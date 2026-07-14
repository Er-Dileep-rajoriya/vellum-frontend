"use client";

import { useEffect, useState } from "react";

import type { Peer } from "@/collaboration/wsClient";
import type { RenderedBlock } from "@/crdt/types";

/**
 * Remote carets, drawn as an overlay.
 *
 * Two properties matter, and both are about **not being in the way**:
 *
 * 1. **Never inside the contenteditable.** Injecting a `<span>` for a colleague's caret into the DOM
 *    the user is typing in would put it inside the text node the browser is managing — corrupting the
 *    offsets the editor reads from the selection, and being immediately clobbered by the next render
 *    from the CRDT. So the carets live in an absolutely-positioned overlay with `pointer-events: none`,
 *    measured against the real text via `Range.getBoundingClientRect()`. The editable DOM is untouched.
 *
 * 2. **A caret is anchored to a CHARACTER, not an offset.** Presence carries the character id the peer
 *    sits after. If it carried an offset, then every time *you* typed above them their caret would drift
 *    — you would watch a colleague's cursor slide around the document while they sat perfectly still.
 */

export interface RemoteCursorsProps {
  readonly peers: readonly Peer[];
  readonly blocks: readonly RenderedBlock[];
  /** The live DOM node for a block, so we can measure where a character actually is on screen. */
  readonly getBlockElement: (blockId: string) => HTMLElement | undefined;
}

interface CursorPosition {
  readonly peer: Peer;
  readonly top: number;
  readonly left: number;
  readonly height: number;
}

/**
 * Retrying a caret whose geometry is not available yet.
 *
 * A **timer**, not `requestAnimationFrame`, and that distinction is the whole fix. rAF does not fire in
 * a tab the browser is not rendering — which is precisely the tab this retry exists for. Using rAF here
 * meant the retry was suspended exactly when it was needed and, if the tab never fired a
 * `visibilitychange` the browser considered worth reporting, never resumed at all. A timer keeps
 * running (throttled to about a second in the background, which is fine — nobody is looking).
 *
 * 25 attempts at 200ms is five seconds of trying. Bounded, because "no geometry" can also be permanent:
 * a block far outside the viewport that the browser has skipped under `content-visibility: auto` and
 * will not lay out until it is scrolled to. Retrying that forever would be a timer that never stops for
 * a caret nobody can see; the scroll listener is what makes that case measurable, and it resets the
 * budget when it fires.
 */
const MEASURE_RETRY_MS = 200;
const MAX_MEASURE_RETRIES = 25;

