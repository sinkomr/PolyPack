import AxeBuilder from "@axe-core/playwright";
import { expect, Page, test } from "@playwright/test";

// Tighter's long game against the local end-to-end stack (an in-memory server on 8788 behind the
// Vite dev server on 5174): the whole tree in the shop, the earlier auto-eval, the dealer's offers
// and filters, method match and pipelines, rent, collections and a reset with a rule, and a save
// from the per-click build. Upgrades the test does not play for are given through the page's
// handle (development builds), as the other specs give points.

interface ProblemView {
  key: string;
  N: number;
  M: number;
  P: number;
  phase: string;
  best: number | null;
  ourId: number | null;
  runs: number;
  endedRuns: number;
}
const focused = (page: Page): Promise<ProblemView> =>
  page.evaluate(() => {
    const s = (window as any).tighter.state;
    return structuredClone(s.queue.find((p: { key: string }) => p.key === s.focus));
  });
const stats = (page: Page) => page.evaluate(() => structuredClone((window as any).tighter.state.stats));
const idle = (page: Page) => page.evaluate(() => !(window as any).tighter.busy);
const game = <T>(page: Page, f: (s: any) => T): Promise<T> =>
  page.evaluate(`(${f.toString()})(window.tighter.state)`) as Promise<T>;

async function fresh(page: Page, seed: number): Promise<void> {
  await page.goto(`/tighter.html?seed=${seed}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/tighter.html?seed=${seed}`);
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
}

async function firstRecord(page: Page): Promise<void> {
  // a new problem is placed at once; the first Evolve click compacts it (100 evaluations)
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)", { timeout: 30_000 });
  await page.click("#t-evolve");
  await expect
    .poll(async () => (await focused(page)).phase === "ready" && (await idle(page)), { timeout: 60_000 })
    .toBe(true);
}

async function click(page: Page): Promise<void> {
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 60_000 });
  const clicks = (await stats(page)).clicks;
  await page.click("#t-evolve");
  await expect
    .poll(async () => (await stats(page)).clicks > clicks && (await idle(page)), { timeout: 60_000 })
    .toBe(true);
}

/** The name form: in the first record's pop-up while it is up, else in Settings (closed again after). */
async function consent(page: Page, name: string): Promise<void> {
  if (!(await page.locator("#t-name").isVisible())) await page.click("#t-open-settings");
  await page.fill("#t-name", name);
  await page.check("#t-agree");
  await page.click("#t-consent-save");
  if (await page.locator("#t-settings").evaluate((d) => (d as HTMLDialogElement).open))
    await page.click("#t-settings-close");
}

