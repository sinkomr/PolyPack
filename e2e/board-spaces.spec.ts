import AxeBuilder from "@axe-core/playwright";
import { type Page, type Route, expect, test } from "@playwright/test";
import { type SpaceName, type SpaceProblemResponse, validateSpaceSubmission } from "@polypack/spaces";
import { DIMENSIONS, whereIs } from "../apps/web/src/dimension-table";
import { DEFAULT_PROBLEM } from "../apps/web/src/space/model";
import { nofoldFaceProblem, nofoldNote } from "../apps/web/src/spaces-model";
import { LAZY_VIEW, openProblem } from "./helpers";

// The board's space mode against the local stack (playwright.config.ts): the server lists the
// research records of data/<space>/records.json and checks submissions; the board draws a
// problem, runs the space's search in a Web Worker and submits a better packing.

const SPACES: SpaceName[] = ["surface", "curved", "sphere", "torus", "boundary", "polyhedra", "balls"];

declare const polypack: {
  board: { toConfig(): unknown };
  space?: { lastResult: { config: unknown; score: number; valid: boolean; submittable: boolean } | null };
};

/** Waits until the space mode shows a problem's packing; `wait` for the first one, while the mode's code loads. */
async function shown(page: Page, id: string, wait: { timeout?: number } = {}): Promise<void> {
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`, wait);
  // the balls space ships without records: its problems show none until an entry is kept
  if (id.startsWith("balls/")) await expect(page.locator("#space-empty")).toBeVisible();
  else await expect(page.locator("#space-score")).not.toHaveText("—");
}

/** Chooses a family in the Problem set menu, as a user would, when it is not the one shown. */
async function choose(page: Page, kind: SpaceName | "polygon"): Promise<void> {
  if ((await page.locator("#family-select").inputValue()) !== kind) await page.selectOption("#family-select", kind);
}

/** The menu names the family shown, and <main> its dimension. */
async function menusShow(page: Page, kind: SpaceName | "polygon"): Promise<void> {
  await expect(page.locator("#family-select")).toHaveValue(kind);
  await expect(page.locator("main")).toHaveAttribute("data-dimension", whereIs(kind)!.dimension.id);
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

test("the Problem set menu switches the board to each family and back to the Flat board as it was", async ({
  page,
}) => {
  await openProblem(page, 4, 4, 5);
  await page.click("#add-all");
  await expect(page.locator("#count")).toContainText("5 / 5");
  const board = await page.evaluate(() => polypack.board.toConfig());

  for (const space of SPACES) {
    await choose(page, space);
    await menusShow(page, space);
    const id = DEFAULT_PROBLEM[space];
    await shown(page, id);
    await expect(page).toHaveURL(new RegExp(`#space=${id.replace(/[/-]/g, "\\$&")}$`));
    // the polygon board is hidden, the space's drawing and values are shown
    await expect(page.locator("#board")).toBeHidden();
    await expect(page.locator("#solve-panel")).toBeHidden();
    const facts = page.locator("#space-facts");
    await expect(facts).toContainText("Entriesopen");
    if (space === "balls") {
      // no record yet: nothing to draw, and the board says what to do
      await expect(page.locator("#space-empty")).toHaveText("No record yet: run the optimizer or submit one.");
      await expect(facts).toContainText("Certified value—");
      await expect(facts).toContainText("Statusno record yet");
      await expect(page.locator("#space-shown")).toHaveText("no record yet");
      await expect(page.locator("#space-solve-start")).toHaveValue("fresh");
      continue;
    }
    // the 2D kinds draw on a canvas or in an svg; 3D on 4D in the three.js view (e2e/board-boundary.spec.ts)
    await expect(page.locator(".space-draw > canvas, .space-draw > svg, .pp3 canvas")).toBeVisible(LAZY_VIEW);
    const api = (await (await page.request.get(`/api/spaces/${space}/problems/${id}`)).json()) as SpaceProblemResponse;
    await expect(facts).toContainText(`Certified value${api.certified!.display}`);
    await expect(page.locator("#space-shown")).toHaveText("the research record");
  }

  await choose(page, "polygon");
  await menusShow(page, "polygon");
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator(".space-stage")).toBeHidden();
  await expect(page).toHaveURL(/#p=4,4,5$/);
  await expect(page.locator("#count")).toContainText("5 / 5");
  expect(await page.evaluate(() => polypack.board.toConfig())).toEqual(board);

  // a space address opens the space; a polygon link returns to the polygon board
  await page.evaluate(() => (location.hash = "#space=torus/hex/5/8"));
  await shown(page, "torus/hex/5/8");
  await menusShow(page, "torus");
  await page.evaluate(() => (location.hash = "#p=4,4,5"));
  await expect(page.locator("#board")).toBeVisible();
  await menusShow(page, "polygon");
});

