import Link from "next/link";

import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export default async function ResetPasswordPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ email?: string; sent?: string }>;
}) {
  const { email, sent } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6">
      <Link href="/" className="mb-8 text-sm font-medium text-muted-foreground">
        Vellum
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter the code from your email and choose a new password.
      </p>

      <ResetPasswordForm initialEmail={email ?? ""} sent={sent !== undefined} />

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Need a code?{" "}
        <Link
          href="/forgot-password"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Request one
        </Link>
      </p>
    </main>
  );
}
