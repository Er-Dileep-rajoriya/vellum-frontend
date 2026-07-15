import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OperationFactory } from "@/crdt/factory";
import { generateKeyBetween } from "@/crdt/fracIndex";
import type { Operation } from "@/crdt/operations";
import { db } from "@/database/db";
import { SyncHttpError } from "@/sync-engine/backoff";
import { backoffDelay, DEFAULT_BACKOFF } from "@/sync-engine/backoff";
import { SyncEngine } from "@/sync-engine/syncEngine";
import type { PullResponse, PushResponse, Transport } from "@/services/transport";

/**
 * The sync engine, tested against a HOSTILE network.
 *
 * A sync engine that only works against a cooperative server is a sync engine tested against the one
 * condition it will never encounter. The fake transport below can: go offline, return 500s, return
 * 429s with Retry-After, reject permanently with a 422, commit a batch and then *drop the response*
 * (the single nastiest real-world failure, because the client cannot distinguish it from a request
 * that never arrived), and come back with a 410 telling the client its cursor is too old.
 *
 * Time is injected. A state machine tested with real timers is slow, flaky, and — because you cannot
 * assert on a delay you did not control — proves almost nothing about the backoff it claims to have.
 */

interface Scenario {
  /** Every push the server actually committed, in order. Duplicates here would be a bug. */
  readonly committed: Operation[];
  failNextPushes: number;
  failWith: SyncHttpError | Error | null;
  /** Simulates the server committing the batch and then the response being lost. */
  dropNextResponse: boolean;
  pushCalls: number;
  idempotencyKeys: string[];
}

function makeTransport(scenario: Scenario): Transport {
  const committedIds = new Set<string>();

  return {
    async push(_documentId, _clientId, operations, idempotencyKey): Promise<PushResponse> {
      scenario.pushCalls += 1;
      scenario.idempotencyKeys.push(idempotencyKey);

      if (scenario.failNextPushes > 0) {
        scenario.failNextPushes -= 1;
        throw scenario.failWith ?? new TypeError("Failed to fetch");
      }

      // The server-side commit, with the same idempotency the real one has: an operation already
      // committed is acknowledged with its ORIGINAL sequence number and is not written twice.
      const acknowledged = operations.map((op) => {
        if (!committedIds.has(op.operationId)) {
          committedIds.add(op.operationId);
          scenario.committed.push(op);
        }
        const index = scenario.committed.findIndex((c) => c.operationId === op.operationId);
        return {
          operationId: op.operationId,
          serverSeq: String(index + 1),
          userId: "user-1",
        };
      });

      if (scenario.dropNextResponse) {
        scenario.dropNextResponse = false;
        // Committed. Response lost. From the client's side this is indistinguishable from a request
        // that never left the machine — which is exactly why idempotency has to be structural.
        throw new TypeError("Failed to fetch");
      }

      return { acknowledged, duplicateCount: 0, documentSeq: String(scenario.committed.length) };
    },

    async pull(): Promise<PullResponse> {
      return { operations: [], hasMore: false, documentSeq: String(scenario.committed.length) };
    },
  };
}

/** Deterministic virtual clock. Timers fire when the test says so, not when the OS feels like it. */
class VirtualClock {
  #now = 0;
  #handle = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.#now;

  setTimer = (fn: () => void, ms: number): number => {
    this.#handle += 1;
    this.#timers.set(this.#handle, { at: this.#now + ms, fn });
    return this.#handle;
  };

  clearTimer = (handle: number): void => {
    this.#timers.delete(handle);
  };

  /** Advance time, firing timers in order. Returns the number fired. */
  async advance(ms: number): Promise<number> {
    const target = this.#now + ms;
    let fired = 0;

    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at);

      const next = due[0];
      if (next === undefined) break;

      this.#timers.delete(next[0]);
      this.#now = next[1].at;
      next[1].fn();
      fired += 1;

      // Let the promise chain the timer kicked off actually run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    this.#now = target;
    return fired;
  }
}

const DOCUMENT_ID = "doc-1";

