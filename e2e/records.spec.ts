import { expect, test } from "@playwright/test";
import { openProblem } from "./helpers";

test("a proven record with coordinates loads onto the board", async ({ page }) => {
  await openProblem(page, 0, 0, 7);
  await expect(page.locator("#show-record")).toHaveText("Show proven minimum");
  await expect(page.locator("#record")).toContainText("3.000000");
  await page.click("#show-record");
  await expect(page.locator("#count")).toContainText("7 / 7");
  await expect(page.locator("#score")).toHaveText("3.000000");
  await expect(page.locator("#gap")).toContainText("0.0000 %");
  await expect(page.locator("#record-info")).toContainText("proven optimal");
  await expect(page.locator("#record-info a").first()).toHaveAttribute("href", /erich-friedman/);
  // the loaded record is an editable copy and undo returns to the empty board
  await page.click("#undo");
  await expect(page.locator("#count")).toContainText("0 / 7");
});

test("a best-known record without coordinates shows its value and source", async ({ page }) => {
  await openProblem(page, 4, 4, 11);
  await expect(page.locator("#show-record")).toHaveText("Show best record");
  await page.click("#show-record");
  await expect(page.locator("#record-info")).toContainText("3.87708359002281");
  await expect(page.locator("#record-info")).toContainText("best known, not proven");
  await expect(page.locator("#record-info")).toContainText("Coordinates are not available");
  await expect(page.locator("#record-info a", { hasText: "Picture" })).toHaveAttribute("href", /square-11\.svg/);
  await expect(page.locator("#count")).toContainText("0 / 11");
});

test("the records page lists published values with a chart", async ({ page }) => {
  await page.goto("/browse.html#0,4");
  await expect(page.locator("#rows tr").nth(9)).toContainText("6.747");
  await expect(page.locator("#chart .lit-mark").first()).toBeVisible();
  await page.locator("#rows tr").nth(4).getByRole("link", { name: /Open P = 5/ }).click();
  await expect(page.locator("#count")).toContainText("0 / 5");
  await expect(page.locator("#m-select")).toHaveValue("4");
  await expect(page.locator("#n-select")).toHaveValue("0");
});

test("the records page puts the atlas above the chart and the complete table", async ({ page }) => {
  await page.goto("/browse.html#0,4");
  await expect(page.locator("#atlas-title")).toHaveText("The atlas of circles in a square");
  await expect(page.locator("#rows tr")).toHaveCount(500);
  // one tile per listed P, the first hundred shown
  await expect(page.locator("#atlas-tiles a.tile")).toHaveCount(500);
  await expect(page.locator("#atlas-tiles a.tile:visible")).toHaveCount(100);
  await expect(page.locator('#atlas-tiles a.tile[data-p="10"] .tile-score')).toHaveText("6.747442");
  await expect(page.locator('#atlas-tiles a.tile[data-p="10"] .tile-art')).toHaveClass(/drawn/);
  const top = (selector: string) => page.locator(selector).evaluate((e) => e.getBoundingClientRect().top + window.scrollY);
  expect(await top("#atlas-tiles")).toBeLessThan(await top("#chart"));
  expect(await top("#chart")).toBeLessThan(await top("table"));
  // the old address form still selects the problem
  await expect(page.locator("#n-select")).toHaveValue("0");
  await expect(page.locator("#m-select")).toHaveValue("4");
  await expect(page).toHaveURL(/\/browse\.html#0,4$/);
});
