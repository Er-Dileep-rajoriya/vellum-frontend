
import { VerifyEmailForm } from "@/components/auth/VerifyEmailForm";

export default async function VerifyEmailPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ email?: string; callbackUrl?: string }>;
}) {
  const { email, callbackUrl } = await searchParams;

  return (
    <main className="mx-auto flex flex-1 w-full max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Verify your email</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        We sent a 6-digit code to your inbox. Enter it below to activate your account.
      </p>

      <VerifyEmailForm initialEmail={email ?? ""} callbackUrl={callbackUrl} />
    </main>
  );
}
