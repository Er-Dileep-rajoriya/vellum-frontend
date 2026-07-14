import { expect, test as setup } from "@playwright/test";

/**
 * Sign in once, for real, and save the session for every other test.
 *
 * This is not a mock and it does not stub the session cookie. It drives the actual form: register →
 * Auth.js credentials provider → backend `verify` → scrypt → session cookie. If any link in that
 * chain breaks, every test in the suite fails, which is exactly what should happen — an auth bug
 * should not be able to hide behind a fixture.
 */

const STATE_PATH = "e2e/.auth/session.json";

setup("authenticate", async ({ page }) => {
  // A unique user per run. Sharing one would make the suite order-dependent and would fail on the
  // second run against the same database ("account already exists").
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;

  await page.goto("/login");

  await page.getByRole("button", { name: "Sign up" }).click();

  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery-staple");

  await page.getByRole("button", { name: "Create account" }).click();

  // Landing on /documents proves the whole loop: the account was created, the credentials verified
  // against a real scrypt hash, and Auth.js issued a session cookie the middleware accepts.
  await expect(page).toHaveURL(/\/documents/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

  await page.context().storageState({ path: STATE_PATH });
});
