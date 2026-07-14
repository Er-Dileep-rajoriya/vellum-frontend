import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";

/**
 * Auth.js configuration.
 *
 * This service owns the **session**. It does not own the **user** — it has no database access at all.
 * User records are created and verified by the backend through service-token endpoints, so Postgres
 * sits behind exactly one process and the tenant-isolation claim in D-011 is auditable rather than
 * aspirational. (DECISIONS.md D-001b.)
 *
 * The session strategy is `jwt`, not `database`. That is forced by the same constraint: a database
 * session strategy needs an adapter, and an adapter needs a database.
 */

const BACKEND_URL = process.env["BACKEND_URL"] ?? "http://localhost:4000";
const SERVICE_TOKEN = process.env["SERVICE_TOKEN"] ?? "";

const CredentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

interface BackendUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

async function callBackend<T>(path: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The service token. Powerful (it can mint users), so it lives only on the server — this file
      // never runs in the browser, and the value is never in a NEXT_PUBLIC_ variable.
      "X-Service-Token": SERVICE_TOKEN,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) return null;
  return (await response.json()) as T;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },

  pages: {
    signIn: "/login",
    error: "/login",
  },

  providers: [
    Google({
      clientId: process.env["GOOGLE_CLIENT_ID"] ?? "",
      clientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",
      // Google's email is verified by Google. That is what makes it safe to use as the join key when
      // linking a Google sign-in to an existing password account — an *unverified* email as a join
      // key would be an account-takeover primitive.
      allowDangerousEmailAccountLinking: false,
    }),

    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },

      async authorize(raw) {
        const parsed = CredentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        // The backend verifies. It returns the SAME error and burns the SAME CPU whether the user
        // exists or the password is wrong — the two enumeration defences live there, not here,
        // because here is a client of that decision, not the owner of it.
        const result = await callBackend<{ user: BackendUser }>("/api/internal/users/verify", {
          email: parsed.data.email,
          password: parsed.data.password,
        });

        if (result === null) return null;

        return {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          image: result.user.image,
        };
      },
    }),
  ],

  callbacks: {
    /**
     * OAuth: upsert the user in the backend, and adopt the id it returns.
     *
     * Returning `false` here aborts the sign-in. If the backend is down we do NOT let the user in
     * with a Google-shaped identity that has no corresponding row — they would get a session whose
     * `userId` matches nothing, and every document query would return an empty list while looking
     * perfectly logged in. Failing the sign-in is the honest outcome.
     */
    async signIn({ user, account }) {
      if (account?.provider !== "google") return true;
      if (user.email === null || user.email === undefined) return false;

      const result = await callBackend<{ user: BackendUser }>("/api/internal/users/oauth", {
        email: user.email,
        name: user.name ?? undefined,
        image: user.image ?? undefined,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
      });

      if (result === null) return false;

      // Adopt the BACKEND's user id. Google's `sub` is not our primary key, and a session carrying
      // the wrong id would authorise against documents that do not exist.
      user.id = result.user.id;
      return true;
    },

    jwt({ token, user }) {
      if (user?.id !== undefined) token.sub = user.id;
      return token;
    },

    session({ session, token }) {
      if (token.sub !== undefined) session.user.id = token.sub;
      return session;
    },
  },

  trustHost: true,
});
