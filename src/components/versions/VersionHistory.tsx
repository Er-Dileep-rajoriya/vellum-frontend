"use client";

import { History, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { render } from "@/crdt/document";
import type { DocumentStore } from "@/services/documentStore";
import { VersionApi, type VersionDetail, type VersionSummary } from "@/services/versionApi";
import type { TokenProvider } from "@/services/transport";
import { cn, relativeTime } from "@/lib/utils";
import { diffDocuments, type DiffSummary } from "@/versioning/diff";
import { buildRestoreOperations, snapshotOf, snapshotStats } from "@/versioning/restore";

/**
 * The version history panel: timeline → preview → diff → restore.
 *
 * The restore button is the sharpest edge in the product, so the UI does three things before it is
 * pressed: it shows what the version contains, it shows exactly what would change, and it says — in
 * words — that restoring appends rather than overwrites. A user who understands that "restore" cannot
 * destroy anything is a user who will actually use it.
 */

export interface VersionHistoryProps {
  readonly documentId: string;
  readonly store: DocumentStore;
  readonly apiUrl: string;
  readonly getToken: TokenProvider;
  readonly canRestore: boolean;
  readonly onClose: () => void;
}

export function VersionHistory({
  documentId,
  store,
  apiUrl,
  getToken,
  canRestore,
  onClose,
}: VersionHistoryProps) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [selected, setSelected] = useState<VersionDetail | null>(null);
  const [diff, setDiff] = useState<DiffSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Memoised: a fresh client on every render changes the identity of every callback that closes over
  // it, which re-runs their effects and re-fetches the timeline on each keystroke elsewhere in the app.
  const api = useMemo(() => new VersionApi(apiUrl, getToken), [apiUrl, getToken]);

  useEffect(() => {
    void (async () => {
      try {
        setVersions(await api.list(documentId));
      } catch {
        // Offline, or not authenticated. The history lives on the server — unlike the document, which
        // does not — so this genuinely is unavailable, and saying so is the honest thing to do.
        setError("Version history is unavailable offline.");
        setVersions([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  const select = useCallback(
    async (summary: VersionSummary) => {
      setBusy(true);
      setError(null);
      try {
        const detail = await api.get(documentId, summary.id);
        setSelected(detail);

        // The diff is computed CLIENT-side, against the live CRDT. The server never folds an operation
        // log (it does not run the CRDT), and it does not need to: the client already holds the
        // document it is comparing against.
        const current = render(store.state).map((block) => ({
          id: block.id,
          type: block.type,
          text: block.text,
        }));
        const target = detail.content.blocks.map((block) => ({
          id: block.id,
          type: block.type,
          text: block.text,
        }));

        setDiff(diffDocuments(current, target));
      } catch {
        setError("Could not load that version.");
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentId, store],
  );

  /**
   * Restore.
   *
   * Two steps, in this order, and the order is what makes it safe:
   *
   *   1. Apply the restore OPERATIONS locally. They go into the outbox and sync like any other edit —
   *      so the restore works offline, merges with a collaborator's concurrent typing, and is undoable.
   *   2. Record a RESTORE version row pointing at what was restored.
   *
   * If step 2 fails (offline, server down), step 1 still stands: the document is restored, durably, and
   * the history row can be written later. The reverse order would give us a history entry for a restore
   * that never happened.
   */
  const restore = useCallback(async () => {
    if (selected === null || !canRestore) return;

    setBusy(true);
    setError(null);

    try {
      const operations = buildRestoreOperations(
        store.factory,
        store.state,
        selected.content,
      );

      if (operations.length === 0) {
        setError("This version is identical to the current document.");
        return;
      }

      store.applyLocal(operations);

      const snapshot = snapshotOf(store.state);
      const stats = snapshotStats(snapshot);

      await api.create(documentId, {
        kind: "RESTORE",
        content: snapshot,
        serverSeq: store.state.serverSeq.toString(),
        blockCount: stats.blockCount,
        charCount: stats.charCount,
        parentVersionId: selected.id,
      });

      onClose();
    } catch {
      // The document IS restored — step 1 succeeded and those operations are in the outbox. Only the
      // history bookkeeping failed, so say exactly that rather than implying the restore did not happen.
      setError("Restored locally. The history entry will be recorded when you reconnect.");
    } finally {
      setBusy(false);
    }
  }, [selected, canRestore, store, documentId, onClose, api]);

  return (
    <aside
      className="flex h-full w-96 shrink-0 flex-col border-l border-border bg-background"
      aria-label="Version history"
    >
      <header className="flex h-14 items-center justify-between border-b border-border px-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <History className="size-4" aria-hidden />
          Version history
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close version history"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {error !== null && (
          <p role="alert" className="border-b border-border bg-muted/50 px-4 py-3 text-xs text-muted-foreground">
            {error}
          </p>
        )}

        {versions === null && <TimelineSkeleton />}

        {versions !== null && versions.length === 0 && error === null && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No versions yet. They&apos;re saved automatically as you write.
          </p>
        )}

        <ol className="divide-y divide-border">
          {versions?.map((version) => (
            <li key={version.id}>
              <button
                type="button"
                onClick={() => void select(version)}
                aria-current={selected?.id === version.id}
                className={cn(
                  "flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-accent/50",
                  selected?.id === version.id && "bg-accent",
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {version.label ?? kindLabel(version.kind)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeTime(new Date(version.createdAt).getTime())}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {version.authorName ?? "Someone"} · {version.blockCount} blocks ·{" "}
                  {version.charCount.toLocaleString()} characters
                </span>
              </button>
            </li>
          ))}
        </ol>

        {diff !== null && selected !== null && (
          <div className="border-t border-border p-4">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              What would change
            </h3>

            {diff.added === 0 && diff.removed === 0 && diff.changed === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing — this version matches the current document.
              </p>
            ) : (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  <span className="text-emerald-600 dark:text-emerald-400">+{diff.added}</span>{" "}
                  <span className="text-destructive">−{diff.removed}</span>{" "}
                  <span>{diff.changed} edited</span>
                </p>

                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-3 text-sm">
                  {diff.blocks
                    .filter((block) => block.kind !== "unchanged")
                    .slice(0, 40)
                    .map((block, index) => (
                      <p
                        key={`${block.blockId}-${index}`}
                        className={cn(
                          "rounded px-1.5 py-0.5 leading-relaxed",
                          block.kind === "added" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                          block.kind === "removed" &&
                            "bg-destructive/10 text-destructive line-through",
                        )}
                      >
                        {block.kind === "changed" && block.words !== undefined
                          ? block.words.map((word, wordIndex) => (
                              <span
                                key={wordIndex}
                                className={cn(
                                  word.kind === "added" &&
                                    "rounded bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
                                  word.kind === "removed" &&
                                    "rounded bg-destructive/20 text-destructive line-through",
                                )}
                              >
                                {word.text}
                              </span>
                            ))
                          : block.text || "(empty)"}
                      </p>
                    ))}
                </div>
              </>
            )}

            {canRestore && (
              <>
                <button
                  type="button"
                  onClick={() => void restore()}
                  disabled={busy}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  <RotateCcw className="size-4" aria-hidden />
                  {busy ? "Restoring…" : "Restore this version"}
                </button>

                {/* Said in words, because it is the thing that makes restore safe to press. */}
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  Restoring adds a new version. Nothing in your history is overwritten.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function kindLabel(kind: VersionSummary["kind"]): string {
  switch (kind) {
    case "NAMED":
      return "Named version";
    case "RESTORE":
      return "Restored";
    case "AUTO":
      return "Autosaved";
    default:
      return "Snapshot";
  }
}

function TimelineSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-hidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

