import type { DocumentSnapshot } from "@/versioning/restore";
import { SyncHttpError } from "@/sync-engine/backoff";
import type { TokenProvider } from "@/services/transport";

export interface VersionSummary {
  id: string;
  kind: "AUTO" | "NAMED" | "RESTORE" | "SNAPSHOT";
  label: string | null;
  description: string | null;
  serverSeq: string;
  authorId: string;
  authorName: string | null;
  parentVersionId: string | null;
  blockCount: number;
  charCount: number;
  createdAt: string;
}

export interface VersionDetail extends VersionSummary {
  content: DocumentSnapshot;
}

/**
 * The version-history API client.
 *
 * Note what this is NOT: part of the sync engine. A version is created when a human presses a button
 * or when the autosave timer fires — never on the keystroke path. It has no outbox, no retry queue, and
 * no dead-letter queue, because a failed snapshot is not lost data: the operation log it summarises is
 * already durable, and the snapshot can simply be recomputed. Giving it the full sync machinery would
 * be ceremony protecting nothing.
 */
export class VersionApi {
  readonly #baseUrl: string;
  readonly #getToken: TokenProvider;

  constructor(baseUrl: string, getToken: TokenProvider) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#getToken = getToken;
  }

  async list(documentId: string): Promise<VersionSummary[]> {
    const body = await this.#request<{ versions: VersionSummary[] }>(
      "GET",
      `/api/documents/${documentId}/versions`,
    );
    return body.versions;
  }

  async get(documentId: string, versionId: string): Promise<VersionDetail> {
    const body = await this.#request<{ version: VersionDetail }>(
      "GET",
      `/api/documents/${documentId}/versions/${versionId}`,
    );
    return body.version;
  }

  async create(
    documentId: string,
    input: {
      kind: "AUTO" | "NAMED" | "RESTORE";
      label?: string;
      description?: string;
      content: DocumentSnapshot;
      serverSeq: string;
      blockCount: number;
      charCount: number;
      parentVersionId?: string;
    },
  ): Promise<VersionSummary> {
    const body = await this.#request<{ version: VersionSummary }>(
      "POST",
      `/api/documents/${documentId}/versions`,
      input,
    );
    return body.version;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.#getToken();

    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; retryable?: boolean };
      } | null;

      throw new SyncHttpError(
        response.status,
        parsed?.error?.code ?? `HTTP_${response.status}`,
        parsed?.error?.message ?? response.statusText,
        parsed?.error?.retryable ?? response.status >= 500,
      );
    }

    return (await response.json()) as T;
  }
}