test("the Problem set menu is one labelled menu, and a family chosen again returns to the problem last shown in it", async ({ page }) => {
  await openProblem(page, 4, 4, 5);
  const menu = page.locator("#family-select");
  // one menu, named by its label
  await expect(page.getByLabel("Problem set")).toHaveAttribute("id", "family-select");
  await expect(page.locator("#dimension-select, #kind-select")).toHaveCount(0);
  // the groups and their options, in order, are pinned by apps/web/test/dimension-table.test.ts
  await expect(menu.locator("optgroup")).toHaveCount(DIMENSIONS.length);
  await expect(menu.locator("option[disabled]")).toHaveCount(0);
  await menusShow(page, "polygon");

  // a family chosen again returns to the problem last shown in it
  await page.evaluate(() => (location.hash = "#space=torus/hex/5/8"));
  await shown(page, "torus/hex/5/8");
  await choose(page, "sphere");
  await shown(page, DEFAULT_PROBLEM.sphere);
  await choose(page, "torus");
  await shown(page, "torus/hex/5/8");
  await menusShow(page, "torus");
  await choose(page, "curved");
  await shown(page, DEFAULT_PROBLEM.curved);
});

test("the Problem set menu works with the keyboard", async ({ page }) => {
  await openProblem(page, 4, 4, 5);
  const menu = page.locator("#family-select");
  await menu.focus();
  await expect(menu).toBeFocused();
  // typing a name picks its family, as in any select; the board follows
  await page.keyboard.type("Sphere");
  await menusShow(page, "sphere");
  await shown(page, DEFAULT_PROBLEM.sphere, LAZY_VIEW);
  await expect(menu).toBeFocused();
  // a select's type-ahead forgets the letters typed after a second
  await page.waitForTimeout(1100);
  await page.keyboard.type("Flat");
  await menusShow(page, "polygon");
  await expect(page.locator("#board")).toBeVisible();
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
    await menusShow(page, space);
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
  let r: Awaited<ReturnType<Route["fetch"]>>;
  let body: SpaceProblemResponse;
  try {
    r = await route.fetch();
    body = (await r.json()) as SpaceProblemResponse;
  } catch {
    // the page went away (the test ended) while the problem was read again
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
    method: "sphere basin hopping (board, from the research record)",
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
  await expect(page.locator("#space-solve-progress")).toContainText(/\d+ rounds? · /, { timeout: 30_000 });
  await page.click("#space-solve-pause");
  await expect(page.locator("#space-solve-pause")).toHaveText("Resume", { timeout: 1000 });
  await expect(page.locator("#space-solve-status")).toHaveText("Paused. Resume, or stop to keep the best result.");
  const held = await page.locator("#space-solve-progress").textContent();
  await page.waitForTimeout(1200);
  await expect(page.locator("#space-solve-progress")).toHaveText(held!);
  await page.click("#space-solve-pause");
  await expect(page.locator("#space-solve-progress")).not.toHaveText(held!, { timeout: 30_000 });
  await page.click("#space-solve-stop");
  await expect(page.locator("#space-solve-run")).toBeEnabled({ timeout: 1000 });
  await expect(page.locator("#space-solve-status")).toContainText("Stopped.");
  await expect(page.locator("#space-solve-download")).toBeEnabled();
});

test("a nofold surface problem says it is a 2D in 2D problem and links to it on the polygon board", async ({
  page,
}) => {
  const note = page.locator("#space-same-as");
  // a fold problem has no such note
  await page.goto("/#space=surface/cube/fold/4/12");
  await shown(page, "surface/cube/fold/4/12", LAZY_VIEW);
  await expect(note).toBeHidden();

  for (const [id, href, N, M, P] of [
    ["surface/cube/nofold/4/13", "/#p=4,4,3", "4", "4", "3"],
    // disks are N = 0 on the polygon board too
    ["surface/tetrahedron/nofold/0/5", "/#p=0,3,2", "0", "3", "2"],
  ]) {
    await page.goto("about:blank");
    await page.goto(`/#space=${id}`);
    await shown(page, id, LAZY_VIEW);
    await expect(note).toBeVisible();
    await expect(note).toHaveText(nofoldNote(nofoldFaceProblem(id)!).join(""));
    const link = note.getByRole("link", { name: `the 2D in 2D problem N = ${N}, M = ${M}, P = ${P}` });
    await expect(link).toHaveAttribute("href", href);
    // the link opens that problem on the polygon board, and the menu says Flat
    await link.click();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#p=${N},${M},${P}$`));
    await expect(page.locator("#n-select")).toHaveValue(N);
    await expect(page.locator("#m-select")).toHaveValue(M);
    await expect(page.locator("#p-input")).toHaveValue(P);
    await menusShow(page, "polygon");
  }
});

test("the dimensions page links each problem to the board", async ({ page }) => {
  await page.goto("/dimensions.html#space=torus&family=hex&N=5");
  const row = page.locator("#space-rows tr").first();
  const id = (await row.getAttribute("data-id"))!;
  const link = row.getByRole("link", { name: /^Open on the board/ });
  await expect(link).toHaveAttribute("href", `/#space=${id}`);
  await link.click();
  await shown(page, id);
  await menusShow(page, "torus");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the space mode has no automatic accessibility violations (${scheme})`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme });
    // The torus problem shows an optimizer result without a search: the search thread answers with
    // the problem's own record, as a round that ended on its evaluation limit.
    await context.addInitScript(() => {
      const Real = window.Worker;
      window.Worker = class extends Real {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (!String(url).includes("/space/worker")) return;
          this.postMessage = ((message: { id: number; job: { space: string; id: string } }) => {
            const { id, job } = message;
            void fetch(`/api/spaces/${job.space}/problems/${job.id}`)
              .then((r) => r.json())
              .then((p: { certified_config: unknown; certified: { score: number } }) =>
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data: {
                      id,
                      result: {
                        job,
                        score: p.certified.score,
                        valid: true,
                        config: p.certified_config,
                        evaluations: 2000,
                        wallTime: 0.1,
                        termination: "evals",
                        reasons: [],
                      },
                    },
                  }),
                ),
              );
          }) as typeof this.postMessage;
        }
      };
    });
    const page = await context.newPage();
    for (const id of [
      "sphere/4/12",
      "surface/cube/nofold/4/13",
      "torus/sq/5/7",
      "polyhedra/cubincub/11",
      "balls/ballinball/13",
    ]) {
      await page.goto("about:blank");
      await page.goto(`/#space=${id}`);
      await shown(page, id);
      if (id === "torus/sq/5/7") {
        await page.click("#space-solve-run");
        await expect(page.locator("#space-solve-stop")).toBeDisabled();
        await expect(page.locator("#space-shown")).toHaveText("the optimizer's result");
      }
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
  await choose(page, "torus");
  await shown(page, DEFAULT_PROBLEM.torus);
  await expect(draw).toHaveAttribute("role", "img");
  await expect(draw).not.toHaveAttribute("tabindex", /.*/);
});

test("a torus entry in a skewed basis draws at once, and a degenerate lattice is not drawn", async ({ page }) => {
  const id = "torus/free/6/30";
  await page.route(`**/api/spaces/torus/problems/${id}`, async (route) => {
    const r = await route.fetch();
    const body = (await r.json()) as SpaceProblemResponse;
    const c = body.certified_config as { lattice: { b1: number[]; b2: number[] }; poses: unknown[] };
    const { b1, b2 } = c.lattice;
    // the same lattice, written as b2 + 320 b1 (the server accepts such a basis)
    const skewed = { ...c, lattice: { b1, b2: [b2[0] + 320 * b1[0], b2[1] + 320 * b1[1]] } };
    await route.fulfill({ response: r, json: { ...body, certified_config: skewed } });
  });
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  await expect(page.locator(".space-draw svg polygon").first()).toBeAttached();
  // a redraw, timed in the page: well under half a second
  for (const view of ["cell", "tile"]) {
    const ms = await page.evaluate((v) => {
      const t0 = performance.now();
      (document.querySelector(`.space-tools [data-view="${v}"]`) as HTMLButtonElement).click();
      return performance.now() - t0;
    }, view);
    expect(ms, view).toBeLessThan(500);
  }
  await page.unroute(`**/api/spaces/torus/problems/${id}`);

  // a degenerate lattice is not read: the board shows nothing and offers nothing to run from
  await page.route(`**/api/spaces/torus/problems/${id}`, async (route) => {
    const r = await route.fetch();
    const body = (await r.json()) as SpaceProblemResponse;
    const c = body.certified_config as { poses: unknown[] };
    await route.fulfill({
      response: r,
      json: { ...body, certified_config: { ...c, lattice: { b1: [3, 0], b2: [6, 0] } } },
    });
  });
  await page.goto("about:blank");
  await page.goto(`/#space=${id}`);
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`);
  await expect(page.locator("#space-shown")).toHaveText("none could be read");
  await expect(page.locator("#space-solve-run")).toBeDisabled();
  await page.unroute(`**/api/spaces/torus/problems/${id}`);

  // a lattice of cells 1e-150 wide is not degenerate, but far too small to draw: said at once
  await page.route(`**/api/spaces/torus/problems/${id}`, async (route) => {
    const r = await route.fetch();
    const body = (await r.json()) as SpaceProblemResponse;
    const c = body.certified_config as { poses: unknown[] };
    await route.fulfill({
      response: r,
      json: { ...body, certified_config: { ...c, lattice: { b1: [1e-150, 0], b2: [0, 1e-150] } } },
    });
  });
  await page.goto("about:blank");
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  await expect(page.locator(".space-draw svg text")).toHaveText(
    /^The lattice is far smaller than a piece \(its shortest vector is 1\.00e-150\), so it is not drawn\.$/,
  );
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /far smaller than a piece/);
});

test("without the kinds' descriptions a kind with records still opens, and one without records says so", async ({
  page,
}) => {
  await page.route("**/api/spaces", (route) => route.abort());
  await page.goto("/#space=torus/hex/5/8");
  await shown(page, "torus/hex/5/8");
  await expect(page.locator("#space-status")).toContainText("The kinds' descriptions could not be read");
  // the balls kind has no records: it needs its domain, and Try again reads it once the server answers
  await page.goto("about:blank");
  await page.goto("/#space=balls/ballinball/13");
  await expect(page.locator("#space-busy")).toContainText("The problems of this kind could not be loaded.");
  await page.unroute("**/api/spaces");
  await page.click("#space-retry");
  await expect(page.locator("#space-problem-note")).toHaveText("Problem balls/ballinball/13");
  await expect(page.locator("#space-empty")).toBeVisible();
});

test("a deep link whose problem cannot be read stays in the address", async ({ page }) => {
  await page.route("**/api/spaces/torus/records", (route) => route.abort());
  await page.goto("/#space=torus/hex/5/8");
  await expect(page.locator("#space-busy")).toContainText("The problems of this kind could not be loaded.");
  await expect(page).toHaveURL(/#space=torus\/hex\/5\/8$/);
  await page.unroute("**/api/spaces/torus/records");
  await page.route("**/api/spaces/torus/problems/torus/hex/5/8", (route) => route.abort());
  await page.click("#space-retry");
  await expect(page.locator("#space-busy")).toContainText("torus/hex/5/8 could not be loaded.");
  await expect(page).toHaveURL(/#space=torus\/hex\/5\/8$/);
  await page.unroute("**/api/spaces/torus/problems/torus/hex/5/8");
  await page.click("#space-retry");
  await shown(page, "torus/hex/5/8");
});

test("a run without a result clears the earlier one, and a submission carries the seed of the run that found it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const id = "sphere/4/10";
  await page.route(`**/api/spaces/sphere/problems/${id}`, weakenRecord);
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
  const record = await page.locator("#space-score").textContent();
  await page.fill("#name", "E2E board");

  // seed 1 finds a result that beats the (weakened) record
  await runFor(page, 4000, 1);
  await expect(page.locator("#space-submit")).toBeEnabled();

  // a new arrangement with seed 2, stopped before its first round ends: nothing is offered now
  await page.selectOption("#space-solve-start", "fresh");
  await page.fill("#space-solve-seed", "2");
  await page.click("#space-solve-run");
  await page.click("#space-solve-stop");
  await expect(page.locator("#space-solve-run")).toBeEnabled();
  await expect(page.locator("#space-solve-status")).toHaveText("Stopped. It ended before its first round finished.");
  await expect(page.locator("#space-submit")).toBeDisabled();
  await expect(page.locator("#space-shown")).toHaveText("the research record");
  await expect(page.locator("#space-score")).toHaveText(record!);
  await expect(page.locator("#space-solve-score")).toHaveText("—");

  // seed 3 from the record finds a result; a run from that result with seed 4, stopped at once, keeps it
  await page.selectOption("#space-solve-start", "shown");
  await runFor(page, 4000, 3);
  const found = await page.locator("#space-solve-score").textContent();
  await page.fill("#space-solve-seed", "4");
  await page.click("#space-solve-run");
  await page.click("#space-solve-stop");
  await expect(page.locator("#space-solve-run")).toBeEnabled();
  await expect(page.locator("#space-solve-status")).toContainText(`That result, ${found}, is kept.`);
  await expect(page.locator("#space-shown")).toHaveText("the optimizer's result");
  await page.click("#space-submit");
  await expect(page.locator("#space-submit-result")).toContainText("✓ Valid");
  await expect(page.locator("#space-busy")).toBeHidden();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ seed: 3, method: "sphere basin hopping (board, from the research record)" });
});

test("a space whose problems cannot be read leaves nothing live, and Try again loads them", async ({ page }) => {
  await page.goto("/#space=sphere/4/12");
  await shown(page, "sphere/4/12");
  await page.route("**/api/spaces/torus/records", (route) => route.abort());
  await choose(page, "torus");
  await expect(page.locator("#space-busy")).toContainText("The problems of this kind could not be loaded.");
  await expect(page).toHaveURL(/#space=torus$/);
  await menusShow(page, "torus");
  await expect(page.locator(".space-draw")).toHaveCount(0);
  await expect(page.locator("#space-solve-run")).toBeDisabled();
  await expect(page.locator("#space-submit")).toBeDisabled();
  await expect(page.locator("#space-score")).toHaveText("—");
  await page.unroute("**/api/spaces/torus/records");
  await page.click("#space-retry");
  await shown(page, DEFAULT_PROBLEM.torus);
  await expect(page.locator("#space-busy")).toBeHidden();
  await expect(page.locator("#space-solve-run")).toBeEnabled();
});

test("loading is shown while the space code and the problems arrive", async ({ page }) => {
  await openProblem(page, 4, 4, 5);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/src\/space\/mode\.ts/, async (route) => {
    await held;
    await route.continue();
  });
  await page.route("**/api/spaces/sphere/records", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await choose(page, "sphere");
  await expect(page.locator(".space-placeholder")).toHaveText("Loading…");
  release();
  await expect(page.locator("#space-busy-text")).toHaveText("Loading the problems of this kind…");
  await shown(page, DEFAULT_PROBLEM.sphere);
  await expect(page.locator(".space-placeholder")).toHaveCount(0);
  await expect(page.locator("#space-busy")).toBeHidden();
});

test("Back to an address without a space shows the polygon board", async ({ page }) => {
  await openProblem(page, 4, 4, 5);
  await page.evaluate(() => (location.hash = "#space=sphere/4/12"));
  // the first problem of a page waits for the mode's code
  await shown(page, "sphere/4/12", LAZY_VIEW);
  await page.goBack();
  await expect(page).toHaveURL(/#p=4,4,5$/);
  await expect(page.locator("#board")).toBeVisible();
  await menusShow(page, "polygon");
  // from the board's address without a hash, as a link from another site would open it
  await page.goto("/");
  await expect(page.locator("#board")).toBeVisible();
  await page.evaluate(() => (location.hash = "#space=torus"));
  await shown(page, DEFAULT_PROBLEM.torus, LAZY_VIEW);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#board")).toBeVisible();
  await menusShow(page, "polygon");
});

test("the answer to a submission is shown when the problem changed while it was sent", async ({ page }) => {
  const id = "sphere/4/10";
  await page.route(`**/api/spaces/sphere/problems/${id}`, weakenRecord);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/spaces/submit", async (route) => {
    await held;
    await route.fulfill({
      status: 200,
      json: { valid: true, reasons: [], score: 1, leader: true, best_score: 1, id: 5, beats_certified: true },
    });
  });
  await page.goto(`/#space=${id}`);
  await shown(page, id);
  await page.fill("#name", "E2E board");
  await runFor(page, 4000, 1);
  await page.click("#space-submit");
  await page.selectOption("#space-f-P", "12");
  await shown(page, "sphere/4/12");
  release();
  await expect(page.locator("#space-submit-result")).toHaveText(
    "Your entry for sphere/4/10: ✓ Kept. Server score 1.000000. This is now the best entry for this problem. It beats the research record.",
  );
  await expect(page.locator("#space-status")).toContainText("Your entry for sphere/4/10:");
});

test("a polygon run is paused while a space is shown, and goes on after", async ({ page }) => {
  await openProblem(page, 4, 4, 5);
  await expect(page.locator("#solve-run")).toBeEnabled();
  await page.selectOption("#solve-method", "basin_hopping");
  await page.selectOption("#solve-budget", "both");
  await page.locator("#solve-time").fill("300");
  await page.fill("#solve-evals", "1000000");
  await page.click("#solve-run");
  await expect(page.locator("#solve-stop")).toBeEnabled();
  await choose(page, "sphere");
  await shown(page, DEFAULT_PROBLEM.sphere);
  await expect(page.locator("#space-hold")).toBeVisible();
  await expect(page.locator("#space-hold")).toContainText("It goes on when you choose Flat under 2D in 2D again.");
  await expect(page.locator("#solve-pause")).toHaveText("Resume");
  await choose(page, "polygon");
  await expect(page.locator("#solve-pause")).toHaveText("Pause");
  await expect(page.locator("#solve-status")).toHaveText(/^Running/);
  await page.click("#solve-stop");
  await expect(page.locator("#solve-run")).toBeEnabled();
  // a run the user paused stays paused
  await page.click("#solve-run");
  await expect(page.locator("#solve-stop")).toBeEnabled();
  await page.click("#solve-pause");
  await expect(page.locator("#solve-pause")).toHaveText("Resume");
  await choose(page, "sphere");
  await expect(page.locator("#space-hold")).toBeHidden();
  await choose(page, "polygon");
  await expect(page.locator("#solve-pause")).toHaveText("Resume");
  await page.click("#solve-stop");
});

test("words and focus: the globe turns both ways, an empty drawing takes no focus, an empty seed is refused", async ({
  page,
}) => {
  // the curved globe (K > 0) turns left and right as well as up and down
  await page.goto("/#space=curved/1/4/4/3");
  await shown(page, "curved/1/4/4/3");
  const draw = page.locator(".space-draw");
  await expect(page.locator(".space-hint")).toBeVisible();
  const before = await page.locator(".space-draw svg").innerHTML();
  await draw.focus();
  await page.keyboard.press("ArrowRight");
  expect(await page.locator(".space-draw svg").innerHTML()).not.toBe(before);
  // the gnomonic chart does not turn: no hint, no focus
  await page.getByRole("button", { name: "Gnomonic chart" }).click();
  await expect(page.locator(".space-hint")).toBeHidden();
  await expect(draw).toHaveAttribute("role", "img");

  // no packing exists, so there is nothing to turn
  await page.goto("about:blank");
  await page.goto("/#space=curved/1/0/4/2");
  await expect(page.locator("#space-problem-note")).toHaveText("Problem curved/1/0/4/2");
  await expect(draw).toHaveAttribute("role", "img");
  await expect(draw).not.toHaveAttribute("tabindex", /.*/);
  await expect(page.locator(".space-hint")).toBeHidden();

  // an empty seed is not 0
  await page.goto("about:blank");
  await page.goto("/#space=sphere/4/12");
  await shown(page, "sphere/4/12");
  await page.fill("#space-solve-seed", "");
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-status")).toHaveText(
    "Random seed: enter a whole number from 0 to 4,294,967,295. Nothing was run.",
  );
  await expect(page.locator("#space-solve-stop")).toBeDisabled();
});

