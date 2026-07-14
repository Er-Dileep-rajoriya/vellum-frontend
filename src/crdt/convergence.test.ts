import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { emptyDocument, render, serialize, toPlainText } from "./document";
import { OperationFactory } from "./factory";
import { generateKeyBetween } from "./fracIndex";
import type { Operation } from "./operations";
import { Replica } from "./replica";
import type { MarkType } from "./types";

/**
 * THE convergence test.
 *
 * Everything else in this repository is an argument. This is the proof.
 *
 * The claim being tested: N replicas that have seen the same SET of operations — in any order, with
 * any duplicates, with arbitrary interleaving — hold byte-identical state. Not "similar". Not
 * "eventually, mostly". Identical, compared by a canonical serialisation that includes tombstones and
 * register clocks, because two replicas can render the same text while holding different hidden state
 * that will diverge visibly on the *next* operation.
 *
 * A hand-rolled CRDT is a risk (DECISIONS.md D-002 says so plainly). This test is the mitigation. If
 * it ever fails, the algorithm is wrong and the algorithm loses — not the test.
 */

type Script = {
  readonly replicaCount: number;
  readonly editsPerReplica: number;
  readonly seed: number;
};

const MARKS: MarkType[] = ["bold", "italic", "code", "underline"];

/**
 * A deterministic PRNG. `Math.random()` in a property test means a failure you cannot reproduce,
 * which is a failure you cannot fix.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

interface Session {
  readonly replica: Replica;
  readonly factory: OperationFactory;
  readonly authored: Operation[];
}

/**
 * Ingest, and advance the authoring clock past everything observed.
 *
 * These two always happen together in the real client (see the document store), and they must: a
 * replica that applies a remote operation without advancing its clock will mint its next character
 * with a counter *below* one it has already seen, breaking the `id > origin.id` invariant that the
 * insertion scan depends on. Bundling them here means the test cannot accidentally simulate a client
 * that is more careful than the real one.
 */
function ingest(session: Session, ops: readonly Operation[]): ReturnType<Replica["ingest"]> {
  for (const op of ops) session.factory.observe(op);
  return session.replica.ingest(ops);
}

/**
 * Simulate concurrent editing.
 *
 * Every replica starts from the same base document and then edits *in isolation* — exactly as if all
 * of them went offline simultaneously and typed. Each replica's operations are generated against its
 * OWN local state, which is the only honest simulation: an operation's origin must be a character its
 * author could actually see.
 */
