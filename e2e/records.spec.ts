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
  // the charts are optional: closed, nothing is drawn
  await expect(page.locator("#chart")).toBeHidden();
  await expect(page.locator("#chart *")).toHaveCount(0);
  await page.getByText("Charts: records against the area bound").click();
  await expect(page.locator("#chart .lit-mark").first()).toBeVisible();
  await expect(page.locator("#chart polyline.record")).toHaveCount(1);
  // the second chart subtracts the bound: ten circles, 6.747442 against sqrt(10 pi) = 5.604991
  // keyboard: Home, then nine steps right, is P = 10; its box names the problem and the values
  const tip = page.locator("#plot figure").nth(1).locator(".chart-tip");
  await page.locator("#chart-gap").focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("N = 0 (circle), M = 4 (square), P = 10");
  await expect(tip).toContainText("published s = 6.7474415232 (proven)");
  await expect(tip).toContainText("1.142450 above the bound");
  await page.locator("#chart-gap").blur();
  await expect(tip).toBeHidden();
  // pointer: the P nearest the pointer is described, whatever the mark's size
  const box = (await page.locator("#chart").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const first = page.locator("#plot figure").first().locator(".chart-tip");
  await expect(first).toBeVisible();
  await expect(first).toContainText(/N = 0 \(circle\), M = 4 \(square\), P = \d+/);
  await expect(first).toContainText("area bound s =");
  await page.mouse.move(box.x - 40, box.y - 40);
  await expect(first).toBeHidden();
  await expect(page.locator("#chart-gap-title")).toContainText("minus the bound");
  await page
    .locator("#rows tr")
    .nth(4)
    .getByRole("link", { name: /Open P = 5/ })
    .click();
  await expect(page.locator("#count")).toContainText("0 / 5");
  await expect(page.locator("#m-select")).toHaveValue("4");
  await expect(page.locator("#n-select")).toHaveValue("0");
});

test("the records page puts the chart above the atlas and the complete table", async ({ page }) => {
  await page.goto("/browse.html#0,4");
  await expect(page.locator("#atlas-title")).toHaveText("The atlas of circles in a square");
  await expect(page.locator("#rows tr")).toHaveCount(500);
  // one tile per listed P, the first hundred shown
  await expect(page.locator("#atlas-tiles a.tile")).toHaveCount(500);
  await expect(page.locator("#atlas-tiles a.tile:visible")).toHaveCount(100);
  await expect(page.locator('#atlas-tiles a.tile[data-p="10"] .tile-score')).toHaveText("6.747442");
  await expect(page.locator('#atlas-tiles a.tile[data-p="10"] .tile-art')).toHaveClass(/drawn/);
  const top = (selector: string) =>
    page.locator(selector).evaluate((e) => e.getBoundingClientRect().top + window.scrollY);
  expect(await top("#plot")).toBeLessThan(await top("#atlas-tiles"));
  expect(await top("#atlas-tiles")).toBeLessThan(await top("table"));
  // the old address form still selects the problem
  await expect(page.locator("#n-select")).toHaveValue("0");
  await expect(page.locator("#m-select")).toHaveValue("4");
  await expect(page).toHaveURL(/\/browse\.html#0,4$/);
});
