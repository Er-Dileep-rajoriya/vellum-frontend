import { ulid } from "ulid";

import { makeCharId, parseCharId } from "./identity";
import type { Operation } from "./operations";
import type {
  AttrValue,
  BlockId,
  BlockType,
  CharId,
  ClientId,
  MarkType,
  MarkValue,
} from "./types";

/**
 * The operation factory. The ONLY place operations are created.
 *
 * Every mutation — a keystroke, a paste, an AI rewrite, a version restore — is minted here. That is
 * not a stylistic preference: the Lamport clock and the per-replica character counter must advance
 * monotonically and be allocated exactly once, and the single reliable way to guarantee that is for
 * there to be one allocator.
 *
 * It also means an AI edit and a human keystroke are indistinguishable to the rest of the system, so
 * AI edits are offline-queued, undoable, merged, versioned and audited for free rather than as a
 * feature someone has to remember to build. (DECISIONS.md D-014.)
 */
export class OperationFactory {
  readonly #clientId: ClientId;
  /**
   * ONE Lamport clock, used for both operation ordering and character identity.
   *
   * They were two counters at first, and that was a bug — a real one, caught by the property test.
   * Character ids must satisfy `id > origin.id` GLOBALLY (see identity.ts), and a per-replica counter
   * cannot: a fresh replica at counter 1, anchoring to a character with counter 500 authored by a
   * replica that had raced ahead, mints a child *smaller* than its own parent. The invariant collapses,
   * the subtree-skip in the insertion scan stops working, and two users typing at the same caret get
   * their words shredded into each other.
   *
   * A Lamport clock — advanced past everything observed, always — makes the invariant hold by
   * construction rather than by luck.
   */
  #clock: number;
  #documentVersion: bigint;

  constructor(clientId: ClientId, options?: { clock?: number }) {
    this.#clientId = clientId;
    this.#clock = options?.clock ?? 0;
    this.#documentVersion = 0n;
  }

  get clientId(): ClientId {
    return this.#clientId;
  }

  /**
   * Persisted with the replica.
   *
   * A clock that restarts at zero after a reload would mint character ids that ALREADY EXIST in the
   * document — the same replica, the same counters, different characters. Two distinct characters
   * with one identity is not a merge conflict; it is the end of the CRDT's ability to reason about
   * anything. This value is written to IndexedDB on every flush.
   */
  get clock(): number {
    return this.#clock;
  }

  /**
   * Advance past an observed operation. MUST be called for every remote operation, before this
   * replica authors its next one.
   *
   * Two things advance here, and both matter:
   *
   *   - the operation's `logicalClock`, which makes LWW registers causal — a value written by someone
   *     who had *seen* your write always beats yours, which is the only defensible resolution;
   *   - the highest character counter the operation *consumed*. A TEXT_INSERT of "hello" starting at
   *     counter 40 occupies 40..44, so observing it must leave our clock at ≥ 44. Advancing only past
   *     `logicalClock` would let us mint a character with a counter below one we have already seen —
   *     violating `id > origin.id` and reopening exactly the interleaving bug this design exists to
   *     prevent.
   */
  observe(op: Operation): void {
    this.#clock = Math.max(this.#clock, op.logicalClock);

    if (op.operationType === "TEXT_INSERT") {
      const { counter } = parseCharId(op.payload.charId);
      this.#clock = Math.max(this.#clock, counter + op.payload.value.length - 1);
    }
  }

  observeServerSeq(serverSeq: bigint): void {
    if (serverSeq > this.#documentVersion) this.#documentVersion = serverSeq;
  }

  #base() {
    this.#clock += 1;
    return {
      operationId: ulid(),
      clientId: this.#clientId,
      logicalClock: this.#clock,
      timestamp: Date.now(),
      documentVersion: this.#documentVersion,
    };
  }

