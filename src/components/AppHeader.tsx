"use client";

import { FileText, LogOut } from "lucide-react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useState } from "react";

import { ThemeToggle } from "@/components/ThemeProvider";
import { clearAccessToken } from "@/services/tokenProvider";

/**
 * The application chrome: one sticky bar, on every screen.
 *
 * It exists so that "sign out" is reachable from anywhere — most importantly the editor, which is
 * otherwise a full-bleed writing surface with no way back out. Rendering it once in the root layout
 * (rather than per-page) is what makes that guarantee hold for every route, including ones added
 * later.
 *
 * Auth state is resolved on the server (the layout calls `auth()`) and passed down as plain props, so
 * this component never does its own session fetch and never flashes a wrong state on hydration. When
 * signed out it is just the wordmark and the theme toggle — no logout control to click when there is
 * no session to end.
 */
export function AppHeader({
  authed,
  email,
}: {
  readonly authed: boolean;
  readonly email: string | null;
}) {
  const [signingOut, setSigningOut] = useState(false);

  function handleSignOut() {
    setSigningOut(true);
    // Clear the in-memory access token BEFORE ending the session. A token that outlives the session
    // it came from still works — for up to its full lifetime, on a machine the user just walked away
    // from. next-auth then clears the session cookie and redirects.
    clearAccessToken();
    void signOut({ callbackUrl: "/login" });
  }

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">
      <div className="flex h-14 items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-1">
          <Link
            href={authed ? "/documents" : "/"}
            className="text-sm font-semibold tracking-tight transition-opacity hover:opacity-70"
          >
            Vellum
          </Link>

          {/* Documents is always reachable from the header. For a signed-out visitor the link still
              points at /documents; the middleware bounces them to /login?callbackUrl=/documents, so
              signing in lands them exactly where they were headed. */}
          <Link
            href="/documents"
            className="ml-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FileText className="size-4" aria-hidden />
            <span className="hidden sm:inline">Documents</span>
          </Link>
        </div>

        <div className="flex items-center gap-1">
          <ThemeToggle />

          {authed && (
            <>
              {email !== null && (
                <span className="ml-1 hidden max-w-[14rem] truncate px-2 text-xs text-muted-foreground sm:inline">
                  {email}
                </span>
              )}
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <LogOut className="size-4" aria-hidden />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
