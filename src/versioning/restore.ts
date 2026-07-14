import { render } from "@/crdt/document";
import type { OperationFactory } from "@/crdt/factory";
import { generateKeyBetween } from "@/crdt/fracIndex";
import type { Operation } from "@/crdt/operations";
import type { BlockType, DocumentState, RenderedBlock } from "@/crdt/types";

import { diffDocuments, type DiffableBlock } from "./diff";

/**
 * Restore a version — by moving FORWARD, never by rewinding.
 *
 * This is the single most dangerous feature in a collaborative editor, and the dangerous
 * implementation is the obvious one:
 *
 *      ❌  document.state = version.content
 *
 * That is a whole-document last-write-wins assignment. It silently annihilates every edit any
 * collaborator has in flight, and it cannot converge — two replicas restoring different versions
 * concurrently would end up in different states, permanently, with no error.
 *
 * So instead: **compute the operations that transform the current document into the target, and append
 * them as NEW operations.** History is untouched. The restore merges through the same CRDT as a
 * keystroke — which means a collaborator typing *during* the restore produces one deterministic
 * outcome on every replica, and their words survive.
 *
 * Restore is therefore not a special case in the merge engine. That is exactly why it is safe.
 * (DECISIONS.md D-010.)
 */

export interface SnapshotBlock {
  readonly id: string;
  readonly type: BlockType;
  readonly text: string;
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
}

/** The serialised form stored in the `versions` table. Deliberately plain and forward-compatible. */
export interface DocumentSnapshot {
  readonly version: 1;
  readonly blocks: readonly SnapshotBlock[];
}

export function snapshotOf(state: DocumentState): DocumentSnapshot {
  return {
    version: 1,
    blocks: render(state).map((block) => ({
      id: block.id,
      type: block.type,
      text: block.text,
      attrs: block.attrs,
    })),
  };
}

export function snapshotStats(snapshot: DocumentSnapshot): {
  blockCount: number;
  charCount: number;
} {
  return {
    blockCount: snapshot.blocks.length,
    charCount: snapshot.blocks.reduce((total, block) => total + block.text.length, 0),
  };
}

/**
 * The operations that turn `current` into `target`.
 *
 * The strategy is a block-level diff, then:
 *   - a block in the target that is not in the current document → insert it, with its text;
 *   - a block in the current document that is not in the target → tombstone it;
 *   - a block whose text changed → delete the old characters, insert the new ones.
 *
 * Why re-insert text rather than compute a minimal character-level patch: a minimal patch would need
 * to reason about which *character ids* to keep, and those ids belong to whoever originally typed
 * them. Re-inserting gives the restored text fresh ids authored by the restorer — which is honest
 * (they are re-asserting this text now) and, crucially, cannot resurrect a character another replica
 * has concurrently deleted. A "minimal" patch that revives tombstones is a patch that undoes a
 * collaborator's deletion without anyone asking.
 *
 * The cost: a restore of a large document is a large batch of operations. It is bounded by the
 * document size, it is batched by the sync engine, and it happens when a human clicks a button — not
 * on the typing path.
 */
export function buildRestoreOperations(
  factory: OperationFactory,
  current: DocumentState,
  target: DocumentSnapshot,
): Operation[] {
  const currentBlocks = render(current);

  const before: DiffableBlock[] = currentBlocks.map((block) => ({
    id: block.id,
    type: block.type,
    text: block.text,
  }));
  const after: DiffableBlock[] = target.blocks.map((block) => ({
    id: block.id,
    type: block.type,
    text: block.text,
  }));

  const diff = diffDocuments(before, after);

  // Nothing to do. Restoring to a version identical to the present must emit ZERO operations — not a
  // no-op batch, not a version row full of nothing. Otherwise "restore" becomes a way to spam the
  // operation log, and every restore of an unchanged document grows the history for no reason.
  if (diff.added === 0 && diff.removed === 0 && diff.changed === 0) return [];

  const operations: Operation[] = [];
  const byId = new Map(currentBlocks.map((block) => [block.id, block]));

  /**
   * Walk the diff in target order, maintaining the fractional index of the last block we placed. New
   * blocks are inserted *after* it, so the restored document's block order is reproduced exactly —
   * and, because fractional indices are dense, without renumbering a single existing block.
   */
  let previousFrac: string | null = null;

  for (const entry of diff.blocks) {
    switch (entry.kind) {
      case "removed": {
        operations.push(factory.removeBlock(entry.blockId));
        break;
      }

      case "unchanged": {
        const existing = byId.get(entry.blockId);
        previousFrac = existing?.fracIndex ?? previousFrac;
        break;
      }

      case "changed": {
        const existing = byId.get(entry.blockId);
        if (existing === undefined) break;

        operations.push(...replaceText(factory, existing, entry.text));
        previousFrac = existing.fracIndex;
        break;
      }

      case "added": {
        const snapshotBlock = target.blocks.find((block) => block.id === entry.blockId);

        const fracIndex = generateKeyBetween(previousFrac, null);
        const insert = factory.insertBlock(
          entry.type as BlockType,
          fracIndex,
          (snapshotBlock?.attrs ?? {}) as Record<string, string | number | boolean | null>,
        );
        operations.push(insert);

        const newBlockId = (insert as Extract<Operation, { operationType: "BLOCK_INSERT" }>).payload
          .blockId;

        if (entry.text.length > 0) {
          operations.push(factory.insertText(newBlockId, null, entry.text));
        }

        previousFrac = fracIndex;
        break;
      }
    }
  }

  return operations;
}

/** Replace a block's text: tombstone what is there, insert what should be. */
function replaceText(
  factory: OperationFactory,
  block: RenderedBlock,
  text: string,
): Operation[] {
  const operations: Operation[] = [];

  if (block.charIds.length > 0) {
    operations.push(factory.deleteText(block.id, block.charIds));
  }
  if (text.length > 0) {
    operations.push(factory.insertText(block.id, null, text));
  }

  return operations;
}
