import { Browser, Page, devices, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";

// Tighter in desktop Safari's engine (WebKit). Safari refuses every module that a worker of a
// cross-origin isolated page imports unless the module carries the embedder policy, where Chrome asks
// it of the worker's own script only: on 2026-10-27 the game's worker failed at once in Safari while
// the Chrome tests passed. These tests run the solver worker there, on a polygon problem and on a
// space problem (dealt by the development build's cheat). They skip where WebKit is not installed.

const URL = "http://localhost:5174/tighter.html";

function hasWebkit(playwright: { webkit: { executablePath(): string } }): boolean {
  try {
    return existsSync(playwright.webkit.executablePath());
  } catch {
    return false;
  }
}

async function safari(playwright: {
  webkit: { launch(): Promise<Browser>; executablePath(): string };
}): Promise<{ browser: Browser; page: Page; errors: string[] }> {
  test.skip(!hasWebkit(playwright), "WebKit is not installed here (npx playwright install webkit)");
  const browser = await playwright.webkit.launch();
  const page = await (await browser.newContext({ ...devices["Desktop Safari"] })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && /worker|Embedder|module/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${URL}?seed=7`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${URL}?seed=7`);
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)", { timeout: 30_000 });
  return { browser, page, errors };
}

const evaluationsRun = async (page: Page) =>
  Number(((await page.locator("#t-bar-evals").textContent()) ?? "0").replace(/[^0-9]/g, "") || "0");

test("safari: the page is isolated and Evolve runs the solver worker on a polygon problem", async ({ playwright }) => {
  const { browser, page, errors } = await safari(playwright);
  try {
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    for (let i = 0; i < 4; i++) await page.locator("#t-evolve").click();
    await expect.poll(() => evaluationsRun(page), { timeout: 30_000 }).toBeGreaterThan(100);
    await expect(page.locator("body")).not.toContainText("solver worker failed");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("safari: Evolve on a dealt sphere problem runs the space worker", async ({ playwright }) => {
  const { browser, page, errors } = await safari(playwright);
  try {
    await page.click("#t-open-settings");
    await page.fill("#t-cheat-space", "sphere/0/12");
    await page.getByRole("button", { name: "Deal it" }).click();
    await expect(page.locator("#t-cheat-note")).toHaveText("Dealt sphere/0/12.", { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#t-space-board")).toBeVisible();
    const before = await evaluationsRun(page);
    for (let i = 0; i < 4; i++) await page.locator("#t-evolve").click();
    await expect.poll(() => evaluationsRun(page), { timeout: 30_000 }).toBeGreaterThan(before);
    await expect(page.locator("body")).not.toContainText("solver worker failed");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
