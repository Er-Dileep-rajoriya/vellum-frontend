import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { auth } from "@/auth";
import { AppHeader } from "@/components/AppHeader";
import { ThemeProvider } from "@/components/ThemeProvider";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

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
    // `suppressHydrationWarning` is required here, and it is NOT a smell: next-themes writes the theme
    // class onto <html> from a blocking inline script BEFORE React hydrates, precisely so a dark-mode
    // user never gets a white flash. The server's HTML and the client's first render therefore differ
    // on exactly this attribute, by design, and React has to be told to expect it.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
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
