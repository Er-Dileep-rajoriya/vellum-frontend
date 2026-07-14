import type { OperationFactory } from "@/crdt/factory";
import type { Operation } from "@/crdt/operations";
import type { CharId, DocumentState } from "@/crdt/types";

/**
 * Undo / redo.
 *
 * Three things about undo in a CRDT are counter-intuitive. Getting any of them wrong destroys data,
 * and I got the third one wrong first — a two-tab E2E test caught it.
 *
 * **1. Undo is not a rewind. It is a new, forward operation.**
 *
 *    You cannot un-delete a character. A tombstone is permanent, and resurrecting one would let this
 *    replica revive a character a *collaborator* legitimately deleted — their deletion would silently
 *    vanish. So undoing a delete means re-inserting the same text as NEW characters with NEW ids.
 *    Exactly like a version restore (D-010), which is why neither is a special case in the merge
 *    engine and why neither can corrupt a live session.
 *
 * **2. Undo is local-origin only.**
 *
 *    Ctrl+Z reverts *your* last edit, not the document's last operation. Otherwise, in a shared
 *    document, you would revert your colleague's sentence while their cursor sat in it.
 *
 * **3. Undo must touch ONLY the characters your operation touched.**
 *
 *    This is the one I got wrong. The first version recorded "block B said X, now it says Y" and undid
 *    by replacing the block's whole text with X. That looks right, passes a single-block unit test, and
 *    **deletes everything a collaborator typed into that paragraph in the meantime.** Alice types
 *    "AAA", Bob appends "BBB" to the same block, Alice hits Ctrl+Z — and Bob's "BBB" is gone.
 *
 *    So a step records the exact character ids it inserted, and the exact text it removed. Undo
 *    tombstones precisely those ids (deletes are idempotent, so a character Bob already removed is
 *    harmless) and re-inserts precisely that text. Everything else in the block is untouched, because
 *    it was never named.
 */

/** One undoable step: what this replica's operation actually did to one block. */
export interface HistoryStep {
  readonly blockId: string;
  /** Character ids this step INSERTED. Undoing means tombstoning exactly these. */
  readonly inserted: readonly CharId[];
  /**
   * Text this step REMOVED, with the character it sat after, and the ids it used to have.
   *
   * Undoing re-inserts the text as NEW characters (tombstones are forever). `originalIds` is what lets
   * the stack be REMAPPED afterwards: an older entry that still refers to those dead ids would
   * otherwise be unable to remove the text a later undo just re-created — undo twice and the text
   * accumulates instead of disappearing. This is the staleness bug that a three-step undo test caught.
   */
  readonly removed: readonly {
    readonly anchor: CharId | null;
    readonly text: string;
    readonly originalIds: readonly CharId[];
  }[];
  readonly label: string;
}

export class History {
  #undoStack: HistoryStep[] = [];
  #redoStack: HistoryStep[] = [];

  /** Bounded. Nobody has ever wanted to undo their 200th-last keystroke, and the memory is not free. */
  readonly #limit = 200;

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  /**
   * Record what a locally-authored batch of operations did.
   *
   * Derived from the operations themselves rather than from a before/after snapshot of the block —
   * that is the whole fix. The operations name exactly which characters they touched; a text snapshot
   * names the entire paragraph, including a collaborator's words that were never ours to revert.
   */
  record(operations: readonly Operation[], state: DocumentState, label: string): void {
    const step = describe(operations, state, label);
    if (step === null) return;

    this.#undoStack.push(step);
    if (this.#undoStack.length > this.#limit) this.#undoStack.shift();

    /**
     * A new edit clears the redo stack. Standard everywhere, and not arbitrary: once you type
     * something new, the future you could have redone into no longer exists, and splicing it into a
     * document that has since diverged would produce a state nobody ever wrote.
     */
    this.#redoStack = [];
  }

  undo(factory: OperationFactory, state: DocumentState): Operation[] {
    const step = this.#undoStack.pop();
    if (step === undefined) return [];

    const { operations, inverse, remap } = invert(step, factory, state);

    // The undo is itself a set of operations, so its inverse is what "redo" means. Deriving it from
    // what the undo *actually did* (rather than re-deriving from the original step) is what keeps redo
    // exact after the CRDT has assigned fresh ids.
    this.#redoStack.push(inverse);

    // Repair every OTHER entry that referred to the characters this undo just re-created under new
    // ids — see #applyRemap.
    this.#applyRemap(remap);

    return operations;
  }

