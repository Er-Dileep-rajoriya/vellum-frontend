"use client";

import { Moon, Sun } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";

/**
 * A tiny, dependency-free theme system.
 *
 * It replaces `next-themes`, which on React 19 renders its no-flash script *inside a client component*
 * — and React 19 warns (correctly) that a `<script>` rendered on the client never executes. The
 * anti-flash script must run before paint, so it belongs in the server-rendered document, not in a
 * client component's render tree. Here it lives in the root layout (see `THEME_INIT_SCRIPT` there),
 * and this file owns only what genuinely needs the client.
 *
 * The theme's source of truth is the browser — localStorage plus the OS media query — read through
 * `useSyncExternalStore` rather than mirrored into `useState` inside an effect. That is deliberate: a
 * synchronous `setState` in an effect is exactly the cascading-render the React Compiler lint rejects,
 * and mirroring an external value into React state is the anti-pattern that rule exists to catch.
 *
 * The CSS contract is a single class on `<html>`: `.dark` (see globals.css `@custom-variant dark`).
 */

const STORAGE_KEY = "theme";

type Theme = "light" | "dark" | "system";
type Resolved = "light" | "dark";

interface ThemeContextValue {
  readonly theme: Theme;
  /** `undefined` until mounted — the server cannot know it, so nothing should render theme-dependent
   *  UI before it resolves (see {@link ThemeToggle}). */
  readonly resolvedTheme: Resolved | undefined;
  readonly setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/* ----------------------------- external store ----------------------------- */

const listeners = new Set<() => void>();

/** Called after the stored preference changes, to push the new value to every subscriber. */
function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  // The OS theme can change (matters in "system" mode), and another tab can change the stored
  // preference (the `storage` event) — both must re-resolve the theme here.
  media.addEventListener("change", onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    media.removeEventListener("change", onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function readTheme(): Theme {
  try {
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
  } catch {
    return "system";
  }
}

function readResolved(): Resolved {
  const theme = readTheme();
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/* ------------------------------ DOM mutation ------------------------------ */

function apply(resolved: Resolved): void {
  const root = document.documentElement;

  // Suppress transitions for the duration of the switch, so the whole page does not animate its colour
  // at once (which reads as a bug and costs a frame on a large document).
  const killTransitions = document.createElement("style");
  killTransitions.appendChild(
    document.createTextNode("*,*::before,*::after{transition:none !important}"),
  );
  document.head.appendChild(killTransitions);

  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;

  // A method call (side-effecting) forces the class change to commit before transitions are re-enabled.
  root.getBoundingClientRect();
  window.setTimeout(() => killTransitions.remove(), 1);
}

/* -------------------------------- provider -------------------------------- */

export function ThemeProvider({ children }: { readonly children: React.ReactNode }) {
  const theme = useSyncExternalStore<Theme>(subscribe, readTheme, () => "system");
  const resolvedTheme = useSyncExternalStore<Resolved | undefined>(
    subscribe,
    readResolved,
    () => undefined,
  );

  // Keep the <html> class in sync with the resolved theme. This mutates the DOM (an external system),
  // never React state, so it does not cascade renders. On mount it is a no-op — the blocking script in
  // the layout already set the class — and on an OS change while in "system" mode it re-applies.
  useEffect(() => {
    if (resolvedTheme !== undefined) apply(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage disabled (private mode): the notify() below still re-resolves for this tab, and the
      // `storage`-based cross-tab sync simply won't fire. The theme still switches; it just isn't
      // remembered.
    }
    notify();
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  /**
   * The theme is not known on the server — it lives in localStorage and the OS preference, neither of
   * which the server can see. `resolvedTheme === undefined` is exactly "we don't know yet"; rendering
   * the icon before it resolves would guess, be wrong half the time, and cause a hydration mismatch.
   * The placeholder is button-sized, so the header does not shift when it resolves.
   */
  if (resolvedTheme === undefined) return <div className="size-8" aria-hidden />;

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {isDark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
  );
}
