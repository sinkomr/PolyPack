import { expect, test } from "@playwright/test";
import { findOverlaps, pieceSeparation } from "@polypack/geometry";
import { openProblem, pieceCentre, pieces } from "./helpers";

test("build a packing, submit it, and a second browser sees the leaderboard update", async ({ page, browser }) => {
  // squares in a heptagon: a problem with no published record
  // a second visitor already watching the same problem
  const other = await (await browser.newContext()).newPage();
  await openProblem(other, 4, 7, 3);
  await expect(other.locator("#leaderboard-note")).toContainText("No entries yet");
  await expect(other.locator("#live")).toHaveClass(/on/);

  await openProblem(page, 4, 7, 3);
  await page.click("#add");
  await page.click("#add");
  await page.click("#add");
  await expect(page.locator("#count")).toContainText("3 / 3");
  const before = Number(await page.textContent("#score"));

  // drag piece 1 hard into and past piece 2: it must stop in contact, never overlap
  const a = await pieceCentre(page, 0);
  const b = await pieceCentre(page, 1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 2 * (b.x - a.x), b.y + 2 * (b.y - a.y), { steps: 25 });
  await page.mouse.up();
  let ps = await pieces(page);
  expect(findOverlaps(4, ps)).toHaveLength(0);
  expect(Math.abs(pieceSeparation(4, ps[0], ps[1]).sep)).toBeLessThan(1e-9);

  // rotate with the keyboard, then snap to contact
  await page.keyboard.press("Shift+Q");
  ps = await pieces(page);
  expect(findOverlaps(4, ps)).toHaveLength(0);
  expect(await page.inputValue("#sel-theta")).toBe("60");
  await page.keyboard.press("Shift+E");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("#status")).toContainText(/contact|Nothing/i);
  expect(findOverlaps(4, await pieces(page))).toHaveLength(0);

  // undo and redo
  const afterMoves = await pieces(page);
  await page.keyboard.press("Control+z");
  expect(await pieces(page)).not.toEqual(afterMoves);
  await page.keyboard.press("Control+Shift+z");
  expect(await pieces(page)).toEqual(afterMoves);

  await page.click("#auto-orient");
  const score = Number(await page.textContent("#score"));
  expect(score).toBeLessThanOrEqual(before);

  await page.fill("#name", "Playwright");
  await page.click("#submit");
  await expect(page.locator("#submit-result")).toContainText("Accepted");
  await expect(page.locator("#submit-result")).toContainText("rank 1");
  await expect(page.locator("#leaderboard li")).toContainText("Playwright");

  // the other browser updates without a reload
  await expect(other.locator("#leaderboard li")).toContainText("Playwright", { timeout: 5000 });
  await expect(other.locator("#record")).toContainText("Playwright");
  await expect(other.locator("#show-record")).toHaveText("Show best record");
  await other.click("#show-record");
  await expect(other.locator("#count")).toContainText("3 / 3");
  expect(Number(await other.textContent("#score"))).toBeCloseTo(score, 5);

  // the records page lists it
  await other.goto("/browse.html#4,7");
  await expect(other.locator("#rows tr")).toContainText("Playwright");
});

test("an invalid submission is refused by the server with a reason", async ({ request }) => {
  const r = await request.post("/api/submit", {
    data: { N: 4, M: 4, P: 2, name: "x", container_phi: 0, pieces: [{ x: 0, y: 0, theta: 0 }, { x: 0.2, y: 0, theta: 0 }] },
  });
  expect(r.status()).toBe(422);
  expect((await r.json()).reasons[0]).toContain("overlapping");
});

test("numeric fields place a piece exactly and refuse overlaps", async ({ page }) => {
  await openProblem(page, 0, 0, 2);
  await page.click("#add-all");
  await page.fill("#sel-x", "10");
  await page.fill("#sel-y", "0");
  await page.press("#sel-y", "Enter");
  await page.locator("#sel-y").blur();
  const ps = await pieces(page);
  expect(ps[1].x).toBe(10);
  // on top of the other piece
  await page.fill("#sel-x", String(ps[0].x + 0.5));
  await page.fill("#sel-y", String(ps[0].y));
  await page.locator("#sel-y").blur();
  await expect(page.locator("#status")).toContainText("overlap");
  expect((await pieces(page))[1].x).toBe(10);
});

test("share link and JSON export round-trip the configuration", async ({ page, context }) => {
  await openProblem(page, 5, 6, 4);
  await page.click("#add-all");
  await page.keyboard.press("Shift+Q");
  const saved = await pieces(page);
  await page.click("#share");
  const url = page.url();
  expect(url).toContain("#c=");
  const fresh = await context.newPage();
  await fresh.goto(url);
  await expect(fresh.locator("#count")).toContainText("4 / 4");
  expect(await pieces(fresh)).toEqual(saved);

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export")]);
  expect(download.suggestedFilename()).toBe("polypack-N5-M6-P4.json");
  const path = await download.path();
  await page.click("#clear");
  await page.setInputFiles("#import-file", path);
  await expect(page.locator("#status")).toContainText("Imported 4 pieces");
  expect(await pieces(page)).toEqual(saved);
});