  redo(factory: OperationFactory, state: DocumentState): Operation[] {
    const step = this.#redoStack.pop();
    if (step === undefined) return [];

    const { operations, inverse, remap } = invert(step, factory, state);
    this.#undoStack.push(inverse);
    this.#applyRemap(remap);

    return operations;
  }

  /**
   * Rewrite every stale character id on both stacks.
   *
   * When an undo re-inserts deleted text, those characters come back with **new ids** — they must, and
   * this is not negotiable: reviving the original ids would resurrect tombstones, and a tombstone that
   * comes back to life is a collaborator's deletion silently undone.
   *
   * But an *older* entry still on the undo stack may name the old, now-dead ids. It would try to
   * tombstone characters that no longer exist, tombstone nothing, and leave the text on screen. Undo
   * twice and instead of stepping back through history you accumulate it: `v1` → `v2` → `v3`, undo,
   * undo, and you are looking at `v1v2`.
   *
   * That is precisely the bug the three-step undo test caught, and this is the repair.
   */
  #applyRemap(remap: ReadonlyMap<CharId, CharId>): void {
    if (remap.size === 0) return;

    const rewrite = (step: HistoryStep): HistoryStep => ({
      ...step,
      inserted: step.inserted.map((id) => remap.get(id) ?? id),
      removed: step.removed.map((run) => ({
        ...run,
        anchor: run.anchor === null ? null : (remap.get(run.anchor) ?? run.anchor),
        originalIds: run.originalIds.map((id) => remap.get(id) ?? id),
      })),
    });

    this.#undoStack = this.#undoStack.map(rewrite);
    this.#redoStack = this.#redoStack.map(rewrite);
  }

  clear(): void {
    this.#undoStack = [];
    this.#redoStack = [];
  }
}

/**
 * What did these operations do?
 *
 * `state` is the state BEFORE they were applied — that is where the text of the deleted characters
 * still exists to be remembered.
 */
function describe(
  operations: readonly Operation[],
  state: DocumentState,
  label: string,
): HistoryStep | null {
  let blockId: string | null = null;
  const inserted: CharId[] = [];
  const removed: { anchor: CharId | null; text: string; originalIds: CharId[] }[] = [];

  for (const op of operations) {
    if (op.operationType === "TEXT_INSERT") {
      blockId ??= op.payload.blockId;
      inserted.push(...expandRun(op.payload.charId, op.payload.value.length));
    } else if (op.operationType === "TEXT_DELETE") {
      blockId ??= op.payload.blockId;

      const block = state.blocks.get(op.payload.blockId);
      if (block === undefined) continue;

      // Remember the deleted text AND where it sat, so the undo can put it back in the right place
      // rather than at the start of the block.
      const targets = new Set(op.payload.charIds);
      const chars = block.chars;

      let runText = "";
      let anchor: CharId | null = null;
      const originalIds: CharId[] = [];

      for (let i = 0; i < chars.length; i += 1) {
        const char = chars[i]!;
        if (!targets.has(char.id) || char.deleted) continue;

        if (runText === "") {
          // The anchor is the nearest LIVE character to the left — the one this run will be re-inserted
          // after. A tombstoned anchor would still work (it is a valid RGA origin) but re-inserting
          // after a live character keeps the text where the user expects to see it.
          anchor = previousLiveChar(chars, i);
        }
        runText += char.value;
        originalIds.push(char.id);
      }

      if (runText !== "") removed.push({ anchor, text: runText, originalIds });
    }
  }

  // Block-level operations (insert, remove, attrs) are not undoable in this version. Recording a step
  // with nothing in it would make Ctrl+Z appear to do nothing, once, which is worse than it doing
  // nothing at all — so we record no step.
  if (blockId === null || (inserted.length === 0 && removed.length === 0)) return null;

  return { blockId, inserted, removed, label };
}

/**
 * Build the operations that reverse a step — and the step that would reverse *those*.
 *
 * Note what is NOT here: any read of the block's full text. The step names its own characters, and
 * nothing else in the block is touched. A collaborator's words are not ours to revert.
 */
