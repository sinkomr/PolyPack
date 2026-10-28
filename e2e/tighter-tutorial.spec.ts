import { expect, Page, test } from "@playwright/test";

// The tutorial on a first visit: squares in a square (9, then 10 and 11 side by side, then 17), ten clicks that shrink 12 hexagons in
// a pentagon, a teaser of finished packings in space, then the name pop-up and the game. It runs against
// the local end-to-end stack (playwright.config.ts). Its boards are never sent and pay no points.

const URL = "/tighter.html?seed=5";

async function freshVisit(page: Page, query = ""): Promise<void> {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL + query);
}

/** Finishing or skipping the tutorial opens the name pop-up; the game begins when it closes. */
async function closeNamePopup(page: Page): Promise<void> {
  await expect(page.locator("#t-name-popup")).toBeVisible({ timeout: 30_000 });
  await page.click("#t-name-cancel");
  await expect(page.locator("#t-name-popup")).toHaveCount(0);
}

/** The side the hands-on step shows, from its status line. */
const shownSide = async (page: Page): Promise<number> =>
  Number(/Pentagon side: ([\d.]+?)\.?(\s|$)/.exec((await page.locator("#t-tut-status").textContent()) ?? "")?.[1]);

test("a first visit walks the tutorial, then starts the game", async ({ page }) => {
  await freshVisit(page);
  const dialog = page.locator("#t-tutorial");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).tighter?.state.tutorialDone ?? false)).toBe(false);

  // 9, 10 and 11 (two packings on one slide), and 17 squares
  await expect(page.locator("#t-tut-title")).toHaveText("Nine squares");
  await expect(page.locator("#t-tut-status")).toContainText("9 squares, side 3.000000", { timeout: 30_000 });
  await page.click("#t-tut-next");
  await expect(page.locator("#t-tut-title")).toHaveText("Ten and eleven squares");
  await expect(page.locator("#t-tut-board-2")).toBeVisible();
  await expect(page.locator("#t-tut-status")).toContainText("10 squares, side 3.707", { timeout: 30_000 });
  await expect(page.locator("#t-tut-status")).toContainText("11 squares, side 3.877");
  await page.click("#t-tut-next");
  await expect(page.locator("#t-tut-title")).toHaveText("Seventeen squares");
  await expect(page.locator("#t-tut-board-2")).toBeHidden();
  await expect(page.locator("#t-tut-status")).toContainText("17 squares, side 4.67", { timeout: 30_000 });
  await page.click("#t-tut-next");

  // the hands-on step: Next waits for ten improvements, and each click shrinks the side
  await expect(page.locator("#t-tut-title")).toHaveText("Try it yourself");
  await expect(page.locator("#t-tut-next")).toBeDisabled();
  await expect(page.locator("#t-tut-act")).toBeEnabled({ timeout: 60_000 });
  let side = await shownSide(page);
  for (let k = 1; k <= 10; k++) {
    await page.click("#t-tut-act");
    await expect(page.locator("#t-tut-status")).toContainText(
      k < 10 ? `Improved ${k} of 10 times` : "Improved 10 times. Press Next when you're ready.",
      { timeout: 60_000 },
    );
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
  await expect(page.locator("#t-tut-text")).toContainText("Later in the game you can reset");
  await expect(page.locator("#t-tut-space-0 canvas")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#t-tut-space-1 canvas")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#t-tut-next")).toHaveText("PLAY");
  await expect(page.locator("#t-tut-name")).toHaveText("Set my leaderboard name");
  await page.click("#t-tut-next");

  // PLAY starts the game with the generated name and no name pop-up; the tutorial is not shown again
  await expect(dialog).toBeHidden();
  await expect(page.locator("#t-name-popup")).toHaveCount(0);
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as any).tighter.state.tutorialDone)).toBe(true);
  await page.reload();
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await expect(dialog).toBeHidden();
});

test("Set my leaderboard name opens the name pop-up, then starts the game", async ({ page }) => {
  await freshVisit(page);
  await expect(page.locator("#t-tutorial")).toBeVisible({ timeout: 30_000 });
  for (const title of ["Nine squares", "Ten and eleven squares", "Seventeen squares"]) {
    await expect(page.locator("#t-tut-title")).toHaveText(title);
    await page.click("#t-tut-next");
  }
  await expect(page.locator("#t-tut-act")).toBeEnabled({ timeout: 60_000 });
  for (let k = 1; k <= 10; k++) {
    await page.click("#t-tut-act");
    await expect(page.locator("#t-tut-status")).toContainText(`Improved ${k}`, { timeout: 60_000 });
    await expect(page.locator("#t-tut-act")).toBeEnabled();
  }
  await page.click("#t-tut-next");
  await expect(page.locator("#t-tut-name")).toBeHidden();
  await page.click("#t-tut-next");
  await expect(page.locator("#t-tut-title")).toHaveText("What comes later");
  await expect(page.locator("#t-tut-name")).toBeVisible();
  await page.click("#t-tut-name");
  await expect(page.locator("#t-tutorial")).toBeHidden();
  await closeNamePopup(page);
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
});

test("Skip goes to the game, and ?tutorial=off never shows it", async ({ page }) => {
  await freshVisit(page);
  await expect(page.locator("#t-tutorial")).toBeVisible({ timeout: 30_000 });
  await page.click("#t-tut-skip");
  await expect(page.locator("#t-tutorial")).toBeHidden();
  await closeNamePopup(page);
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
  await closeNamePopup(page);
});
