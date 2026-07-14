"use client";

import type { Peer } from "@/collaboration/wsClient";
import { cn } from "@/lib/utils";

/**
 * Who else is in this document.
 *
 * Presence is ephemeral by construction — it lives in the relay's memory, is never persisted, and never
 * becomes an operation. A cursor position has no meaning once its owner disconnects, it must never
 * appear in version history, and writing it to Postgres at typing speed would be a self-inflicted
 * denial of service on the database that holds the actual documents.
 */
export function Presence({ peers }: { readonly peers: readonly Peer[] }) {
  if (peers.length === 0) return null;

  const visible = peers.slice(0, 4);
  const overflow = peers.length - visible.length;

  return (
    <div className="flex items-center -space-x-2" aria-label={`${peers.length} other people editing`}>
      {visible.map((peer) => (
        <span
          key={peer.clientId}
          title={peer.name ?? "Anonymous"}
          className="flex size-7 items-center justify-center rounded-full border-2 border-background text-[11px] font-semibold text-white"
          style={{ backgroundColor: peer.color }}
        >
          {(peer.name ?? "?").slice(0, 1).toUpperCase()}
        </span>
      ))}

      {overflow > 0 && (
        <span className="flex size-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[11px] font-semibold text-muted-foreground">
          +{overflow}
        </span>
      )}
    </div>
  );
}

/**
 * The connection chip.
 *
 * Deliberately quiet. A disconnected socket is NOT an error — the document still syncs over HTTP, and
 * the only thing the user loses is the speed at which collaborators' edits appear. Shouting about it
 * would train people to ignore a warning that, most of the time, means nothing is actually wrong.
 */
export function ConnectionIndicator({
  status,
  peerCount,
}: {
  readonly status: "connecting" | "connected" | "disconnected";
  readonly peerCount: number;
}) {
  if (status === "connected" && peerCount === 0) return null;

  return (
    <span
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "connected" && "bg-emerald-500",
          status === "connecting" && "animate-pulse bg-amber-500",
          status === "disconnected" && "bg-muted-foreground/40",
        )}
      />
      {status === "connected"
        ? `${peerCount} editing`
        : status === "connecting"
          ? "Connecting"
          : "Live updates paused"}
    </span>
  );
}
