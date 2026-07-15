"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { CollaborationClient, type ConnectionStatus, type Peer } from "@/collaboration/wsClient";
import type { RenderedBlock } from "@/crdt/types";
import { apiBaseUrl } from "@/lib/clientEnv";
import { db, getClientId } from "@/database/db";
import { DocumentStore } from "@/services/documentStore";
import { HttpTransport, type TokenProvider } from "@/services/transport";
import { CrossTabChannel } from "@/sync-engine/crossTab";
import { SyncEngine, type SyncState } from "@/sync-engine/syncEngine";
import { VersionApi } from "@/services/versionApi";
import { AutoSnapshot } from "@/versioning/autoSnapshot";

/**
 * Wire a document into React.
 *
 * `useSyncExternalStore` rather than `useState`: the store is mutated from outside React's world (a
 * WebSocket frame, a pull, another browser tab) and this is the hook that exists precisely for that.
 * Rolling it by hand with `useState` + an effect produces tearing under concurrent rendering — the
 * kind of bug that shows up as "a character occasionally renders twice" and is never reproducible.
 */

export interface UseDocumentResult {
  /** Publish this replica's caret. Ephemeral — never persisted, never an operation. */
  readonly setPresence: (blockId: string | null, anchor: string | null) => void;
  readonly store: DocumentStore | null;
  readonly blocks: readonly RenderedBlock[];
  readonly sync: SyncState;
  readonly ready: boolean;
  readonly peers: readonly Peer[];
  readonly connection: ConnectionStatus;
}

const EMPTY_BLOCKS: readonly RenderedBlock[] = [];
const INITIAL_SYNC: SyncState = {
  status: "idle",
  pendingCount: 0,
  deadLetterCount: 0,
  lastSyncedAt: null,
  nextAttemptAt: null,
  attempt: 0,
};

