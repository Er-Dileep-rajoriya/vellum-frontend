import { describe, expect, it } from "vitest";

import { serialize, toPlainText } from "@/crdt/document";
import { OperationFactory } from "@/crdt/factory";
import { generateKeyBetween } from "@/crdt/fracIndex";
import type { Operation } from "@/crdt/operations";
import { Replica } from "@/crdt/replica";

import { History } from "./history";

/**
 * Undo, in a collaborative document.
 *
 * The test that matters is not "does undo undo". It is: **does Ctrl+Z leave my colleague's sentence
 * alone?** An undo implemented as "reverse the last operation in the document" passes the first and
 * fails the second — and it fails it silently, in production, while someone watches their own words
 * vanish under their cursor.
 */

class Session {
  readonly replica = new Replica();
  readonly factory: OperationFactory;
  readonly history = new History();
  readonly log: Operation[] = [];

  constructor(clientId: string) {
    this.factory = new OperationFactory(clientId);
  }

  apply(operations: readonly Operation[]): void {
    for (const op of operations) this.factory.observe(op);
    this.log.push(...operations);
    this.replica.ingest(operations);
  }

  get text(): string {
    return toPlainText(this.replica.state);
  }

  /** A collaborator who has actually READ the document — i.e. a real one. */
  peer(clientId: string): OperationFactory {
    const factory = new OperationFactory(clientId);
    for (const op of this.log) factory.observe(op);
    return factory;
  }

  /** Replace a block's text, recording an undo step the way the editor does. */
  type(blockId: string, text: string, label = "typing"): void {
    const block = this.replica.state.blocks.get(blockId)!;
    const live = block.chars.filter((char) => !char.deleted).map((char) => char.id);

    const ops: Operation[] = [];
    if (live.length > 0) ops.push(this.factory.deleteText(blockId, live));
    ops.push(this.factory.insertText(blockId, null, text));

    // Record BEFORE applying — the step needs the pre-edit state to remember what the delete removed.
    this.history.record(ops, this.replica.state, label);
    this.apply(ops);
  }

  /** Append to a block without touching what is already there — what a collaborator typically does. */
  append(blockId: string, text: string, label = "typing"): void {
    const block = this.replica.state.blocks.get(blockId)!;
    const live = block.chars.filter((char) => !char.deleted);
    const anchor = live.at(-1)?.id ?? null;

    const ops = [this.factory.insertText(blockId, anchor, text)];
    this.history.record(ops, this.replica.state, label);
    this.apply(ops);
  }

  blockText(blockId: string): string {
    const block = this.replica.state.blocks.get(blockId);
    if (block === undefined) return "";
    return block.chars
      .filter((char) => !char.deleted)
      .map((char) => char.value)
      .join("");
  }

  undo(): void {
    this.apply(this.history.undo(this.factory, this.replica.state));
  }

  redo(): void {
    this.apply(this.history.redo(this.factory, this.replica.state));
  }
}

function seed(text: string): { session: Session; blockId: string } {
  const session = new Session("author");
  const blockOp = session.factory.insertBlock("paragraph", generateKeyBetween(null, null));
  const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;

  // An empty block is a block with no TEXT_INSERT at all — not a TEXT_INSERT of "". The latter is an
  // operation the server rejects (`value: min(1)`), and the factory now refuses to mint one.
  const operations: Operation[] =
    text.length === 0 ? [blockOp] : [blockOp, session.factory.insertText(blockId, null, text)];

  session.apply(operations);
  return { session, blockId };
}

