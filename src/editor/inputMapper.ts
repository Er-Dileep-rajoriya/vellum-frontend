import type { OperationFactory } from "@/crdt/factory";
import type { Operation } from "@/crdt/operations";
import type { BlockType, CharId, MarkType, MarkValue, RenderedBlock } from "@/crdt/types";
import { generateKeyBetween } from "@/crdt/fracIndex";

/**
 * The input path: a user's intent → CRDT operations.
 *
 * This is a PURE function, deliberately. It takes a rendered block, a selection, and an intent; it
 * returns operations. It never touches the DOM, never reads a ref, never schedules a render.
 *
 * That matters because the editor is where every rich-text project turns into an unmaintainable pile
 * of DOM special cases. By making the translation pure, the hard part — "the user pressed Backspace
 * with a 3-character selection at the start of a block; what exactly should happen?" — is testable in
 * milliseconds, exhaustively, without a browser. The React layer that calls this is then thin enough
 * to be obviously correct.
 *
 * The DOM is never the source of truth. We listen to `beforeinput` (which reports the intent BEFORE
 * the browser mutates anything), call `preventDefault()`, and re-render from the CRDT. The browser
 * never gets to "helpfully" normalise our document out from under us.
 */

/**
 * A selection, expressed in *character ids* rather than DOM offsets.
 *
 * This is the single most important representation choice in the editor. A selection stored as
 * `{ blockId, offset: 5 }` is invalidated the instant a collaborator inserts a character before
 * offset 5 — the caret silently drifts, or worse, an edit applies at the wrong place. A selection
 * anchored to character *ids* is immune: the characters it names are the characters it means, no
 * matter what anyone else types.
 */
export interface Selection {
  readonly blockId: string;
  /** Character the caret sits AFTER. `null` = start of the block. */
  readonly anchor: CharId | null;
  /** For a range selection: the characters covered, in document order. Empty for a collapsed caret. */
  readonly selected: readonly CharId[];
}

export function collapsed(blockId: string, anchor: CharId | null): Selection {
  return { blockId, anchor, selected: [] };
}

/** Build a Selection from DOM offsets. The ONLY place offsets are permitted to exist. */
export function selectionFromOffsets(
  block: RenderedBlock,
  start: number,
  end: number,
): Selection {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(block.charIds.length, Math.max(start, end));

  return {
    blockId: block.id,
    // The caret sits after the character at `from - 1`. At offset 0 there is no such character, which
    // is what `null` (= "the start of the block") means to the RGA.
    anchor: from === 0 ? null : (block.charIds[from - 1] ?? null),
    selected: block.charIds.slice(from, to),
  };
}

/** Map a Selection back to DOM offsets for rendering the caret. */
export function offsetsFromSelection(
  block: RenderedBlock,
  selection: Selection,
): { start: number; end: number } {
  const start =
    selection.anchor === null ? 0 : block.charIds.indexOf(selection.anchor) + 1;

  if (selection.selected.length === 0) return { start, end: start };

  const last = selection.selected[selection.selected.length - 1]!;
  const end = block.charIds.indexOf(last) + 1;

  // A collaborator can delete a character our selection named while we hold it. `indexOf` returns -1
  // and the arithmetic yields 0 — so we clamp to the anchor rather than silently teleporting the
  // caret to the top of the block, which is exactly the kind of "the cursor jumped" bug that makes
  // collaborative editors feel haunted.
  return { start, end: end <= 0 ? start : end };
}

export interface EditorContext {
  readonly factory: OperationFactory;
  readonly block: RenderedBlock;
  readonly selection: Selection;
  /** All blocks, in document order. Needed to position a new block's fractional index. */
  readonly blocks: readonly RenderedBlock[];
}

export interface EditResult {
  readonly operations: readonly Operation[];
  /** Where the caret must be after these operations apply. */
  readonly selection: Selection;
}

const EMPTY: EditResult = { operations: [], selection: { blockId: "", anchor: null, selected: [] } };

/**
 * Insert text at the selection, replacing it if it is a range.
 *
 * Replacing a selection is a delete AND an insert, in that order, in one batch — and the insert must
 * be anchored to the character before the selection, NOT to a character inside it. Anchoring inside
 * would make the new text's origin a tombstone that a concurrent replica might not have; correct
 * (the pending buffer handles it) but needlessly slow. Anchoring before is both correct and cheap.
 */