function makeOps(count: number): Operation[] {
  const factory = new OperationFactory("client-a");
  const blockOp = factory.insertBlock("paragraph", generateKeyBetween(null, null));
  const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;

  const ops: Operation[] = [blockOp];
  let anchor: string | null = null;
  for (let i = 1; i < count; i += 1) {
    const op = factory.insertText(blockId, anchor, String(i));
    anchor = (op as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload.charId;
    ops.push(op);
  }
  return ops;
}

function newScenario(): Scenario {
  return {
    committed: [],
    failNextPushes: 0,
    failWith: null,
    dropNextResponse: false,
    pushCalls: 0,
    idempotencyKeys: [],
  };
}

describe("sync engine", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    await db.close();
  });

  it("persists operations locally before the network is involved at all", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const [op] = makeOps(1);
    await engine.enqueue(op!);

    // Durable immediately. The network has not been touched: a keystroke is saved before it is sent,
    // and the user never waits for a server to acknowledge their own typing.
    const stored = await db.operations.get(op!.operationId);
    expect(stored).toBeDefined();
    expect(stored!.serverSeq).toBeNull(); // in the outbox
    expect(scenario.pushCalls).toBe(0);

    engine.dispose();
  });

  it("syncs the outbox after the debounce, and empties it", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (const op of makeOps(5)) await engine.enqueue(op);
    expect(engine.state.pendingCount).toBe(5);

    await clock.advance(500); // past the 400ms debounce
    await engine.settled();

    // Five operations, ONE round trip. The debounce coalesced a burst of typing into a single push —
    // which is the difference between a request per keystroke and a request per word.
    expect(scenario.pushCalls).toBe(1);
    expect(scenario.committed).toHaveLength(5);
    expect(engine.state.pendingCount).toBe(0);

    const remaining = await db.operations.filter((row) => row.serverSeq === null).count();
    expect(remaining).toBe(0);

    engine.dispose();
  });

  /**
   * THE test. The server commits the batch and the response is lost.
   *
   * The client cannot tell this apart from "the request never arrived", so it must retry — and the
   * retry must not duplicate the user's text. This is not an exotic edge case: it is what happens
   * every time someone walks into a lift, and it is the reason idempotency is structural rather than
   * best-effort.
   */
  it("does not duplicate operations when the server commits but the response is lost", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    scenario.dropNextResponse = true;

    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      // Full jitter, pinned to its maximum. Without this the backoff delay is `Math.random() * cap`,
      // which sometimes lands INSIDE the 500ms this test advances through — the retry fires early, the
      // engine is back to `idle`, and the assertion below fails. It did, about one run in three.
      // Pinning the jitter is what makes the state machine's state observable at a known instant.
      random: () => 1,
    });

    for (const op of makeOps(3)) await engine.enqueue(op);

    await clock.advance(500);
    await engine.settled();

    // First attempt: committed server-side, response lost → the engine backs off.
    expect(engine.state.status).toBe("backoff");
    expect(scenario.committed).toHaveLength(3);

    // Retry.
    await clock.advance(DEFAULT_BACKOFF.maxMs);
    await engine.settled();

    expect(scenario.pushCalls).toBe(2);
    // Still three. The retry was deduplicated by operationId — the user's text was not doubled.
    expect(scenario.committed).toHaveLength(3);
    expect(engine.state.status).toBe("idle");
    expect(engine.state.pendingCount).toBe(0);

    // And the retry carried the SAME idempotency key, because the batch contents were the same.
    expect(scenario.idempotencyKeys[0]).toBe(scenario.idempotencyKeys[1]);

    engine.dispose();
  });

  it("backs off exponentially, then dead-letters — it does not retry forever", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    scenario.failNextPushes = 100; // the server is simply down, and stays down
    scenario.failWith = new SyncHttpError(503, "INTERNAL", "service unavailable", true);

    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (const op of makeOps(2)) await engine.enqueue(op);

    await clock.advance(500);
    await engine.settled();
    expect(engine.state.status).toBe("backoff");

    // Drive all 8 attempts.
    for (let i = 0; i < DEFAULT_BACKOFF.maxAttempts + 1; i += 1) {
      await clock.advance(DEFAULT_BACKOFF.maxMs + 1);
      await engine.settled();
    }

    // Bounded. It gave up — LOUDLY. The operations are in the dead-letter queue, visible and
    // exportable, not spinning forever burning the user's battery and not silently discarded.
    expect(engine.state.status).toBe("error");
    expect(engine.state.deadLetterCount).toBe(2);

    const deadLetters = await db.deadLetters.toArray();
    expect(deadLetters).toHaveLength(2);
    expect(deadLetters[0]!.code).toBe("INTERNAL");
    // The operation itself is preserved verbatim — it can be replayed once the bug is fixed.
    expect(deadLetters[0]!.operation).toBeDefined();

    engine.dispose();
  });

  it("dead-letters immediately on a permanent error — retrying a 422 forever is a self-DoS", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    scenario.failNextPushes = 100;
    scenario.failWith = new SyncHttpError(422, "VALIDATION_FAILED", "malformed operation", false);

    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (const op of makeOps(2)) await engine.enqueue(op);

    await clock.advance(500);
    await engine.settled();

    // ONE attempt. Not eight. A malformed operation will be malformed forever, and hammering the
    // server with it is a self-inflicted denial of service.
    expect(scenario.pushCalls).toBe(1);
    expect(engine.state.status).toBe("error");
    expect(engine.state.deadLetterCount).toBe(2);

    engine.dispose();
  });

  it("obeys Retry-After on a 429 instead of guessing", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    scenario.failNextPushes = 1;
    scenario.failWith = new SyncHttpError(429, "RATE_LIMITED", "slow down", true, 5);

    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (const op of makeOps(1)) await engine.enqueue(op);
    await clock.advance(500);
    await engine.settled();

    expect(engine.state.status).toBe("backoff");

    /**
     * Assert the BEHAVIOUR, not a wall-clock coincidence.
     *
     * An assertion like `nextAttemptAt === now() + 5000` is fragile: it depends on precisely when the
     * engine observed the failure relative to when the test looks, which is a property of the await
     * scheduling and not of the engine.
     *
     * This is also the assertion that actually discriminates against the bug being guarded. Default
     * backoff for attempt 0 is at most 500ms — so an engine that *ignored* Retry-After would have
     * retried long before 4999ms. Still waiting at 4999ms and retrying at 5001ms can only mean the
     * server's instruction was obeyed.
     */
    const scheduledFor = engine.state.nextAttemptAt!;

    // The server said 5s. Default backoff for attempt 0 is at most 500ms (baseMs × 2^0, full jitter),
    // and the failure was observed no earlier than t=400 — so an engine that IGNORED Retry-After would
    // have scheduled its retry no later than t≈900. A deadline at or beyond t=5000 can only be the
    // server's instruction being obeyed.
    expect(scheduledFor).toBeGreaterThanOrEqual(5_000);

    await clock.advance(scheduledFor - clock.now() - 1);
    await engine.settled();
    expect(scenario.pushCalls).toBe(1); // one millisecond short: still waiting
    expect(engine.state.status).toBe("backoff");

    await clock.advance(2);
    await engine.settled();
    expect(scenario.pushCalls).toBe(2);
    expect(engine.state.status).toBe("idle");

    engine.dispose();
  });

  it("resyncs from a snapshot when its cursor falls below the compaction watermark", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    scenario.failNextPushes = 1;
    scenario.failWith = new SyncHttpError(410, "GONE", "cursor too old", false);

    let resyncCalled = 0;

    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {
        resyncCalled += 1;
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (const op of makeOps(1)) await engine.enqueue(op);
    await clock.advance(500);
    await engine.settled();

    // 410 is not retryable and is not a dead-letter either — it is an instruction to bootstrap from a
    // snapshot. Dead-lettering here would discard writes for a reason that has nothing to do with them.
    expect(resyncCalled).toBe(1);
    expect(engine.state.deadLetterCount).toBe(0);
    expect(engine.state.status).toBe("idle");

    engine.dispose();
  });

  it("recovers the outbox after a reload — pending work is not forgotten", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();

    const first = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (const op of makeOps(4)) await first.enqueue(op);
    first.dispose(); // the tab was closed before the debounce fired: nothing was ever sent

    expect(scenario.pushCalls).toBe(0);

    // A new page load. New engine, same IndexedDB.
    const second = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await second.hydrate();
    expect(second.state.pendingCount).toBe(4); // it knows, because the outbox is on disk

    await second.syncNow();
    expect(scenario.committed).toHaveLength(4); // and nothing the user typed was lost

    second.dispose();
  });

  it("treats a NOT_FOUND push as transient (backoff), not an instant dead-letter", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    // The document row was briefly not visible to this replica on reconnect. It resolves on the next
    // attempt — so the writing must NOT be dead-lettered on the first try.
    scenario.failNextPushes = 1;
    scenario.failWith = new SyncHttpError(404, "NOT_FOUND", "document not found", false);

    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 1,
    });

    for (const op of makeOps(3)) await engine.enqueue(op);

    await clock.advance(500);
    await engine.settled();

    // First attempt failed with a server "non-retryable" NOT_FOUND — but it is NOT permanent, so the
    // engine backs off instead of discarding three operations. Before this fix it dead-lettered here.
    expect(engine.state.status).toBe("backoff");
    expect(engine.state.deadLetterCount).toBe(0);

    // The retry succeeds (only one failure was scheduled) and the writing lands.
    await clock.advance(DEFAULT_BACKOFF.maxMs);
    await engine.settled();
    expect(engine.state.status).toBe("idle");
    expect(engine.state.deadLetterCount).toBe(0);
    expect(scenario.committed).toHaveLength(3);

    engine.dispose();
  });

  it("requeues dead-lettered operations and syncs them once the condition clears", async () => {
    const clock = new VirtualClock();
    const scenario = newScenario();
    // Force a permanent failure so the ops dead-letter immediately (one attempt).
    scenario.failNextPushes = 1;
    scenario.failWith = new SyncHttpError(422, "VALIDATION_FAILED", "malformed operation", false);

    const engine = new SyncEngine({
      documentId: DOCUMENT_ID,
      clientId: "client-a",
      transport: makeTransport(scenario),
      onRemoteOperations: () => {},
      onResyncRequired: async () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (const op of makeOps(2)) await engine.enqueue(op);
    await clock.advance(500);
    await engine.settled();

    // Stranded — the old behaviour ended here, permanently.
    expect(engine.state.status).toBe("error");
    expect(engine.state.deadLetterCount).toBe(2);
    expect(await db.deadLetters.count()).toBe(2);

    // The condition clears (a fix ships, the doc becomes visible, the token refreshes). The user hits
    // "Retry": dead-letters move back into the outbox and sync. Nothing is stranded forever.
    const recovered = await engine.requeueDeadLetters(false);
    await engine.settled();

    expect(recovered).toBe(2);
    expect(engine.state.deadLetterCount).toBe(0);
    expect(engine.state.status).toBe("idle");
    expect(scenario.committed).toHaveLength(2);
    expect(await db.deadLetters.count()).toBe(0);

    engine.dispose();
  });
});

