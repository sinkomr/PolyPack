import { expect, test } from "@playwright/test";
import { evaluate, findOverlaps, pieceSeparation } from "@polypack/geometry";
import { openProblem, pieceCentre, pieces } from "./helpers";

test("build a packing, submit it, and a second browser sees the leaderboard update", async ({ page, browser }) => {
  // squares in a nine-sided container: a problem with no published record, used by no other test
  // a second visitor already watching the same problem
  const other = await (await browser.newContext()).newPage();
  // it follows the live changes of its own problem only
  const follows = other.waitForRequest((r) => decodeURIComponent(r.url()).endsWith("/api/events?keys=4/9/3"));
  await openProblem(other, 4, 9, 3);
  await follows;
  await expect(other.locator("#leaderboard-note")).toContainText("No entries yet");
  await expect(other.locator("#live")).toHaveClass(/on/);

  await openProblem(page, 4, 9, 3);
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

  // a board built by hand is submitted as found by hand; nobody declares Human or AI any more
  await expect(page.locator("#agent")).toHaveCount(0);
  await expect(page.locator("#found-with")).toHaveText("Found by hand.");
  await expect(page.locator("#agent-note")).toHaveValue("");
  await page.fill("#name", "Playwright");
  const [sent] = await Promise.all([page.waitForRequest("**/api/submit"), page.click("#submit")]);
  const body = sent.postDataJSON();
  expect(body.found_with).toBe("hand");
  for (const key of ["agent", "agent_note", "method", "method_params", "seed", "budget"]) expect(body).not.toHaveProperty(key);
  await expect(page.locator("#submit-result")).toContainText("Accepted");
  await expect(page.locator("#submit-result")).toContainText("This is now the best entry for this problem.");
  await expect(page.locator("#leaderboard li")).toHaveCount(1);
  await expect(page.locator("#leaderboard li")).toContainText("Playwright");
  await expect(page.locator("#leaderboard li .meta")).toContainText("by hand");
  await expect(page.locator("#leaderboard li")).not.toContainText(/\bHuman\b|\bAI\b/);
  await expect(page.locator("#leaderboard-note")).toHaveText("1 submission so far.");

  // the other browser updates without a reload
  await expect(other.locator("#leaderboard li")).toContainText("Playwright", { timeout: 5000 });
  await expect(other.locator("#record")).toContainText("Playwright");
  await expect(other.locator("#show-record")).toHaveText("Show best record");
  await other.click("#show-record");
  await expect(other.locator("#count")).toContainText("3 / 3");
  expect(Number(await other.textContent("#score"))).toBeCloseTo(score, 5);

  // the same packing again, under another name: counted, but not kept, and the earlier entry keeps the lead
  await page.fill("#name", "Latecomer");
  await page.click("#submit");
  await expect(page.locator("#submit-result")).toContainText("Valid, score");
  await expect(page.locator("#submit-result")).toContainText("does not beat the current best");
  await expect(page.locator("#submit-result")).toContainText("equal scores keep the earlier entry");
  await expect(page.locator("#leaderboard-note")).toHaveText("2 submissions in total; the earliest best one is shown.");
  await expect(page.locator("#leaderboard li")).toHaveCount(1);
  await expect(page.locator("#leaderboard li")).toContainText("Playwright");
  await expect(other.locator("#leaderboard-note")).toContainText("1 submission so far.");

  // the records page lists the leader only
  await other.goto("/browse.html#4,9");
  await expect(other.locator("#rows tr")).toContainText("Playwright (by hand)");
  await expect(other.locator("#rows")).not.toContainText("Latecomer");
});

test("the board turns the container to its best orientation before it submits", async ({ page, request }) => {
  // squares in a ten-sided container: a problem with no published record, used by no other test
  await openProblem(page, 4, 10, 3);
  await page.click("#add-all");
  await expect(page.locator("#count")).toContainText("3 / 3");
  // the container turned away from its best orientation
  await page.fill("#phi", "13");
  await page.locator("#phi").blur();
  const shown = Number(await page.textContent("#score"));
  await page.fill("#name", "Playwright orientation");
  const [sent] = await Promise.all([page.waitForRequest("**/api/submit"), page.click("#submit")]);
  const body = sent.postDataJSON();
  // the server scores the container at the phi it is sent, so the board sends its best one
  const atSent = evaluate(body).score!;
  expect(atSent).toBe(evaluate(body, { autoOrient: true }).score);
  expect(atSent).toBeLessThan(shown);
  await expect(page.locator("#status")).toContainText("Turned the container to its best orientation before submitting");
  await expect(page.locator("#submit-result")).toContainText("Accepted");
  const lb = await (await request.get("/api/leaderboard/4/10/3")).json();
  expect(lb.entries[0].score).toBe(atSent);
  // the board shows the orientation it sent
  await expect(page.locator("#score")).toHaveText(atSent.toFixed(6));
});

