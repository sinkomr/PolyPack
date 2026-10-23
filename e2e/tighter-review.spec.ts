import { mkdirSync, writeFileSync } from "node:fs";
import { Page, expect, test } from "@playwright/test";

// Independent review of Tighter (2026-10-19, adapted to open runs and points per click 2026-10-20),
// against the local stack only (playwright.config.ts: in-memory server on 8788 behind Vite on 5174).
// Tests named "owner rule" assert the site owner's rules from the review brief; a failure there is a
// finding. Screenshots go to tighter-review-shots/.

const SHOTS = "tighter-review-shots";
mkdirSync(SHOTS, { recursive: true });

interface Req {
  t: number;
  method: string;
  path: string;
}

/** Every request that left the local stack, in any test: must stay empty. */
const offStack: string[] = [];
test.afterEach(() => expect(offStack).toEqual([]));

function recorder(page: Page): Req[] {
  const log: Req[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.host !== "localhost:5174" && u.protocol.startsWith("http")) offStack.push(r.url());
    if (u.pathname.startsWith("/api/")) log.push({ t: Date.now(), method: r.method(), path: u.pathname + u.search });
  });
  return log;
}

const state = (page: Page) => page.evaluate(() => structuredClone((window as any).tighter.state));
const focus = async (page: Page) => {
  const s = await state(page);
  return s.queue.find((p: { key: string }) => p.key === s.focus);
};
const idle = (page: Page) => page.evaluate(() => !(window as any).tighter.busy);
const posts = (log: Req[]) => log.filter((r) => r.method === "POST" && r.path === "/api/submit");
const siteBest = async (page: Page, k: { N: number; M: number; P: number }) =>
  (await (await page.request.get(`/api/problems/${k.N}/${k.M}/${k.P}`)).json()).site_best;

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
    .poll(async () => (await focus(page)).phase === "ready" && (await idle(page)), { timeout: 120_000 })
    .toBe(true);
}

/** The name form: in the first record's pop-up while it is up, else in Settings (closed again after). */
async function consent(page: Page, name: string, agree = true): Promise<void> {
  if (!(await page.locator("#t-name").isVisible())) await page.click("#t-open-settings");
  await page.fill("#t-name", name);
  await page.setChecked("#t-agree", agree);
  await page.click("#t-consent-save");
  if (await page.locator("#t-settings").evaluate((d) => (d as HTMLDialogElement).open))
    await page.click("#t-settings-close");
}

/** One Evolve click, waited until it has run; returns its time in ms. */
async function click(page: Page): Promise<number> {
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 120_000 });
  const clicks = (await state(page)).stats.clicks;
  const t = Date.now();
  await page.click("#t-evolve");
  await expect
    .poll(async () => (await state(page)).stats.clicks > clicks && (await idle(page)), { timeout: 120_000 })
    .toBe(true);
  return Date.now() - t;
}

async function clickUntilBetter(page: Page, than: number, tries = 200): Promise<void> {
  for (let i = 0; i < tries && (await focus(page)).best >= than * (1 - 2e-9); i++) await click(page);
  expect((await focus(page)).best).toBeLessThan(than * (1 - 2e-9));
}

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
    await expect.poll(async () => (await state(page)).owned.includes(id)).toBe(true);
  }
  await openBoard(page);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("owner rule: nothing is POSTed after consent is withdrawn while the leader check is in flight", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const log = recorder(page);
  await fresh(page, 21);
  await firstRecord(page);
  const p = await focus(page);
  // the leader check before the POST is slow (a slow network or a busy server)
  await page.route(`**/api/problems/${p.N}/${p.M}/${p.P}`, async (route) => {
    await sleep(3000);
    await route.continue();
  });
  await consent(page, "Withdrawn Player");
  await sleep(800);
  // the player changes their mind while that GET is under way
  await consent(page, "Withdrawn Player", false);
  expect((await state(page)).consent).toBe(false);
  await sleep(6000);
  expect(posts(log)).toEqual([]);
  expect(await siteBest(page, p)).toBeNull();
});

