"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Enter the 6-digit code sent at sign-up.
 *
 * The email is carried in the query string, not re-typed, because the code was already sent to it —
 * asking the user to retype the address they just registered with is friction with no purpose. It
 * stays editable only for the rare case of a mistyped query param.
 */
export function VerifyEmailForm({ initialEmail }: { readonly initialEmail: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/auth/verify-email/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not verify that code.");
        return;
      }

      router.push("/login?verified=1");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setResending(true);
    setError(null);
    setNotice(null);

    try {
      await fetch("/api/auth/verify-email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      // Always report sent. The endpoint is deliberately silent about whether the address has an
      // unverified account, so the UI is too.
      setNotice("If that account needs verifying, a new code is on its way.");
    } catch {
      setError("Could not send a new code. Please try again.");
    } finally {
      setResending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="mt-8 space-y-3" noValidate>
      {notice !== null && (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}

      <div>
        <label htmlFor="verify-email" className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <input
          id="verify-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:ring-2 focus:ring-foreground/20"
        />
      </div>

      <div>
        <label htmlFor="verify-code" className="mb-1.5 block text-sm font-medium">
          Verification code
        </label>
        <input
          id="verify-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          value={code}
          // Strip anything that is not a digit as it is typed, so a pasted "123 456" or "123-456"
          // still submits cleanly.
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className={cn(
            "w-full rounded-lg border bg-background px-3 py-2 text-center text-lg tracking-[0.4em] outline-none transition-colors",
            "focus:ring-2 focus:ring-foreground/20",
            error !== null ? "border-destructive" : "border-border",
          )}
        />
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || code.length !== 6}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        Verify email
      </button>

      <p className="pt-2 text-center text-sm text-muted-foreground">
        Didn&apos;t get a code?{" "}
        <button
          type="button"
          onClick={() => void resend()}
          disabled={resending}
          className="font-medium text-foreground underline underline-offset-4 disabled:opacity-50"
        >
          {resending ? "Sending…" : "Resend"}
        </button>
      </p>
    </form>
  );
}
