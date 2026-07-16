import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { InviteAccept } from "@/components/invitations/InviteAccept";

/**
 * The invitation-acceptance route.
 *
 * Reached from the link in an invitation email. It is NOT under `/documents`, so the middleware does
 * not guard it — auth is handled here instead, because the flow is deliberately different: a signed-out
 * invitee (who may not even have an account yet) is sent to sign in / sign up, with `callbackUrl`
 * carrying them straight back here afterward. Once signed in, the client island fetches the invitation
 * and offers Accept / Decline — accepting is the only thing that grants access.
 */
export default async function InvitePage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const session = await auth();
  if (session?.user?.id === undefined) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-12">
      <InviteAccept token={token} />
    </main>
  );
}