describe("backoff", () => {
  it("is bounded by the exponential and never exceeds the cap", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const max = backoffDelay(attempt, DEFAULT_BACKOFF, () => 0.999_999);
      const min = backoffDelay(attempt, DEFAULT_BACKOFF, () => 0);
      const expected = Math.min(DEFAULT_BACKOFF.maxMs, DEFAULT_BACKOFF.baseMs * 2 ** attempt);

      expect(min).toBe(0);
      expect(max).toBeLessThan(expected);
      expect(max).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    }
  });

  /**
   * Full jitter, asserted.
   *
   * Without jitter, every client that failed at the same moment retries at the same moment, and a
   * server coming back from an outage is knocked over by its own client base in lockstep. This asserts
   * the retries actually spread across the window rather than clustering — the property that turns a
   * thundering herd into a trickle.
   */
  it("spreads retries across the whole window (no thundering herd)", () => {
    const samples = Array.from({ length: 1_000 }, (_, i) =>
      backoffDelay(5, DEFAULT_BACKOFF, () => (i + 0.5) / 1_000),
    );

    const cap = Math.min(DEFAULT_BACKOFF.maxMs, DEFAULT_BACKOFF.baseMs * 2 ** 5);
    const buckets: number[] = new Array<number>(10).fill(0);
    for (const sample of samples) {
      const bucket = Math.min(9, Math.floor((sample / cap) * 10));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }

    // Every decile of the window is used. A "±20% jitter" implementation would leave eight of these
    // empty — which is exactly why it does not actually solve the problem it claims to.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(0);
    }
  });
});
