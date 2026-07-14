import type { Operation } from "@/crdt/operations";

/**
 * Two browser tabs of the same document are two replicas on one device.
 *
 * That creates two distinct problems, and they need two distinct mechanisms:
 *
 * **1. They must not both sync.** Two tabs pushing the same outbox means duplicate requests (harmless
 *    — the server is idempotent), duplicate work, and — genuinely dangerous — two writers racing to
 *    advance the same checkpoint. A pull could then skip a page of operations. → **Web Locks**.
 *
 * **2. They must see each other instantly.** Typing in one tab and waiting for a server round trip to
 *    see it in the other would be absurd on the same machine: the operations are already in the same
 *    IndexedDB. → **BroadcastChannel**.
 *
 * Both APIs are ~20 lines each and both degrade cleanly: without Web Locks the tabs both sync (wasteful,
 * still correct — idempotency saves us), and without BroadcastChannel they see each other on the next
 * poll instead of instantly.
 */

const CHANNEL_PREFIX = "vellum:doc:";

export interface CrossTabMessage {
  readonly type: "operations";
  /** Who sent it, so a tab does not process its own broadcast. */
  readonly clientId: string;
  readonly operations: readonly SerializedOperation[];
}

/** `documentVersion` is a bigint, which does not survive `structuredClone` into every browser. */
interface SerializedOperation extends Omit<Operation, "documentVersion"> {
  readonly documentVersion: string;
}

export class CrossTabChannel {
  readonly #channel: BroadcastChannel | null;
  readonly #clientId: string;

  constructor(documentId: string, clientId: string, onOperations: (ops: Operation[]) => void) {
    this.#clientId = clientId;

    // Not available in every runtime (older Safari, some embedded webviews, and Node during SSR). The
    // product must not require it — it is an optimisation, and the HTTP pull is the delivery guarantee.
    if (typeof BroadcastChannel === "undefined") {
      this.#channel = null;
      return;
    }

    this.#channel = new BroadcastChannel(`${CHANNEL_PREFIX}${documentId}`);

    this.#channel.onmessage = (event: MessageEvent<CrossTabMessage>) => {
      const message = event.data;
      if (message.type !== "operations") return;

      // Ignore our own echo. (BroadcastChannel does not deliver to the sender, but a future refactor
      // that moves this into a SharedWorker would — and the CRDT would dedupe it anyway. Cheap to be
      // explicit.)
      if (message.clientId === this.#clientId) return;

      onOperations(
        message.operations.map((op) => ({
          ...op,
          documentVersion: BigInt(op.documentVersion),
        })) as Operation[],
      );
    };
  }

  /** Tell the other tabs about operations authored here. Sub-millisecond; no server involved. */
  post(operations: readonly Operation[]): void {
    if (this.#channel === null || operations.length === 0) return;

    const message: CrossTabMessage = {
      type: "operations",
      clientId: this.#clientId,
      operations: operations.map((op) => ({
        ...op,
        documentVersion: op.documentVersion.toString(),
      })),
    };

    try {
      this.#channel.postMessage(message);
    } catch {
      // A closed channel (the tab is unloading) throws. There is nothing useful to do — the receiving
      // tabs will pull the operations from the server, which is the guarantee anyway.
    }
  }

  close(): void {
    this.#channel?.close();
  }
}

/**
 * Run `fn` while holding the document's sync lock. Only one tab in the browser holds it at a time.
 *
 * If the lock is unavailable the function is **skipped, not queued** — `ifAvailable: true`. That is
 * deliberate: another tab is already syncing this document *right now*, so queueing would just run a
 * redundant sync a moment later against an outbox that tab has already drained. The work is not lost;
 * it was done by someone else.
 *
 * The lock releases automatically when `fn` settles — including if it throws, and including if the tab
 * is killed mid-sync. There is no path that leaks it, which is precisely why this API exists rather
 * than a flag in localStorage (which a crashed tab would leave set forever, permanently wedging every
 * other tab out of syncing).
 */
export async function withSyncLock<T>(
  documentId: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  // Not in Safari before 15.4, and not in Node. Without it, both tabs sync: wasteful, and still
  // correct, because every operation carries an idempotency key.
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    return fn();
  }

  return navigator.locks.request(
    `vellum:sync:${documentId}`,
    { ifAvailable: true },
    async (lock) => {
      // `lock === null` means another tab holds it. Skip.
      if (lock === null) return undefined;
      return fn();
    },
  );
}
