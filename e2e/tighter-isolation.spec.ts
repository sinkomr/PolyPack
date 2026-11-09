import { expect, test } from "@playwright/test";

// A page that is not cross-origin isolated (an app's built-in browser, a proxy) cannot run space
// problems: one already queued says so, cannot be evolved, and an isolated page still compacts it.

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

test("a space problem on a page that is not isolated says so and cannot be evolved", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: false, configurable: true }),
  );
  await dealCube(page);
  await expect(page.locator("#t-problem-note")).toHaveText(/This problem can't run on this page\./);
  await expect(page.locator("#t-evolve")).toBeDisabled();
  await expect(page.locator("#t-evolve")).toHaveAttribute("title", /can't run on this page/);
});

test("in another site's frame the note says how to move the save", async ({ page }) => {
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
  await expect(game.locator("#t-problem-note")).toHaveText(/embedded in another site\. To play it, Export your save/);
  await expect(game.locator("#t-evolve")).toBeDisabled();
});

test("on an isolated page the same space problem compacts on one click", async ({ page }) => {
  await dealCube(page);
  await expect(page.locator("#t-problem-note")).not.toHaveText(/can't run on this page/);
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)");
  await page.click("#t-evolve");
  await expect(page.locator("#t-evolve")).not.toHaveText(/compacts first/, { timeout: 60_000 });
});
