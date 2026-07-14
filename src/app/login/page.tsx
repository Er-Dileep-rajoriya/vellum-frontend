import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { LoginForm } from "@/components/auth/LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id !== undefined) redirect("/documents");

  const { error, callbackUrl } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6">
      <Link href="/" className="mb-8 text-sm font-medium text-muted-foreground">
        Vellum
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your documents are saved on this device and synced when you&apos;re online.
      </p>

      <LoginForm callbackUrl={callbackUrl ?? "/documents"} initialError={mapError(error)} />
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
