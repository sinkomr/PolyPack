import { expect, Page, test } from "@playwright/test";

// The tech tree's zoom: the buttons, Fit, Ctrl+wheel, buying a node while zoomed, and the zoom kept
// across a reload. Properties are asserted (the size shrinks, the tree fits), not exact pixels.

async function open(page: Page): Promise<void> {
  await page.goto("/tighter.html?seed=7&tutorial=off");
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  // the tree's tab shows once some points are earned
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.rp += 1;
    s.rpEarned += 1;
  });
  const tab = page.locator("#t-tab-tree");
  await expect(tab).toBeVisible({ timeout: 10_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.locator(".t-tree-canvas")).toBeVisible();
}

const size = (page: Page) =>
  page.locator(".t-tree-canvas").evaluate((c) => {
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
const readout = (page: Page) => page.locator("[data-zoom='value']");

test.beforeEach(async ({ page }) => {
  await page.goto("/tighter.html?seed=7&tutorial=off");
  await page.evaluate(() => localStorage.clear());
});

test("the buttons zoom the tree, and Fit shows all of it", async ({ page }) => {
  await open(page);
  await expect(readout(page)).toHaveText("100 %");
  const full = await size(page);
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(readout(page)).toHaveText("90 %");
  await expect.poll(async () => (await size(page)).w).toBeLessThan(full.w * 0.95);

  await page.getByRole("button", { name: "Fit" }).click();
  const box = await page.locator("#t-cards").evaluate((b) => {
    const r = b.getBoundingClientRect();
    return { w: b.clientWidth, h: b.clientHeight, left: r.left, top: r.top };
  });
  await expect
    .poll(async () => {
      const s = await size(page);
      return s.w <= box.w + 2 && s.h <= box.h + 2;
    })
    .toBe(true);
  const pct = parseInt((await readout(page).textContent()) ?? "", 10);
  expect(pct).toBeLessThanOrEqual(100);
  expect(pct).toBeGreaterThanOrEqual(20);
});

test("Ctrl+wheel zooms, a plain wheel does not, and a node still buys when zoomed", async ({ page }) => {
  await open(page);
  const box = (await page.locator("#t-cards").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const full = await size(page);

  await page.mouse.wheel(0, 100);
  await expect(readout(page)).toHaveText("100 %");

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await size(page)).w).toBeLessThan(full.w);
  await expect(readout(page)).not.toHaveText("100 %");

  // give record points, so some upgrade can be bought, then press it in the zoomed tree
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.rp += 1e9;
    s.rpEarned += 1e9;
  });
  const buyable = page.locator('.t-card[data-state="buyable"] .t-node-act').first();
  await expect(buyable).toBeVisible({ timeout: 10_000 });
  const owned = () => page.evaluate(() => (window as any).tighter.state.owned.length);
  const before = await owned();
  await buyable.scrollIntoViewIfNeeded();
  await buyable.click();
  await expect.poll(owned).toBeGreaterThan(before);
});

test("the zoom is kept across a reload", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(readout(page)).toHaveText("80 %");
  await open(page);
  await expect(readout(page)).toHaveText("80 %");
  const s = await size(page);
  const natural = await page.locator(".t-tree-canvas").evaluate((c) => (c as HTMLElement).offsetWidth);
  expect(s.w / natural).toBeCloseTo(0.8, 1);
});
