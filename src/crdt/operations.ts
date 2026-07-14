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
 * The operation.
 *
 * Every mutation in the system — a keystroke, a paste, an AI rewrite, a version restore — is one of
 * these. There is deliberately no "set document content" operation: a whole-document set is
 * last-writer-wins wearing a costume, and it would silently annihilate a concurrent collaborator's
 * work. If it cannot be expressed as one of the seven operations below, it does not happen.
 */

export interface OperationBase {
  /** ULID. Globally unique, lexicographically time-sortable. THE idempotency key. */
  readonly operationId: string;
  readonly clientId: ClientId;
  /** Lamport counter. Orders causally-related operations; breaks register ties. */
  readonly logicalClock: number;
  /** Authoring time. For the UI and the audit log. NEVER used in a merge decision. */
  readonly timestamp: number;
  /** The serverSeq this replica had seen when it authored. Measures divergence; never rejects. */
  readonly documentVersion: bigint;
}

export type Operation =
  | (OperationBase & {
      operationType: "BLOCK_INSERT";
      payload: {
        blockId: BlockId;
        blockType: BlockType;
        fracIndex: string;
        attrs: Record<string, AttrValue>;
      };
    })
  | (OperationBase & { operationType: "BLOCK_REMOVE"; payload: { blockId: BlockId } })
  | (OperationBase & {
      operationType: "BLOCK_MOVE";
      payload: { blockId: BlockId; fracIndex: string };
    })
  | (OperationBase & {
      operationType: "BLOCK_SET_ATTRS";
      payload: { blockId: BlockId; attrs: Record<string, AttrValue>; blockType?: BlockType };
    })
  | (OperationBase & {
      operationType: "TEXT_INSERT";
      payload: {
        blockId: BlockId;
        /**
         * The id of the FIRST character in the run. The rest take consecutive counters from the same
         * clientId, so a 40-character paste is one operation, not forty — and the run's internal
         * order is implied rather than transmitted.
         */
        charId: CharId;
        /** The RGA origin: the character this run is anchored after. `null` = start of block. */
        originLeft: CharId | null;
        value: string;
      };
    })
  | (OperationBase & {
      operationType: "TEXT_DELETE";
      payload: { blockId: BlockId; charIds: readonly CharId[] };
    })
  | (OperationBase & {
      operationType: "MARK_SET";
      payload: {
        blockId: BlockId;
        charIds: readonly CharId[];
        mark: MarkType;
        value: MarkValue;
      };
    });

export type OperationType = Operation["operationType"];

/** An operation as it comes back from the server, with its committed position in the total order. */
export interface CommittedOperation {
  readonly operation: Operation;
  readonly serverSeq: bigint;
  readonly userId: string;
}