/** The tech tree's tab, opened: the upgrades live there. */
async function openTree(page: Page): Promise<void> {
  const tab = page.locator("#t-tab-tree");
  await expect(tab).toBeVisible({ timeout: 10_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

/** The game's log (kept in the save; the page shows the latest important line on the notice line). */
const logText = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).tighter.state.log.map((l: { text: string }) => l.text).join("\n"));

/** Points for the tests, through the page's handle. */
const grant = (page: Page, points: number) =>
  page.evaluate((n) => {
    const s = (window as any).tighter.state;
    s.rp += n;
    s.rpEarned += n;
  }, points);

/** Upgrades the test does not play for, owned at once. */
const give = (page: Page, ids: string[]) =>
  page.evaluate((list) => {
    const s = (window as any).tighter.state;
    for (const id of list) if (!s.owned.includes(id)) s.owned.push(id);
  }, ids);

/** Buys an upgrade from the tech tree: pressing a node you can afford buys it. */
async function buy(page: Page, id: string): Promise<void> {
  await openTree(page);
  const node = page.locator(`.t-card[data-id="${id}"]`);
  await expect(node).toHaveAttribute("data-state", "buyable", { timeout: 10_000 });
  await node.locator("button").click();
  await expect.poll(() => page.evaluate((i) => (window as any).tighter.state.owned.includes(i), id)).toBe(true);
}

/** At phone width the panel's sections are views of their own, chosen with the dock's tabs. */
const dockView = (page: Page, view: "queue" | "points") => page.click(`#t-dock-${view}`);

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

const axe = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations.map(
    (v) => `${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 100)}`,
  );

const CLICK_LADDER = [
  "trace",
  "click2",
  "click3",
  "click4",
  "click5",
  "click6",
  "click7",
  "click8",
  "click9",
  "click10",
];

test("long game: the whole tree in its pane, mysteries until their prerequisites, levels, standing last", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 21);
  await grant(page, 5);
  // the tech tree is a pane of its own, beside the board; its tab counts what can be bought
  await expect(page.locator("#t-tab-count")).toHaveText("1");
  await expect(page.locator("#t-next-up")).toHaveText("1 upgrade to buy in the tech tree");
  await openTree(page);
  const shop = page.locator("#t-upgrades");
  await expect(shop).toBeVisible();
  // a band for every row but Standing from the start, and the summary counts the mysteries
  const rows = await page
    .locator("#t-cards .t-band")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.row));
  expect(rows).toEqual(["clicks", "auto", "seeds", "queue", "methods", "runs", "problems", "dealer", "records"]);
  await expect(page.locator("#t-shop-summary")).toHaveText(
    /^0 of \d+ upgrades owned · \d+ still \?\?\?\?\?\? · 1 to buy now$/,
  );
  // the first node can be bought at once; the fancier ones show as ??????, their details naming what they need
  await expect(page.locator('.t-card[data-id="trace"]')).toHaveAttribute("data-state", "buyable");
  const harden = page.locator('.t-node[data-id="harden"]');
  await expect(harden).toHaveAttribute("data-state", "mystery");
  await expect(harden.locator(".t-node-name")).toHaveText("??????");
  await harden.locator("button").click();
  await expect(page.locator("#t-tree-detail")).toContainText("Needs Method: seed.");
  await expect(page.locator('.t-node[data-id="click3"] .t-node-name')).toHaveText("3 a click");
  expect(await axe(page)).toEqual([]);

  // a mystery revealed: Method: seed bought, Method: harden shows as itself
  const before = CLICK_LADDER.concat(["auto1", "auto2", "auto3", "auto4", "basin", "shrink", "penalty"]);
  await give(page, before);
  await grant(page, 21_000);
  await buy(page, "lattice");
  await expect(page.locator('.t-card[data-id="harden"] h3')).toHaveText("harden");
  await expect(page.locator('.t-card[data-id="harden"]')).toContainText("30,000 RP");

  // a levelled upgrade bought twice: one more evaluation per click a level, the price growing
  await grant(page, 4500);
  await buy(page, "clickx");
  await expect(page.locator('.t-card[data-id="clickx"]')).toContainText("next 2,500 RP");
  await expect(page.locator('.t-card[data-id="clickx"] .t-level')).toHaveText("L1");
  const rp = await game(page, (s) => s.rp);
  await page.click('.t-card[data-id="clickx"] button');
  await expect.poll(() => game(page, (s) => s.levels.clickx)).toBe(2);
  expect(await game(page, (s) => s.rp)).toBeCloseTo(rp - 2500, 6);
  await expect(page.locator('.t-card[data-id="clickx"]')).toContainText("next 3,125 RP");
  await expect(page.locator("#t-evolve")).toBeAttached();

  // Standing: its row appears once Standing is owned, priced in standing
  expect(await page.locator('.t-band[data-row="standing"]').count()).toBe(0);
  await give(page, ["standing"]);
  await expect(page.locator('.t-band[data-row="standing"]')).toBeVisible();
  await expect(page.locator('.t-card[data-id="head1"]')).toContainText("1 standing");
  await expect(page.locator('.t-card[data-id="head1"]')).toHaveAttribute("data-state", "dear");
  await page.evaluate(() => ((window as any).tighter.state.standing.points = 1));
  await expect(page.locator('.t-card[data-id="head1"]')).toHaveAttribute("data-state", "buyable");
  await page.click('.t-card[data-id="head1"] button');
  await expect.poll(() => game(page, (s) => [s.owned.includes("head1"), s.standing.points])).toEqual([true, 0]);

  // at phone width: no sideways scroll, and still clean for assistive technology with a node's details open
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.t-node[data-state="mystery"] button').first().click();
  await expect(page.locator("#t-tree-detail")).toContainText("Needs");
  await page.waitForTimeout(300);
  expect(await noOverflow(page)).toBe(true);
  await shop.screenshot({ path: test.info().outputPath("shop-390.png") });
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("long game: auto-eval comes right after 2 evaluations per click, for 100 RP", async ({ page }) => {
  test.setTimeout(90_000);
  await fresh(page, 22);
  await firstRecord(page);
  await expect(page.locator("#t-auto")).toBeHidden();
  await grant(page, 5);
  await buy(page, "trace");
  await grant(page, 150);
  await buy(page, "click2");
  // the next card along is Auto-eval at 100 RP, before 3 evaluations per click (320)
  const card = page.locator('.t-card[data-id="auto1"]');
  await expect(card).toContainText("100 RP");
  await expect(card).toHaveAttribute("data-state", "dear");
  await grant(page, 100);
  await buy(page, "auto1");
  await expect(page.locator("#t-auto")).toBeVisible();
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: off");
  await expect(page.locator("#t-lanes")).toBeVisible();
  // it runs live: no bank, and no Away upgrades in the tree
  expect(await page.locator("#t-bar-bank-box, #t-bank-note").count()).toBe(0);
  expect(await page.locator('.t-card[data-id^="away"], .t-node[data-id^="away"]').count()).toBe(0);
  expect(await game(page, (s) => s.rp)).toBeCloseTo(0, 6);
});

