import { NextResponse } from "next/server";
import { z } from "zod";

import { forwardToBackend } from "@/lib/authProxy";

/** Confirm an email-verification code. On success the backend marks the address verified. */

const Schema = z.object({
  email: z.email().max(254),
  code: z.string().regex(/^\d{6}$/),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = Schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 400 });
  }

  return forwardToBackend(
    "/api/internal/auth/verify-email/confirm",
    parsed.data,
    "Could not verify that code.",
  );
}
