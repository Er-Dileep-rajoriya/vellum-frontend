import "server-only";

import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/serverEnv";

/**
 * Forward a browser request to a service-token-protected backend auth endpoint.
 *
 * The browser cannot call these endpoints directly: they require the SERVICE_TOKEN, which can mint
 * users and reset passwords and therefore must never reach a client bundle. Every OTP/verify/reset
 * route handler is the same three lines — validate, forward, relay — so the forward lives here once.
 *
 * `server-only` guarantees this module (and the token it reads) can never be imported into a client
 * component: doing so is a build error, not a runtime leak.
 *
 * The backend's own message is passed through ONLY for 400s (they are user-actionable: "that code
 * has expired", "please wait a moment"). Anything else collapses to a generic message so an internal
 * error string never reaches the browser.
 */
export async function forwardToBackend(
  path: string,
  body: unknown,
  fallbackMessage: string,
): Promise<NextResponse> {
  // Read at request time, not module scope — a module-scope throw fails the Vercel build instead of
  // the one request that needed the variable (see serverEnv.ts for the incident this prevents).
  const response = await fetch(`${serverEnv.backendUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Service-Token": serverEnv.serviceToken,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (response.ok) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const parsed = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;

  const message =
    response.status === 400
      ? (parsed?.error?.message ?? fallbackMessage)
      : fallbackMessage;

  // Normalise everything that is not a clean 400 to 400 for the client — the browser only needs
  // "your input was rejected, here is why", not the backend's internal status taxonomy.
  return NextResponse.json({ error: message }, { status: response.status === 400 ? 400 : 502 });
}
