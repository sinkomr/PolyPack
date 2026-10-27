import AxeBuilder from "@axe-core/playwright";
import { type Page, type Route, expect, test } from "@playwright/test";
import { SPACE_INFO, type SpaceProblemResponse, validateSpaceSubmission } from "@polypack/spaces";
import { foldGain, gainText } from "../apps/web/src/boundary-model";
import { DEFAULT_PROBLEM } from "../apps/web/src/space/model";
import { LAZY_VIEW, distinctColours, openProblem, pageErrors } from "./helpers";

// 3D on 4D on the board, against the local stack (playwright.config.ts): the server lists the
// research records of data/boundary/records.json and checks submissions; the board draws a
// problem with the three.js views of packages/view3d, runs the boundary search in a Web Worker
// and submits a better packing.

declare const polypack: {
  space?: { lastResult: { config: unknown; score: number; valid: boolean; submittable: boolean } | null };
};

const ID = DEFAULT_PROBLEM.boundary;

/**
 * A problem as the server has it now, with what the board shows for it: its best edge, the edge
 * without folding and the gain. The records change as better packings are certified, so no value
 * of a record is written in these tests.
 */
async function problemOf(page: Page, id: string) {
  const api = (await (await page.request.get(`/api/spaces/boundary/problems/${id}`)).json()) as SpaceProblemResponse;
  const nofold = api.extra!.nofold!.value;
  return {
    api,
    edge: api.best_score!.toFixed(6),
    nofold: nofold.toFixed(6),
    gain: gainText(foldGain(api.best_score, nofold)),
  };
}

/** The P the catalogue lists for a piece, in order. */
async function listedP(page: Page, piece: "ball" | "cube"): Promise<number[]> {
  const body = (await (await page.request.get("/api/spaces/boundary/records")).json()) as {
    problems: { id: string; P: number }[];
  };
  return body.problems
    .filter((p) => p.id.split("/")[2] === piece)
    .map((p) => p.P)
    .sort((a, b) => a - b);
}

