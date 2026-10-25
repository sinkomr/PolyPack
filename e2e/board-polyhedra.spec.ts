import { type Page, type Route, expect, test } from "@playwright/test";
import { type SpaceProblemResponse, validateSpaceSubmission } from "@polypack/spaces";
import { DEFAULT_PROBLEM } from "../apps/web/src/space/model";
import { LAZY_VIEW, openProblem } from "./helpers";

// 3D in 3D on the board: polyhedra packed in polyhedra, drawn with three.js, searched in a Web
// Worker, submitted to the local server (playwright.config.ts) or to a mocked one.

declare const polypack: {
  space?: {
    lastResult: { config: unknown; score: number; valid: boolean; submittable: boolean } | null;
    renderer: { describe(): string; measureFrames?(n: number): number | null } | null;
  };
};

/** Waits until the space mode shows a problem's packing. */
async function shown(page: Page, id: string): Promise<void> {
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`);
  await expect(page.locator("#space-score")).not.toHaveText("—");
}

/** Waits until the drawing has drawn the packing (three.js loaded, the description written). */
async function drawn(page: Page, pieces: number): Promise<void> {
  await expect(page.locator(".space-draw")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${pieces} .* of scale \\d+\\.\\d{6}, drawn in 3D\\. Drag it or use the arrow keys to turn it\\.$`),
  );
  // a frame was drawn: the measurement hook answers once three.js has made its scene
  await expect.poll(() => page.evaluate(() => polypack.space!.renderer?.measureFrames?.(1) ?? null)).not.toBeNull();
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