test("owner rule: a problem's best is POSTed at most once a minute, also when it leaves (Next problem)", async ({
  page,
}) => {
  test.setTimeout(400_000);
  const log = recorder(page);
  await fresh(page, 22);
  await firstRecord(page);
  const p = await focus(page);
  await consent(page, "Leaving Player");
  await expect.poll(async () => (await siteBest(page, p))?.name, { timeout: 20_000 }).toBe("Leaving Player");
  const first = await siteBest(page, p);
  await clickUntilBetter(page, first.score);
  // the next problem is earned by work (300 clicks, whatever their size), not yet
  await expect(page.locator("#t-next")).toBeDisabled();
  await expect(page.locator("#t-next")).toHaveText(/^Next problem after [\d,]+ clicks$/);
  // once the next problem is earned (a deal given here), the problem can be left at once
  await page.evaluate(() => ((window as any).tighter.state.dealer.tokens = 1));
  await expect(page.locator("#t-next")).toBeEnabled({ timeout: 5_000 });
  await expect(page.locator("#t-next")).toHaveText("Next problem");
  await page.click("#t-next");
  // the next problem is dealt at once
  await expect.poll(async () => (await state(page)).queue.some((q: any) => !q.leaving), { timeout: 20_000 }).toBe(true);
  await sleep(5000);
  const mine = posts(log);
  const gaps = mine.slice(1).map((r, i) => r.t - mine[i].t);
  console.log(`POSTs for ${p.key}: ${mine.length}, gaps ms ${JSON.stringify(gaps)}`);
  expect(gaps.every((g) => g >= 60_000)).toBe(true);
});

test("owner rule: a refused first record (name the server strips to nothing) is not re-POSTed within the minute", async ({
  page,
}) => {
  test.setTimeout(400_000);
  const log = recorder(page);
  await fresh(page, 23);
  await firstRecord(page);
  const p = await focus(page);
  // the page cleans names as the server does, so "<>" (empty once cleaned) is refused at the form
  await consent(page, "<>");
  await expect(page.locator("#status")).toContainText("empty once cleaned");
  expect((await state(page)).consent).toBe(false);
  await sleep(3000);
  expect(posts(log)).toEqual([]);
  // a refusal still paces the problem: here the server's 400 for an empty name, made up by the test
  await page.route("**/api/submit", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ valid: false, reasons: ["name is required"], score: null, leader: false }),
    }),
  );
  await consent(page, "Refused Player");
  await expect.poll(() => posts(log).length, { timeout: 20_000 }).toBe(1);
  await expect.poll(() => logText(page), { timeout: 15_000 }).toContain("name is required");
  // the refused send's points are taken back
  await expect.poll(() => logText(page), { timeout: 15_000 }).toContain("taken back");
  const best0 = (await focus(page)).best;
  await clickUntilBetter(page, best0);
  const b1 = (await focus(page)).best;
  await clickUntilBetter(page, b1);
  await sleep(3000);
  const mine = posts(log);
  console.log(
    `refused-name POSTs for ${p.key} within ${((Date.now() - mine[0].t) / 1000).toFixed(0)} s: ${mine.length}`,
  );
  await page.screenshot({ path: `${SHOTS}/r1-refused-name.png`, fullPage: true });
  const firstMinute = mine.filter((r) => r.t - mine[0].t < 60_000);
  expect(firstMinute.length).toBe(1);
});

test("owner rule: points the server does not confirm are taken back", async ({ page }) => {
  test.setTimeout(240_000);
  const log = recorder(page);
  await fresh(page, 29);
  await firstRecord(page);
  const p = await focus(page);
  // another entry got there first: valid, but not the leader, and better than the board
  await page.route("**/api/submit", async (route) => {
    const best = (await focus(page)).best;
    await sleep(1500);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ valid: true, score: best, leader: false, leader_score: best * 0.9, reasons: [] }),
    });
  });
  await consent(page, "Behind Player");
  // consent paid the record at once
  expect((await state(page)).rp).toBeGreaterThan(5);
  await expect.poll(() => posts(log).length, { timeout: 20_000 }).toBe(1);
  await expect.poll(() => logText(page), { timeout: 15_000 }).toContain("Another entry got there first");
  await expect.poll(() => logText(page), { timeout: 15_000 }).toContain("taken back");
  const s = await state(page);
  const q = s.queue.find((x: any) => x.key === p.key);
  expect(s.rp).toBeLessThan(1e-6);
  expect(q.unconfirmed).toBe(0);
  expect(q.sending).toBeNull();
  expect(q.ourId).toBeNull();
  // the board no longer beats the record to beat: clicks pay nothing until it does
  const rp0 = s.rp;
  for (let i = 0; i < 5; i++) await click(page);
  expect((await state(page)).rp).toBe(rp0);
});

