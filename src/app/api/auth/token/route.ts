import { SignJWT } from "jose";
import { NextResponse } from "next/server";

import { auth } from "@/auth";

/**
 * The token exchange (DECISIONS.md D-001b).
 *
 * The backend is a different origin and cannot read Auth.js's session cookie. So this route trades a
 * valid session for a short-lived HS256 access token that the backend verifies with `jose`.
 *
 *      session cookie  (long-lived, httpOnly, SameSite=Lax — the refresh token in all but name)
 *              │
 *              ▼  this route
 *      access token    (15 minutes, held in memory, sent to the backend as a bearer)
 *
 * Two properties matter and are easy to get wrong:
 *
 * 1. **The token is never persisted in the browser.** It goes to the caller and lives in a closure.
 *    An XSS that can read `localStorage` owns the account for as long as the token lasts *and* can
 *    exfiltrate it; a token in a closure dies with the tab.
 *
 * 2. **It expires in 15 minutes.** The cookie can be long-lived because it is `httpOnly` and useless
 *    to script. The bearer token is *not* protected that way, so its lifetime is the blast radius of
 *    a leak — and 15 minutes is a survivable one. The client silently re-mints from the cookie.
 */

const SECRET = new TextEncoder().encode(process.env["API_JWT_SECRET"] ?? "");
const ISSUER = process.env["API_JWT_ISSUER"] ?? "vellum-web";
const AUDIENCE = process.env["API_JWT_AUDIENCE"] ?? "vellum-api";

export async function GET(): Promise<NextResponse> {
  const session = await auth();

  if (session?.user?.id === undefined || session.user.email === null) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  /**
   * Sign with HS256 and pin the algorithm on both sides.
   *
   * The backend's verifier pins `algorithms: ["HS256"]` too. Without that pin, a token whose header
   * says `"alg": "none"` is a token the attacker writes themselves — the single most exploited JWT
   * mistake there is. It is prevented by one line on each side, and both lines exist.
   */
  const token = await new SignJWT({ email: session.user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(SECRET);

  return NextResponse.json(
    { token, expiresIn: 900 },
    {
      // Never cached. A CDN or a shared browser cache holding somebody's bearer token is exactly the
      // kind of thing that ends up in a postmortem.
      headers: { "Cache-Control": "no-store, private" },
    },
  );
}
