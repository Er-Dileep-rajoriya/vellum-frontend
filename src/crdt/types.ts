/**
 * The CRDT document model.
 *
 * This module is pure: no React, no DOM, no network, no storage. It is a state machine whose only
 * input is an operation and whose only output is a new document state. That purity is what makes the
 * convergence property testable — the fuzz test can run ten thousand random histories through it in
 * a second precisely because it touches nothing.
 */

/** Replica identity. One per device+tab. Persisted; never reused across replicas. */
export type ClientId = string;

/**
 * A character's identity: `<clientId>:<counter>`.
 *
 * Uniqueness is *structural*, not probabilistic: the clientId namespaces the counter, and a replica
 * never reuses a counter. This matters more than it looks — the entire convergence argument rests on
 * every character in the universe having exactly one id, forever, on every replica.
 */
export type CharId = string;

export type BlockId = string;

export type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "numberedList"
  | "todo"
  | "quote"
  | "code"
  | "divider"
  | "image"
  | "table"
  | "callout";

export type MarkType =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "code"
  | "link"
  | "mention"
  | "highlight";

export type MarkValue = boolean | string | null;
export type AttrValue = string | number | boolean | null;

/**
 * A last-writer-wins register, ordered by a hybrid logical clock.
 *
 * Used ONLY for scalars — a heading level, a code block's language, whether a mark is on. Never for
 * authored text. The distinction is the core design rule of this engine (DECISIONS.md D-002): use
 * the weakest primitive that cannot lose data, for the shape of data it guards. For a scalar there is
 * no merge — one value must win — and LWW picks a winner deterministically while destroying nothing a
 * human typed. For prose, LWW would destroy an entire paragraph, so prose gets a sequence CRDT.
 */
export interface Register<T> {
  readonly value: T;
  /** Lamport counter. Higher wins. */
  readonly clock: number;
  /** Tiebreak when clocks are equal. Higher clientId wins. Arbitrary, but *identical everywhere*. */
  readonly clientId: ClientId;
}

export interface Char {
  readonly id: CharId;
  readonly value: string;
  /**
   * The character this one was inserted immediately after, at the moment of insertion. `null` means
   * "at the start of the block".
   *
   * This is the RGA origin, and it is the single most important field in the model. Without it, a
   * concurrent insert has no defined position and the merge is not deterministic — it is a guess.
   * With it, two replicas that have seen the same operations *must* place this character at the same
   * index, regardless of the order those operations arrived in.
   */
  readonly originLeft: CharId | null;
  /**
   * Tombstone. Deleted characters are never removed from the sequence.
   *
   * This is not laziness, it is a requirement: a concurrent insert may be anchored to this character
   * as its origin, and an origin that has vanished cannot be resolved — the insert would have nowhere
   * to go, and the two replicas would place it differently. Tombstones are bounded by snapshot
   * compaction (ARCHITECTURE.md §8), which is the *only* safe place to remove them.
   */
  readonly deleted: boolean;
  /** Per-mark LWW register. Sparse: absent means "not set", which renders as the default. */
  readonly marks: ReadonlyMap<MarkType, Register<MarkValue>>;
}

export interface Block {
  readonly id: BlockId;
  readonly type: Register<BlockType>;
  /**
   * Fractional index. Lexicographically comparable; new blocks get a key strictly between their
   * neighbours, so an insert never renumbers anything else. (DECISIONS.md D-004.)
   */
  readonly fracIndex: Register<string>;
  readonly attrs: ReadonlyMap<string, Register<AttrValue>>;
  /** The sequence, in document order, INCLUDING tombstones. */
  readonly chars: readonly Char[];
  readonly deleted: boolean;
}

/**
 * The document's value. Blocks and a cursor — nothing else.
 *
 * Note what is NOT here: the set of operation ids already applied. That set is a *delivery* concern —
 * it exists because a WebSocket broadcast and an HTTP pull can carry the same operation — and it lives
 * on `Replica`, the one boundary every operation enters through. Two reasons it does not belong in the
 * document value:
 *
 *   1. **Correctness of comparison.** Two replicas holding an identical document should compare equal.
 *      With the dedup index inside the state, they would differ whenever they had *received* different
 *      duplicates, which is a difference in network history, not in the document.
 *   2. **Cost.** The set grows with every operation ever applied and never shrinks. Keeping it inside a
 *      persistent state meant copying it on every keystroke — an O(session history) term on the hot
 *      path. A benchmark caught this: it is invisible on a fresh document and it is a growing tax on a
 *      long editing session, which is precisely the case that must not degrade.
 */
export interface DocumentState {
  readonly blocks: ReadonlyMap<BlockId, Block>;
  /** The highest serverSeq folded into this state. The sync cursor. */
  readonly serverSeq: bigint;
}

/** The rendered view the editor consumes. Derived; never stored. */
export interface RenderedBlock {
  readonly id: BlockId;
  readonly type: BlockType;
  /**
   * The block's position key, surfaced because the editor needs it to compute a fractional index
   * *between* two blocks when inserting. It is deliberately a first-class field rather than smuggled
   * into `attrs`: `attrs` is user-authored data (heading level, code language), and mixing a system
   * field into it means the day someone iterates `attrs` to render block properties, the internal
   * position key shows up in the UI.
   */
  readonly fracIndex: string;
  readonly attrs: Readonly<Record<string, AttrValue>>;
  readonly text: string;
  /** Parallel to `text`: the character id at each offset. Maps a DOM selection back onto the CRDT. */
  readonly charIds: readonly CharId[];
  readonly marks: readonly Readonly<Record<MarkType, MarkValue>>[];
}
