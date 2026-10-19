import { mkdirSync, writeFileSync } from "node:fs";
import { Page, expect, test } from "@playwright/test";

// Independent review of Tighter (2026-10-19), against the local stack only (playwright.config.ts:
// in-memory server on 8788 behind Vite on 5174). Tests named "owner rule" assert the site owner's
// rules from the review brief; a failure there is a finding. Screenshots go to tighter-review-shots/.

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
  await page.click("#t-loadall");
  await expect(page.locator("#t-compact")).toBeEnabled({ timeout: 30_000 });
  await page.click("#t-compact");
  await expect(page.locator("#t-evolve")).toBeVisible({ timeout: 120_000 });
}

async function consent(page: Page, name: string, agree = true): Promise<void> {
  await page.fill("#t-name", name);
  await page.setChecked("#t-agree", agree);
  await page.click("#t-consent-save");
}

async function evolveOnce(page: Page): Promise<number> {
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 120_000 });
  const runs = (await state(page)).stats.runs;
  const t = Date.now();
  await page.click("#t-evolve");
  await expect.poll(async () => (await state(page)).stats.runs, { timeout: 180_000 }).toBe(runs + 1);
  return Date.now() - t;
}

async function evolveUntilBetter(page: Page, than: number, tries = 10): Promise<void> {
  for (let i = 0; i < tries && (await focus(page)).best >= than * (1 - 2e-9); i++) await evolveOnce(page);
  expect((await focus(page)).best).toBeLessThan(than * (1 - 2e-9));
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
  await evolveUntilBetter(page, first.score);
  // the next problem may be dealt (in real play: 5 minutes after this one was dealt)
  await page.evaluate(() => ((window as any).tighter.state.dealer.tokens = 1));
  await expect(page.locator("#t-next")).toBeEnabled({ timeout: 10_000 });
  await page.click("#t-next");
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
  // Adjusted after the fix: the page cleans names as the server does, so "<>" (empty once cleaned)
  // is refused at the form and nothing is sent.
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
  await expect(page.locator("#t-log")).toContainText("name is required");
  const best0 = (await focus(page)).best;
  await evolveUntilBetter(page, best0);
  const b1 = (await focus(page)).best;
  await evolveUntilBetter(page, b1);
  await sleep(3000);
  const mine = posts(log);
  console.log(
    `refused-name POSTs for ${p.key} within ${((Date.now() - mine[0].t) / 1000).toFixed(0)} s: ${mine.length}`,
  );
  await page.screenshot({ path: `${SHOTS}/r1-refused-name.png`, fullPage: true });
  const firstMinute = mine.filter((r) => r.t - mine[0].t < 60_000);
  expect(firstMinute.length).toBe(1);
});

test("an accepted first record whose answer is lost to a reload: no second POST, but is it counted?", async ({
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
  await page.reload();
  await page.unroute("**/api/submit");
  await expect(page.locator("#t-evolve")).toBeVisible({ timeout: 30_000 });
  await sleep(6000);
  const server = await siteBest(page, p);
  const after = await focus(page);
  const s = await state(page);
  console.log(
    `lost answer: server leader ${server?.name} id ${server?.id}; game verified ${after.verified} ourId ${after.ourId} ` +
      `held ${await page.locator("#t-held").textContent()} rp ${s.rp} POSTs ${posts(log).length}`,
  );
  await page.screenshot({ path: `${SHOTS}/r2-lost-answer-after-reload.png`, fullPage: true });
  expect(server?.name).toBe("Reload Player");
  expect(posts(log)).toHaveLength(1);
  // the game should know it holds this record
  await expect(page.locator("#t-held")).toHaveText("1");
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
  const measure = async (label: string, ms: number) => {
    const n0 = log.length;
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
  await consent(page, "Error Player");
  await measure("429 first 10 s", 10_000);
  await page.evaluate(() => (window as any).tighter.skipAhead(61_000));
  await measure("429 after a game minute, 10 s", 10_000);
  await answer(500);
  await page.evaluate(() => (window as any).tighter.skipAhead(61_000));
  await measure("500, 10 s", 10_000);
  await answer("abort");
  await page.evaluate(() => (window as any).tighter.skipAhead(31_000));
  await measure("network error, 10 s", 10_000);
  await page.unroute("**/api/submit");
  await page.route(`**/api/problems/${p.N}/${p.M}/${p.P}`, (route) => route.abort());
  await page.evaluate(() => (window as any).tighter.skipAhead(31_000));
  await measure("leader GET fails, 10 s", 10_000);
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
  await evolveUntilBetter(page, (await focus(page)).best);
  await answer(409);
  await page.evaluate(() => (window as any).tighter.skipAhead(61_000));
  const before409 = posts(log).length;
  await expect
    .poll(async () => (await state(page)).queue.some((q: any) => q.key === p.key), { timeout: 20_000 })
    .toBe(false);
  expect(posts(log).length - before409).toBeLessThanOrEqual(1);
});

// Adjusted after the fix: one tab runs the game at a time, so tab B stands by instead of playing;
// the owner's rules (one POST per problem a minute, no save overwritten) are asserted on that design.
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
  for (let i = 0; i < 2; i++) await evolveOnce(a);
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
  await sleep(1000);
  const rpA = (await state(a)).rp;
  await b.click("#t-take-over");
  await expect(b.locator("#t-evolve")).toBeVisible({ timeout: 30_000 });
  await expect(a.locator("#t-elsewhere")).toBeVisible({ timeout: 10_000 });
  await expect(a.locator("#t-elsewhere-text")).toContainText("another tab");
  expect((await state(b)).rp).toBeCloseTo(rpA, 9);
  const postsA = posts(logA).length;
  await evolveOnce(b);
  await a.evaluate(() => (window as any).tighter.skipAhead(120_000));
  await sleep(3000);
  expect(posts(logA).length).toBe(postsA);
  const saved = await b.evaluate(() => JSON.parse(localStorage.getItem("tighter.save")!).rp);
  expect(saved).toBeGreaterThanOrEqual(rpA - 1e-9);
});

