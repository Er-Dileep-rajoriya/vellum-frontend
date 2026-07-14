"use client";

import { memo, useEffect, useRef } from "react";

import type { RenderedBlock } from "@/crdt/types";
import type { Selection } from "@/editor/inputMapper";
import { offsetsFromSelection } from "@/editor/inputMapper";
import { cn } from "@/lib/utils";

/**
 * One block = one contenteditable.
 *
 * Why not one contenteditable for the whole document: the browser normalises the DOM inside a
 * contenteditable however it likes — merging text nodes, inserting `<br>`, splitting spans — and a
 * whole-document editable means fighting that on every keystroke, everywhere. Scoping it to a block
 * confines the browser's creativity to a paragraph, and makes "which block did this input event
 * belong to?" a question with an obvious answer rather than a DOM walk.
 *
 * The React contract here is deliberately unusual and worth being explicit about: **React does not own
 * this DOM's text.** We render the text once, `preventDefault()` every input, and write the text back
 * from the CRDT ourselves. React re-rendering a contenteditable's children on every keystroke destroys
 * the selection, and every workaround for that is worse than not doing it.
 */

export interface BlockViewProps {
  readonly block: RenderedBlock;
  readonly isFocused: boolean;
  readonly selection: Selection | null;
  readonly readOnly: boolean;
  readonly onBeforeInput: (blockId: string, event: InputEvent) => void;
  readonly onKeyDown: (blockId: string, event: React.KeyboardEvent) => void;
  readonly onSelect: (blockId: string) => void;
  readonly registerRef: (blockId: string, element: HTMLElement | null) => void;
}

/**
 * Memoised on the block's identity and content.
 *
 * This is what keeps typing O(1) in document size: a keystroke changes one block, so exactly one of
 * these re-renders regardless of whether the document has 5 blocks or 5,000. Without the memo, every
 * keystroke would reconcile the entire document and typing would degrade linearly — the classic reason
 * hand-rolled editors "get slow on long documents".
 */
