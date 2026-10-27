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
  await openProblem(page, 4, 4, 55);
  await expect(page.locator("#show-record")).toHaveText("Show best record");
  await page.click("#show-record");
  await expect(page.locator("#record-info")).toContainText("7.94577100750391");
  await expect(page.locator("#record-info")).toContainText("best known, not proven");
  await expect(page.locator("#record-info")).toContainText("Coordinates are not available");
  await expect(page.locator("#record-info a", { hasText: "Picture" })).toHaveAttribute("href", /square-55\.svg/);
  await expect(page.locator("#count")).toContainText("0 / 55");
});

test("a record read from the source's drawing loads onto the board and names the drawing", async ({ page }) => {
  await openProblem(page, 4, 4, 11);
  await page.click("#show-record");
  await expect(page.locator("#record-info")).toContainText("3.87708359002281");
  await expect(page.locator("#record-info")).toContainText("drawing of the packing");
  await expect(page.locator("#count")).toContainText("11 / 11");
  await expect(page.locator("#score")).toHaveText("3.877084");
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
  await page.locator("#chart").scrollIntoViewIfNeeded();
  const box = (await page.locator("#chart").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const first = page.locator("#plot figure").first().locator(".chart-tip");
  await expect(first).toBeVisible();
  await expect(first).toContainText(/N = 0 \(circle\), M = 4 \(square\), P = \d+/);
  await expect(first).toContainText("area bound s =");
  await page.mouse.move(box.x - 40, box.y - 40);
  await expect(first).toBeHidden();

  // zoom: a drag across the chart narrows both charts to that range of P, double-click undoes it
  const marks = page.locator("#chart rect.lit-mark");
  const all = await marks.count();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("#chart-range")).toContainText(/P = \d+ to \d+/);
  await expect(page.getByRole("button", { name: "Reset zoom" })).toBeVisible();
  expect(await marks.count()).toBeLessThan(all / 2);
  expect(await page.locator("#chart-gap rect.lit-mark").count()).toBe(await marks.count());
  await page.locator("#chart").dblclick();
  await expect(page.locator("#chart-range")).toHaveText("");
  await expect(page.getByRole("button", { name: "Reset zoom" })).toBeHidden();
  expect(await marks.count()).toBe(all);
  // and from the keyboard: + zooms around the chosen P, 0 resets
  await page.locator("#chart").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("+");
  await expect(page.locator("#chart-range")).toContainText("P = 1 to");
  await expect(page.locator("#chart")).toBeFocused();
  await page.keyboard.press("0");
  await expect(page.locator("#chart-range")).toHaveText("");
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

test("the records page follows the live changes of the pair of shapes it shows", async ({ page }) => {
  const follows = (pair: string) =>
    page.waitForRequest((r) => decodeURIComponent(r.url()).endsWith(`/api/events?keys=${pair}/*`));
  const squares = follows("4/4");
  await page.goto("/browse.html#4,4");
  await squares;
  const circles = follows("0/4");
  await page.selectOption("#n-select", "0");
  await circles;
});

test("the record holders page counts the leads of each name", async ({ page, request }) => {
  // two pentagons in a nine-sided container: a problem without a published value that no other test enters
  const sent = await request.post("/api/submit", {
    data: {
      N: 5,
      M: 9,
      P: 2,
      container_phi: 0,
      name: "Holders test",
      pieces: [
        { x: 0, y: 0, theta: 0 },
        { x: 3, y: 0, theta: 0 },
      ],
    },
  });
  expect((await sent.json()).leader).toBe(true);
  await page.goto("/browse.html#4,4");
  await page.getByRole("navigation", { name: "Records" }).getByRole("link", { name: "Record holders" }).click();
  await expect(page).toHaveURL(/\/holders\.html$/);
  await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Records" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // place, name, records, beat published, site bests, awaiting review
  await expect(page.locator("#rows tr", { hasText: "Holders test" }).locator("td")).toHaveText([
    /^\d+$/,
    "Holders test",
    "1",
    "0",
    "1",
    "0",
  ]);
  await expect(page.locator("#note")).toContainText(
    /leads? [\d,]+ problems?; [\d,]+ of these (is a record|are records)\./,
  );
});