/** Waits until the board shows a 3D on 4D problem, drawn. */
async function shown(page: Page, id: string): Promise<void> {
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`, LAZY_VIEW);
  await expect(page.locator("#space-score")).not.toHaveText("—");
  await expect(page.locator(".pp3 canvas")).toBeVisible(LAZY_VIEW);
  await expect(page.locator(".pp3-status")).toContainText(/edge \d\.\d{6}\./);
}

const canvas = (page: Page) => page.locator(".pp3 canvas");
const button = (page: Page, name: string) => page.locator(".pp3").getByRole("button", { name, exact: true });

/** The drawing as it is now: a screenshot of its canvas, after the next two frames. */
async function picture(page: Page): Promise<Buffer> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return canvas(page).screenshot();
}

/** Runs the optimizer with an evaluation budget and waits for its end; returns the status line. */
async function runFor(page: Page, evals: number, seed = 1): Promise<string> {
  await page.selectOption("#space-solve-budget", "evals");
  await page.fill("#space-solve-evals", String(evals));
  await page.fill("#space-solve-seed", String(seed));
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-stop")).toBeDisabled({ timeout: 90_000 });
  await expect(page.locator("#space-solve-run")).toBeEnabled();
  return (await page.locator("#space-solve-status").textContent()) ?? "";
}

test("3D on 4D is chosen from the menus and drawn as cells, as a net that folds, and in slices", async ({ page }) => {
  const errors = pageErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openProblem(page, 4, 4, 5);
  await expect(page.locator("#family-select option[value='boundary']")).toBeEnabled();
  await page.selectOption("#family-select", "boundary");
  await expect(page.locator("#family-select")).toHaveValue("boundary");
  await expect(page.locator("#family-select optgroup[label='3D on 4D'] option")).toHaveText([
    "3D on 4D: Polytope boundaries",
  ]);
  await shown(page, ID);
  await expect(page).toHaveURL(new RegExp(`#space=${ID}$`));
  await expect(page.locator("main")).toHaveAttribute("data-dimension", "3-on-4");
  await expect(page.locator("main")).toHaveAttribute("data-space", "boundary");
  await expect(page.locator("#board")).toBeHidden();

  // the picker offers the catalogue's values only
  await expect(page.locator("#space-fields label")).toHaveText(["Polytope", "Piece", "Pieces (P)"]);
  await expect(page.locator("#space-f-polytope option")).toHaveText(["Tesseract"]);
  await expect(page.locator("#space-f-piece option")).toHaveText(["Balls", "Cubes"]);
  await expect(page.locator("#space-f-P option")).toHaveText((await listedP(page, "ball")).map(String));

  // the usual values, and what folding gains
  const nine = await problemOf(page, ID);
  const api = nine.api;
  await expect(page.locator("#space-score-label")).toHaveText("Tesseract edge s");
  await expect(page.locator("#space-score")).toHaveText(nine.edge);
  const facts = page.locator("#space-facts");
  await expect(facts).toContainText(`Certified value${api.certified!.display}`);
  await expect(facts).toContainText("Statusbest known");
  await expect(facts).toContainText(`Lower bound${api.bound!.value.toFixed(6)}`);
  // nine balls without folding: two in one cell, 2 + 2 / sqrt 3 (docs/spaces/BOUNDARY.md 6)
  await expect(facts).toContainText(`Without folding${nine.nofold}`);
  expect(nine.nofold).toBe((2 + 2 / Math.sqrt(3)).toFixed(6));
  await expect(facts).toContainText(`Folding gains${nine.gain}`);
  await expect(facts).toContainText("Entriesopen");
  await expect(page.locator("#space-values-note")).toContainText("exact rational arithmetic");
  await page.locator("#space-about summary").click();
  await expect(page.locator("#space-about")).toContainText("Pieces are not moved by hand here.");
  await expect(page.locator("#space-turn-help")).toContainText("Fold folds the net up into the fourth dimension");
  await expect(page.locator("#space-docs")).toHaveAttribute("href", SPACE_INFO.boundary.docs);

  // Cells: the eight cells, drawn
  await expect(page.locator(".pp3").getByRole("toolbar")).toHaveAttribute("aria-label", "Drawing");
  await expect(button(page, "Cells")).toHaveAttribute("aria-pressed", "true");
  const cells = await picture(page);
  expect(await distinctColours(page, cells)).toBeGreaterThan(40);
  await expect(canvas(page)).toHaveAttribute("aria-label", /9 balls|cells/i);

  // Net: flat, then folded with the slider, then unfolded with the button
  await button(page, "Net").click();
  await expect(button(page, "Net")).toHaveAttribute("aria-pressed", "true");
  const fold = page.getByRole("slider", { name: "Fold" });
  await expect(fold).toBeVisible();
  await expect(fold).toHaveAttribute("aria-valuetext", "flat");
  const flat = await picture(page);
  expect(flat.equals(cells)).toBe(false);
  await fold.fill("1000");
  await expect(fold).toHaveAttribute("aria-valuetext", "folded");
  await expect(button(page, "Unfold")).toBeVisible();
  const folded = await picture(page);
  expect(folded.equals(flat)).toBe(false);
  expect(await distinctColours(page, folded)).toBeGreaterThan(40);
  await button(page, "Unfold").click();
  await expect(fold).toHaveAttribute("aria-valuetext", "flat");
  await button(page, "Fold up").click();
  await expect(fold).toHaveAttribute("aria-valuetext", "folded");

  // Slice: an axis, the position, a strip of nine
  await button(page, "Slice").click();
  await expect(fold).toBeHidden();
  const axes = page.getByRole("group", { name: "Slice across axis" });
  await expect(axes.getByRole("button")).toHaveText(["x", "y", "z", "w"]);
  await page.getByRole("button", { name: "Slice across x" }).click();
  await expect(page.getByRole("button", { name: "Slice across x" })).toHaveAttribute("aria-pressed", "true");
  const position = page.getByRole("slider", { name: "Position" });
  await expect(position).toHaveAttribute("aria-valuetext", /^x = /);
  const middle = await picture(page);
  await position.fill("150");
  const offCentre = (await position.getAttribute("aria-valuetext"))!;
  expect(offCentre).toMatch(/^x = −/);
  expect((await picture(page)).equals(middle)).toBe(false);
  await button(page, "Strip of 9").click();
  await expect(button(page, "Strip of 9")).toHaveAttribute("aria-pressed", "true");
  await expect(position).toBeHidden();
  await button(page, "Strip of 9").click();
  await expect(position).toBeVisible();

  // the keyboard turns the drawing and follows one piece at a time
  await canvas(page).focus();
  const before = await picture(page);
  await page.keyboard.press("Shift+ArrowRight");
  expect((await picture(page)).equals(before)).toBe(false);
  await page.keyboard.press("PageDown");
  await expect(page.locator(".pp3-status")).toHaveText(/^Ball 1: centre in cell /);
  await page.keyboard.press("Escape");
  await expect(page.locator(".pp3-status")).toHaveText(
    new RegExp(`^9 balls, edge ${nine.edge.replace(".", "\\.")}\\.`),
  );

  // another P keeps the drawing, with the view and the slice chosen
  await canvas(page).evaluate((c) => ((c as HTMLCanvasElement & { kept?: boolean }).kept = true));
  await page.selectOption("#space-f-P", "10");
  await shown(page, "boundary/tesseract/ball/10");
  expect(await canvas(page).evaluate((c) => (c as HTMLCanvasElement & { kept?: boolean }).kept)).toBe(true);
  await expect(button(page, "Slice")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Slice across x" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/#space=boundary\/tesseract\/ball\/10$/);

  // another piece needs a drawing of its own, which opens in the view last used
  await page.selectOption("#space-f-piece", "cube");
  await shown(page, "boundary/tesseract/cube/10");
  await expect(button(page, "Slice")).toHaveAttribute("aria-pressed", "true");
  const ten = await problemOf(page, "boundary/tesseract/cube/10");
  await expect(page.locator(".pp3-status")).toHaveText(
    new RegExp(`^10 cubes, edge ${ten.edge.replace(".", "\\.")}\\.`),
  );
  await expect(page.locator("#space-facts")).toContainText(`Without folding${ten.nofold}`);
  await expect(page.locator("#space-facts")).toContainText(`Folding gains${ten.gain}`);
  expect(await distinctColours(page, await picture(page))).toBeGreaterThan(20);

  // back to the polygon board, and to 3D on 4D again
  await page.selectOption("#family-select", "polygon");
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator(".space-stage")).toBeHidden();
  await expect(page.locator("main")).toHaveAttribute("data-dimension", "2-in-2");
  await page.selectOption("#family-select", "boundary");
  await shown(page, "boundary/tesseract/cube/10");
  expect(errors).toEqual([]);
});