export function useDocument(documentId: string, getToken: TokenProvider): UseDocumentResult {
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [ready, setReady] = useState(false);
  const [peers, setPeers] = useState<readonly Peer[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const engineRef = useRef<SyncEngine | null>(null);
  const collabRef = useRef<CollaborationClient | null>(null);
  /** The last caret the user placed, held so it survives a client that does not exist yet. */
  const presenceRef = useRef<{ blockId: string | null; anchor: string | null } | null>(null);
  const channelRef = useRef<CrossTabChannel | null>(null);
  const snapshotRef = useRef<AutoSnapshot | null>(null);

  const apiUrl = useMemo(() => apiBaseUrl(), []);

  useEffect(() => {
    let disposed = false;
    const clientId = getClientId();

    void (async () => {
      // The persisted Lamport clock. Restoring it is not optional — see DocumentStore.persistClock.
      const checkpoint = await db.checkpoints.get(documentId);
      const nextStore = new DocumentStore(documentId, clientId, checkpoint?.clock ?? 0);

      const engine = new SyncEngine({
        documentId,
        clientId,
        transport: new HttpTransport(apiUrl, getToken),
        onRemoteOperations: (operations) => {
          nextStore.applyRemote(operations);
        },
        onResyncRequired: async () => {
          // The cursor fell below the compaction watermark. In a full implementation this fetches the
          // server snapshot; the local operation log plus the outbox are preserved, so the user's
          // unsynced work merges on top of whatever the snapshot contains.
          await db.checkpoints.put({
            documentId,
            lastServerSeq: "0",
            clock: nextStore.factory.clock,
            updatedAt: Date.now(),
          });
        },
        onStateChange: (state) => {
          nextStore.setSyncState(state);
        },
      });

      nextStore.attachEngine(engine);
      engineRef.current = engine;

      /**
       * Cross-tab fanout.
       *
       * Two tabs of the same document share one IndexedDB. Waiting for a server round trip to show a
       * keystroke from one in the other would be absurd — the operation is already on the device.
       * BroadcastChannel delivers it in under a millisecond; the CRDT dedupes it against the copy that
       * later arrives from the server, because operations are idempotent.
       */
      const channel = new CrossTabChannel(documentId, clientId, (operations) => {
        nextStore.applyRemote(operations);
      });
      nextStore.attachChannel(channel);
      channelRef.current = channel;

      /**
       * Automatic version snapshots.
       *
       * A version history containing only the versions people remembered to NAME is a version history
       * that is empty on the day someone needs it. Snapshot every 200 operations or 5 minutes of
       * activity — the first catches a burst (a big paste, an AI rewrite) that would otherwise leave a
       * hole in the timeline; the second catches a slow session that would otherwise have no restore
       * points at all.
       */
      const snapshots = new AutoSnapshot({
        store: nextStore,
        api: new VersionApi(apiUrl, getToken),
        documentId,
        enabled: true,
      });
      nextStore.onLocalOperations((count) => snapshots.onOperations(count));
      snapshots.start();
      snapshotRef.current = snapshots;

      /**
       * The realtime client.
       *
       * Note what it is NOT wired to: the outbox. Operations are delivered by the sync engine over
       * HTTP, which is the path that actually guarantees delivery. The socket only *accelerates*
       * inbound edits from collaborators — so if it never connects, the document still syncs and the
       * only thing lost is latency. Making the socket a delivery path would make it a delivery
       * *dependency*, and the product would break on hotel WiFi.
       */
      const collaboration = new CollaborationClient({
        url: apiUrl.replace(/^http/, "ws") + "/ws",
        documentId,
        clientId,
        getToken,
        onOperations: (operations) => {
          nextStore.applyRemote(operations);
        },
        onPeers: (nextPeers) => {
          // Do not render yourself in the presence list. Seeing your own avatar in "who is here" is
          // the kind of small wrongness that makes a product feel unfinished.
          setPeers(nextPeers.filter((peer) => peer.clientId !== clientId));
        },
        onStatus: setConnection,
      });
      collabRef.current = collaboration;

      /**
       * Hand the client any caret the user has already placed.
       *
       * This client is constructed *asynchronously* — after a token fetch and a store hydrate — and the
       * user is faster than that. Opening a document and clicking into a paragraph within a few hundred
       * milliseconds is not an edge case, it is the normal way to start writing, and every presence
       * update in that window went to `collabRef.current?.setPresence(...)` — an optional-chain on a ref
       * that was still null. Silently dropped.
       *
       * The consequence was not subtle, only invisible to the person suffering it: your caret never
       * reached anybody, and it never would, because presence is republished when it *changes* and a
       * caret that has been placed and left alone does not change. You were simply not in the document,
       * as far as your colleagues could see, until you moved.
       *
       * So the last caret is remembered here (`presenceRef`) as well as inside the client — the two
       * cover different windows: this one covers "the client does not exist yet", and the client's own
       * memory covers "the socket is not open yet" and every reconnect thereafter.
       */
      if (presenceRef.current !== null) {
        collaboration.setPresence(presenceRef.current.blockId, presenceRef.current.anchor);
      }

      void collaboration.connect();

      // Local first, in the literal order of operations: the document is on screen from IndexedDB
      // BEFORE the network is consulted about whether it even exists.
      await nextStore.hydrate();
      await engine.hydrate();

      if (disposed) {
        engine.dispose();
        collaboration.dispose();
        channel.close();
        snapshots.dispose();
        return;
      }

      setStore(nextStore);
      setReady(true);

      /**
       * Seed the first block only AFTER the initial sync settles.
       *
       * An empty local store does not mean an empty document — it means we have not pulled yet.
       * Seeding before the pull invents a paragraph that then syncs and duplicates the one already on
       * the server (and made two tabs each create their own). Waiting means "empty" is a fact.
       *
       * The  matters: offline, the sync REJECTS, and we must still seed — otherwise a brand-new
       * document created on a plane would have nothing to type into, which is the exact scenario this
       * product exists for.
       */
      void engine
        .syncNow()
        .catch(() => {})
        .finally(() => {
          if (!disposed) nextStore.seedIfEmpty();
        });
    })();

    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
      collabRef.current?.dispose();
      collabRef.current = null;
      channelRef.current?.close();
      channelRef.current = null;
      snapshotRef.current?.dispose();
      snapshotRef.current = null;
    };
  }, [documentId, apiUrl, getToken]);

  /**
   * Network transitions.
   *
   * `online` fires when the OS regains an interface — the single most valuable moment to flush the
   * outbox. `visibilitychange` covers the laptop-lid case, where the OS never reported a change but
   * hours have passed. Both are cheap and both are the difference between "syncs when you come back"
   * and "syncs when you next press a key".
   */
  useEffect(() => {
    const flush = (): void => {
      void engineRef.current?.syncNow();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") flush();
    };

    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const blocks = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? (() => EMPTY_BLOCKS),
    // The server snapshot. Server components never have a replica, and returning the client's would
    // hydrate against state the server never rendered — React's hydration mismatch, in its purest form.
    () => EMPTY_BLOCKS,
  );

  const sync = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSyncSnapshot ?? (() => INITIAL_SYNC),
    () => INITIAL_SYNC,
  );

  const setPresence = useCallback((blockId: string | null, anchor: string | null) => {
    // Remembered unconditionally, sent when there is something to send it on. Presence is *state* — the
    // caret is where it is whether or not a socket happens to exist at this instant — and the bug this
    // fixes came from treating it as an event that could simply be missed.
    presenceRef.current = { blockId, anchor };
    collabRef.current?.setPresence(blockId, anchor);
  }, []);

  return { store, blocks, sync, ready, peers, connection, setPresence };
}

function noopSubscribe(): () => void {
  return () => {};
}
