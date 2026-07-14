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

  constructor(baseUrl: string, getToken: TokenProvider) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#getToken = getToken;
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

    if (!response.ok) {
      // The server's error envelope carries `retryable`, which is the bit the whole retry/DLQ
      // decision hangs on. Parse it; if the body is not our envelope (a proxy's HTML 502 page, a
      // captive portal's login form), fall back to the status code — 5xx and 429 are retryable,
      // everything else is not.
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

      throw new SyncHttpError(
        response.status,
        code,
        message,
        retryable,
        retryAfter !== null ? Number(retryAfter) : undefined,
        details,
      );
    }

    return (await response.json()) as T;
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