export function RemoteCursors({ peers, blocks, getBlockElement }: RemoteCursorsProps) {
  const [positions, setPositions] = useState<CursorPosition[]>([]);

  /**
   * Re-measure whenever the peers move OR the document changes.
   *
   * The `blocks` dependency is the non-obvious one: a colleague's caret does not move when *they* stop
   * typing — it moves when **you** type above them, because the text below shifts down. Measuring only
   * on presence updates leaves their caret stranded where it used to be.
   */
  useEffect(() => {
    let frame: number | null = null;
    let retry: number | null = null;
    let retries = 0;

    const measure = (): void => {
      const next: CursorPosition[] = [];
      /** A caret we *should* be able to draw but currently have no geometry for. */
      let unmeasurable = false;

      for (const peer of peers) {
        if (peer.blockId === null) continue;

        const element = getBlockElement(peer.blockId);
        const block = blocks.find((candidate) => candidate.id === peer.blockId);
        if (element === undefined || block === undefined) continue;

        const textNode = element.firstChild;
        const offset =
          peer.anchor === null ? 0 : block.charIds.indexOf(peer.anchor) + 1;

        // The character they were anchored to has been deleted — by us, or by a third collaborator.
        // Drop the caret rather than guessing a position: a caret drawn in the wrong place is worse
        // than no caret, because it is a confident lie about where somebody is.
        if (peer.anchor !== null && offset === 0) continue;

        const rect = measureCaret(element, textNode, offset);
        if (rect === null) {
          // The block is in the DOM and the character exists — but the browser has produced no
          // geometry for it. That is a *temporary* state, not an absent caret, and it happens
          // constantly: a background tab is not laid out, and neither is a block the browser has
          // skipped under `content-visibility: auto`.
          unmeasurable = true;
          continue;
        }

        const container = element.offsetParent as HTMLElement | null;
        const containerRect = container?.getBoundingClientRect();

        next.push({
          peer,
          top: rect.top - (containerRect?.top ?? 0),
          left: rect.left - (containerRect?.left ?? 0),
          height: rect.height,
        });
      }

      setPositions(next);

      /**
       * Try again shortly if a caret we know about had no geometry yet.
       *
       * This is the bug that made the presence test flaky, and it was a real one: the effect measured
       * **once**, when the presence frame arrived, and if the geometry was not available at that instant
       * it silently gave up. The instant a presence frame arrives is exactly when it tends to be
       * unavailable — the collaborator is typing in *their* tab, which means yours is in the background,
       * which means the browser is not laying it out. When you switched back, nothing re-measured,
       * because `peers` and `blocks` had not changed. Your colleague's caret was simply missing from a
       * paragraph you were looking straight at, until they happened to type again.
       *
       * The retry is on a timer rather than a frame callback precisely because the tab may not be
       * rendering — see MEASURE_RETRY_MS.
       */
      if (unmeasurable && retries < MAX_MEASURE_RETRIES) {
        retries += 1;
        if (retry === null) {
          retry = window.setTimeout(() => {
            retry = null;
            measure();
          }, MEASURE_RETRY_MS);
        }
      }
    };

    /** Coalesce scroll/resize bursts: they fire far faster than a frame, and measuring forces layout. */
    const scheduleMeasure = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };

    measure();

    /**
     * Re-measure on resize, on scroll, and when the tab becomes visible again.
     *
     * Resize is the obvious one: a narrower window rewraps the text, and every caret below the rewrap is
     * now in the wrong place.
     *
     * Scroll matters because of `content-visibility: auto`: a block the browser has skipped has no
     * layout, so a caret inside it cannot be measured — and when it scrolls into view, nothing else
     * would tell this component to look again, since `peers` and `blocks` have not changed.
     *
     * Each of these resets the retry budget, because they mean the *world* changed rather than that we
     * are waiting for a frame — a caret that was legitimately unmeasurable a moment ago may be
     * measurable now.
     *
     * `requestAnimationFrame` coalesces the burst: scroll fires many times per frame, and measuring
     * forces layout. One measurement per frame is the most this can usefully do.
     */
    const remeasure = (): void => {
      retries = 0;
      scheduleMeasure();
    };

    window.addEventListener("resize", remeasure);
    // Capture phase: the editor scrolls inside its own container, and a scroll event on a descendant
    // does not bubble to the window. Without capture, scrolling the document would never be seen.
    window.addEventListener("scroll", remeasure, { capture: true, passive: true });
    document.addEventListener("visibilitychange", remeasure);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (retry !== null) window.clearTimeout(retry);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, { capture: true });
      document.removeEventListener("visibilitychange", remeasure);
    };
  }, [peers, blocks, getBlockElement]);

  if (positions.length === 0) return null;

  return (
    <div
      // `pointer-events: none` is load-bearing, not cosmetic: without it, this overlay sits on top of
      // the editor and swallows every click. The user would be unable to place their own cursor.
      className="pointer-events-none absolute inset-0 z-10"
      aria-hidden
    >
      {positions.map(({ peer, top, left, height }) => (
        <span
          key={peer.clientId}
          className="absolute transition-[top,left] duration-100 ease-out"
          style={{ top, left, height }}
        >
          {/* The caret. */}
          <span
            className="block w-[2px] rounded-full"
            style={{ height, backgroundColor: peer.color }}
          />

          {/* The name flag. Sits ABOVE the caret so it never covers the character the peer is about
              to type — a label that hides the text it points at is a label that gets turned off. */}
          <span
            className="absolute -top-[1.15em] left-0 whitespace-nowrap rounded px-1 py-[1px] text-[10px] font-medium leading-tight text-white"
            style={{ backgroundColor: peer.color }}
          >
            {peer.name ?? "Anonymous"}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Where, in pixels, is the caret at `offset` inside this block?
 *
 * A DOM `Range` collapsed at that offset gives the answer directly — including through line wraps,
 * bidirectional text, and variable-width fonts. Computing it from character widths would be a
 * re-implementation of the browser's own layout engine, and it would be wrong for every script that
 * is not Latin.
 */
function measureCaret(
  element: HTMLElement,
  textNode: ChildNode | null,
  offset: number,
): DOMRect | null {
  try {
    const range = document.createRange();

    if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) {
      // An empty block: no text node to measure inside, so the caret sits at the block's own origin.
      const rect = element.getBoundingClientRect();
      return new DOMRect(rect.left, rect.top, 0, rect.height);
    }

    const length = textNode.textContent?.length ?? 0;
    const clamped = Math.min(offset, length);

    range.setStart(textNode, clamped);
    range.setEnd(textNode, clamped);

    const rects = range.getClientRects();
    const rect = rects[0] ?? range.getBoundingClientRect();

    // A zero-height rect means the layout is not settled yet (mid-render, or the block is hidden).
    // Skip it: it would draw a caret at the top-left corner of the page.
    if (rect.height === 0) return null;

    return rect;
  } catch {
    // A range that cannot be constructed is a caret we cannot draw. That is a cosmetic loss, and it
    // must never take the editor down with it.
    return null;
  }
}
