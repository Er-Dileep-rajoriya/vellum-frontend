import type { Operation } from "@/crdt/operations";
import { deserializeOperation } from "@/services/transport";
import { backoffDelay, DEFAULT_BACKOFF } from "@/sync-engine/backoff";

/**
 * The realtime client.
 *
 * Its most important property is that **nothing depends on it**. If the socket never connects — a
 * corporate proxy blocking `wss://`, a captive portal, the relay being down — the document still
 * syncs over HTTP, and the only thing the user loses is latency: collaborators' edits arrive on the
 * next poll instead of in 50ms.
 *
 * That is why this class has no error handling that surfaces to the user, no "reconnect failed" modal,
 * and no ability to block the editor. It reconnects quietly forever, and the sync engine — which is
 * the thing that actually guarantees delivery — carries on regardless.
 */

export interface Peer {
  readonly userId: string;
  readonly clientId: string;
  readonly name: string | null;
  readonly color: string;
  readonly blockId: string | null;
  readonly anchor: string | null;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface CollaborationClientOptions {
  readonly url: string;
  readonly documentId: string;
  readonly clientId: string;
  readonly getToken: () => Promise<string>;
  readonly onOperations: (operations: Operation[]) => void;
  readonly onPeers: (peers: Peer[]) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
}

export class CollaborationClient {
  readonly #options: CollaborationClientOptions;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #reconnectTimer: number | null = null;
  #disposed = false;
  /** The last caret this client published, resent on every (re)connect. Presence is state, not an event. */
  #presence: { blockId: string | null; anchor: string | null } | null = null;

  constructor(options: CollaborationClientOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#disposed || this.#socket !== null) return;

    this.#options.onStatus("connecting");

    let token: string;
    try {
      token = await this.#options.getToken();
    } catch {
      // No session, or the token endpoint is down. Not fatal — HTTP sync is also failing, and the
      // editor keeps working locally. Retry on the same backoff schedule as everything else.
      this.#scheduleReconnect();
      return;
    }

    if (this.#disposed) return;

    const url = new URL(this.#options.url);
    url.searchParams.set("token", token);
    url.searchParams.set("clientId", this.#options.clientId);

    const socket = new WebSocket(url.toString());
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#options.onStatus("connected");
      this.#send({ type: "join", documentId: this.#options.documentId });

      /**
       * Republish the caret on every (re)connect.
       *
       * Presence is state, not an event, and this is the difference. `setPresence` can only send when
       * the socket is open, and a caret does not move on a schedule — so a presence update that is
       * dropped is dropped *for as long as the user holds still*, which for a reader is forever.
       *
       * Two ordinary things produce exactly that: opening a document and clicking into it before the
       * socket has finished handshaking (a few hundred milliseconds — and people are faster than that),
       * and any reconnect, where the server's roster for this client starts empty again. In both cases
       * the user is sitting in a paragraph, visible to nobody, and nothing will fix it until they
       * happen to move. A flaky E2E is what exposed it, but the bug was the product's, not the test's.
       *
       * Sending the last known caret at join makes presence converge on reconnect rather than depend on
       * the user doing something.
       */
      if (this.#presence !== null) {
        this.#send({
          type: "presence",
          documentId: this.#options.documentId,
          blockId: this.#presence.blockId,
          anchor: this.#presence.anchor,
        });
      }
    });

    socket.addEventListener("message", (event: MessageEvent<string>) => {
      this.#handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      this.#socket = null;
      this.#options.onStatus("disconnected");
      this.#scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // `error` is always followed by `close`, and the event itself carries no useful detail (the spec
      // deliberately withholds it to avoid leaking cross-origin information). Reconnection is handled
      // in `close`; doing it here too would double-schedule.
    });
  }

  /**
   * Push operations over the socket.
   *
   * Returns `false` if the socket is not open, and the caller does NOTHING about it — because the sync
   * engine is already going to push these over HTTP. The socket is a fast path, not the delivery
   * guarantee, and treating a closed socket as a failure would turn a latency optimisation into a
   * source of errors.
   */
  push(operations: readonly Operation[]): boolean {
    if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) return false;

    this.#send({
      type: "ops",
      documentId: this.#options.documentId,
      clientId: this.#options.clientId,
      operations: operations.map((op) => ({
        operationId: op.operationId,
        clientId: op.clientId,
        logicalClock: op.logicalClock,
        timestamp: new Date(op.timestamp).toISOString(),
        documentVersion: op.documentVersion.toString(),
        operationType: op.operationType,
        payload: op.payload,
      })),
    });

    return true;
  }

  /**
   * Publish the caret position. Ephemeral — never persisted, never an operation.
   *
   * The position is *remembered* even when it cannot be sent, so a socket that is still connecting (or
   * has just dropped) delays the update rather than losing it — see the republish on `open`.
   */
  setPresence(blockId: string | null, anchor: string | null): void {
    this.#presence = { blockId, anchor };

    if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) return;

    this.#send({
      type: "presence",
      documentId: this.#options.documentId,
      blockId,
      anchor,
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer);
    this.#socket?.close(1000, "client disposed");
    this.#socket = null;
  }

  #handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // a frame we cannot parse is a frame we ignore; the server is not a trusted parser input
    }

    if (typeof message !== "object" || message === null || !("type" in message)) return;

    const typed = message as { type: string; [key: string]: unknown };

    switch (typed.type) {
      case "ops": {
        const rows = typed["operations"];
        if (!Array.isArray(rows)) return;

        // Operations arriving here are idempotent and are deduplicated by the CRDT. A broadcast that
        // races the HTTP pull delivering the same operation is not a bug to be prevented — it is the
        // normal case, made harmless by construction.
        this.#options.onOperations(rows.map((row) => deserializeOperation(row as never)));
        return;
      }

      case "presence":
      case "joined": {
        const peers = typed["peers"];
        if (Array.isArray(peers)) {
          this.#options.onPeers(peers as Peer[]);
        }
        return;
      }

      case "error":
        // The socket's errors are advisory. A FORBIDDEN here means this user cannot write to this
        // document, which the HTTP path will report properly (and durably, into the dead-letter queue).
        // Duplicating that reporting here would show the user two error messages for one problem.
        return;

      default:
        return;
    }
  }

  #send(message: unknown): void {
    if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }

  #scheduleReconnect(): void {
    if (this.#disposed) return;
    if (this.#reconnectTimer !== null) return;

    // The same exponential backoff with full jitter as the sync engine, and for the same reason: when
    // the relay restarts, every client in the fleet is disconnected at the same instant. Without jitter
    // they would all reconnect at the same instant too, and knock it over again.
    const delay = backoffDelay(this.#attempt, DEFAULT_BACKOFF);
    this.#attempt += 1;

    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
