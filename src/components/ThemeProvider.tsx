"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

export function ThemeProvider({ children }: { readonly children: React.ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      // Disabling transitions during the switch stops every element on the page from animating its
      // colour at once, which looks like a bug and costs a frame budget on a large document.
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  /**
   * The theme is not known on the server — it lives in localStorage and in the OS preference, neither
   * of which the server can see. Rendering the icon before hydration would therefore *guess*, get it
   * wrong half the time, and produce a hydration mismatch.
   *
   * The signal for "we don't know yet" is `resolvedTheme === undefined`, which next-themes gives us
   * directly. The usual `const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true))`
   * dance produces the same result via a synchronous setState inside an effect — a guaranteed second
   * render pass on every mount, to learn something we were already being told.
   *
   * The placeholder is the same size as the button, so the header does not shift when it resolves.
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
