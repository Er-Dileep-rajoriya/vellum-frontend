import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes, resolving conflicts by specificity rather than by source order.
 *
 * Without `twMerge`, `cn("p-2", "p-4")` emits both and the winner is whichever Tailwind happened to
 * emit later in the stylesheet — which is not something a component author can reason about. With it,
 * the last one wins, which is what everyone assumes is happening anyway.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "2 minutes ago". Bounded, non-throwing, and honest about "just now". */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1_000);

  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return new Date(timestamp).toLocaleDateString();
}
