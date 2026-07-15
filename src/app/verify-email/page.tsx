import Link from "next/link";

import { VerifyEmailForm } from "@/components/auth/VerifyEmailForm";

export default async function VerifyEmailPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6">
      <Link href="/" className="mb-8 text-sm font-medium text-muted-foreground">
        Vellum
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight">Verify your email</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        We sent a 6-digit code to your inbox. Enter it below to activate your account.
      </p>

      <VerifyEmailForm initialEmail={email ?? ""} />
    </main>
  );
}
