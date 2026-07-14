import { describe, expect, it } from "vitest";

import { serialize, toPlainText } from "./document";
import { OperationFactory } from "./factory";
import { generateKeyBetween } from "./fracIndex";
import type { Operation } from "./operations";
import { Replica } from "./replica";

/**
 * AI edits are ordinary CRDT operations.
 *
 * The claim in DECISIONS.md D-014 is that AI output goes through the same `OperationFactory` as a
 * keystroke, and therefore inherits undo, offline queueing, merging, versioning and audit *for free*.
 * That is a strong claim, and this file is what makes it true rather than aspirational.
 *
 * The scenario that matters: **a user asks the AI to rewrite a paragraph while a collaborator is
 * typing in that same paragraph.** An implementation where AI writes directly to document state
 * would silently destroy the collaborator's words. This one cannot — because to the merge engine,
 * the AI is just another typist.
 */

class Session {
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

  /** A second replica that has actually READ the document — i.e. a real collaborator. */
  collaborator(clientId: string): OperationFactory {
    const factory = new OperationFactory(clientId);
    for (const op of this.history) factory.observe(op);
    return factory;
  }
}

function seed(text: string): { session: Session; blockId: string } {
  const session = new Session("author");
  const blockOp = session.factory.insertBlock("paragraph", generateKeyBetween(null, null));
  const blockId = (blockOp as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;

  session.apply([blockOp, session.factory.insertText(blockId, null, text)]);
  return { session, blockId };
}

describe("AI edits are CRDT operations", () => {
  it("a rewrite is a delete + insert, not a state assignment", () => {
    const { session, blockId } = seed("this sentence is bad");
    const block = session.replica.state.blocks.get(blockId)!;
    const charIds = block.chars.map((char) => char.id);

    // Exactly what the AI menu emits on "Replace".
    session.apply([
      session.factory.deleteText(blockId, charIds),
      session.factory.insertText(blockId, null, "This sentence is good."),
    ]);

    expect(session.text).toBe("This sentence is good.");

    // The original characters are TOMBSTONED, not erased. That is what makes the rewrite undoable
    // and what lets a version restore bring the old wording back.
    const after = session.replica.state.blocks.get(blockId)!;
    expect(after.chars.filter((char) => char.deleted).length).toBe(charIds.length);
  });

  /**
   * THE test.
   *
   * Alice asks the AI to rewrite a paragraph. At the same moment, Bob is typing in it. Neither has
   * seen the other's work yet.
   *
   * With AI-writes-state, Bob's words are gone — no error, no trace. With AI-as-operations, the
   * rewrite and Bob's keystrokes merge like any two concurrent edits: both replicas converge, and
   * Bob's sentence survives.
   */
  it("an AI rewrite merges with a collaborator's concurrent typing, and does not destroy it", () => {
    const { session: alice, blockId } = seed("The quick brown fox.");

    // Bob has the same document.
    const bob = new Session("bob");
    bob.apply(alice.history);

    // Alice's AI rewrite: delete everything, insert the new text.
    const aliceBlock = alice.replica.state.blocks.get(blockId)!;
    const aliceOps = [
      alice.factory.deleteText(blockId, aliceBlock.chars.map((char) => char.id)),
      alice.factory.insertText(blockId, null, "A swift auburn fox."),
    ];
    alice.apply(aliceOps);

    // Bob, concurrently and offline, appends his own sentence.
    const bobBlock = bob.replica.state.blocks.get(blockId)!;
    const lastChar = bobBlock.chars[bobBlock.chars.length - 1]!.id;
    const bobOps = [bob.factory.insertText(blockId, lastChar, " Bob was here.")];
    bob.apply(bobOps);

    // They sync, in opposite orders.
    alice.apply(bobOps);
    bob.apply(aliceOps);

    // Convergence: byte-identical, not merely "looks the same".
    expect(serialize(bob.replica.state)).toBe(serialize(alice.replica.state));

    // The AI's rewrite landed...
    expect(alice.text).toContain("A swift auburn fox.");
    expect(alice.text).not.toContain("quick brown");

    // ...AND Bob's sentence survived. This is the assertion the whole architecture exists to make
    // possible. An AI that wrote directly to document state would have erased it without a word.
    expect(alice.text).toContain("Bob was here.");
  });

  it("an AI edit is undoable, because a delete is a tombstone rather than an erasure", () => {
    const { session, blockId } = seed("original");
    const before = serialize(session.replica.state);

    const block = session.replica.state.blocks.get(blockId)!;
    const originalIds = block.chars.map((char) => char.id);

    const aiOps = [
      session.factory.deleteText(blockId, originalIds),
      session.factory.insertText(blockId, null, "rewritten"),
    ];
    session.apply(aiOps);
    expect(session.text).toBe("rewritten");

    /**
     * Undo: invert the operations. Un-deleting is impossible in the CRDT by design (a tombstone is
     * forever — resurrecting it would let a replica revive a character another replica has
     * legitimately deleted). So undo is expressed the same way restore is: as NEW forward operations
     * that reproduce the old text. The result is the same string, and — crucially — history is not
     * rewritten.
     */
    const current = session.replica.state.blocks.get(blockId)!;
    const rewrittenIds = current.chars
      .filter((char) => !char.deleted)
      .map((char) => char.id);

    session.apply([
      session.factory.deleteText(blockId, rewrittenIds),
      session.factory.insertText(blockId, null, "original"),
    ]);

    expect(session.text).toBe("original");
    // The state is NOT byte-identical to the start — the tombstones and the new character ids are
    // real history. The *text* is restored; the *past* is not erased. That distinction is the whole
    // point of an append-only log.
    expect(serialize(session.replica.state)).not.toBe(before);
  });

  it("an AI insert-below does not eat the paragraph it was analysing", () => {
    const { session, blockId } = seed("A long paragraph about foxes.");

    // "Summarise" is an analysis action: it appends, it does not replace. If this ever became a
    // replacing action, the model's summary would consume the text it was summarising.
    const block = session.replica.state.blocks.get(blockId)!;
    const lastChar = block.chars[block.chars.length - 1]!.id;

    session.apply([
      session.factory.insertText(blockId, lastChar, "\nSummary: foxes are discussed."),
    ]);

    expect(session.text).toContain("A long paragraph about foxes.");
    expect(session.text).toContain("Summary: foxes are discussed.");
  });
});