  /**
   * Reserve `length` consecutive character ids from the Lamport clock.
   *
   * Consuming clock ticks for characters (rather than keeping a separate counter) is what guarantees
   * every character we mint outranks every character we have seen — including the origin we are
   * anchoring to. Ids are never reused and never reordered.
   */
  #allocateChars(length: number): CharId {
    const first = makeCharId(this.#clientId, this.#clock + 1);
    this.#clock += length;
    return first;
  }

  /**
   * `blockId` may be supplied explicitly, and exactly one caller does: the seed of a document's first
   * block.
   *
   * Two replicas opening the same empty document both decide it needs a first paragraph. With random
   * ids they mint two different blocks, the CRDT correctly keeps both, and the user gets a duplicate
   * empty paragraph they did not ask for. With a **deterministic** id derived from the documentId, both
   * replicas produce the *same* block — and `BLOCK_INSERT` on an existing block is already a no-op
   * (see document.ts). The duplicate cannot happen, using idempotency the engine already has.
   *
   * Every other caller passes nothing and gets a ULID, which is what you want for a block a human
   * actually created.
   */
  insertBlock(
    blockType: BlockType,
    fracIndex: string,
    attrs: Record<string, AttrValue> = {},
    blockId?: BlockId,
  ): Operation {
    return {
      ...this.#base(),
      operationType: "BLOCK_INSERT",
      payload: { blockId: blockId ?? ulid(), blockType, fracIndex, attrs },
    };
  }

  removeBlock(blockId: BlockId): Operation {
    return { ...this.#base(), operationType: "BLOCK_REMOVE", payload: { blockId } };
  }

  moveBlock(blockId: BlockId, fracIndex: string): Operation {
    return { ...this.#base(), operationType: "BLOCK_MOVE", payload: { blockId, fracIndex } };
  }

  setBlockAttrs(
    blockId: BlockId,
    attrs: Record<string, AttrValue>,
    blockType?: BlockType,
  ): Operation {
    return {
      ...this.#base(),
      operationType: "BLOCK_SET_ATTRS",
      payload: { blockId, attrs, ...(blockType !== undefined ? { blockType } : {}) },
    };
  }

  /**
   * `originLeft` is the character the run is anchored after; null = start of block.
   *
   * An empty run is rejected, loudly, at the moment it is minted. The server's validator specifies
   * `min(1)` on this field, so an empty TEXT_INSERT is an operation that can never be accepted: it
   * would be optimistically applied locally, pushed, rejected with a 400, retried, and finally parked
   * in the dead-letter queue — a corrupt-looking sync failure whose cause is hours upstream of where
   * it surfaces. Two live paths could reach it: an AI action that returned an empty string, and a
   * history step replaying a run with no characters left in it.
   *
   * Throwing here converts a silent, delayed, remote failure into an immediate local one at the exact
   * call site that is wrong. Callers with a legitimately-empty value must not call this at all — see
   * `inputMapper.insertText`, which returns no operations for empty text rather than an empty one.
   *
   * (`apply()` separately tolerates an empty run as a no-op. That is not redundancy: this guard is
   * about what *this client* is allowed to author, while `apply()` must stay total against anything a
   * peer, another tab, or a replayed log hands it. Authoring is strict; parsing is forgiving.)
   */
  insertText(blockId: BlockId, originLeft: CharId | null, value: string): Operation {
    if (value.length === 0) {
      throw new Error("insertText: empty value — the wire contract requires at least one character");
    }

    return {
      ...this.#base(),
      operationType: "TEXT_INSERT",
      payload: { blockId, charId: this.#allocateChars(value.length), originLeft, value },
    };
  }

  deleteText(blockId: BlockId, charIds: readonly CharId[]): Operation {
    return { ...this.#base(), operationType: "TEXT_DELETE", payload: { blockId, charIds } };
  }

  setMark(
    blockId: BlockId,
    charIds: readonly CharId[],
    mark: MarkType,
    value: MarkValue,
  ): Operation {
    return { ...this.#base(), operationType: "MARK_SET", payload: { blockId, charIds, mark, value } };
  }
}
