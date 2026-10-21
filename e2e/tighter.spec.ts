import AxeBuilder from "@axe-core/playwright";
import { expect, Page, test } from "@playwright/test";
import { evaluate, findOverlaps } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import { strictTolerance } from "@polypack/solver";

// Tighter against the local end-to-end stack (playwright.config.ts: an in-memory server on 8788 behind
// the Vite dev server on 5174). Every request is checked to stay on that stack.
//
// A click is k evaluations of a solver run that stays open on the problem; points are paid per
// click (with consent) and confirmed or taken back by the server's answer to the next submission.

interface ProblemView {
  key: string;
  N: number;
  M: number;
  P: number;
  phase: string;
  floor: number | null;
  best: number | null;
  board: PackingConfig | null;
  verified: number | null;
  ourId: number | null;
  runs: number;
  nextSeed: number;
  unconfirmed: number;
  sending: unknown;
}
const focused = (page: Page): Promise<ProblemView> =>
  page.evaluate(() => {
    const s = (window as any).tighter.state;
    return structuredClone(s.queue.find((p: { key: string }) => p.key === s.focus));
  });
const stats = (page: Page) => page.evaluate(() => structuredClone((window as any).tighter.state.stats));
const rp = (page: Page): Promise<number> => page.evaluate(() => (window as any).tighter.state.rp);
const idle = (page: Page) => page.evaluate(() => !(window as any).tighter.busy);
const siteBest = async (page: Page, p: ProblemView) =>
  (await (await page.request.get(`/api/problems/${p.N}/${p.M}/${p.P}`)).json()).site_best;

async function fresh(page: Page, seed: number): Promise<void> {
  await page.goto(`/tighter.html?seed=${seed}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/tighter.html?seed=${seed}`);
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
}

/** The first record: the first Evolve click compacts the placed board (a run of 100 evaluations that stays open). */
async function firstRecord(page: Page): Promise<void> {
  // a new problem is placed at once; the first Evolve click compacts it (100 evaluations)
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)", { timeout: 30_000 });
  await page.click("#t-evolve");
  await expect
    .poll(async () => (await focused(page)).phase === "ready" && (await idle(page)), { timeout: 60_000 })
    .toBe(true);
}

/** One Evolve click, waited until it has run. */
async function click(page: Page): Promise<void> {
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  const clicks = (await stats(page)).clicks;
  await page.click("#t-evolve");
  await expect
    .poll(async () => (await stats(page)).clicks > clicks && (await idle(page)), { timeout: 60_000 })
    .toBe(true);
}

async function clickUntilBetter(page: Page, than: number, tries = 200): Promise<void> {
  for (let i = 0; i < tries && (await focused(page)).best! >= than * (1 - 2e-9); i++) await click(page);
  expect((await focused(page)).best!).toBeLessThan(than * (1 - 2e-9));
}

/** Points for the tests, through the page's handle (development builds). */
const grant = (page: Page, points: number) =>
  page.evaluate((n) => {
    const s = (window as any).tighter.state;
    s.rp += n;
    s.rpEarned += n;
  }, points);

