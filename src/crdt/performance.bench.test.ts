import { describe, expect, it } from "vitest";

import { render, serialize } from "./document";
import { OperationFactory } from "./factory";
import { generateKeyBetween } from "./fracIndex";
import type { Operation } from "./operations";
import { Replica } from "./replica";

/**
 * The typing-latency budget, measured rather than asserted.
 *
 * ARCHITECTURE.md claims "typing p99 < 8ms on a 500-block document". A claim like that is worthless
 * unless something fails when it stops being true — performance regressions do not announce themselves,
 * they arrive as a colleague saying "the editor feels sluggish lately" six months later.
 *
 * What is measured here is the **synchronous keystroke path**: build the operation, fold it into the
 * CRDT, and re-derive the rendered view. That is everything that must happen before the character can
 * be painted. It excludes IndexedDB and the network *because they are excluded in the product too* —
 * they are write-behind, and if they were on this path the product would not be local-first.
 *
 * The budget is 8ms because a 60Hz frame is 16.7ms and a keystroke should never cost more than half of
 * one. A p99 above that means one keystroke in a hundred drops a frame — which is exactly the frequency
 * at which typing starts to feel "off" without anyone being able to say why.
 */

const BLOCKS = 500;
const KEYSTROKES = 300;

/** The p99 budget for one keystroke's synchronous work, in milliseconds. */
const BUDGET_MS = 8;

/**
 * The batch-scaling span: 1,000 operations against 8,000.
 *
 * The span is 8× rather than 2× on purpose, and the arithmetic is the whole point. Over an 8× span a
 * linear implementation costs 8× more and a quadratic one costs 64×. Those are far enough apart that a
 * garbage-collection pause — which can easily double a measurement, and can only ever make it *slower* —
 * cannot carry a linear result across the line, and no quadratic can hide beneath it.
 *
 * A 2× span cannot do that: linear is 2× and quadratic is 4×, and a single GC pause spans the gap. That
 * version of this test failed about one run in five on a busy machine while the implementation was
 * perfectly linear — a benchmark that cries wolf, which is how benchmarks get deleted.
 *
 * This is a test for a complexity-class regression, not a stopwatch. It is calibrated to say "someone
 * made this quadratic again", not "this is 15% slower than last week".
 */
const BATCH_BASE = 1_000;
const BATCH_SPAN = 8;

/** Linear over the span is 8×; quadratic is 64×. The threshold sits far from both. */
const BATCH_MAX_RATIO = 20;

