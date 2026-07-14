import type { TokenProvider } from "@/services/transport";

/**
 * The access-token provider.
 *
 * The token lives **in this closure and nowhere else** — not in `localStorage`, not in
 * `sessionStorage`, not in a cookie readable by script. An XSS that can read `localStorage` owns the
 * account and can exfiltrate the token; a token in a closure dies with the tab. That is the entire
 * reason this is a module-scoped variable rather than a convenient little storage wrapper.
 *
 * It is refreshed from the Auth.js session cookie, which IS long-lived — but is `httpOnly` and
 * therefore useless to an injected script.
 */

interface CachedToken {
  readonly token: string;
  /** Epoch millis. */
  readonly expiresAt: number;
}

let cached: CachedToken | null = null;
/**
 * The in-flight refresh.
 *
 * Without this, a page that fires five requests at once when the token has just expired mints five
 * tokens — five round trips, five signatures, and a thundering herd against the session endpoint on
 * every reconnect. Sharing one promise makes concurrent callers wait for the same refresh.
 */
let inflight: Promise<string> | null = null;

/** Refresh 60s early. A token that expires *while in flight* is a 401 the user did nothing to earn. */
const REFRESH_MARGIN_MS = 60_000;

export const getAccessToken: TokenProvider = async (): Promise<string> => {
  const now = Date.now();

  if (cached !== null && cached.expiresAt - REFRESH_MARGIN_MS > now) {
    return cached.token;
  }

  if (inflight !== null) return inflight;

  inflight = (async () => {
    try {
      const response = await fetch("/api/auth/token", {
        cache: "no-store",
        credentials: "same-origin",
      });

      if (!response.ok) {
        cached = null;
        // A 401 here means the session is gone. Throwing is correct: the sync engine treats it as
        // non-retryable and stops hammering the endpoint, and the editor keeps working offline —
        // which is a *degraded* mode, not an outage. The user's writing is still safe on this device.
        throw new Error("not authenticated");
      }

      const body = (await response.json()) as { token: string; expiresIn: number };

      cached = {
        token: body.token,
        expiresAt: Date.now() + body.expiresIn * 1_000,
      };

      return body.token;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
};

/** Called on sign-out. A token that outlives the session is a token that still works. */
export function clearAccessToken(): void {
  cached = null;
  inflight = null;
}
