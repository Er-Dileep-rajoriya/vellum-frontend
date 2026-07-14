import { expect, test, type Page } from "@playwright/test";

/**
 * The end-to-end proof of the product's central claim.
 *
 * Everything else — the CRDT property tests, the sync engine tests — is a unit-level argument. This is
 * the only test that exercises the promise a user is actually being made:
 *
 *      "Type with no internet. Reload. Your work is still there."
 *
 * These tests sign in for real (see auth.setup.ts) and then **sever the connection to the backend**
 * mid-session. That is a more honest test than never starting a backend at all: it is the actual
 * failure a user experiences — logged in, working, and then the train enters a tunnel.
 */

/** Cut the backend off at the knees. Every request to it fails, exactly as it would offline. */
async function goOffline(page: Page): Promise<void> {
  await page.route("http://localhost:4000/**", (route) => route.abort("internetdisconnected"));
  await page.route("http://127.0.0.1:4000/**", (route) => route.abort("internetdisconnected"));
}

/** Create a real document through the real API, and open it. */
async function openNewDocument(page: Page): Promise<string> {
  await page.goto("/documents");
  await page.getByRole("button", { name: "New document" }).click();

  await expect(page).toHaveURL(/\/documents\/[a-z0-9]+/i, { timeout: 20_000 });

  const url = page.url();
  return url.slice(url.lastIndexOf("/") + 1);
}

test.describe("local-first editing", () => {
  test("keeps working when the connection dies, and survives a reload", async ({ page }) => {
    const documentId = await openNewDocument(page);

    // The user is online, signed in, and working. Then the network goes.
    await goOffline(page);

    const block = page.locator("[data-block-id] [contenteditable]").first();
    await expect(block).toBeVisible();
    await block.click();
    await page.keyboard.type("This was typed after the connection died.");

    // Zero latency, no spinner, no blocking. The keystroke never touched the network.
    await expect(block).toHaveText("This was typed after the connection died.");

    /**
     * The UI must NOT claim "Saved".
     *
     * "Saved locally", "Offline", "Retrying" are all TRUE — the operations are durable in IndexedDB
     * and the server has not seen them. The one thing it must never say is the unqualified "Saved",
     * which is the lie this assertion exists to catch.
     */
    await expect(
      page.getByText(/Saved locally|Offline|Retrying|Reconnecting|couldn't be saved/i).first(),
    ).toBeVisible({ timeout: 15_000 });

    // The hard part. A full reload: nothing survives except IndexedDB.
    await page.reload();
    await goOffline(page);

    await expect(page.locator("[data-block-id] [contenteditable]").first()).toHaveText(
      "This was typed after the connection died.",
      { timeout: 15_000 },
    );

    expect(documentId).not.toBe("");
  });

  /**
   * The full round trip: type online, and prove the text reached Postgres by loading it in a
   * completely fresh browser context (new IndexedDB, so the ONLY possible source is the server).
   */
  test("syncs to the server, and a fresh device gets the document", async ({ page, browser }) => {
    const documentId = await openNewDocument(page);

    const block = page.locator("[data-block-id] [contenteditable]").first();
    await block.click();
    await page.keyboard.type("Synced through Postgres.");

    // Wait for the sync engine to actually report success — not a fixed sleep, which would be a
    // race dressed up as a test.
    await expect(page.getByText(/^Saved$/).first()).toBeVisible({ timeout: 20_000 });

    // A brand-new browser context: fresh IndexedDB, fresh everything, same session. If the text
    // appears here it can only have come from the server.
    const secondDevice = await browser.newContext({ storageState: "e2e/.auth/session.json" });
    const secondPage = await secondDevice.newPage();

    await secondPage.goto(`/documents/${documentId}`);

    await expect(secondPage.locator("[data-block-id] [contenteditable]").first()).toHaveText(
      "Synced through Postgres.",
      { timeout: 20_000 },
    );

    await secondDevice.close();
  });

  test("markdown shortcuts transform blocks", async ({ page }) => {
    await openNewDocument(page);
    await goOffline(page);

    const block = page.locator("[data-block-id] [contenteditable]").first();
    await block.click();

    // "## " must become a heading, and the "## " itself must be swallowed rather than left behind.
    await page.keyboard.type("## ");
    await page.keyboard.type("A heading");

    await expect(page.locator("h2[contenteditable]")).toHaveText("A heading");
  });

  test("does NOT transform a '#' typed mid-sentence", async ({ page }) => {
    await openNewDocument(page);
    await goOffline(page);

    const block = page.locator("[data-block-id] [contenteditable]").first();
    await block.click();

    // The bug this guards: text transforming while you write a sentence *about* markdown.
    await page.keyboard.type("issue # 42");

    await expect(block).toHaveText("issue # 42");
    await expect(page.locator("h1[contenteditable]")).toHaveCount(0);
  });

  test("Enter splits a block; Backspace at the start merges it back", async ({ page }) => {
    await openNewDocument(page);
    await goOffline(page);

    const first = page.locator("[data-block-id] [contenteditable]").first();
    await first.click();
    await page.keyboard.type("HelloWorld");

    for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");

    const blocks = page.locator("[data-block-id] [contenteditable]");
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(0)).toHaveText("Hello");
    await expect(blocks.nth(1)).toHaveText("World");

    await page.keyboard.press("Backspace");

    await expect(page.locator("[data-block-id] [contenteditable]")).toHaveCount(1);
    await expect(page.locator("[data-block-id] [contenteditable]").first()).toHaveText("HelloWorld");
  });

  test("the slash menu inserts a block type", async ({ page }) => {
    await openNewDocument(page);
    await goOffline(page);

    const block = page.locator("[data-block-id] [contenteditable]").first();
    await block.click();
    await page.keyboard.type("/");

    const menu = page.getByRole("listbox", { name: "Block types" });
    await expect(menu).toBeVisible();

    await page.keyboard.type("quote");
    await expect(menu.getByRole("option").first()).toContainText("Quote");

    await page.keyboard.press("Enter");

    await expect(page.locator("blockquote[contenteditable]")).toBeVisible();
    // The "/quote" the user typed must be gone. Leaving it behind is the kind of small bug that makes
    // a product feel unfinished.
    await expect(page.locator("blockquote[contenteditable]")).toHaveText("");
  });
});

test.describe("access control", () => {
  test("a signed-out visitor is redirected away from a document", async ({ browser }) => {
    // No storageState: a genuinely anonymous browser.
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await anonymous.newPage();

    await page.goto("/documents/some-document-id");

    await expect(page).toHaveURL(/\/login/);
    await anonymous.close();
  });
});
