import { expect, Page, test } from "@playwright/test";

// The tutorial on a first visit: squares in a square (9, 10, 11), ten clicks that shrink 12 hexagons in
// a pentagon, a teaser of finished packings in space, then the name pop-up and the game. It runs against
// the local end-to-end stack (playwright.config.ts). Its boards are never sent and pay no points.

const URL = "/tighter.html?seed=5";

async function freshVisit(page: Page, query = ""): Promise<void> {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL + query);
}

/** The side the hands-on step shows, from its status line. */
const shownSide = async (page: Page): Promise<number> =>
  Number(/Side ([\d.]+)/.exec((await page.locator("#t-tut-status").textContent()) ?? "")?.[1]);

test("a first visit walks the tutorial, then starts the game", async ({ page }) => {
  await freshVisit(page);
  const dialog = page.locator("#t-tutorial");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).tighter?.state.tutorialDone ?? false)).toBe(false);

  // 9, 10 and 11 squares
  await expect(page.locator("#t-tut-title")).toHaveText("Nine squares");
  await expect(page.locator("#t-tut-status")).toContainText("9 squares, side 3.000000", { timeout: 30_000 });
  await page.click("#t-tut-next");
  await expect(page.locator("#t-tut-title")).toHaveText("Ten squares");
  await page.click("#t-tut-next");
  await expect(page.locator("#t-tut-title")).toHaveText("Eleven squares");
  await page.click("#t-tut-next");

  // the hands-on step: Next waits for ten improvements, and each click shrinks the side
  await expect(page.locator("#t-tut-title")).toHaveText("Try it yourself");
  await expect(page.locator("#t-tut-next")).toBeDisabled();
  await expect(page.locator("#t-tut-act")).toBeEnabled({ timeout: 60_000 });
  let side = await shownSide(page);
  for (let k = 1; k <= 10; k++) {
    await page.click("#t-tut-act");
    await expect(page.locator("#t-tut-status")).toContainText(`${k} of 10`, { timeout: 60_000 });
    const now = await shownSide(page);
    expect(now).toBeLessThan(side);
    side = now;
    await expect(page.locator("#t-tut-act")).toBeEnabled();
  }
  await expect(page.locator("#t-tut-next")).toBeEnabled();
  await page.click("#t-tut-next");

  await expect(page.locator("#t-tut-title")).toHaveText("Now the game");
  await page.click("#t-tut-next");

  // the teaser: two finished packings in space, drawn by the site's space view
  await expect(page.locator("#t-tut-title")).toHaveText("What comes later");
  await expect(page.locator("#t-tut-text")).toContainText("After your first reset");
  await expect(page.locator("#t-tut-space-0 canvas")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#t-tut-space-1 canvas")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#t-tut-next")).toHaveText("Choose a name");
  await page.click("#t-tut-next");

  // then the game starts, and the tutorial is not shown again
  await expect(dialog).toBeHidden();
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as any).tighter.state.tutorialDone)).toBe(true);
  await page.reload();
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await expect(dialog).toBeHidden();
});

test("Skip goes to the game, and ?tutorial=off never shows it", async ({ page }) => {
  await freshVisit(page);
  await expect(page.locator("#t-tutorial")).toBeVisible({ timeout: 30_000 });
  await page.click("#t-tut-skip");
  await expect(page.locator("#t-tutorial")).toBeHidden();
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });

  await freshVisit(page, "&tutorial=off");
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await expect(page.locator("#t-tutorial")).toBeHidden();
});

test("Settings replays the tutorial", async ({ page }) => {
  await freshVisit(page, "&tutorial=off");
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await page.click("#t-open-settings");
  await page.click("#t-tut-replay");
  await expect(page.locator("#t-tutorial")).toBeVisible();
  await expect(page.locator("#t-tut-title")).toHaveText("Nine squares");
  await page.click("#t-tut-skip");
  await expect(page.locator("#t-tutorial")).toBeHidden();
});