test("an accepted first record whose answer is lost to a reload: no second POST, and it is counted", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const log = recorder(page);
  await fresh(page, 24);
  await firstRecord(page);
  const p = await focus(page);
  let reached!: () => void;
  const atServer = new Promise<void>((r) => (reached = r));
  await page.route("**/api/submit", async (route) => {
    const response = await route.fetch();
    reached();
    await sleep(4000);
    await route.fulfill({ response }).catch(() => {});
  });
  await consent(page, "Reload Player");
  await atServer;
  const paid = (await state(page)).rp;
  await page.reload();
  await page.unroute("**/api/submit");
  await expect(page.locator("#t-evolve")).toBeVisible({ timeout: 30_000 });
  await sleep(6000);
  const server = await siteBest(page, p);
  const after = await focus(page);
  const s = await state(page);
  console.log(
    `lost answer: server leader ${server?.name} id ${server?.id}; game verified ${after.verified} ourId ${after.ourId} ` +
      `held ${await page.locator("#t-bar-held").textContent()} rp ${s.rp} POSTs ${posts(log).length}`,
  );
  await page.screenshot({ path: `${SHOTS}/r2-lost-answer-after-reload.png`, fullPage: true });
  expect(server?.name).toBe("Reload Player");
  expect(posts(log)).toHaveLength(1);
  // the game knows it holds this record, and the points it paid before the send are confirmed, once
  await expect(page.locator("#t-bar-held")).toHaveText("1");
  expect(after.ourId).toBe(server.id);
  expect(after.sending).toBeNull();
  expect(after.unconfirmed).toBe(0);
  expect(s.rp).toBeCloseTo(paid, 9);
  await expect.poll(() => logText(page), { timeout: 15_000 }).toContain("its answer had not arrived");
});

