import { NextResponse } from "next/server";

import { auth } from "@/auth";

/**
 * Route protection.
 *
 * This is a **convenience**, not a security boundary, and it is important to be honest about which.
 * The actual authorization happens in the backend, on every request, against the database — a user
 * who bypasses this middleware entirely reaches an API that will still refuse them. What this does is
 * stop a signed-out user from loading an editor shell that would immediately 401 on every call.
 *
 * Treating middleware as the security boundary is a well-known way to ship a hole: it runs at the
 * edge, it can be skipped by a direct API call, and it has no idea whether *this* user may read
 * *that* document. That question is answered in `accessRepository.authorize`, and only there.
 */
export default auth((request) => {
  const isAuthenticated = request.auth?.user?.id !== undefined;
  const { pathname } = request.nextUrl;

  const isProtected = pathname.startsWith("/documents");

  if (isProtected && !isAuthenticated) {
    const url = new URL("/login", request.nextUrl.origin);
    // Preserve where they were going, so signing in lands them on the document they clicked rather
    // than dumping them on a generic dashboard.
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = {
  /**
   * Skip static assets and Auth.js's own routes. Running auth middleware on `/api/auth/*` would make
   * signing in require being signed in.
   */
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
