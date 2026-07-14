import { describe, expect, it } from "vitest";

import { serialize, toPlainText } from "@/crdt/document";
import { OperationFactory } from "@/crdt/factory";
import { generateKeyBetween } from "@/crdt/fracIndex";
import type { Operation } from "@/crdt/operations";
import { Replica } from "@/crdt/replica";

import { diffDocuments, diffWords } from "./diff";
import { buildRestoreOperations, snapshotOf, snapshotStats } from "./restore";

/**
 * Version history.
 *
 * The tests that matter here are not "does restore restore". They are:
 *
 *   - does restore CONVERGE when someone else is typing at the same time, and
 *   - does it destroy their words.
 *
 * A restore implemented as `state = version.content` passes "does restore restore" perfectly, and
 * fails both of these — silently, and only under concurrency, which is to say only in production.
 */

class TestReplica {
  readonly replica = new Replica();
  readonly factory: OperationFactory;
  readonly history: Operation[] = [];

  constructor(clientId: string) {
    this.factory = new OperationFactory(clientId);
  }

  apply(operations: readonly Operation[]): void {
    for (const op of operations) this.factory.observe(op);
    this.history.push(...operations);
    this.replica.ingest(operations);
  }

  get text(): string {
    return toPlainText(this.replica.state);
  }
}

/** A document with three paragraphs, known to both replicas. */
function seedDocument(): { operations: Operation[]; blockIds: string[] } {
  const author = new OperationFactory("author");
  const operations: Operation[] = [];
  const blockIds: string[] = [];

  let frac: string | null = null;
  for (const text of ["Alpha", "Beta", "Gamma"]) {
    frac = generateKeyBetween(frac, null);
    const blockOp = author.insertBlock("paragraph", frac);
    const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
      .blockId;

    operations.push(blockOp, author.insertText(blockId, null, text));
    blockIds.push(blockId);
  }

  return { operations, blockIds };
}

