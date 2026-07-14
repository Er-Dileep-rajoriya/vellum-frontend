import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/ThemeProvider";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vellum — local-first collaborative editor",
  description:
    "A document editor that works without the internet. Every keystroke is saved locally and merged conflict-free.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