test("long game: offers to pick from, best first; filters saved and applied; deals ranked", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 23);
  const first = await focused(page);
  await grant(page, 1);
  // the queue of 3 and the dealer's upgrades, with three deals earned
  await give(page, ["queue3", "rank2", "pick3", "filters"]);
  await page.evaluate(() => ((window as any).tighter.state.dealer.tokens = 3));
  const offers = page.locator("#t-offer-list > li");
  await expect(page.locator("#t-offers")).toBeVisible({ timeout: 30_000 });
  await expect(offers).toHaveCount(3, { timeout: 30_000 });
  await expect(offers.first()).toContainText("Best offer");
  // offers are ranked: the stored scores fall from the first to the last
  const scores = await game(page, (s) => s.picks.offers.map((x: { score: number }) => x.score));
  expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  // taking one deals it into the queue and focuses it
  const taken = await game(page, (s) => `${s.picks.offers[1].N}/${s.picks.offers[1].M}/${s.picks.offers[1].P}`);
  await offers.nth(1).locator("button").click();
  await expect.poll(() => game(page, (s) => s.queue.map((p: { key: string }) => p.key))).toEqual([first.key, taken]);
  await expect.poll(() => game(page, (s) => s.focus)).toBe(taken);
  await expect.poll(() => logText(page)).toContain("Dealt:");
  expect(await game(page, (s) => Object.keys(s.picks.dealt))).toContain(taken);

  // filters: only 100 to 150 pieces; offers outside go, and the new ones fit
  await page.locator("#t-filters summary").click();
  await page.fill("#t-f-minp", "100");
  await page.fill("#t-f-maxp", "150");
  await page.locator('#t-filter-form button[type="submit"]').click();
  await expect(page.locator("#t-filter-note")).toContainText("Filters saved");
  expect(await game(page, (s) => s.picks.filters)).toMatchObject({ minP: 100, maxP: 150 });
  await expect(offers).toHaveCount(3, { timeout: 30_000 });
  const ps = await game(page, (s) => s.picks.offers.map((x: { P: number }) => x.P));
  for (const P of ps) expect(P >= 100 && P <= 150).toBe(true);
  // a bad range is refused with a reason, and the saved filters stay
  await page.fill("#t-f-minp", "200");
  await page.locator('#t-filter-form button[type="submit"]').click();
  await expect(page.locator("#t-filter-note")).toContainText("a range from 1 to 500");
  expect(await game(page, (s) => s.picks.filters)).toMatchObject({ minP: 100, maxP: 150 });
  // the filters and offers survive a reload
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(offers).toHaveCount(3, { timeout: 30_000 });
  expect(await game(page, (s) => s.picks.filters)).toMatchObject({ minP: 100, maxP: 150 });
  await page.setViewportSize({ width: 390, height: 844 });
  await dockView(page, "queue");
  await page.waitForTimeout(300);
  expect(await noOverflow(page)).toBe(true);
  await page.locator("#t-queue").screenshot({ path: test.info().outputPath("queue-390.png") });
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("long game: Auto picks each run's method; a pipeline moves to its next method when a run ends", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 24);
  await firstRecord(page);
  // method match: an Auto option in the method select, and the Runs panel says what it learned
  await give(page, [...CLICK_LADDER, "auto1", "auto2", "auto3", "auto4", "basin", "shrink", "learning", "methodMatch"]);
  const select = page.locator("#t-method");
  await expect(select.locator('option[value="auto"]')).toHaveText("Auto (method match)");
  await select.selectOption("auto");
  await expect.poll(() => game(page, (s) => s.runplan.auto)).toBe(true);
  await expect(page.locator("#t-runs")).toBeVisible();
  await expect(page.locator("#t-runs")).toContainText("Auto is on");
  await click(page);
  const method = await page.locator("#t-runinfo").textContent();
  expect(method).toMatch(/^(mc_compress|basin_hopping|shrink_repair) /);
  // back to a chosen method
  await select.selectOption("mc_compress");
  await expect.poll(() => game(page, (s) => s.runplan.auto)).toBe(false);

  // a pipeline of two stages: lattice starts (a run of about 45 evaluations), then mc_compress
  await give(page, ["lattice", "seeds", "seeds2", "seeds4", "standing", "pipeline"]);
  await expect(page.locator("#t-runs h3").first()).toHaveText("Pipeline");
  const add = async (m: string) => {
    await page.selectOption("#t-pipeline-method", m);
    await page.getByRole("button", { name: "Add the chosen method as the pipeline's last stage" }).click();
  };
  await add("seed");
  await add("mc_compress");
  await expect.poll(() => game(page, (s) => s.runplan.pipeline)).toEqual(["seed", "mc_compress"]);
  await expect(page.locator(".t-pipeline li")).toHaveCount(2);
  const ended0 = (await focused(page)).endedRuns;
  await click(page);
  await expect(page.locator("#t-runinfo")).toContainText("seed ");
  for (let i = 0; i < 30 && (await focused(page)).endedRuns === ended0; i++) await click(page);
  expect((await focused(page)).endedRuns).toBe(ended0 + 1);
  await expect.poll(() => logText(page)).toContain("stopped improving");
  await expect(page.locator("#t-notice")).toContainText("stopped improving");
  await click(page);
  await expect(page.locator("#t-runinfo")).toContainText("mc_compress ");
  // a stage can be moved and removed
  await page.getByRole("button", { name: "Move stage 2, mc_compress, up" }).click();
  await expect.poll(() => game(page, (s) => s.runplan.pipeline)).toEqual(["mc_compress", "seed"]);
  await page.getByRole("button", { name: "Remove stage 2, seed" }).click();
  await expect.poll(() => game(page, (s) => s.runplan.pipeline)).toEqual(["mc_compress"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await dockView(page, "queue");
  await page.waitForTimeout(300);
  expect(await noOverflow(page)).toBe(true);
  await page.locator("#t-runs").screenshot({ path: test.info().outputPath("runs-390.png") });
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("long game: records counted, rent paid on a check, a reset under a rule that holds through a reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 25);
  await firstRecord(page);
  await consent(page, "E2E Long");
  await expect.poll(async () => (await focused(page)).ourId, { timeout: 20_000 }).not.toBeNull();
  const p = await focused(page);
  // a confirmed record is remembered for collections, with its tier
  await expect.poll(() => game(page, (s) => s.economy.recorded)).toContain(p.key);
  await give(page, ["rent", "collections"]);
  await expect(page.locator("#t-records")).toBeVisible();
  await expect(page.locator("#t-rc-sets")).toContainText("First records by tier: open");
  await expect(page.locator("#t-rc-stats")).toContainText("+5 % on all points");

  // rent: the record's rent starts, and an hour later a check that finds it still ours pays it
  await expect.poll(() => game(page, (s) => s.economy.checks?.[s.focus] !== undefined), { timeout: 15_000 }).toBe(true);
  const rate = await game(page, (s) => s.economy.base[s.focus]);
  expect(rate).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).tighter.skipAhead(3_600_000));
  await expect.poll(() => game(page, (s) => s.economy.rentPaid), { timeout: 20_000 }).toBeGreaterThan(0);
  const paid = await game(page, (s) => s.economy.rentPaid);
  // 1 % of what the record earned, an hour, times the collections bonus (+5 %)
  expect(paid).toBeCloseTo(0.01 * rate * 1.05, 3);
  await expect(page.locator("#t-rc-note")).toContainText("The last check paid +");

  // a reset for standing, the next cycle under One method, with Head start I
  await give(page, ["standing", "rules", "head1"]);
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.standing.cycleEarned = 300_000;
    s.rp += 300_000;
    s.rpEarned += 300_000;
  });
  await expect(page.locator("#t-standing")).toBeVisible();
  await expect(page.locator("#t-st-preview")).toContainText("Reset now for 1 standing");
  await page.selectOption("#t-st-rule", "method");
  await expect(page.locator("#t-st-rule-note")).toContainText("One method");
  await page.click("#t-st-reset");
  await expect(page.locator("#t-st-confirm")).toBeVisible();
  await expect(page.locator("#t-st-confirm-text")).toContainText("You keep the 1 record you hold and its rent");
  await page.click("#t-st-yes");
  await expect.poll(() => game(page, (s) => s.standing.resets)).toBe(1);
  const after = await game(page, (s) => ({
    rp: s.rp,
    owned: s.owned,
    standing: s.standing,
    recorded: s.economy.recorded,
    ourId: s.queue.find((q: { key: string }) => q.key === s.focus)?.ourId,
  }));
  expect(after.rp).toBe(0);
  expect(after.standing).toMatchObject({ points: 1, total: 1, rule: "method", cycleEarned: 0 });
  // kept: Standing and its row, rent and collections; granted: Head start I's upgrades
  expect(after.owned).toEqual(
    expect.arrayContaining(["standing", "rules", "head1", "rent", "collections", "trace", "click5", "auto1"]),
  );
  expect(after.owned).not.toContain("click6");
  expect(after.recorded).toContain(p.key);
  expect(after.ourId).toBe(p.ourId);
  await expect(page.locator("#t-bar-standing")).toHaveText("1 · ×1.1");
  await expect(page.locator("#t-evolve")).toHaveText("Evolve ×5");
  // the rule holds: with Basin hopping owned, the select still offers only mc_compress
  await give(page, ["basin"]);
  await expect(page.locator('#t-method option[value="basin_hopping"]')).toBeDisabled();
  await click(page);
  await expect(page.locator("#t-runinfo")).toContainText("mc_compress ");

  // all of it survives a reload
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator("#t-standing")).toBeVisible();
  expect(await game(page, (s) => [s.standing.rule, s.standing.resets, s.standing.points])).toEqual(["method", 1, 1]);
  await expect(page.locator('#t-method option[value="basin_hopping"]')).toBeDisabled();
  await expect(page.locator("#t-st-history-box")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await dockView(page, "points");
  await page.waitForTimeout(300);
  expect(await noOverflow(page)).toBe(true);
  await page.locator("#t-standing").screenshot({ path: test.info().outputPath("standing-390.png") });
  await page.locator("#t-records").screenshot({ path: test.info().outputPath("records-390.png") });
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("long game: a save from the per-click build (no new fields) loads and plays", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 26);
  await firstRecord(page);
  await consent(page, "E2E Old Save");
  await expect.poll(async () => (await focused(page)).ourId, { timeout: 20_000 }).not.toBeNull();
  const p = await focused(page);
  await page.waitForTimeout(1500);
  // the save as the live per-click build writes it: version 2, none of the long game's fields, its own
  // upgrades, auto-eval on, an hour away and its bank
  const old = await page.evaluate(() => {
    const save = JSON.parse(localStorage.getItem("tighter.save")!);
    for (const k of ["levels", "standing", "economy", "picks", "runplan"]) delete save[k];
    save.owned = ["trace", "click2", "click3", "click4", "auto1", "seeds"];
    save.settings.auto = true;
    save.bank = 700;
    save.bankAt = Date.now() - 3_600_000;
    save.rp = 123.5;
    return JSON.stringify(save);
  });
  // leaving saves the page's own state (pagehide): the old save goes in before the game's script next runs
  await page.goto("about:blank");
  await page.addInitScript((text) => {
    if (!sessionStorage.getItem("old-save-put")) {
      localStorage.setItem("tighter.save", text);
      sessionStorage.setItem("old-save-put", "1");
    }
  }, old);
  await page.goto("/tighter.html");
  await expect(page.locator("#t-evolve")).toHaveText("Evolve ×4", { timeout: 30_000 });
  const s = await game(page, (st) => ({
    version: st.version,
    rp: st.rp,
    owned: st.owned,
    levels: st.levels,
    standing: st.standing,
    recorded: st.economy.recorded,
    picks: st.picks.offers.length,
    pipeline: st.runplan.pipeline,
    autoDue: st.autoDue,
    auto: st.settings.auto,
  }));
  expect(s).toMatchObject({ version: 2, rp: 123.5, levels: {}, picks: 0, pipeline: [] });
  expect(s.standing).toMatchObject({ points: 0, total: 0, resets: 0 });
  expect(s.owned).toEqual(["trace", "click2", "click3", "click4", "auto1", "seeds"]);
  // the record it held is counted for collections; auto-eval is off and owes nothing for the hour away
  expect(s.recorded).toContain(p.key);
  expect(s).toMatchObject({ autoDue: 0, auto: false });
  await expect(page.locator("#status")).not.toContainText("While you were away");
  await expect(page.locator("#t-auto")).toBeVisible();
  await openTree(page);
  await expect(page.locator("#t-upgrades")).toBeVisible();
  await expect(page.locator('.t-band[data-row="clicks"]')).toBeVisible();
  expect(await page.locator('.t-band[data-row="standing"]').count()).toBe(0);
  await expect(page.locator("#t-standing")).toBeHidden();
  const e0 = (await stats(page)).evaluations;
  await click(page);
  // after a reload the click opens a run with the next seed: its start's scoring, then 4 evaluations
  expect((await stats(page)).evaluations).toBe(e0 + 5);
  expect(errors).toEqual([]);
});

