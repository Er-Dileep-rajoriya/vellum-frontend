"use client";

import { AlertCircle, FileText, LogOut, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { apiBaseUrl } from "@/lib/clientEnv";
import { relativeTime } from "@/lib/utils";
import { getAccessToken } from "@/services/tokenProvider";

interface DocumentSummary {
  id: string;
  title: string;
  role: "OWNER" | "EDITOR" | "VIEWER";
  collaboratorCount: number;
  updatedAt: string;
}

const API_URL = apiBaseUrl();

export function DocumentList({ currentUserId }: { readonly currentUserId: string | null }) {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The document a delete/leave confirmation is open for, and whether that request is in flight.
  const [pending, setPending] = useState<DocumentSummary | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    /**
     * `ignore` guards against a stale response landing after the component has unmounted — or after a
     * newer fetch has superseded this one — and overwriting fresher state. It is the classic
     * async-effect race, and it is why every `setState` below sits behind it.
     *
     * The fetch lives inside the effect rather than in a `useCallback` above it, so that it is obvious
     * (to a reader and to the compiler) that no state is written *synchronously* during the effect —
     * every write happens after an `await`, which is what makes this a subscription rather than a
     * cascading render.
     */
    let ignore = false;

    void (async () => {
      try {
        const token = await getAccessToken();
        const response = await fetch(`${API_URL}/api/documents`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });

        if (!response.ok) throw new Error("failed to load");

        const body = (await response.json()) as { documents: DocumentSummary[] };
        if (!ignore) setDocuments(body.documents);
      } catch {
        // The list is server data — unlike a document, it genuinely IS unavailable offline. Saying so
        // is more honest than an empty state that implies the user has no documents.
        if (ignore) return;
        setError("Couldn't load your documents. Check your connection.");
        setDocuments([]);
      }
    })();

    return () => {
      ignore = true;
    };
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    try {
      const token = await getAccessToken();
      const response = await fetch(`${API_URL}/api/documents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Untitled" }),
      });

      if (!response.ok) throw new Error("failed to create");

      const body = (await response.json()) as { document: { id: string } };
      router.push(`/documents/${body.document.id}`);
    } catch {
      setError("Couldn't create a document. Check your connection.");
      setCreating(false);
    }
  }, [router]);

  /**
   * Delete (if you own it) or leave (if it was shared with you).
   *
   * The owner deletes the document — a soft delete on the server, so nothing a collaborator wrote is
   * destroyed. Everyone else *leaves*, which removes only their own collaborator row: you can walk away
   * from a document someone shared with you, and doing so takes nothing from anyone else. Both make the
   * row disappear from *your* list, which is the only list this component owns.
   */
  const removePending = useCallback(async () => {
    if (pending === null) return;

    const target = pending;
    const isOwner = target.role === "OWNER";
    setRemoving(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const path = isOwner
        ? `${API_URL}/api/documents/${target.id}`
        : `${API_URL}/api/documents/${target.id}/collaborators/${currentUserId}`;

      const response = await fetch(path, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("failed");

      setDocuments((prev) => (prev === null ? prev : prev.filter((d) => d.id !== target.id)));
      setPending(null);
    } catch {
      // Close the dialog so the error banner (which sits behind the modal backdrop) is actually
      // visible. The row stays, so the user can try again.
      setPending(null);
      setError(
        isOwner
          ? "Couldn't delete that document. Check your connection and try again."
          : "Couldn't leave that document. Check your connection and try again.",
      );
    } finally {
      setRemoving(false);
    }
  }, [pending, currentUserId]);

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden />
          New document
        </button>
        {/* Sign out lives in the global app header now — reachable from every screen, not just this one. */}
      </div>

      {error !== null && (
        <p
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      {documents === null && <ListSkeleton />}

      {documents !== null && documents.length === 0 && error === null && (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <FileText className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">No documents yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Create one and start writing.</p>
        </div>
      )}

      {/* Only render the list container when there is something to list. An always-present <ul>
          shows as a stray empty bordered box on the loading-error and empty states. */}
      {documents !== null && documents.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {documents.map((document) => {
            const isOwner = document.role === "OWNER";
            return (
              <li
                key={document.id}
                className="flex items-center transition-colors hover:bg-accent/50"
              >
                <a
                  href={`/documents/${document.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{document.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {relativeTime(new Date(document.updatedAt).getTime())}
                      {document.collaboratorCount > 1 &&
                        ` · ${document.collaboratorCount} collaborators`}
                    </span>
                  </span>

                  {!isOwner && (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {document.role === "EDITOR" ? "Editor" : "Viewer"}
                    </span>
                  )}
                </a>

                {/* Delete lives OUTSIDE the anchor — a <button> inside an <a> is invalid, and a click
                    here must open a confirm, never navigate into the document. */}
                {(isOwner || currentUserId !== null) && (
                  <div className="shrink-0 pl-1 pr-2">
                    <button
                      type="button"
                      onClick={() => setPending(document)}
                      aria-label={
                        isOwner ? `Delete ${document.title}` : `Leave ${document.title}`
                      }
                      title={isOwner ? "Delete" : "Leave"}
                      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                    >
                      {isOwner ? (
                        <Trash2 className="size-4" aria-hidden />
                      ) : (
                        <LogOut className="size-4" aria-hidden />
                      )}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pending !== null && (
        <ConfirmDialog
          title={pending.role === "OWNER" ? "Delete this document?" : "Leave this document?"}
          message={
            pending.role === "OWNER"
              ? `"${pending.title}" will be removed from your documents. Collaborators will lose access.`
              : `You'll lose access to "${pending.title}". The owner can invite you again later.`
          }
          confirmLabel={pending.role === "OWNER" ? "Delete" : "Leave"}
          destructive
          busy={removing}
          onConfirm={() => void removePending()}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border" aria-hidden>
      {[0, 1, 2].map((index) => (
        <li key={index} className="flex items-center gap-3 px-4 py-3">
          <div className="size-4 animate-pulse rounded bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/5 animate-pulse rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  );
}
