"use client";

import { Bold, Code, Italic, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The selection ("bubble") toolbar.
 *
 * Appears above a non-empty text selection with the formatting actions users reach for by muscle
 * memory — bold, italic, inline code — plus a shortcut into the AI menu. It is a thin veneer over the
 * exact same operations the keyboard shortcuts emit (`toggleMark`, the AI target), so it introduces no
 * new path into the document: every button is a CRDT operation, like every other edit.
 *
 * Positioning is measured from the live DOM selection rect (passed in), not stored offsets — the
 * toolbar is chrome, and chrome may read the DOM. The buttons use `onMouseDown` + `preventDefault` so
 * clicking one never blurs the editor and collapses the selection it is about to format.
 */
export interface SelectionToolbarProps {
  readonly anchorRect: DOMRect;
  readonly active: { readonly bold: boolean; readonly italic: boolean; readonly code: boolean };
  readonly onBold: () => void;
  readonly onItalic: () => void;
  readonly onCode: () => void;
  readonly onAi: () => void;
}

export function SelectionToolbar({
  anchorRect,
  active,
  onBold,
  onItalic,
  onCode,
  onAi,
}: SelectionToolbarProps) {
  // Center over the selection, sit just above it, and stay inside the viewport horizontally.
  const centerX = anchorRect.left + anchorRect.width / 2;
  const left = Math.min(Math.max(centerX, 96), window.innerWidth - 96);
  const top = Math.max(8, anchorRect.top - 46);

  return (
    <div
      role="toolbar"
      aria-label="Text formatting"
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-xl animate-in fade-in-0 zoom-in-95"
      style={{ top, left, transform: "translateX(-50%)" }}
    >
      <ToolbarButton label="Bold" shortcut="⌘B" active={active.bold} onAction={onBold}>
        <Bold className="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton label="Italic" shortcut="⌘I" active={active.italic} onAction={onItalic}>
        <Italic className="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton label="Code" shortcut="⌘E" active={active.code} onAction={onCode}>
        <Code className="size-4" aria-hidden />
      </ToolbarButton>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      <ToolbarButton label="Ask AI" shortcut="⌘K" active={false} onAction={onAi}>
        <Sparkles className="size-4" aria-hidden />
        <span className="text-xs font-medium">AI</span>
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  label,
  shortcut,
  active,
  onAction,
  children,
}: {
  readonly label: string;
  readonly shortcut: string;
  readonly active: boolean;
  readonly onAction: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={`${label} (${shortcut})`}
      aria-pressed={active}
      title={`${label} · ${shortcut}`}
      // mousedown, not click: a click blurs the contenteditable first, collapsing the selection we are
      // about to format. Preventing the default mousedown keeps focus and the selection intact.
      onMouseDown={(event) => {
        event.preventDefault();
        onAction();
      }}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md px-2 text-sm transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
