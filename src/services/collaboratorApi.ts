import { SyncHttpError } from "@/sync-engine/backoff";
import type { TokenProvider } from "@/services/transport";

export type CollaboratorRole = "OWNER" | "EDITOR" | "VIEWER";
/** The two roles a collaborator can be *granted*. OWNER is never granted — it is created with the
 *  document and only ever transferred, so the invite/change-role surface deliberately excludes it. */
export type InviteRole = "EDITOR" | "VIEWER";

export interface Collaborator {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: CollaboratorRole;
  createdAt: string;
}

/**
 * The collaborator-management API client.
 *
 * A thin mirror of the backend's `/documents/:id/collaborators` surface, following the same shape as
 * {@link VersionApi}: a bearer token per call, and any non-2xx collapsed into a {@link SyncHttpError}
 * carrying the backend's error code so the UI can turn "the invitee has no account" (404) into a
 * sentence a human can act on rather than a raw status.
 *
 * Like versions, this is NOT part of the sync engine. Sharing is a deliberate human action with no
 * offline-queue semantics: if you are offline you cannot invite someone, and that is honest — the
 * person you are inviting is on the server, not on your device.
 */
export class CollaboratorApi {
  readonly #baseUrl: string;
  readonly #getToken: TokenProvider;

  constructor(baseUrl: string, getToken: TokenProvider) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#getToken = getToken;
  }

  async list(documentId: string): Promise<Collaborator[]> {
    const response = await this.#send("GET", `/api/documents/${documentId}/collaborators`);
    const body = (await response.json()) as { collaborators: Collaborator[] };
    return body.collaborators;
  }

  async invite(documentId: string, email: string, role: InviteRole): Promise<Collaborator> {
    const response = await this.#send("POST", `/api/documents/${documentId}/collaborators`, {
      email,
      role,
    });
    const body = (await response.json()) as { collaborator: Collaborator };
    return body.collaborator;
  }

  async changeRole(documentId: string, userId: string, role: InviteRole): Promise<void> {
    await this.#send("PATCH", `/api/documents/${documentId}/collaborators/${userId}`, { role });
  }

  /** Remove a collaborator, or — when `userId` is the caller — leave the document. */
  async remove(documentId: string, userId: string): Promise<void> {
    await this.#send("DELETE", `/api/documents/${documentId}/collaborators/${userId}`);
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
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

    return response;
  }
}
