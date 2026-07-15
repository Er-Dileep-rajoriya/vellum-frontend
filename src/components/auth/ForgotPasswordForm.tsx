"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Request a password-reset code.
 *
 * The backend answers identically whether or not the address has an account, so this form cannot —
 * and must not try to — tell the user "no account found": that difference is exactly the enumeration
 * oracle the uniform response exists to close. On submit it simply advances to the reset screen,
 * where a code (if one was sent) is entered.
 */
export function ForgotPasswordForm({ initialEmail }: { readonly initialEmail: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not start a password reset.");
        return;
      }

      // Move to the reset step regardless — a real account got a code, and a fake one gets a form
      // that will simply reject whatever is typed. Either way the UI reveals nothing.
      router.push(`/reset-password?email=${encodeURIComponent(email.trim().toLowerCase())}&sent=1`);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="mt-8 space-y-3" noValidate>
      <div>
        <label htmlFor="forgot-email" className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <input
          id="forgot-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:ring-2 focus:ring-foreground/20"
        />
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || email.trim().length === 0}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        Send reset code
      </button>
    </form>
  );
}
