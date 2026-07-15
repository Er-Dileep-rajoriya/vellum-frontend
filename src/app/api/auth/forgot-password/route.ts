import { NextResponse } from "next/server";
import { z } from "zod";

import { forwardToBackend } from "@/lib/authProxy";

/**
 * Begin a password reset. The backend always answers 200 whether or not the address has an account —
 * that uniform response is the enumeration defence, so this proxy must not add one of its own.
 */

const Schema = z.object({ email: z.email().max(254) });

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = Schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  return forwardToBackend(
    "/api/internal/auth/password/forgot",
    parsed.data,
    "Could not start a password reset.",
  );
}
