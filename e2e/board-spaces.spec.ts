import AxeBuilder from "@axe-core/playwright";
import { type Page, type Route, expect, test } from "@playwright/test";
import { type SpaceName, type SpaceProblemResponse, validateSpaceSubmission } from "@polypack/spaces";
import { DEFAULT_PROBLEM } from "../apps/web/src/space/model";
import { openProblem } from "./helpers";

// The board's space mode against the local stack (playwright.config.ts): the server lists the
// research records of data/<space>/records.json and checks submissions; the board draws a
// problem, runs the space's search in a Web Worker and submits a better packing.

const SPACES: SpaceName[] = ["surface", "curved", "sphere", "torus"];

declare const polypack: {
  board: { toConfig(): unknown };
  space?: { lastResult: { config: unknown; score: number; valid: boolean; submittable: boolean } | null };
};

/** Waits until the space mode shows a problem's packing. */
async function shown(page: Page, id: string): Promise<void> {
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`);
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

test("the Space menu switches the board to each space and back to the polygon board as it was", async ({ page }) => {
  await openProblem(page, 4, 4, 5);
  await page.click("#add-all");
  await expect(page.locator("#count")).toContainText("5 / 5");
  const board = await page.evaluate(() => polypack.board.toConfig());

  for (const space of SPACES) {
    await page.selectOption("#space-select", space);
    const id = DEFAULT_PROBLEM[space];
    await shown(page, id);
    await expect(page).toHaveURL(new RegExp(`#space=${id.replace(/[/-]/g, "\\$&")}$`));
    // the polygon board is hidden, the space's drawing and values are shown
    await expect(page.locator("#board")).toBeHidden();
    await expect(page.locator("#solve-panel")).toBeHidden();
    await expect(page.locator(".space-draw > canvas, .space-draw > svg")).toBeVisible();
    const api = (await (await page.request.get(`/api/spaces/${space}/problems/${id}`)).json()) as SpaceProblemResponse;
    const facts = page.locator("#space-facts");
    await expect(facts).toContainText(`Certified value${api.certified!.display}`);
    await expect(facts).toContainText("Entriesopen");
    await expect(page.locator("#space-shown")).toHaveText("the research record");
  }

  await page.selectOption("#space-select", "");
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator(".space-stage")).toBeHidden();
  await expect(page).toHaveURL(/#p=4,4,5$/);
  await expect(page.locator("#count")).toContainText("5 / 5");
  expect(await page.evaluate(() => polypack.board.toConfig())).toEqual(board);

  // a space address opens the space; a polygon link returns to the polygon board
  await page.evaluate(() => (location.hash = "#space=torus/hex/5/8"));
  await shown(page, "torus/hex/5/8");
  await expect(page.locator("#space-select")).toHaveValue("torus");
  await page.evaluate(() => (location.hash = "#p=4,4,5"));
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#space-select")).toHaveValue("");
});

test("each space loads a problem from its address, optimises it in the browser and offers only a valid result", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const cases: [string, number][] = [
    ["sphere/4/10", 4000],
    ["torus/sq/5/7", 2000],
    ["curved/-1/3/4/5", 9],
    ["surface/cube/fold/0/10", 4],
    ["surface/cube/nofold/4/13", 3000],
  ];
  for (const [id, evals] of cases) {
    const space = id.split("/")[0] as SpaceName;
    await page.goto("about:blank");
    await page.goto(`/#space=${id}`);
    await shown(page, id);
    await expect(page.locator("#space-select")).toHaveValue(space);
    const status = await runFor(page, evals);
    expect(status, id).toMatch(/^(Evaluation limit reached|Reached the lower bound)\./);
    await expect(page.locator("#space-solve-score")).toHaveText(/^\d+\.\d{6}$/);
    await expect(page.locator("#space-solve-progress")).toContainText("evaluations");
    const result = await page.evaluate(() => polypack.space!.lastResult);
    expect(result, id).not.toBeNull();
    expect(result!.valid).toBe(true);
    // the server's own check accepts it at its stated size
    const api = (await (await page.request.get(`/api/spaces/${space}/problems/${id}`)).json()) as SpaceProblemResponse;
    const v = validateSpaceSubmission(space, id, result!.config, {
      bound: api.bound?.value ?? null,
      certified: api.certified?.score ?? null,
    });
    expect(v.valid, `${id}: ${v.reasons.join("; ")}`).toBe(true);
    expect(v.score).toBe(result!.score);
    // a research record is not beaten in a few seconds, so nothing is offered
    await expect(page.locator("#space-submit")).toBeDisabled();
    await expect(page.locator("#space-submit-note")).toContainText("does not beat the problem's best");
    await expect(page.locator("#space-shown")).toHaveText("the optimizer's result");
  }
});

