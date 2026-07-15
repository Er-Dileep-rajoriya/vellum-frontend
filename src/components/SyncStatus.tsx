"use client";

import { AlertTriangle, Check, CloudOff, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import type { SyncState } from "@/sync-engine/syncEngine";

/**
 * The sync indicator.
 *
 * The product promise is "your work is safe even offline". This component is where that promise is
 * either kept or broken, and the way it gets broken is by lying — by showing a cheerful cloud icon
 * while three operations sit in a dead-letter queue.
 *
 * So each state says exactly what is true:
 *
 *   idle    + nothing pending  → "Saved"      (durable locally AND on the server)
 *   idle    + pending          → "Saved locally" (durable HERE; the server does not know yet)
 *   syncing                    → "Syncing…"
 *   backoff                    → "Retrying in Ns" — with a countdown, because a spinner that never
 *                                resolves is indistinguishable from a hang
 *   offline                    → "Offline — N changes saved on this device"
 *   error                      → "N changes could not be saved" + a way to see them
 *
 * "Saved locally" is the one that matters. The user's work IS safe — it is in IndexedDB — and telling
 * them so is honest. Telling them "Saved" when the server has never heard of it is not.
 */

export interface SyncStatusProps {
  readonly state: SyncState;
  readonly onRetry?: () => void;
  readonly onShowFailures?: () => void;
}

export function SyncStatus({ state, onRetry, onShowFailures }: SyncStatusProps) {
  const countdown = useCountdown(state.nextAttemptAt);

  if (state.status === "error") {
    return (
      <button
        type="button"
        // Retry is the primary action now that dead-letters are recoverable: clicking moves the failed
        // operations back into the outbox and tries again. Falls back to onShowFailures if no retry
        // handler is wired.
        onClick={onRetry ?? onShowFailures}
        title="Retry saving these changes"
        className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
      >
        <AlertTriangle className="size-3.5" aria-hidden />
        <span>
          {state.deadLetterCount} change{state.deadLetterCount === 1 ? "" : "s"} couldn&apos;t save
        </span>
        <RefreshCw className="size-3.5" aria-hidden />
      </button>
    );
  }

  if (state.status === "offline") {
    return (
      <Chip tone="muted" icon={<CloudOff className="size-3.5" aria-hidden />}>
        Offline
        {state.pendingCount > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · {state.pendingCount} saved on this device
          </span>
        )}
      </Chip>
    );
  }

  if (state.status === "backoff") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
      >
        <RefreshCw className="size-3.5" aria-hidden />
        {countdown === null ? "Reconnecting…" : `Retrying in ${countdown}s`}
      </button>
    );
  }

  if (state.status === "syncing") {
    return (
      <Chip tone="muted" icon={<Loader2 className="size-3.5 animate-spin" aria-hidden />}>
        Syncing…
      </Chip>
    );
  }

  if (state.pendingCount > 0) {
    return (
      <Chip tone="muted" icon={<Check className="size-3.5" aria-hidden />}>
        Saved locally
      </Chip>
    );
  }

  return (
    <Chip tone="success" icon={<Check className="size-3.5" aria-hidden />}>
      Saved
    </Chip>
  );
}

function Chip({
  children,
  icon,
  tone,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  tone: "muted" | "success";
}) {
  return (
    <span
      // `aria-live="polite"` so a screen-reader user hears "Offline" when it happens, rather than
      // discovering it when their work does not arrive. It is polite rather than assertive because a
      // sync state change should never interrupt someone mid-sentence.
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
        tone === "success" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * Seconds until `at`, ticking. Null when there is nothing to count down to.
 *
 * The countdown is **derived during render** from a ticking clock, rather than being pushed into
 * state from inside an effect. That is not a stylistic preference: calling `setState` synchronously
 * in an effect body schedules a second render pass immediately after the first, and on a component
 * that re-renders every second, that doubles the work forever. Deriving means one render per tick.
 *
 * The effect here does the one thing effects are *for* — subscribing to an external system (the
 * clock) — and the only state it writes is written from a timer callback, not synchronously.
 */
function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (at === null) return;

    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [at]);

  if (at === null) return null;
  return Math.max(0, Math.ceil((at - now) / 1_000));
}

/** The offline banner. Deliberately reassuring, because the truth here IS reassuring. */
export function OfflineBanner({ state }: { readonly state: SyncState }) {
  if (state.status !== "offline") return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-border bg-muted/60 px-4 py-2 text-sm text-muted-foreground"
    >
      <CloudOff className="size-4" aria-hidden />
      <span>
        You&apos;re offline. Keep writing — everything is saved on this device and will sync
        automatically.
      </span>
    </div>
  );
}
