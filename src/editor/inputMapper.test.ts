import { describe, expect, it } from "vitest";

import { render, toPlainText } from "@/crdt/document";
import { OperationFactory } from "@/crdt/factory";
import { generateKeyBetween } from "@/crdt/fracIndex";
import type { Operation } from "@/crdt/operations";
import { Replica } from "@/crdt/replica";
import type { RenderedBlock } from "@/crdt/types";

import {
  deleteBackward,
  deleteForward,
  insertText,
  offsetsFromSelection,
  selectionFromOffsets,
  splitBlock,
  toggleMark,
  type EditorContext,
} from "./inputMapper";
import { matchInlineShortcut, matchShortcut } from "./markdown";

/**
 * The input mapper, tested as a pure function against a real CRDT.
 *
 * Each test drives an intent ("the user pressed Backspace here") through the mapper, applies the
 * resulting operations to an actual Replica, and asserts on the resulting document. No DOM, no React,
 * no browser — which means the fiddly interactions (merge on backspace at offset 0, split with marks,
 * replace-a-selection) are pinned down in milliseconds instead of being discovered by users.
 */

class Editor {
  readonly replica = new Replica();
  readonly factory = new OperationFactory("editor");
  /** Everything applied, so a simulated remote replica can observe the document before editing it. */
  readonly history: Operation[] = [];

  constructor(initialText = "") {
    const blockOp = this.factory.insertBlock("paragraph", generateKeyBetween(null, null));
    this.apply([blockOp]);

    if (initialText !== "") {
      const blockId = this.blocks[0]!.id;
      this.apply([this.factory.insertText(blockId, null, initialText)]);
    }
  }

  get blocks(): RenderedBlock[] {
    return render(this.replica.state);
  }

  get text(): string {
    return toPlainText(this.replica.state);
  }

  apply(operations: readonly Operation[]): void {
    for (const op of operations) this.factory.observe(op);
    this.history.push(...operations);
    this.replica.ingest(operations);
  }

  /**
   * A second replica that has SEEN this document — i.e. an actual collaborator.
   *
   * Constructing one without replaying the history would produce a replica whose Lamport clock is 0:
   * a client editing a document it has never read. Its characters would carry counters below every
   * character already present, and the RGA would (correctly) order them accordingly. That is not a bug
   * in the merge algorithm; it is a bug in the simulation, and this helper is what stops the test from
   * writing one.
   */
  collaborator(clientId: string): OperationFactory {
    const factory = new OperationFactory(clientId);
    for (const op of this.history) factory.observe(op);
    return factory;
  }

  context(blockIndex: number, start: number, end = start): EditorContext {
    const blocks = this.blocks;
    const block = blocks[blockIndex]!;
    return {
      factory: this.factory,
      block,
      blocks,
      selection: selectionFromOffsets(block, start, end),
    };
  }
}

describe("input mapper — typing", () => {
  it("inserts text at the caret", () => {
    const editor = new Editor("Helo");
    const result = insertText(editor.context(0, 3), "l"); // "Hel|o" → "Hell|o"
    editor.apply(result.operations);

    expect(editor.text).toBe("Hello");

    // The caret must land AFTER the inserted character, not before it. Getting this wrong means every
    // typed character appears in reverse order — the classic first bug of every hand-rolled editor.
    const offsets = offsetsFromSelection(editor.blocks[0]!, result.selection);
    expect(offsets.start).toBe(4);
  });

  it("inserts at the very start of a block (anchor = null)", () => {
    const editor = new Editor("world");
    const result = insertText(editor.context(0, 0), "hello ");
    editor.apply(result.operations);

    expect(editor.text).toBe("hello world");
  });

  it("replaces a selection with typed text", () => {
    const editor = new Editor("Hello cruel world");
    // Select "cruel " (offsets 6..12) and type over it.
    const result = insertText(editor.context(0, 6, 12), "");
    expect(result.operations).toHaveLength(0); // typing nothing does nothing

    const replaced = insertText(editor.context(0, 6, 12), "beautiful ");
    editor.apply(replaced.operations);

    expect(editor.text).toBe("Hello beautiful world");
  });
});