export const BlockView = memo(function BlockView({
  block,
  isFocused,
  selection,
  readOnly,
  onBeforeInput,
  onKeyDown,
  onSelect,
  registerRef,
}: BlockViewProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    registerRef(block.id, ref.current);
    return () => registerRef(block.id, null);
  }, [block.id, registerRef]);

  /**
   * A NATIVE `beforeinput` listener — not React's `onBeforeInput` prop.
   *
   * They are not the same event. React synthesises `onBeforeInput` from a legacy `textInput`
   * compatibility path, and the synthetic event it hands you **has no `inputType`**. Every intent the
   * editor distinguishes — insertText vs insertParagraph vs deleteContentBackward vs insertFromPaste —
   * is carried on that one field, so with React's version the entire dispatch falls through to
   * `default` and every keystroke is silently discarded. Which is exactly what happened: the block
   * rendered, the caret blinked, and typing did nothing.
   *
   * The native event also lets `preventDefault()` actually prevent the DOM mutation, which is the whole
   * premise of the editor: the browser reports intent, the CRDT decides what happens.
   */
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const handler = (event: Event): void => {
      onBeforeInput(block.id, event as InputEvent);
    };

    element.addEventListener("beforeinput", handler);
    return () => element.removeEventListener("beforeinput", handler);
  }, [block.id, onBeforeInput]);

  /**
   * Write the CRDT's text into the DOM — but ONLY when they actually differ.
   *
   * The guard is load-bearing. Assigning `textContent` unconditionally would destroy the browser's
   * selection on every render, including renders caused by a *collaborator's* edit elsewhere in the
   * document. The user would be typing along and their caret would jump to the start of the block
   * every time someone else typed. Comparing first means the DOM is touched only when it is genuinely
   * stale.
   */
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (element.textContent === block.text) return;

    element.textContent = block.text;
  }, [block.text]);

  /** Restore the caret after a CRDT-driven re-render. */
  useEffect(() => {
    const element = ref.current;
    if (element === null || !isFocused || selection === null) return;
    if (selection.blockId !== block.id) return;

    const { start, end } = offsetsFromSelection(block, selection);
    const textNode = element.firstChild;

    const domSelection = window.getSelection();
    if (domSelection === null) return;

    const range = document.createRange();

    if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) {
      // An empty block has no text node to place a caret inside.
      range.setStart(element, 0);
      range.setEnd(element, 0);
    } else {
      const length = textNode.textContent?.length ?? 0;
      // Clamp: a collaborator may have deleted characters our selection named between the CRDT update
      // and this effect. Setting a range beyond the node's length throws, and an exception here would
      // take the whole editor down over a caret.
      range.setStart(textNode, Math.min(start, length));
      range.setEnd(textNode, Math.min(end, length));
    }

    domSelection.removeAllRanges();
    domSelection.addRange(range);
  }, [block, isFocused, selection]);

  /**
   * The block's semantic element, chosen at runtime.
   *
   * TypeScript intersects the ref types of every possible intrinsic element in the union, demanding a
   * ref that is simultaneously an HTMLDivElement, an HTMLHeadingElement and an HTMLQuoteElement — which
   * nothing is. The cast narrows the *type* to one member while leaving the *value* alone; the element
   * really is an `<h2>` at runtime, and everything we do with the ref (`textContent`, `firstChild`,
   * `focus`) exists on HTMLElement anyway.
   */
  const Tag = tagFor(block.type) as "div";

  return (
    <div
      className="group relative flex items-start gap-2"
      data-block-id={block.id}
      /**
       * `content-visibility: auto` — virtualisation without the lie.
       *
       * The browser skips layout, paint, and style for blocks outside the viewport, which is the entire
       * win a JS virtualiser gives you. But the node **stays in the DOM**, and that is the part that
       * matters for a writing tool:
       *
       *   - **Ctrl+F still finds it.** A JS virtualiser unmounts off-screen blocks, so the browser's own
       *     find-in-page cannot see them. For a document editor that is a real, permanent regression —
       *     people search their own writing constantly — and it is not a trade worth making.
       *   - Screen readers still reach it, `#anchor` links still resolve, and Select-All still selects
       *     the whole document rather than the visible slice of it.
       *   - The editor's DOM references stay valid, so no block needs pinning and a scroll can never
       *     unmount the element the user is typing into.
       *
       * `contain-intrinsic-size` is what stops the scrollbar from thrashing: it tells the browser how
       * tall to *assume* a skipped block is, so scroll height is stable instead of being recomputed as
       * blocks scroll into view. Roughly one line of text.
       */
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 28px" }}
    >
      {block.type === "bulletList" && (
        <span aria-hidden className="mt-[0.55rem] size-1.5 shrink-0 rounded-full bg-foreground/60" />
      )}
      {block.type === "todo" && (
        <input
          type="checkbox"
          checked={block.attrs["checked"] === true}
          readOnly
          aria-label="To-do"
          className="mt-[0.4rem] size-4 shrink-0 rounded border-foreground/30"
        />
      )}

      <Tag
        ref={ref}
        // `plaintext-only` stops the browser from injecting `<b>`, `<i>` and `<div>` elements of its
        // own on Ctrl+B or Enter. Formatting is CRDT marks, not DOM tags, and the DOM is a projection —
        // letting the browser author structure into it would make it a second, competing source of truth.
        contentEditable={readOnly ? false : "plaintext-only"}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="false"
        tabIndex={0}
        spellCheck
        data-placeholder={block.text === "" ? placeholderFor(block.type) : undefined}
        onKeyDown={(event) => onKeyDown(block.id, event)}
        onSelect={() => onSelect(block.id)}
        onFocus={() => onSelect(block.id)}
        className={cn(
          "min-h-[1.6em] w-full flex-1 outline-none",
          "empty:before:pointer-events-none empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)]",
          STYLES[block.type],
          readOnly && "cursor-default",
        )}
      />
    </div>
  );
});

/**
 * Semantic elements, not a wall of styled `<div>`s.
 *
 * A screen reader announces "heading level 2" because the element IS an `<h2>`. Rendering a div with
 * `class="text-2xl font-bold"` looks identical and is invisible to assistive technology — the document
 * outline, which is how a blind user navigates a long page, simply would not exist.
 */
function tagFor(type: RenderedBlock["type"]): "h1" | "h2" | "h3" | "blockquote" | "pre" | "div" {
  switch (type) {
    case "heading1":
      return "h1";
    case "heading2":
      return "h2";
    case "heading3":
      return "h3";
    case "quote":
      return "blockquote";
    case "code":
      return "pre";
    default:
      return "div";
  }
}

const STYLES: Record<RenderedBlock["type"], string> = {
  paragraph: "text-base leading-7",
  heading1: "text-3xl font-semibold tracking-tight leading-tight mt-6",
  heading2: "text-2xl font-semibold tracking-tight leading-snug mt-5",
  heading3: "text-xl font-semibold tracking-tight leading-snug mt-4",
  bulletList: "text-base leading-7",
  numberedList: "text-base leading-7",
  todo: "text-base leading-7",
  quote: "border-l-2 border-foreground/20 pl-4 italic text-muted-foreground leading-7",
  code: "rounded-lg bg-muted p-4 font-mono text-sm leading-6 whitespace-pre-wrap",
  divider: "border-t border-border my-4 min-h-0",
  image: "text-base leading-7",
  table: "text-base leading-7",
  callout: "rounded-lg bg-muted/60 border border-border p-4 leading-7",
};

function placeholderFor(type: RenderedBlock["type"]): string {
  switch (type) {
    case "heading1":
    case "heading2":
    case "heading3":
      return "Heading";
    case "code":
      return "Code";
    case "quote":
      return "Quote";
    default:
      return "Type '/' for commands";
  }
}