test("server errors do not cause retry storms: 429, 500, network failure, failed leader check, 409, 422", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const log = recorder(page);
  await fresh(page, 25);
  await firstRecord(page);
  const p = await focus(page);
  const counts: Record<string, number> = {};
  const answer = async (status: number | "abort") => {
    await page.unroute("**/api/submit");
    await page.route("**/api/submit", (route) =>
      status === "abort"
        ? route.abort()
        : route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify({ valid: false, reasons: [`test ${status}`], score: null, leader: false }),
          }),
    );
  };
  // `from`: where the window's requests start in the log (by default, now)
  const measure = async (label: string, ms: number, from = log.length) => {
    const n0 = from;
    await sleep(ms);
    const w = log.slice(n0);
    counts[label] = w.filter((r) => r.method === "POST").length;
    counts[`${label} GET`] = w.filter((r) => r.method === "GET" && r.path.startsWith("/api/problems/")).length;
    const g = await state(page);
    console.log(
      `${label}: ${JSON.stringify(w.map((r) => `${r.method} ${r.path}`))} pacer ${JSON.stringify(g.pacer)} ` +
        `log ${JSON.stringify(g.log.slice(-2).map((l: any) => l.text))}`,
    );
  };
  await answer(429);
  // the first send goes as soon as there is consent, often before consent() returns: count from before
  const beforeConsent = log.length;
  await consent(page, "Error Player");
  await measure("429 first 10 s", 10_000, beforeConsent);
  // trouble with sending is told on the notice line, with when sending tries again
  await expect(page.locator("#t-notice")).toContainText("too many submissions came from your address");
  await page.evaluate(() => (window as any).tighter.skipAhead(61_000));
  await measure("429 after a game minute, 10 s", 10_000);
  await answer(500);
  await page.evaluate(() => (window as any).tighter.skipAhead(61_000));
  await measure("500, 10 s", 10_000);
  await expect(page.locator("#t-notice")).toContainText("The server answered with an error (500)");
  await answer("abort");
  await page.evaluate(() => (window as any).tighter.skipAhead(31_000));
  await measure("network error, 10 s", 10_000);
  await page.unroute("**/api/submit");
  await page.route(`**/api/problems/${p.N}/${p.M}/${p.P}`, (route) => route.abort());
  await page.evaluate(() => (window as any).tighter.skipAhead(31_000));
  await measure("leader GET fails, 10 s", 10_000);
  await expect(page.locator("#t-notice")).toContainText("The server cannot be reached. Sending will try again");
  await page.unroute(`**/api/problems/${p.N}/${p.M}/${p.P}`);
  await answer(422);
  await page.evaluate(() => (window as any).tighter.skipAhead(31_000));
  await measure("422, 10 s", 10_000);
  console.log(`error handling: ${JSON.stringify(counts)}`);
  expect(counts["429 first 10 s"]).toBe(1);
  expect(counts["429 after a game minute, 10 s"]).toBe(1);
  expect(counts["500, 10 s"]).toBeLessThanOrEqual(1);
  expect(counts["network error, 10 s"]).toBeLessThanOrEqual(1);
  expect(counts["leader GET fails, 10 s"]).toBeLessThanOrEqual(0);
  expect(counts["leader GET fails, 10 s GET"]).toBeLessThanOrEqual(1);
  expect(counts["422, 10 s"]).toBeLessThanOrEqual(1);
  // a 409 takes the problem out of the queue (a new best first: the refused board is never resent)
  await page.unroute("**/api/submit");
  await page.route("**/api/submit", (route) => route.abort());
  await clickUntilBetter(page, (await focus(page)).best);
  await answer(409);
  await page.evaluate(() => (window as any).tighter.skipAhead(61_000));
  const before409 = posts(log).length;
  await expect
    .poll(async () => (await state(page)).queue.some((q: any) => q.key === p.key), { timeout: 20_000 })
    .toBe(false);
  expect(posts(log).length - before409).toBeLessThanOrEqual(1);
});

// One tab runs the game at a time, so tab B stands by instead of playing; the owner's rules (one POST
// per problem a minute, no save overwritten) are asserted on that design.
test("two tabs sharing one save: the second stands by, sends and saves nothing, and can take over", async ({
  context,
}) => {
  test.setTimeout(600_000);
  const a = await context.newPage();
  const logA = recorder(a);
  await fresh(a, 26);
  await firstRecord(a);
  const p = await focus(a);
  await consent(a, "Two Tabs");
  await expect.poll(async () => (await siteBest(a, p))?.name, { timeout: 20_000 }).toBe("Two Tabs");
  const first = await siteBest(a, p);
  await sleep(1000);
  const b = await context.newPage();
  const logB = recorder(b);
  // count B's writes to storage from its first script on
  await b.addInitScript(() => {
    const w = window as any;
    w.__writes = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      w.__writes++;
      return setItem.call(this, k, v);
    };
  });
  await b.goto("/tighter.html");
  await expect(b.locator("#t-elsewhere")).toBeVisible({ timeout: 10_000 });
  await expect(b.locator("#t-elsewhere-text")).toContainText("open in another tab");
  await expect(b.locator("#t-evolve")).toBeHidden();
  // tab A plays on and sends its next improvement after the problem's minute; B does nothing
  await clickUntilBetter(a, first.score);
  await a.evaluate(() => (window as any).tighter.skipAhead(61_000));
  await expect.poll(() => posts(logA).length, { timeout: 15_000 }).toBe(2);
  await b.evaluate(() => (window as any).tighter.skipAhead(61_000));
  await sleep(4000);
  expect(posts(logB)).toEqual([]);
  expect(logB.filter((r) => r.path.startsWith("/api/problems/"))).toEqual([]);
  expect(await b.evaluate(() => (window as any).__writes)).toBe(0);
  await a.screenshot({ path: `${SHOTS}/r3-two-tabs-A.png`, fullPage: true });
  await b.screenshot({ path: `${SHOTS}/r3-two-tabs-B.png`, fullPage: true });
  const all = posts(logA);
  const late = all.slice(1);
  expect(late.filter((r) => r.t - late[0].t < 60_000).length).toBeLessThanOrEqual(1);

  // B takes over: A stops and stands by, B carries on from A's save with A's points
  await sleep(1500);
  const rpA = (await state(a)).rp;
  await b.click("#t-take-over");
  await expect(b.locator("#t-evolve")).toBeVisible({ timeout: 30_000 });
  await expect(a.locator("#t-elsewhere")).toBeVisible({ timeout: 10_000 });
  await expect(a.locator("#t-elsewhere-text")).toContainText("another tab");
  expect((await state(b)).rp).toBeCloseTo(rpA, 9);
  const postsA = posts(logA).length;
  await click(b);
  await a.evaluate(() => (window as any).tighter.skipAhead(120_000));
  await sleep(3000);
  expect(posts(logA).length).toBe(postsA);
  await sleep(1500);
  const saved = await b.evaluate(() => JSON.parse(localStorage.getItem("tighter.save")!).rp);
  expect(saved).toBeGreaterThanOrEqual(rpA - 1e-9);
});

