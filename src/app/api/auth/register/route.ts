import { NextResponse } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/lib/serverEnv";

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

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = RegisterSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the details and try again." }, { status: 400 });
  }

  // Read at request time, not at module scope: on Vercel a module-scope throw happens during the build's
  // page-data collection, which fails the *build* with a stack trace instead of the deployment with a
  // clear message. Here it fails the one request that needed it, and logs the variable's name.
  const backendUrl = serverEnv.backendUrl;
  const serviceToken = serverEnv.serviceToken;

  const response = await fetch(`${backendUrl}/api/internal/users/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Service-Token": serviceToken,
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
