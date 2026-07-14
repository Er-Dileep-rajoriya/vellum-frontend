import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * Registration proxy.
 *
 * The browser cannot call the backend's `/internal/users/register` directly — that endpoint requires
 * the **service token**, which can mint users and therefore must never be shipped to a browser. So
 * the request goes through this route handler, which runs on the server, holds the token, and
 * forwards.
 *
 * This is the whole reason the frontend has a server at all in the auth flow: it is the only place
 * that can hold a credential the client is not allowed to see.
 */

const RegisterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(12).max(200),
});

const BACKEND_URL = process.env["BACKEND_URL"] ?? "http://localhost:4000";
const SERVICE_TOKEN = process.env["SERVICE_TOKEN"] ?? "";

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = RegisterSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the details and try again." }, { status: 400 });
  }

  const response = await fetch(`${BACKEND_URL}/api/internal/users/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Service-Token": SERVICE_TOKEN,
    },
    body: JSON.stringify(parsed.data),
    cache: "no-store",
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;

    // Pass the backend's message through for the duplicate-account case (it is genuinely useful:
    // "you already have an account"), but never leak an internal error string.
    const message =
      response.status === 400
        ? (error?.error?.message ?? "Could not create your account.")
        : "Could not create your account.";

    return NextResponse.json({ error: message }, { status: response.status === 400 ? 400 : 500 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
