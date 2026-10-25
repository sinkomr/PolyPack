import { expect, test } from "@playwright/test";

test("phone: the board's space mode fits, and a short run can be tapped through", async ({ page }) => {
  await page.goto("/#space=sphere/4/12");
  await expect(page.locator("#space-problem-note")).toHaveText("Problem sphere/4/12");
  await expect(page.locator(".space-draw > canvas")).toBeVisible();
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.selectOption("#space-solve-budget", "evals");
  await page.fill("#space-solve-evals", "2000");
  await page.locator("#space-solve-run").scrollIntoViewIfNeeded();
  await page.tap("#space-solve-run");
  await expect(page.locator("#space-solve-status")).toContainText("Evaluation limit reached.", { timeout: 30_000 });
  await page.locator("#space-submit").scrollIntoViewIfNeeded();
  await expect(page.locator("#space-submit")).toBeVisible();
  for (const id of ["torus/free/6/7", "surface/dodecahedron/fold/5/13", "curved/-1/0/0/14"]) {
    await page.goto("about:blank");
    await page.goto(`/#space=${id}`);
    await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`);
    expect(await overflow(), id).toBeLessThanOrEqual(1);
  }
});

test("phone: the Dimension and Kind menus fit and switch the board", async ({ page }) => {
  await page.goto("/");
  const width = page.viewportSize()!.width;
  for (const id of ["#dimension-select", "#kind-select"]) {
    await page.locator(id).scrollIntoViewIfNeeded();
    const box = (await page.locator(id).boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, id).toBeLessThanOrEqual(width + 1);
  }
  await page.selectOption("#dimension-select", "2-on-3");
  await expect(page.locator("#kind-select")).toHaveValue("surface");
  await expect(page.locator("#space-problem-note")).toContainText("Problem surface/");
  await page.selectOption("#kind-select", "sphere");
  await expect(page.locator("#space-problem-note")).toContainText("Problem sphere/");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.selectOption("#dimension-select", "2-in-2");
  await expect(page.locator("#board")).toBeVisible();
});
