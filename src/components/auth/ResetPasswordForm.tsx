"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Enter the reset code and a new password.
 *
 * The 12-character minimum matches the backend exactly (services/password.service.ts explains why
 * length, not complexity, is the rule). Client-side it is a UX affordance only — the backend
 * re-validates, because a client check is a suggestion an attacker can skip.
 */
export function ResetPasswordForm({
  initialEmail,
  sent,
}: {
  readonly initialEmail: string;
  readonly sent: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (password.length < 12) {
      setError("Use at least 12 characters.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not reset your password.");
        return;
      }

      router.push("/login?reset=1");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="mt-8 space-y-3" noValidate>
      {sent && (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          If an account exists for that email, a reset code is on its way.
        </p>
      )}

      <div>
        <label htmlFor="reset-email" className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <input
          id="reset-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:ring-2 focus:ring-foreground/20"
        />
      </div>

      <div>
        <label htmlFor="reset-code" className="mb-1.5 block text-sm font-medium">
          Reset code
        </label>
        <input
          id="reset-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-center text-lg tracking-[0.4em] outline-none transition-colors focus:ring-2 focus:ring-foreground/20"
        />
      </div>

      <div>
        <label htmlFor="reset-password" className="mb-1.5 block text-sm font-medium">
          New password
        </label>
        <div className="relative">
          <input
            id="reset-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 12 characters"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm outline-none transition-colors focus:ring-2 focus:ring-foreground/20"
          />
          <div className="absolute inset-y-0 right-0 flex items-center pr-3">
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="grid place-items-center text-muted-foreground transition-colors hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="size-4" aria-hidden />
              ) : (
                <Eye className="size-4" aria-hidden />
              )}
            </button>
          </div>
        </div>
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
        Reset password
      </button>
    </form>
  );
}
