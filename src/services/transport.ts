import { ulid } from "ulid";

import type { Operation } from "@/crdt/operations";
import { SyncHttpError } from "@/sync-engine/backoff";

/**
 * The wire layer.
 *
 * Deliberately an interface, not a concrete fetch call, because the sync engine's tests must be able
 * to simulate the network being *hostile* — dropping responses after committing, returning 429s,
 * dying mid-batch, coming back after ten minutes. A sync engine tested only against a cooperative
 * server is a sync engine tested against the one condition it will never face.
 */

export interface PushResponse {
  acknowledged: Array<{ operationId: string; serverSeq: string; userId: string }>;
  duplicateCount: number;
  documentSeq: string;
}

export interface PullResponse {
  operations: Array<{
    operationId: string;
    documentId: string;
    userId: string;
    clientId: string;
    serverSeq: string;
    logicalClock: number;
    timestamp: string;
    documentVersion: string;
    operationType: Operation["operationType"];
    payload: unknown;
  }>;
  hasMore: boolean;
  documentSeq: string;
}

export interface Transport {
  push(
    documentId: string,
    clientId: string,
    operations: readonly Operation[],
    idempotencyKey: string,
  ): Promise<PushResponse>;

  pull(documentId: string, since: string, clientId: string): Promise<PullResponse>;
}

/** Supplies a fresh access token. In-memory, refreshed from the Auth.js session cookie (D-001b). */
export type TokenProvider = () => Promise<string>;

export class HttpTransport implements Transport {
  readonly #baseUrl: string;
  readonly #getToken: TokenProvider;
  readonly #invalidateToken: (() => void) | undefined;

  constructor(baseUrl: string, getToken: TokenProvider, invalidateToken?: () => void) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#getToken = getToken;
    // Called on a 401 to drop the cached token before the one automatic retry, so a stale bearer
    // token is refreshed rather than dead-lettering the user's writing. See tokenProvider.ts.
    this.#invalidateToken = invalidateToken;
  }

  async push(
    documentId: string,
    clientId: string,
    operations: readonly Operation[],
    idempotencyKey: string,
  ): Promise<PushResponse> {
    return this.#request<PushResponse>("POST", "/api/sync/push", {
      // The idempotency key is generated ONCE per batch by the caller and reused across every retry
      // of that batch. Generating it here would mint a fresh key on each attempt, which would defeat
      // the entire mechanism: the server would see each retry as a new request.
      headers: { "Idempotency-Key": idempotencyKey, "X-Client-Id": clientId },
      body: {
        documentId,
        clientId,
        operations: operations.map(serializeOperation),
      },
    });
  }

  async pull(documentId: string, since: string, clientId: string): Promise<PullResponse> {
    const query = new URLSearchParams({ documentId, since });
    return this.#request<PullResponse>("GET", `/api/sync/pull?${query.toString()}`, {
      headers: { "X-Client-Id": clientId },
    });
  }

  async #request<T>(
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    // At most two attempts: the first with whatever token the provider has, and — ONLY on a 401 — a
    // second with a freshly minted one. A 401 almost always means the cached bearer token went stale
    // (a long offline gap, clock skew), not that the operation is bad. Refreshing and retrying here
    // means the sync engine never even sees that 401, so it cannot mistake it for a permanent
    // rejection and dead-letter the batch.
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.#getToken();

      const response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });

      if (response.ok) return (await response.json()) as T;

      if (response.status === 401 && attempt === 0 && this.#invalidateToken !== undefined) {
        this.#invalidateToken();
        continue; // retry once with a freshly minted token
      }

      throw await this.#errorFrom(response);
    }
  }

  /** Build (not throw) a SyncHttpError from a non-ok response, so the caller decides control flow. */
  async #errorFrom(response: Response): Promise<SyncHttpError> {
    // The server's error envelope carries `retryable`, which is the bit the whole retry/DLQ decision
    // hangs on. Parse it; if the body is not our envelope (a proxy's HTML 502 page, a captive portal's
    // login form), fall back to the status code — 5xx and 429 are retryable, everything else is not.
    const fallbackRetryable = response.status >= 500 || response.status === 429;

    let code = `HTTP_${response.status}`;
    let message = response.statusText;
    let retryable = fallbackRetryable;
    let details: unknown;

    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; retryable?: boolean; details?: unknown };
      };
      if (body.error !== undefined) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        retryable = body.error.retryable ?? fallbackRetryable;
        details = body.error.details;
      }
    } catch {
      // Not JSON. Keep the status-derived defaults.
    }

    const retryAfter = response.headers.get("Retry-After");

    return new SyncHttpError(
      response.status,
      code,
      message,
      retryable,
      retryAfter !== null ? Number(retryAfter) : undefined,
      details,
    );
  }
}

/**
 * A transport that goes nowhere.
 *
 * Used for the public demo document (`/documents/demo`), which has no server-side record: it is a
 * try-the-editor scratchpad that lives entirely in the browser's IndexedDB. Pointing the real
 * HttpTransport at it would push operations the backend has never heard of, every one of which comes
 * back rejected and lands in the dead-letter queue — the "N changes couldn't be saved" a user should
 * never see on a doc that is working exactly as intended.
 *
 * So this transport *acknowledges* everything immediately, with a fabricated monotonic sequence. The
 * sync engine then sees a clean flush ("Saved"), the outbox drains, and nothing ever leaves the
 * device. Pull returns nothing, because there is no server to pull from.
 */
export class LocalOnlyTransport implements Transport {
  #seq = 0;

  push(
    _documentId: string,
    clientId: string,
    operations: readonly Operation[],
    _idempotencyKey: string,
  ): Promise<PushResponse> {
    const acknowledged = operations.map((op) => ({
      operationId: op.operationId,
      serverSeq: String(++this.#seq),
      userId: clientId,
    }));
    return Promise.resolve({ acknowledged, duplicateCount: 0, documentSeq: String(this.#seq) });
  }

  pull(): Promise<PullResponse> {
    return Promise.resolve({ operations: [], hasMore: false, documentSeq: String(this.#seq) });
  }
}

/**
 * `documentVersion` is a bigint locally and a string on the wire.
 *
 * JSON has no integers above 2^53. `serverSeq` is the sync cursor of the entire system, and a cursor
 * that silently rounds is a cursor that silently skips operations — a divergence that would be blamed
 * on the CRDT for months. So it crosses the wire as a string, in both directions, always.
 */
function serializeOperation(op: Operation): Record<string, unknown> {
  return {
    operationId: op.operationId,
    clientId: op.clientId,
    logicalClock: op.logicalClock,
    timestamp: new Date(op.timestamp).toISOString(),
    documentVersion: op.documentVersion.toString(),
    operationType: op.operationType,
    payload: op.payload,
  };
}

export function deserializeOperation(row: PullResponse["operations"][number]): Operation {
  return {
    operationId: row.operationId,
    clientId: row.clientId,
    logicalClock: row.logicalClock,
    timestamp: new Date(row.timestamp).getTime(),
    documentVersion: BigInt(row.documentVersion),
    operationType: row.operationType,
    payload: row.payload,
  } as Operation;
}

export function newIdempotencyKey(): string {
  return ulid();
}