// Clicks are the player's own and always run. Auto-eval runs nothing while the tab is hidden or the
// device is on battery power (unless allowed), and owes nothing for that time: it runs live.
test("hidden tab and battery: auto-eval pauses and owes nothing, clicks always run", async ({ page }) => {
  test.setTimeout(400_000);
  await page.addInitScript(() => {
    const battery = Object.assign(new EventTarget(), { charging: false, level: 0.5 });
    (navigator as any).getBattery = () => Promise.resolve(battery);
  });
  await fresh(page, 27);
  // the battery setting is in Settings
  await page.click("#t-open-settings");
  await expect(page.locator("#t-battery-box")).toBeVisible();
  await page.click("#t-settings-close");
  // the first click's Compact and the clicks after it, on battery power: they run
  await firstRecord(page);
  expect((await state(page)).stats.evaluations).toBe(101);
  await click(page);
  expect((await state(page)).stats.evaluations).toBe(102);
  await expect(page.locator("#t-hold")).toHaveText("");

  await grant(page, 6000);
  await buyAll(page, ["trace", "click2", "click3", "click4", "auto1"]);
  await page.click("#t-auto");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: on");
  await expect(page.locator("#t-hold")).toContainText("battery");
  const due = () => page.evaluate(() => (window as any).tighter.state.autoDue as number);
  const evaluations = async () => (await state(page)).stats.evaluations;
  // on battery, a minute held (an evaluation a second would be 60 evaluations) earns nothing
  const e0 = await evaluations();
  await page.evaluate(() => ((window as any).tighter.state.autoAt -= 60_000));
  await sleep(3000);
  expect(await due()).toBe(0);
  expect(await evaluations()).toBe(e0);
  // a click on battery still runs, 4 evaluations
  await click(page);
  expect(await evaluations()).toBe(e0 + 4);
  const onBattery = await page.locator("#t-hold").textContent();
  // allowing battery use runs it live from then on, an evaluation a second whatever the click size, with
  // nothing owed for the minute held
  const t1 = Date.now();
  await page.click("#t-open-settings");
  await page.check("#t-battery");
  await page.click("#t-settings-close");
  await expect(page.locator("#t-hold")).toHaveText("");
  await expect.poll(evaluations, { timeout: 30_000 }).toBeGreaterThanOrEqual(e0 + 8);
  await expect.poll(() => idle(page)).toBe(true);
  const e1 = await evaluations();
  expect(e1 - (e0 + 4)).toBeLessThanOrEqual((Date.now() - t1) / 1000 + 4);

  // a hidden tab pauses it too
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => idle(page)).toBe(true);
  const e2 = await evaluations();
  await page.evaluate(() => ((window as any).tighter.state.autoAt -= 60_000));
  await sleep(3000);
  expect(await due()).toBe(0);
  expect(await evaluations()).toBe(e2);
  const hidden = await page.locator("#t-hold").textContent();
  await page.screenshot({ path: `${SHOTS}/r4-hidden-paused.png`, fullPage: true });
  const t2 = Date.now();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(6000);
  await expect.poll(() => idle(page)).toBe(true);
  // back: live again, nothing owed for the time hidden
  const after = (await evaluations()) - e2;
  console.log(`battery: "${onBattery}"; hidden: "${hidden}"; ran after: ${after}`);
  expect(after).toBeLessThanOrEqual((Date.now() - t2) / 1000 + 4);
  expect(onBattery).toContain("battery");
  expect(hidden).toContain("hidden");
});

