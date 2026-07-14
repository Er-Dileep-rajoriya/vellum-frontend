import Dexie from "dexie";

import type { Operation } from "@/crdt/operations";
import { db, type StoredOperation } from "@/database/db";
import { deserializeOperation, type Transport } from "@/services/transport";

import { withSyncLock } from "./crossTab";

import { backoffDelay, DEFAULT_BACKOFF, isRetryable, SyncHttpError, type BackoffConfig } from "./backoff";

/**
 * The sync engine.
 *
 * A state machine, not a pile of setTimeouts. The states are explicit because every one of them is a
 * thing the UI must be able to show the user honestly — "offline", "syncing", "retrying in 4s",
 * "3 changes could not be saved" are all different, and a product that renders them all as a grey
 * cloud icon is a product that lies.
 *
 *          ┌──────────► IDLE ◄──────────────────────────┐
 *          │             │ outbox non-empty & online     │
 *          │             ▼                               │
 *          │         PUSHING ──ack──► PULLING ──► IDLE   │
 *          │             │                │              │
 *          │      network / 5xx / 429     │ 410 Gone     │
 *          │             ▼                ▼              │
 *          └────────  BACKOFF        RESYNCING ──────────┘
 *                        │
 *                   maxAttempts (8)
 *                        ▼
 *                  DEAD_LETTER  ← visible, exportable, never silently dropped
 *
 * Everything the engine does is safe to interrupt at any point, because every step is idempotent:
 * a push that is killed after the server commits but before the ack arrives is retried with the same
 * idempotency key and the same operation ids, and the server returns the original acknowledgement.
 * The engine therefore never needs to reason about "did that half-happen?" — the question does not
 * arise.
 */

export type SyncStatus =
  | "idle"
  | "syncing"
  | "backoff"
  | "offline"
  /** Operations were rejected permanently. The user must be told. */
  | "error";

export interface SyncState {
  readonly status: SyncStatus;
  readonly pendingCount: number;
  readonly deadLetterCount: number;
  readonly lastSyncedAt: number | null;
  /** When in backoff: when the next attempt fires. Lets the UI count down honestly. */
  readonly nextAttemptAt: number | null;
  readonly attempt: number;
}

export interface SyncEngineOptions {
  readonly documentId: string;
  readonly clientId: string;
  readonly transport: Transport;
  /** Called with operations pulled from the server, to be folded into the CRDT. */
  readonly onRemoteOperations: (operations: Operation[]) => void;
  /** Called when the cursor falls below the compaction watermark: bootstrap from a snapshot. */
  readonly onResyncRequired: () => Promise<void>;
  readonly onStateChange?: (state: SyncState) => void;
  readonly backoff?: BackoffConfig;
  /** Injectable for tests: real timers make a state-machine test slow, flaky, and useless. */
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => number;
  readonly clearTimer?: (handle: number) => void;
  /**
   * The randomness behind the backoff jitter — injectable for the same reason the clock is.
   *
   * `backoff.ts` already took a `random` parameter for exactly this purpose, and the engine ignored it
   * and let `Math.random()` through. The consequence was a genuinely flaky test: full jitter picks a
   * delay in `[0, cap]`, so the retry sometimes landed *inside* the window the test had advanced the
   * virtual clock through, and an assertion on `status === "backoff"` would find `idle` instead. It
   * failed roughly one run in three — the worst possible failure rate, frequent enough to erode trust
   * in the suite and rare enough to be dismissed as "just CI being CI".
   *
   * A virtual clock is only half a deterministic test if the *delays* are still random. This is the
   * other half.
   */
  readonly random?: () => number;
}

/** Batch caps. Must not exceed the server's, or every push is a guaranteed 413/422. */
const MAX_OPERATIONS_PER_BATCH = 500;

/**
 * Coalesce a burst of keystrokes into one round trip. 400ms is long enough to batch a typed word and
 * short enough that a collaborator sees you typing rather than teleporting. It is NOT the autosave
 * interval — the operation was already durable in IndexedDB the moment it was authored. This debounce
 * only decides when the *network* finds out.
 */
const PUSH_DEBOUNCE_MS = 400;