test("3D in 3D > Polyhedra opens a problem, draws it with three.js loaded for this mode only, and picks another", async ({
  page,
}) => {
  const three: string[] = [];
  page.on("request", (r) => {
    if (/three/i.test(new URL(r.url()).pathname)) three.push(r.url());
  });
  await openProblem(page, 4, 4, 5);
  const dimension = page.locator("#dimension-select");
  await expect(dimension.locator('option[value="3-in-3"]')).toHaveText("3D in 3D");
  await expect(dimension.locator('option[value="3-in-3"]')).toBeEnabled();
  expect(three).toEqual([]);

  await page.selectOption("#dimension-select", "3-in-3");
  await expect(page.locator("#kind-select option")).toHaveText(["Polyhedra"]);
  await expect(page.locator("#kind-select")).toHaveValue("polyhedra");
  await shown(page, DEFAULT_PROBLEM.polyhedra);
  await expect(page).toHaveURL(/#space=polyhedra\/cubincub\/11$/);
  await expect(page.locator("main")).toHaveAttribute("data-dimension", "3-in-3");
  await expect(page.locator("#board")).toBeHidden();
  await expect(page.locator(".space-draw > canvas")).toBeVisible(LAZY_VIEW);
  await drawn(page, 11);
  expect(three.length).toBeGreaterThan(0);

  // the values of the research record, as the API gives them
  const api = (await (await page.request.get(`/api/spaces/polyhedra/problems/${DEFAULT_PROBLEM.polyhedra}`)).json()) as SpaceProblemResponse;
  await expect(page.locator("#space-facts")).toContainText(`Certified value${api.certified!.display}`);
  await expect(page.locator("#space-score-label")).toHaveText("Container scale s");
  await expect(page.locator("#space-shown")).toHaveText("the research record");
  await expect(page.locator("#space-f-code")).toHaveValue("cubincub");
  await expect(page.locator("#space-f-code option")).toHaveCount(86);
  await expect(page.locator("#space-f-P option")).toHaveCount(99);

  // the drawing turns with the keyboard and the views
  const draw = page.locator(".space-draw");
  await expect(draw).toHaveAttribute("role", "application");
  const before = await page.locator(".space-draw canvas").screenshot();
  await draw.focus();
  await page.keyboard.press("Shift+ArrowRight");
  const after = await page.locator(".space-draw canvas").screenshot();
  expect(after.equals(before)).toBe(false);
  await page.getByRole("button", { name: "See-through" }).click();
  await expect(page.getByRole("button", { name: "See-through" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Solid" })).toHaveAttribute("aria-pressed", "false");

  // a lost WebGL context is waited out, and the drawing comes back with it
  await page.evaluate(() => {
    const c = document.querySelector(".space-draw canvas") as HTMLCanvasElement;
    const ext = (c.getContext("webgl2") as WebGL2RenderingContext).getExtension("WEBGL_lose_context")!;
    (window as unknown as { lose: WEBGL_lose_context }).lose = ext;
    ext.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => polypack.space!.renderer!.describe()))
    .toMatch(/graphics context away/);
  await page.evaluate(() => (window as unknown as { lose: WEBGL_lose_context }).lose.restoreContext());
  await expect.poll(() => page.evaluate(() => polypack.space!.renderer!.describe())).toMatch(/^11 cubes in a cube/);
  await expect.poll(() => page.evaluate(() => polypack.space!.renderer?.measureFrames?.(1) ?? null)).not.toBeNull();

  // the picker: another problem, then the largest P of the largest solid, served from its file on demand
  await page.selectOption("#space-f-code", "tidintid");
  await page.selectOption("#space-f-P", "100");
  await shown(page, "polyhedra/tidintid/100");
  await drawn(page, 100);
  await expect(page).toHaveURL(/#space=polyhedra\/tidintid\/100$/);
  // back to the Flat board: the 3D drawing gives back its WebGL context, and is made again on return
  await page.selectOption("#dimension-select", "2-in-2");
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator(".space-draw canvas")).toHaveCount(0);
  await page.selectOption("#dimension-select", "3-in-3");
  await shown(page, "polyhedra/tidintid/100");
  await drawn(page, 100);
});

test("a polyhedra round runs in the browser and returns a valid result, and pause and stop act at once at P = 100", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = "polyhedra/cubincub/5";
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  const status = await runFor(page, 17000);
  expect(status).toMatch(/^(Evaluation limit reached|Reached the lower bound)\./);
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.valid).toBe(true);
  const api = (await (await page.request.get(`/api/spaces/polyhedra/problems/${id}`)).json()) as SpaceProblemResponse;
  const v = validateSpaceSubmission("polyhedra", id, result.config, {
    bound: api.bound?.value ?? null,
    certified: api.certified?.score ?? null,
  });
  expect(v.valid, v.reasons.join("; ")).toBe(true);
  expect(v.score).toBe(result.score);
  // the record (2, five cubes) is not beaten, so nothing is offered
  await expect(page.locator("#space-submit")).toBeDisabled();
  await expect(page.locator("#space-submit-note")).toContainText("does not beat the problem's best");

  // 100 truncated icosidodecahedra: short rounds (a polish and jiggles); pause and stop end the worker at once
  const big = "polyhedra/tidintid/100";
  await page.goto("about:blank");
  await page.goto(`/#space=${big}`);
  await shown(page, big);
  await expect(page.locator("#space-solve-unit")).toContainText("rounds of 2,600");
  await page.selectOption("#space-solve-budget", "both");
  await page.locator("#space-solve-time").fill("120");
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-stop")).toBeEnabled();
  await page.waitForTimeout(1500);
  await page.click("#space-solve-pause");
  await expect(page.locator("#space-solve-pause")).toHaveText("Resume", { timeout: 1000 });
  await page.click("#space-solve-pause");
  await expect(page.locator("#space-solve-pause")).toHaveText("Pause", { timeout: 1000 });
  await page.waitForTimeout(1000);
  const t = Date.now();
  await page.click("#space-solve-stop");
  await expect(page.locator("#space-solve-run")).toBeEnabled({ timeout: 1000 });
  expect(Date.now() - t).toBeLessThan(1000);
  await expect(page.locator("#space-solve-status")).toContainText("Stopped.");
});

test("leaving 3D in 3D while a problem loads leaves the problem shown usable on return", async ({ page }) => {
  await page.goto("/#space=polyhedra/cubincub/11");
  await shown(page, "polyhedra/cubincub/11");
  // the next problem's answer is held until the board shows Flat
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/spaces/polyhedra/problems/polyhedra/cubincub/12", async (route) => {
    await held;
    await route.continue();
  });
  await page.selectOption("#space-f-P", "12");
  await expect(page.locator("#space-busy")).toBeVisible();
  await page.selectOption("#dimension-select", "2-in-2");
  await expect(page.locator("#board")).toBeVisible();
  const late = page.waitForResponse((r) => r.url().endsWith("/polyhedra/cubincub/12"));
  release();
  await late;
  // back: the problem shown before, with its own fields, nothing loading, and the panel usable
  await page.selectOption("#dimension-select", "3-in-3");
  await shown(page, "polyhedra/cubincub/11");
  await expect(page.locator("#space-busy")).toBeHidden();
  await expect(page.locator("#space-f-P")).toHaveValue("11");
  await expect(page.locator("#space-solve-run")).toBeEnabled();
  await expect(page).toHaveURL(/#space=polyhedra\/cubincub\/11$/);
  await drawn(page, 11);
});

/** Serves cubincub/11 with its research record 2% larger (the container grows, the cubes keep their places). */
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

test("a polyhedra result that beats the problem's best is submitted, and the answers are shown", async ({ page }) => {
  test.setTimeout(120_000);
  const id = "polyhedra/cubincub/11";
  await page.route(`**/api/spaces/polyhedra/problems/${id}`, weakenRecord);
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  const weak = Number(await page.locator("#space-score").textContent());

  const status = await runFor(page, 17000);
  expect(status).toContain(`beats the problem's best ${weak.toFixed(6)}. You can submit it.`);
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.score).toBeLessThan(weak * (1 - 1e-6));
  await expect(page.locator("#space-submit")).toBeEnabled();
  await page.fill("#name", "E2E board");

  // the real server does not keep it below the real record by less than the margin, and so does not check it
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/spaces/submit") && r.method() === "POST");
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/spaces/submit"));
  await page.click("#space-submit");
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({
    space: "polyhedra",
    id,
    name: "E2E board",
    method: "polyhedra soft-to-rigid search (board, from the research record)",
    seed: 1,
    software: "PolyPack board",
  });
  expect(body.config).toEqual(result.config);
  expect((await answered).status()).toBe(200);
  await expect(page.locator("#space-submit-result")).toContainText("✗ Not kept, and not checked: the score");
  await expect(page.locator("#space-submit-result")).toContainText("the research record by more than a relative 1e-6");

  // kept, as a server whose record it beats would answer
  await page.route("**/api/spaces/submit", (route) =>
    route.fulfill({
      status: 200,
      json: { valid: true, reasons: [], score: result.score, leader: true, best_score: result.score, id: 9, beats_certified: true },
    }),
  );
  if (!(await page.locator("#space-submit").isEnabled())) await runFor(page, 17000);
  await page.click("#space-submit");
  await expect(page.locator("#space-submit-result")).toContainText("✓ Kept. Server score");
  await expect(page.locator("#space-submit-result")).toContainText("It beats the research record.");
});

test("the dimensions page lists 3D in 3D with the polyhedra records and links them to the board", async ({ page }) => {
  await page.goto("/dimensions.html");
  const card = page.locator('#dimension-groups > section[data-dimension="3-in-3"] li[data-space="polyhedra"]');
  await expect(card.getByRole("heading", { name: "Polyhedra", exact: true })).toBeVisible();
  await expect(card).toContainText("8,514");
  await card.getByRole("link", { name: /^Records/ }).click();
  await expect(page.locator('#space-pick input[value="polyhedra"]')).toBeChecked();
  // the table starts at cubes in a cube, P = 2 to 100
  await expect(page.locator("#filter-code")).toHaveValue("cubincub");
  await expect(page.locator("#space-rows tr")).toHaveCount(99);
  const row = page.locator('#space-rows tr[data-id="polyhedra/cubincub/100"]');
  await expect(row.getByRole("link", { name: /^JSON/ })).toHaveAttribute(
    "href",
    "/api/spaces/polyhedra/problems/polyhedra/cubincub/100",
  );
  await row.getByRole("link", { name: /^Open on the board/ }).click();
  await shown(page, "polyhedra/cubincub/100");
  await drawn(page, 100);
});
