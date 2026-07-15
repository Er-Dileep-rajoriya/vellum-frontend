"use client";

import { History } from "lucide-react";
import { useMemo, useState } from "react";

import { ConnectionIndicator, Presence } from "@/components/Presence";
import { OfflineBanner, SyncStatus } from "@/components/SyncStatus";
import { ThemeToggle } from "@/components/ThemeProvider";
import { VersionHistory } from "@/components/versions/VersionHistory";
import { useDocument } from "@/hooks/useDocument";
import { apiBaseUrl } from "@/lib/clientEnv";
import { getAccessToken } from "@/services/tokenProvider";

import { Editor } from "./Editor";

/**
 * The workspace: the editor plus everything that tells the user the truth about their data.
 *
 * Note the loading state. It is a skeleton, not a spinner, and it is on screen for the duration of an
 * IndexedDB read — single-digit milliseconds — not a network round trip. If this ever visibly flashes,
 * something has gone wrong with the local-first promise and the fix is upstream, not here.
 */
export function DocumentWorkspace({ documentId }: { readonly documentId: string }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const apiUrl = useMemo(() => apiBaseUrl(), []);

  // The real provider: caches in memory, refreshes 60s before expiry, coalesces concurrent
  // refreshes into one round trip, and never writes the token to any browser storage.
  const getToken = getAccessToken;

  const { store, blocks, sync, ready, peers, connection, setPresence } = useDocument(
    documentId,
    getToken,
  );

  return (
    <div className="min-h-dvh">
      <OfflineBanner state={sync} />

      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-6">
          <h1 className="truncate text-sm font-medium">Untitled</h1>

          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connection} peerCount={peers.length} />
            <Presence peers={peers} />
            <SyncStatus state={sync} onRetry={() => store?.syncNow()} />

            <button
              type="button"
              onClick={() => setHistoryOpen((open) => !open)}
              aria-label="Version history"
              aria-expanded={historyOpen}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <History className="size-4" aria-hidden />
            </button>

            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="flex">
        <main className="mx-auto max-w-3xl flex-1 px-6 py-12">
          {!ready || store === null ? (
            <EditorSkeleton />
          ) : (
            <Editor
            store={store}
            blocks={blocks}
            readOnly={false}
            documentId={documentId}
            apiUrl={apiUrl}
            getToken={getToken}
            peers={peers}
            onPresence={setPresence}
          />
          )}
        </main>

        {historyOpen && store !== null && (
          <VersionHistory
            documentId={documentId}
            store={store}
            apiUrl={apiUrl}
            getToken={getToken}
            canRestore
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A skeleton shaped like the content it replaces, not a generic spinner.
 *
 * A spinner tells the user "something is happening". A skeleton tells them "a document is about to
 * appear, and it will look like this" — which prevents the layout shift that makes an app feel cheap,
 * and stops the eye from having to re-find its place when the content lands.
 */
function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-4 w-full animate-pulse rounded bg-muted" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
      <div className="h-4 w-4/6 animate-pulse rounded bg-muted" />
    </div>
  );
}
