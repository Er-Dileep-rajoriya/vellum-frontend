import { SyncHttpError } from "@/sync-engine/backoff";
import type { TokenProvider } from "@/services/transport";

export type InviteRole = "EDITOR" | "VIEWER";
export type InvitationStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "REVOKED";

/** A pending invitation, as the owner's Share panel sees it. */
export interface Invitation {
  id: string;
  email: string;
  role: InviteRole;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
}

/** What the invitee's accept page renders. `documentTitle`/`inviterName`/`role` are present only when
 *  the signed-in email matches the invited address (the server withholds them otherwise). */
export interface InvitationPreview {
  invitedEmail: string;
  status: InvitationStatus | "EXPIRED";
  emailMatches: boolean;
  documentTitle: string | null;
  inviterName: string | null;
  role: InviteRole | null;
}

/**
 * The invitation API client — both sides of the flow.
 *
 * Owner side (`/documents/:id/invitations`): create, list pending, revoke, resend. Invitee side
 * (`/invitations/:token`): preview, accept, decline. Same bearer-token transport as the rest of the
 * app, and any non-2xx becomes a {@link SyncHttpError} carrying the backend's status so the UI can
 * turn "wrong email" (403) or "expired" (400) into a sentence.
 */
export class InvitationApi {
  readonly #baseUrl: string;
  readonly #getToken: TokenProvider;

  constructor(baseUrl: string, getToken: TokenProvider) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#getToken = getToken;
  }

  // ── Owner side ──────────────────────────────────────────────────────────

  async create(
    documentId: string,
    email: string,
    role: InviteRole,
  ): Promise<{ invitation: Invitation; emailSent: boolean }> {
    const response = await this.#send("POST", `/api/documents/${documentId}/invitations`, {
      email,
      role,
    });
    return (await response.json()) as { invitation: Invitation; emailSent: boolean };
  }

  async listPending(documentId: string): Promise<Invitation[]> {
    const response = await this.#send("GET", `/api/documents/${documentId}/invitations`);
    const body = (await response.json()) as { invitations: Invitation[] };
    return body.invitations;
  }

  async revoke(documentId: string, invitationId: string): Promise<void> {
    await this.#send("DELETE", `/api/documents/${documentId}/invitations/${invitationId}`);
  }

  async resend(documentId: string, invitationId: string): Promise<{ emailSent: boolean }> {
    const response = await this.#send(
      "POST",
      `/api/documents/${documentId}/invitations/${invitationId}/resend`,
    );
    return (await response.json()) as { emailSent: boolean };
  }

  // ── Invitee side ────────────────────────────────────────────────────────

  async getByToken(token: string): Promise<InvitationPreview> {
    const response = await this.#send("GET", `/api/invitations/${encodeURIComponent(token)}`);
    const body = (await response.json()) as { invitation: InvitationPreview };
    return body.invitation;
  }

  async accept(token: string): Promise<{ documentId: string }> {
    const response = await this.#send(
      "POST",
      `/api/invitations/${encodeURIComponent(token)}/accept`,
    );
    return (await response.json()) as { documentId: string };
  }

  async decline(token: string): Promise<void> {
    await this.#send("POST", `/api/invitations/${encodeURIComponent(token)}/decline`);
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#getToken();

    // Set Content-Type ONLY when there is a body. accept/decline/resend are POSTs with no body, and a
    // `Content-Type: application/json` header on an empty body makes Fastify reject the request with
    // "Body cannot be empty when content-type is set to 'application/json'".
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
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
