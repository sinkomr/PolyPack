import { type Page, expect, test } from "@playwright/test";
import { type SpaceProblemResponse, validateSpaceSubmission } from "@polypack/spaces";
import { DEFAULT_PROBLEM } from "../apps/web/src/space/model";
import { LAZY_VIEW, openProblem } from "./helpers";

// 3D in 3D > Balls on the board: unit balls in a ball or in one of 94 solids, and each of those solids in a ball.
// The space ships without research records, so every problem opens empty ("No record yet"), runs from a new arrangement, and its first valid
// entry is kept by the local server (playwright.config.ts).

declare const polypack: {
  space?: {
    lastResult: { config: unknown; score: number; valid: boolean; submittable: boolean } | null;
    renderer: { describe(): string; measureFrames?(n: number): number | null } | null;
  };
};

const EMPTY = "No record yet: run the optimizer or submit one.";

async function opened(page: Page, id: string): Promise<void> {
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`);
}

/** Waits until the drawing shows a packing of `pieces` (three.js loaded, the description written, a frame drawn). */
async function drawn(page: Page, pieces: number, what = "[a-z]+"): Promise<void> {
  await expect(page.locator(".space-draw")).toHaveAttribute(
    "aria-label",
    new RegExp(
      `^${pieces} ${what} in an? [\\w .]+? (of radius|of edge|scaled by) \\d+\\.\\d{6}, drawn in 3D\\. Drag it or use the arrow keys to turn it\\.$`,
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

/** The result of the last run passes the server's rule for a problem without a record (the strict check). */
async function resultValid(page: Page, id: string): Promise<{ config: unknown; score: number }> {
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.valid).toBe(true);
  const api = (await (await page.request.get(`/api/spaces/balls/problems/${id}`)).json()) as SpaceProblemResponse;
  const v = validateSpaceSubmission("balls", id, result.config, { bound: api.bound?.value ?? null, noRecord: true });
  expect(v.valid, v.reasons.join("; ")).toBe(true);
  expect(v.score).toBe(result.score);
  return result;
}

test("3D in 3D > Balls opens a problem without a record, runs from a new arrangement and draws the result", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openProblem(page, 4, 4, 5);
  await expect(page.locator('#family-select optgroup[label="3D in 3D"] option')).toHaveText([
    "3D in 3D: Polyhedra",
    "3D in 3D: Balls",
  ]);
  await page.selectOption("#family-select", "balls");
  await opened(page, DEFAULT_PROBLEM.balls);
  await expect(page).toHaveURL(/#space=balls\/ballinball\/13$/);
  await expect(page.locator("main")).toHaveAttribute("data-space", "balls");
  // no record yet: an empty drawing that says what to do, the values, and a run from a new arrangement
  await expect(page.locator("#space-empty")).toHaveText(EMPTY);
  await expect(page.locator("#space-status")).toHaveText(`${DEFAULT_PROBLEM.balls}: ${EMPTY}`);
  const facts = page.locator("#space-facts");
  await expect(facts).toContainText("Certified value—");
  await expect(facts).toContainText("Statusno record yet");
  await expect(facts).toContainText("Lower bound2.351335");
  await expect(facts).toContainText("Entriesopen");
  await expect(page.locator("#space-score-label")).toHaveText("Container radius s");
  await expect(page.locator("#space-solve-start")).toHaveValue("fresh");
  // 189 problems in 16 menu groups: balls in a ball or a Platonic solid first
  await expect(page.locator("#space-f-code option")).toHaveCount(189);
  await expect(page.locator("#space-f-code optgroup")).toHaveCount(16);
  await expect(page.locator("#space-f-code option").first()).toHaveText("Balls in a ball");
  await expect(page.locator('#space-f-code optgroup[label="Balls in a Catalan solid"] option')).toHaveCount(13);
  await expect(page.locator("#space-f-P option")).toHaveCount(99);

  const status = await runFor(page, 40000);
  expect(status).toMatch(/^Evaluation limit reached\./);
  expect(status).toContain("You can submit it.");
  await resultValid(page, DEFAULT_PROBLEM.balls);
  await expect(page.locator("#space-empty")).toBeHidden();
  await drawn(page, 13, "balls");
  // it turns with the keyboard, and the views switch
  const draw = page.locator(".space-draw");
  const before = await page.locator(".space-draw canvas").screenshot();
  await draw.focus();
  await page.keyboard.press("Shift+ArrowRight");
  expect((await page.locator(".space-draw canvas").screenshot()).equals(before)).toBe(false);
  await page.getByRole("button", { name: "See-through" }).click();
  await expect(page.getByRole("button", { name: "See-through" })).toHaveAttribute("aria-pressed", "true");

  // balls in a cube and a Platonic solid in a ball, each from a new arrangement
  await page.selectOption("#space-f-code", "ballincub");
  await page.selectOption("#space-f-P", "8");
  await opened(page, "balls/ballincub/8");
  await expect(page.locator("#space-score-label")).toHaveText("Cube edge s");
  await runFor(page, 20000);
  await resultValid(page, "balls/ballincub/8");
  await drawn(page, 8, "balls");
  await expect(draw).toHaveAttribute("aria-label", /^8 balls in a cube of edge/);
  await page.selectOption("#space-f-code", "dodinball");
  await page.selectOption("#space-f-P", "10");
  await opened(page, "balls/dodinball/10");
  await runFor(page, 15000);
  await resultValid(page, "balls/dodinball/10");
  await drawn(page, 10, "dodecahedra");

  // Flat again: the drawing is destroyed; back: made anew with the same packing
  await page.selectOption("#family-select", "polygon");
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator(".space-draw canvas")).toHaveCount(0);
  await page.selectOption("#family-select", "balls");
  await expect(page.locator("#family-select")).toHaveValue("balls");
  await opened(page, "balls/dodinball/10");
  await drawn(page, 10, "dodecahedra");
});

test("3D in 3D > Balls opens balls in a Catalan solid and a prism in a ball from the grouped menu, runs and draws them", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/#space=balls/ballinpkd/6");
  await opened(page, "balls/ballinpkd/6");
  await expect(page.locator("#space-f-code")).toHaveValue("ballinpkd");
  await expect(page.locator("#space-score-label")).toHaveText("Container scale s");
  await expect(page.locator("#space-empty")).toHaveText(EMPTY);
  await runFor(page, 12000);
  await resultValid(page, "balls/ballinpkd/6");
  await drawn(page, 6, "balls");
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /^6 balls in a pentakis dodecahedron scaled by \d+\.\d{6}, drawn in 3D\./);
  // a prism of height 1.5 in a ball, chosen in the menu
  await page.selectOption("#space-f-code", "pr3l15inball");
  await page.selectOption("#space-f-P", "4");
  await opened(page, "balls/pr3l15inball/4");
  await expect(page.locator("#space-score-label")).toHaveText("Container radius s");
  await runFor(page, 8000);
  await resultValid(page, "balls/pr3l15inball/4");
  await drawn(page, 4, "triangular prisms of height 1\\.5");
});

test("a balls run at P = 100 pauses and stops at once", async ({ page }) => {
  test.setTimeout(120_000);
  const id = "balls/icoinball/100";
  await page.goto(`/#space=${id}`);
  await opened(page, id);
  await expect(page.locator("#space-empty")).toHaveText(EMPTY);
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

test("the first balls entry of a problem is kept, and the board then starts from it", async ({ page }) => {
  test.setTimeout(120_000);
  // a problem no other test opens, so that its first entry stays this test's
  const id = "balls/icoinball/5";
  await page.goto(`/#space=${id}`);
  await opened(page, id);
  await runFor(page, 20000);
  const result = await resultValid(page, id);
  await expect(page.locator("#space-submit")).toBeEnabled();
  await page.fill("#name", "E2E board");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/spaces/submit") && r.method() === "POST");
  await page.click("#space-submit");
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({
    space: "balls",
    id,
    name: "E2E board",
    method: "balls penalty basin hopping (board, from a new arrangement)",
    seed: 1,
    software: "PolyPack board",
  });
  expect(body.config).toEqual(result.config);
  await expect(page.locator("#space-submit-result")).toContainText("✓ Kept. Server score");
  // the problem now has a site entry: shown, and the start of a run, while it still has no research record
  await page.goto("about:blank");
  await page.goto(`/#space=${id}`);
  await opened(page, id);
  await expect(page.locator("#space-shown")).toHaveText("the site's best entry, by E2E board");
  await expect(page.locator("#space-empty")).toBeHidden();
  await expect(page.locator("#space-facts")).toContainText("Statusno record yet");
  await expect(page.locator("#space-facts")).toContainText(`Site best${result.score.toFixed(6)}`);
  await drawn(page, 5, "icosahedra");
  await expect(page.locator("#space-solve-start")).toHaveValue("shown");
});

test("the dimensions page lists Balls under 3D in 3D, its problems without records, linked to the board", async ({
  page,
}) => {
  await page.goto("/dimensions.html");
  const card = page.locator('#dimension-groups > section[data-dimension="3-in-3"] li[data-space="balls"]');
  await expect(card.getByRole("heading", { name: "Balls", exact: true })).toBeVisible();
  await expect(card).toContainText("18,711, none with a record yet");
  // its problems are a domain: the records table lists none, and says where to work on them
  await card.getByRole("link", { name: /^Records/ }).click();
  await expect(page.locator('#space-pick input[value="balls"]')).toBeChecked();
  await expect(page.locator("#space-note")).toHaveText(
    "No records yet. All 18,711 problems of this kind are open: choose one on the board, or let the volunteer client search them.",
  );
  await page.goto("/dimensions.html");
  await page
    .locator('#dimension-groups > section[data-dimension="3-in-3"] li[data-space="balls"]')
    .getByRole("link", { name: /^Board/ })
    .click();
  await opened(page, DEFAULT_PROBLEM.balls);
  await expect(page.locator("#space-empty")).toHaveText(EMPTY);
  // any problem of the domain opens from its address
  await page.goto("about:blank");
  await page.goto("/#space=balls/octinball/77");
  await opened(page, "balls/octinball/77");
  await expect(page.locator("#space-f-P")).toHaveValue("77");
});