function invert(
  step: HistoryStep,
  factory: OperationFactory,
  state: DocumentState,
): { operations: Operation[]; inverse: HistoryStep; remap: Map<CharId, CharId> } {
  const block = state.blocks.get(step.blockId);

  // The block was removed — by this user, or by a collaborator. Re-creating it would resurrect
  // something someone deliberately deleted, so the undo does nothing. That is the honest outcome.
  if (block === undefined || block.deleted) {
    return { operations: [], inverse: step, remap: new Map() };
  }

  const operations: Operation[] = [];

  const inverseRemoved: { anchor: CharId | null; text: string; originalIds: CharId[] }[] = [];
  const inverseInserted: CharId[] = [];
  /** old id → new id, for every character this inversion re-created under a fresh identity. */
  const remap = new Map<CharId, CharId>();

  /**
   * Undo the insert: tombstone exactly the characters this step created.
   *
   * Filtered to those still alive. Deleting an already-tombstoned character is idempotent and would be
   * harmless — but a character that no longer exists in this block *at all* would be buffered forever
   * by the pending-dependency logic, waiting for an insert that is never coming.
   */
  const stillAlive = step.inserted.filter((id) =>
    block.chars.some((char) => char.id === id && !char.deleted),
  );

  if (stillAlive.length > 0) {
    // Remember the text and position, so the redo can put it back.
    const text = stillAlive
      .map((id) => block.chars.find((char) => char.id === id)?.value ?? "")
      .join("");

    const firstIndex = block.chars.findIndex((char) => char.id === stillAlive[0]);
    inverseRemoved.push({
      anchor: firstIndex > 0 ? previousLiveChar(block.chars, firstIndex) : null,
      text,
      originalIds: stillAlive,
    });

    operations.push(factory.deleteText(step.blockId, stillAlive));
  }

  /** Undo the delete: re-insert the text as NEW characters. The tombstones stay tombstoned. */
  for (const run of step.removed) {
    // Nothing to put back. A run can be empty if the step recorded a delete over characters a
    // collaborator had already tombstoned; re-inserting "" is not just pointless, it is an operation
    // the server's validator rejects outright (`min(1)`), so it would fail the whole sync batch that
    // carried it. Skip it — the undo of "delete nothing" is "insert nothing".
    if (run.text.length === 0) continue;

    // The anchor may itself have been deleted by a collaborator since. A tombstone is still a valid
    // RGA origin (that is exactly why tombstones exist), so this still lands in the right place.
    const anchorExists =
      run.anchor === null || block.chars.some((char) => char.id === run.anchor);

    const insert = factory.insertText(step.blockId, anchorExists ? run.anchor : null, run.text);
    operations.push(insert);

    const payload = (insert as Extract<Operation, { operationType: "TEXT_INSERT" }>).payload;
    const newIds = expandRun(payload.charId, run.text.length);
    inverseInserted.push(...newIds);

    // The re-inserted characters carry NEW ids. Any OTHER entry still on the stack that refers to the
    // old ones is now stale — it would try to tombstone characters that no longer exist, and the text
    // it meant to remove would survive. Record the mapping so the stack can be repaired.
    run.originalIds.forEach((oldId, index) => {
      const newId = newIds[index];
      if (newId !== undefined) remap.set(oldId, newId);
    });
  }

  return {
    operations,
    remap,
    inverse: {
      blockId: step.blockId,
      inserted: inverseInserted,
      removed: inverseRemoved,
      label: step.label,
    },
  };
}

/** A TEXT_INSERT of N characters occupies N consecutive counters from its first id. */
function expandRun(firstCharId: CharId, length: number): CharId[] {
  const separator = firstCharId.lastIndexOf(":");
  const clientId = firstCharId.slice(0, separator);
  const counter = Number(firstCharId.slice(separator + 1));

  const ids: CharId[] = [];
  for (let i = 0; i < length; i += 1) ids.push(`${clientId}:${counter + i}`);
  return ids;
}

/** The nearest live character to the left of `index`, or null if there is none. */
function previousLiveChar(
  chars: readonly { id: CharId; deleted: boolean }[],
  index: number,
): CharId | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = chars[i]!;
    if (!char.deleted) return char.id;
  }
  return null;
}
