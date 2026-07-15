"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { cn } from "@/lib/utils";

/**
 * The sign-in / sign-up form.
 *
 * React Hook Form + zod, with the SAME schema shape the backend validates against. Client validation
 * is a UX affordance — it saves a round trip and tells the user about a typo immediately. It is not a
 * security control, and it is not treated as one: the backend re-validates everything, because a
 * client-side check is a suggestion an attacker is free to ignore.
 *
 * Sign in and sign up are separate routes (/login and /signup), not a toggle. Each renders this
 * component with a fixed `mode`, so the URL is shareable, the back button works, and a password
 * manager sees a stable form instead of one that mutates under it.
 */

const SignInSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

const SignUpSchema = SignInSchema.extend({
  name: z.string().trim().min(1, "Enter your name").max(100),
  // 12 characters. Length is the only property of a password that reliably resists an offline attack
  // against a stolen hash; complexity rules mostly produce "P@ssw0rd1" and a frustrated user.
  password: z.string().min(12, "Use at least 12 characters"),
});

type FormValues = z.infer<typeof SignUpSchema>;

export function AuthForm({
  mode,
  callbackUrl,
  initialError,
  notice,
}: {
  readonly mode: "signin" | "signup";
  readonly callbackUrl: string;
  readonly initialError: string | null;
  // A success message from a completed flow elsewhere (e.g. "Email verified — sign in"), shown once
  // above the form. Distinct from `error` so it reads as good news, not a failure.
  readonly notice?: string | undefined;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(mode === "signin" ? (SignInSchema as never) : SignUpSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setBusy(true);
    setError(null);

    try {
      if (mode === "signup") {
        // Registration goes through a Next route handler, which holds the service token. The browser
        // never sees that token — it can mint users, and it belongs on the server only.
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? "Could not create your account.");
          return;
        }

        // Do NOT sign in yet: the account is created but unverified, and the backend refuses a
        // credentials login until the emailed code is confirmed. Send the user to the verify screen
        // (which the register call already dispatched a code for) with their address prefilled.
        router.push(`/verify-email?email=${encodeURIComponent(values.email)}`);
        return;
      }

      const result = await signIn("credentials", {
        email: values.email,
        password: values.password,
        redirect: false,
      });

      if (result?.error !== undefined && result.error !== null) {
        // The backend returns the SAME error for a wrong password and an unverified account, so this
        // message stays generic. The standing "verify your email" link below the form is the escape
        // hatch for someone who signed up but never confirmed.
        setError("Invalid email or password.");
        return;
      }

      // router.push, not window.location: a client-side navigation keeps the app shell we just booted
      // instead of throwing it away and re-downloading everything.
      router.push(callbackUrl);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  });

  // Prefill the verify link with whatever address the user has typed, so the escape hatch for an
  // unverified account lands them on a form that already knows who they are. `useWatch` (not
  // `form.watch`) is the subscription form React Compiler can reason about — the plain watch()
  // function it cannot, and warns.
  const emailValue = useWatch({ control: form.control, name: "email" });
  const verifyHref = emailValue
    ? `/verify-email?email=${encodeURIComponent(emailValue)}`
    : "/verify-email";

  return (
    <div className="mt-8">
      {notice !== undefined && (
        <p className="mb-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}

      <button
        type="button"
        onClick={() => void signIn("google", { callbackUrl })}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
      >
        <GoogleMark />
        Continue with Google
      </button>

      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={(event) => void onSubmit(event)} className="space-y-3" noValidate>
        {mode === "signup" && (
          <Field
            label="Name"
            error={form.formState.errors.name?.message}
            {...form.register("name")}
            autoComplete="name"
          />
        )}

        <Field
          label="Email"
          type="email"
          error={form.formState.errors.email?.message}
          {...form.register("email")}
          autoComplete="email"
        />

        <Field
          label="Password"
          type={showPassword ? "text" : "password"}
          error={form.formState.errors.password?.message}
          {...form.register("password")}
          // The correct autocomplete token per mode. Getting this wrong is why password managers
          // sometimes overwrite a saved password during signup.
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          rightSlot={
            <button
              type="button"
              // Toggle only flips a local flag — the value never leaves the field. onMouseDown prevents
              // the button from stealing focus, so tabbing back into the input still works.
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
          }
        />

        {mode === "signin" && (
          <div className="text-right">
            <Link
              href="/forgot-password"
              className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Forgot password?
            </Link>
          </div>
        )}

        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        {mode === "signin" ? "Don't have an account?" : "Already have an account?"}{" "}
        <Link
          href={mode === "signin" ? "/signup" : "/login"}
          className="font-medium text-foreground underline underline-offset-4"
        >
          {mode === "signin" ? "Sign up" : "Sign in"}
        </Link>
      </p>

      {mode === "signin" && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Signed up but never confirmed your email?{" "}
          <Link href={verifyHref} className="underline underline-offset-4 hover:text-foreground">
            Verify it
          </Link>
        </p>
      )}
    </div>
  );
}

const Field = function Field({
  label,
  error,
  rightSlot,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string;
  readonly error?: string | undefined;
  readonly rightSlot?: React.ReactNode;
}) {
  const id = `field-${label.toLowerCase()}`;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          // Wire the error to the input for screen readers. A red border is invisible to someone using
          // one, and "the form just doesn't submit" is the most frustrating possible failure mode.
          aria-invalid={error !== undefined}
          aria-describedby={error !== undefined ? `${id}-error` : undefined}
          className={cn(
            "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none transition-colors",
            "focus:ring-2 focus:ring-foreground/20",
            // Leave room so the toggle never sits on top of the typed value.
            rightSlot !== undefined && "pr-10",
            error !== undefined ? "border-destructive" : "border-border",
          )}
          {...props}
        />
        {rightSlot !== undefined && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-3">{rightSlot}</div>
        )}
      </div>
      {error !== undefined && (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};

function GoogleMark() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z"
      />
    </svg>
  );
}
