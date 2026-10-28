import { expect, test } from "@playwright/test";

// A space problem on the Tighter board, reached through the development build's cheats (Settings)
// without a reset: the site's own drawing replaces the polygon canvas, and the score box fits it.

test("a dealt sphere problem is drawn with the space view and the score box has no density", async ({ page }) => {
  await page.goto("/tighter.html?seed=7&tutorial=off");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/tighter.html?seed=7&tutorial=off");
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });

  await page.click("#t-open-settings");
  await page.fill("#t-cheat-space", "sphere/0/12");
  await page.getByRole("button", { name: "Deal it" }).click();
  await expect(page.locator("#t-cheat-note")).toHaveText("Dealt sphere/0/12.", { timeout: 30_000 });
  await page.keyboard.press("Escape");

  await expect(page.locator("#t-space-board")).toBeVisible();
  await expect(page.locator("#board")).toBeHidden();
  // the drawing is there, its own toolbar is not shown
  await expect(page.locator("#t-space-board .space-draw canvas, #t-space-board .space-draw svg").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("#t-space-board .space-tools")).toBeHidden();
  await expect(page.locator("#t-side-label")).toHaveText("Radius ρ");
  await expect(page.locator("#t-side")).not.toHaveText("—");
  await expect(page.locator("#t-density")).toBeHidden();
});

// Evolve on a space problem runs the space worker: the evaluations run rise with each click and the
// drawing stays on the board.

test("Evolve on a dealt sphere problem runs evaluations and keeps the board drawn", async ({ page }) => {
  await page.goto("/tighter.html?seed=7&tutorial=off");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/tighter.html?seed=7&tutorial=off");
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });

  await page.click("#t-open-settings");
  await page.fill("#t-cheat-space", "sphere/0/12");
  await page.getByRole("button", { name: "Deal it" }).click();
  await expect(page.locator("#t-cheat-note")).toHaveText("Dealt sphere/0/12.", { timeout: 30_000 });
  await page.keyboard.press("Escape");
  const drawing = page.locator("#t-space-board .space-draw canvas, #t-space-board .space-draw svg").first();
  await expect(drawing).toBeVisible({ timeout: 30_000 });

  const evals = async () => Number((await page.locator("#t-bar-evals").innerText()).replace(/[^0-9]/g, "") || "0");
  const before = await evals();
  for (let i = 0; i < 3; i++) {
    await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
    await page.click("#t-evolve");
  }
  await expect.poll(evals, { timeout: 60_000 }).toBeGreaterThan(before);
  await expect(drawing).toBeVisible();
  await expect(page.locator("#t-side")).not.toHaveText("—");
});
