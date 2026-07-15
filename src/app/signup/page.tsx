import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { AuthForm } from "@/components/auth/AuthForm";

export default async function SignupPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id !== undefined) redirect("/documents");

  const { error, callbackUrl } = await searchParams;

  return (
    <main className="mx-auto flex flex-1 w-full max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your documents are saved on this device and synced when you&apos;re online.
      </p>

      <AuthForm mode="signup" callbackUrl={callbackUrl ?? "/documents"} initialError={mapError(error)} />
    </main>
  );
}

/**
 * Auth.js reports OAuth failures as opaque codes in the query string. Map the ones a new user can hit
 * to human sentences; anything else gets a generic fallback.
 */
function mapError(code: string | undefined): string | null {
  if (code === undefined) return null;

  switch (code) {
    case "OAuthAccountNotLinked":
      return "That email is already registered with a password. Sign in with your password instead.";
    default:
      return "Something went wrong. Please try again.";
  }
}