/** Serves a problem whose research record is 2% worse than it is (the sphere grows, its pieces keep their places). */
async function weakenRecord(route: Route): Promise<void> {
  const r = await route.fetch();
  const body = (await r.json()) as SpaceProblemResponse;
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

test("a result that beats the problem's best is submitted, and the server's answers are shown", async ({ page }) => {
  test.setTimeout(120_000);
  const id = "sphere/4/10";
  await page.route(`**/api/spaces/sphere/problems/${id}`, weakenRecord);
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  const weak = Number(await page.locator("#space-score").textContent());

  const status = await runFor(page, 4000);
  expect(status).toContain(`beats the problem's best ${weak.toFixed(6)}. You can submit it.`);
  const result = (await page.evaluate(() => polypack.space!.lastResult))!;
  expect(result.score).toBeLessThan(weak * (1 - 1e-9));
  await expect(page.locator("#space-submit")).toBeEnabled();
  await expect(page.locator("#space-submit-note")).toContainText("Sends the optimizer's result");

  // the board's own Name field
  await page.click("#space-submit");
  await expect(page.locator("#space-submit-result")).toHaveText("✗ Enter a display name.");
  await expect(page.locator("#name")).toBeFocused();
  await page.fill("#name", "E2E board");
  await page.fill("#agent-note", "a space test");

  // the real server checks it against the real record: valid, not kept
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/spaces/submit") && r.method() === "POST");
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/spaces/submit"));
  await page.click("#space-submit");
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({
    space: "sphere",
    id,
    name: "E2E board",
    agent_note: "a space test",
    method: "sphere basin hopping",
    seed: 1,
    software: "PolyPack board",
  });
  expect(body.config).toEqual(result.config);
  expect((await answered).status()).toBe(200);
  await expect(page.locator("#space-submit-result")).toContainText("✓ Valid, score");
  await expect(page.locator("#space-submit-result")).toContainText("but not kept");

  // the other answers, as the server would give them
  const answers: [number, object, string][] = [
    [
      200,
      {
        valid: true,
        reasons: [],
        score: result.score,
        leader: true,
        best_score: result.score,
        id: 9,
        beats_certified: true,
      },
      "✓ Kept. Server score",
    ],
    [
      409,
      {
        valid: false,
        reasons: ["this problem is closed: its optimum is proven"],
        score: null,
        leader: false,
        best_score: null,
        id: null,
        beats_certified: false,
      },
      "✗ This problem takes no entries: this problem is closed",
    ],
    [
      422,
      {
        valid: false,
        reasons: ["pieces 1 and 2 overlap by 0.001"],
        score: null,
        leader: false,
        best_score: null,
        id: null,
        beats_certified: false,
      },
      "✗ Not accepted: pieces 1 and 2 overlap by 0.001.",
    ],
    [
      429,
      {
        valid: false,
        reasons: ["too many submissions from this address; wait a minute"],
        score: null,
        leader: false,
        best_score: null,
        id: null,
        beats_certified: false,
      },
      "✗ Too many submissions from this address; wait a minute.",
    ],
  ];
  for (const [status, json, text] of answers) {
    await page.route("**/api/spaces/submit", (route) => route.fulfill({ status, json }));
    // a reload after an answer shows the problem's best again; run once more to have a result to send
    if (!(await page.locator("#space-submit").isEnabled())) await runFor(page, 2000);
    await page.click("#space-submit");
    await expect(page.locator("#space-submit-result"), String(status)).toContainText(text);
    await page.unroute("**/api/spaces/submit");
  }
});

test("a closed problem can be viewed but not submitted, and an impossible one has nothing to run", async ({
  page,
  request,
}) => {
  await page.goto("/#space=sphere/0/12");
  await shown(page, "sphere/0/12");
  await expect(page.locator("#space-facts")).toContainText("Statusproven optimal");
  await expect(page.locator("#space-facts")).toContainText("Entriesclosed");
  await page.locator("#space-facts summary", { hasText: "Why" }).click();
  await expect(page.locator("#space-facts")).toContainText("is proven");
  await expect(page.locator("#space-submit")).toBeDisabled();
  await expect(page.locator("#space-submit-note")).toContainText(
    "This problem takes no entries: its optimum 1.806442 is proven",
  );

  const curved = (await (await request.get("/api/spaces/curved/records")).json()) as {
    problems: { id: string; status?: string }[];
  };
  const impossible = curved.problems.find((p) => p.status === "infeasible")!;
  await page.goto("about:blank");
  await page.goto(`/#space=${impossible.id}`);
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${impossible.id}`);
  await expect(page.locator("#space-shown")).toHaveText("no packing exists");
  await expect(page.locator("#space-solve-run")).toBeDisabled();
  await expect(page.locator("#space-submit")).toBeDisabled();
});

test("pause holds a run at once, resume goes on, stop ends it at once", async ({ page }) => {
  await page.goto("/#space=torus/sq/5/7");
  await shown(page, "torus/sq/5/7");
  await page.selectOption("#space-solve-budget", "both");
  await page.locator("#space-solve-time").fill("60");
  await page.fill("#space-solve-evals", "1000000");
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-progress")).toContainText(/\d+ rounds? · /, { timeout: 10_000 });
  await page.click("#space-solve-pause");
  await expect(page.locator("#space-solve-pause")).toHaveText("Resume", { timeout: 1000 });
  await expect(page.locator("#space-solve-status")).toHaveText("Paused. Resume, or stop to keep the best result.");
  const held = await page.locator("#space-solve-progress").textContent();
  await page.waitForTimeout(1200);
  await expect(page.locator("#space-solve-progress")).toHaveText(held!);
  await page.click("#space-solve-pause");
  await expect(page.locator("#space-solve-progress")).not.toHaveText(held!, { timeout: 10_000 });
  await page.click("#space-solve-stop");
  await expect(page.locator("#space-solve-run")).toBeEnabled({ timeout: 1000 });
  await expect(page.locator("#space-solve-status")).toContainText("Stopped.");
  await expect(page.locator("#space-solve-download")).toBeEnabled();
});

test("the spaces page links each problem to the board", async ({ page }) => {
  await page.goto("/spaces.html#space=torus&family=hex&N=5");
  const row = page.locator("#space-rows tr").first();
  const id = (await row.getAttribute("data-id"))!;
  const link = row.getByRole("link", { name: /^Open on the board/ });
  await expect(link).toHaveAttribute("href", `/#space=${id}`);
  await link.click();
  await shown(page, id);
  await expect(page.locator("#space-select")).toHaveValue("torus");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the space mode has no automatic accessibility violations (${scheme})`, async ({ browser }) => {
    const page = await (await browser.newContext({ colorScheme: scheme })).newPage();
    for (const id of ["sphere/4/12", "surface/cube/fold/0/10", "curved/-1/3/4/5", "torus/sq/5/7", "sphere/0/12"]) {
      await page.goto("about:blank");
      await page.goto(`/#space=${id}`);
      await shown(page, id);
      if (id === "torus/sq/5/7") await runFor(page, 2000);
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(
        results.violations.map((v) => `${id}: ${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`),
      ).toEqual([]);
    }
  });
}

test("the drawing turns with the keyboard", async ({ page }) => {
  await page.goto("/#space=sphere/4/12");
  await shown(page, "sphere/4/12");
  const draw = page.locator(".space-draw");
  await expect(draw).toHaveAttribute("role", "application");
  await expect(draw).toHaveAttribute(
    "aria-label",
    /12 squares on a sphere of radius .* Drag it or use the arrow keys to turn it\./,
  );
  const before = await page.locator(".space-draw canvas").screenshot();
  await draw.focus();
  await page.keyboard.press("Shift+ArrowRight");
  const after = await page.locator(".space-draw canvas").screenshot();
  expect(after.equals(before)).toBe(false);
  // a torus does not turn, so its drawing is a picture that takes no focus
  await page.selectOption("#space-select", "torus");
  await shown(page, DEFAULT_PROBLEM.torus);
  await expect(draw).toHaveAttribute("role", "img");
  await expect(draw).not.toHaveAttribute("tabindex", /.*/);
});
