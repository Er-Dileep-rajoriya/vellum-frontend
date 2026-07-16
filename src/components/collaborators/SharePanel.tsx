"use client";

import { Check, Clock, Loader2, LogOut, Mail, Send, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CollaboratorApi, type Collaborator } from "@/services/collaboratorApi";
import {
  InvitationApi,
  type Invitation,
  type InviteRole,
} from "@/services/invitationApi";
import { SyncHttpError } from "@/sync-engine/backoff";
import type { TokenProvider } from "@/services/transport";
import { cn } from "@/lib/utils";

/**
 * Share a document: invite people by email, manage who has access, or leave a document someone shared
 * with you.
 *
 * Inviting does NOT grant access directly — it sends an email invitation the recipient must accept
 * (see InvitationApi / the /invite page). So the panel has two lists: **people with access** (accepted
 * collaborators) and **pending invitations** (sent, awaiting acceptance, resend/revoke-able).
 *
 * Authorization mirrors the backend: only an OWNER has `manage`, so only an owner sees the invite form,
 * the pending list, and the per-collaborator controls. Everyone else sees a read-only roster and, if
 * they are not the owner, a way to leave. The server enforces all of it regardless.
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
  const collabApi = useMemo(() => new CollaboratorApi(apiUrl, getToken), [apiUrl, getToken]);
  const inviteApi = useMemo(() => new InvitationApi(apiUrl, getToken), [apiUrl, getToken]);

  const [collaborators, setCollaborators] = useState<Collaborator[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("EDITOR");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteOk, setInviteOk] = useState<string | null>(null);

  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const roster = await collabApi.list(documentId);
        if (ignore) return;
        setCollaborators(roster);

        // Pending invitations are manage-only. Fetch them only if we own the document — a non-owner
        // GET would 403, and there is nothing for them to manage anyway.
        const mine = roster.find((c) => c.userId === currentUserId)?.role;
        if (mine === "OWNER") {
          try {
            const pending = await inviteApi.listPending(documentId);
            if (!ignore) setInvitations(pending);
          } catch {
            /* pending list is a nicety; a failure here should not blank the whole panel */
          }
        }
      } catch {
        if (ignore) return;
        setLoadError("Sharing is unavailable offline.");
        setCollaborators([]);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [collabApi, inviteApi, documentId, currentUserId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const myRole = collaborators?.find((c) => c.userId === currentUserId)?.role ?? null;
  const canManage = myRole === "OWNER";
  const iAmOwner = myRole === "OWNER";

  const invite = useCallback(async () => {
    const trimmed = email.trim();
    if (trimmed === "") return;

    setInviting(true);
    setInviteError(null);
    setInviteOk(null);
    try {
      const { invitation, emailSent } = await inviteApi.create(documentId, trimmed, role);
      // Replace any existing pending invite for the same email; otherwise prepend.
      setInvitations((prev) => [invitation, ...prev.filter((i) => i.email !== invitation.email)]);
      setEmail("");
      setInviteOk(
        emailSent
          ? `Invitation sent to ${invitation.email}.`
          : `Invitation created for ${invitation.email}, but the email didn't go out. Use “Resend”.`,
      );
    } catch (error) {
      setInviteError(inviteMessage(error));
    } finally {
      setInviting(false);
    }
  }, [inviteApi, documentId, email, role]);

  const resend = useCallback(
    async (invitation: Invitation) => {
      setRowBusy(invitation.id);
      setInviteError(null);
      setInviteOk(null);
      try {
        const { emailSent } = await inviteApi.resend(documentId, invitation.id);
        setInviteOk(
          emailSent
            ? `Invitation re-sent to ${invitation.email}.`
            : `Couldn't send the email to ${invitation.email}. Try again shortly.`,
        );
      } catch (error) {
        setInviteError(inviteMessage(error));
      } finally {
        setRowBusy(null);
      }
    },
    [inviteApi, documentId],
  );

  const revokeInvite = useCallback(
    async (invitation: Invitation) => {
      setRowBusy(invitation.id);
      setInviteError(null);
      try {
        await inviteApi.revoke(documentId, invitation.id);
        setInvitations((prev) => prev.filter((i) => i.id !== invitation.id));
      } catch (error) {
        setInviteError(inviteMessage(error));
      } finally {
        setRowBusy(null);
      }
    },
    [inviteApi, documentId],
  );

  const changeRole = useCallback(
    async (userId: string, next: InviteRole) => {
      setRowBusy(userId);
      setInviteError(null);
      try {
        await collabApi.changeRole(documentId, userId, next);
        setCollaborators((prev) =>
          (prev ?? []).map((c) => (c.userId === userId ? { ...c, role: next } : c)),
        );
      } catch (error) {
        setInviteError(inviteMessage(error));
      } finally {
        setRowBusy(null);
      }
    },
    [collabApi, documentId],
  );

  const removeCollaborator = useCallback(
    async (userId: string) => {
      setRowBusy(userId);
      setInviteError(null);
      try {
        await collabApi.remove(documentId, userId);
        setCollaborators((prev) => (prev ?? []).filter((c) => c.userId !== userId));
        setConfirmRemove(null);
        if (userId === currentUserId) onClose();
      } catch (error) {
        setInviteError(inviteMessage(error));
      } finally {
        setRowBusy(null);
      }
    },
    [collabApi, documentId, currentUserId, onClose],
  );

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
              className="mb-5"
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
                They&apos;ll get an email to accept. Editors can write; viewers can only read.
              </p>
            </form>
          )}

          {!canManage && inviteError !== null && (
            <p role="alert" className="mb-3 text-xs text-destructive">
              {inviteError}
            </p>
          )}

          {/* Pending invitations — owner only, and only when there are any. */}
          {canManage && invitations.length > 0 && (
            <section className="mb-5">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Clock className="size-3.5" aria-hidden />
                Pending invitations
              </h3>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {invitations.map((inv) => {
                  const busy = rowBusy === inv.id;
                  return (
                    <li key={inv.id} className="flex items-center gap-3 px-3 py-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Mail className="size-4" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{inv.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {inv.role === "EDITOR" ? "Editor" : "Viewer"} · invited, not yet accepted
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void resend(inv)}
                        disabled={busy}
                        aria-label={`Resend invitation to ${inv.email}`}
                        title="Resend email"
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                          <Send className="size-4" aria-hidden />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void revokeInvite(inv)}
                        disabled={busy}
                        aria-label={`Cancel invitation to ${inv.email}`}
                        title="Cancel invitation"
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                      >
                        <X className="size-4" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
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

                    {isOwnerRow ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        Owner
                      </span>
                    ) : canManage ? (
                      confirmRemove === c.userId ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void removeCollaborator(c.userId)}
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

          {collaborators !== null && myRole !== null && !iAmOwner && currentUserId !== null && (
            <button
              type="button"
              onClick={() => void removeCollaborator(currentUserId)}
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
    if (error.status === 403) return "Only the document's owner can manage sharing.";
    if (error.status === 400 || error.status === 422) {
      return error.message || "That email doesn't look right.";
    }
    if (error.status === 404) return "That invitation no longer exists.";
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
