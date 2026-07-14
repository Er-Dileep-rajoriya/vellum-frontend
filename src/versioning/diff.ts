/**
 * The diff engine.
 *
 * Two levels, because a document is two-dimensional:
 *
 *   1. **Block level** — which paragraphs were added, removed, or kept. An LCS (longest common
 *      subsequence) over block *content*, not block ids: a restore re-creates blocks with new ids, so
 *      an id-based diff would report "everything changed" on a restore that changed one word.
 *
 *   2. **Word level** — within a block that survived but changed, which words moved. Words, not
 *      characters: a character diff of "the cat sat" → "the dog sat" highlights `c`,`a`,`t` → `d`,`o`,`g`
 *      as a jumble of single-letter edits, which is technically correct and unreadable. Humans read
 *      diffs in words.
 *
 * Pure functions, no dependencies. The version-history UI renders whatever these return.
 */

export interface DiffBlock {
  readonly kind: "added" | "removed" | "unchanged" | "changed";
  readonly blockId: string;
  readonly type: string;
  readonly text: string;
  /** Only set when `kind === "changed"`: the word-level diff within this block. */
  readonly words?: readonly DiffWord[];
}

export interface DiffWord {
  readonly kind: "added" | "removed" | "unchanged";
  readonly text: string;
}

export interface DiffableBlock {
  readonly id: string;
  readonly type: string;
  readonly text: string;
}

export interface DiffSummary {
  readonly blocks: readonly DiffBlock[];
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

/**
 * The LCS table, computed with the classic dynamic-programming approach.
 *
 * O(n·m) in time and space. For a document that is a few thousand blocks, that is a few million
 * integers — fine, and it runs off the render path (in the history panel, on demand). Myers' algorithm
 * would be O(n·d) and is what you would reach for on a 100,000-line file; for prose documents the
 * simpler table is correct, obviously correct, and fast enough, and "obviously correct" is worth real
 * money in a diff that people use to decide whether to restore a version.
 */
function lcsTable(left: readonly string[], right: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  return table;
}

/** Word-level diff within one block. */
export function diffWords(before: string, after: string): DiffWord[] {
  // Split on whitespace but KEEP it, so reassembling the words reproduces the original text exactly.
  // A diff that silently normalises whitespace is a diff that lies about what changed.
  const left = before.split(/(\s+)/).filter((token) => token !== "");
  const right = after.split(/(\s+)/).filter((token) => token !== "");

  const table = lcsTable(left, right);
  const result: DiffWord[] = [];

  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ kind: "unchanged", text: left[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({ kind: "removed", text: left[i]! });
      i += 1;
    } else {
      result.push({ kind: "added", text: right[j]! });
      j += 1;
    }
  }

  while (i < left.length) {
    result.push({ kind: "removed", text: left[i]! });
    i += 1;
  }
  while (j < right.length) {
    result.push({ kind: "added", text: right[j]! });
    j += 1;
  }

  return result;
}

/**
 * Diff two document states.
 *
 * Blocks are matched on `${type}\u0000${text}` — their *content*, not their id. This is the key
 * decision, and it is forced by how restore works: restoring a version re-creates its blocks as NEW
 * operations with NEW ids (D-010), so an id-based diff between "the document" and "the version it was
 * restored from" would report every block as removed-and-re-added. Content matching reports what a
 * human would call the truth: nothing changed.
 *
 * The cost of content matching is that two identical paragraphs are interchangeable to the diff. That
 * produces a diff that is *equally short* but may attribute the change to the wrong one of two
 * identical blocks — which, since they are identical, is not a distinction a reader can perceive.
 */
export function diffDocuments(
  before: readonly DiffableBlock[],
  after: readonly DiffableBlock[],
): DiffSummary {
  const leftKeys = before.map(keyOf);
  const rightKeys = after.map(keyOf);
  const table = lcsTable(leftKeys, rightKeys);

  const blocks: DiffBlock[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    const left = before[i]!;
    const right = after[j]!;

    if (leftKeys[i] === rightKeys[j]) {
      blocks.push({ kind: "unchanged", blockId: right.id, type: right.type, text: right.text });
      i += 1;
      j += 1;
      continue;
    }

    /**
     * Is this an *edit* of a block, or a delete of one plus an insert of another?
     *
     * Pairing them into an edit produces a word-level diff ("cat" → "dog") instead of two walls of red
     * and green — the difference between a diff a person reads and one they scroll past.
     *
     * The first version of this decided by peeking at whether the NEXT pair of blocks matched, which is
     * a structural guess and is wrong the moment there are trailing additions: a document ending with a
     * brand-new paragraph made every preceding edit look like a delete-plus-insert. The test caught it.
     *
     * So decide on the actual question instead: **do these two blocks resemble each other?** Same type,
     * and enough shared words that a reader would call it "the same paragraph, edited". The 0.4
     * threshold is a judgement call — high enough that two unrelated paragraphs are not smeared into a
     * confusing word diff, low enough that a heavily-rewritten sentence still pairs.
     */
    const isEdit = left.type === right.type && similarity(left.text, right.text) >= 0.4;

    if (isEdit) {
      blocks.push({
        kind: "changed",
        blockId: right.id,
        type: right.type,
        text: right.text,
        words: diffWords(left.text, right.text),
      });
      changed += 1;
      i += 1;
      j += 1;
      continue;
    }

    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      blocks.push({ kind: "removed", blockId: left.id, type: left.type, text: left.text });
      removed += 1;
      i += 1;
    } else {
      blocks.push({ kind: "added", blockId: right.id, type: right.type, text: right.text });
      added += 1;
      j += 1;
    }
  }

  while (i < before.length) {
    const left = before[i]!;
    blocks.push({ kind: "removed", blockId: left.id, type: left.type, text: left.text });
    removed += 1;
    i += 1;
  }

  while (j < after.length) {
    const right = after[j]!;
    blocks.push({ kind: "added", blockId: right.id, type: right.type, text: right.text });
    added += 1;
    j += 1;
  }

  return { blocks, added, removed, changed };
}

/**
 * How alike are two blocks of text? 0 = nothing in common, 1 = identical.
 *
 * Word-level LCS over max length. Not a character measure: "the cat sat" and "the dog sat" share two
 * of three words (0.67 — clearly an edit), while by characters they share most of their letters and
 * would score high even for genuinely unrelated sentences that happen to use the same alphabet.
 */
function similarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left === "" || right === "") return 0;

  const leftWords = left.split(/\s+/).filter(Boolean);
  const rightWords = right.split(/\s+/).filter(Boolean);
  if (leftWords.length === 0 || rightWords.length === 0) return 0;

  const common = lcsTable(leftWords, rightWords)[0]![0]!;
  return common / Math.max(leftWords.length, rightWords.length);
}

function keyOf(block: DiffableBlock): string {
  // NUL as the separator, and it is written as an escape rather than embedded as a raw control
  // character in the source. With a plain space, a paragraph whose text starts with "1 x" would key
  // identically to a heading block with text "x" — the type and the text would smear into each other
  // and the diff would silently treat two different blocks as the same. NUL cannot appear in the text:
  // the editor only inserts characters the user actually typed, and there is no key for it.
  return `${block.type}\u0000${block.text}`;
}