/** The tech tree's tab, opened: the upgrades live there. */
async function openTree(page: Page): Promise<void> {
  const tab = page.locator("#t-tab-tree");
  await expect(tab).toBeVisible({ timeout: 10_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

/** The board's tab, back in front (the trace and the score are drawn on it). */
async function openBoard(page: Page): Promise<void> {
  const tab = page.locator("#t-tab-board");
  if ((await tab.isVisible()) && (await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

/** The game's log (kept in the save; the page shows the latest important line on the notice line). */
const logText = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).tighter.state.log.map((l: { text: string }) => l.text).join("\n"));

/** Buys upgrades from the tech tree: pressing a node you can afford buys it. */
async function buyAll(page: Page, ids: string[]): Promise<void> {
  await openTree(page);
  for (const id of ids) {
    const node = page.locator(`.t-card[data-id="${id}"]`);
    await expect(node).toHaveAttribute("data-state", "buyable", { timeout: 10_000 });
    await node.locator("button").click();
    await expect.poll(() => page.evaluate((i) => (window as any).tighter.state.owned.includes(i), id)).toBe(true);
  }
  await openBoard(page);
}

test("tighter: placed at once, the first click compacts, the first record is sent, clicks improve it and pay at once, upgrades are bought", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const offStack: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol !== "data:" && u.protocol !== "blob:" && u.host !== "localhost:5174") offStack.push(r.url());
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await fresh(page, 7);

  // a dealt open problem is placed at once (pieces on rings around the centre): the free floor, never sent
  await expect(page.locator("#t-problem-note")).toHaveText("No record exists. Any valid packing is a new record.");
  await expect(page.locator("#t-stop")).toBeVisible();
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)", { timeout: 30_000 });
  await expect(page.locator("#t-score")).toBeVisible();
  await expect(page.locator("#t-trace-empty")).toBeVisible();
  let p = await focused(page);
  expect(await siteBest(page, p)).toBeNull();
  expect(p.phase).toBe("loaded");
  expect(p.board!.pieces).toHaveLength(p.P);
  expect(p.floor).toBe(evaluate(p.board!, { autoOrient: true }).score);

  // the first Evolve click compacts: one press, 100 evaluations of a real mc_compress run (seed 1) that
  // stays open, and the first record
  await page.click("#t-evolve");
  await expect
    .poll(async () => (await focused(page)).phase === "ready" && (await idle(page)), { timeout: 60_000 })
    .toBe(true);
  await expect(page.locator("#t-evolve")).toBeVisible();
  await expect(page.locator("#t-evolve")).toHaveText("Evolve");
  await expect(page.locator("#t-banner")).toContainText("New record");
  p = await focused(page);
  expect(p.best!).toBeLessThan(p.floor! * (1 - 1e-9));
  expect(findOverlaps(p.N, p.board!.pieces, strictTolerance(p.board!))).toEqual([]);
  // the run scores the container at fixed angles between turns: the server's best angle is no worse
  expect(evaluate(p.board!, { autoOrient: true }).score!).toBeLessThanOrEqual(p.best!);
  // the start's scoring and Compact's 100 evaluations, in one run with seed 1
  expect(await stats(page)).toMatchObject({ evaluations: 101, clicks: 1, runs: 1 });
  expect(p).toMatchObject({ runs: 1, nextSeed: 2 });
  await expect(page.locator("#t-runinfo")).toContainText("mc_compress · run at 101 evaluations");
  // the next problem is earned by work: 300 clicks of one evaluation
  await expect(page.locator("#t-next")).toBeDisabled();
  await expect(page.locator("#t-next")).toHaveText(/^Next problem after [\d,]+ evaluations$/);
  // nothing is sent and nothing is paid before the player consents
  await page.waitForTimeout(1500);
  expect(await siteBest(page, p)).toBeNull();
  expect(await rp(page)).toBe(0);
  // the first record asks for a name in a pop-up over the board
  await expect(page.locator("#t-welcome #t-consent")).toBeVisible();

  await page.fill("#t-name", "E2E Tighter");
  await page.check("#t-agree");
  await page.click("#t-consent-save");
  await expect(page.locator("#t-welcome")).toBeHidden();

  // consent pays the record so far at once; the first record goes at once, with its provenance
  await expect(page.locator("#t-points")).toBeVisible();
  const paid = await rp(page);
  expect(paid).toBeGreaterThanOrEqual(5);
  await expect.poll(async () => (await siteBest(page, p))?.name, { timeout: 15_000 }).toBe("E2E Tighter");
  const first = await siteBest(page, p);
  p = await focused(page);
  // the board was turned to its best angle before it went: the server's score is the board's
  expect(first.score).toBeCloseTo(p.best!, 12);
  const entry = await (await page.request.get(`/api/submissions/${first.id}`)).json();
  expect(entry).toMatchObject({
    found_with: "optimizer",
    method: "mc_compress",
    seed: 1,
    budget: { evals: 101 },
    agent_note: "tighter/0.1",
  });
  expect(entry.method_params).toMatchObject({ sweepsPerEvaluation: 5 });
  // the answer confirms what was paid; it pays nothing more
  await expect.poll(async () => (await focused(page)).ourId, { timeout: 15_000 }).toBe(first.id);
  p = await focused(page);
  expect(p.unconfirmed).toBe(0);
  expect(p.sending).toBeNull();
  // everything paid so far (consent's payment, and the container's turn before the send) is confirmed
  const confirmed = await rp(page);
  expect(confirmed).toBeGreaterThanOrEqual(paid - 1e-9);
  await expect.poll(() => logText(page)).toContain(`${confirmed.toFixed(1)} RP confirmed`);
  await expect(page.locator("#t-notice")).toContainText("RP confirmed");
  await expect(page.locator("#t-held")).toHaveText("1");

  // Evolve: each click is one more evaluation of the same run; an improving click pays at once
  const s0 = await stats(page);
  await click(page);
  expect((await stats(page)).evaluations).toBe(s0.evaluations + 1);
  await clickUntilBetter(page, first.score);
  p = await focused(page);
  expect(p.runs).toBe(1);
  const afterClicks = await rp(page);
  expect(p.unconfirmed).toBeCloseTo(afterClicks - confirmed, 9);
  expect(afterClicks).toBeGreaterThan(confirmed);
  await expect(page.locator("#t-pending")).toContainText("sent within the minute");
  // the problem's next submission waits for its minute
  await page.waitForTimeout(2500);
  expect((await siteBest(page, p)).score).toBe(first.score);
  // past the minute the improvement goes and its points are confirmed. Game time can be moved only in
  // development builds; against a production build (POLYPACK_E2E_PRODUCTION=1) this waits the real minute.
  const dev = await page.evaluate(() => (window as any).tighter.dev);
  if (dev) await page.evaluate(() => (window as any).tighter.skipAhead(61_000));
  await expect
    .poll(async () => (await siteBest(page, p)).score, { timeout: dev ? 15_000 : 75_000 })
    .toBeLessThan(first.score);
  const second = await siteBest(page, p);
  expect(second.name).toBe("E2E Tighter");
  const secondEntry = await (await page.request.get(`/api/submissions/${second.id}`)).json();
  // the same run (seed 1), as far as it had gone when it found the board
  expect(secondEntry).toMatchObject({ found_with: "optimizer", method: "mc_compress", seed: 1 });
  expect(secondEntry.budget.evals).toBeGreaterThan(101);
  // the server keeps only the leader: the overtaken first record is gone, and the game holds one record
  expect((await page.request.get(`/api/submissions/${first.id}`)).status()).toBe(404);
  await expect.poll(async () => (await focused(page)).ourId, { timeout: 15_000 }).toBe(second.id);
  await expect.poll(async () => (await focused(page)).unconfirmed).toBe(0);
  await expect(page.locator("#t-held")).toHaveText("1");
  expect(await rp(page)).toBeGreaterThanOrEqual(afterClicks - 1e-9);

  // the trace is drawn in the board's corner from the start; an upgrade, Trace detail (5 RP), labels it
  await expect(page.locator("#t-trace")).toBeVisible();
  await expect(page.locator("#t-trace text")).toHaveCount(0);
  const before = await rp(page);
  await buyAll(page, ["trace"]);
  await openBoard(page);
  await expect(page.locator("#t-trace text")).toHaveCount(1);
  expect(await rp(page)).toBeCloseTo(before - 5, 9);
  expect(await page.evaluate(() => (window as any).tighter.state.owned)).toEqual(["trace"]);

  // evaluations per click: 2 per click, then 3
  await grant(page, 1000);
  await buyAll(page, ["click2"]);
  await expect(page.locator("#t-evolve")).toHaveText("Evolve ×2");
  let e = (await stats(page)).evaluations;
  await click(page);
  expect((await stats(page)).evaluations).toBe(e + 2);
  await buyAll(page, ["click3"]);
  await expect(page.locator("#t-evolve")).toHaveText("Evolve ×3");
  e = (await stats(page)).evaluations;
  await click(page);
  expect((await stats(page)).evaluations).toBe(e + 3);
  expect((await focused(page)).runs).toBe(1);

  // the game is kept in the browser across a reload
  await page.waitForTimeout(1500);
  const saved = await focused(page);
  await page.reload();
  await expect(page.locator("#t-evolve")).toBeVisible();
  await expect(page.locator("#t-evolve")).toHaveText("Evolve ×3");
  expect(await page.evaluate(() => (window as any).tighter.state.owned)).toEqual(["trace", "click2", "click3"]);
  expect((await focused(page)).best).toBe(saved.best);
  await expect(page.locator("#t-trace text")).toHaveCount(1);
  // after a reload the next click opens a run with the next seed
  await click(page);
  expect(await focused(page)).toMatchObject({ runs: 2, nextSeed: 3 });

  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`)).toEqual([]);
  expect(offStack).toEqual([]);
  expect(errors).toEqual([]);
});

test("tighter: Stop drops queued clicks and keeps the best", async ({ page }) => {
  test.setTimeout(120_000);
  await fresh(page, 3);
  await firstRecord(page);
  const clicks0 = (await stats(page)).clicks;
  // fifteen clicks at once: the first runs, the rest queue; Stop drops what is queued
  const stopEnabled = await page.evaluate(() => {
    const evolve = document.getElementById("t-evolve")!;
    for (let i = 0; i < 15; i++) evolve.click();
    const stop = document.getElementById("t-stop") as HTMLButtonElement;
    const enabled = !stop.disabled;
    stop.click();
    return enabled;
  });
  expect(stopEnabled).toBe(true);
  await expect(page.locator("#status")).toContainText("Stopped");
  await expect.poll(() => idle(page), { timeout: 10_000 }).toBe(true);
  await expect(page.locator("#t-stop")).toBeDisabled();
  const ran = (await stats(page)).clicks - clicks0;
  expect(ran).toBeGreaterThanOrEqual(1);
  expect(ran).toBeLessThan(15);
  const p = await focused(page);
  // the board is a strict packing smaller than its placed start, and nothing was sent
  expect(p.best!).toBeLessThan(p.floor!);
  expect(findOverlaps(p.N, p.board!.pieces, strictTolerance(p.board!))).toEqual([]);
  expect((await stats(page)).submissions).toBe(0);
  // the board is still playable
  await click(page);
});

test("tighter: auto-eval banks one evaluation every 5 s, at most an hour, runs it when on, and earns while away", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 5);
  await firstRecord(page);
  await page.fill("#t-name", "Idle Player");
  await page.check("#t-agree");
  await page.click("#t-consent-save");
  await grant(page, 5000);
  await expect(page.locator("#t-auto")).toBeHidden();
  await buyAll(page, ["trace", "click2", "click3", "click4", "auto1"]);
  await expect(page.locator("#t-evolve")).toHaveText("Evolve ×4");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: off");
  await expect(page.locator("#t-bar-bank-box")).toBeVisible();

  await page.click("#t-auto");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: on");
  await expect(page.locator("#t-bar-auto")).toHaveText("1 evaluation every 5 s");
  // two hours on: the bank holds one hour (720 evaluations) and runs it, in clicks of 4, beside the player
  const s0 = await stats(page);
  await page.evaluate(() => ((window as any).tighter.state.bankAt -= 2 * 3600_000));
  await expect
    .poll(async () => (await stats(page)).evaluations - s0.evaluations, { timeout: 120_000 })
    .toBeGreaterThanOrEqual(716);
  await expect
    .poll(async () => (await page.evaluate(() => (window as any).tighter.state.bank)) < 4 && (await idle(page)), {
      timeout: 30_000,
    })
    .toBe(true);
  const s1 = await stats(page);
  expect(s1.evaluations - s0.evaluations).toBeLessThanOrEqual(740);
  expect(s1.evaluations - s0.evaluations).toBe(Math.round((s1.evaluations - s0.evaluations) / 4) * 4);
  // auto-eval's evaluations are not the player's clicks
  expect(s1.clicks).toBe(s0.clicks);
  await expect(page.locator("#t-bank-note")).toContainText("at most 720 evaluations (1 h of every lane's auto-eval)");

  // away for half an hour with auto-eval on: the page saves as it goes (pagehide), and nothing else is
  // written afterwards, so the reload reads exactly that save
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.settings.auto = true;
    s.bank = 0;
    s.bankAt = Date.now() - 1800_000;
    window.dispatchEvent(new Event("pagehide"));
    Storage.prototype.setItem = () => {};
  });
  await page.reload();
  await expect(page.locator("#t-evolve")).toBeVisible({ timeout: 30_000 });
  // compute starts only on a press: auto-eval is off, and what it earned waits in its bank
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: off");
  const bank = await page.evaluate(() => (window as any).tighter.state.bank);
  expect(bank).toBeGreaterThanOrEqual(359);
  expect(bank).toBeLessThan(366);
  await expect(page.locator("#status")).toContainText(/While you were away, auto-eval earned 36\d evaluations/);
  const s2 = await stats(page);
  await page.click("#t-auto");
  await expect(page.locator("#status")).toContainText("banked while it was away run first");
  await expect
    .poll(async () => (await page.evaluate(() => (window as any).tighter.state.bank)) < 4 && (await idle(page)), {
      timeout: 120_000,
    })
    .toBe(true);
  const ran = (await stats(page)).evaluations - s2.evaluations;
  // the bank in clicks of 4, and the new run's start (a reload closes runs)
  expect(ran).toBeGreaterThanOrEqual(356);
  expect(ran).toBeLessThanOrEqual(372);
  expect(errors).toEqual([]);
});

test("tighter: a method change opens a new run with the next seed", async ({ page }) => {
  test.setTimeout(180_000);
  await fresh(page, 9);
  await firstRecord(page);
  await grant(page, 50_000);
  await buyAll(page, [
    "trace",
    "click2",
    "click3",
    "click4",
    "auto1",
    "click5",
    "seeds",
    "auto2",
    "click6",
    "click7",
    "auto3",
    "click8",
    "click9",
    "click10",
    "auto4",
  ]);
  await expect(page.locator("#t-method-box")).toBeHidden();
  await buyAll(page, ["basin"]);
  await expect(page.locator("#t-method-box")).toBeVisible();
  expect(await focused(page)).toMatchObject({ runs: 1, nextSeed: 2 });
  await expect(page.locator("#t-runinfo")).toContainText("mc_compress · seed 1");
  const runs0 = (await stats(page)).runs;

  await page.selectOption("#t-method", "basin_hopping");
  await click(page);
  expect(await focused(page)).toMatchObject({ runs: 2, nextSeed: 3 });
  await expect(page.locator("#t-runinfo")).toContainText("basin_hopping · seed 2");
  // the same run goes on with the next click
  await click(page);
  expect((await focused(page)).runs).toBe(2);
  expect((await stats(page)).runs).toBe(runs0 + 1);

  await page.selectOption("#t-method", "mc_compress");
  await click(page);
  expect(await focused(page)).toMatchObject({ runs: 3, nextSeed: 4 });
  await expect(page.locator("#t-runinfo")).toContainText("mc_compress · seed 3");
  // none of these runs ended by itself, so the problem's one seed is not spent
  await expect(page.locator("#t-evolve")).toBeEnabled();
});
