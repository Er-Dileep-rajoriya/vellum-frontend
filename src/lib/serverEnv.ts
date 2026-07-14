import "server-only";

/**
 * Server-side configuration, read once, with **no defaults**.
 *
 * Every value here used to have a convenience fallback — `?? "http://localhost:4000"`, `?? ""` — and that
 * convenience produced a live incident that took a while to read, because none of the symptoms pointed at
 * configuration:
 *
 *   - Deployed to Vercel with no `BACKEND_URL`, the sign-up route fetched `http://localhost:4000`. In a
 *     serverless function `localhost` is *the function's own container*; there is no backend there. Every
 *     registration returned an opaque **500** with nothing in it to suggest a missing variable.
 *   - `API_JWT_SECRET ?? ""` is worse, and would have been far more expensive to find: it does not fail.
 *     It **signs access tokens with an empty secret**. The tokens are produced, sent, and rejected by the
 *     backend as unauthorized — so the investigation starts in the auth code, which is correct, while the
 *     actual cause is an unset environment variable one layer up.
 *
 * A default is a decision. `?? "localhost"` is the decision "if you forget to configure me, quietly talk
 * to the wrong machine" — and it is never the decision anyone actually wanted. Failing closed turns a
 * silent misconfiguration into one loud message that names the variable.
 *
 * `server-only` at the top is a second, harder guarantee: importing this from a client component is a
 * *build* error, so the secrets below cannot be pulled into a browser bundle by an accident of import.
 */
function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Refusing to fall back to a default — a wrong default is harder to debug than a missing value.`,
    );
  }

  return value;
}

/**
 * Read lazily, not at module scope.
 *
 * A throw at module scope runs during Next's build-time page-data collection, so a missing variable fails
 * the *build* with a stack trace rather than failing the request that needed it with a clear message. It
 * also means a route that does not use a given secret is not held hostage by it.
 */
export const serverEnv = {
  /** The API, server-side. The browser never sees this — it uses NEXT_PUBLIC_API_URL. */
  get backendUrl(): string {
    return required("BACKEND_URL");
  },

  /** Service-to-service secret. The frontend has no database of its own; this is how it reaches the API. */
  get serviceToken(): string {
    return required("SERVICE_TOKEN");
  },

  /** Signs the short-lived access token the browser holds in memory (never in localStorage). */
  get apiJwtSecret(): string {
    return required("API_JWT_SECRET");
  },

  get apiJwtIssuer(): string {
    return process.env["API_JWT_ISSUER"] ?? "vellum-web";
  },

  get apiJwtAudience(): string {
    return process.env["API_JWT_AUDIENCE"] ?? "vellum-api";
  },
} as const;