describe("restore", () => {
  it("restores a snapshot by emitting forward operations", () => {
    const replica = new TestReplica("r1");
    const { operations } = seedDocument();
    replica.apply(operations);

    const snapshot = snapshotOf(replica.replica.state);
    expect(replica.text).toBe("Alpha\nBeta\nGamma");

    // The document moves on.
    const blocks = [...replica.replica.state.blocks.values()];
    const betaBlock = blocks[1]!;
    replica.apply([
      replica.factory.deleteText(
        betaBlock.id,
        betaBlock.chars.map((char) => char.id),
      ),
      replica.factory.insertText(betaBlock.id, null, "CHANGED"),
    ]);
    expect(replica.text).toBe("Alpha\nCHANGED\nGamma");

    // Restore.
    const restoreOps = buildRestoreOperations(
      replica.factory,
      replica.replica.state,
      snapshot,
    );
    replica.apply(restoreOps);

    expect(replica.text).toBe("Alpha\nBeta\nGamma");
  });

  it("emits ZERO operations when restoring to a version identical to the present", () => {
    const replica = new TestReplica("r1");
    replica.apply(seedDocument().operations);

    const snapshot = snapshotOf(replica.replica.state);
    const operations = buildRestoreOperations(replica.factory, replica.replica.state, snapshot);

    // Not "a no-op batch". Zero. Otherwise every restore of an unchanged document grows the operation
    // log forever, and "restore" becomes a way to spam history.
    expect(operations).toHaveLength(0);
  });

  /**
   * THE test.
   *
   * Alice restores an old version. At the same moment, offline, Bob types a new paragraph. Neither has
   * seen the other's work.
   *
   * A `state = version.content` restore would obliterate Bob's paragraph — it was not in the snapshot,
   * so it would simply cease to exist, with no error and no trace. Because restore is expressed as
   * ordinary CRDT operations, Bob's insert and Alice's restore merge like any other pair of concurrent
   * edits: both survive, and both replicas agree.
   */
  it("converges with a concurrent edit — and does NOT destroy it", () => {
    const seed = seedDocument();

    const alice = new TestReplica("alice");
    const bob = new TestReplica("bob");
    alice.apply(seed.operations);
    bob.apply(seed.operations);

    // A version is captured, then the document changes.
    const snapshot = snapshotOf(alice.replica.state);

    const betaBlock = [...alice.replica.state.blocks.values()][1]!;
    const edit = [
      alice.factory.deleteText(betaBlock.id, betaBlock.chars.map((char) => char.id)),
      alice.factory.insertText(betaBlock.id, null, "CHANGED"),
    ];
    alice.apply(edit);
    bob.apply(edit);

    expect(alice.text).toBe("Alpha\nCHANGED\nGamma");

    // ── Now they diverge. ────────────────────────────────────────────────────────────────────────
    // Alice restores the old version.
    const restoreOps = buildRestoreOperations(alice.factory, alice.replica.state, snapshot);
    alice.apply(restoreOps);

    // Bob, offline and unaware, adds a brand-new paragraph.
    const lastFrac = [...bob.replica.state.blocks.values()].at(-1)!.fracIndex.value;
    const bobBlockOp = bob.factory.insertBlock("paragraph", generateKeyBetween(lastFrac, null));
    const bobBlockId = (bobBlockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
      .blockId;
    const bobOps = [bobBlockOp, bob.factory.insertText(bobBlockId, null, "Bob was here")];
    bob.apply(bobOps);

    // ── They sync, in opposite orders. ───────────────────────────────────────────────────────────
    alice.apply(bobOps);
    bob.apply(restoreOps);

    // Convergence: byte-identical state, not merely similar text.
    expect(serialize(bob.replica.state)).toBe(serialize(alice.replica.state));

    // The restore did its job...
    expect(alice.text).toContain("Beta");
    expect(alice.text).not.toContain("CHANGED");

    // ...AND Bob's concurrent paragraph survived. A whole-document restore would have erased it without
    // a word of warning, and neither of them would have noticed until Bob went looking for it.
    expect(alice.text).toContain("Bob was here");
  });

  it("a restore is itself restorable — history is a DAG, not a line", () => {
    const replica = new TestReplica("r1");
    replica.apply(seedDocument().operations);

    const v1 = snapshotOf(replica.replica.state); // "Alpha Beta Gamma"

    const betaBlock = [...replica.replica.state.blocks.values()][1]!;
    replica.apply([
      replica.factory.deleteText(betaBlock.id, betaBlock.chars.map((c) => c.id)),
      replica.factory.insertText(betaBlock.id, null, "V2"),
    ]);
    const v2 = snapshotOf(replica.replica.state); // "Alpha V2 Gamma"

    // Restore v1...
    replica.apply(buildRestoreOperations(replica.factory, replica.replica.state, v1));
    expect(replica.text).toBe("Alpha\nBeta\nGamma");

    // ...then change your mind and restore v2. Both are forward operations; nothing was ever rewritten.
    replica.apply(buildRestoreOperations(replica.factory, replica.replica.state, v2));
    expect(replica.text).toBe("Alpha\nV2\nGamma");
  });

  it("restores a deleted block by re-inserting it", () => {
    const replica = new TestReplica("r1");
    const { operations, blockIds } = seedDocument();
    replica.apply(operations);

    const snapshot = snapshotOf(replica.replica.state);

    replica.apply([replica.factory.removeBlock(blockIds[1]!)]);
    expect(replica.text).toBe("Alpha\nGamma");

    replica.apply(buildRestoreOperations(replica.factory, replica.replica.state, snapshot));

    // The text is back, and in the right place — the fractional index put it between Alpha and Gamma
    // rather than at the end.
    expect(replica.text).toBe("Alpha\nBeta\nGamma");
  });

  it("computes snapshot stats without folding the operation log", () => {
    const replica = new TestReplica("r1");
    replica.apply(seedDocument().operations);

    const stats = snapshotStats(snapshotOf(replica.replica.state));
    expect(stats.blockCount).toBe(3);
    expect(stats.charCount).toBe("Alpha".length + "Beta".length + "Gamma".length);
  });
});

describe("diff", () => {
  it("diffs words, not characters", () => {
    const words = diffWords("the cat sat", "the dog sat");

    const removed = words.filter((word) => word.kind === "removed").map((word) => word.text);
    const added = words.filter((word) => word.kind === "added").map((word) => word.text);

    // "cat" → "dog", not c→d, a→o, t→g. A character diff here is technically correct and unreadable.
    expect(removed).toContain("cat");
    expect(added).toContain("dog");
    expect(removed).not.toContain("the");
  });

  it("preserves whitespace so the text can be reassembled exactly", () => {
    const words = diffWords("a  b", "a  b");
    expect(words.map((word) => word.text).join("")).toBe("a  b");
  });

  it("reports added, removed, and changed blocks", () => {
    const before = [
      { id: "1", type: "paragraph", text: "keep" },
      { id: "2", type: "paragraph", text: "delete me" },
      { id: "3", type: "paragraph", text: "the cat sat" },
    ];
    const after = [
      { id: "1", type: "paragraph", text: "keep" },
      { id: "3", type: "paragraph", text: "the dog sat" },
      { id: "4", type: "paragraph", text: "brand new" },
    ];

    const diff = diffDocuments(before, after);

    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.changed).toBe(1);

    // The changed block carries a word-level diff, so the UI can highlight "cat" → "dog" rather than
    // painting the whole paragraph red and green.
    const changed = diff.blocks.find((block) => block.kind === "changed");
    expect(changed?.words?.some((word) => word.kind === "removed" && word.text === "cat")).toBe(true);
  });

  it("matches blocks on content, not id — so a restore does not look like a rewrite", () => {
    // The same text, re-created with fresh ids: exactly what a restore produces.
    const before = [{ id: "old-1", type: "paragraph", text: "Alpha" }];
    const after = [{ id: "new-1", type: "paragraph", text: "Alpha" }];

    const diff = diffDocuments(before, after);

    // An id-based diff would report 1 removed + 1 added, and the history UI would tell the user their
    // whole document changed when nothing did.
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.blocks[0]?.kind).toBe("unchanged");
  });
});