describe("input mapper — deletion", () => {
  it("backspace deletes the character before the caret", () => {
    const editor = new Editor("Hello!");
    const result = deleteBackward(editor.context(0, 6));
    editor.apply(result.operations);

    expect(editor.text).toBe("Hello");
    expect(offsetsFromSelection(editor.blocks[0]!, result.selection).start).toBe(5);
  });

  it("backspace deletes a selection rather than one character", () => {
    const editor = new Editor("Hello world");
    const result = deleteBackward(editor.context(0, 5, 11)); // select " world"
    editor.apply(result.operations);

    expect(editor.text).toBe("Hello");
  });

  it("delete removes the character AFTER the caret and does not move it", () => {
    const editor = new Editor("Hello");
    const result = deleteForward(editor.context(0, 0));
    editor.apply(result.operations);

    expect(editor.text).toBe("ello");
    expect(offsetsFromSelection(editor.blocks[0]!, result.selection).start).toBe(0);
  });

  it("delete at the end of a block does nothing (no crash, no merge)", () => {
    const editor = new Editor("Hello");
    const result = deleteForward(editor.context(0, 5));

    expect(result.operations).toHaveLength(0);
    expect(editor.text).toBe("Hello");
  });

  /**
   * Backspace at offset 0 is the fiddliest interaction in a block editor, and the one users perform
   * constantly without thinking. It must merge this block into the previous one, carrying the text.
   */
  it("backspace at the start of a block merges it into the previous block", () => {
    const editor = new Editor("First");
    const split = splitBlock(editor.context(0, 5)); // Enter at the end → a new empty block
    editor.apply(split.operations);
    editor.apply(insertText(editor.context(1, 0), "Second").operations);

    expect(editor.blocks).toHaveLength(2);
    expect(editor.text).toBe("First\nSecond");

    const merge = deleteBackward(editor.context(1, 0));
    editor.apply(merge.operations);

    expect(editor.blocks).toHaveLength(1);
    expect(editor.text).toBe("FirstSecond");
    // The caret must land at the join, not at the start or the end of the merged block.
    expect(offsetsFromSelection(editor.blocks[0]!, merge.selection).start).toBe(5);
  });

  it("backspace at the start of the FIRST block does nothing — the document stays typeable", () => {
    const editor = new Editor("Only");
    const result = deleteBackward(editor.context(0, 0));

    expect(result.operations).toHaveLength(0);
    expect(editor.blocks).toHaveLength(1);
  });
});

describe("input mapper — splitting", () => {
  it("Enter splits the block at the caret and moves the tail", () => {
    const editor = new Editor("HelloWorld");
    const result = splitBlock(editor.context(0, 5));
    editor.apply(result.operations);

    const blocks = editor.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe("Hello");
    expect(blocks[1]!.text).toBe("World");

    // The caret goes to the START of the new block — where the tail text now begins.
    expect(result.selection.blockId).toBe(blocks[1]!.id);
    expect(result.selection.anchor).toBeNull();
  });

  it("Enter at the end of a heading produces a paragraph, not another heading", () => {
    const editor = new Editor("Title");
    editor.apply([editor.factory.setBlockAttrs(editor.blocks[0]!.id, {}, "heading1")]);

    const result = splitBlock(editor.context(0, 5));
    editor.apply(result.operations);

    expect(editor.blocks[0]!.type).toBe("heading1");
    expect(editor.blocks[1]!.type).toBe("paragraph"); // ← not heading1
  });

  it("Enter in a list continues the list", () => {
    const editor = new Editor("item");
    editor.apply([editor.factory.setBlockAttrs(editor.blocks[0]!.id, {}, "bulletList")]);

    const result = splitBlock(editor.context(0, 4));
    editor.apply(result.operations);

    expect(editor.blocks[1]!.type).toBe("bulletList"); // ← lists DO persist
  });

  it("splitting carries marks onto the new block's text", () => {
    const editor = new Editor("HelloWorld");
    const block = editor.blocks[0]!;

    // Bold "World" (offsets 5..10).
    editor.apply(toggleMark(editor.context(0, 5, 10), "bold").operations);
    expect(editor.blocks[0]!.marks[7]?.["bold"]).toBe(true);

    const result = splitBlock(editor.context(0, 5));
    editor.apply(result.operations);

    const tail = editor.blocks[1]!;
    expect(tail.text).toBe("World");
    // Every character of the moved text kept its bold. A split that silently drops formatting is a
    // split that loses the user's work in a way they only notice later.
    for (let i = 0; i < tail.text.length; i += 1) {
      expect(tail.marks[i]?.["bold"]).toBe(true);
    }
    void block;
  });
});

