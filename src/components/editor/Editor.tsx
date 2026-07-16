"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Operation } from "@/crdt/operations";
import type { MarkType, RenderedBlock } from "@/crdt/types";
import {
  collapsed,
  deleteBackward,
  deleteForward,
  insertBlockAfter,
  insertText,
  selectionFromOffsets,
  setBlockType,
  splitBlock,
  toggleMark,
  type EditorContext,
  type Selection,
} from "@/editor/inputMapper";
import { History } from "@/editor/history";
import { matchInlineShortcut, matchShortcut } from "@/editor/markdown";
import type { DocumentStore } from "@/services/documentStore";

import type { Peer } from "@/collaboration/wsClient";
import { AiMenu } from "@/components/ai/AiMenu";
import type { TokenProvider } from "@/services/transport";

import { BlockView } from "./BlockView";
import { RemoteCursors } from "./RemoteCursors";
import { SelectionToolbar } from "./SelectionToolbar";
import { SlashMenu } from "./SlashMenu";

/**
 * The editor.
 *
 * Every keystroke follows the same path, and there are no exceptions to it:
 *
 *    beforeinput → preventDefault() → read the DOM selection → map to CRDT operations →
 *    apply locally (synchronously, on screen) → hand to the sync engine (async, off the hot path)
 *
 * The `preventDefault()` is the whole design. The browser never mutates the document; it only reports
 * what the user *wanted*. We decide what happens. That is what makes the CRDT — not the DOM — the
 * source of truth, and it is why a collaborator's edit landing mid-keystroke cannot corrupt anything.
 */

export interface EditorProps {
  readonly store: DocumentStore;
  readonly blocks: readonly RenderedBlock[];
  readonly readOnly: boolean;
  readonly documentId: string;
  readonly apiUrl: string;
  readonly getToken: TokenProvider;
  readonly peers: readonly Peer[];
  /** Publish this replica's caret. Ephemeral: never persisted, never an operation. */
  readonly onPresence: (blockId: string | null, anchor: string | null) => void;
}

interface SlashState {
  readonly blockId: string;
  readonly query: string;
  /** Captured at open time, in an event handler — never read from a ref during render. */
  readonly anchor: HTMLElement | null;
}

/**
 * How often a caret may be broadcast. ~7 frames a second per person: fast enough to read as live,
 * slow enough that ten people in a document do not saturate the socket with cursor positions.
 */
const PRESENCE_THROTTLE_MS = 150;

