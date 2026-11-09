import { expect, test } from "@playwright/test";

// A page that is not cross-origin isolated (an app's built-in browser, a proxy) cannot share memory
// with the solver, so it runs space problems as chains of shorter runs, after a notice that says so.
// An isolated page runs them in one piece and shows no notice.

// The embedded test's portal is fulfilled by the test, so Chrome counts it as public and would block
// its frame on localhost (Local Network Access); a real portal and the live game are both public.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });

async function dealCube(page: import("@playwright/test").Page) {
  await page.goto("/tighter.html?seed=7&tutorial=off");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/tighter.html?seed=7&tutorial=off");
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await page.click("#t-open-settings");
  await page.fill("#t-cheat-space", "surface/cube/fold/33/70");
  await page.getByRole("button", { name: "Deal it" }).click();
  await expect(page.locator("#t-cheat-note")).toHaveText(/Dealt|could|not/, { timeout: 30_000 });
  await page.keyboard.press("Escape");
}

const notIsolated = (page: import("@playwright/test").Page) =>
  page.addInitScript(() =>
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: false, configurable: true }),
  );

const DIRECT =
  /For the full solver, open polypack\.fly\.dev\/tighter\.html directly in Chrome, Edge, Firefox or Safari/;

test("a space problem on a page that is not isolated runs as a chain, after a notice", async ({ page }) => {
  await notIsolated(page);
  await dealCube(page);
  await expect(page.locator("#t-problem-note")).not.toHaveText(/can't run/);
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)");
  await page.click("#t-evolve");
  const notice = page.locator("#t-chain-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice.locator("h2")).toHaveText("Slower solver on this page");
  await expect(notice).toContainText("This page can't share memory with the solver.");
  await expect(notice.locator("#t-chain-more")).toHaveText(DIRECT);
  await page.click("#t-chain-ok");
  await expect(notice).toBeHidden();
  // the Compact is a chain of links that runs until its first finished packing
  await expect(page.locator("#t-evolve")).not.toHaveText(/compacts first/, { timeout: 240_000 });
});

test("Don't show this again keeps the notice away on the next chained run", async ({ page }) => {
  await notIsolated(page);
  await dealCube(page);
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  await page.click("#t-evolve");
  await expect(page.locator("#t-chain-notice")).toBeVisible({ timeout: 30_000 });
  await page.check("#t-chain-hide");
  await page.click("#t-chain-ok");
  await expect(page.locator("#t-evolve")).not.toHaveText(/compacts first/, { timeout: 240_000 });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("tighter-chain-notice-hidden")), { timeout: 10_000 })
    .toBe("1");
  await page.reload();
  await expect(page.locator("#t-title")).toHaveText(/folded over its edges/, { timeout: 30_000 });
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  await page.click("#t-evolve");
  // a run opens on the click, as the first one did; this time without the notice
  await page.waitForTimeout(5000);
  await expect(page.locator("#t-chain-notice")).toBeHidden();
});

test("in another site's frame the notice says how to move the save", async ({ page }) => {
  // a game portal embeds the game in a frame of a page that is not isolated (galaxy.click, 2026-11-08)
  // the portal is another site (127.0.0.1, not localhost), served without isolation headers
  await page.route("http://127.0.0.1:5174/portal", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<body style="margin:0"><iframe id="game" src="http://localhost:5174/tighter.html?seed=7&tutorial=off" style="border:0;width:100vw;height:100vh"></iframe></body>',
    }),
  );
  await page.goto("http://127.0.0.1:5174/portal");
  const game = page.frameLocator("#game");
  await expect(game.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await game.locator("#t-open-settings").click();
  await game.locator("#t-cheat-space").fill("surface/cube/fold/33/70");
  await game.getByRole("button", { name: "Deal it" }).click();
  await expect(game.locator("#t-cheat-note")).toHaveText(/Dealt|could|not/, { timeout: 30_000 });
  await game.locator("body").press("Escape");
  await expect(game.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  await game.locator("#t-evolve").click();
  const notice = game.locator("#t-chain-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice.locator("#t-chain-more")).toHaveText(
    "For the full solver, Export your save in Settings, open polypack.fly.dev/tighter.html, and Import the save there.",
  );
});

test("on an isolated page the same space problem compacts on one click, with no notice", async ({ page }) => {
  await dealCube(page);
  await expect(page.locator("#t-problem-note")).not.toHaveText(/can't run/);
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)");
  await page.click("#t-evolve");
  await expect(page.locator("#t-evolve")).not.toHaveText(/compacts first/, { timeout: 60_000 });
  await expect(page.locator("#t-chain-notice")).toBeHidden();
});
