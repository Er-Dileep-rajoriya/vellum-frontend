import { applyTo, Draft, emptyDocument, type MissingDependency } from "./document";
import type { Operation } from "./operations";
import type { DocumentState } from "./types";

/**
 * A replica: a document state plus the buffer of operations that cannot be applied yet.
 *
 * This is the layer that makes delivery order irrelevant. `apply()` in document.ts is a pure
 * function that either applies an operation or reports what it is missing; `Replica` is what turns
 * that into a system where operations can arrive over a WebSocket, out of a pull, from another tab,
 * twice, in any order, and still converge.
 */

const MAX_PENDING_OPERATIONS = 10_000;

export interface IngestResult {
  /** Operations applied to the state, in the order they were applied (including drained ones). */
  readonly applied: readonly Operation[];
  readonly pendingCount: number;
  /**
   * True when the pending buffer overflowed and the replica gave up on incremental reconciliation.
   * The caller must resync from a snapshot. See below for why this is a feature.
   */
  readonly needsResync: boolean;
}

export class Replica {
  #state: DocumentState;

  /**
   * Operations waiting on a dependency, indexed by the id of the thing they are waiting FOR.
   *
   * Indexing by the missing dependency (rather than keeping a flat list to rescan) is what makes the
   * drain O(dependents) instead of O(buffer) per applied operation. With a flat list, a client
   * returning from an hour offline — thousands of buffered operations — would rescan the entire
   * buffer after every single apply, and the reconnect would take minutes of pegged CPU.
   */
  readonly #pending = new Map<string, Operation[]>();
  #pendingCount = 0;

  /**
   * Every operation id this replica has applied — the idempotence guarantee, in one Set.
   *
   * This lives on the Replica rather than inside `DocumentState` for two reasons (see the note on
   * `DocumentState`): duplicate delivery is a property of the *network*, not of the document, and a
   * set that grows with every operation ever applied must never be copied on a keystroke. Here it is
   * mutated in place — O(1) per operation, forever — because the Replica is explicitly the stateful
   * object in this design and the document value it holds is the pure one.
   *
   * Every ingress — WebSocket broadcast, HTTP pull, cross-tab BroadcastChannel, local edit — funnels
   * through `ingest()`, so this is the only gate a duplicate can arrive at, and it is closed.
   */
  readonly #applied = new Set<string>();

  /**
   * A replica is normally built empty and fed its history through `ingest()` — that is what populates
   * the dedup set alongside the state.
   *
   * The optional seed state exists for tests that want to start from a known document. It comes with a
   * constraint: the dedup set starts EMPTY, so re-delivering an operation that is already folded into
   * the seed would apply it a second time. Never seed a replica with a state derived from operations
   * that can still arrive over the wire — hydrate by replaying them instead.
   */
  constructor(state: DocumentState = emptyDocument()) {
    this.#state = state;
  }

  get state(): DocumentState {
    return this.#state;
  }

  get pendingCount(): number {
    return this.#pendingCount;
  }

