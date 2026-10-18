import AxeBuilder from "@axe-core/playwright";
import { APIRequestContext, Page, Route, expect, test } from "@playwright/test";
import { enclose } from "@polypack/geometry";

const tile = (page: Page, P: number) => page.locator(`#atlas-tiles a.tile[data-p="${P}"]`);
const art = (page: Page, P: number) => tile(page, P).locator(".tile-art");
const shownTiles = (page: Page) => page.locator("#atlas-tiles a.tile:visible");
/** Number of pieces in the drawing of a tile: every piece is one sub-path. */
const piecesDrawn = (page: Page, P: number) =>
  tile(page, P)
    .locator("path.piece")
    .evaluateAll((paths) => paths.reduce((n, p) => n + (p.getAttribute("d")!.match(/M/g) ?? []).length, 0));

// ---------- fixtures ----------
// Tests of placeholders, loading and the pending rule serve the two endpoints of one problem from
// a fixture, so that they do not depend on which published records happen to have coordinates.

type Pose = { x: number; y: number; theta: number };
interface Listed {
  P: number;
  value: number;
  status?: string;
  has_coordinates?: boolean;
  source_url?: string;
  picture_url?: string;
}
interface Entry {
  P: number;
  id: number;
  score: number;
  name?: string;
  verification?: string;
}
interface AtlasTile {
  P: number;
  source: "site" | "literature";
  score: number;
  pieces: Pose[];
  container_phi: number;
  id?: number;
  verification?: string;
}
interface Fixture {
  literature: Listed[];
  site?: Entry[];
  site_verified?: Entry[];
  /** The drawing of one P, or nothing. */
  tile: (P: number) => AtlasTile | undefined;
  /** Called for each /api/atlas request before it is answered; may delay or fail it. */
  onAtlas?: (from: number, to: number, route: Route) => Promise<"answered" | void> | "answered" | void;
}

/** Unit pieces on a square grid, one unit of clearance between circles. */
const grid = (P: number, gap = 2, theta = 0): Pose[] => {
  const k = Math.ceil(Math.sqrt(P));
  return Array.from({ length: P }, (_, i) => ({ x: gap * (i % k), y: gap * Math.floor(i / k), theta }));
};
const listed = (N: number, M: number, r: Listed) => ({
  N,
  M,
  display: String(r.value),
  display_precision: 6,
  status: "best_known",
  source_name: "A fixture of the tests",
  source_url: "https://example.org/source",
  accessed: "2026-10-07",
  conversion_note: "none",
  has_coordinates: false,
  ...r,
});
const entry = (e: Entry) => ({
  name: "ann",
  found_with: "hand",
  agent_note: "",
  created_at: "2026-10-11T00:00:00Z",
  verification: "none",
  ...e,
});

/** Serves /api/records and /api/atlas of one problem from `f`. Returns the ranges asked of /api/atlas. */
async function serve(page: Page, N: number, M: number, f: Fixture): Promise<{ from: number; to: number }[]> {
  const asked: { from: number; to: number }[] = [];
  await page.route(`**/api/records?N=${N}&M=${M}`, (route) =>
    route.fulfill({
      json: {
        N,
        M,
        literature: f.literature.map((r) => listed(N, M, r)),
        site: (f.site ?? []).map(entry),
        site_verified: (f.site_verified ?? []).map(entry),
      },
    }),
  );
  await page.route(`**/api/atlas?N=${N}&M=${M}&*`, async (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    asked.push({ from, to });
    if ((await f.onAtlas?.(from, to, route)) === "answered") return;
    const tiles: AtlasTile[] = [];
    for (let P = from; P <= to; P++) {
      const t = f.tile(P);
      if (t) tiles.push(t);
    }
    await route.fulfill({ json: { N, M, from, to, next: null, tiles } });
  });
  return asked;
}

/** A problem (circles in an M-gon) and a P for which the real server has no entry yet, whatever ran before. */
async function freeSlot(request: APIRequestContext): Promise<{ M: number; P: number }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const M = 7 + Math.floor(Math.random() * 14);
    const P = 2 + Math.floor(Math.random() * 39);
    const records = await (await request.get(`/api/records?N=0&M=${M}`)).json();
    if (!records.literature.length && !records.site.some((e: { P: number }) => e.P === P)) return { M, P };
  }
  throw new Error("no free problem found");
}

/** Submits P circles in a row to the real server; a smaller gap is a better entry. */
async function submitRow(request: APIRequestContext, slot: { M: number; P: number }, gap: number, name = "atlas test") {
  const pieces = Array.from({ length: slot.P }, (_, i) => ({ x: gap * i, y: 0, theta: 0 }));
  const r = await request.post("/api/submit", {
    data: { N: 0, ...slot, container_phi: 0, name, found_with: "external", software: "e2e", pieces },
  });
  const body = await r.json();
  expect(body.valid).toBe(true);
  return body as { id: number; score: number };
}

// ---------- the atlas on the real records ----------