test("a deep link opens a 3D on 4D problem, and one that is not listed opens the nearest", async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto("/#space=boundary/tesseract/cube/12");
  await shown(page, "boundary/tesseract/cube/12");
  await expect(page.locator("main")).toHaveAttribute("data-dimension", "3-on-4");
  await expect(page.locator("#family-select")).toHaveValue("boundary");
  await expect(page.locator("#space-f-piece")).toHaveValue("cube");
  await expect(page.locator("#space-f-P")).toHaveValue("12");
  await expect(page.locator("#space-score")).toHaveText((await problemOf(page, "boundary/tesseract/cube/12")).edge);

  // a P beyond the catalogue's opens its largest
  const last = `boundary/tesseract/cube/${Math.max(...(await listedP(page, "cube")))}`;
  await page.goto("about:blank");
  await page.goto("/#space=boundary/tesseract/cube/9999");
  await shown(page, last);
  await expect(page.locator("#space-status")).toHaveText(
    `boundary/tesseract/cube/9999 is not in the catalogue, so ${last} is shown.`,
  );
  await expect(page).toHaveURL(new RegExp(`#space=${last}$`));

  // the kind alone opens its starting problem; Back returns to the polygon board
  await page.goto("about:blank");
  await openProblem(page, 4, 4, 5);
  await page.evaluate(() => (location.hash = "#space=boundary"));
  await shown(page, ID);
  await page.goBack();
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#family-select")).toHaveValue("polygon");

  // each row of the dimensions page opens its problem here
  await page.goto("/dimensions.html#space=boundary&polytope=tesseract&piece=ball");
  const row = page.locator('#space-rows tr[data-id="boundary/tesseract/ball/5"]');
  await row.getByRole("link", { name: /^Open on the board/ }).click();
  await shown(page, "boundary/tesseract/ball/5");
  expect(errors).toEqual([]);
});

test("a short run completes, and Submit is offered only for a result that beats the problem's best", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const id = "boundary/tesseract/ball/4";
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  await expect(page.locator("#space-method")).toContainText("Penalty relaxation of the pieces across the cells");
  await expect(page.locator("#space-solve-unit")).toContainText("one evaluation of the penalty energy");
  // the starting budget, within the limit of this kind's cheap evaluations
  await expect(page.locator("#space-solve-evals")).toHaveValue("3000000");
  await expect(page.locator("#space-solve-evals")).toHaveAttribute("max", "100000000");
  await page.fill("#space-solve-evals", "100000001");
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-status")).toHaveText(
    "Evaluations: enter a whole number from 1 to 100,000,000. Nothing was run.",
  );
  const status = await runFor(page, 20000);
  expect(status).toMatch(/^(Evaluation limit reached|Reached the lower bound)\./);
  await expect(page.locator("#space-solve-progress")).toContainText("evaluations");
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.valid).toBe(true);
  // the server's own check accepts it at its stated size
  const api = (await (await page.request.get(`/api/spaces/boundary/problems/${id}`)).json()) as SpaceProblemResponse;
  const v = validateSpaceSubmission("boundary", id, result.config, {
    bound: api.bound?.value ?? null,
    certified: api.certified?.score ?? null,
  });
  expect(v.valid, v.reasons.join("; ")).toBe(true);
  // a short run does not beat the research record, so nothing is offered
  await expect(page.locator("#space-submit")).toBeDisabled();
  await expect(page.locator("#space-submit-note")).toContainText("does not beat the problem's best");

  // with the record shown 2% larger than it is, a run beats it; the real server then judges
  await page.route(`**/api/spaces/boundary/problems/${id}`, weakenRecord);
  await page.goto("about:blank");
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  const weak = Number(await page.locator("#space-score").textContent());
  expect(weak).toBeGreaterThan(api.certified!.score * 1.01);
  const beat = await runFor(page, 20000);
  expect(beat).toContain(`beats the problem's best ${weak.toFixed(6)}. You can submit it.`);
  await expect(page.locator("#space-submit")).toBeEnabled();
  await page.fill("#name", "E2E board");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/spaces/submit") && r.method() === "POST");
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/spaces/submit"));
  await page.click("#space-submit");
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({
    space: "boundary",
    id,
    name: "E2E board",
    method: "boundary compression search (board, from the research record)",
    seed: 1,
  });
  expect((await answered).status()).toBe(200);
  // valid by the server's rule, but not better than the real record
  await expect(page.locator("#space-submit-result")).toContainText("✓ Valid, score");
  await expect(page.locator("#space-submit-result")).toContainText("but not kept");
});