// Adjusted after the fix: on battery every run pauses (as in a hidden tab) until the player allows
// battery use, so the Compact is checked paused first and then allowed.
test("hidden tab pauses a run; on battery a manual run is paused too, until allowed", async ({ page }) => {
  test.setTimeout(400_000);
  await page.addInitScript(() => {
    const battery = Object.assign(new EventTarget(), { charging: false, level: 0.5 });
    (navigator as any).getBattery = () => Promise.resolve(battery);
  });
  await fresh(page, 27);
  await expect(page.locator("#t-battery-box")).toBeVisible();
  await page.click("#t-loadall");
  await expect(page.locator("#t-compact")).toBeEnabled({ timeout: 30_000 });
  await page.click("#t-compact"); // a manual Compact, on battery power
  await expect(page.locator("#t-runinfo")).toContainText("paused", { timeout: 10_000 });
  const onBattery = await page.locator("#t-runinfo").textContent();
  await expect(page.locator("#t-hold")).toContainText("battery");
  const doneOf = (t: string | null) => Number(/([\d,]+) done/.exec(t ?? "")?.[1].replace(/,/g, "") ?? -1);
  // the framework always scores the start before its first checkpoint, where the pause takes hold
  await sleep(1000);
  const b0 = doneOf(await page.locator("#t-runinfo").textContent());
  expect(b0).toBeLessThanOrEqual(1);
  await sleep(3000);
  expect(doneOf(await page.locator("#t-runinfo").textContent())).toBe(b0);
  // allowing battery use lets the run go on to its end
  await page.locator("#t-settings").scrollIntoViewIfNeeded();
  await page.check("#t-battery");
  await expect(page.locator("#t-evolve")).toBeVisible({ timeout: 120_000 });
  // longer runs so that one can be watched: Longer runs II (300 evaluations), granted through the page's handle
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.owned.push("trace", "evals1", "queue3", "auto1", "seeds", "basin", "evals2");
  });
  await expect(page.locator("#t-evolve")).toBeEnabled();
  await page.click("#t-evolve");
  await expect(page.locator("#t-runinfo")).toContainText(/[1-9]\d* done/, { timeout: 60_000 });
  // battery use is allowed now: the run goes on
  expect(await page.locator("#t-runinfo").textContent()).not.toContain("paused");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(1500);
  const done = (t: string | null) => Number(/([\d,]+) done/.exec(t ?? "")?.[1].replace(/,/g, "") ?? -1);
  const h0 = await page.locator("#t-runinfo").textContent();
  await sleep(6000);
  const h1 = await page.locator("#t-runinfo").textContent();
  await page.screenshot({ path: `${SHOTS}/r4-hidden-paused.png`, fullPage: true });
  console.log(
    `battery: "${onBattery}"; hidden: "${h0}" then "${h1}"; hold "${await page.locator("#t-hold").textContent()}"`,
  );
  expect(h1).toContain("paused");
  expect(done(h1)).toBe(done(h0));
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#t-evolve")).toBeEnabled({ timeout: 300_000 });
  // owner rule: battery does what a hidden tab does (where detectable): the run was paused
  expect(onBattery).toContain("paused");
});

