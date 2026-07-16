import type { TokenProvider } from "@/services/transport";

/**
 * The AI client.
 *
 * Consumes the server's Server-Sent Event stream and yields text as it arrives. The user watches the
 * model write — which takes exactly as long as a spinner would, and feels nothing like it.
 *
 * `AbortSignal` is plumbed through deliberately: when the user presses Escape or closes the tab, the
 * server stops pulling tokens from the model. Without it we would keep paying for a generation
 * nobody is going to read.
 */

export type AiAction =
  | "REWRITE"
  | "IMPROVE"
  | "SUMMARIZE"
  | "TRANSLATE"
  | "FIX_GRAMMAR"
  | "CHANGE_TONE"
  | "MEETING_NOTES"
  | "ACTION_ITEMS"
  | "CONTINUE_WRITING"
  | "EXPLAIN"
  | "GENERATE_TITLE"
  | "DOCUMENT_INSIGHTS";

/** Which actions replace the selection, and which produce a panel. MUST match the server's spec. */
export const AI_REPLACES_SELECTION: Record<AiAction, boolean> = {
  REWRITE: true,
  IMPROVE: true,
  TRANSLATE: true,
  FIX_GRAMMAR: true,
  CHANGE_TONE: true,
  // Analysis actions. If `EXPLAIN` were ever flipped to `true`, the model's explanation of a
  // paragraph would *replace the paragraph it was explaining* — a spectacular way to destroy
  // someone's work, and the reason this table exists rather than being inferred at the call site.
  SUMMARIZE: false,
  MEETING_NOTES: false,
  ACTION_ITEMS: false,
  CONTINUE_WRITING: false,
  EXPLAIN: false,
  GENERATE_TITLE: false,
  DOCUMENT_INSIGHTS: false,
};

export interface AiStreamOptions {
  readonly action: AiAction;
  readonly documentId: string;
  readonly content: string;
  readonly prompt?: string;
  readonly signal?: AbortSignal;
}

export class AiClient {
  readonly #baseUrl: string;
  readonly #getToken: TokenProvider;

  constructor(baseUrl: string, getToken: TokenProvider) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#getToken = getToken;
  }

  async *stream(options: AiStreamOptions): AsyncGenerator<string> {
    const token = await this.#getToken();

    let response: Response | null = null;
    try {
      response = await fetch(`${this.#baseUrl}/api/ai/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: options.action,
          documentId: options.documentId,
          content: options.content,
          ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
        }),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (err) {
      console.error("[AI] Fetch failed:", err);
      throw new Error(
        `Failed to connect to AI service: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }

    if (!response.ok) {
      console.error("[AI] Response not OK:", response.status, response.statusText);
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(body?.error?.message ?? `AI request failed with status ${response.status}`);
    }

    if (response.body === null) {
      console.error("[AI] Response body is null");
      throw new Error("AI stream response has no body");
    }

    let reader: ReadableStreamDefaultReader<string> | null = null;
    try {
      reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    } catch (err) {
      console.error("[AI] Failed to create reader:", err);
      throw new Error(
        `Failed to read AI stream: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }

    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;

        // SSE frames are separated by a blank line. A chunk from the network can split a frame in
        // half — parsing per-chunk instead of per-frame would render half a JSON object as text,
        // which is exactly the kind of bug that only appears on a slow connection.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
          if (line === undefined) continue;

          const payload = JSON.parse(line.slice(6)) as {
            type: "delta" | "done" | "error";
            text?: string;
            message?: string;
          };

          if (payload.type === "delta" && payload.text !== undefined) {
            yield payload.text;
          } else if (payload.type === "error") {
            throw new Error(payload.message ?? "the AI request failed");
          } else if (payload.type === "done") {
            return;
          }
        }
      }
    } finally {
      // Releasing the reader cancels the underlying request, which is what tells the *server* to
      // stop generating. Skipping this leaks a stream and burns tokens.
      if (reader !== null) {
        await reader.cancel().catch(() => {});
      }
    }
  }

}