export function insertText(context: EditorContext, text: string): EditResult {
  if (text.length === 0) return { operations: [], selection: context.selection };

  const { factory, block, selection } = context;
  const operations: Operation[] = [];

  let anchor = selection.anchor;

  if (selection.selected.length > 0) {
    operations.push(factory.deleteText(block.id, selection.selected));
    // The anchor is already the character *before* the selection, so it survives the delete and is
    // the correct origin for the replacement text.
    anchor = selection.anchor;
  }

  const insert = factory.insertText(block.id, anchor, text);
  operations.push(insert);

  const payload = (insert as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload;
  const lastCharId = lastIdOfRun(payload.charId, text.length);

  return { operations, selection: collapsed(block.id, lastCharId) };
}

/** Delete backwards: Backspace. */
export function deleteBackward(context: EditorContext): EditResult {
  const { factory, block, selection } = context;

  if (selection.selected.length > 0) {
    return {
      operations: [factory.deleteText(block.id, selection.selected)],
      // The caret collapses to where the selection started, which is the character before it.
      selection: collapsed(block.id, selection.anchor),
    };
  }

  if (selection.anchor === null) {
    // Backspace at the very start of a block. In a block editor this is "merge with the previous
    // block" — the single most fiddly interaction in the whole editor, and the one users do
    // constantly without thinking about it.
    return mergeWithPrevious(context);
  }

  const index = block.charIds.indexOf(selection.anchor);
  /* c8 ignore next -- the anchor is always a character in this block or null */
  if (index === -1) return { operations: [], selection };

  const previous = index === 0 ? null : (block.charIds[index - 1] ?? null);

  return {
    operations: [factory.deleteText(block.id, [selection.anchor])],
    selection: collapsed(block.id, previous),
  };
}

/** Delete forwards: Delete key. */
export function deleteForward(context: EditorContext): EditResult {
  const { factory, block, selection } = context;

  if (selection.selected.length > 0) {
    return {
      operations: [factory.deleteText(block.id, selection.selected)],
      selection: collapsed(block.id, selection.anchor),
    };
  }

  const index = selection.anchor === null ? -1 : block.charIds.indexOf(selection.anchor);
  const next = block.charIds[index + 1];
  if (next === undefined) return { operations: [], selection }; // end of block: nothing ahead

  return {
    operations: [factory.deleteText(block.id, [next])],
    selection, // the caret does not move when deleting forwards
  };
}

/**
 * Enter: split the block at the caret.
 *
 * The text after the caret moves into a NEW block. Implemented as: create the block, re-insert the
 * tail text there, tombstone the tail here.
 *
 * The re-insert is not a "move" — there is no move operation for text, and there must not be. A move
 * would need to preserve character identity across blocks, which would let two replicas concurrently
 * "move" the same character into two different blocks and duplicate it. Delete-and-reinsert gives the
 * new characters fresh ids, and duplication becomes structurally impossible.
 *
 * The cost, stated honestly: the tail text loses its authorship attribution and its marks are
 * re-applied rather than carried. Splitting a paragraph is not a common enough operation for that to
 * be worth the risk of a duplication bug that only appears under concurrency.
 */
export function splitBlock(context: EditorContext): EditResult {
  const { factory, block, selection, blocks } = context;

  const caretIndex =
    selection.anchor === null ? 0 : block.charIds.indexOf(selection.anchor) + 1;

  const tailIds = block.charIds.slice(caretIndex);
  const tailText = block.text.slice(caretIndex);

  const operations: Operation[] = [];

  const insertBlock = factory.insertBlock(
    // A split inherits the block's type EXCEPT for one-shot types: pressing Enter at the end of a
    // heading gives you a paragraph, not another heading. Anyone who has fought a word processor
    // about this knows why.
    continuationTypeOf(block.type),
    fracIndexAfter(blocks, block.id),
  );
  operations.push(insertBlock);

  const newBlockId = (insertBlock as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
    .blockId;

  if (tailIds.length > 0) {
    operations.push(factory.deleteText(block.id, tailIds));
    const insert = factory.insertText(newBlockId, null, tailText);
    operations.push(insert);

    // Carry the marks across. They are re-applied per character on the new ids — the marks are LWW
    // registers keyed by (charId, markType), so "re-apply" is a well-defined operation rather than a
    // hack.
    const payload = (insert as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload;
    operations.push(...carryMarks(factory, newBlockId, payload.charId, block, caretIndex));
  }

  return { operations, selection: collapsed(newBlockId, null) };
}

/** Backspace at the start of a block: merge into the previous one. */
function mergeWithPrevious(context: EditorContext): EditResult {
  const { factory, block, blocks } = context;

  const index = blocks.findIndex((b) => b.id === block.id);
  const previous = index > 0 ? blocks[index - 1] : undefined;

  // The first block of the document. Backspace does nothing — it must not delete the block, or the
  // user would be left with a document they cannot type into.
  if (previous === undefined) return { operations: [], selection: context.selection };

  const operations: Operation[] = [];
  const anchor = previous.charIds[previous.charIds.length - 1] ?? null;

  if (block.text.length > 0) {
    const insert = factory.insertText(previous.id, anchor, block.text);
    operations.push(insert);

    const payload = (insert as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload;
    operations.push(...carryMarks(factory, previous.id, payload.charId, block, 0));
  }

  // Tombstone the now-empty block. Its text (if any) lives on in the previous block under new ids.
  operations.push(factory.removeBlock(block.id));

  return { operations, selection: collapsed(previous.id, anchor) };
}

/** Toggle a mark over the selection. */
export function toggleMark(context: EditorContext, mark: MarkType): EditResult {
  const { factory, block, selection } = context;
  if (selection.selected.length === 0) return { operations: [], selection };

  // Toggle semantics: if EVERY selected character already has the mark, remove it; otherwise add it.
  // "Some are bold" → bold all, which is what every editor in existence does and what users expect.
  const allMarked = selection.selected.every((charId) => {
    const index = block.charIds.indexOf(charId);
    return index !== -1 && block.marks[index]?.[mark] === true;
  });

  const value: MarkValue = allMarked ? null : true;

  return {
    operations: [factory.setMark(block.id, selection.selected, mark, value)],
    selection,
  };
}

/** Change a block's type — used by the slash menu and by markdown shortcuts. */
export function setBlockType(
  context: EditorContext,
  type: BlockType,
  attrs: Record<string, string | number | boolean | null> = {},
): EditResult {
  return {
    operations: [context.factory.setBlockAttrs(context.block.id, attrs, type)],
    selection: context.selection,
  };
}

/** Insert an empty block below the current one (slash menu, Enter on an empty list item). */
export function insertBlockAfter(context: EditorContext, type: BlockType): EditResult {
  const { factory, block, blocks } = context;

  const op = factory.insertBlock(type, fracIndexAfter(blocks, block.id));
  const blockId = (op as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload.blockId;

  return { operations: [op], selection: collapsed(blockId, null) };
}

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────

function lastIdOfRun(firstCharId: CharId, length: number): CharId {
  const separator = firstCharId.lastIndexOf(":");
  const clientId = firstCharId.slice(0, separator);
  const counter = Number(firstCharId.slice(separator + 1));
  return `${clientId}:${counter + length - 1}`;
}

/**
 * A fractional index strictly between `blockId` and whatever follows it.
 *
 * `blocks` is in document order, so the neighbour is simply the next element. Inserting between two
 * blocks touches NEITHER of them — that is the whole point of fractional indexing (D-004). The
 * alternative, integer positions, would emit an operation for every subsequent block in the document
 * on every Enter keypress.
 */
function fracIndexAfter(blocks: readonly RenderedBlock[], blockId: string): string {
  const index = blocks.findIndex((b) => b.id === blockId);
  const before = index === -1 ? null : (blocks[index]?.fracIndex ?? null);
  const after = index === -1 ? null : (blocks[index + 1]?.fracIndex ?? null);

  return generateKeyBetween(before, after);
}

/**
 * Pressing Enter at the end of a heading should give a paragraph, not another heading. Same for
 * quotes and callouts. Lists are the exception — Enter in a list continues the list, which is the one
 * place users *do* want the type to persist.
 */
function continuationTypeOf(type: BlockType): BlockType {
  switch (type) {
    case "bulletList":
    case "numberedList":
    case "todo":
      return type;
    default:
      return "paragraph";
  }
}

/** Re-apply the marks of `block`'s characters from `fromIndex` onto a freshly-inserted run. */
function carryMarks(
  factory: OperationFactory,
  targetBlockId: string,
  firstNewCharId: CharId,
  block: RenderedBlock,
  fromIndex: number,
): Operation[] {
  const separator = firstNewCharId.lastIndexOf(":");
  const clientId = firstNewCharId.slice(0, separator);
  const base = Number(firstNewCharId.slice(separator + 1));

  // Group by (mark, value) so a bold run of 40 characters is ONE operation, not forty. The naive
  // per-character version is correct and would quietly turn a paragraph split into a 200-operation
  // batch — which the user pays for in sync latency, in storage, and in every future replay.
  const byMark = new Map<string, { mark: MarkType; value: MarkValue; charIds: CharId[] }>();

  for (let i = fromIndex; i < block.charIds.length; i += 1) {
    const marks = block.marks[i];
    if (marks === undefined) continue;

    const newCharId: CharId = `${clientId}:${base + (i - fromIndex)}`;

    for (const [mark, value] of Object.entries(marks) as [MarkType, MarkValue][]) {
      if (value === null || value === false) continue;

      const key = `${mark}:${String(value)}`;
      const group = byMark.get(key);
      if (group === undefined) {
        byMark.set(key, { mark, value, charIds: [newCharId] });
      } else {
        group.charIds.push(newCharId);
      }
    }
  }

  return [...byMark.values()].map((group) =>
    factory.setMark(targetBlockId, group.charIds, group.mark, group.value),
  );
}

export { EMPTY as EMPTY_EDIT };
