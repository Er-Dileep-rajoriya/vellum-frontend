import { render } from "@/crdt/document";
import { OperationFactory } from "@/crdt/factory";
import type { Operation } from "@/crdt/operations";
import { Replica } from "@/crdt/replica";
import type { DocumentState, RenderedBlock } from "@/crdt/types";
import { generateKeyBetween } from "@/crdt/fracIndex";
import { db } from "@/database/db";
import type { CrossTabChannel } from "@/sync-engine/crossTab";
import type { SyncEngine, SyncState } from "@/sync-engine/syncEngine";

/**
 * The document store: the bridge between the CRDT and everything else.
 *
 * It owns exactly three things — the replica, the operation factory, and the rendered view — and it
 * enforces the one invariant that ties them together:
 *
 *      **Every operation that enters this replica also advances the factory's Lamport clock.**
 *
 * That is not a nicety. A replica that folds a remote operation without observing its clock will mint
 * its next character with a counter below one it has already seen, breaking the `id > origin.id`
 * invariant the RGA depends on, and two users typing at the same caret get their words shredded into
 * each other (see DECISIONS.md D-003 — this bug was real, and the property test caught it). Routing
 * every operation through `#absorb` means there is exactly one place that can get it wrong, and it
 * doesn't.
 *
 * Framework-agnostic on purpose: React subscribes to it, but it has no idea React exists. That keeps
 * the CRDT testable without a renderer, and it means a future worker or a CLI can drive the same store.
 */

export type Listener = () => void;

export class DocumentStore {
  readonly documentId: string;
  readonly #replica: Replica;
  readonly #factory: OperationFactory;
  #engine: SyncEngine | null = null;
  #channel: CrossTabChannel | null = null;
  #onLocalOperations: ((count: number) => void) | null = null;