export class SyncEngine {
  readonly #options: Required<
    Pick<SyncEngineOptions, "backoff" | "now" | "setTimer" | "clearTimer" | "random">
  > &
    SyncEngineOptions;

  #status: SyncStatus = "idle";
  #attempt = 0;
  #lastSyncedAt: number | null = null;
  #nextAttemptAt: number | null = null;
  #deadLetterCount = 0;
  #pendingCount = 0;

  /**
   * The sync lock, in-process.
   *
   * Two overlapping syncs would push the same operations twice (harmless — idempotent) and, far worse,
   * could advance the checkpoint out of order, so a pull could skip a page of operations. The Web
   * Locks API handles the *cross-tab* case; this handles the in-tab case, which is the one that
   * actually happens (a debounced push racing a scheduler tick).
   */
  #running = false;
  #rerunRequested = false;
  /**
   * The in-flight sync cycle, if any.
   *
   * Exposed via `settled()` so callers — the tests, and the "sync before you close the tab" handler —
   * can await a cycle that was started by a timer rather than by them. Without it the only way to
   * observe completion is to sleep and hope, which produces tests that pass on a fast machine and fail
   * in CI, and a beforeunload handler that races the very flush it exists to perform.
   */
  #inflight: Promise<void> | null = null;

  #timer: number | null = null;
  #debounce: number | null = null;
  #disposed = false;