/** Serves a problem whose research record is 2% larger than it is: the tesseract grows, the centres move with it. */
async function weakenRecord(route: Route): Promise<void> {
  let r: Awaited<ReturnType<Route["fetch"]>>;
  let body: SpaceProblemResponse;
  try {
    r = await route.fetch();
    body = (await r.json()) as SpaceProblemResponse;
  } catch {
    // the page went away (the test ended) while the problem was read again
    return;
  }
  // scaling the tesseract with its centres keeps a packing valid (docs/spaces/BOUNDARY.md 4.4)
  const config = body.certified_config as { s: number; pieces: { cell: number; u: number[] }[] };
  const s = config.s * 1.02;
  const pieces = config.pieces.map((p) => ({ ...p, u: p.u.map((x) => x * 1.02) }));
  await route.fulfill({
    response: r,
    json: {
      ...body,
      certified: { ...body.certified!, score: s, display: s.toFixed(6) },
      best_score: s,
      certified_config: { s, pieces },
    },
  });
}

test("without WebGL the drawing says so in plain words, and the rest of the board works", async ({ page }) => {
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return /webgl/i.test(type) ? null : (get as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof get;
  });
  await page.goto(`/#space=${ID}`);
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${ID}`, LAZY_VIEW);
  await expect(page.locator(".pp3-message")).toHaveText(
    "This 3D drawing needs WebGL, which this browser has turned off or does not support.",
    LAZY_VIEW,
  );
  await expect(page.locator(".pp3 canvas")).toHaveCount(0);
  await expect(page.locator(".pp3-bar")).toBeHidden();
  await expect(page.locator("#space-facts")).toContainText(`Folding gains${(await problemOf(page, ID)).gain}`);
  await expect(page.locator("#space-solve-run")).toBeEnabled();
});

test("a 3D drawing that cannot be loaded says so and loads on Try again", async ({ page }) => {
  let fail = true;
  // the module in development, its chunk in a build (vite.config.ts)
  await page.route(/\/packages\/view3d\/src\/index\.ts|\/assets\/view3d-[^/]*\.js/, (route) =>
    fail ? route.abort() : route.continue(),
  );
  await page.goto(`/#space=${ID}`);
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${ID}`, LAZY_VIEW);
  await expect(page.locator(".space-3d-wait")).toContainText("The 3D drawing could not be loaded.");
  fail = false;
  await page.locator(".space-3d-wait").getByRole("button", { name: "Try again" }).click();
  await shown(page, ID);
});

// The whole board once per theme, with the drawing in Cells, then the drawing alone in each other
// view: Net with its fold, Slice with its axes and position (the viewer scans its own page once).
for (const scheme of ["light", "dark"] as const) {
  test(`3D on 4D on the board has no automatic accessibility violations (${scheme})`, async ({ browser }) => {
    const page = await (await browser.newContext({ colorScheme: scheme })).newPage();
    const errors = pageErrors(page);
    await page.goto(`/#space=${ID}`);
    await shown(page, ID);
    const scan = async (what: string, region?: string) => {
      const axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
      const results = await (region ? axe.include(region) : axe).analyze();
      expect(
        results.violations.map((v) => `${what}: ${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`),
      ).toEqual([]);
    };
    await expect(button(page, "Cells")).toHaveAttribute("aria-pressed", "true");
    await scan("Cells, the whole board");
    await button(page, "Net").click();
    await expect(page.getByRole("slider", { name: "Fold" })).toBeVisible();
    await scan("Net", ".pp3");
    await button(page, "Slice").click();
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
    await scan("Slice", ".pp3");
    expect(errors).toEqual([]);
  });
}