test("long game: Auto-advance's tolerance and patience; a problem that stops making progress is replaced once a deal is earned", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 27);
  await firstRecord(page);
  await consent(page, "E2E Advance");
  const first = await focused(page);
  // the board counts the problem's evaluations, and those since its last progress
  const count = /^[\d,]+ evaluations? · [\d,]+ since progress$/;
  await expect(page.locator("#t-problem-count")).toHaveText(count);
  // three slots filled, each with a first record
  await give(page, ["queue3", "auto1", "advance"]);
  await page.evaluate(() => ((window as any).tighter.state.dealer.tokens = 3));
  await expect.poll(() => game(page, (s) => s.queue.length), { timeout: 60_000 }).toBe(3);
  const keys = await game(page, (s) => s.queue.map((p: { key: string }) => p.key));
  for (const key of keys.filter((k: string) => k !== first.key)) {
    await page.evaluate((k) => ((window as any).tighter.state.focus = k), key);
    await firstRecord(page);
  }
  // every row of the queue counts too, in place
  const rows = page.locator("#t-queue-list .t-q-count");
  await expect(rows).toHaveCount(3);
  for (const t of await rows.allTextContents()) expect(t).toMatch(count);

  // the settings, once Auto-advance is owned: labelled, the defaults chosen
  await expect(page.locator("#t-advance")).toBeVisible();
  await expect(page.getByLabel("Tolerance", { exact: true })).toHaveValue("1e-6");
  await expect(page.getByLabel("Patience", { exact: true })).toHaveValue("1000");
  await page.getByLabel("Tolerance", { exact: true }).selectOption("1e-3");
  await page.getByLabel("Patience", { exact: true }).selectOption("250");
  expect(await game(page, (s) => [s.settings.tolerance, s.settings.patience])).toEqual([1e-3, 250]);
  await expect(page.locator("#t-advance-note")).toContainText("at least 0.1 % smaller");
  await expect(page.locator("#t-advance-note")).toContainText("After 250 evaluations without progress");
  expect(await axe(page)).toEqual([]);

  // the first problem stops making progress while no deal is earned: it stays, and the queue says why
  await page.evaluate((key) => {
    const s = (window as any).tighter.state;
    s.dealer.tokens = 0;
    s.dealer.evalsAt = s.stats.evaluations;
    s.queue.find((p: { key: string }) => p.key === key).sinceGain = 5000;
  }, first.key);
  await page.click("#t-auto");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: on");
  await expect(page.locator("#t-deal")).toContainText("has run 5,000 evaluations without progress");
  await page.waitForTimeout(2000);
  expect(await game(page, (s) => s.queue.filter((p: { leaving: boolean }) => !p.leaving).length)).toBe(3);
  // a deal earned: a new problem is dealt, and the stalled one leaves as if dropped
  await page.evaluate(() => ((window as any).tighter.state.dealer.tokens = 1));
  await expect
    .poll(() => game(page, (s) => s.queue.filter((p: { leaving: boolean }) => !p.leaving).map((p: any) => p.key)), {
      timeout: 60_000,
    })
    .not.toContain(first.key);
  expect(await game(page, (s) => s.queue.filter((p: { leaving: boolean }) => !p.leaving).length)).toBe(3);
  await expect
    .poll(() => logText(page))
    .toMatch(
      /Auto-advance (dropped|is dropping) .* after 5,0\d\d evaluations without progress, and .* takes its slot\./,
    );
  // it is never dealt straight back
  await expect
    .poll(() => game(page, (s) => s.past.map((p: { key: string }) => p.key)), { timeout: 60_000 })
    .toContain(first.key);

  // Never: nothing leaves, however long it goes without progress
  await page.getByLabel("Patience", { exact: true }).selectOption("never");
  const second = keys.find((k: string) => k !== first.key)!;
  await page.evaluate((key) => {
    const s = (window as any).tighter.state;
    s.dealer.tokens = 3;
    s.queue.find((p: { key: string }) => p.key === key).sinceGain = 50_000;
  }, second);
  await expect(page.locator("#t-advance-note")).toContainText("Auto-advance keeps every problem in the queue");
  await page.waitForTimeout(3000);
  expect(await game(page, (s) => s.queue.map((p: { key: string }) => p.key))).toContain(second);
  await expect(page.locator("#t-deal")).not.toContainText("without progress");
  await page.click("#t-auto");
  await page.setViewportSize({ width: 390, height: 844 });
  await dockView(page, "queue");
  await page.waitForTimeout(300);
  expect(await noOverflow(page)).toBe(true);
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("long game: with Your pick and two lanes, Auto-advance compacts every new problem and replaces stalled ones", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 31);
  await firstRecord(page);
  await consent(page, "E2E Lanes");
  await give(page, [...CLICK_LADDER, "queue3", "queue4", "queue6", "rank2", "pick3", "advance", "auto1", "lanes2"]);
  await page.evaluate(() => ((window as any).tighter.state.dealer.tokens = 6));
  // five offers taken by hand: a full queue of six, five of them never compacted
  const offers = page.locator("#t-offer-list > li");
  for (let i = 0; i < 5; i++) {
    const n = await game(page, (s) => s.queue.length);
    await expect(offers.first()).toBeVisible({ timeout: 30_000 });
    await offers.first().locator("button").click();
    await expect.poll(() => game(page, (s) => s.queue.length), { timeout: 30_000 }).toBe(n + 1);
  }
  // a problem past its patience with auto-eval off waits, and the queue says what it waits for
  await page.evaluate(() => ((window as any).tighter.state.queue[0].sinceGain = 1500));
  await expect(page.locator("#t-deal")).toContainText("Auto-advance replaces it once you switch auto-eval on");
  await page.evaluate(() => ((window as any).tighter.state.queue[0].sinceGain = 0));
  // auto-eval at 15 evaluations a second in each lane: every new problem gets its Compact, although a
  // lane with a problem to work takes each job as it comes due (a Compact owes the rest)
  await page.evaluate(() => (window as any).tighter.state.owned.push("auto2", "auto3", "auto4", "auto5"));
  await page.click("#t-auto");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: on");
  await expect
    .poll(() => game(page, (s) => s.queue.filter((p: { phase: string }) => p.phase !== "ready").length), {
      timeout: 90_000,
    })
    .toBe(0);
  // two stall: both are replaced as deals are earned, and the queue stays full
  const stalled = await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.dealer.tokens = 2;
    return s.queue.slice(0, 2).map((p: { key: string; sinceGain: number }) => ((p.sinceGain = 1500), p.key));
  });
  await expect
    .poll(() => game(page, (s) => s.past.map((p: { key: string }) => p.key)), { timeout: 90_000 })
    .toEqual(expect.arrayContaining(stalled));
  expect(await game(page, (s) => s.queue.filter((p: { leaving: boolean }) => !p.leaving).length)).toBe(6);
  expect(await logText(page)).toMatch(
    /Auto-advance (dropped|is dropping) .* without progress, and .* takes its slot\./,
  );
  await page.click("#t-auto");
  expect(errors).toEqual([]);
});
