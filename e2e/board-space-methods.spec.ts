import { type Page, type Route, expect, test } from "@playwright/test";
import { type SpaceName, type SpaceProblemResponse, validateSpaceSubmission } from "@polypack/spaces";
import { POLYGON_METHOD_DESCRIPTIONS, POLYGON_METHOD_NAMES } from "../apps/web/src/solve-methods";
import { parseSearchProblem } from "@polypack/spaces/search";
import { DEFAULT_PROBLEM, METHOD_TEXT, boardMethods, genericRound } from "../apps/web/src/space/model";
import { LAZY_VIEW } from "./helpers";

// The Method menu of the space mode's Solve panel against the local stack (playwright.config.ts):
// Auto, each kind's own search, is the default everywhere; nofold surface problems also offer the
// polygon solver's methods; the choice is remembered per kind, and a submission names the method.

const SPACES: SpaceName[] = ["surface", "curved", "sphere", "torus", "boundary", "polyhedra"];
const NOFOLD = "surface/cube/nofold/4/13";

declare const polypack: {
  space?: { lastResult: { config: unknown; score: number; valid: boolean; submittable: boolean } | null };
};

/** Waits until the space mode shows a problem's packing. */
async function shown(page: Page, id: string): Promise<void> {
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`, LAZY_VIEW);
  await expect(page.locator("#space-score")).not.toHaveText("—");
}

/** Runs the optimizer with an evaluation budget and waits for its end; returns the status line. */
async function runFor(page: Page, evals: number, seed = 1): Promise<string> {
  await page.selectOption("#space-solve-budget", "evals");
  await page.fill("#space-solve-evals", String(evals));
  await page.fill("#space-solve-seed", String(seed));
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-stop")).toBeDisabled({ timeout: 60_000 });
  await expect(page.locator("#space-solve-run")).toBeEnabled();
  return (await page.locator("#space-solve-status").textContent()) ?? "";
}

/** Serves the nofold problem with a research record 2 % worse: the solid grows, the pieces keep their places in their faces. */
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
  const config = body.certified_config as { s: number; pieces: unknown[] };
  const s = config.s * 1.02;
  await route.fulfill({
    response: r,
    json: {
      ...body,
      certified: { ...body.certified!, score: s, display: s.toFixed(6) },
      best_score: s,
      certified_config: { ...config, s },
    },
  });
}

test("the Method menu offers Auto by default in every kind, described as the kind's own search", async ({ page }) => {
  test.setTimeout(120_000);
  for (const space of SPACES) {
    const id = DEFAULT_PROBLEM[space];
    await page.goto("about:blank");
    await page.goto(`/#space=${id}`);
    await shown(page, id);
    const select = page.locator("#space-solve-method");
    await expect(select, space).toHaveValue("auto");
    await expect(select.locator("option").first()).toHaveText("Auto");
    await expect(page.locator("label[for=space-solve-method]")).toHaveText("Method");
    await expect(page.locator("#space-method")).toHaveText(METHOD_TEXT[space]);
    // Auto has no settings of its own
    await expect(page.locator("#space-solve-more")).toBeHidden();
  }
});

test("a nofold problem lists the polygon solver's methods, a short run of one completes, and a submission names it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.route(`**/api/spaces/surface/problems/${NOFOLD}`, weakenRecord);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/spaces/submit", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      json: { valid: true, reasons: [], score: 1, leader: false, best_score: 1, id: null, beats_certified: false },
    });
  });
  await page.goto(`/#space=${NOFOLD}`);
  await shown(page, NOFOLD);
  const weak = Number(await page.locator("#space-score").textContent());
  const select = page.locator("#space-solve-method");
  await expect(select).toHaveValue("auto");
  await expect(page.locator("#space-method")).toHaveText(METHOD_TEXT.nofold);
  const names = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(names[0]).toBe("auto");
  expect(names.slice(1, 4)).toEqual(["basin_hopping", "penalty", "mc_compress"]);
  expect(names).toEqual(expect.arrayContaining(["asc", "morph", "harden", "shrink_repair", "seed", "polish"]));
  expect(names).not.toContain("identity");
  await expect(select.locator('option[value="mc_compress"]')).toHaveText(POLYGON_METHOD_NAMES.mc_compress);

  await select.selectOption("mc_compress");
  await expect(page.locator("#space-method")).toHaveText(POLYGON_METHOD_DESCRIPTIONS.mc_compress);
  await expect(page.locator("#space-solve-unit")).toContainText("one evaluation of the polygon solver");
  // its settings, from its schema; a value out of range is refused before anything runs
  const more = page.locator("#space-solve-more");
  await expect(more).toBeVisible();
  await more.locator("summary").click();
  const step = page.locator("#space-param-translationStep");
  await expect(step).toHaveValue("0.15");
  await step.fill("-5");
  // closed again: a rejected setting opens it
  await more.locator("summary").click();
  await expect(step).toBeHidden();
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-status")).toHaveText(
    /^Translation step: must be at least \S+\. Nothing was run\.$/,
  );
  await expect(step).toBeFocused();
  await expect(step).toHaveAttribute("aria-invalid", "true");
  await step.fill("0.2");

  const status = await runFor(page, 3000);
  expect(status).toMatch(/^(Evaluation limit reached|Reached the lower bound)\./);
  expect(status).toContain("beats the problem's best");
  await expect(page.locator("#space-solve-progress")).toContainText("evaluations");
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.valid).toBe(true);
  expect(result.score).toBeLessThan(weak * (1 - 1e-9));
  const api = (await (await page.request.get(`/api/spaces/surface/problems/${NOFOLD}`)).json()) as SpaceProblemResponse;
  const v = validateSpaceSubmission("surface", NOFOLD, result.config, {
    bound: api.bound?.value ?? null,
    certified: api.certified?.score ?? null,
  });
  expect(v.valid, v.reasons.join("; ")).toBe(true);

  await page.fill("#name", "E2E board");
  await expect(page.locator("#space-submit")).toBeEnabled();
  await page.click("#space-submit");
  await expect(page.locator("#space-submit-result")).toContainText("✓ Valid");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    space: "surface",
    id: NOFOLD,
    // the settings changed from the defaults go with it; with them the start does not fit in 80 characters
    method: 'surface nofold: mc_compress on one face {"translationStep":0.2}',
    seed: 1,
  });
});

