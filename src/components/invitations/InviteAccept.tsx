"use client";

import { AlertCircle, Check, FileText, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { InvitationApi, type InvitationPreview } from "@/services/invitationApi";
import { SyncHttpError } from "@/sync-engine/backoff";
import { apiBaseUrl } from "@/lib/clientEnv";
import { getAccessToken } from "@/services/tokenProvider";

/**
 * The client island for accepting an invitation.
 *
 * It fetches the invitation preview (which the server tailors: the document title and inviter are
 * revealed only when the signed-in email matches the invited one), then renders the appropriate state:
 * accept/decline, a "sent to a different email" prompt, or an expired/revoked/accepted notice. Accept
 * is the single action that creates the collaborator row and drops the user into the document.
 */
export function InviteAccept({ token }: { readonly token: string }) {
  const router = useRouter();
  const api = useMemo(() => new InvitationApi(apiBaseUrl(), getAccessToken), []);

  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const result = await api.getByToken(token);
        if (!ignore) setPreview(result);
      } catch (error) {
        if (ignore) return;
        setLoadError(
          error instanceof SyncHttpError && error.status === 404
            ? "This invitation link is invalid or has been removed."
            : "Couldn't load this invitation. Check your connection and try again.",
        );
      }
    })();
    return () => {
      ignore = true;
    };
  }, [api, token]);

  const accept = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const { documentId } = await api.accept(token);
      // Straight into the document they just joined.
      router.push(`/documents/${documentId}`);
      router.refresh();
    } catch (error) {
      setActionError(
        error instanceof SyncHttpError
          ? error.message || "Couldn't accept this invitation."
          : "Couldn't accept this invitation. Check your connection and try again.",
      );
      setBusy(false);
    }
  }, [api, token, router]);

  const decline = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.decline(token);
      setDeclined(true);
    } catch (error) {
      setActionError(
        error instanceof SyncHttpError
          ? error.message || "Couldn't decline this invitation."
          : "Couldn't decline this invitation.",
      );
    } finally {
      setBusy(false);
    }
  }, [api, token]);

  if (loadError !== null) {
    return <Notice icon="error" title="Invitation unavailable" body={loadError} />;
  }

  if (preview === null) {
    return (
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading invitation…
      </div>
    );
  }

  if (declined) {
    return (
      <Notice
        icon="ok"
        title="Invitation declined"
        body="No problem — you can ask the owner to invite you again if you change your mind."
        action={{ label: "Go to your documents", onClick: () => router.push("/documents") }}
      />
    );
  }

  if (preview.status === "ACCEPTED") {
    return (
      <Notice
        icon="ok"
        title="Already accepted"
        body="You've already accepted this invitation."
        action={{ label: "Go to your documents", onClick: () => router.push("/documents") }}
      />
    );
  }

  if (preview.status === "EXPIRED") {
    return (
      <Notice
        icon="error"
        title="Invitation expired"
        body="This invitation has expired. Ask the owner to send you a new one."
        action={{ label: "Go to your documents", onClick: () => router.push("/documents") }}
      />
    );
  }

  if (preview.status === "DECLINED" || preview.status === "REVOKED") {
    return (
      <Notice
        icon="error"
        title="Invitation no longer available"
        body="This invitation is no longer active. Ask the owner to send you a new one."
        action={{ label: "Go to your documents", onClick: () => router.push("/documents") }}
      />
    );
  }

  // PENDING, but signed in as the wrong account.
  if (!preview.emailMatches) {
    return (
      <Notice
        icon="error"
        title="Wrong account"
        body={`This invitation was sent to ${preview.invitedEmail}. Sign in with that email to accept it.`}
        action={{
          label: `Sign in as ${preview.invitedEmail}`,
          onClick: () =>
            void signOut({ callbackUrl: `/login?callbackUrl=/invite/${encodeURIComponent(token)}` }),
        }}
      />
    );
  }

  // PENDING and the email matches — the accept/decline decision.
  const roleLabel = preview.role === "EDITOR" ? "edit" : "view";

  return (
    <div className="rounded-xl border border-border p-6 text-center">
      <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
        <FileText className="size-6 text-muted-foreground" aria-hidden />
      </span>

      <h1 className="text-lg font-semibold">
        {preview.inviterName ?? "Someone"} invited you to a document
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        You&apos;ve been invited to <strong className="text-foreground">{roleLabel}</strong>{" "}
        <strong className="text-foreground">&ldquo;{preview.documentTitle}&rdquo;</strong>.
      </p>

      {actionError !== null && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {actionError}
        </p>
      )}

      <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
        <button
          type="button"
          onClick={() => void accept()}
          disabled={busy}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
          Accept invitation
        </button>
        <button
          type="button"
          onClick={() => void decline()}
          disabled={busy}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <X className="size-4" aria-hidden />
          Decline
        </button>
      </div>
    </div>
  );
}

function Notice({
  icon,
  title,
  body,
  action,
}: {
  readonly icon: "ok" | "error";
  readonly title: string;
  readonly body: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  return (
    <div className="rounded-xl border border-border p-6 text-center">
      <span
        className={
          icon === "ok"
            ? "mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"
        }
      >
        {icon === "ok" ? (
          <Check className="size-6" aria-hidden />
        ) : (
          <AlertCircle className="size-6" aria-hidden />
        )}
      </span>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action !== undefined && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
