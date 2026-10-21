import AxeBuilder from "@axe-core/playwright";
import { Browser, Page, devices, expect, test } from "@playwright/test";

// Tighter on phones and tablets (the "phone" project runs this file on a Pixel 7; the iPhone and iPad
// tests launch WebKit themselves). The mechanics are the desktop's; what is checked here is that the
// layout fits one screen, that every view is reachable by touch, and that rapid taps on Evolve never
// zoom, scroll, select or get lost. Emulators do not reproduce double-tap zoom (a control page with
// touch-action: auto does not zoom either), so that protection is checked as the computed styles that
// give it: touch-action: manipulation on the page and its controls, with pinch zoom left on.

const URL = "http://localhost:5174/tighter.html";

const state = <T>(page: Page, f: (s: any) => T): Promise<T> =>
  page.evaluate(`(${f.toString()})(window.tighter.state)`) as Promise<T>;
const idle = (page: Page) => page.evaluate(() => !(window as any).tighter.busy);

async function fresh(page: Page, seed: number): Promise<void> {
  await page.goto(`${URL}?seed=${seed}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${URL}?seed=${seed}`);
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)", { timeout: 30_000 });
}

/** The first record by a tap, then a name on it from the pop-up, all by touch. */
async function firstRecordWithName(page: Page, name: string): Promise<void> {
  await page.locator("#t-evolve").tap();
  await expect(page.locator("#t-welcome")).toBeVisible({ timeout: 60_000 });
  await page.locator("#t-name").fill(name);
  await page.locator("#t-agree").tap();
  await page.locator("#t-consent-save").tap();
  await expect.poll(() => state(page, (s) => s.consent)).toBe(true);
  await expect(page.locator("#t-welcome")).toBeHidden();
}

/** A game further on: points, the first upgrades, the queue and the lanes. */
async function midGame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.rp = 5000;
    s.rpEarned = 9000;
    for (const id of ["trace", "click2", "auto1", "click3", "seeds", "auto2", "click4", "click5", "queue3"])
      if (!s.owned.includes(id)) s.owned.push(id);
    s.reveal.push("score", "points", "upgrades", "queue", "lanes");
  });
  // the queue's section is shown (on a phone it waits behind the dock's Queue tab)
  await expect.poll(() => page.evaluate(() => !document.getElementById("t-queue")!.hidden)).toBe(true);
}

/** Taps Evolve `n` times, every `ms`, at the point where it was when the tapping began (a finger). */
async function rapidTaps(page: Page, n: number, ms = 100) {
  const box = (await page.locator("#t-evolve").boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const clicks0 = await state(page, (s) => s.stats.clicks);
  for (let i = 0; i < n; i++) {
    await page.touchscreen.tap(x + (i % 3) - 1, y + (i % 2));
    await page.waitForTimeout(ms);
  }
  await expect.poll(() => idle(page), { timeout: 60_000 }).toBe(true);
  const after = (await page.locator("#t-evolve").boundingBox())!;
  const view = await page.evaluate(() => ({
    scale: visualViewport!.scale,
    scrollX,
    scrollY,
    selection: getSelection()?.toString() ?? "",
  }));
  return { clicks: (await state(page, (s) => s.stats.clicks)) - clicks0, moved: Math.abs(after.y - box.y), ...view };
}

/** The page fits the screen: no scrolling either way. */
async function fits(page: Page): Promise<void> {
  const d = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
    iw: innerWidth,
    ih: innerHeight,
  }));
  expect(d.w).toBeLessThanOrEqual(d.iw);
  expect(d.h).toBeLessThanOrEqual(d.ih);
}