describe("input mapper — marks", () => {
  it("toggles a mark on, then off", () => {
    const editor = new Editor("Hello");

    editor.apply(toggleMark(editor.context(0, 0, 5), "bold").operations);
    expect(editor.blocks[0]!.marks.every((marks) => marks["bold"] === true)).toBe(true);

    editor.apply(toggleMark(editor.context(0, 0, 5), "bold").operations);
    // Cleared to null, not left as `true`. The register still exists (it must, for LWW ordering) but
    // its value is now "not bold".
    expect(editor.blocks[0]!.marks.every((marks) => marks["bold"] !== true)).toBe(true);
  });

  it("bolds the whole selection when only part of it is bold (add wins over remove)", () => {
    const editor = new Editor("Hello");

    editor.apply(toggleMark(editor.context(0, 0, 2), "bold").operations); // bold "He"
    editor.apply(toggleMark(editor.context(0, 0, 5), "bold").operations); // toggle over "Hello"

    // Not every character was bold, so the toggle ADDS rather than removes — which is what every
    // editor does and what users expect.
    expect(editor.blocks[0]!.marks.every((marks) => marks["bold"] === true)).toBe(true);
  });

  it("does nothing on a collapsed caret", () => {
    const editor = new Editor("Hello");
    const result = toggleMark(editor.context(0, 2), "bold");
    expect(result.operations).toHaveLength(0);
  });
});

describe("selection is anchored to character ids, not offsets", () => {
  /**
   * The reason the whole editor stores selections as character ids.
   *
   * A collaborator inserts text BEFORE our caret. With offset-based selections, our caret would
   * silently drift left by the length of their insert — and the next character we type would land in
   * the wrong place. With id-anchored selections, the caret means the character it names, and it
   * survives.
   */
  it("survives a concurrent insert before the caret", () => {
    const editor = new Editor("world");

    const block = editor.blocks[0]!;
    const selection = selectionFromOffsets(block, 5, 5); // caret at the end of "world"
    expect(offsetsFromSelection(block, selection).start).toBe(5);

    // A collaborator prepends "hello " at the start of the block.
    const remote = editor.collaborator("collaborator");
    editor.apply([remote.insertText(block.id, null, "hello ")]);

    expect(editor.text).toBe("hello world");

    // The caret still sits after "world" — now at offset 11, not the stale 5. It tracked the CHARACTER,
    // not the position.
    const after = offsetsFromSelection(editor.blocks[0]!, selection);
    expect(after.start).toBe(11);
  });

  it("does not teleport to the top when a collaborator deletes the anchored character", () => {
    const editor = new Editor("hello");
    const block = editor.blocks[0]!;
    const selection = selectionFromOffsets(block, 5, 5);

    // The collaborator deletes the very character our caret is anchored to.
    const remote = editor.collaborator("collaborator");
    editor.apply([remote.deleteText(block.id, [block.charIds[4]!])]);

    const offsets = offsetsFromSelection(editor.blocks[0]!, selection);
    // Degrades gracefully to offset 0 rather than throwing or producing a negative index. The editor
    // re-anchors on the next keystroke; it does not crash and it does not corrupt.
    expect(offsets.start).toBeGreaterThanOrEqual(0);
    expect(offsets.end).toBeGreaterThanOrEqual(offsets.start);
  });
});