test("the atlas draws circles in a circle from published coordinates", async ({ page, request }) => {
  const records = await (await request.get("/api/records?N=0&M=0")).json();
  const total = new Set([...records.literature, ...records.site].map((r: { P: number }) => r.P)).size;
  await page.goto("/browse.html#0,0");
  await expect(page.locator("#atlas-title")).toHaveText("The atlas of circles in a circle");
  await expect(shownTiles(page)).toHaveCount(100);
  await expect(page.getByRole("link", { name: "The Squares Project" })).toHaveAttribute(
    "href",
    "https://jlevy.github.io/squares/",
  );

  // real drawings: seven unit circles in the circle of radius 3
  await expect(art(page, 7)).toHaveClass(/drawn/);
  expect(await piecesDrawn(page, 7)).toBe(7);
  expect(await piecesDrawn(page, 19)).toBe(19);
  await expect(tile(page, 7).locator("circle.container")).toHaveAttribute("r", "3");
  await expect(tile(page, 7)).toHaveAttribute("aria-label", /^P = 7, radius 3\.000000, proven, drawn from/);
  await expect(tile(page, 7).locator(".tile-score")).toHaveText("3.000000");
  // the marks follow the status of the record, whatever it is today
  for (const r of records.literature.filter((l: { P: number }) => l.P <= 30 && l.P !== 7)) {
    const marks = tile(page, r.P).locator(`.mark-proven, .mark-proven_unrefereed, .mark-trivial_tiling`);
    await expect(marks).toHaveCount(r.status === "best_known" ? 0 : 1);
    if (r.status !== "best_known") await expect(tile(page, r.P).locator(`.mark-${r.status}`)).toBeVisible();
  }

  // the rest of the sequence is behind "Show more"
  await expect(tile(page, 250)).toBeHidden();
  const more = page.locator("#atlas-more");
  await expect(more).toHaveText(`Show more (${total - 100} more)`);
  await more.click();
  await expect(shownTiles(page)).toHaveCount(total);
  await expect(page).toHaveURL(/[?&]show=all/);
  await expect(more).toHaveText("Show the first 100 only");
});