export function Editor({
  store,
  blocks,
  readOnly,
  documentId,
  apiUrl,
  getToken,
  peers,
  onPresence,
}: EditorProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  /** When the caret was last broadcast. Drives the throttle's leading edge. */
  const lastPresenceAt = useRef(0);
  const [aiTarget, setAiTarget] = useState<{ blockId: string; selection: Selection } | null>(null);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  /** The live bounding rect of a non-empty selection, for positioning the bubble toolbar. */
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);

  const elements = useRef(new Map<string, HTMLElement>());

  /**
   * Ordinals for numbered-list blocks — `1.`, `2.`, `3.`, restarting after any non-numbered block.
   *
   * Computed here (where the whole ordered list of blocks is known) rather than in BlockView (which
   * sees one block and could not count its predecessors). Memoised on `blocks`, so it recomputes only
   * when the document structure changes, not on every keystroke inside a paragraph.
   */
  const ordinals = useMemo(() => {
    const map = new Map<string, number>();
    let counter = 0;
    for (const block of blocks) {
      if (block.type === "numberedList") {
        counter += 1;
        map.set(block.id, counter);
      } else {
        counter = 0;
      }
    }
    return map;
  }, [blocks]);

  /**
   * Undo history — LOCAL-ORIGIN ONLY.
   *
   * Ctrl+Z reverts *your* last edit, never the document's last operation. Undoing whatever happened
   * most recently would, in a shared document, revert your colleague's sentence while their cursor was
   * sitting in it. (See editor/history.ts, and the test that pins it.)
   */
  const history = useRef(new History());

  const registerRef = useCallback((blockId: string, element: HTMLElement | null) => {
    if (element === null) elements.current.delete(blockId);
    else elements.current.set(blockId, element);
  }, []);

  /** Read the live DOM selection and translate it into character ids. */
  const readSelection = useCallback(
    (block: RenderedBlock): Selection => {
      const element = elements.current.get(block.id);
      const domSelection = window.getSelection();

      if (element === undefined || domSelection === null || domSelection.rangeCount === 0) {
        return collapsed(block.id, null);
      }

      const range = domSelection.getRangeAt(0);
      // The offsets are read here and converted immediately. They never escape this function: the rest
      // of the editor speaks only in character ids, because an offset is stale the moment a
      // collaborator types.
      const start = range.startContainer === element ? 0 : range.startOffset;
      const end = range.endContainer === element ? 0 : range.endOffset;

      return selectionFromOffsets(block, start, end);
    },
    [],
  );

  const contextFor = useCallback(
    (blockId: string, currentSelection?: Selection): EditorContext | null => {
      const block = blocks.find((candidate) => candidate.id === blockId);
      if (block === undefined) return null;

      return {
        factory: store.factory,
        block,
        blocks,
        selection: currentSelection ?? readSelection(block),
      };
    },
    [blocks, store, readSelection],
  );

  const commit = useCallback(
    (result: { operations: readonly unknown[]; selection: Selection }, undoLabel?: string) => {
      const operations = result.operations as Operation[];

      /**
       * Record the undo step BEFORE applying — from the OPERATIONS, against the pre-edit state.
       *
       * Not from a before/after snapshot of the block. That was the first design, and it deleted a
       * collaborator's words: undoing by restoring the block's remembered text wipes anything they
       * typed into that paragraph in the meantime. The operations name exactly the characters we
       * touched — and nothing else. (See editor/history.ts.)
       */
      if (undoLabel !== undefined && operations.length > 0) {
        history.current.record(operations, store.state, undoLabel);
      }

      store.applyLocal(operations);
      setSelection(result.selection);
      setFocusedBlockId(result.selection.blockId);
    },
    [store],
  );

  const handleBeforeInput = useCallback(
    (blockId: string, event: InputEvent) => {
      if (readOnly) {
        event.preventDefault();
        return;
      }

      const context = contextFor(blockId);
      if (context === null) return;

      // THE line. The browser is told: you do not touch this document. We will.
      event.preventDefault();

      const { block, selection: current } = context;
      const caretOffset =
        current.anchor === null ? 0 : block.charIds.indexOf(current.anchor) + 1;

      switch (event.inputType) {
        case "insertText":
        case "insertCompositionText": {
          const data = event.data ?? "";
          if (data === "") return;

          // Markdown block shortcut: "## " becomes a heading, and the space is swallowed rather than
          // inserted. Checked BEFORE the text is applied, which is only possible because we intercept
          // the intent instead of reacting to the mutation.
          const shortcut = matchShortcut(block, caretOffset, data);
          if (shortcut !== null) {
            const consumed = block.charIds.slice(0, shortcut.consumed);
            const operations = [
              store.factory.deleteText(block.id, consumed),
              store.factory.setBlockAttrs(block.id, shortcut.attrs ?? {}, shortcut.type),
            ];
            store.applyLocal(operations);
            setSelection(collapsed(block.id, null));
            return;
          }

          const inline = matchInlineShortcut(block, caretOffset, data);
          if (inline !== null) {
            const delimiterIds = inline.delimiters
              .map((offset) => block.charIds[offset])
              .filter((id): id is string => id !== undefined);
            const contentIds = inline.content
              .map((offset) => block.charIds[offset])
              .filter((id): id is string => id !== undefined);

            store.applyLocal([
              store.factory.setMark(block.id, contentIds, inline.mark, true),
              store.factory.deleteText(block.id, delimiterIds),
            ]);
            setSelection(collapsed(block.id, contentIds[contentIds.length - 1] ?? null));
            return;
          }

          if (data === "/" && block.text === "") {
            setSlash({
              blockId: block.id,
              query: "",
              anchor: elements.current.get(block.id) ?? null,
            });
          } else if (slash !== null && slash.blockId === block.id) {
            setSlash({ ...slash, query: slash.query + data });
          }

          commit(insertText(context, data), "typing");
          return;
        }

        // Enter. In a `plaintext-only` contenteditable the browser reports `insertLineBreak`, NOT
        // `insertParagraph` — it thinks it is inserting a `\n` into a text node rather than starting a
        // new paragraph element. Handling only `insertParagraph` (the intuitive name, and the one every
        // tutorial uses) means Enter silently does nothing, which is exactly the bug the E2E test
        // caught. Both intents mean "split the block" here.
        case "insertParagraph":
        case "insertLineBreak": {
          setSlash(null);
          commit(splitBlock(context));
          return;
        }

        case "deleteContentBackward": {
          if (slash !== null) {
            const query = slash.query.slice(0, -1);
            setSlash(query === "" && block.text === "/" ? null : { ...slash, query });
          }
          commit(deleteBackward(context), "delete");
          return;
        }

        case "deleteContentForward": {
          commit(deleteForward(context), "delete");
          return;
        }

        case "insertFromPaste": {
          const text = event.dataTransfer?.getData("text/plain") ?? "";
          if (text === "") return;

          // Paste arrives as plain text, always. Accepting `text/html` would mean parsing arbitrary
          // markup from the clipboard into our block model — an XSS surface, a parser to maintain, and
          // a source of "why is my document full of Google Docs spans" bug reports. Multi-line pastes
          // become multiple blocks, which is what the user meant anyway.
          const lines = text.split(/\r?\n/).filter((line) => line !== "");
          if (lines.length <= 1) {
            commit(insertText(context, text.replace(/\r?\n/g, " ")));
            return;
          }

          const operations: unknown[] = [];
          let cursor = context;
          let lastSelection = context.selection;

          for (const [index, line] of lines.entries()) {
            if (index === 0) {
              const result = insertText(cursor, line);
              operations.push(...result.operations);
              lastSelection = result.selection;
              continue;
            }

            const blockResult = insertBlockAfter(cursor, "paragraph");
            operations.push(...blockResult.operations);

            // Each new block is inserted after the previous one, so the fractional indices stay ordered
            // and the pasted paragraphs land in the order they were written.
            const newBlock: RenderedBlock = {
              id: blockResult.selection.blockId,
              type: "paragraph",
              fracIndex: "",
              attrs: {},
              text: "",
              charIds: [],
              marks: [],
            };
            const textResult = insertText(
              { ...cursor, block: newBlock, selection: blockResult.selection },
              line,
            );
            operations.push(...textResult.operations);
            lastSelection = textResult.selection;
            cursor = { ...cursor, block: newBlock, selection: textResult.selection };
          }

          store.applyLocal(operations as never);
          setSelection(lastSelection);
          setFocusedBlockId(lastSelection.blockId);
          return;
        }

        default:
          // Anything we do not explicitly handle is refused rather than passed through. An unhandled
          // input type that mutates the DOM would put the CRDT and the screen permanently out of sync,
          // and the user would see text that no longer exists in the document.
          return;
      }
    },
    [contextFor, commit, readOnly, slash, store],
  );

  const handleKeyDown = useCallback(
    (blockId: string, event: React.KeyboardEvent) => {
      if (readOnly) return;

      const context = contextFor(blockId);
      if (context === null) return;

      const isMod = event.metaKey || event.ctrlKey;

      /**
       * Undo / redo. Cmd+Z and Cmd+Shift+Z (plus Ctrl+Y, which Windows users reach for).
       *
       * These emit ORDINARY forward operations — an undo is not a rewind. It cannot be, because
       * un-deleting a character would resurrect one a collaborator legitimately deleted.
       */
      if (isMod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        const ops = event.shiftKey
          ? history.current.redo(store.factory, store.state)
          : history.current.undo(store.factory, store.state);
        if (ops.length > 0) store.applyLocal(ops);
        return;
      }

      if (isMod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        const ops = history.current.redo(store.factory, store.state);
        if (ops.length > 0) store.applyLocal(ops);
        return;
      }

      if (isMod && event.key.toLowerCase() === "b") {
        event.preventDefault();
        commit(toggleMark(context, "bold"));
        return;
      }
      if (isMod && event.key.toLowerCase() === "i") {
        event.preventDefault();
        commit(toggleMark(context, "italic"));
        return;
      }
      if (isMod && event.key.toLowerCase() === "e") {
        event.preventDefault();
        commit(toggleMark(context, "code"));
        return;
      }

      // Cmd/Ctrl+K opens the AI menu on the current selection (or the whole block if the caret is
      // collapsed). The same shortcut every editor uses for "do something to this text".
      if (isMod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setAiTarget({ blockId, selection: context.selection });
        return;
      }

      if (event.key === "Escape" && slash !== null) {
        event.preventDefault();
        setSlash(null);
        return;
      }

      // Arrow navigation ACROSS blocks. Within a block the browser handles it correctly and we stay out
      // of its way — reimplementing intra-block caret movement is how editors end up broken for
      // right-to-left scripts, for emoji, and for every keyboard layout the author did not own.
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const index = blocks.findIndex((block) => block.id === blockId);
        const target = event.key === "ArrowUp" ? blocks[index - 1] : blocks[index + 1];
        if (target === undefined) return;

        const element = elements.current.get(target.id);
        if (element === undefined) return;

        const atEdge = isCaretAtEdge(element, event.key === "ArrowUp" ? "start" : "end", context);
        if (!atEdge) return;

        event.preventDefault();
        setFocusedBlockId(target.id);
        setSelection(
          collapsed(
            target.id,
            event.key === "ArrowUp" ? (target.charIds[target.charIds.length - 1] ?? null) : null,
          ),
        );
        element.focus();
      }
    },
    // `store` is a real dependency now: the undo/redo branch reads store.factory and store.state, and
    // applies the resulting operations. Omitting it would let this handler close over a stale store
    // after a document switch — and undo would then emit operations into the previous document.
    [blocks, contextFor, commit, readOnly, slash, store],
  );

  const handleSelect = useCallback(
    (blockId: string) => {
      const block = blocks.find((candidate) => candidate.id === blockId);
      if (block === undefined) return;

      setFocusedBlockId(blockId);
      // Identical selections must produce the *same object*, not an equal one. This looks like a
      // micro-optimisation and is a correctness fix: `selection` is a dependency of the throttled
      // presence effect below, so a new object identity tears that effect down and rebuilds it —
      // **cancelling the 150ms timer before it can fire**. This handler runs on every DOM selection
      // event, including the ones the editor causes itself when it restores the caret after a CRDT
      // update. A steady trickle of those means the presence timer is reset forever and the caret is
      // never published at all: the collaborator is invisible, and the harder the document is being
      // edited, the more reliably invisible they are.
      setSelection((previous) => {
        const next = readSelection(block);
        return sameSelection(previous, next) ? previous : next;
      });
    },
    [blocks, readSelection],
  );

  /**
   * Track the caret as the USER moves it — clicks, arrows, Home/End, a mouse drag.
   *
   * `selectionchange` on the document is the only event that reports this. React's `onSelect` does not
   * fire for caret movement inside a contenteditable, and `onFocus` fires *before* the browser has
   * placed the caret, so the selection it reads is the pre-click one. The result, before this existed,
   * was that `selection` state only ever advanced when the user *edited* — which meant presence was
   * only published after an edit. A collaborator who clicked into a paragraph and moved around, or who
   * was simply reading, was invisible to everyone else, and a caret that moved by arrow key kept
   * broadcasting the position it had left. An E2E test caught it: a peer who clicks and presses End
   * publishes nothing at all.
   *
   * The equality check is what makes this safe to attach to an event this noisy. `selectionchange`
   * fires on every keystroke *and* every time the editor writes the caret back after a CRDT update —
   * so re-setting state unconditionally would re-render the editor on its own caret restoration, in a
   * loop. Bailing out when the character ids are unchanged breaks it: a caret that has not moved
   * produces no state change, and therefore no render and no presence frame.
   */
  useEffect(() => {
    const handler = (): void => {
      if (focusedBlockId === null) return;

      const block = blocks.find((candidate) => candidate.id === focusedBlockId);
      if (block === undefined) return;

      const element = elements.current.get(focusedBlockId);
      const domSelection = window.getSelection();
      if (element === undefined || domSelection === null || domSelection.rangeCount === 0) return;

      // Ignore selections that are not in this block — clicking the version-history panel or the AI
      // menu must not be mistaken for the caret leaving the paragraph.
      if (!element.contains(domSelection.anchorNode)) return;

      const next = readSelection(block);
      setSelection((previous) => (sameSelection(previous, next) ? previous : next));
    };

    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [blocks, focusedBlockId, readSelection]);

  /**
   * Publish the caret — throttled, with a leading edge and a trailing edge.
   *
   * Presence is ephemeral, so sending it often is cheap. But a frame per keystroke is ~10/sec per
   * person, and ten people in one document is 100 broadcasts a second to say something one frame later
   * would have said just as well. Hence a rate limit.
   *
   * It must be a **throttle**, not a debounce, and the original was a debounce: `setTimeout(150)` reset
   * on every change publishes 150ms after the user *stops*. While someone types continuously — keystroke
   * to keystroke in under 150ms, which is ordinary typing — the timer is cancelled and rebuilt forever
   * and their caret is never broadcast **at all**. The one moment you most want to see where a
   * collaborator is, is precisely the moment they are typing, and that was the one moment the design
   * guaranteed you could not.
   *
   * So: publish immediately if the last publish was long enough ago (the leading edge — the caret shows
   * up the instant it moves), otherwise schedule one for when the window expires (the trailing edge — a
   * burst still ends with the final position, rather than a stale one).
   */
  useEffect(() => {
    if (selection === null || focusedBlockId === null) return;

    const publish = (): void => {
      lastPresenceAt.current = Date.now();
      onPresence(selection.blockId, selection.anchor);
    };

    const elapsed = Date.now() - lastPresenceAt.current;
    if (elapsed >= PRESENCE_THROTTLE_MS) {
      publish();
      return;
    }

    const handle = window.setTimeout(publish, PRESENCE_THROTTLE_MS - elapsed);
    return () => window.clearTimeout(handle);
  }, [selection, focusedBlockId, onPresence]);

  const handleSlashCommand = useCallback(
    (type: RenderedBlock["type"]) => {
      if (slash === null) return;

      const context = contextFor(slash.blockId);
      if (context === null) return;

      // Remove the "/query" the user typed, then apply the block type. Leaving the "/" behind is the
      // kind of small bug that makes a product feel unfinished.
      const operations = [
        ...(context.block.charIds.length > 0
          ? [store.factory.deleteText(context.block.id, context.block.charIds)]
          : []),
        ...setBlockType(context, type).operations,
      ];

      store.applyLocal(operations);
      setSelection(collapsed(context.block.id, null));
      setSlash(null);
    },
    [slash, contextFor, store],
  );

  /** Toggle a to-do's checkbox — a BLOCK_SET_ATTRS operation, like any other change. */
  const handleToggleTodo = useCallback(
    (blockId: string) => {
      if (readOnly) return;
      const block = blocks.find((candidate) => candidate.id === blockId);
      if (block === undefined) return;

      const checked = block.attrs["checked"] === true;
      store.applyLocal([store.factory.setBlockAttrs(blockId, { checked: !checked }, "todo")]);
    },
    [blocks, readOnly, store],
  );

  // The block the caret is in, and whether each mark covers the whole current selection — drives the
  // bubble toolbar's pressed state. Recomputed only when the block or selection changes.
  const activeBlock = focusedBlockId !== null ? blocks.find((b) => b.id === focusedBlockId) : undefined;

  const activeMarks = useMemo(() => {
    const none = { bold: false, italic: false, code: false };
    if (activeBlock === undefined || selection === null || selection.selected.length === 0) {
      return none;
    }
    const everyCharHas = (mark: MarkType): boolean =>
      selection.selected.every((id) => {
        const index = activeBlock.charIds.indexOf(id);
        return index !== -1 && activeBlock.marks[index]?.[mark] === true;
      });
    return { bold: everyCharHas("bold"), italic: everyCharHas("italic"), code: everyCharHas("code") };
  }, [activeBlock, selection]);

  const applyMark = useCallback(
    (mark: MarkType) => {
      if (focusedBlockId === null || selection === null) return;
      const context = contextFor(focusedBlockId, selection);
      if (context === null) return;
      commit(toggleMark(context, mark), "format");
    },
    [focusedBlockId, selection, contextFor, commit],
  );

  const openAiForSelection = useCallback(() => {
    if (focusedBlockId === null || selection === null) return;
    setAiTarget({ blockId: focusedBlockId, selection });
  }, [focusedBlockId, selection]);

  /**
   * Position the bubble toolbar by measuring the live DOM selection.
   *
   * The measurement runs inside event callbacks — selectionchange, and scroll/resize so the toolbar
   * stays glued to the text as the page moves — never synchronously in the effect body. That is the
   * "subscribe to an external system and setState in its callback" pattern React sanctions (and the
   * same shape as the presence listener above); measuring in the effect body would be the cascading
   * setState-in-effect the compiler rejects. The toolbar shows only for a non-collapsed selection that
   * lives inside a block.
   */
  useEffect(() => {
    const measure = (): void => {
      const domSelection = window.getSelection();
      if (domSelection === null || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
        setSelectionRect(null);
        return;
      }

      const range = domSelection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const element =
        container.nodeType === Node.ELEMENT_NODE
          ? (container as Element)
          : container.parentElement;
      if (element === null || element.closest("[data-block-id]") === null) {
        setSelectionRect(null);
        return;
      }

      const rect = range.getBoundingClientRect();
      setSelectionRect(rect.width === 0 && rect.height === 0 ? null : rect);
    };

    document.addEventListener("selectionchange", measure);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("selectionchange", measure);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, []);

  /**
   * Stable handler identities, via a "latest ref".
   *
   * `handleBeforeInput` closes over `blocks`, so its identity changes on every keystroke. Passing it
   * straight down would change a prop on EVERY BlockView, defeating their `memo` and re-rendering the
   * entire document on every character — precisely the linear degradation the memo exists to prevent,
   * and the reason hand-rolled editors "get slow on long documents".
   *
   * The dispatchers below never change identity. They read the current handlers out of a ref at call
   * time, so the behaviour is always up to date while the prop is always the same object. One keystroke
   * re-renders one block, whether the document has five blocks or five thousand.
   */
  const latest = useRef({ handleBeforeInput, handleKeyDown, handleSelect, handleToggleTodo });

  /**
   * The ref is written in an effect, NOT during render.
   *
   * Writing a ref during render is a real bug, not a lint nit: under concurrent rendering React may
   * render a component, throw the result away, and render again. A ref mutated in that discarded pass
   * has already leaked into the outside world — so the handler captured here could be one that belongs
   * to a render that never committed, closing over state the user never saw.
   *
   * An effect only runs for a render that *did* commit, which is exactly the guarantee this needs.
   * The handlers are only ever invoked from DOM events, long after commit, so the one-tick delay is
   * unobservable.
   */
  useEffect(() => {
    latest.current = { handleBeforeInput, handleKeyDown, handleSelect, handleToggleTodo };
  }, [handleBeforeInput, handleKeyDown, handleSelect, handleToggleTodo]);

  const onBeforeInput = useCallback((blockId: string, event: InputEvent) => {
    latest.current.handleBeforeInput(blockId, event);
  }, []);
  const onKeyDown = useCallback((blockId: string, event: React.KeyboardEvent) => {
    latest.current.handleKeyDown(blockId, event);
  }, []);
  const onSelect = useCallback((blockId: string) => {
    latest.current.handleSelect(blockId);
  }, []);
  const onToggleTodo = useCallback((blockId: string) => {
    latest.current.handleToggleTodo(blockId);
  }, []);

  const getBlockElement = useCallback(
    (blockId: string) => elements.current.get(blockId),
    [],
  );

  return (
    <div className="relative">
      <RemoteCursors peers={peers} blocks={blocks} getBlockElement={getBlockElement} />

      <div className="flex flex-col gap-1">
        {blocks.map((block) => (
          <BlockView
            key={block.id}
            block={block}
            ordinal={ordinals.get(block.id)}
            isFocused={focusedBlockId === block.id}
            selection={focusedBlockId === block.id ? selection : null}
            readOnly={readOnly}
            onBeforeInput={onBeforeInput}
            onKeyDown={onKeyDown}
            onSelect={onSelect}
            onToggleTodo={onToggleTodo}
            registerRef={registerRef}
          />
        ))}
      </div>

      {aiTarget !== null &&
        (() => {
          const block = blocks.find((candidate) => candidate.id === aiTarget.blockId);
          if (block === undefined) return null;

          return (
            <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 pt-32 backdrop-blur-sm">
              <AiMenu
                store={store}
                documentId={documentId}
                block={block}
                selection={aiTarget.selection}
                apiUrl={apiUrl}
                getToken={getToken}
                onClose={() => setAiTarget(null)}
              />
            </div>
          );
        })()}

      {slash !== null && (
        <SlashMenu
          query={slash.query}
          anchorElement={slash.anchor}
          onSelect={handleSlashCommand}
          onDismiss={() => setSlash(null)}
        />
      )}

      {/* The bubble toolbar — only when editing (a viewer has no formatting to apply), when there is a
          real selection, and never fighting the slash or AI menus for the same screen space. */}
      {!readOnly && selectionRect !== null && slash === null && aiTarget === null && (
        <SelectionToolbar
          anchorRect={selectionRect}
          active={activeMarks}
          onBold={() => applyMark("bold")}
          onItalic={() => applyMark("italic")}
          onCode={() => applyMark("code")}
          onAi={openAiForSelection}
        />
      )}
    </div>
  );
}

/** Is the caret at the first/last line of the block, i.e. should an arrow key leave it? */
function isCaretAtEdge(
  _element: HTMLElement,
  edge: "start" | "end",
  context: EditorContext,
): boolean {
  const { block, selection } = context;
  if (edge === "start") return selection.anchor === null;
  return selection.anchor === block.charIds[block.charIds.length - 1];
}

/**
 * Two selections that name the same characters are the same selection.
 *
 * Compared by character id, never by offset — an offset is stale the moment a collaborator types above
 * you, so two "identical" offsets can point at different characters. Ids do not have that problem, and
 * comparing them is what lets the `selectionchange` listener above ignore the caret restorations the
 * editor performs on itself.
 */
function sameSelection(a: Selection | null, b: Selection): boolean {
  if (a === null) return false;
  if (a.blockId !== b.blockId || a.anchor !== b.anchor) return false;
  if (a.selected.length !== b.selected.length) return false;
  return a.selected.every((id, index) => id === b.selected[index]);
}