  constructor(options: SyncEngineOptions) {
    this.#options = {
      backoff: DEFAULT_BACKOFF,
      now: () => Date.now(),
      setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
      clearTimer: (handle) => {
        globalThis.clearTimeout(handle);
      },
      random: () => Math.random(),
      ...options,
    };
  }

  get state(): SyncState {
    return {
      status: this.#status,
      pendingCount: this.#pendingCount,
      deadLetterCount: this.#deadLetterCount,
      lastSyncedAt: this.#lastSyncedAt,
      nextAttemptAt: this.#nextAttemptAt,
      attempt: this.#attempt,
    };
  }

  /**
   * A local operation was authored. Persist it and schedule a push.
   *
   * Note what this does NOT do: block. The operation is already in the in-memory CRDT (the editor has
   * rendered it), and the durable write plus the network are both deferred. The keystroke is done.
   */
  async enqueue(operation: Operation): Promise<void> {
    const localSeq = await this.#nextLocalSeq();

    await db.operations.put({
      operationId: operation.operationId,
      documentId: this.#options.documentId,
      localSeq,
      operation,
      serverSeq: null, // ← this is the outbox: null means "not yet on the server"
      createdAt: this.#options.now(),
    });

    this.#pendingCount += 1;
    this.#options.onStateChange?.(this.state);
    this.#scheduleDebouncedSync();
  }

  /**
   * Rehydrate after a reload: the outbox lives in IndexedDB, so its depth must be read back rather
   * than assumed to be zero. A UI that shows "all synced" while three operations sit unsent on disk is
   * a UI that is lying about the one thing the user needs to trust.
   */
  async hydrate(): Promise<void> {
    const [pending, deadLetters] = await Promise.all([
      db.operations
        .where("documentId")
        .equals(this.#options.documentId)
        .filter((row) => row.serverSeq === null)
        .count(),
      db.deadLetters.where("documentId").equals(this.#options.documentId).count(),
    ]);

    this.#pendingCount = pending;
    this.#deadLetterCount = deadLetters;
    this.#options.onStateChange?.(this.state);
  }

  async syncNow(): Promise<void> {
    if (this.#debounce !== null) {
      this.#options.clearTimer(this.#debounce);
      this.#debounce = null;
    }
    await this.#runSync();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) this.#options.clearTimer(this.#timer);
    if (this.#debounce !== null) this.#options.clearTimer(this.#debounce);
  }

  #scheduleDebouncedSync(): void {
    if (this.#debounce !== null) this.#options.clearTimer(this.#debounce);
    this.#debounce = this.#options.setTimer(() => {
      this.#debounce = null;
      void this.#runSync();
    }, PUSH_DEBOUNCE_MS);
  }

  /**
   * One sync cycle: push the outbox, then pull what we are missing.
   *
   * Push before pull, always. If we pulled first, we would fold remote operations into the CRDT and
   * *then* push ours — which is correct (the CRDT does not care about order) but produces a worse
   * experience: the user's own unsynced changes would appear to "arrive" after everyone else's,
   * reordering the visible timeline for no reason.
   */
  /** Await the in-flight sync cycle, if there is one. Resolves immediately when idle. */
  async settled(): Promise<void> {
    await this.#inflight;
  }

  #runSync(): Promise<void> {
    if (this.#disposed) return Promise.resolve();

    // Re-entrancy guard. A second call while one is in flight is not dropped — it is remembered, and
    // the cycle runs again when the current one finishes. Dropping it would mean an operation authored
    // mid-sync sits in the outbox until the next tick, for no reason. Returning the in-flight promise
    // (rather than a resolved one) means a caller awaiting `syncNow()` during a cycle waits for the
    // work their call actually caused, not just for the cycle that happened to already be running.
    if (this.#running) {
      this.#rerunRequested = true;
      return this.#inflight ?? Promise.resolve();
    }

    this.#running = true;
    this.#inflight = (async () => {
      try {
        /**
         * The cross-tab sync lock.
         *
         * Only one tab in the browser syncs a given document at a time. Two tabs draining the same
         * IndexedDB outbox would race to advance the same checkpoint — and a checkpoint that moves
         * out of order lets a pull skip a page of operations, which is silent, permanent data loss
         * dressed up as a performance optimisation.
         *
         *  SKIPS rather than queues when another tab holds the lock: that tab is
         * draining the very outbox we would drain, so the work is not lost — it is being done.
         */
        await withSyncLock(this.#options.documentId, async () => {
          do {
            this.#rerunRequested = false;
            await this.#syncOnce();
          } while (this.#rerunRequested && !this.#disposed);
        });
      } finally {
        this.#running = false;
        this.#inflight = null;
      }
    })();

    return this.#inflight;
  }

  async #syncOnce(): Promise<void> {
    if (!this.#isOnline()) {
      this.#setStatus("offline");
      return;
    }

    this.#setStatus("syncing");

    try {
      await this.#push();
      await this.#pull();

      this.#attempt = 0;
      this.#nextAttemptAt = null;
      this.#lastSyncedAt = this.#options.now();
      this.#setStatus(this.#deadLetterCount > 0 ? "error" : "idle");
    } catch (error) {
      await this.#handleFailure(error);
    }
  }

  async #push(): Promise<void> {
    const outbox = await db.operations
      .where("[documentId+localSeq]")
      .between([this.#options.documentId, Dexie.minKey], [this.#options.documentId, Dexie.maxKey])
      .filter((row) => row.serverSeq === null)
      .limit(MAX_OPERATIONS_PER_BATCH)
      .toArray();

    if (outbox.length === 0) return;

    /**
     * The idempotency key is derived from the batch's contents, not generated fresh.
     *
     * If it were random per attempt, a retry after a lost response would look like a brand-new
     * request to the server — which would be *safe* (per-operation ids still dedupe) but would defeat
     * the response cache and could return a different acknowledgement shape. Deriving it from the
     * first and last operation ids means the same batch always carries the same key, across retries,
     * across reloads, across process restarts.
     */
    const idempotencyKey = this.#batchKey(outbox);

    const response = await this.#options.transport.push(
      this.#options.documentId,
      this.#options.clientId,
      outbox.map((row) => row.operation),
      idempotencyKey,
    );

    // Mark acknowledged. This is the ONLY place an operation leaves the outbox, and it happens after
    // the server has confirmed durability. A crash before this line means the operations are retried
    // and the server dedupes them — nothing is lost, nothing is doubled.
    await db.transaction("rw", db.operations, async () => {
      for (const ack of response.acknowledged) {
        await db.operations.update(ack.operationId, { serverSeq: ack.serverSeq });
      }
    });

    this.#pendingCount = Math.max(0, this.#pendingCount - response.acknowledged.length);
  }

  async #pull(): Promise<void> {
    const checkpoint = await db.checkpoints.get(this.#options.documentId);
    const since = checkpoint?.lastServerSeq ?? "0";

    let cursor = since;
    let hasMore = true;

    // Page until drained. A client returning from a week offline has thousands of operations waiting,
    // and pulling them in one request would mean a multi-megabyte response and a UI frozen while it
    // folds. Paging keeps both bounded, and each page advances the checkpoint — so an interruption
    // mid-catch-up resumes from where it stopped rather than starting over.
    while (hasMore && !this.#disposed) {
      const response = await this.#options.transport.pull(
        this.#options.documentId,
        cursor,
        this.#options.clientId,
      );

      if (response.operations.length > 0) {
        const operations = response.operations.map(deserializeOperation);

        // Store remote operations locally too. They are already durable on the server, so `serverSeq`
        // is set — they are NOT in the outbox. Persisting them means a reload replays them from disk
        // instead of refetching, which is what makes an offline reload instant.
        await db.transaction("rw", db.operations, async () => {
          for (const [index, operation] of operations.entries()) {
            await db.operations.put({
              operationId: operation.operationId,
              documentId: this.#options.documentId,
              localSeq: 0,
              operation,
              serverSeq: response.operations[index]!.serverSeq,
              createdAt: this.#options.now(),
            });
          }
        });

        this.#options.onRemoteOperations(operations);
        cursor = response.operations[response.operations.length - 1]!.serverSeq;

        await db.checkpoints.put({
          documentId: this.#options.documentId,
          lastServerSeq: cursor,
          clock: checkpoint?.clock ?? 0,
          updatedAt: this.#options.now(),
        });
      }

      hasMore = response.hasMore;
    }
  }

  /**
   * Something failed. Decide: retry, or give up loudly.
   *
   * This is the most consequential branch in the client. Getting it wrong in one direction means a
   * client that retries a malformed operation until the heat death of the universe; in the other, a
   * client that silently discards a user's paragraph because of a transient 503.
   */
  async #handleFailure(error: unknown): Promise<void> {
    // 410 Gone: our cursor is below the server's compaction watermark. Not retryable, and not a
    // failure — the operations we want simply are not shipped any more. Bootstrap from a snapshot and
    // replay our outbox on top. Nothing is lost: our unsynced operations are CRDT operations, so they
    // merge into whatever the snapshot contains.
    if (error instanceof SyncHttpError && error.code === "GONE") {
      this.#setStatus("syncing");
      await this.#options.onResyncRequired();
      this.#attempt = 0;
      this.#setStatus("idle");
      return;
    }

    if (!isRetryable(error)) {
      // Permanent. The operations in this batch will never be accepted. Move them to the dead-letter
      // queue where the user can SEE them, export them, and where support can replay them once the
      // bug that produced them is fixed. Silence is not an option.
      await this.#deadLetter(error);
      this.#setStatus("error");
      return;
    }

    if (!this.#isOnline()) {
      // Offline is not a failure; it is the product working as designed. No backoff, no attempt
      // counter, no error state — the outbox simply waits, and the `online` listener kicks it.
      this.#setStatus("offline");
      return;
    }

    if (!this.#shouldRetry()) {
      await this.#deadLetter(error);
      this.#setStatus("error");
      return;
    }

    // A 429 tells us exactly how long to wait. Obeying it is strictly better than guessing, and it is
    // the difference between backing off and being banned.
    const serverDelay =
      error instanceof SyncHttpError && error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds * 1_000
        : null;

    const delay = serverDelay ?? backoffDelay(this.#attempt, this.#options.backoff, this.#options.random);

    this.#attempt += 1;
    this.#nextAttemptAt = this.#options.now() + delay;
    this.#setStatus("backoff");

    if (this.#timer !== null) this.#options.clearTimer(this.#timer);
    this.#timer = this.#options.setTimer(() => {
      this.#timer = null;
      void this.#runSync();
    }, delay);
  }

  #shouldRetry(): boolean {
    return this.#attempt < this.#options.backoff.maxAttempts;
  }

  async #deadLetter(error: unknown): Promise<void> {
    const outbox = await db.operations
      .where("documentId")
      .equals(this.#options.documentId)
      .filter((row) => row.serverSeq === null)
      .limit(MAX_OPERATIONS_PER_BATCH)
      .toArray();

    const code = error instanceof SyncHttpError ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);

    await db.transaction("rw", db.operations, db.deadLetters, async () => {
      for (const row of outbox) {
        await db.deadLetters.put({
          operationId: row.operationId,
          documentId: row.documentId,
          operation: row.operation,
          code,
          message,
          attempts: this.#attempt,
          failedAt: this.#options.now(),
        });
        // Remove from the outbox — but ONLY after it is durably in the dead-letter table, and in the
        // same transaction, so a crash between the two cannot lose the operation entirely. The
        // operation still exists in `deadLetters`; it is visible, exportable, and replayable.
        await db.operations.delete(row.operationId);
      }
    });

    this.#deadLetterCount += outbox.length;
    this.#pendingCount = Math.max(0, this.#pendingCount - outbox.length);
    this.#attempt = 0;
  }

  /**
   * The batch's idempotency key: a pure function of its CONTENTS.
   *
   * It must be deterministic, so a retry of the same batch (after a lost response, after a reload,
   * after the process was killed) presents the same key and the server replays its original
   * acknowledgement instead of re-committing.
   *
   * It must ALSO change when the contents change. That is the non-obvious half: a client that pushes
   * [a, b], gets no response, then authors `c` and retries with [a, b, c] would — with a
   * "first operation id" key — send the SAME key with a DIFFERENT body, which the server correctly
   * rejects as a mismatch (422). Hashing every operation id in the batch makes the key follow the
   * body, so a grown batch is honestly a new request.
   */
  #batchKey(rows: readonly StoredOperation[]): string {
    return crockfordUlidFromIds(rows.map((row) => row.operationId));
  }

  async #nextLocalSeq(): Promise<number> {
    const last = await db.operations
      .where("[documentId+localSeq]")
      .between([this.#options.documentId, Dexie.minKey], [this.#options.documentId, Dexie.maxKey])
      .last();
    return (last?.localSeq ?? 0) + 1;
  }

  #isOnline(): boolean {
    /**
     * `navigator.onLine === true` is a lie on a captive portal — the hotel WiFi that demands a login
     * reports "online" while dropping every request. `=== false` is never wrong in that direction: the
     * OS knows when there is no interface at all. So we trust the negative and distrust the positive.
     * "Maybe online" simply means we try, and a failure feeds the normal retry path.
     *
     * The `typeof !== "boolean"` guard is not defensive noise. Node 18+ defines a global `navigator`
     * (with only `userAgent`), so `navigator.onLine` is `undefined` there — and `return
     * navigator.onLine` would coerce that to false and declare the engine permanently offline in
     * every non-browser runtime, including SSR and the test suite. Which is precisely how this bug was
     * found: seven tests failing with status "offline" against a transport that was perfectly healthy.
     */
    if (typeof navigator === "undefined") return true;
    if (typeof navigator.onLine !== "boolean") return true;
    return navigator.onLine;
  }

  #setStatus(status: SyncStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStateChange?.(this.state);
  }
}

/** Crockford base32 — the ULID alphabet. The server validates the key against exactly this shape. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A stable 26-character Crockford-base32 key derived from a batch's operation ids.
 *
 * Four independent FNV-1a accumulators over the concatenated ids, so the key depends on every id, on
 * their order, and on the batch length. This is a *collision-avoidance* device, not a security one —
 * the key is not a secret and the server's per-operation uniqueness constraint is what actually
 * guarantees safety. A collision here would cause a spurious 422 on one push, which the engine
 * retries; it cannot cause a double commit.
 */
function crockfordUlidFromIds(ids: readonly string[]): string {
  const accumulators = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const joined = ids.join("|");

  for (let i = 0; i < joined.length; i += 1) {
    const code = joined.charCodeAt(i);
    for (let a = 0; a < accumulators.length; a += 1) {
      accumulators[a] = Math.imul(accumulators[a]! ^ code, 16_777_619 + a * 2) >>> 0;
    }
  }

  let key = "";
  for (let i = 0; i < 26; i += 1) {
    const accumulator = accumulators[i % accumulators.length]!;
    const shift = Math.floor(i / accumulators.length) * 5;
    key += CROCKFORD[(accumulator >>> shift) & 31]!;
  }

  return key;
}