  /**
   * The rendered view, cached.
   *
   * `useSyncExternalStore` calls `getSnapshot()` on every render and will loop forever if it returns a
   * new object each time. So the view is recomputed only when the state actually changes — which also
   * means React's referential equality checks do real work: an unchanged block keeps its identity, and
   * its component does not re-render. On a 500-block document, one keystroke re-renders one block.
   */
  #view: RenderedBlock[];
  #syncState: SyncState = {
    status: "idle",
    pendingCount: 0,
    deadLetterCount: 0,
    lastSyncedAt: null,
    nextAttemptAt: null,
    attempt: 0,
  };

  readonly #listeners = new Set<Listener>();

  constructor(documentId: string, clientId: string, clock = 0) {
    this.documentId = documentId;
    this.#replica = new Replica();
    this.#factory = new OperationFactory(clientId, { clock });
    this.#view = [];
  }

  attachEngine(engine: SyncEngine): void {
    this.#engine = engine;
  }

  attachChannel(channel: CrossTabChannel): void {
    this.#channel = channel;
  }

  /** Notified for every LOCALLY-authored operation. Drives the auto-snapshot cadence. */
  onLocalOperations(listener: (count: number) => void): void {
    this.#onLocalOperations = listener;
  }

  get factory(): OperationFactory {
    return this.#factory;
  }

  /**
   * The raw CRDT state.
   *
   * Exposed for versioning (diff and restore both need the full state, tombstones included — a diff
   * computed from the *rendered* view cannot see what was deleted). Deliberately read-only: the only
   * ways to change this store are `applyLocal` and `applyRemote`, both of which route through the
   * single choke point that advances the Lamport clock.
   */
  get state(): DocumentState {
    return this.#replica.state;
  }

  get blocks(): readonly RenderedBlock[] {
    return this.#view;
  }

  get syncState(): SyncState {
    return this.#syncState;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): readonly RenderedBlock[] => this.#view;
  getSyncSnapshot = (): SyncState => this.#syncState;

  /**
   * Apply operations authored HERE.
   *
   * Local-first, literally: the CRDT is updated and the UI re-rendered synchronously, then the
   * operations are handed to the sync engine, which persists them and (eventually) ships them. The
   * user's keystroke has landed on screen before any promise has resolved.
   */
  applyLocal(operations: readonly Operation[]): void {
    if (operations.length === 0) return;

    this.#absorb(operations);

    /**
     * Tell the other tabs immediately — over BroadcastChannel, with no server in the loop.
     *
     * They share this device and this IndexedDB. Waiting for a round trip to show a keystroke in a
     * second tab of the same browser would be absurd, and it is also *wrong*: with no network, it
     * would never arrive at all. (That is exactly how the E2E caught this line being missing — the
     * two tabs appeared to sync, but only because the server was quietly relaying between them.)
     */
    this.#channel?.post(operations);
    this.#onLocalOperations?.(operations.length);

    // Fire-and-forget: the durable write and the network are both off the keystroke path. `enqueue`
    // cannot lose the operation — it is already in the in-memory CRDT, and a failure to persist would
    // surface on the next flush rather than corrupting anything.
    void Promise.all(operations.map((op) => this.#engine?.enqueue(op)));
  }

  /** Apply operations that arrived from the server (pull or WebSocket) or from another tab. */
  applyRemote(operations: readonly Operation[]): void {
    if (operations.length === 0) return;
    this.#absorb(operations);
  }

  /**
   * The single choke point. Observe, ingest, re-render, notify — in that order.
   *
   * Observe BEFORE ingest: the clock must be advanced past an operation before this replica could
   * possibly author a successor to it.
   */
  #absorb(operations: readonly Operation[]): void {
    for (const op of operations) this.#factory.observe(op);

    const result = this.#replica.ingest(operations);

    if (result.needsResync) {
      // The pending buffer overflowed: this replica has lost so much causal context that incremental
      // reconciliation is no longer the cheap path. Ask the engine to bootstrap from a snapshot. The
      // outbox is untouched, so nothing the user wrote is lost.
      void this.#engine?.syncNow();
    }

    // Re-render only if something actually applied. A batch of pure duplicates (a WebSocket broadcast
    // racing an HTTP pull — which happens constantly by design) must not repaint the editor.
    if (result.applied.length > 0) {
      this.#view = render(this.#replica.state);
      this.#emit();
    }
  }

  setSyncState(state: SyncState): void {
    this.#syncState = state;
    this.#emit();
  }

  /** Force a sync — the user pressed "retry", or the network just came back. */
  syncNow(): void {
    void this.#engine?.syncNow();
  }

  /**
   * The user pressed "Retry" on the "couldn't be saved" badge: move EVERY dead-lettered operation
   * (recoverable or not) back into the outbox and sync. This is the manual escape hatch that makes a
   * dead-letter non-terminal — the writing is never truly stuck as long as this exists.
   */
  retryFailed(): void {
    void this.#engine?.requeueDeadLetters(false);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  /**
   * Load from IndexedDB: replay the local operation log into the CRDT.
   *
   * This is what makes an offline reload instant — and what makes it *possible*. The operations are on
   * disk; the server is not consulted; the document is on screen before the network has been asked
   * whether it exists.
   */
  async hydrate(): Promise<void> {
    const stored = await db.operations.where("documentId").equals(this.documentId).toArray();

    // Sort so that acknowledged operations are replayed in the server's order, and local unsynced ones
    // afterwards in authoring order. Order does not affect the final state (that is the whole point of
    // a CRDT) but it minimises pending-buffer churn during the replay, which on a large document is
    // the difference between an instant open and a visible stutter.
    stored.sort((a, b) => {
      if (a.serverSeq !== null && b.serverSeq !== null) {
        return Number(BigInt(a.serverSeq) - BigInt(b.serverSeq));
      }
      if (a.serverSeq !== null) return -1;
      if (b.serverSeq !== null) return 1;
      return a.localSeq - b.localSeq;
    });

    this.#absorb(stored.map((row) => row.operation));

    // Persist the clock. It MUST survive a reload: a clock that restarts at zero would mint character
    // ids that already exist in this document — two distinct characters with one identity, which is
    // the end of the CRDT's ability to reason about anything.
    await this.persistClock();
  }

  /**
   * Seed the first block — but ONLY once we actually know the document is empty.
   *
   * This is deliberately NOT part of `hydrate()`, and that was a real bug an E2E test caught. Hydrate
   * replays what is on *this device*; a device that has never seen this document has nothing, and an
   * empty local store does not mean an empty document — it means we have not pulled yet.
   *
   * Creating a block there produces a spurious empty paragraph on every fresh device, which then syncs
   * and *duplicates* the one already on the server. Two tabs opening the same document each invented
   * their own.
   *
   * So: call this only after the first sync attempt has settled — succeeded (we now know what the
   * server has) or failed (we are offline, and this device's copy is all there is). Both are moments
   * when "empty" is a fact rather than a guess.
   */
  seedIfEmpty(): void {
    if (this.#view.length > 0) return;

    /**
     * A DETERMINISTIC block id, derived from the document.
     *
     * Even after waiting for the first sync, two replicas can still both conclude a brand-new document
     * is empty (they opened it at the same moment, or both offline). With random ids they would mint
     * two different first blocks; the CRDT would faithfully keep both, and the user would get a
     * duplicate empty paragraph nobody asked for.
     *
     * A deterministic id makes the two seeds *the same operation*, and `BLOCK_INSERT` on an existing
     * block is already a no-op. The race resolves itself using idempotency the engine already has,
     * rather than a lock or a coordination round trip.
     */
    this.applyLocal([
      this.#factory.insertBlock(
        "paragraph",
        generateKeyBetween(null, null),
        {},
        `seed-${this.documentId}`,
      ),
    ]);
  }

  async persistClock(): Promise<void> {
    const existing = await db.checkpoints.get(this.documentId);
    await db.checkpoints.put({
      documentId: this.documentId,
      lastServerSeq: existing?.lastServerSeq ?? "0",
      clock: this.#factory.clock,
      updatedAt: Date.now(),
    });
  }
}
