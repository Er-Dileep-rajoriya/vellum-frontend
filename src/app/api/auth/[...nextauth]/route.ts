import { handlers } from "@/auth";

/**
 * Auth.js's own route handlers: sign-in, callback, sign-out, CSRF, session.
 *
 * Note the path: `/api/auth/[...nextauth]`. The token-exchange route at `/api/auth/token` is a
 * *sibling*, and Next's routing gives a static segment precedence over a catch-all — so `token` is
 * ours and everything else is Auth.js's.
 */
export const { GET, POST } = handlers;