test("names and server text are shown as text, never as HTML", async ({ page }) => {
  test.setTimeout(240_000);
  await fresh(page, 28);
  await firstRecord(page);
  const evil = `<img src=x onerror="window.__xss=1">`;
  await consent(page, evil);
  // adjusted after the fix: the name is shown cleaned as the server stores it (no angle brackets)
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
  const str = `tighter:1:j:${Buffer.from(JSON.stringify(raw)).toString("base64url")}`;
  await page.locator("#t-settings summary").click();
  await page.fill("#t-save-text", str);
  page.once("dialog", (d) => d.accept());
  await page.click("#t-import");
  await expect(page.locator("#t-save-note")).toHaveText("Save imported.");
  await sleep(1500);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(await page.locator("#t-log img, #t-consent b").count()).toBe(0);
});

test("a sustained session: Load all, Compact, consent, Evolves, upgrades, auto-eval on two lanes, Stop, reload", async ({
  page,
}) => {
  test.setTimeout(1_500_000);
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
  await page.click("#t-loadall");
  await expect(page.locator("#t-compact")).toBeEnabled({ timeout: 30_000 });
  await shot("02-load-all");
  const tc = Date.now();
  await page.click("#t-compact");
  await expect(page.locator("#t-evolve")).toBeVisible({ timeout: 120_000 });
  const compactMs = Date.now() - tc;
  await shot("03-first-record-consent");
  endPhase("Load all and Compact");
  await consent(page, "Review Player");
  const p0 = await focus(page);
  await expect.poll(async () => (await siteBest(page, p0))?.name, { timeout: 20_000 }).toBe("Review Player");
  const evolveMs: number[] = [];
  for (let i = 0; i < 15; i++) evolveMs.push(await evolveOnce(page));
  await shot("04-after-15-evolves");
  endPhase("consent and 15 manual Evolves");

  // grant points through the page's handle, then buy the ten upgrades through their cards
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.rp += 5000;
    s.rpEarned += 5000;
  });
  for (const id of ["trace", "evals1", "queue3", "auto1", "seeds", "basin", "reach2", "evals2", "advance", "lanes2"]) {
    const btn = page.locator(`.t-card[data-id="${id}"] button`);
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();
    await expect.poll(async () => (await state(page)).owned.includes(id)).toBe(true);
  }
  await shot("05-all-upgrades");
  // fill the 3 slots without waiting 100 s per deal
  await page.evaluate(() => ((window as any).tighter.state.dealer.tokens = 3));
  await expect.poll(async () => (await state(page)).queue.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
  endPhase("buy upgrades, deal 3");

  await page.click("#t-auto");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: on");
  let twoBusy = false;
  const autoEnd = Date.now() + 4 * 60_000;
  let shotTaken = false;
  while (Date.now() < autoEnd) {
    const lines = await page.locator(".t-lane-line").allTextContents();
    if (lines.length === 2 && lines.every((l) => !l.includes("idle"))) {
      twoBusy = true;
      if (!shotTaken) {
        await shot("06-auto-eval-two-lanes");
        shotTaken = true;
      }
    }
    await sleep(2000);
  }
  if (!shotTaken) await shot("06-auto-eval-two-lanes");
  endPhase("auto-eval, two lanes, 4 min");

  await page.selectOption("#t-method", "basin_hopping");
  const busyBefore = await page.locator(".t-lane-line").allTextContents();
  const ts = Date.now();
  await page.click("#t-stop");
  await expect
    .poll(async () => (await page.locator(".t-lane-line").allTextContents()).every((l) => l.includes("idle")), {
      timeout: 30_000,
    })
    .toBe(true);
  const stopMs = Date.now() - ts;
  await shot("07-stopped");
  const s1 = await state(page);
  endPhase("Stop");
  await sleep(1000);
  await page.reload();
  await expect(page.locator("#t-title")).toHaveText(/pieces/, { timeout: 30_000 });
  await sleep(3000);
  const s2 = await state(page);
  await shot("08-after-reload");
  // a minute idle after the reload, to see what an idle open tab sends
  await sleep(60_000);
  endPhase("reload and 1 idle minute");

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
    evolveMs,
    stopMs,
    twoBusy,
    busyBefore,
    owned: s1.owned,
    rpBeforeReload: s1.rp,
    rpAfterReload: s2.rp,
    autoAfterReload: s2.settings.auto,
    queue: s2.queue.map((q: any) => `${q.key} ${q.phase} best ${q.best} ours ${q.ourId} runs ${q.runs}`),
    stats: s2.stats,
    byPhase,
    errors,
  };
  writeFileSync(`${SHOTS}/session-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  expect(errors).toEqual([]);
  expect(s2.settings.auto).toBe(false);
  expect(s2.owned).toHaveLength(10);
});
