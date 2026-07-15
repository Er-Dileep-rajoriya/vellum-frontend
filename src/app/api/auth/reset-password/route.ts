import { NextResponse } from "next/server";
import { z } from "zod";

import { forwardToBackend } from "@/lib/authProxy";

/** Complete a password reset: code + new password. The backend verifies the code and sets both. */

const Schema = z.object({
  email: z.email().max(254),
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(12).max(200),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = Schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the code and password and try again." }, { status: 400 });
  }

  return forwardToBackend(
    "/api/internal/auth/password/reset",
    parsed.data,
    "Could not reset your password.",
  );
}