function buildDocument(blockCount: number): {
  replica: Replica;
  factory: OperationFactory;
  blockIds: string[];
} {
  const replica = new Replica();
  const factory = new OperationFactory("bench");
  const blockIds: string[] = [];

  const operations: Operation[] = [];
  let frac: string | null = null;

  for (let i = 0; i < blockCount; i += 1) {
    frac = generateKeyBetween(frac, null);
    const blockOp = factory.insertBlock("paragraph", frac);
    const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
      .blockId;

    operations.push(blockOp);
    // ~60 characters per paragraph — a realistic line of prose, not a synthetic single character.
    operations.push(
      factory.insertText(blockId, null, "The quick brown fox jumps over the lazy dog, repeatedly."),
    );
    blockIds.push(blockId);
  }

  for (const op of operations) factory.observe(op);
  replica.ingest(operations);

  return { replica, factory, blockIds };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

describe("typing latency", () => {
  it(`stays under ${BUDGET_MS}ms at p99 on a ${BLOCKS}-block document`, () => {
    const { replica, factory, blockIds } = buildDocument(BLOCKS);

    // Type into a block in the MIDDLE of the document. The first block would be the easy case: an RGA
    // insert near the start of a short array. The middle is where the scan actually has to walk.
    const targetBlock = blockIds[Math.floor(blockIds.length / 2)]!;

    const samples: number[] = [];
    let anchor: string | null = null;

    for (let i = 0; i < KEYSTROKES; i += 1) {
      const start = performance.now();

      // Exactly what a keystroke does, in order:
      //   1. mint the operation
      const op = factory.insertText(targetBlock, anchor, "x");
      //   2. advance the clock and fold it in
      factory.observe(op);
      replica.ingest([op]);
      //   3. re-derive the view the editor renders from
      render(replica.state);

      samples.push(performance.now() - start);

      anchor = (op as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload.charId;
    }

    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);
    const worst = Math.max(...samples);

    // Reported on failure, so a regression tells you *how bad* rather than just "it broke".
    const report = `p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${worst.toFixed(2)}ms over ${KEYSTROKES} keystrokes on ${BLOCKS} blocks`;

    expect(p99, report).toBeLessThan(BUDGET_MS);
  });

  /**
   * The property that actually makes the editor scale: **document size must not affect keystroke cost.**
   *
   * A keystroke touches one block. If it cost more on a large document than a small one, the editor
   * would degrade linearly as people write — which is exactly how hand-rolled editors "get slow on long
   * documents", and it is a much more valuable thing to assert than an absolute millisecond number
   * (which varies wildly between a CI runner and a laptop).
   *
   * The tolerance is loose (4×) on purpose. This is not measuring a constant; it is catching an
   * *algorithmic* regression — someone scanning every block on every keystroke — which would show up as
   * 20× or 100×, not 1.3×.
   */
  it("keystroke cost does not grow with document size", () => {
    const measure = (blockCount: number): number => {
      const { replica, factory, blockIds } = buildDocument(blockCount);
      const target = blockIds[Math.floor(blockIds.length / 2)]!;

      const samples: number[] = [];
      let anchor: string | null = null;

      for (let i = 0; i < 200; i += 1) {
        const start = performance.now();

        const op = factory.insertText(target, anchor, "x");
        factory.observe(op);
        replica.ingest([op]);
        render(replica.state);

        samples.push(performance.now() - start);
        anchor = (op as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload.charId;
      }

      // The median keystroke, not the mean: the tail here is GC, and a GC pause is a property of the
      // machine rather than of the algorithm being compared.
      return percentile(samples, 50);
    };

    measure(50); // warm the JIT before either side of the comparison is timed

    const small = measure(50);
    const large = measure(500);

    // A 10× larger document must not cost 10× more per keystroke.
    const ratio = large / Math.max(small, 0.001);

    expect(
      ratio,
      `a 10x larger document cost ${ratio.toFixed(1)}x more per keystroke (${small.toFixed(3)}ms → ${large.toFixed(3)}ms) — that is an algorithmic regression, not a constant factor`,
    ).toBeLessThan(4);
  });

  /**
   * Folding a large batch — a paste, an AI rewrite, a version restore, or a client catching up after a
   * week offline — must not be quadratic.
   *
   * This is the operation that silently kills a CRDT: an O(N²) apply is invisible on the ten operations
   * a unit test uses and takes half a minute on the thousands a real reconnect delivers. It found two
   * separate quadratics in this file — the per-operation state copy (D-015) and, hiding behind it, the
   * linear scan in the character-level idempotence check.
   *
   * **Min-of-N, not a single run.** A benchmark's noise is one-sided: the scheduler and the garbage
   * collector can only ever make a run *slower*, never faster. So the fastest of several runs is the
   * measurement least contaminated by them, and the mean is the one most contaminated. Timing a single
   * run made this test swing by 2× between invocations and fail on a machine that was merely busy —
   * which is how a benchmark earns a reputation for crying wolf and gets deleted.
   */
  it("applying a large batch is not quadratic", () => {
    const time = (count: number): number => {
      const replica = new Replica();
      const factory = new OperationFactory("bench");

      const blockOp = factory.insertBlock("paragraph", generateKeyBetween(null, null));
      const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
        .blockId;
      replica.ingest([blockOp]);

      const ops: Operation[] = [];
      let anchor: string | null = null;
      for (let i = 0; i < count; i += 1) {
        const op = factory.insertText(blockId, anchor, "x");
        anchor = (op as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload.charId;
        ops.push(op);
      }

      // Only the fold is timed. Building the operations is the test's own setup cost, and including it
      // would dilute exactly the signal being measured.
      const start = performance.now();
      replica.ingest(ops);
      return performance.now() - start;
    };

    const best = (count: number): number => {
      let fastest = Infinity;
      for (let run = 0; run < 5; run += 1) fastest = Math.min(fastest, time(count));
      return fastest;
    };

    time(BATCH_BASE); // warm the JIT: the first run of anything measures the compiler, not the code

    const small = best(BATCH_BASE);
    const large = best(BATCH_BASE * BATCH_SPAN);

    const ratio = large / Math.max(small, 0.001);

    expect(
      ratio,
      `a ${BATCH_SPAN}x larger batch (${BATCH_BASE} → ${BATCH_BASE * BATCH_SPAN} ops) cost ${ratio.toFixed(1)}x more (${small.toFixed(1)}ms → ${large.toFixed(1)}ms). Linear would be ~${BATCH_SPAN}x; quadratic would be ~${BATCH_SPAN ** 2}x. This looks quadratic.`,
    ).toBeLessThan(BATCH_MAX_RATIO);
  });

  it("serialising a large document stays linear (the convergence test depends on it)", () => {
    const { replica } = buildDocument(500);

    const start = performance.now();
    const output = serialize(replica.state);
    const elapsed = performance.now() - start;

    expect(output.length).toBeGreaterThan(0);
    // Not a hot path — it runs in the fuzz test and at snapshot time — but if it ever went quadratic the
    // property test would slow to a crawl and someone would "fix" it by reducing numRuns, which is how a
    // convergence suite quietly stops testing anything.
    expect(elapsed, `serialize took ${elapsed.toFixed(1)}ms for 500 blocks`).toBeLessThan(250);
  });
});
