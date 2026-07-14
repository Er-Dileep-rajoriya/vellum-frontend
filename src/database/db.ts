import Dexie, { type EntityTable } from "dexie";

import type { Operation } from "@/crdt/operations";

/**
 * The local database. IndexedDB, via Dexie.
 *
 * This is the source of truth for the *user*. The server is a replica that happens to be shared.
 * (ARCHITECTURE.md §4, DECISIONS.md D-008.)
 *
 * The critical property: nothing on the keystroke path awaits this. IndexedDB writes take
 * 1–15ms — a whole frame budget, sometimes several — so a design that persists synchronously on each
 * keystroke is a design that jitters exactly when the user is typing fastest. Operations are appended
 * to an in-memory buffer and flushed on idle, every 250ms, and forcibly on `pagehide`. The worst case
 * on a hard kill is the loss of the last ≤250ms of typing; blocking every keystroke on a disk write
 * to avoid that is the wrong trade, and it is the trade every laggy "local-first" demo has made.
 */

/** An operation as stored locally, before and after it reaches the server. */
export interface StoredOperation {
  /** ULID. Primary key. Same id the server uses — so a local op and its ack are the same row. */
  operationId: string;
  documentId: string;
  /** Monotonic local sequence. Preserves authoring order in the outbox independently of the ULID. */
  localSeq: number;
  operation: Operation;
  /**
   * Null until the server acknowledges. This single field IS the outbox: `synced === null` means
   * "not yet durable anywhere but this device".
   */
  serverSeq: string | null;
  createdAt: number;
}

/** Per-document sync cursor. The one thing needed to resume from anywhere, after any interruption. */
export interface Checkpoint {
  documentId: string;
  /** Highest serverSeq folded into the local snapshot. `pull?since=` sends exactly this. */
  lastServerSeq: string;
  /** The replica's Lamport clock. Restarting this at zero would mint duplicate character ids. */
  clock: number;
  updatedAt: number;
}

/** A materialised CRDT snapshot, so opening a 200k-operation document is O(1) rather than O(n). */
export interface LocalSnapshot {
  documentId: string;
  /** Serialised DocumentState. Rebuilt from operations if absent or corrupt — it is a cache. */
  state: string;
  serverSeq: string;
  updatedAt: number;
}

/**
 * The client-side dead-letter queue.
 *
 * Operations the server will never accept (malformed, forbidden, too large). They are NOT silently
 * dropped: silently discarding a user's writes is the worst failure this system can have, so they are
 * kept, surfaced in the UI, and exportable. Loss must be loud.
 */
export interface DeadLetter {
  operationId: string;
  documentId: string;
  operation: Operation;
  code: string;
  message: string;
  attempts: number;
  failedAt: number;
}

/** Document metadata, cached so the app shell renders instantly offline. */
export interface LocalDocument {
  id: string;
  title: string;
  role: "OWNER" | "EDITOR" | "VIEWER";
  updatedAt: number;
  deletedAt: number | null;
}

export class VellumDatabase extends Dexie {
  operations!: EntityTable<StoredOperation, "operationId">;
  checkpoints!: EntityTable<Checkpoint, "documentId">;
  snapshots!: EntityTable<LocalSnapshot, "documentId">;
  deadLetters!: EntityTable<DeadLetter, "operationId">;
  documents!: EntityTable<LocalDocument, "id">;

  constructor() {
    super("vellum");

    this.version(1).stores({
      // `[documentId+localSeq]` is the outbox scan: unsynced operations for one document, in
      // authoring order. `serverSeq` is indexed so "what have I not synced?" is an index range scan
      // rather than a full table walk — that query runs on every sync tick, forever.
      operations: "operationId, documentId, [documentId+localSeq], [documentId+serverSeq], serverSeq",
      checkpoints: "documentId",
      snapshots: "documentId",
      deadLetters: "operationId, documentId, failedAt",
      documents: "id, updatedAt, deletedAt",
    });
  }
}

export const db = new VellumDatabase();

/**
 * The replica's identity — **one per TAB**, not one per device.
 *
 * This lives in `sessionStorage`, and the distinction is not cosmetic. It was `localStorage` first,
 * and that was a real bug that a two-tab E2E test caught:
 *
 *    A `clientId` is the namespace for character ids (`<clientId>:<counter>`). Two tabs sharing one
 *    clientId share one namespace — and they each keep their own in-memory Lamport counter. So both
 *    tabs happily mint `abc123:42`, for **two different characters**.
 *
 *    Two distinct characters with one identity is not a merge conflict. It is the end of the CRDT's
 *    ability to reason about anything: `findCharIndex` returns the wrong node, an insert anchors to a
 *    character that is not the one it meant, and the document quietly corrupts. No error, no crash.
 *
 * A tab IS a replica. It gets its own id.
 *
 * `sessionStorage` is exactly right for that: it is scoped to the tab, and it **survives a reload** —
 * which matters, because a replica that changed its identity on every refresh would orphan its own
 * unsynced operations in the outbox and fragment its own clock.
 */
const CLIENT_ID_KEY = "vellum.clientId";

export function getClientId(): string {
  if (typeof window === "undefined") {
    // Server components must never mint a replica id — a replica that exists for one render and then
    // vanishes would burn a clientId namespace on every request.
    throw new Error("getClientId() is client-only");
  }

  const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
  if (existing !== null && existing !== "") return existing;

  const clientId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  window.sessionStorage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}