test("a search thread that fails says so in a sentence", async ({ page }) => {
  await page.route(/\/src\/space\/worker\.ts/, (route) =>
    route.fulfill({ contentType: "text/javascript", body: 'throw new Error("broken on purpose");' }),
  );
  await page.goto("/#space=sphere/4/12");
  await shown(page, "sphere/4/12");
  await runFor(page, 6000);
  await expect(page.locator("#space-solve-status")).toContainText(
    "The search ended with errors. The search thread failed:",
  );
  await expect(page.locator("#space-solve-progress")).toHaveText(/^3 rounds · 0 evaluations · /);
});

test("a large fold surface starts with a smaller budget, says why, and shows a long round working", async ({
  page,
}) => {
  await page.goto("/#space=surface/icosahedron/fold/3/80");
  await shown(page, "surface/icosahedron/fold/3/80");
  await expect(page.locator("#space-solve-evals")).toHaveValue("8");
  await expect(page.locator("#space-solve-unit")).toContainText("rounds of 2");
  await expect(page.locator("#space-solve-unit")).toContainText("Fold rounds on 80 pieces are slow");
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-progress")).toContainText(/round running for \d+ s/, { timeout: 15_000 });
  await page.click("#space-solve-stop");
  await expect(page.locator("#space-solve-run")).toBeEnabled({ timeout: 1000 });
});