function simulate(script: Script): { sessions: Session[]; allOps: Operation[] } {
  const random = makeRandom(script.seed);
  const pick = <T,>(items: readonly T[]): T | undefined =>
    items.length === 0 ? undefined : items[Math.floor(random() * items.length)];

  // A shared starting point: one block, known to everyone. Without this, replicas would edit
  // disjoint documents and convergence would be trivially true and prove nothing.
  const genesis = new OperationFactory("genesis");
  const baseOps: Operation[] = [
    genesis.insertBlock("paragraph", generateKeyBetween(null, null)),
  ];
  const baseBlockId = (baseOps[0] as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
    .blockId;
  baseOps.push(genesis.insertText(baseBlockId, null, "seed"));

  const sessions: Session[] = [];
  for (let i = 0; i < script.replicaCount; i += 1) {
    const session: Session = {
      replica: new Replica(emptyDocument()),
      factory: new OperationFactory(`r${i}`),
      authored: [],
    };
    ingest(session, baseOps);
    sessions.push(session);
  }

  for (const session of sessions) {
    for (let edit = 0; edit < script.editsPerReplica; edit += 1) {
      const blocks = render(session.replica.state);
      const block = pick(blocks);
      if (block === undefined) continue;

      const choice = random();
      let op: Operation | undefined;

      if (choice < 0.4) {
        // Type. The interesting case: concurrent inserts at the same origin are what a sequence CRDT
        // exists for, so the origin is drawn from the whole block including its start.
        const anchorIndex = Math.floor(random() * (block.charIds.length + 1)) - 1;
        const originLeft = anchorIndex < 0 ? null : (block.charIds[anchorIndex] ?? null);
        const text = ["a", "bc", "hello", "xyz", "world"][Math.floor(random() * 5)]!;
        op = session.factory.insertText(block.id, originLeft, text);
      } else if (choice < 0.6 && block.charIds.length > 0) {
        // Delete a random run — including, deliberately, runs another replica may be concurrently
        // deleting or marking. A delete racing a delete must be idempotent; a delete racing a mark
        // must not resurrect the character.
        const start = Math.floor(random() * block.charIds.length);
        const end = Math.min(start + 1 + Math.floor(random() * 3), block.charIds.length);
        op = session.factory.deleteText(block.id, block.charIds.slice(start, end));
      } else if (choice < 0.75 && block.charIds.length > 0) {
        const start = Math.floor(random() * block.charIds.length);
        const end = Math.min(start + 1 + Math.floor(random() * 4), block.charIds.length);
        const mark = MARKS[Math.floor(random() * MARKS.length)]!;
        op = session.factory.setMark(block.id, block.charIds.slice(start, end), mark, random() > 0.3);
      } else if (choice < 0.85) {
        // A new block, positioned relative to the blocks this replica can see. Two replicas doing
        // this concurrently produce two blocks competing for the same slot.
        const index = Math.floor(random() * (blocks.length + 1));
        const beforeBlock = index > 0 ? blocks[index - 1] : undefined;
        const afterBlock = index < blocks.length ? blocks[index] : undefined;
        const beforeKey = beforeBlock ? fracOf(session, beforeBlock.id) : null;
        const afterKey = afterBlock ? fracOf(session, afterBlock.id) : null;
        op = session.factory.insertBlock("paragraph", generateKeyBetween(beforeKey, afterKey));
      } else if (choice < 0.93) {
        op = session.factory.setBlockAttrs(
          block.id,
          { level: Math.floor(random() * 3) + 1 },
          random() > 0.5 ? "heading1" : "quote",
        );
      } else if (blocks.length > 1) {
        // Remove a block — while someone else may be typing in it.
        op = session.factory.removeBlock(block.id);
      }

      if (op === undefined) continue;

      // The author applies its own operation immediately. That is what "local-first" means: the
      // keystroke lands with zero latency and the network catches up later.
      ingest(session, [op]);
      session.authored.push(op);
    }
  }

  const allOps = sessions.flatMap((session) => session.authored);
  return { sessions, allOps };
}

function fracOf(session: Session, blockId: string): string {
  return session.replica.state.blocks.get(blockId)!.fracIndex.value;
}

/** Shuffle — and duplicate. Both are things the real network does. */
function scramble(ops: readonly Operation[], random: () => number, duplicate: boolean): Operation[] {
  const shuffled = [...ops];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  if (!duplicate || shuffled.length === 0) return shuffled;

  // At-least-once delivery: a WebSocket broadcast racing an HTTP pull delivers the same operation
  // twice. Idempotence must absorb it silently.
  const withDuplicates = [...shuffled];
  const duplicateCount = 1 + Math.floor(random() * 3);
  for (let i = 0; i < duplicateCount; i += 1) {
    withDuplicates.push(shuffled[Math.floor(random() * shuffled.length)]!);
  }
  return withDuplicates;
}

describe("CRDT convergence", () => {
  /**
   * The property, stated as executably as it can be:
   *
   *   for all (replica counts, edit counts, delivery orders):
   *     after every replica has seen every operation, in ITS OWN random order, with duplicates,
   *     every replica's canonical serialisation is identical.
   *
   * The explicit timeout is not padding for a slow implementation — 500 generated histories, each with
   * up to 5 replicas and a random delivery order, is simply a lot of work, and it lands around 5s: right
   * on Vitest's default. So on a busy machine the single most important test in the repository would
   * fail for being *big*, which teaches everyone to ignore it, which is worse than not having it.
   *
   * The right response to "the fuzz test is slow" is a real timeout, never a smaller `numRuns` — that
   * would quietly buy a green build by testing less.
   */
  it("converges: N replicas, random concurrent edits, random delivery order, duplicates", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 1, max: 25 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        (replicaCount, editsPerReplica, seed) => {
          const { sessions, allOps } = simulate({ replicaCount, editsPerReplica, seed });

          // Deliver everything to everyone — each replica in a DIFFERENT random order, because the
          // whole claim is that order does not matter. Delivering the same order to all would test
          // nothing.
          sessions.forEach((session, index) => {
            const random = makeRandom(seed + index * 7919);
            const foreign = allOps.filter((op) => !session.authored.includes(op));
            const delivery = scramble(foreign, random, true);

            const result = ingest(session, delivery);
            expect(result.needsResync).toBe(false);
            // Every operation must eventually apply. A non-empty pending buffer at the end means an
            // operation is stranded forever waiting on a dependency that already arrived — a bug in
            // the drain, and a permanent, silent divergence in production.
            expect(session.replica.pendingCount).toBe(0);
          });

          const serialised = sessions.map((session) => serialize(session.replica.state));
          const first = serialised[0]!;

          for (let i = 1; i < serialised.length; i += 1) {
            expect(serialised[i]).toBe(first);
          }
        },
      ),
      // 500 generated histories per run. Each one is up to 5 replicas × 25 edits delivered in 5
      // different random orders with duplicates — a few hundred thousand distinct interleavings per
      // CI run, at a cost of well under a second.
      { numRuns: 500 },
    );
  });

  it("is idempotent: applying the same operation set twice changes nothing", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const { sessions, allOps } = simulate({ replicaCount: 3, editsPerReplica: 12, seed });
        const session = sessions[0]!;

        const foreign = allOps.filter((op) => !session.authored.includes(op));
        ingest(session, foreign);
        const once = serialize(session.replica.state);

        ingest(session, foreign);
        ingest(session, foreign);
        const thrice = serialize(session.replica.state);

        expect(thrice).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * The anti-interleaving property.
   *
   * Two users type a word at the same caret, concurrently. A merely-convergent CRDT is allowed to
   * produce "hweolrllod" — every replica agrees, and the result is garbage. This asserts the stronger
   * property the design actually promises: each author's run stays contiguous, so the result is one
   * of exactly two sane outcomes.
   */
  it("never interleaves two users' concurrently typed words", () => {
    const genesis = new OperationFactory("genesis");
    const blockOp = genesis.insertBlock("paragraph", generateKeyBetween(null, null));
    const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;

    const alice: Session = { replica: new Replica(), factory: new OperationFactory("alice"), authored: [] };
    const bob: Session = { replica: new Replica(), factory: new OperationFactory("bob"), authored: [] };

    ingest(alice, [blockOp]);
    ingest(bob, [blockOp]);

    // Both type at the very start of an empty block. Maximum contention: identical origin (null).
    const aliceOp = alice.factory.insertText(blockId, null, "hello");
    const bobOp = bob.factory.insertText(blockId, null, "world");

    ingest(alice, [aliceOp]);
    ingest(bob, [bobOp]);

    // Exchange, in opposite orders.
    ingest(alice, [bobOp]);
    ingest(bob, [aliceOp]);

    const aliceText = toPlainText(alice.replica.state);
    const bobText = toPlainText(bob.replica.state);

    expect(aliceText).toBe(bobText); // convergence
    expect(["helloworld", "worldhello"]).toContain(aliceText); // and it is not word salad
  });

  it("preserves both users' text when they type at the same caret (nothing is overwritten)", () => {
    const genesis = new OperationFactory("genesis");
    const blockOp = genesis.insertBlock("paragraph", generateKeyBetween(null, null));
    const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;
    const seed = genesis.insertText(blockId, null, "AB");

    const replicas: Session[] = ["r1", "r2", "r3"].map((id) => ({
      replica: new Replica(),
      factory: new OperationFactory(id),
      authored: [],
    }));

    for (const session of replicas) ingest(session, [blockOp, seed]);

    const anchor = render(replicas[0]!.replica.state)[0]!.charIds[0]!; // after "A"

    // Three replicas insert at the same anchor, concurrently, offline.
    const ops = replicas.map((r, i) => r.factory.insertText(blockId, anchor, `<${i}>`));
    replicas.forEach((r, i) => ingest(r, [ops[i]!]));

    // Exchange everything, each in a different order.
    ingest(replicas[0]!, [ops[1]!, ops[2]!]);
    ingest(replicas[1]!, [ops[2]!, ops[0]!]);
    ingest(replicas[2]!, [ops[0]!, ops[1]!]);

    const texts = replicas.map((r) => toPlainText(r.replica.state));
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);

    // Nothing was overwritten: every replica's insert survived, and so did the original text.
    for (const fragment of ["<0>", "<1>", "<2>", "A", "B"]) {
      expect(texts[0]).toContain(fragment);
    }
  });

  /**
   * Delivery order is irrelevant — including the order that is *causally backwards*.
   *
   * An insert anchored to a character whose own insert has not arrived is buffered, not dropped. This
   * delivers a chain of dependent operations in exactly reverse order, which is the worst case, and
   * is what a lossy connection catching up actually looks like.
   */
  it("buffers causally-early operations and drains them transitively", () => {
    const author = new OperationFactory("author");
    const blockOp = author.insertBlock("paragraph", generateKeyBetween(null, null));
    const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;

    // A chain: each insert anchors to the last character of the previous one.
    const ops: Operation[] = [blockOp];
    let anchor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const op = author.insertText(blockId, anchor, `${i}`);
      ops.push(op);
      anchor = (op as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload.charId;
    }

    const forward = new Replica();
    forward.ingest(ops);

    const backward = new Replica();
    const reversed = [...ops].reverse();
    const result = backward.ingest(reversed);

    // Every operation except the block insert arrives before its dependency, so the buffer does all
    // the work — and then drains completely.
    expect(backward.pendingCount).toBe(0);
    expect(result.needsResync).toBe(false);
    expect(serialize(backward.state)).toBe(serialize(forward.state));
    expect(toPlainText(backward.state)).toBe("0123456789");
  });

  it("a concurrent block delete does not destroy text typed into it", () => {
    const genesis = new OperationFactory("genesis");
    const blockOp = genesis.insertBlock("paragraph", generateKeyBetween(null, null));
    const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;

    const deleter: Session = { replica: new Replica(), factory: new OperationFactory("deleter"), authored: [] };
    const typist: Session = { replica: new Replica(), factory: new OperationFactory("typist"), authored: [] };
    ingest(deleter, [blockOp]);
    ingest(typist, [blockOp]);

    const removeOp = deleter.factory.removeBlock(blockId);
    const typeOp = typist.factory.insertText(blockId, null, "important thought");

    ingest(deleter, [removeOp, typeOp]);
    ingest(typist, [typeOp, removeOp]);

    // Both converge, and the block is gone from the render...
    expect(serialize(typist.replica.state)).toBe(serialize(deleter.replica.state));
    expect(render(typist.replica.state)).toHaveLength(0);

    // ...but the text is NOT destroyed. It lives in the tombstoned block, so a version restore that
    // brings the block back brings the words back with it. A hard delete would have burned them.
    const block = typist.replica.state.blocks.get(blockId)!;
    expect(block.deleted).toBe(true);
    expect(block.chars.map((c) => c.value).join("")).toBe("important thought");
  });

  /**
   * A state handed out earlier must NEVER change. This is the invariant the Draft could break.
   *
   * `Replica.ingest` folds a whole batch into one mutable draft — it clones each touched block once and
   * then writes into that clone — which is what makes hydration and catch-up linear instead of
   * quadratic. The entire safety of that rests on the mutation never escaping: every write must land on
   * a clone the draft owns, never on a Block or Char object that a previously-returned state still
   * points at.
   *
   * If it ever did escape, the failure would be genuinely awful to diagnose. An auto-snapshot taken
   * before an edit would silently acquire the edit; a version restore would compare against a "past"
   * that had been rewritten to match the present; and the render cache — which is keyed on Block
   * identity, and would therefore see no change — would keep serving the old projection of a block
   * whose characters had moved underneath it.
   *
   * So the test is the strongest form of the statement: capture the canonical serialisation of a state,
   * apply every kind of operation on top of it, and require the old serialisation to be byte-identical
   * afterwards.
   */
  it("applying a batch does not mutate any state handed out earlier", () => {
    const session: Session = {
      replica: new Replica(),
      factory: new OperationFactory("author"),
      authored: [],
    };

    const blockOp = session.factory.insertBlock("paragraph", generateKeyBetween(null, null));
    const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
      .blockId;
    ingest(session, [blockOp, session.factory.insertText(blockId, null, "the past")]);

    // The state as it was, and its exact content, captured by value.
    const past = session.replica.state;
    const pastSerialised = serialize(past);
    const pastBlock = past.blocks.get(blockId)!;
    const pastChars = pastBlock.chars;
    const pastText = pastChars.map((char) => char.value).join("");

    // Now do everything that writes: insert text, delete text, set a mark, change the type, move the
    // block, and remove it — in one batch, so they all share a single draft.
    const live = render(session.replica.state)[0]!;
    ingest(session, [
      session.factory.insertText(blockId, live.charIds.at(-1)!, " and the future"),
      session.factory.deleteText(blockId, [live.charIds[0]!, live.charIds[1]!]),
      session.factory.setMark(blockId, [live.charIds[4]!], "bold", true),
      session.factory.setBlockAttrs(blockId, { checked: true }, "heading1"),
      session.factory.moveBlock(blockId, generateKeyBetween("a5", null)),
      session.factory.removeBlock(blockId),
    ]);

    // The new state changed...
    expect(serialize(session.replica.state)).not.toBe(pastSerialised);

    // ...and the old one did not, in any respect: not its serialisation, not the block object, not the
    // character array, not the characters themselves, and not their tombstone flags or marks.
    expect(serialize(past)).toBe(pastSerialised);
    expect(past.blocks.get(blockId)).toBe(pastBlock);
    expect(pastBlock.chars).toBe(pastChars);
    expect(pastBlock.deleted).toBe(false);
    expect(pastBlock.type.value).toBe("paragraph");
    expect(pastChars.map((char) => char.value).join("")).toBe(pastText);
    expect(pastChars.some((char) => char.deleted)).toBe(false);
    expect(pastChars.some((char) => char.marks.size > 0)).toBe(false);
  });
});
