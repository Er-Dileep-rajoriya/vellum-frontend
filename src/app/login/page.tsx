import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { AuthForm } from "@/components/auth/AuthForm";

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    error?: string;
    callbackUrl?: string;
    verified?: string;
    reset?: string;
  }>;
}) {
  const session = await auth();
  if (session?.user?.id !== undefined) redirect("/documents");

  const { error, callbackUrl, verified, reset } = await searchParams;

  const notice =
    verified !== undefined
      ? "Email verified. Sign in to continue."
      : reset !== undefined
        ? "Password updated. Sign in with your new password."
        : undefined;

  return (
    <main className="mx-auto flex flex-1 w-full max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your documents are saved on this device and synced when you&apos;re online.
      </p>

      <AuthForm
        mode="signin"
        callbackUrl={callbackUrl ?? "/documents"}
        initialError={mapError(error)}
        notice={notice}
      />
    </main>
  );
}

/**
 * Auth.js reports failures as opaque codes in the query string. Map them to human sentences — and
 * keep the credentials failure vague on purpose.
 *
 * "Invalid email or password" is the same message whether the account does not exist or the password
 * is wrong. Saying "no account with that email" would turn the login form into a user-enumeration
 * oracle: an attacker could test a million leaked addresses and learn exactly which ones have
 * accounts here. The backend already equalises the *timing* of the two cases; this equalises the
 * *text*. Both are needed — either one alone leaks.
 */
function mapError(code: string | undefined): string | null {
  if (code === undefined) return null;

  switch (code) {
    case "CredentialsSignin":
      return "Invalid email or password.";
    case "OAuthAccountNotLinked":
      return "That email is already registered with a password. Sign in with your password instead.";
    default:
      return "Something went wrong signing you in. Please try again.";
  }
}
