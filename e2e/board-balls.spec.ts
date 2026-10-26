import { type Page, type Route, expect, test } from "@playwright/test";
import { type SpaceProblemResponse, validateSpaceSubmission } from "@polypack/spaces";
import { DEFAULT_PROBLEM } from "../apps/web/src/space/model";
import { LAZY_VIEW, openProblem } from "./helpers";

// 3D in 3D > Balls on the board: unit balls in a ball or a cube, Platonic solids in a ball, drawn with three.js,
// searched in a Web Worker, submitted to the local server (playwright.config.ts) or to a mocked one.

declare const polypack: {
  space?: {
    lastResult: { config: unknown; score: number; valid: boolean; submittable: boolean } | null;
    renderer: { describe(): string; measureFrames?(n: number): number | null } | null;
  };
};

async function shown(page: Page, id: string): Promise<void> {
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`);
  await expect(page.locator("#space-score")).not.toHaveText("—");
}

/** Waits until the drawing has drawn the packing (three.js loaded, the description written, a frame drawn). */
async function drawn(page: Page, pieces: number): Promise<void> {
  await expect(page.locator(".space-draw")).toHaveAttribute(
    "aria-label",
    new RegExp(
      `^${pieces} [a-z]+ in a (ball of radius|cube of edge) \\d+\\.\\d{6}, drawn in 3D\\. Drag it or use the arrow keys to turn it\\.$`,
    ),
    LAZY_VIEW,
  );
  await expect.poll(() => page.evaluate(() => polypack.space!.renderer?.measureFrames?.(1) ?? null)).not.toBeNull();
}

async function runFor(page: Page, evals: number, seed = 1): Promise<string> {
  await page.selectOption("#space-solve-budget", "evals");
  await page.fill("#space-solve-evals", String(evals));
  await page.fill("#space-solve-seed", String(seed));
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-stop")).toBeDisabled({ timeout: 90_000 });
  await expect(page.locator("#space-solve-run")).toBeEnabled();
  return (await page.locator("#space-solve-status").textContent()) ?? "";
}

test("3D in 3D > Balls opens a problem, draws it, picks others and gives back its drawing on leaving", async ({ page }) => {
  await openProblem(page, 4, 4, 5);
  await page.selectOption("#dimension-select", "3-in-3");
  await expect(page.locator("#kind-select option")).toHaveText(["Polyhedra", "Balls"]);
  await page.selectOption("#kind-select", "balls");
  await shown(page, DEFAULT_PROBLEM.balls);
  await expect(page).toHaveURL(/#space=balls\/ballinball\/13$/);
  await expect(page.locator("main")).toHaveAttribute("data-dimension", "3-in-3");
  await expect(page.locator("main")).toHaveAttribute("data-space", "balls");
  await expect(page.locator(".space-draw > canvas")).toBeVisible(LAZY_VIEW);
  await drawn(page, 13);
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /^13 balls in a ball of radius 3\.0000/);

  const api = (await (await page.request.get(`/api/spaces/balls/problems/${DEFAULT_PROBLEM.balls}`)).json()) as SpaceProblemResponse;
  await expect(page.locator("#space-facts")).toContainText(`Certified value${api.certified!.display}`);
  await expect(page.locator("#space-score-label")).toHaveText("Container radius s");
  await expect(page.locator("#space-f-code option")).toHaveText([
    "Balls in a ball",
    "Balls in a cube",
    "Tetrahedra in a ball",
    "Cubes in a ball",
    "Octahedra in a ball",
    "Dodecahedra in a ball",
    "Icosahedra in a ball",
  ]);
  await expect(page.locator("#space-f-P option")).toHaveCount(99);

  // it turns with the keyboard, and the views switch
  const draw = page.locator(".space-draw");
  await expect(draw).toHaveAttribute("role", "application");
  const before = await page.locator(".space-draw canvas").screenshot();
  await draw.focus();
  await page.keyboard.press("Shift+ArrowRight");
  expect((await page.locator(".space-draw canvas").screenshot()).equals(before)).toBe(false);
  await page.getByRole("button", { name: "See-through" }).click();
  await expect(page.getByRole("button", { name: "See-through" })).toHaveAttribute("aria-pressed", "true");

  // balls in a cube, then a Platonic solid in a ball
  await page.selectOption("#space-f-code", "ballincub");
  await page.selectOption("#space-f-P", "27");
  await shown(page, "balls/ballincub/27");
  await drawn(page, 27);
  await expect(page.locator("#space-score-label")).toHaveText("Cube edge s");
  await page.selectOption("#space-f-code", "dodinball");
  await page.selectOption("#space-f-P", "100");
  await shown(page, "balls/dodinball/100");
  await drawn(page, 100);
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /^100 dodecahedra in a ball of radius/);

  // Flat again: the drawing is destroyed; back: made anew with the same packing
  await page.selectOption("#dimension-select", "2-in-2");
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator(".space-draw canvas")).toHaveCount(0);
  await page.selectOption("#dimension-select", "3-in-3");
  await expect(page.locator("#kind-select")).toHaveValue("balls");
  await shown(page, "balls/dodinball/100");
  await drawn(page, 100);
});

test("a balls round runs in the browser with a valid result, and pause and stop act at once at P = 100", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = "balls/ballinball/13";
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  const status = await runFor(page, 40000);
  expect(status).toMatch(/^(Evaluation limit reached|Reached the lower bound)\./);
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.valid).toBe(true);
  const api = (await (await page.request.get(`/api/spaces/balls/problems/${id}`)).json()) as SpaceProblemResponse;
  const v = validateSpaceSubmission("balls", id, result.config, {
    bound: api.bound?.value ?? null,
    certified: api.certified?.score ?? null,
  });
  expect(v.valid, v.reasons.join("; ")).toBe(true);
  expect(v.score).toBe(result.score);

  const big = "balls/icoinball/100";
  await page.goto("about:blank");
  await page.goto(`/#space=${big}`);
  await shown(page, big);
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

/** Serves the problem with its research record 2% larger (the container grows, the pieces keep their places). */
async function weakenRecord(route: Route): Promise<void> {
  let r: Awaited<ReturnType<Route["fetch"]>>;
  let body: SpaceProblemResponse;
  try {
    r = await route.fetch();
    body = (await r.json()) as SpaceProblemResponse;
  } catch {
    return;
  }
  const config = body.certified_config as { s: number; pieces: unknown[] };
  const s = config.s * 1.02;
  await route.fulfill({
    response: r,
    json: { ...body, certified: { ...body.certified!, score: s, display: s.toFixed(6) }, best_score: s, certified_config: { ...config, s } },
  });
}

test("a balls result that beats the problem's best is submitted, and the answers are shown", async ({ page }) => {
  test.setTimeout(120_000);
  const id = "balls/octinball/6";
  await page.route(`**/api/spaces/balls/problems/${id}`, weakenRecord);
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  const weak = Number(await page.locator("#space-score").textContent());
  const status = await runFor(page, 30000);
  expect(status).toContain(`beats the problem's best ${weak.toFixed(6)}. You can submit it.`);
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.score).toBeLessThan(weak * (1 - 1e-9));
  await page.fill("#name", "E2E board");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/spaces/submit") && r.method() === "POST");
  await page.route("**/api/spaces/submit", (route) =>
    route.fulfill({
      status: 200,
      json: { valid: true, reasons: [], score: result.score, leader: true, best_score: result.score, id: 9, beats_certified: true },
    }),
  );
  await page.click("#space-submit");
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({
    space: "balls",
    id,
    name: "E2E board",
    method: "balls penalty basin hopping (board, from the research record)",
    seed: 1,
    software: "PolyPack board",
  });
  expect(body.config).toEqual(result.config);
  await expect(page.locator("#space-submit-result")).toContainText("✓ Kept. Server score");
  await expect(page.locator("#space-submit-result")).toContainText("It beats the research record.");
});

test("the dimensions page lists Balls under 3D in 3D with its records, linked to the board", async ({ page }) => {
  await page.goto("/dimensions.html");
  const card = page.locator('#dimension-groups > section[data-dimension="3-in-3"] li[data-space="balls"]');
  await expect(card.getByRole("heading", { name: "Balls", exact: true })).toBeVisible();
  await expect(card).toContainText("693");
  await card.getByRole("link", { name: /^Records/ }).click();
  await expect(page.locator('#space-pick input[value="balls"]')).toBeChecked();
  await expect(page.locator("#filter-code")).toHaveValue("ballinball");
  await expect(page.locator("#space-rows tr")).toHaveCount(99);
  const row = page.locator('#space-rows tr[data-id="balls/ballinball/50"]');
  await row.getByRole("link", { name: /^Open on the board/ }).click();
  await shown(page, "balls/ballinball/50");
  await drawn(page, 50);
});
