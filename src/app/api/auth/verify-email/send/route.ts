import { NextResponse } from "next/server";
import { z } from "zod";

import { forwardToBackend } from "@/lib/authProxy";

/** Resend an email-verification code. Proxies to the service-token backend. */

const Schema = z.object({ email: z.email().max(254) });

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = Schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  return forwardToBackend(
    "/api/internal/auth/verify-email/send",
    parsed.data,
    "Could not send a verification code.",
  );
}