test("a link to an entry that is no longer kept says why it cannot be loaded", async ({ page, request }) => {
  // squares in an eight-sided container: an entry, then a better one, which deletes the first
  const entry = (gap: number) => ({
    N: 4,
    M: 8,
    P: 2,
    container_phi: 0,
    name: "Link test",
    pieces: [
      { x: 0, y: 0, theta: Math.PI / 4 },
      { x: gap, y: 0, theta: Math.PI / 4 },
    ],
  });
  const first = await (await request.post("/api/submit", { data: entry(3) })).json();
  const better = await (await request.post("/api/submit", { data: entry(1) })).json();
  expect([first.leader, better.leader]).toEqual([true, true]);
  expect((await request.get(`/api/submissions/${first.id}`)).status()).toBe(404);
  await page.goto(`/#s=${first.id}`);
  await expect(page.locator("#status")).toContainText("only the best entry of each problem is kept.");
  await page.goto(`/#s=${better.id}`);
  await expect(page.locator("#status")).toContainText("Loaded the submitter's entry");
});

test("a problem with a proven optimum takes no submissions, and an open one does again", async ({ page, request }) => {
  const closedNote = "This problem is solved: its optimum is proven, so the leaderboard is closed. You can still play it.";
  // seven circles in a circle: proven
  await openProblem(page, 0, 0, 7);
  await expect(page.locator("#show-record")).toHaveText("Show proven minimum");
  await expect(page.locator("#submit")).toBeDisabled();
  await expect(page.locator("#submit-closed")).toBeVisible();
  await expect(page.locator("#submit-closed")).toHaveText(closedNote);
  await expect(page.locator("#leaderboard li")).toHaveCount(0);
  await expect(page.locator("#leaderboard-note")).toHaveText(closedNote);
  // the board and the optimizer stay usable
  await page.click("#add-all");
  await expect(page.locator("#count")).toContainText("7 / 7");
  await expect(page.locator("#solve-run")).toBeEnabled();
  await expect(page.locator("#submit")).toBeDisabled();

  // the server refuses on its own account, whatever the page does
  const r = await request.post("/api/submit", {
    data: { N: 0, M: 0, P: 7, units: "diameter", name: "x", container_phi: 0, pieces: await pieces(page) },
  });
  expect(r.status()).toBe(409);
  expect((await r.json()).reasons[0]).toMatch(/^this problem is closed: its optimum 3 is proven \(.+\)$/);
  expect((await (await request.get("/api/leaderboard/0/0/7")).json()).total).toBe(0);

  // twenty circles in a circle: best known only, so open
  await page.fill("#p-input", "20");
  await page.locator("#p-input").blur();
  await expect(page.locator("#show-record")).toHaveText("Show best record");
  await expect(page.locator("#submit")).toBeEnabled();
  await expect(page.locator("#submit-closed")).toBeHidden();
  await expect(page.locator("#leaderboard-note")).toContainText("No entries yet");

  // and back to a closed one
  await page.fill("#p-input", "7");
  await page.locator("#p-input").blur();
  await expect(page.locator("#submit")).toBeDisabled();
  await expect(page.locator("#submit-closed")).toBeVisible();
});

test("a refusal of a closed problem is shown when the page did not know", async ({ page }) => {
  // the page is told that the problem is open; the server knows better
  await page.route("**/api/problems/0/0/7", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), accepts_submissions: true } });
  });
  await openProblem(page, 0, 0, 7);
  await expect(page.locator("#submit")).toBeEnabled();
  await page.click("#show-record");
  await expect(page.locator("#count")).toContainText("7 / 7");
  await page.fill("#name", "Playwright");
  await page.click("#submit");
  await expect(page.locator("#submit-result")).toContainText("this problem is closed: its optimum 3 is proven");
  await expect(page.locator("#submit-result")).toHaveClass(/bad/);
  // the refusal makes the page ask for the problem again; that request may outlive the test
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("an invalid submission is refused by the server with a reason", async ({ request }) => {
  const r = await request.post("/api/submit", {
    // an open problem: a closed one is refused before the packing is looked at
    data: { N: 4, M: 7, P: 2, name: "x", container_phi: 0, pieces: [{ x: 0, y: 0, theta: 0 }, { x: 0.2, y: 0, theta: 0 }] },
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
