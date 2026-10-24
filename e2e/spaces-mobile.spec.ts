import { expect, test } from "@playwright/test";

test("phone: the spaces page fits, and its widest table scrolls in its own box", async ({ page }) => {
  await page.goto("/spaces.html#space=curved&K=-1&N=all&M=all");
  await expect(page.locator("#space-rows tr").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Spaces" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1);
  const wrap = page.locator("#records .table-wrap");
  expect(await wrap.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  // the space picker and the filters stay within the screen
  for (const id of ["#space-pick", "#space-filters"]) {
    const box = (await page.locator(id).boundingBox())!;
    expect(box.x + box.width, id).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
});