describe("undo / redo", () => {
  it("undoes the last local edit and redoes it", () => {
    const { session, blockId } = seed("original");

    session.type(blockId, "changed");
    expect(session.text).toBe("changed");

    session.undo();
    expect(session.text).toBe("original");

    session.redo();
    expect(session.text).toBe("changed");
  });

  it("undoes several steps in order", () => {
    const { session, blockId } = seed("v1");

    session.type(blockId, "v2");
    session.type(blockId, "v3");
    expect(session.text).toBe("v3");

    session.undo();
    expect(session.text).toBe("v2");

    session.undo();
    expect(session.text).toBe("v1");

    expect(session.history.canUndo).toBe(false);
  });

  it("a new edit clears the redo stack", () => {
    const { session, blockId } = seed("a");

    session.type(blockId, "b");
    session.undo();
    expect(session.history.canRedo).toBe(true);

    // Once you type something new, the future you could have redone into no longer exists.
    session.type(blockId, "c");
    expect(session.history.canRedo).toBe(false);
  });

  /**
   * THE test.
   *
   * Alice types. Bob types. Alice presses Ctrl+Z.
   *
   * Alice's undo must revert **Alice's** change and leave Bob's alone. An undo built on "reverse the
   * document's last operation" would revert BOB's edit — he would watch his sentence disappear while
   * his cursor was sitting in it. That is not undo; it is a remote-controlled delete.
   */
  it("undoes only the LOCAL user's edit — never a collaborator's", () => {
    const seedOps: Operation[] = [];
    const author = new OperationFactory("seed");
    const blockA = author.insertBlock("paragraph", generateKeyBetween(null, null));
    const blockAId = (blockA as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;
    const blockB = author.insertBlock("paragraph", generateKeyBetween("V", null));
    const blockBId = (blockB as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;
    seedOps.push(blockA, blockB);

    const alice = new Session("alice");
    alice.apply(seedOps);

    // Alice edits her paragraph.
    alice.type(blockAId, "Alice wrote this.");

    // Bob edits HIS paragraph, and it arrives. It is the most recent operation in the document.
    const bob = alice.peer("bob");
    const bobOps = [bob.insertText(blockBId, null, "Bob wrote this.")];
    alice.apply(bobOps);

    expect(alice.text).toContain("Alice wrote this.");
    expect(alice.text).toContain("Bob wrote this.");

    // Alice presses Ctrl+Z. The document's most recent operation is BOB's.
    alice.undo();

    // Alice's text is gone (correct — it was her edit)...
    expect(alice.text).not.toContain("Alice wrote this.");

    // ...and Bob's is untouched. This is the assertion the whole design exists to satisfy.
    expect(alice.text).toContain("Bob wrote this.");
  });

  /**
   * THE OTHER test — the one the first implementation failed, and a two-tab E2E caught.
   *
   * A collaborator typing into a *different* block is the easy case. The hard case is a collaborator
   * typing into the **same paragraph you are about to undo in**.
   *
   * My first version recorded "block B said X, now it says Y" and undid by replacing the block's whole
   * text with X. That passes the different-block test above, and it **deletes everything the
   * collaborator typed into that paragraph in the meantime**. Alice types "AAA", Bob appends "BBB",
   * Alice presses Ctrl+Z, and Bob's "BBB" is gone.
   *
   * The fix is that a step records the exact character ids it inserted — so an undo tombstones only
   * those. Bob's characters were never named, so they cannot be touched.
   */
  it("undoing in a block a collaborator is ALSO editing leaves their text alone", () => {
    const { session: alice, blockId } = seed("");

    alice.append(blockId, "AAA");
    expect(alice.blockText(blockId)).toBe("AAA");

    // Bob appends to the SAME block. Not a different one — the same paragraph.
    const bob = alice.peer("bob");
    const live = alice.replica.state.blocks
      .get(blockId)!
      .chars.filter((char) => !char.deleted);
    const bobOps = [bob.insertText(blockId, live.at(-1)!.id, "BBB")];
    alice.apply(bobOps);

    expect(alice.blockText(blockId)).toBe("AAABBB");

    // Alice presses Ctrl+Z.
    alice.undo();

    // Her "AAA" is gone. Bob's "BBB" is NOT — it is still there, in the same block, untouched.
    expect(alice.blockText(blockId)).toBe("BBB");
  });

  it("redo after an interleaved collaborator edit still only re-applies the local text", () => {
    const { session: alice, blockId } = seed("");

    alice.append(blockId, "AAA");

    const bob = alice.peer("bob");
    const live = alice.replica.state.blocks
      .get(blockId)!
      .chars.filter((char) => !char.deleted);
    alice.apply([bob.insertText(blockId, live.at(-1)!.id, "BBB")]);

    alice.undo();
    expect(alice.blockText(blockId)).toBe("BBB");

    alice.redo();

    // Alice's text is back, and Bob's is still there exactly once — a redo that re-inserted the whole
    // remembered block text would have duplicated his.
    expect(alice.blockText(blockId)).toContain("AAA");
    expect(alice.blockText(blockId)).toContain("BBB");
    expect(alice.blockText(blockId).match(/BBB/g)).toHaveLength(1);
  });

  /**
   * Undo is a FORWARD operation, not a resurrection.
   *
   * Un-deleting a character would let this replica revive one that a collaborator legitimately
   * deleted — their deletion would silently vanish. So an undo re-inserts the text as NEW characters,
   * and the tombstones from the original edit remain tombstoned forever.
   */
  it("undo re-inserts text as new characters; it never resurrects a tombstone", () => {
    const { session, blockId } = seed("hello");

    const originalIds = session.replica.state.blocks
      .get(blockId)!
      .chars.map((char) => char.id);

    session.type(blockId, "goodbye");
    session.undo();

    expect(session.text).toBe("hello");

    const block = session.replica.state.blocks.get(blockId)!;

    // Every ORIGINAL character is still tombstoned. The text says "hello" again because five *new*
    // characters spell it — not because the old ones came back from the dead.
    for (const id of originalIds) {
      const char = block.chars.find((candidate) => candidate.id === id);
      expect(char?.deleted).toBe(true);
    }

    const live = block.chars.filter((char) => !char.deleted);
    expect(live.map((char) => char.value).join("")).toBe("hello");
    expect(live.every((char) => !originalIds.includes(char.id))).toBe(true);
  });

  /** An undo, being an ordinary operation, converges like any other. */
  it("an undo converges with a collaborator's concurrent edit", () => {
    const { session: alice, blockId } = seed("start");

    const bob = new Session("bob");
    bob.apply(alice.log);

    alice.type(blockId, "alice-edit");
    const aliceEdit = alice.log.slice(-2);
    bob.apply(aliceEdit);

    // Alice undoes, while Bob concurrently appends to a NEW block.
    const undoOpsStart = alice.log.length;
    alice.undo();
    const undoOps = alice.log.slice(undoOpsStart);

    const bobFactory = bob.peer("bob-2");
    const newBlock = bobFactory.insertBlock("paragraph", generateKeyBetween("V", null));
    const newBlockId = (newBlock as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
      .blockId;
    const bobOps = [newBlock, bobFactory.insertText(newBlockId, null, "bob's new paragraph")];
    bob.apply(bobOps);

    // Exchange.
    alice.apply(bobOps);
    bob.apply(undoOps);

    expect(serialize(bob.replica.state)).toBe(serialize(alice.replica.state));
    expect(alice.text).toContain("start"); // the undo landed
    expect(alice.text).toContain("bob's new paragraph"); // and Bob's work survived
  });

  it("undoing an edit to a block a collaborator has since deleted is a no-op, not a resurrection", () => {
    const { session, blockId } = seed("doomed");

    session.type(blockId, "edited");

    // A collaborator removes the whole block.
    const peer = session.peer("peer");
    session.apply([peer.removeBlock(blockId)]);

    // Ctrl+Z. The block is gone. Re-creating it would resurrect something someone deliberately
    // deleted — so the undo does nothing, which is the honest outcome.
    session.undo();

    expect(session.text).toBe("");
    expect(session.replica.state.blocks.get(blockId)?.deleted).toBe(true);
  });
});
