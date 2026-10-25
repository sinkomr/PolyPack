import { type Page, expect, test } from "@playwright/test";
import { pageErrors } from "./helpers";

// 3D on 4D at phone width (390 px): the board stacks its stage above the panel, and the 3D
// drawing gets a square of its own under its controls (style.css, data-dimension="3-on-4").

test.use({ viewport: { width: 390, height: 844 } });

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Every control of the drawing lies within the screen. */
async function controlsFit(page: Page, what: string): Promise<void> {
  const width = page.viewportSize()!.width;
  for (const control of await page.locator(".pp3 button:visible, .pp3 input:visible").all()) {
    const box = (await control.boundingBox())!;
    expect(box.x, `${what}: ${await control.evaluate((e) => e.outerHTML.slice(0, 60))}`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, what).toBeLessThanOrEqual(width + 1);
    // large enough to tap
    expect(box.height, what).toBeGreaterThanOrEqual(32);
  }
}

test("phone: 3D on 4D on the board gets a square drawing, its controls fit, and a short run can be tapped through", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = pageErrors(page);
  await page.goto("/#space=boundary/tesseract/ball/9");
  await expect(page.locator("#space-problem-note")).toHaveText("Problem boundary/tesseract/ball/9");
  const canvas = page.locator(".pp3 canvas");
  await expect(canvas).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  const box = (await canvas.boundingBox())!;
  // as tall as the screen is wide, at full width
  expect(box.width).toBeGreaterThanOrEqual(388);
  expect(Math.abs(box.height - box.width)).toBeLessThanOrEqual(2);
  await controlsFit(page, "Cells");

  await page.locator(".pp3").getByRole("button", { name: "Net", exact: true }).tap();
  await expect(page.getByRole("slider", { name: "Fold" })).toBeVisible();
  await controlsFit(page, "Net");
  await page.locator(".pp3").getByRole("button", { name: "Fold up" }).tap();
  await expect(page.getByRole("slider", { name: "Fold" })).toHaveAttribute("aria-valuetext", "folded", {
    timeout: 10_000,
  });
  await page.locator(".pp3").getByRole("button", { name: "Slice", exact: true }).tap();
  await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
  await controlsFit(page, "Slice");
  expect(await overflow(page)).toBeLessThanOrEqual(1);

  // the picker and the run, below the drawing
  for (const id of ["#space-f-piece", "#space-f-P", "#space-solve-run", "#space-submit"]) {
    await page.locator(id).scrollIntoViewIfNeeded();
    const b = (await page.locator(id).boundingBox())!;
    expect(b.x + b.width, id).toBeLessThanOrEqual(391);
  }
  await page.selectOption("#space-solve-budget", "evals");
  await page.fill("#space-solve-evals", "5000");
  await page.locator("#space-solve-run").scrollIntoViewIfNeeded();
  await page.tap("#space-solve-run");
  await expect(page.locator("#space-solve-status")).toContainText(
    /^(Evaluation limit reached|Reached the lower bound)\./,
    {
      timeout: 90_000,
    },
  );
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("phone: the 3D on 4D viewer fits, with a square drawing", async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto("/spaces/boundary.html#id=boundary/tesseract/cube/12");
  await expect(page.locator("#viewer-problem-note")).toHaveText("Problem boundary/tesseract/cube/12");
  const canvas = page.locator(".pp3 canvas");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(388);
  expect(Math.abs(box.height - box.width)).toBeLessThanOrEqual(2);
  await controlsFit(page, "viewer");
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  for (const id of ["#viewer-f-piece", "#viewer-packing", "#viewer-board"]) {
    await page.locator(id).scrollIntoViewIfNeeded();
    const b = (await page.locator(id).boundingBox())!;
    expect(b.x + b.width, id).toBeLessThanOrEqual(391);
  }
  expect(errors).toEqual([]);
});
