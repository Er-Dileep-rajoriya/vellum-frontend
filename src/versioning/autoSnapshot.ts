import type { DocumentStore } from "@/services/documentStore";
import type { VersionApi } from "@/services/versionApi";

import { snapshotOf, snapshotStats } from "./restore";

/**
 * Automatic version snapshots.
 *
 * A version history that only contains versions people remembered to name is a version history that is
 * empty on the day someone needs it. So the client snapshots on a cadence, silently.
 *
 * **Every N operations OR every T minutes of activity, whichever comes first**, and only if the document
 * actually changed. Those two triggers cover the two shapes of writing:
 *
 *   - the operation count catches a burst (a 2,000-word paste, a big AI rewrite) that would otherwise
 *     produce a single enormous gap in the history;
 *   - the timer catches a slow, steady session, where 200 operations might take an hour and the user
 *     would have no restore point in between.
 *
 * The snapshot is computed **client-side** — the server does not run the CRDT (D-001), so it cannot fold
 * an operation log into a document. That is also why this is safe to do from any replica: a snapshot is
 * a *cache*, the oplog is the truth, and any client can rebuild and check one by replaying.
 */

/** A burst — a large paste, an AI rewrite — should not leave a hole in the timeline. */
const EVERY_OPERATIONS = 200;

/** A slow session should still get restore points. */
const EVERY_MS = 5 * 60 * 1_000;

export interface AutoSnapshotOptions {
  readonly store: DocumentStore;
  readonly api: VersionApi;
  readonly documentId: string;
  /** VIEWERs cannot write a version; do not even try, or every tick is a 403 in the log. */
  readonly enabled: boolean;
}

export class AutoSnapshot {
  readonly #options: AutoSnapshotOptions;

  #operationsSinceSnapshot = 0;
  #lastSnapshotAt = Date.now();
  #timer: number | null = null;
  #inflight = false;
  #disposed = false;

  constructor(options: AutoSnapshotOptions) {
    this.#options = options;
  }

  start(): void {
    if (!this.#options.enabled || this.#disposed) return;

    // A minute is the resolution, not the cadence: the tick is cheap (it usually decides to do nothing)
    // and it means the 5-minute rule is honoured within a minute rather than up to 5 minutes late.
    this.#timer = window.setInterval(() => void this.#maybeSnapshot("timer"), 60_000);
  }

  /** Called for every locally-authored operation. Cheap: it increments a number. */
  onOperations(count: number): void {
    if (!this.#options.enabled || this.#disposed) return;

    this.#operationsSinceSnapshot += count;

    if (this.#operationsSinceSnapshot >= EVERY_OPERATIONS) {
      void this.#maybeSnapshot("operations");
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) window.clearInterval(this.#timer);
  }

  async #maybeSnapshot(reason: "timer" | "operations"): Promise<void> {
    if (this.#disposed || this.#inflight) return;

    // Nothing has changed. Snapshotting an unchanged document would fill the timeline with identical
    // entries, which makes the history *worse* — a list of a hundred "Autosaved" rows that all say the
    // same thing is a list nobody scrolls through to find the one that matters.
    if (this.#operationsSinceSnapshot === 0) return;

    if (reason === "timer" && Date.now() - this.#lastSnapshotAt < EVERY_MS) return;

    this.#inflight = true;

    try {
      const state = this.#options.store.state;
      const snapshot = snapshotOf(state);
      const stats = snapshotStats(snapshot);

      await this.#options.api.create(this.#options.documentId, {
        kind: "AUTO",
        content: snapshot,
        // The watermark this snapshot is a fold of. The server rejects one that claims a position the
        // log has not reached — see version.repository.ts.
        serverSeq: state.serverSeq.toString(),
        blockCount: stats.blockCount,
        charCount: stats.charCount,
      });

      this.#operationsSinceSnapshot = 0;
      this.#lastSnapshotAt = Date.now();
    } catch {
      /**
       * Offline, or the server said no. Do **not** reset the counter.
       *
       * The work is not lost: the operations are still in the outbox and the document is still on this
       * device. Keeping the counter means the snapshot is retried on the next tick, once we are back —
       * and resetting it would mean the user's whole offline session silently produced no restore point
       * at all, which is exactly when they are most likely to want one.
       */
    } finally {
      this.#inflight = false;
    }
  }
}
