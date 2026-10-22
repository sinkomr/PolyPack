import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { findOverlaps } from "@polypack/geometry";
import { openProblem, pieces } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test(`no automatic accessibility violations (${scheme})`, async ({ browser }) => {
    const page = await (await browser.newContext({ colorScheme: scheme })).newPage();
    for (const path of ["/", "/browse.html#0,4", "/holders.html", "/api", "/admin.html"]) {
      // the default problem has no published record, so the board is checked on one that does
      if (path === "/") await openProblem(page, 4, 4, 5);
      else await page.goto(path);
      if (path === "/") {
        await page.click("#add");
        await page.click("#show-record");
      }
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(
        results.violations.map((v) => `${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`),
      ).toEqual([]);
    }
  });
}

test("the board can be operated with the keyboard alone", async ({ page }) => {
  await openProblem(page, 6, 6, 3);
  await page.locator("#board").focus();
  await expect(page.locator("#board")).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press("a");
  await expect(page.locator("#count")).toContainText("3 / 3");

  await page.keyboard.press("n");
  await expect(page.locator("#status")).toContainText("piece 1 of 3 selected");
  const start = (await pieces(page))[0];
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  expect((await pieces(page))[0].y).toBeCloseTo(start.y + 0.11, 9);
  await page.keyboard.press("q");
  expect((await pieces(page))[0].theta).toBeCloseTo(start.theta + Math.PI / 180, 9);

  // extend the selection and move the group into contact with the third piece
  await page.keyboard.press("Shift+n");
  await expect(page.locator("#status")).toContainText("2 in the selection");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowDown");
  expect(findOverlaps(6, await pieces(page))).toHaveLength(0);

  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await page.keyboard.press("Delete");
  await expect(page.locator("#count")).toContainText("2 / 3");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#count")).toContainText("3 / 3");

  // Tab leaves the board and reaches the controls; the focused control is visibly outlined
  await page.keyboard.press("Tab");
  await expect(page.locator("#board")).not.toBeFocused();
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe("none");
});

test("dragging stays fast with 100 twelve-sided pieces", async ({ page }) => {
  await openProblem(page, 12, 4, 100);
  await page.click("#add-all");
  await expect(page.locator("#count")).toContainText("100 / 100");
  // time the full cost of one drag step: no-overlap move, container update and redraw
  const ms = await page.evaluate(async () => {
    const { board } = (window as any).polypack;
    board.select([0]);
    const frames = 120;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      board.translateSelection(i % 2 ? 0.3 : -0.3, i % 3 ? 0.2 : -0.2);
      await new Promise(requestAnimationFrame);
    }
    return (performance.now() - t0) / frames;
  });
  // 60 frames per second is 16.7 ms per frame; allow slack for a loaded test machine
  expect(ms).toBeLessThan(25);
  const cost = await page.evaluate(() => {
    const { board } = (window as any).polypack;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) board.translateSelection(i % 2 ? 0.3 : -0.3, 0.1);
    return (performance.now() - t0) / 200;
  });
  expect(cost).toBeLessThan(4);
});
