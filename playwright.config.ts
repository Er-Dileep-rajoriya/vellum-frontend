import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against a PRODUCTION build of the frontend and a REAL backend, with a REAL Postgres.
 *
 * Dev mode double-invokes effects (StrictMode), skips optimisations, and behaves differently around
 * hydration — all of which hide exactly the class of bug a local-first app is prone to (an effect
 * that runs twice happily papers over a missing dependency, and the bug then only appears for users).
 *
 * The backend is started here too, because the auth setup signs in for real. A mocked session cookie
 * would let an auth bug hide behind a fixture.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] !== undefined ? 2 : 0,
  reporter: process.env["CI"] !== undefined ? "github" : "list",

  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
  },

  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Every test starts signed in, with a session obtained by driving the real login form.
        storageState: "e2e/.auth/session.json",
      },
      dependencies: ["setup"],
    },
  ],

  webServer: [
    {
      command: "pnpm --dir ../backend exec tsx src/main.ts",
      url: "http://127.0.0.1:4000/health",
      reuseExistingServer: process.env["CI"] === undefined,
      timeout: 120_000,
    },
    {
      command: "pnpm exec next start --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: process.env["CI"] === undefined,
      timeout: 120_000,
    },
  ],
});
