"use client";

import { Check, Loader2, LogOut, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CollaboratorApi,
  type Collaborator,
  type InviteRole,
} from "@/services/collaboratorApi";
import { SyncHttpError } from "@/sync-engine/backoff";
import type { TokenProvider } from "@/services/transport";
import { cn } from "@/lib/utils";

/**
 * Share a document: invite people by email, change their role, remove them — or leave a document
 * someone shared with you.
 *
 * Authorization is mirrored from the backend rather than reinvented: only an OWNER has the `manage`
 * capability, so only an owner sees the invite form and the per-collaborator controls. Everyone else
 * sees a read-only roster (useful — "who else is in here?") plus, if they are not the owner, a way to
 * leave. The server enforces all of this regardless; the UI just refuses to dangle a control it knows
 * will 403.
 *
 * Invite is by email of an EXISTING account (the backend does not create shell users — that would be a
 * spam and enumeration vector), so a missing account comes back as a 404 and is shown as a sentence,
 * not a status code.
 */
export function SharePanel({
  documentId,
  apiUrl,
  getToken,
  currentUserId,
  onClose,
}: {
  readonly documentId: string;
  readonly apiUrl: string;
  readonly getToken: TokenProvider;
  readonly currentUserId: string | null;
  readonly onClose: () => void;
}) {
  const api = useMemo(() => new CollaboratorApi(apiUrl, getToken), [apiUrl, getToken]);

  const [collaborators, setCollaborators] = useState<Collaborator[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("EDITOR");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteOk, setInviteOk] = useState<string | null>(null);

  // The userId of a row whose role/removal request is in flight — disables just that row's controls.
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  // Two-step confirm for removal, inline rather than a nested modal (a modal over a modal is a focus
  // trap fighting a focus trap).
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const list = await api.list(documentId);
        if (!ignore) setCollaborators(list);
      } catch {
        if (ignore) return;
        // The roster is server data. Offline, it genuinely cannot be shown — unlike the document itself.
        setLoadError("Sharing is unavailable offline.");
        setCollaborators([]);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [api, documentId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const myRole = collaborators?.find((c) => c.userId === currentUserId)?.role ?? null;
  const canManage = myRole === "OWNER";

  const invite = useCallback(async () => {
    const trimmed = email.trim();
    if (trimmed === "") return;

    setInviting(true);
    setInviteError(null);
    setInviteOk(null);
    try {
      const collaborator = await api.invite(documentId, trimmed, role);
      // Upsert: re-inviting an existing collaborator updates their role (the backend does the same),
      // so replace an existing row rather than appending a duplicate.
      setCollaborators((prev) => {
        const rest = (prev ?? []).filter((c) => c.userId !== collaborator.userId);
        return [...rest, collaborator];
      });
      setEmail("");
      setInviteOk(`Shared with ${collaborator.email}.`);
    } catch (error) {
      setInviteError(inviteMessage(error));
    } finally {
      setInviting(false);
    }
  }, [api, documentId, email, role]);

  const changeRole = useCallback(
    async (userId: string, next: InviteRole) => {
      setRowBusy(userId);
      setInviteError(null);
      try {
        await api.changeRole(documentId, userId, next);
        setCollaborators((prev) =>
          (prev ?? []).map((c) => (c.userId === userId ? { ...c, role: next } : c)),
        );
      } catch (error) {
        setInviteError(inviteMessage(error));
      } finally {
        setRowBusy(null);
      }
    },
    [api, documentId],
  );

  const remove = useCallback(
    async (userId: string) => {
      setRowBusy(userId);
      setInviteError(null);
      try {
        await api.remove(documentId, userId);
        setCollaborators((prev) => (prev ?? []).filter((c) => c.userId !== userId));
        setConfirmRemove(null);
        // Leaving your own document means you can no longer see it — close and let the list refetch.
        if (userId === currentUserId) onClose();
      } catch (error) {
        setInviteError(inviteMessage(error));
      } finally {
        setRowBusy(null);
      }
    },
    [api, documentId, currentUserId, onClose],
  );

  const iAmOwner = myRole === "OWNER";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-title"
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[1px]"
      />

      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="share-title" className="text-base font-semibold">
            Share this document
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {canManage && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void invite();
              }}
              className="mb-4"
            >
              <label htmlFor="invite-email" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Invite by email
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="invite-email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="person@example.com"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:ring-2 focus:ring-foreground/15"
                />
                <select
                  aria-label="Role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as InviteRole)}
                  className="rounded-lg border border-border bg-background px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-foreground/15"
                >
                  <option value="EDITOR">Editor</option>
                  <option value="VIEWER">Viewer</option>
                </select>
                <button
                  type="submit"
                  disabled={inviting || email.trim() === ""}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {inviting ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <UserPlus className="size-4" aria-hidden />
                  )}
                  Invite
                </button>
              </div>

              {inviteError !== null && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {inviteError}
                </p>
              )}
              {inviteOk !== null && (
                <p className="mt-2 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <Check className="size-3.5" aria-hidden />
                  {inviteOk}
                </p>
              )}

              <p className="mt-2 text-xs text-muted-foreground">
                Editors can write; viewers can only read. You can only invite people who already have a
                Vellum account.
              </p>
            </form>
          )}

          {/* A manage-level error that happened outside the invite form (a failed role change / removal
              when the invite form is not rendered) still needs somewhere to surface. */}
          {!canManage && inviteError !== null && (
            <p role="alert" className="mb-3 text-xs text-destructive">
              {inviteError}
            </p>
          )}

          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            People with access
          </h3>

          {loadError !== null && (
            <p role="alert" className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {loadError}
            </p>
          )}

          {collaborators === null && <RosterSkeleton />}

          {collaborators !== null && collaborators.length > 0 && (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {collaborators.map((c) => {
                const isOwnerRow = c.role === "OWNER";
                const isMe = c.userId === currentUserId;
                const busy = rowBusy === c.userId;

                return (
                  <li key={c.userId} className="flex items-center gap-3 px-3 py-2.5">
                    <Avatar name={c.name} email={c.email} image={c.image} />

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {c.name ?? c.email}
                        {isMe && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
                      </p>
                      {c.name !== null && (
                        <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                      )}
                    </div>

                    {/* The owner's role is fixed: it cannot be changed or removed, by anyone, from
                        here — ownership is transferred, not edited. */}
                    {isOwnerRow ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        Owner
                      </span>
                    ) : canManage ? (
                      confirmRemove === c.userId ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void remove(c.userId)}
                            disabled={busy}
                            className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                          >
                            {busy ? "Removing…" : "Remove"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRemove(null)}
                            disabled={busy}
                            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-1.5">
                          <select
                            aria-label={`Role for ${c.email}`}
                            value={c.role}
                            disabled={busy}
                            onChange={(event) =>
                              void changeRole(c.userId, event.target.value as InviteRole)
                            }
                            className="rounded-md border border-border bg-background px-1.5 py-1 text-xs outline-none focus:ring-2 focus:ring-foreground/15 disabled:opacity-50"
                          >
                            <option value="EDITOR">Editor</option>
                            <option value="VIEWER">Viewer</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => setConfirmRemove(c.userId)}
                            aria-label={`Remove ${c.email}`}
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                          >
                            <X className="size-4" aria-hidden />
                          </button>
                        </span>
                      )
                    ) : (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {c.role === "EDITOR" ? "Editor" : "Viewer"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Not the owner → you cannot invite, but you can walk away. Self-removal is allowed by the
              backend without `manage` for exactly this. */}
          {collaborators !== null && myRole !== null && !iAmOwner && currentUserId !== null && (
            <button
              type="button"
              onClick={() => void remove(currentUserId)}
              disabled={rowBusy === currentUserId}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50"
            >
              <LogOut className="size-4" aria-hidden />
              {rowBusy === currentUserId ? "Leaving…" : "Leave this document"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Turn a backend error into something a person can act on. */
function inviteMessage(error: unknown): string {
  if (error instanceof SyncHttpError) {
    if (error.status === 404) {
      return "No Vellum account uses that email. Ask them to sign up first.";
    }
    if (error.status === 403) {
      return "Only the document's owner can manage sharing.";
    }
    if (error.status === 400 || error.status === 422) {
      return error.message || "That email doesn't look right.";
    }
  }
  return "Something went wrong. Check your connection and try again.";
}

function Avatar({
  name,
  email,
  image,
}: {
  readonly name: string | null;
  readonly email: string;
  readonly image: string | null;
}) {
  const initials = (name ?? email).trim().slice(0, 2).toUpperCase();
  return image !== null ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image}
      alt=""
      className="size-8 shrink-0 rounded-full object-cover"
      referrerPolicy="no-referrer"
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground",
      )}
    >
      {initials}
    </span>
  );
}

function RosterSkeleton() {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border" aria-hidden>
      {[0, 1].map((index) => (
        <li key={index} className="flex items-center gap-3 px-3 py-2.5">
          <div className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  );
}