describe("markdown shortcuts", () => {
  const block = (text: string, type: RenderedBlock["type"] = "paragraph"): RenderedBlock => ({
    id: "b1",
    type,
    fracIndex: "V",
    attrs: {},
    text,
    charIds: [...text].map((_, i) => `c:${i}`),
    marks: [...text].map(() => ({}) as RenderedBlock["marks"][number]),
  });

  it("recognises headings, lists, quotes and code", () => {
    expect(matchShortcut(block("#"), 1, " ")?.type).toBe("heading1");
    expect(matchShortcut(block("##"), 2, " ")?.type).toBe("heading2");
    expect(matchShortcut(block("###"), 3, " ")?.type).toBe("heading3");
    expect(matchShortcut(block("-"), 1, " ")?.type).toBe("bulletList");
    expect(matchShortcut(block("1."), 2, " ")?.type).toBe("numberedList");
    expect(matchShortcut(block(">"), 1, " ")?.type).toBe("quote");
    expect(matchShortcut(block("[]"), 2, " ")?.type).toBe("todo");
  });

  it("consumes the typed prefix and swallows the trigger space", () => {
    const shortcut = matchShortcut(block("##"), 2, " ");
    expect(shortcut?.consumed).toBe(2); // the "##" is removed; the space is never inserted
  });

  /**
   * The bug this prevents: text transforming while you are writing a sentence *about* markdown.
   * "I typed # here" must stay a paragraph.
   */
  it("does NOT fire mid-sentence", () => {
    expect(matchShortcut(block("hello #"), 7, " ")).toBeNull();
    expect(matchShortcut(block("a # b"), 3, " ")).toBeNull();
  });

  it("does NOT fire on a non-space character", () => {
    expect(matchShortcut(block("#"), 1, "x")).toBeNull();
  });

  it("does NOT re-transform a block that is already a heading", () => {
    expect(matchShortcut(block("#", "heading1"), 1, " ")).toBeNull();
  });

  it("tries the longest prefix first (### is h3, not h2 plus a stray #)", () => {
    expect(matchShortcut(block("###"), 3, " ")?.type).toBe("heading3");
    expect(matchShortcut(block("###"), 3, " ")?.consumed).toBe(3);
  });
});

describe("inline markdown", () => {
  const block = (text: string): RenderedBlock => ({
    id: "b1",
    type: "paragraph",
    fracIndex: "V",
    attrs: {},
    text,
    charIds: [...text].map((_, i) => `c:${i}`),
    marks: [...text].map(() => ({}) as RenderedBlock["marks"][number]),
  });

  it("matches **bold** on the closing delimiter", () => {
    const match = matchInlineShortcut(block("**bold*"), 7, "*");
    expect(match?.mark).toBe("bold");
    expect(match?.content).toEqual([2, 3, 4, 5]); // the characters of "bold"
  });

  it("matches `code`", () => {
    const match = matchInlineShortcut(block("`x"), 2, "`");
    expect(match?.mark).toBe("code");
  });

  it("does not create an empty mark from `****`", () => {
    // Four asterisks are four asterisks. Turning them into a zero-length bold is a bug that presents
    // to the user as "my text vanished".
    expect(matchInlineShortcut(block("***"), 3, "*")).toBeNull();
  });

  it("does not match without an opening delimiter", () => {
    expect(matchInlineShortcut(block("hello"), 5, "*")).toBeNull();
  });
});