/** Serves a sphere problem whose research record is 2 % worse: the sphere grows, its pieces keep their places. */
async function weakenSphere(route: Route): Promise<void> {
  let r: Awaited<ReturnType<Route["fetch"]>>;
  let body: SpaceProblemResponse;
  try {
    r = await route.fetch();
    body = (await r.json()) as SpaceProblemResponse;
  } catch {
    return;
  }
  const config = body.certified_config as { rho: number; pieces: unknown[] };
  const rho = config.rho * 1.02;
  await route.fulfill({
    response: r,
    json: {
      ...body,
      certified: { ...body.certified!, score: rho, display: rho.toFixed(6) },
      best_score: rho,
      certified_config: { ...config, rho },
    },
  });
}

test("a short run of a generic method on the sphere completes, with its own settings, and a submission names it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const id = "sphere/4/10";
  const search = parseSearchProblem(id)!;
  const penalty = boardMethods(search).find((m) => m.name === "penalty")!;
  await page.route(`**/api/spaces/sphere/problems/${id}`, weakenSphere);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/spaces/submit", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      json: { valid: true, reasons: [], score: 1, leader: false, best_score: 1, id: null, beats_certified: false },
    });
  });
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  const weak = Number(await page.locator("#space-score").textContent());
  const select = page.locator("#space-solve-method");
  const names = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(names).toEqual(boardMethods(search).map((m) => m.name));
  await select.selectOption("penalty");
  await expect(page.locator("#space-method")).toHaveText(penalty.summary);
  await expect(page.locator("#space-solve-unit")).toContainText(
    "An evaluation here is one evaluation of the penalty energy",
  );
  // its settings as its schema states them: no polygon units
  await page.locator("#space-solve-more summary").click();
  await expect(
    page.locator("#space-solve-params .parameter span").filter({ hasText: /^Symmetry breaking/ }),
  ).toHaveText("Symmetry breaking");
  await expect(page.locator("#space-solve-params-note")).not.toContainText("degrees");

  const status = await runFor(page, genericRound(search));
  expect(status).toMatch(/^(Evaluation limit reached|Reached the lower bound)\./);
  expect(status).toContain("beats the problem's best");
  // the method may finish its work before a round's evaluations are spent: then more rounds follow
  await expect(page.locator("#space-solve-progress")).toHaveText(/^[\d,]+ rounds? · [\d,]+ evaluations · /);
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.valid).toBe(true);
  expect(result.score).toBeLessThan(weak * (1 - 1e-9));

  await page.fill("#name", "E2E board");
  await page.click("#space-submit");
  await expect(page.locator("#space-submit-result")).toContainText("✓ Valid");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    space: "sphere",
    id,
    method: "sphere penalty (board, from the research record)",
    seed: 1,
  });
});

test("the method chosen survives a reload, per kind", async ({ page }) => {
  await page.goto(`/#space=${NOFOLD}`);
  await shown(page, NOFOLD);
  await page.selectOption("#space-solve-method", "penalty");
  await page.reload();
  await shown(page, NOFOLD);
  await expect(page.locator("#space-solve-method")).toHaveValue("penalty");
  await expect(page.locator("#space-method")).toHaveText(POLYGON_METHOD_DESCRIPTIONS.penalty);
  // another nofold problem keeps it; a fold problem of the same solid has its own choice, Auto
  await page.evaluate(() => (location.hash = "#space=surface/cube/nofold/4/7"));
  await shown(page, "surface/cube/nofold/4/7");
  await expect(page.locator("#space-solve-method")).toHaveValue("penalty");
  await page.evaluate(() => (location.hash = "#space=surface/cube/fold/0/10"));
  await shown(page, "surface/cube/fold/0/10");
  await expect(page.locator("#space-solve-method")).toHaveValue("auto");
  // Auto, chosen again, is remembered too
  await page.evaluate(() => (location.hash = `#space=${"surface/cube/nofold/4/13"}`));
  await shown(page, NOFOLD);
  await page.selectOption("#space-solve-method", "auto");
  await page.reload();
  await shown(page, NOFOLD);
  await expect(page.locator("#space-solve-method")).toHaveValue("auto");
});
