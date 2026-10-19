import AxeBuilder from "@axe-core/playwright";
import { expect, Page, test } from "@playwright/test";
import { evaluate, findOverlaps } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import { strictTolerance } from "@polypack/solver";

// Tighter against the local end-to-end stack (playwright.config.ts: an in-memory server on 8788 behind
// the Vite dev server on 5174). Every request is checked to stay on that stack.

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
}
const focused = (page: Page): Promise<ProblemView> =>
  page.evaluate(() => {
    const s = (window as any).tighter.state;
    return structuredClone(s.queue.find((p: { key: string }) => p.key === s.focus));
  });
const rp = (page: Page): Promise<number> => page.evaluate(() => (window as any).tighter.state.rp);
const siteBest = async (page: Page, p: ProblemView) =>
  (await (await page.request.get(`/api/problems/${p.N}/${p.M}/${p.P}`)).json()).site_best;

async function evolveOnce(page: Page): Promise<void> {
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  const runs = await page.evaluate(() => (window as any).tighter.state.stats.runs);
  await page.click("#t-evolve");
  await expect
    .poll(() => page.evaluate(() => (window as any).tighter.state.stats.runs), { timeout: 60_000 })
    .toBe(runs + 1);
}

test("tighter: Load all, Compact, the first record is sent, Evolve improves it, an upgrade is bought", async ({
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

  await page.goto("/tighter.html?seed=7");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/tighter.html?seed=7");

  // the bare board: a dealt open problem, Load all and a disabled Compact
  await expect(page.locator("#t-title")).toHaveText(/pieces$/);
  await expect(page.locator("#t-problem-note")).toHaveText("No record exists. Any valid packing is a new record.");
  await expect(page.locator("#t-compact")).toBeDisabled();
  await expect(page.locator("#t-stop")).toBeVisible();
  await expect(page.locator("#t-score")).toBeHidden();
  let p = await focused(page);
  expect(await siteBest(page, p)).toBeNull();

  // Load all: the free floor, never sent
  await page.click("#t-loadall");
  await expect(page.locator("#t-compact")).toBeEnabled();
  p = await focused(page);
  expect(p.phase).toBe("loaded");
  expect(p.board!.pieces).toHaveLength(p.P);
  expect(p.floor).toBe(evaluate(p.board!, { autoOrient: true }).score);

  // Compact: a real mc_compress run of 100 evaluations from the board, and the first record
  await page.click("#t-compact");
  await expect(page.locator("#t-evolve")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#t-banner")).toContainText("New record");
  p = await focused(page);
  expect(p.phase).toBe("ready");
  expect(p.best!).toBeLessThan(p.floor! * (1 - 1e-9));
  expect(findOverlaps(p.N, p.board!.pieces, strictTolerance(p.board!))).toEqual([]);
  expect(evaluate(p.board!, { autoOrient: true }).score).toBe(p.best);
  // nothing is sent before the player consents
  await page.waitForTimeout(1500);
  expect(await siteBest(page, p)).toBeNull();
  await expect(page.locator("#t-consent")).toBeVisible();

  await page.fill("#t-name", "E2E Tighter");
  await page.check("#t-agree");
  await page.click("#t-consent-save");

  // the first record goes at once, with its provenance, and pays record points once verified
  await expect.poll(async () => (await siteBest(page, p))?.name, { timeout: 15_000 }).toBe("E2E Tighter");
  const first = await siteBest(page, p);
  expect(first.score).toBeCloseTo(p.best!, 12);
  const entry = await (await page.request.get(`/api/submissions/${first.id}`)).json();
  expect(entry).toMatchObject({
    found_with: "optimizer",
    method: "mc_compress",
    seed: 1,
    budget: { evals: 100 },
    agent_note: "tighter/0.1",
  });
  expect(entry.method_params).toMatchObject({ sweepsPerEvaluation: 10 });
  await expect(page.locator("#t-points")).toBeVisible();
  const earned = await rp(page);
  expect(earned).toBeGreaterThanOrEqual(5);
  await expect(page.locator("#t-held")).toHaveText("1");

  // Evolve: real runs from the board with the next seeds, until one improves it
  for (let i = 0; i < 5 && (await focused(page)).best! >= first.score; i++) await evolveOnce(page);
  p = await focused(page);
  expect(p.best!).toBeLessThan(first.score);
  // the problem's next submission waits for its minute
  await page.waitForTimeout(2500);
  expect((await siteBest(page, p)).score).toBe(first.score);
  await expect(page.locator("#t-pending")).toContainText("next send");
  // past the minute the improvement goes and is paid. Game time can be moved only in development
  // builds; against a production build (POLYPACK_E2E_PRODUCTION=1) this waits the real minute.
  const dev = await page.evaluate(() => (window as any).tighter.dev);
  if (dev) await page.evaluate(() => (window as any).tighter.skipAhead(61_000));
  await expect
    .poll(async () => (await siteBest(page, p)).score, { timeout: dev ? 15_000 : 75_000 })
    .toBeLessThan(first.score);
  const second = await siteBest(page, p);
  expect(second.name).toBe("E2E Tighter");
  const second_entry = await (await page.request.get(`/api/submissions/${second.id}`)).json();
  expect(second_entry).toMatchObject({ found_with: "optimizer", method: "mc_compress", budget: { evals: 30 } });
  // the server keeps only the leader: the overtaken first record is gone, and the game holds one record
  expect((await page.request.get(`/api/submissions/${first.id}`)).status()).toBe(404);
  expect(await page.evaluate(() => (window as any).tighter.state.queue[0].ourId)).toBe(second.id);
  await expect(page.locator("#t-held")).toHaveText("1");
  expect(second_entry.seed).toBeGreaterThanOrEqual(2);
  await expect.poll(() => rp(page)).toBeGreaterThan(earned);

  // an upgrade: Side-length trace, 5 RP
  const before = await rp(page);
  await expect(page.locator('.t-card[data-id="trace"] button')).toBeEnabled();
  await page.click('.t-card[data-id="trace"] button');
  await expect(page.locator("#t-trace")).toBeVisible();
  expect(await rp(page)).toBeCloseTo(before - 5, 9);
  expect(await page.evaluate(() => (window as any).tighter.state.owned)).toEqual(["trace"]);

  // the game is kept in the browser across a reload
  const saved = await focused(page);
  await page.reload();
  await expect(page.locator("#t-evolve")).toBeVisible();
  expect(await page.evaluate(() => (window as any).tighter.state.owned)).toEqual(["trace"]);
  expect((await focused(page)).best).toBe(saved.best);
  await expect(page.locator("#t-trace")).toBeVisible();

  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`)).toEqual([]);
  expect(offStack).toEqual([]);
  expect(errors).toEqual([]);
});

test("tighter: Stop ends a run and keeps its best", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tighter.html?seed=3");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/tighter.html?seed=3");
  await expect(page.locator("#t-title")).toHaveText(/pieces$/);
  await page.click("#t-loadall");
  await expect(page.locator("#t-compact")).toBeEnabled();
  // Compact, then Stop at once: a starter problem compacts in about a second, too fast to catch otherwise
  const stopEnabled = await page.evaluate(() => {
    document.getElementById("t-compact")!.click();
    const stop = document.getElementById("t-stop") as HTMLButtonElement;
    const enabled = !stop.disabled;
    stop.click();
    return enabled;
  });
  expect(stopEnabled).toBe(true);
  await expect(page.locator("#t-stop")).toBeDisabled({ timeout: 10_000 });
  await expect(page.locator("#status")).toContainText(/^Compact/);
  const p = await focused(page);
  // whatever was kept is a strict packing no larger than Load all, and nothing was sent
  expect(p.best!).toBeLessThanOrEqual(p.floor!);
  expect(findOverlaps(p.N, p.board!.pieces, strictTolerance(p.board!))).toEqual([]);
  expect(await page.evaluate(() => (window as any).tighter.state.stats.submissions)).toBe(0);
  // the board is still playable
  await expect(page.locator("#t-compact, #t-evolve").first()).toBeEnabled();
});