  /**
   * Ingest operations. Applies what it can, buffers what it cannot, and drains the buffer
   * transitively — an insert landing can unblock a delete that was waiting on it, which can unblock
   * a mark that was waiting on the delete, and so on.
   */
  /**
   * ONE draft for the whole batch — including everything the drain unblocks.
   *
   * The batch is the unit of work the state copy is paid for. Applying operations one at a time, each
   * producing its own fresh state, meant a 1,000-operation catch-up copied the blocks Map 1,000 times
   * and the touched block's character array 1,000 times at growing length. That is quadratic, and it
   * lands on the paths where the user is already waiting: first load, reconnect after a flight, an AI
   * rewrite, a version restore.
   *
   * Nothing about the merge semantics changes — the same operations are folded in the same order with
   * the same rules. The only difference is that the intermediate states are never handed to anyone, so
   * they need not exist. The single new state escapes at `commit()`, and untouched blocks are still
   * shared by reference with the previous one.
   */
  ingest(operations: readonly Operation[]): IngestResult {
    const applied: Operation[] = [];
    const draft = new Draft(this.#state);

    for (const op of operations) {
      // Not an error, and not rare. A duplicate is the single most common non-applied outcome in
      // normal operation: a WebSocket broadcast and an HTTP pull delivering the same operation, which
      // is a race the design deliberately permits rather than prevents.
      if (this.#applied.has(op.operationId)) continue;

      const result = applyTo(draft, op);

      switch (result.status) {
        case "applied":
          this.#applied.add(op.operationId);
          applied.push(op);
          this.#drain(draft, op, applied);
          break;

        case "pending":
          if (!this.#buffer(op, result.missing)) {
            // Overflow. Commit what was applied before giving up — those operations really were folded
            // into the draft, and throwing the draft away here would silently lose them while telling
            // the caller they had been applied.
            this.#state = draft.commit(this.#state);
            return { applied, pendingCount: this.#pendingCount, needsResync: true };
          }
          break;
      }
    }

    this.#state = draft.commit(this.#state);
    return { applied, pendingCount: this.#pendingCount, needsResync: false };
  }

  #buffer(op: Operation, missing: MissingDependency): boolean {
    /**
     * The overflow rule.
     *
     * An unbounded pending buffer is an OOM waiting for a bad network. But the deeper reason for the
     * cap: a buffer this large means the replica has lost so much causal history that incremental
     * reconciliation is no longer the cheap path — refetching a snapshot is. So overflow is not a
     * failure to be prevented, it is a *signal* to switch strategies, and the honest response is to
     * say so rather than to grind.
     *
     * Nothing is lost when this fires: the client's own unsynced operations live in its outbox, not
     * in this buffer, and they are replayed on top of the fresh snapshot. They are CRDT operations,
     * so they merge.
     */
    if (this.#pendingCount >= MAX_PENDING_OPERATIONS) {
      return false;
    }

    const key = `${missing.kind}:${missing.id}`;
    const waiting = this.#pending.get(key);
    if (waiting === undefined) {
      this.#pending.set(key, [op]);
    } else {
      // A duplicate arriving while its twin is already buffered would otherwise be applied twice on
      // drain — harmless (apply is idempotent), but it would inflate the buffer without bound under
      // a retry storm, which is the exact condition the cap above is defending against.
      if (waiting.some((existing) => existing.operationId === op.operationId)) return true;
      waiting.push(op);
    }
    this.#pendingCount += 1;
    return true;
  }

  /**
   * An operation just landed. Anything waiting on what it provides can now be retried — and anything
   * waiting on *those* can be retried in turn, transitively.
   *
   * The work list is a queue rather than recursion: a long chain of dependent inserts (a paste of a
   * paragraph delivered in reverse) would otherwise blow the stack, and "the app crashes when you
   * paste while offline on a bad connection" is precisely the kind of bug that never shows up in
   * development and always shows up in production.
   */
  #drain(draft: Draft, trigger: Operation, applied: Operation[]): void {
    const queue: string[] = this.#keysProvidedBy(trigger);

    while (queue.length > 0) {
      const key = queue.shift()!;
      const waiting = this.#pending.get(key);
      if (waiting === undefined) continue;

      this.#pending.delete(key);
      this.#pendingCount -= waiting.length;

      for (const op of waiting) {
        // A duplicate can be buffered twice under two different missing dependencies and drained
        // twice — the check has to be here as well, not only at ingest.
        if (this.#applied.has(op.operationId)) continue;

        const result = applyTo(draft, op);

        switch (result.status) {
          case "applied":
            this.#applied.add(op.operationId);
            applied.push(op);
            queue.push(...this.#keysProvidedBy(op));
            break;

          case "pending":
            // It unblocked one dependency and is now waiting on a different one. Re-buffer under the
            // new key. (A TEXT_DELETE naming five characters waits on them one at a time.)
            this.#buffer(op, result.missing);
            break;
        }
      }
    }
  }

  /** The dependency keys an operation satisfies once applied. */
  #keysProvidedBy(op: Operation): string[] {
    switch (op.operationType) {
      case "BLOCK_INSERT":
        return [`block:${op.payload.blockId}`];

      case "TEXT_INSERT": {
        // A run of N characters provides N ids: `charId` is only the first, and a delete or a mark
        // could be waiting on any of them. Missing this is how an operation gets stranded in the
        // buffer forever while the character it wants sits, applied, right there in the document.
        const { clientId, counter } = parseId(op.payload.charId);
        const keys: string[] = [];
        for (let i = 0; i < op.payload.value.length; i += 1) {
          keys.push(`char:${clientId}:${counter + i}`);
        }
        return keys;
      }

      default:
        return [];
    }
  }
}

function parseId(charId: string): { clientId: string; counter: number } {
  const separator = charId.lastIndexOf(":");
  return {
    clientId: charId.slice(0, separator),
    counter: Number(charId.slice(separator + 1)),
  };
}
