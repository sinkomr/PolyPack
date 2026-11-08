import { expect, test } from "@playwright/test";

// A page that is not cross-origin isolated (an app's built-in browser, a proxy) cannot run space
// problems: one already queued says so, cannot be evolved, and an isolated page still compacts it.

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

test("on an isolated page the same space problem compacts on one click", async ({ page }) => {
  await dealCube(page);
  await expect(page.locator("#t-problem-note")).not.toHaveText(/can't run on this page/);
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)");
  await page.click("#t-evolve");
  await expect(page.locator("#t-evolve")).not.toHaveText(/compacts first/, { timeout: 60_000 });
});