test("names and server text are shown as text, never as HTML", async ({ page }) => {
  test.setTimeout(240_000);
  await fresh(page, 28);
  await firstRecord(page);
  const evil = `<img src=x onerror="window.__xss=1">`;
  await consent(page, evil);
  // the name is shown cleaned as the server stores it (no angle brackets)
  await expect(page.locator("#t-consent-note")).toContainText(`img src=x onerror="window.__xss=1"`);
  await sleep(4000);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(await page.locator("img").count()).toBe(0);
  // a save string carrying markup in its log and name
  const raw = {
    ...(await state(page)),
    name: "<b onmouseover=alert(1)>x</b>",
    log: [{ t: 1, text: "<img src=y onerror=window.__xss=2>" }],
  };
  const str = `tighter:3:j:${Buffer.from(JSON.stringify(raw)).toString("base64url")}`;
  await page.click("#t-open-settings");
  await page.fill("#t-save-text", str);
  page.once("dialog", (d) => d.accept());
  await page.click("#t-import");
  await expect(page.locator("#t-save-note")).toHaveText("Save imported.");
  await sleep(1500);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(await page.locator("#t-notice img, #t-consent b").count()).toBe(0);
});

test("a sustained session: the first click compacts, consent, clicks, upgrades, auto-eval on two lanes, Stop, reload", async ({
  page,
}) => {
  test.setTimeout(900_000);
  const log = recorder(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const phases: { name: string; from: number; to: number }[] = [];
  let phaseStart = Date.now();
  const endPhase = (name: string) => {
    phases.push({ name, from: phaseStart, to: Date.now() });
    phaseStart = Date.now();
  };
  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

  await fresh(page, 31);
  await shot("01-bare-board");
  endPhase("open and deal");
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)", { timeout: 30_000 });
  await shot("02-placed");
  const tc = Date.now();
  await page.click("#t-evolve");
  await expect
    .poll(async () => (await focus(page)).phase === "ready" && (await idle(page)), { timeout: 120_000 })
    .toBe(true);
  const compactMs = Date.now() - tc;
  await shot("03-first-record-consent");
  endPhase("placed and compacted");
  await consent(page, "Review Player");
  const p0 = await focus(page);
  await expect.poll(async () => (await siteBest(page, p0))?.name, { timeout: 20_000 }).toBe("Review Player");
  const clickMs: number[] = [];
  for (let i = 0; i < 60; i++) clickMs.push(await click(page));
  await shot("04-after-60-clicks");
  endPhase("consent and 60 manual clicks");

  // grant points through the page's handle, then buy the path to the second lane through the cards
  await grant(page, 400_000);
  const path = [
    "trace",
    "click2",
    "click3",
    "click4",
    "auto1",
    "click5",
    "auto2",
    "click6",
    "queue3",
    "click7",
    "auto3",
    "click8",
    "click9",
    "click10",
    "auto4",
    "basin",
    "reach2",
    "advance",
    "lanes2",
  ];
  await buyAll(page, path);
  await shot("05-upgrades");
  // fill the 3 slots without earning each deal
  await page.evaluate(() => ((window as any).tighter.state.dealer.tokens = 3));
  await expect.poll(async () => (await state(page)).queue.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
  endPhase("buy upgrades, deal 3");

  const e0 = (await state(page)).stats.evaluations;
  await page.click("#t-auto");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: on");
  // twenty minutes between ticks: auto-eval catches up at most a minute (5 evaluations a second,
  // shared by the two lanes: 300), then runs live, two lanes, Auto-advance compacting the new problems
  const autoStart = Date.now();
  await page.evaluate(() => ((window as any).tighter.state.autoAt -= 20 * 60_000));
  let twoBusy = false;
  let shotTaken = false;
  const autoEnd = Date.now() + 60_000;
  while (Date.now() < autoEnd) {
    const lines = await page.locator(".t-lane-line").allTextContents();
    if (lines.length === 2 && lines.every((l) => l.includes("run at"))) {
      twoBusy = true;
      if (!shotTaken) {
        await shot("06-auto-eval-two-lanes");
        shotTaken = true;
      }
    }
    await sleep(500);
  }
  if (!shotTaken) await shot("06-auto-eval-two-lanes");
  // owner rule: every evaluation auto-eval was due runs once, or is still due; none is lost, and no
  // more than a minute behind plus its live rate
  const afterAuto = await state(page);
  const conserved = afterAuto.stats.evaluations - e0 + afterAuto.autoDue;
  const dueAtMost = 300 + 5 * ((Date.now() - autoStart) / 1000) + 40;
  endPhase("auto-eval, two lanes, 1 min");

  await page.selectOption("#t-method", "basin_hopping");
  const busyBefore = await page.locator(".t-lane-line").allTextContents();
  const ts = Date.now();
  await page.click("#t-stop");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: off");
  await expect.poll(() => idle(page), { timeout: 30_000 }).toBe(true);
  const stopMs = Date.now() - ts;
  await shot("07-stopped");
  const s1 = await state(page);
  endPhase("Stop");
  await sleep(1500);
  await page.reload();
  await expect(page.locator("#t-title")).toHaveText(/pieces/, { timeout: 30_000 });
  await sleep(3000);
  const s2 = await state(page);
  await shot("08-after-reload");
  // half a minute idle after the reload, to see what an idle open tab sends
  await sleep(30_000);
  endPhase("reload and 30 s idle");

  const byPhase = phases.map((ph) => {
    const rs = log.filter((r) => r.t >= ph.from && r.t < ph.to);
    const minutes = Math.max((ph.to - ph.from) / 60_000, 1 / 60);
    const c = (f: (r: Req) => boolean) => rs.filter(f).length;
    return {
      phase: ph.name,
      seconds: Math.round((ph.to - ph.from) / 1000),
      problemsGET: c((r) => r.method === "GET" && r.path.startsWith("/api/problems/")),
      recordsGET: c((r) => r.path.startsWith("/api/records")),
      submissionsGET: c((r) => r.path.startsWith("/api/submissions/")),
      submitPOST: c((r) => r.method === "POST"),
      events: c((r) => r.path.startsWith("/api/events")),
      perMinute: +(rs.filter((r) => !r.path.startsWith("/api/events")).length / minutes).toFixed(1),
    };
  });
  const report = {
    compactMs,
    clickMs: { median: [...clickMs].sort((x, y) => x - y)[clickMs.length >> 1], max: Math.max(...clickMs) },
    stopMs,
    twoBusy,
    conserved,
    busyBefore,
    owned: s1.owned,
    rpBeforeReload: s1.rp,
    rpAfterReload: s2.rp,
    autoAfterReload: s2.settings.auto,
    dueAfterReload: s2.autoDue,
    queue: s2.queue.map(
      (q: any) => `${q.key} ${q.phase} best ${q.best} ours ${q.ourId} runs ${q.runs} evaluations ${q.evaluations}`,
    ),
    stats: s2.stats,
    byPhase,
    errors,
  };
  writeFileSync(`${SHOTS}/session-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  expect(errors).toEqual([]);
  expect(conserved).toBeGreaterThanOrEqual(300);
  expect(conserved).toBeLessThanOrEqual(dueAtMost);
  expect(s2.autoDue).toBe(0);
  expect(twoBusy).toBe(true);
  expect(s2.settings.auto).toBe(false);
  expect(s2.owned).toHaveLength(path.length);
  expect(s2.rp).toBeGreaterThanOrEqual(s1.rp - 1e-6);
});
