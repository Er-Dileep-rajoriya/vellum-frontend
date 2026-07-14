import { expect, test, type Page } from "@playwright/test";

/**
 * Cross-tab and undo, in a real browser.
 *
 * These two features share a property that makes them worth an E2E rather than only a unit test: both
 * are about what happens *between* two things — two tabs, or a user and a collaborator — and both fail
 * in ways that a single-context test cannot see.
 */

async function openNewDocument(page: Page): Promise<string> {
  await page.goto("/documents");
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/documents\/[a-z0-9]+/i, { timeout: 20_000 });

  const url = page.url();
  return url.slice(url.lastIndexOf("/") + 1);
}

test.describe("cross-tab", () => {
  /**
   * Two tabs, ONE browser, and NO server.
   *
   * The operations never touch the network — they go over BroadcastChannel, in under a millisecond.
   * If this only worked via the server, typing in one tab and watching a second tab of the same
   * browser would require a round trip, which is absurd: the data is already on the device.
   */
  test("a second tab sees the first tab's typing, with the network severed", async ({ context }) => {
    const first = await context.newPage();
    const documentId = await openNewDocument(first);

    const second = await context.newPage();
    await second.goto(`/documents/${documentId}`);
    await expect(second.locator("[data-block-id] [contenteditable]").first()).toBeVisible();

    // Cut the backend off from BOTH tabs. Anything that crosses between them now is going over
    // BroadcastChannel, not the wire.
    for (const page of [first, second]) {
      await page.route("**/localhost:4000/**", (route) => route.abort("internetdisconnected"));
      await page.route("**/127.0.0.1:4000/**", (route) => route.abort("internetdisconnected"));
    }

    await first.bringToFront();
    const block = first.locator("[data-block-id] [contenteditable]").first();
    await block.click();
    await first.keyboard.type("Typed in tab one.");

    // Appears in tab two, with no server in the loop at all.
    await expect(second.locator("[data-block-id] [contenteditable]").first()).toHaveText(
      "Typed in tab one.",
      { timeout: 10_000 },
    );

    await first.close();
    await second.close();
  });
});

test.describe("presence", () => {
  /**
   * A live remote caret, drawn from a real WebSocket presence frame.
   *
   * The caret is measured against the real text with a DOM Range and drawn in an overlay — never
   * injected into the contenteditable, which would corrupt the offsets the editor reads from the
   * selection and be clobbered by the next render from the CRDT.
   */
  test("a collaborator's caret and name appear in the document", async ({ context }) => {
    const alice = await context.newPage();
    const documentId = await openNewDocument(alice);

    const aliceBlock = alice.locator("[data-block-id] [contenteditable]").first();
    await aliceBlock.click();
    await alice.keyboard.type("Shared paragraph.");

    const bob = await context.newPage();
    await bob.goto(`/documents/${documentId}`);
    const bobBlock = bob.locator("[data-block-id] [contenteditable]").first();
    await expect(bobBlock).toHaveText("Shared paragraph.", { timeout: 20_000 });

    // Bob places his caret. Presence is published over the WebSocket, throttled to 150ms.
    await bobBlock.click();
    await bob.keyboard.press("End");

    // Alice sees Bob's name flag on his caret. Both tabs share a session, so the name is the local
    // part of the email — presence deliberately never carries the address itself.
    await alice.bringToFront();
    await expect(alice.locator("[aria-hidden] >> text=/e2e-/").first()).toBeVisible({
      timeout: 20_000,
    });

    await alice.close();
    await bob.close();
  });
});

test.describe("undo", () => {
  test("Ctrl+Z undoes the last edit, Ctrl+Shift+Z redoes it", async ({ page }) => {
    await openNewDocument(page);

    const block = page.locator("[data-block-id] [contenteditable]").first();
    await block.click();
    await page.keyboard.type("hello");
    await expect(block).toHaveText("hello");

    await page.keyboard.press("ControlOrMeta+z");
    // Each keystroke is its own undo entry, so one Ctrl+Z removes one character.
    await expect(block).toHaveText("hell");

    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(block).toHaveText("hello");
  });

  /**
   * THE test.
   *
   * Two tabs are two replicas. Tab two types; tab one presses Ctrl+Z.
   *
   * Tab one's undo must revert **tab one's** edit and leave tab two's alone. An undo built on "reverse
   * the document's most recent operation" reverts the *other* replica's text — and the person in tab
   * two watches their sentence vanish under their cursor. That is not undo; it is a remote-controlled
   * delete, and only a two-context test can catch it.
   */
  test("undo reverts only the local user's edit, never a collaborator's", async ({ context }) => {
    const alice = await context.newPage();
    const documentId = await openNewDocument(alice);

    const aliceBlock = alice.locator("[data-block-id] [contenteditable]").first();
    await aliceBlock.click();
    await alice.keyboard.type("AAA");
    await expect(aliceBlock).toHaveText("AAA");

    // Bob opens the same document in a second tab and appends. His edit is now the document's most
    // recent operation.
    const bob = await context.newPage();
    await bob.goto(`/documents/${documentId}`);
    const bobBlock = bob.locator("[data-block-id] [contenteditable]").first();
    await expect(bobBlock).toHaveText("AAA", { timeout: 15_000 });

    await bobBlock.click();
    await bob.keyboard.press("End");
    await bob.keyboard.type("BBB");
    await expect(bobBlock).toHaveText("AAABBB");

    // Alice sees Bob's text, then presses Ctrl+Z.
    await alice.bringToFront();
    await expect(aliceBlock).toHaveText("AAABBB", { timeout: 15_000 });

    await aliceBlock.click();
    await alice.keyboard.press("ControlOrMeta+z");

    // Alice's last character is gone. Bob's "BBB" is NOT.
    await expect(aliceBlock).toHaveText(/BBB/, { timeout: 10_000 });
    await expect(aliceBlock).not.toHaveText("AAABBB");

    await alice.close();
    await bob.close();
  });
});