test("published data carries reference marks to the notes of its sources", async ({ page }) => {
  await page.goto("/browse.html#0,0");
  await expect(art(page, 7)).toHaveClass(/drawn/);
  // the notes at the foot of the page: a fixed order, each with a link to the site
  const notes = page.locator("#source-list > li");
  await expect(notes).toHaveCount(3);
  await expect(notes.nth(0)).toHaveAttribute("id", "source-1");
  await expect(notes.nth(0)).toContainText("Erich Friedman");
  await expect(notes.nth(0).getByRole("link", { name: "Packing Center" })).toHaveAttribute(
    "href",
    "https://erich-friedman.github.io/packing/",
  );
  await expect(notes.nth(1)).toContainText("David Ellsworth");
  await expect(notes.nth(2).getByRole("link", { name: "Packomania" })).toHaveAttribute("href", /packomania\.com/);
  // only the sources of this problem are named under the atlas
  await expect(page.locator("#atlas-sources")).toHaveText(
    "Published records compiled by Erich Friedman1 and Eckard Specht3, used with attribution.",
  );

  // the table: the value of P = 7 is Erich Friedman's, that of P = 30 Eckard Specht's
  const mark = (row: number) => page.locator("#rows tr").nth(row).locator(".src-ref a");
  await expect(mark(6)).toHaveText(["1"]);
  await expect(mark(6)).toHaveAttribute("aria-label", "Source 1: Erich Friedman, Packing Center");
  await expect(mark(29)).toHaveText(["3"]);
  // a mark leads to its note and leaves the address, which names the problem, alone
  await mark(6).click();
  await expect(page.locator("#source-1")).toBeFocused();
  await expect(page.locator("#source-1")).toBeInViewport();
  await expect(page).toHaveURL(/\/browse\.html#0,0$/);
  await expect(page.locator("#m-select")).toHaveValue("0");

  // the detail panel: value and caption from one source, coordinates from another, both credited in the panel
  await tile(page, 7).click();
  const detail = page.getByRole("dialog");
  const credit = detail.locator("#detail-source-1");
  await expect(credit).toHaveText(
    "Source 1 Erich Friedman, Packing Center: Circles in Circles, read 2026-10-07: value and caption",
  );
  await expect(credit.getByRole("link")).toHaveAttribute("href", "https://erich-friedman.github.io/packing/cirincir/");
  await expect(detail.locator("#detail-source-3")).toHaveText("Source 3 Eckard Specht, Packomania: coordinates");
  await expect(detail.locator(".detail-figure .src-ref a")).toHaveText(["3"]);
  await expect(detail.locator(".detail-source", { hasText: "Proved by Graham" }).locator(".src-ref a")).toHaveText([
    "1",
  ]);
  await detail.locator(".detail-figure .src-ref a").click();
  await expect(detail.locator("#detail-source-3")).toBeFocused();
  await expect(detail).toBeVisible();
  await expect(page).toHaveURL(/[?&]p=7\b.*#0,0$/);

  // every mark of the page points to a note that exists
  const targets = await page.locator(".src-ref a").evaluateAll((links) => links.map((a) => a.getAttribute("href")!));
  expect(targets.length).toBeGreaterThan(500);
  const missing = await page.evaluate(
    (hrefs) => hrefs.filter((h) => !/^#(detail-)?source-\d$/.test(h) || !document.getElementById(h.slice(1))),
    [...new Set(targets)],
  );
  expect(missing).toEqual([]);

  // the marks and the notes pass the automatic accessibility checks, in the panel and behind it
  const axe = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect((await axe()).violations.map((v) => `${v.id} ${v.nodes[0].html.slice(0, 80)}`)).toEqual([]);
  await page.keyboard.press("Escape");
  expect((await axe()).violations.map((v) => `${v.id} ${v.nodes[0].html.slice(0, 80)}`)).toEqual([]);

  // squares in a square: David Ellsworth's values, with coordinates that this site constructed
  await page.goto("/browse.html#4,4");
  await expect(page.locator("#atlas-sources")).toHaveText(
    "Published records compiled by David Ellsworth2, used with attribution.",
  );
  await expect(page.locator("#rows tr").nth(10).locator(".src-ref a")).toHaveText(["2"]);
});

test("a record from an unlisted source has no reference mark", async ({ page }) => {
  await serve(page, 5, 7, { literature: [{ P: 2, value: 2.25, status: "proven" }], tile: () => undefined });
  await page.goto("/browse.html#5,7");
  await expect(shownTiles(page)).toHaveCount(1);
  await expect(page.locator("#atlas-sources")).toBeHidden();
  await tile(page, 2).click();
  await expect(page.getByRole("dialog")).toContainText("A fixture of the tests, read 2026-10-07");
  await expect(page.locator(".src-ref")).toHaveCount(0);
  await expect(page.locator("#source-list > li")).toHaveCount(3);
});

test("the size, scale and layout choosers change the atlas and survive a reload", async ({ page, request }) => {
  const records = await (await request.get("/api/records?N=0&M=0")).json();
  const r = new Map<number, number>(records.literature.map((l: { P: number; value: number }) => [l.P, l.value]));
  await page.goto("/browse.html#0,0");
  await expect(art(page, 7)).toHaveClass(/drawn/);
  const width = (P: number, what = ".tile-art") =>
    tile(page, P)
      .locator(what)
      .evaluate((e) => e.getBoundingClientRect().width);
  await expect(page.getByRole("radio", { name: "Medium" })).toBeChecked();
  const medium = await width(7);
  await expect(tile(page, 7).locator(".tile-score")).toBeVisible();

  await page.getByRole("radio", { name: "Large" }).check();
  await expect(page).toHaveURL(/\/browse\.html\?size=large#0,0$/);
  expect(await width(7)).toBeGreaterThan(medium * 1.3);
  await page.getByRole("radio", { name: "Small" }).check();
  await expect(page).toHaveURL(/\?size=small#0,0$/);
  expect(await width(7)).toBeLessThan(medium * 0.8);
  await expect(tile(page, 7).locator(".tile-score")).toBeHidden();

  // fixed: every container fills its tile. global: true size against the largest container shown
  const fixed = [await width(1, ".tile-art svg"), await width(100, ".tile-art svg")];
  expect(fixed[0]).toBeCloseTo(fixed[1], 0);
  await page.getByRole("radio", { name: "Global" }).check();
  await expect(page).toHaveURL(/\?size=small&scale=global#0,0$/);
  const largest = Math.max(...[...r].filter(([P]) => P <= 100).map(([, value]) => value));
  const global = [await width(1, ".tile-art svg"), await width(50, ".tile-art svg"), await width(100, ".tile-art svg")];
  expect(global[2] / fixed[1]).toBeCloseTo(r.get(100)! / largest, 2);
  expect(global[0] / fixed[1]).toBeCloseTo(r.get(1)! / largest, 2);
  expect(global[1] / fixed[1]).toBeCloseTo(r.get(50)! / largest, 2);

  // the row scale belongs to the rows layout
  await expect(page.getByRole("radio", { name: "Row", exact: true })).toBeDisabled();
  await expect(page.locator("#atlas-tiles .tile-group")).toHaveCount(1);
  await page.getByRole("radio", { name: "Rows" }).check();
  await expect(page).toHaveURL(/\?size=small&scale=global&layout=rows#0,0$/);
  // row k holds every P whose radius is in (k - 1, k]
  const rowOf = (P: number) => Math.max(1, Math.ceil(r.get(P)! - 1e-9));
  const first100 = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(await page.locator("#atlas-tiles .tile-group:visible").count()).toBe(new Set(first100.map(rowOf)).size);
  const third = page.locator("#atlas-tiles .tile-group", { has: page.locator(".group-label", { hasText: /^r ≤ 3$/ }) });
  expect(
    await third.locator("a.tile").evaluateAll((links) => links.map((a) => Number(a.getAttribute("data-p")))),
  ).toEqual(first100.filter((P) => rowOf(P) === 3));
  await page.getByRole("radio", { name: "Row", exact: true }).check();
  await expect(page).toHaveURL(/scale=row&layout=rows/);
  // three circles against seven, the largest of their row (radius 3)
  expect((await width(3, ".tile-art svg")) / (await width(7, ".tile-art svg"))).toBeCloseTo(r.get(3)! / r.get(7)!, 2);

  await page.reload();
  await expect(page.getByRole("radio", { name: "Small" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Row", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Rows" })).toBeChecked();
  await expect(page.locator("#n-select")).toHaveValue("0");
  await expect(page.locator("#m-select")).toHaveValue("0");
  await expect(page.locator("#atlas-tiles .group-label").nth(2)).toHaveText("r ≤ 3");
  expect(await width(7)).toBeLessThan(medium * 0.8);

  // back to the grid, the row scale falls back to fixed; another problem keeps the display state
  await page.getByRole("radio", { name: "Grid" }).check();
  await expect(page).toHaveURL(/\?size=small#0,0$/);
  await page.selectOption("#m-select", "4");
  await expect(page).toHaveURL(/\?size=small#0,4$/);
  await expect(page.locator("#atlas-title")).toHaveText("The atlas of circles in a square");
  await expect(art(page, 9)).toHaveClass(/drawn/);
});

test("a tile opens its record, Back closes it, and the board link opens the problem", async ({ page }) => {
  await page.goto("/browse.html#0,0");
  await expect(art(page, 7)).toHaveClass(/drawn/);
  await tile(page, 7).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading")).toHaveText("P = 7: 7 circles in a circle");
  await expect(page).toHaveURL(/\?p=7#0,0$/);
  await expect(detail.locator(".tile-art")).toHaveClass(/drawn/);
  await expect(detail.locator("dd.big")).toHaveText("3.000000");
  await expect(detail.locator(".detail-badges")).toContainText("proven");
  await expect(detail).toContainText("Site best");
  await expect(detail).toContainText("Area lower bound");
  await expect(detail).toContainText("2.645751");
  await expect(detail).toContainText("13.39 %");
  await expect(detail).toContainText("read 2026-10-07");
  // the link to the source itself; the reference marks beside it are named "Source 1: ..."
  await expect(detail.getByRole("link", { name: /^Erich Friedman/ })).toHaveAttribute(
    "href",
    /^https:\/\/erich-friedman/,
  );
  await expect(tile(page, 7)).toHaveClass(/current/);

  // opening made a history entry: Back closes the panel and stays on the page, Forward opens it again
  await page.goBack();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\/browse\.html#0,0$/);
  await expect(tile(page, 7)).not.toHaveClass(/current/);
  await page.goForward();
  await expect(detail.getByRole("heading")).toHaveText("P = 7: 7 circles in a circle");
  await expect(page).toHaveURL(/\?p=7#0,0$/);

  // Esc closes, steps back over that entry and hands the focus back
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\/browse\.html#0,0$/);
  await tile(page, 9).focus();
  await page.keyboard.press("Enter");
  await expect(detail.getByRole("heading")).toHaveText("P = 9: 9 circles in a circle");
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(detail).toBeHidden();
  await expect(tile(page, 9)).toBeFocused();
  await expect(page).toHaveURL(/\/browse\.html#0,0$/);
  // one step forward is the panel that was just closed, so the history did not grow a stray entry
  await page.goForward();
  await expect(detail.getByRole("heading")).toHaveText("P = 9: 9 circles in a circle");
  await page.goBack();
  await expect(detail).toBeHidden();

  // the address of an open record is a deep link
  await page.goto("/browse.html?size=large&p=19#0,0");
  await expect(detail.getByRole("heading")).toHaveText("P = 19: 19 circles in a circle");
  await expect(page.getByRole("radio", { name: "Large" })).toBeChecked();
  // the main link puts the drawn record on the board; the other opens the problem empty
  await expect(detail.getByRole("link", { name: "Open an empty board" })).toHaveAttribute("href", "/#p=0,0,19");
  await detail.getByRole("link", { name: "Show on the board" }).click();
  await expect(page).toHaveURL(/\/#p=0,0,19&record$/);
  await expect(page.locator("#count")).toContainText("19 / 19");
  await expect(page.locator("#n-select")).toHaveValue("0");
  await expect(page.locator("#m-select")).toHaveValue("0");

  // a panel number without a readable problem is ignored
  await page.goto("/browse.html?size=large&p=7#99,99");
  await expect(page.locator("#atlas-title")).toHaveText("The atlas of squares in a square");
  await expect(art(page, 1)).toHaveClass(/drawn/);
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\/browse\.html\?size=large#4,4$/);
});

test("the atlas can be operated with the keyboard alone", async ({ page }) => {
  await page.goto("/browse.html#3,3");
  await expect(art(page, 4)).toHaveClass(/drawn/);
  // the choosers are radio groups: Tab reaches the group, the arrow keys choose
  await page.locator("#m-select").focus();
  // the closed charts are one stop: their summary
  await page.keyboard.press("Tab");
  await expect(page.locator("#plot > summary")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Grid" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Rows" })).toBeChecked();
  await expect(page).toHaveURL(/layout=rows/);
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!.nextElementSibling!).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Medium" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/size=large/);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Fixed" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Row", exact: true })).toBeChecked();

  // tiles are links: Tab and the arrow keys walk them, Enter opens, Esc returns
  await page.keyboard.press("Tab");
  await expect(tile(page, 1)).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Tab");
  await expect(tile(page, 2)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(tile(page, 4)).toBeFocused();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading")).toHaveText("P = 4: 4 triangles in a triangle");
  await expect(detail).toContainText("optimal tiling");
  // three upright triangles and one upside down, told apart in words as well as by fill and texture
  await expect(detail.locator(".tilt-list")).toHaveText(/side-on \(0°\) × 3.*corner-on \(60°\) × 1/);
  await expect(page.locator("#atlas-legend")).toContainText("side-on: a side faces a container side squarely");
  await expect(page.locator("#atlas-legend")).toContainText("corner-on: a corner points squarely at a container side");
  // the upside-down triangle carries the stripes of its class, the upright ones a plain fill
  await expect(detail.locator("path.piece.tilt-1 + path.texture")).toHaveCount(1);
  await expect(detail.locator("path.piece.tilt-0 + path.texture")).toHaveCount(0);
  // the focus stays inside the panel
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest("dialog") || document.activeElement === document.body,
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(tile(page, 4)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tile(page, 3)).toBeFocused();
});

test("a new site best appears on its tile without a reload", async ({ page, request }) => {
  // a problem and a P that nothing has been submitted for, so that the entries below are the best
  const slot = await freeSlot(request);
  const P = slot.P;
  await page.goto(`/browse.html#0,${slot.M}`);
  await expect(page.locator("#atlas-lede")).not.toBeEmpty();
  await expect(tile(page, P)).toHaveCount(0);
  const first = await submitRow(request, slot, 3);
  // live update, or the 10 s polling fallback
  await expect(tile(page, P)).toBeVisible({ timeout: 20_000 });
  await expect(art(page, P)).toHaveClass(/drawn/);
  expect(await piecesDrawn(page, P)).toBe(P);
  await expect(tile(page, P).locator(".tile-score")).toHaveText(first.score.toFixed(6));
  await expect(tile(page, P).locator(".mark-site")).toBeVisible();
  await expect(tile(page, P)).toHaveAttribute(
    "aria-label",
    /site entry, no published value, drawn from the entry by atlas test$/,
  );
  const before = await tile(page, P).locator(".tile-art svg").getAttribute("viewBox");

  // a better entry replaces the drawing
  const second = await submitRow(request, slot, 2.4);
  expect(second.score).toBeLessThan(first.score);
  await expect(tile(page, P).locator(".tile-score")).toHaveText(second.score.toFixed(6), { timeout: 20_000 });
  await expect.poll(() => tile(page, P).locator(".tile-art svg").getAttribute("viewBox")).not.toBe(before);
  await tile(page, P).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText(`${second.score.toFixed(6)} by atlas test (own software)`);
  await expect(detail).toContainText("no published value on record");
  await expect(detail.getByRole("link", { name: "Show on the board" })).toHaveAttribute("href", `/#s=${second.id}`);
});

test("the atlas fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    "/browse.html#0,0",
    "/browse.html?layout=rows&scale=row&size=large#3,3",
    "/browse.html?size=small&scale=global&p=5#4,4",
  ]) {
    await page.goto(path);
    await expect(art(page, 1)).toHaveClass(/drawn/);
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect([path, scroll]).toEqual([path, client]);
  }
  // the record panel stays inside the screen
  const box = (await page.getByRole("dialog").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test("the wall of tiles is wider than the chart and the table, which keep their column", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/browse.html#0,4");
  await expect(art(page, 1)).toHaveClass(/drawn/);
  await page.locator("#plot > summary").click();
  const box = (selector: string) => page.locator(selector).evaluate((e) => e.getBoundingClientRect().toJSON());
  const [atlas, chart, table] = [await box("#atlas"), await box("#chart"), await box(".table-wrap")];
  expect(atlas.width).toBeCloseTo(1120, 0);
  expect(chart.width).toBeCloseTo(948, 0);
  expect(table.width).toBeCloseTo(948, 0);
  // all three share one centre line
  expect(atlas.x + atlas.width / 2).toBeCloseTo(chart.x + chart.width / 2, 0);
});

// ---------- placeholders and laziness, on fixtures ----------

test("a tile without coordinates shows a quiet placeholder", async ({ page }) => {
  await serve(page, 5, 7, {
    literature: [
      { P: 1, value: 1.2, status: "trivial_tiling", has_coordinates: true },
      { P: 2, value: 2.25, status: "proven", picture_url: "https://example.org/two.svg" },
      // addresses in the data are followed only when they are http(s) or paths of this site
      { P: 3, value: 2.75, source_url: "javascript:alert(1)", picture_url: "data:text/html,x" },
    ],
    tile: (P) => (P === 1 ? { P, source: "literature", score: 1.2, pieces: grid(1), container_phi: 0 } : undefined),
  });
  await page.goto("/browse.html#5,7");
  await expect(page.locator("#atlas-title")).toHaveText("The atlas of pentagons in a 7-gon");
  await expect(shownTiles(page)).toHaveCount(3);
  await expect(art(page, 1)).toHaveClass(/drawn/);
  await expect(tile(page, 1).locator(".mark-trivial_tiling")).toBeVisible();
  await expect(art(page, 2)).toHaveClass(/empty/);
  await expect(tile(page, 2).locator(".tile-empty")).toHaveText("no coordinates");
  await expect(tile(page, 2).locator(".tile-empty")).toBeVisible();
  await expect(tile(page, 2).locator("polygon.container")).toBeVisible();
  await expect(tile(page, 2).locator("path.piece")).toHaveCount(0);
  await expect(tile(page, 2).locator(".tile-score")).toHaveText("2.250000");
  await expect(tile(page, 2)).toHaveAttribute("aria-label", "P = 2, side 2.250000, proven, no coordinates");
  await expect(page.locator("#atlas-more")).toBeHidden();
  await expect(page.locator("#atlas-legend")).toContainText("no coordinates to draw");
  // the outline of a placeholder is as easy to see as text
  const stroke = await tile(page, 2)
    .locator("polygon.container")
    .evaluate((e) => getComputedStyle(e).stroke);
  expect(stroke).toBe(await page.locator("#note").evaluate((e) => getComputedStyle(e).color));

  // the record of such a tile is complete all the same
  await tile(page, 2).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("Coordinates are not available from the source.");
  await expect(detail.locator(".detail-badges")).toHaveText("proven");
  await expect(detail.getByRole("link", { name: "Picture at the source" })).toHaveAttribute(
    "href",
    "https://example.org/two.svg",
  );
  await expect(detail.getByRole("link", { name: "A fixture of the tests" })).toHaveAttribute(
    "href",
    "https://example.org/source",
  );
  await page.keyboard.press("Escape");
  await tile(page, 3).click();
  await expect(detail.getByRole("heading")).toHaveText("P = 3: 3 pentagons in a 7-gon");
  await expect(detail).toContainText("A fixture of the tests, read 2026-10-07");
  await expect(detail.getByRole("link", { name: "A fixture of the tests" })).toHaveCount(0);
  await expect(detail.getByRole("link", { name: "Picture at the source" })).toHaveCount(0);
  // the table below follows the same rule
  await expect(page.locator("#rows tr").nth(2).locator("a[target=_blank]")).toHaveCount(0);
  await expect(page.locator("#rows tr").nth(1).locator("a[target=_blank]")).toHaveAttribute(
    "href",
    "https://example.org/source",
  );
});

test("drawings are fetched and kept only near the viewport", async ({ page }) => {
  // 500 tiles that all have coordinates, up to 500 circles each
  await page.setViewportSize({ width: 1280, height: 500 });
  const asked = await serve(page, 0, 9, {
    literature: Array.from({ length: 500 }, (_, i) => ({
      P: i + 1,
      value: 2 + 2 * Math.sqrt(i + 1),
      has_coordinates: true,
    })),
    tile: (P) => ({ P, source: "literature", score: 2 + 2 * Math.sqrt(P), pieces: grid(P), container_phi: 0 }),
  });
  const covered = (P: number) => asked.some((a) => a.from <= P && P <= a.to);
  const drawn = () => page.locator("#atlas-tiles .tile-art.drawn").count();
  await page.goto("/browse.html?show=all#0,9");
  await expect(art(page, 1)).toHaveClass(/drawn/);
  await expect(shownTiles(page)).toHaveCount(500);
  await page.waitForTimeout(600);

  // first paint: only the first rows were asked for, in bounded ranges, and nothing far below
  expect(asked.length).toBeGreaterThan(0);
  for (const a of asked) expect(a.to - a.from).toBeLessThan(30);
  expect(Math.max(...asked.map((a) => a.to))).toBeLessThan(150);
  expect(covered(300)).toBe(false);
  await expect(art(page, 300)).toHaveClass(/loading/);
  const firstPaint = await drawn();
  expect(firstPaint).toBeGreaterThan(10);
  expect(firstPaint).toBeLessThan(150);

  // scrolling to a tile fetches its range, and only then
  await tile(page, 300).scrollIntoViewIfNeeded();
  await expect(art(page, 300)).toHaveClass(/drawn/);
  expect(await piecesDrawn(page, 300)).toBe(300);
  expect(covered(300)).toBe(true);
  expect(covered(480)).toBe(false);

  // the drawings left behind are taken out of the page again, so the page never holds all 500
  await expect(art(page, 1)).toHaveClass(/parked/);
  await expect(tile(page, 1).locator("path.piece")).toHaveCount(0);
  await tile(page, 500).scrollIntoViewIfNeeded();
  await expect(art(page, 500)).toHaveClass(/drawn/);
  await page.waitForTimeout(400);
  expect(await drawn()).toBeLessThan(150);
  expect(await page.locator("#atlas-tiles path.piece").count()).toBe(await drawn());
  await expect(art(page, 300)).toHaveClass(/parked|loading/);

  // and they come back when their tiles do
  await tile(page, 1).scrollIntoViewIfNeeded();
  await expect(art(page, 1)).toHaveClass(/drawn/);
  expect(await piecesDrawn(page, 12)).toBe(12);
  await tile(page, 300).scrollIntoViewIfNeeded();
  await expect(art(page, 300)).toHaveClass(/drawn/);
});

// ---------- loading: stale answers, failures, focus ----------

test("an answer that was overtaken by a new site best does not stick", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  const slot = await freeSlot(request);
  // 200 site entries; P = 5 is the one that changes while its drawing is on the way
  let best = { id: 1005, gap: 3 };
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let hold = true;
  const fixture: Fixture = {
    literature: [],
    site: [],
    tile: (P) => ({
      P,
      source: "site",
      score: 1 + P,
      pieces: grid(P, P === 5 ? best.gap : 2),
      container_phi: 0,
      id: P === 5 ? best.id : 1000 + P,
      verification: "none",
    }),
    onAtlas: async (from, to, route) => {
      if (!hold || from > 5 || to < 5) return;
      hold = false;
      // answer with what was true when the request arrived, but only after the test says so
      const tiles = [];
      for (let P = from; P <= to; P++) tiles.push(fixture.tile(P)!);
      await held;
      await route.fulfill({ json: { N: 0, M: slot.M, from, to, next: null, tiles } });
      return "answered";
    },
  };
  const site = () =>
    Array.from({ length: 200 }, (_, i) => ({
      P: i + 1,
      id: i + 1 === 5 ? best.id : 1001 + i,
      score: i + 1 === 5 ? best.gap : 2 + i,
    }));
  fixture.site = site();
  const asked = await serve(page, 0, slot.M, fixture);
  await page.goto(`/browse.html?show=all#0,${slot.M}`);
  await expect(shownTiles(page)).toHaveCount(200);
  await expect.poll(() => asked.some((a) => a.from <= 5 && 5 <= a.to)).toBe(true);
  await expect(art(page, 5)).toHaveClass(/loading/);

  // the tile leaves the neighbourhood of the viewport while its request is still out
  await tile(page, 200).scrollIntoViewIfNeeded();
  await expect(art(page, 200)).toHaveClass(/drawn/);
  // a live update: P = 5 has a new best with another drawing (a real submission elsewhere triggers the refresh)
  best = { id: 2005, gap: 2 };
  fixture.site!.splice(0, fixture.site!.length, ...site());
  await submitRow(request, slot, 3, "atlas nudge");
  await expect(tile(page, 5).locator(".tile-score")).toHaveText("2.000000", { timeout: 20_000 });

  // now the overtaken answer arrives; back at the tile, the drawing is the new one
  const before = asked.length;
  release();
  await page.waitForTimeout(300);
  await tile(page, 5).scrollIntoViewIfNeeded();
  await expect(art(page, 5)).toHaveClass(/drawn/);
  // Five circles on a grid: pitch 2 for the new entry, 3 for the old one. The width of a drawing's
  // frame is proportional to its container, so the unchanged neighbour P = 4 gives the scale.
  const frame = async (P: number) =>
    Number((await tile(page, P).locator(".tile-art svg").getAttribute("viewBox"))!.split(" ")[2]);
  const size = (P: number, gap: number) => enclose(0, grid(P, gap), slot.M, 0).size;
  const perUnit = (await frame(4)) / size(4, 2);
  expect((await frame(5)) / perUnit / size(5, 2)).toBeCloseTo(1, 2);
  // the two drawings are far apart, so this cannot pass by accident
  expect(size(5, 3)).toBeGreaterThan(size(5, 2) * 1.2);
  expect(asked.slice(before).some((a) => a.from <= 5 && 5 <= a.to)).toBe(true);
  // its neighbours, which did not change, took the same answer as it was
  await expect(art(page, 4)).toHaveClass(/drawn/);
});

test("a failed request is retried, then reported with a way to try again", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  let down = true;
  const asked = await serve(page, 0, 11, {
    literature: Array.from({ length: 300 }, (_, i) => ({
      P: i + 1,
      value: 2 + 2 * Math.sqrt(i + 1),
      has_coordinates: true,
    })),
    tile: (P) => ({ P, source: "literature", score: 2 + 2 * Math.sqrt(P), pieces: grid(P), container_phi: 0 }),
    onAtlas: async (_from, _to, route) => {
      if (!down) return;
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
      return "answered";
    },
  });
  await page.goto("/browse.html?show=all#0,11");
  await expect(shownTiles(page)).toHaveCount(300);
  await expect(art(page, 3)).toHaveClass(/loading/);
  // each range is asked for four times (0.4 s, 0.8 s and 1.6 s apart), then the tiles say so
  await expect(art(page, 3)).toHaveClass(/failed/, { timeout: 15_000 });
  await expect(tile(page, 3).locator(".tile-empty")).toHaveText("not loaded");
  await expect(tile(page, 3)).toHaveAttribute("aria-label", /the drawing could not be loaded$/);
  expect(asked.filter((a) => a.from === 1).length).toBe(4);
  const gaveUp = asked.length;
  await page.waitForTimeout(1500);
  expect(asked.length).toBe(gaveUp); // no endless retrying

  // opening the record tries again, and says so when it fails again
  await tile(page, 3).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("The coordinates could not be loaded.", { timeout: 15_000 });
  const again = detail.getByRole("button", { name: "Try again" });
  await expect(again).toBeVisible();
  expect(asked.length).toBeGreaterThan(gaveUp);

  // the server is back: the button loads the drawing
  down = false;
  await again.focus();
  await again.click();
  await expect(detail.locator(".tile-art")).toHaveClass(/drawn/);
  await expect(detail).toContainText("Drawn from published coordinates.");
  // the button is gone and the focus did not fall out of the panel
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(art(page, 3)).toHaveClass(/drawn/);
  await expect(tile(page, 3)).not.toHaveAttribute("aria-label", /could not be loaded/);

  // tiles that gave up in the meantime load when they come back into view
  await tile(page, 300).scrollIntoViewIfNeeded();
  await expect(art(page, 300)).toHaveClass(/drawn/);
  await tile(page, 1).scrollIntoViewIfNeeded();
  await expect(art(page, 20)).toHaveClass(/drawn/);
  await expect(page.locator("#atlas-tiles .tile-art.failed:visible")).toHaveCount(0);
});

test("a refresh leaves an open record and its focus alone", async ({ page, request }) => {
  const slot = await freeSlot(request);
  let best = { id: 1005, score: 9, name: "ann" };
  let listings = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/records")) listings++;
  });
  const fixture: Fixture = {
    literature: [{ P: 5, value: 9.5 }],
    site: [{ P: 5, ...best }],
    tile: (P) =>
      P === 5
        ? {
            P,
            source: "site",
            score: best.score,
            pieces: grid(5, best.score / 3),
            container_phi: 0,
            id: best.id,
            verification: "none",
          }
        : undefined,
  };
  await serve(page, 0, slot.M, fixture);
  await page.goto(`/browse.html#0,${slot.M}`);
  await expect(art(page, 5)).toHaveClass(/drawn/);
  await tile(page, 5).click();
  const detail = page.getByRole("dialog");
  const board = detail.getByRole("link", { name: "Show on the board" });
  await board.focus();
  await board.evaluate((e) => ((e as HTMLElement & { marked?: boolean }).marked = true));
  await expect(detail).toContainText("9.000000 by ann (by hand)");

  // a live event for the same problem, with nothing new about this P: the panel is not rebuilt
  const seen = listings;
  await submitRow(request, slot, 3, "atlas nudge");
  await expect.poll(() => listings, { timeout: 20_000 }).toBeGreaterThan(seen);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement & { marked?: boolean }).marked)).toBe(true);
  await expect(board).toBeFocused();

  // a new best for this P: the panel is rebuilt and the focus is on the same control again
  best = { id: 2005, score: 8, name: "bea" };
  fixture.site![0] = { P: 5, ...best };
  await submitRow(request, slot, 2.5, "atlas nudge");
  await expect(detail).toContainText("8.000000 by bea (by hand)", { timeout: 20_000 });
  await expect(board).toHaveAttribute("href", "/#s=2005");
  await expect(board).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

// ---------- entries that are pending verification ----------

test("a pending entry is never shown as the smallest known value", async ({ page }) => {
  const row = (n: number, gap: number): Pose[] =>
    Array.from({ length: n }, (_, i) => ({ x: gap * i, y: 0, theta: Math.PI / 4 }));
  await serve(page, 4, 9, {
    literature: [
      // a claim against a proven value without coordinates: the claim is all that can be drawn
      { P: 3, value: 5, status: "proven" },
      // a claim against published coordinates: those are drawn
      { P: 4, value: 6, has_coordinates: true },
      // a claim beside a verified entry that is behind the published value: the verified entry is drawn
      { P: 5, value: 7 },
      { P: 6, value: 7.5 },
    ],
    site: [
      { P: 3, id: 73, score: 3, name: "pat", verification: "pending" },
      { P: 4, id: 74, score: 4.2, name: "pat", verification: "pending" },
      { P: 5, id: 75, score: 5.1, name: "pat", verification: "pending" },
    ],
    site_verified: [{ P: 5, id: 65, score: 7.4, name: "ann" }],
    tile: (P) =>
      P === 3
        ? { P, source: "site", score: 3, pieces: row(3, 1), container_phi: 0, id: 73, verification: "pending" }
        : P === 4
          ? { P, source: "literature", score: 6, pieces: row(4, 1.5), container_phi: 0 }
          : P === 5
            ? { P, source: "site", score: 7.4, pieces: row(5, 1.6), container_phi: 0, id: 65, verification: "none" }
            : undefined,
  });
  await page.goto("/browse.html?layout=rows&size=large#4,9");
  await expect(art(page, 3)).toHaveClass(/drawn/);

  // the caption is the published value, not the claim; the claim is flagged in three ways
  await expect(tile(page, 3).locator(".tile-score")).toHaveText("5.000000");
  await expect(tile(page, 3).locator(".mark-pending")).toBeVisible();
  await expect(tile(page, 3).locator(".mark-site")).toHaveCount(0);
  await expect(art(page, 3)).toHaveClass(/pending-drawing/);
  await expect(tile(page, 3).locator(".tile-flag")).toHaveText("pending");
  await expect(tile(page, 3).locator(".tile-flag")).toBeVisible();
  await expect(tile(page, 3)).toHaveAttribute(
    "aria-label",
    "P = 3, side 5.000000, proven, an entry at 3.000000 is pending verification, drawing: the pending entry by pat",
  );
  await expect(page.locator("#atlas-legend")).toContainText("an entry is pending verification");

  // published coordinates and verified entries are drawn before any claim
  await expect(tile(page, 4).locator(".tile-score")).toHaveText("6.000000");
  await expect(art(page, 4)).not.toHaveClass(/pending-drawing|not-record/);
  await expect(tile(page, 4)).toHaveAttribute("aria-label", /pending verification, drawn from published coordinates$/);
  await expect(tile(page, 5).locator(".tile-score")).toHaveText("7.000000");
  await expect(art(page, 5)).toHaveClass(/not-record/);
  await expect(art(page, 5)).not.toHaveClass(/pending-drawing/);
  await expect(tile(page, 5)).toHaveAttribute("aria-label", /drawing: entry by ann at 7\.400000$/);

  // the claim does not move its tile to another row, nor set the scale
  const rowOf = (P: number) =>
    tile(page, P).locator("xpath=ancestor::div[contains(@class,'tile-group')]").locator(".group-label");
  await expect(rowOf(3)).toHaveText("s ≤ 5");
  await expect(rowOf(4)).toHaveText("s ≤ 6");
  await expect(rowOf(5)).toHaveText("s ≤ 7");
  const k = (P: number) =>
    tile(page, P).evaluate((a) => Number(getComputedStyle(a.parentElement!).getPropertyValue("--k-global")));
  // against the largest container shown: the published 7.5 of P = 6; the verified drawing of P = 5 is 7.4 across
  expect(await k(3)).toBeCloseTo(5 / 7.5, 3);
  expect(await k(4)).toBeCloseTo(6 / 7.5, 3);
  expect(await k(5)).toBeCloseTo(7.4 / 7.5, 3);

  // the record says the same
  await tile(page, 3).click();
  const detail = page.getByRole("dialog");
  await expect(detail.locator("dd.big")).toHaveText("5.000000");
  await expect(detail.locator(".detail-badges")).toContainText("an entry is pending verification");
  await expect(detail.locator(".detail-list")).toContainText("Site bestnone verified yet");
  await expect(detail.locator(".detail-list")).toContainText("Pending verification3.000000 by pat (by hand)");
  await expect(detail).toContainText("which is pending verification and is not counted as a known value");
  await expect(detail.locator(".tile-art")).toHaveClass(/pending-drawing/);
  await page.keyboard.press("Escape");
  await tile(page, 5).click();
  await expect(detail.locator("dd.big")).toHaveText("7.000000");
  await expect(detail.locator(".detail-list")).toContainText("Site best7.400000 by ann (by hand)");
  await expect(detail.locator(".detail-list")).toContainText("Pending verification5.100000 by pat (by hand)");
  await expect(detail).toContainText("Drawn from the entry by ann at 7.400000: above the published value");
});

test("without the server the atlas says so", async ({ page }) => {
  await page.route("**/api/records?*", (route) => route.abort());
  await page.goto("/browse.html#6,8");
  await expect(page.locator("#atlas-lede")).toHaveText(/The server is not reachable/);
  await expect(page.locator("#atlas-lede")).not.toContainText("Nothing to show");
  await expect(shownTiles(page)).toHaveCount(0);
});

// ---------- accessibility ----------

for (const scheme of ["light", "dark"] as const) {
  test(`the atlas and its record panel have no automatic accessibility violations (${scheme})`, async ({ browser }) => {
    const page = await (await browser.newContext({ colorScheme: scheme })).newPage();
    for (const path of [
      "/browse.html#0,0",
      "/browse.html?layout=rows&size=small&scale=row#3,3",
      "/browse.html?size=large&p=4#3,3",
      "/browse.html?p=11#4,4",
    ]) {
      await page.goto(path);
      await expect(art(page, 1)).toHaveClass(/drawn/);
      if (path.includes("p=")) await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(
        results.violations.map((v) => `${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 120)}`),
      ).toEqual([]);
    }
    await page.context().close();
  });
}
