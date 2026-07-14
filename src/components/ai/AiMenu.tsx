"use client";

import { Loader2, Sparkles, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import type { RenderedBlock } from "@/crdt/types";
import type { Selection } from "@/editor/inputMapper";
import { cn } from "@/lib/utils";
import { AI_REPLACES_SELECTION, AiClient, type AiAction } from "@/services/aiClient";
import type { DocumentStore } from "@/services/documentStore";
import type { TokenProvider } from "@/services/transport";

/**
 * The AI menu.
 *
 * The important line in this file is the one that applies the result:
 *
 *     store.applyLocal([factory.deleteText(...), factory.insertText(...)])
 *
 * The AI's output goes through the SAME `OperationFactory` as a keystroke. It is not written into
 * document state; it is *typed* into it, as operations. That single decision is why an AI edit is
 * undoable, offline-capable, mergeable with a collaborator's concurrent typing, versioned, and
 * audited — with no code anywhere that special-cases "an edit that came from the AI".
 * (DECISIONS.md D-014.)
 */

const QUICK_ACTIONS: ReadonlyArray<{ action: AiAction; label: string; needsPrompt?: string }> = [
  { action: "IMPROVE", label: "Improve writing" },
  { action: "FIX_GRAMMAR", label: "Fix grammar" },
  { action: "REWRITE", label: "Rewrite", needsPrompt: "How should it be rewritten?" },
  { action: "CHANGE_TONE", label: "Change tone", needsPrompt: "Which tone? (e.g. formal, warm)" },
  { action: "TRANSLATE", label: "Translate", needsPrompt: "Into which language?" },
  { action: "SUMMARIZE", label: "Summarise" },
  { action: "EXPLAIN", label: "Explain" },
  { action: "ACTION_ITEMS", label: "Extract action items" },
  { action: "CONTINUE_WRITING", label: "Continue writing" },
];

export interface AiMenuProps {
  readonly store: DocumentStore;
  readonly documentId: string;
  readonly block: RenderedBlock;
  readonly selection: Selection;
  readonly apiUrl: string;
  readonly getToken: TokenProvider;
  readonly onClose: () => void;
}

export function AiMenu({
  store,
  documentId,
  block,
  selection,
  apiUrl,
  getToken,
  onClose,
}: AiMenuProps) {
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: AiAction; question: string } | null>(null);
  const [promptText, setPromptText] = useState("");
  const [lastAction, setLastAction] = useState<AiAction | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const selectedText =
    selection.selected.length > 0
      ? selection.selected
          .map((charId) => block.text[block.charIds.indexOf(charId)] ?? "")
          .join("")
      : block.text;

  const run = useCallback(
    async (action: AiAction, prompt?: string) => {
      setBusy(true);
      setError(null);
      setOutput("");
      setLastAction(action);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const client = new AiClient(apiUrl, getToken);
        let accumulated = "";

        for await (const delta of client.stream({
          action,
          documentId,
          content: selectedText,
          ...(prompt !== undefined ? { prompt } : {}),
          signal: controller.signal,
        })) {
          accumulated += delta;
          // Render as it arrives. The user watches the model write — same wall-clock time as a
          // spinner, an entirely different experience.
          setOutput(accumulated);
        }
      } catch (caught) {
        if (controller.signal.aborted) return; // the user cancelled; not an error
        setError(caught instanceof Error ? caught.message : "the AI request failed");
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [apiUrl, documentId, getToken, selectedText],
  );

  /**
   * Accept the suggestion.
   *
   * A replacing action (rewrite, translate) deletes the selected characters and inserts the new text
   * at the same anchor. An analysis action (summarise, action items) appends below instead — it must
   * NOT eat the paragraph it was analysing.
   *
   * Both paths emit ordinary CRDT operations. If a collaborator is typing in this block right now,
   * their characters and these merge, deterministically, exactly as two humans typing would.
   */
  const accept = useCallback(() => {
    if (output === "" || lastAction === null) return;

    const factory = store.factory;
    const replaces = AI_REPLACES_SELECTION[lastAction];

    if (replaces && selection.selected.length > 0) {
      store.applyLocal([
        factory.deleteText(block.id, selection.selected),
        factory.insertText(block.id, selection.anchor, output),
      ]);
    } else {
      // Append at the end of the block. `\n` would be a character in the text, not a new block, so
      // the separator is a space — the user can split it themselves if they want two paragraphs.
      const lastChar = block.charIds[block.charIds.length - 1] ?? null;
      store.applyLocal([factory.insertText(block.id, lastChar, `\n${output}`)]);
    }

    onClose();
  }, [output, lastAction, store, block, selection, onClose]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="AI assistant"
      className="w-[28rem] rounded-xl border border-border bg-popover p-3 shadow-xl"
    >
      <header className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          AI
        </h2>
        <button
          type="button"
          onClick={cancel}
          aria-label="Close"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      {pending !== null && (
        <form
          className="mb-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = promptText.trim();
            if (value === "") return;
            void run(pending.action, value);
            setPending(null);
            setPromptText("");
          }}
        >
          <input
            autoFocus
            value={promptText}
            onChange={(event) => setPromptText(event.target.value)}
            placeholder={pending.question}
            aria-label={pending.question}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-foreground/20"
          />
          <button
            type="submit"
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            Go
          </button>
        </form>
      )}

      {output === "" && !busy && pending === null && (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto">
          {QUICK_ACTIONS.map((item) => (
            <li key={item.action}>
              <button
                type="button"
                onClick={() => {
                  if (item.needsPrompt !== undefined) {
                    setPending({ action: item.action, question: item.needsPrompt });
                  } else {
                    void run(item.action);
                  }
                }}
                className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {(busy || output !== "") && (
        <div className="space-y-3">
          <div
            aria-live="polite"
            className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-sm leading-relaxed"
          >
            {output}
            {busy && (
              // A caret that blinks while the model writes. Small, and it is the difference between
              // "the app is thinking" and "the app has frozen".
              <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-foreground align-middle" />
            )}
          </div>

          {!busy && output !== "" && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={accept}
                className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                {lastAction !== null && AI_REPLACES_SELECTION[lastAction] ? "Replace" : "Insert below"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOutput("");
                  setLastAction(null);
                }}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                Discard
              </button>
            </div>
          )}

          {busy && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Stop
            </button>
          )}
        </div>
      )}

      {error !== null && (
        <p role="alert" className={cn("mt-2 text-xs text-destructive")}>
          {error}
        </p>
      )}
    </div>
  );
}
