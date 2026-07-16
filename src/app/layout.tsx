import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { auth } from "@/auth";
import { AppHeader } from "@/components/AppHeader";
import { ThemeProvider } from "@/components/ThemeProvider";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * The no-flash theme script.
 *
 * It runs synchronously, as the first thing in <body>, BEFORE any content paints — so a dark-mode user
 * never sees a white flash. It sets the `.dark` class on <html> from the stored preference (or the OS,
 * when unset / "system"), matching the client contract in ThemeProvider.
 *
 * It lives here, rendered by a Server Component, rather than inside the client ThemeProvider. That is
 * the whole point: a `<script>` rendered by a client component is never executed on the client (React
 * 19 warns about exactly this), and an anti-flash script that runs after hydration is useless. Here it
 * is static server HTML, so it runs at parse time, once, and is never re-rendered.
 */
const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem("theme");var d=s==="dark"||((s===null||s==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;if(d)r.classList.add("dark");r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

export const metadata: Metadata = {
  title: "Vellum — local-first collaborative editor",
  description:
    "A document editor that works without the internet. Every keystroke is saved locally and merged conflict-free.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Resolve the session once, on the server, and hand the header plain props. The header is a client
  // component (logout is interactive) but it must never do its own session round trip — that would
  // flash "signed out" chrome on first paint before the fetch resolves.
  const session = await auth();
  const authed = session?.user?.id !== undefined;

  return (
    // `suppressHydrationWarning` is required here, and it is NOT a smell: the blocking THEME_INIT_SCRIPT
    // below writes the `.dark` class onto <html> BEFORE React hydrates, precisely so a dark-mode user
    // never gets a white flash. The server's HTML and the client's first render therefore differ on
    // exactly this attribute, by design, and React has to be told to expect it.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* First child of <body>: runs before any content paints, so there is no theme flash. Rendered
            by this Server Component (not the client provider) so React executes it and never warns. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <ThemeProvider>
          <AppHeader authed={authed} email={session?.user?.email ?? null} />
          {/* The sticky header owns the top of the viewport; everything else fills the remaining
              height. Pages use `flex-1` (not `min-h-dvh`) so they size to this space instead of the
              full viewport, which would otherwise push a scrollbar down by the header's height. */}
          <div className="flex flex-1 flex-col">{children}</div>
        </ThemeProvider>
      </body>
    </html>
  );
}
