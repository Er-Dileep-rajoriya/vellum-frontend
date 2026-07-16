"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * A minimal, accessible confirmation modal.
 *
 * Used for the irreversible-looking actions — deleting a document, leaving one, removing a
 * collaborator — where a stray click should not be enough. It is deliberately not a full component
 * library: a backdrop, a focus-trapped-enough card, Escape to cancel, and the confirm button focused
 * on open so Enter confirms and Escape cancels without touching the mouse.
 *
 * "Delete" here is a soft delete on the server (the operation log survives), but the user does not
 * know that and should not have to — the dialog treats it as destructive because that is how it reads.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Guard against Escape firing while a request is in flight — cancelling then would leave the
      // caller unsure whether the action went through.
      if (event.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
    >
      <button
        type="button"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={() => !busy && onCancel()}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[1px]"
      />

      <div className="relative w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-xl">
        <h2 id="confirm-dialog-title" className="text-sm font-semibold">
          {title}
        </h2>
        <p id="confirm-dialog-message" className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50",
              destructive
                ? "bg-destructive text-white"
                : "bg-primary text-primary-foreground",
            )}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