async function axeClean(page: Page): Promise<void> {
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`)).toEqual([]);
}

/** Opens a context on a device in WebKit (Safari's engine). */
async function webkitPage(
  playwright: { webkit: { launch(): Promise<Browser> } },
  device: string,
): Promise<{ browser: Browser; page: Page }> {
  const browser = await playwright.webkit.launch();
  const page = await (await browser.newContext({ ...devices[device] })).newPage();
  return { browser, page };
}

test("phone: one screen, Evolve in the thumb zone, and rapid taps that never zoom, scroll, select or get lost", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 11);
  await fits(page);
  // the action dock is at the bottom of the screen; before the second view opens there are no tabs
  const vh = await page.evaluate(() => innerHeight);
  const evolve = (await page.locator("#t-evolve").boundingBox())!;
  expect(evolve.y).toBeGreaterThan(vh * 0.75);
  expect(evolve.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator("#t-dock")).toBeHidden();
  await expect(page.locator("#board")).toBeVisible();

  // double-tap zoom is off everywhere (the canvas keeps its own gestures), and pinch zoom is not
  const styles = await page.evaluate(() => {
    const ta = (sel: string) => getComputedStyle(document.querySelector(sel)!).touchAction;
    return {
      html: ta("html"),
      body: ta("body"),
      evolve: ta("#t-evolve"),
      title: ta("#t-title"),
      status: ta("#status"),
      bar: ta(".t-bar"),
      canvas: ta("#board"),
      select: getComputedStyle(document.querySelector("#t-evolve")!).userSelect,
      viewport: document.querySelector('meta[name="viewport"]')!.getAttribute("content"),
    };
  });
  for (const k of ["html", "body", "evolve", "title", "status", "bar"] as const) expect(styles[k]).toBe("manipulation");
  expect(styles.canvas).toBe("none");
  expect(styles.select).toBe("none");
  expect(styles.viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale/);

  // a name first (Settings), then 40 rapid taps from the placed board: the first compacts, its record
  // pays, and the totals and the views' tabs appear in the middle of the tapping; Evolve stays put
  await page.locator("#t-open-settings").tap();
  await page.locator("#t-name").fill("Thumb");
  await page.locator("#t-agree").tap();
  await page.locator("#t-consent-save").tap();
  await page.locator("#t-settings-close").tap();
  await expect(page.locator("#t-settings")).toBeHidden();
  const r = await rapidTaps(page, 40);
  expect(r).toMatchObject({ clicks: 40, scale: 1, scrollX: 0, scrollY: 0, selection: "", moved: 0 });
  await expect(page.locator("#t-dock")).toBeVisible();
  await expect(page.locator("#t-welcome")).toBeHidden();
  await fits(page);
  expect(errors).toEqual([]);
});

test("phone: every view by the dock's tabs; the tree as a list, bought from by touch; Settings as a sheet", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await fresh(page, 12);
  await firstRecordWithName(page, "Dock");
  await midGame(page);
  await axeClean(page);

  // the tree: a list of the same nodes, a tap opens the details, Buy there buys
  await page.locator("#t-dock-tree").tap();
  await expect(page.locator("#t-dock-tree")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".t-tree-list")).toBeVisible();
  await expect(page.locator("#board")).toBeHidden();
  const node = page.locator('.t-card[data-id="click6"]');
  await expect(node).toHaveAttribute("data-state", "buyable");
  await node.locator("button").tap();
  await expect(page.locator(".t-detail-buy")).toBeVisible();
  await axeClean(page);
  await page.locator(".t-detail-buy").tap();
  await expect.poll(() => state(page, (s) => s.owned.includes("click6"))).toBe(true);
  await fits(page);

  // the queue: the queue, its offers and lanes, without the points
  await page.locator("#t-dock-queue").tap();
  await expect(page.locator("#t-queue")).toBeVisible();
  await expect(page.locator("#t-lanes")).toBeVisible();
  await expect(page.locator("#t-points")).toBeHidden();
  await expect(page.locator("#t-upgrades")).toBeHidden();
  await axeClean(page);

  // the points: the points, standing and records, without the queue
  await page.locator("#t-dock-points").tap();
  await expect(page.locator("#t-points")).toBeVisible();
  await expect(page.locator("#t-queue")).toBeHidden();

  // back to the board, which is fitted again
  await page.locator("#t-dock-board").tap();
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator(".t-head")).toBeVisible();
  // Evolve answers from every view
  await page.locator("#t-dock-queue").tap();
  const clicks = await state(page, (s) => s.stats.clicks);
  await page.locator("#t-evolve").tap();
  await expect.poll(() => state(page, (s) => s.stats.clicks)).toBe(clicks + 1);

  // Settings: a sheet from the bottom edge; its fields at 16 px, so focusing one does not zoom
  await page.locator("#t-open-settings").tap();
  const sheet = page.locator("#t-settings");
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  const vh = await page.evaluate(() => innerHeight);
  expect(Math.abs(box.y + box.height - vh)).toBeLessThanOrEqual(2);
  expect(box.width).toBeGreaterThanOrEqual((await page.evaluate(() => innerWidth)) - 1);
  const sizes = await page.evaluate(() =>
    ["#t-name", "#t-save-text"].map((s) => parseFloat(getComputedStyle(document.querySelector(s)!).fontSize)),
  );
  for (const px of sizes) expect(px).toBeGreaterThanOrEqual(16);
  await axeClean(page);
  await page.locator("#t-settings-close").tap();
  await expect(sheet).toBeHidden();
  expect(errors).toEqual([]);
});

test("iPhone (WebKit): rapid taps, a purchase from the tree by touch, and the board beside the controls on its side", async ({
  playwright,
}) => {
  test.setTimeout(240_000);
  const { browser, page } = await webkitPage(playwright, "iPhone 13");
  try {
    await fresh(page, 13);
    await fits(page);
    await firstRecordWithName(page, "Safari");
    const r = await rapidTaps(page, 40);
    expect(r).toMatchObject({ clicks: 40, scale: 1, scrollY: 0, selection: "", moved: 0 });
    // iOS takes a first tap on an element whose hover changes the page for a hover: the tree's nodes
    // must answer the tap itself, and the details must stay for the Buy tap
    await midGame(page);
    await page.locator("#t-dock-tree").tap();
    const node = page.locator('.t-card[data-id="click6"]');
    await expect(node).toHaveAttribute("data-state", "buyable");
    await node.locator("button").tap();
    await expect(page.locator(".t-detail-buy")).toBeVisible();
    await page.locator(".t-detail-buy").tap();
    await expect.poll(() => state(page, (s) => s.owned.includes("click6"))).toBe(true);
  } finally {
    await browser.close();
  }

  // landscape: the board fills the left, the controls take a column on the right
  const land = await webkitPage(playwright, "iPhone 13 landscape");
  try {
    const page = land.page;
    await fresh(page, 14);
    await fits(page);
    const vw = await page.evaluate(() => innerWidth);
    const board = (await page.locator("#board").boundingBox())!;
    const evolve = (await page.locator("#t-evolve").boundingBox())!;
    expect(board.x).toBeLessThan(10);
    expect(board.x + board.width).toBeLessThanOrEqual(evolve.x);
    expect(evolve.x).toBeGreaterThan(vw / 2);
    expect(evolve.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator("#t-title")).toBeVisible();
    const r = await rapidTaps(page, 20);
    expect(r).toMatchObject({ clicks: 20, scale: 1, scrollY: 0, moved: 0 });
  } finally {
    await land.browser.close();
  }
});

test("iPad (WebKit): two columns, the toolbar under the board, rapid taps kept while the header changes", async ({
  playwright,
}) => {
  test.setTimeout(180_000);
  const { browser, page } = await webkitPage(playwright, "iPad (gen 7)");
  try {
    await fresh(page, 15);
    await fits(page);
    // the panel beside the board, the toolbar below it
    const board = (await page.locator("#board").boundingBox())!;
    const panel = (await page.locator("#t-panel").boundingBox())!;
    const evolve = (await page.locator("#t-evolve").boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(board.x + board.width - 1);
    expect(evolve.y).toBeGreaterThan(board.y + board.height - 1);
    await expect(page.locator("#t-dock")).toBeHidden();
    // the first tap compacts; the header then shows Next problem, which must not move Evolve
    const r = await rapidTaps(page, 30);
    expect(r).toMatchObject({ clicks: 30, scale: 1, scrollY: 0, selection: "", moved: 0 });
    // the tree's canvas by touch: a tap shows the details, which hold Buy
    await midGame(page);
    await page.locator("#t-tab-tree").tap();
    const node = page.locator('.t-card[data-id="click6"]');
    await expect(node).toHaveAttribute("data-state", "buyable");
    await node.locator("button").tap();
    await page.locator(".t-detail-buy").tap();
    await expect.poll(() => state(page, (s) => s.owned.includes("click6"))).toBe(true);
    await fits(page);
  } finally {
    await browser.close();
  }
});
