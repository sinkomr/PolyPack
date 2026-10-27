import { expect, test } from "@playwright/test";
import { LAZY_VIEW } from "./helpers";

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
  for (const id of ["torus/free/6/7", "surface/dodecahedron/fold/5/13", "curved/-1/0/0/14", "polyhedra/tidintid/100"]) {
    await page.goto("about:blank");
    await page.goto(`/#space=${id}`);
    await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`);
    expect(await overflow(), id).toBeLessThanOrEqual(1);
  }
});

test("phone: the Problem set menu fits and switches the board", async ({ page }) => {
  await page.goto("/");
  const width = page.viewportSize()!.width;
  const menu = page.locator("#family-select");
  await menu.scrollIntoViewIfNeeded();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  await page.selectOption("#family-select", "surface");
  await expect(menu.locator("option:checked")).toHaveText("2D on 3D: Polyhedral surfaces");
  await expect(page.locator("main")).toHaveAttribute("data-dimension", "2-on-3");
  // the space mode's code loads on first use
  await expect(page.locator("#space-problem-note")).toContainText("Problem surface/", LAZY_VIEW);
  await page.selectOption("#family-select", "sphere");
  await expect(menu.locator("option:checked")).toHaveText("2D on 3D: Sphere");
  await expect(page.locator("#space-problem-note")).toContainText("Problem sphere/");
  await page.selectOption("#family-select", "polyhedra");
  await expect(page.locator("main")).toHaveAttribute("data-dimension", "3-in-3");
  await expect(page.locator("#space-problem-note")).toContainText("Problem polyhedra/");
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /drawn in 3D/, LAZY_VIEW);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.selectOption("#family-select", "polygon");
  await expect(page.locator("#board")).toBeVisible();
});
