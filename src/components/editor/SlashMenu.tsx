"use client";

import { useEffect, useRef, useState } from "react";

import type { BlockType } from "@/crdt/types";
import { filterSlashCommands } from "@/editor/markdown";
import { cn } from "@/lib/utils";

/**
 * The slash menu.
 *
 * Keyboard-first, because a command palette that requires the mouse defeats its own purpose. Arrow
 * keys move, Enter selects, Escape dismisses — and the whole thing is announced correctly to a screen
 * reader via `role="listbox"` and `aria-activedescendant`, which is what makes "keyboard accessible"
 * mean something rather than just "the keys happen to work".
 */

export interface SlashMenuProps {
  readonly query: string;
  readonly anchorElement: HTMLElement | null;
  readonly onSelect: (type: BlockType) => void;
  readonly onDismiss: () => void;
}

export function SlashMenu({ query, anchorElement, onSelect, onDismiss }: SlashMenuProps) {
  const [highlighted, setHighlighted] = useState(0);
  const [lastQuery, setLastQuery] = useState(query);
  const listRef = useRef<HTMLUListElement | null>(null);

  const commands = filterSlashCommands(query);

  /**
   * Reset the highlight when the query changes — otherwise the user can find themselves selecting an
   * item that scrolled out from under their cursor as they typed.
   *
   * Adjusted **during render** rather than in an effect. React explicitly supports this pattern for
   * "state derived from a prop change", and it is strictly better than the effect version: the effect
   * would render once with a stale highlight, then immediately re-render with the reset one — a
   * visible flash of the wrong selection on a menu the user is actively arrowing through.
   */
  if (query !== lastQuery) {
    setLastQuery(query);
    setHighlighted(0);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (commands.length === 0) return;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setHighlighted((current) => (current + 1) % commands.length);
          break;
        case "ArrowUp":
          event.preventDefault();
          setHighlighted((current) => (current - 1 + commands.length) % commands.length);
          break;
        case "Enter": {
          event.preventDefault();
          // `stopPropagation` matters: without it the Enter also reaches the editor's beforeinput
          // handler and splits the block underneath the menu we just used.
          event.stopPropagation();
          const command = commands[highlighted];
          if (command !== undefined) onSelect(command.type);
          break;
        }
        case "Escape":
          event.preventDefault();
          onDismiss();
          break;
      }
    };

    // Capture phase, so the menu sees the key before the contenteditable does.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [commands, highlighted, onSelect, onDismiss]);

  if (commands.length === 0) return null;

  const rect = anchorElement?.getBoundingClientRect();

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Block types"
      aria-activedescendant={`slash-${commands[highlighted]?.id ?? ""}`}
      className={cn(
        "fixed z-50 max-h-80 w-72 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl",
        "animate-in fade-in-0 zoom-in-95",
      )}
      style={{
        top: rect !== undefined ? rect.bottom + 8 : 0,
        left: rect?.left ?? 0,
      }}
    >
      {commands.map((command, index) => (
        <li key={command.id}>
          <button
            id={`slash-${command.id}`}
            type="button"
            role="option"
            aria-selected={index === highlighted}
            // `onMouseDown` with preventDefault, NOT onClick: a click would first blur the
            // contenteditable, which collapses the selection we are about to act on. Preventing the
            // default mousedown keeps focus — and the caret — exactly where it was.
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(command.type);
            }}
            onMouseEnter={() => setHighlighted(index)}
            className={cn(
              "flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors",
              index === highlighted ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
          >
            <span className="text-sm font-medium">{command.label}</span>
            <span className="text-xs text-muted-foreground">{command.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
