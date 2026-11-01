import { expect, Page, test } from "@playwright/test";

// Tighter's dealer filters against the local end-to-end stack: the note that says when nothing can
// match, a problem dealt outside the filters into an empty queue, and a saved filter that deals at
// once after a search that found nothing. Upgrades are given through the page's handle (development
// builds), as tighter-long.spec.ts does.

const game = <T>(page: Page, f: (s: any) => T): Promise<T> =>
  page.evaluate(`(${f.toString()})(window.tighter.state)`) as Promise<T>;

async function fresh(page: Page, seed: number): Promise<void> {
  await page.goto(`/tighter.html?seed=${seed}&tutorial=off`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/tighter.html?seed=${seed}&tutorial=off`);
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
}

/** The dealer's upgrades, with three deals earned, and a queue of three slots holding the first problem. */
async function setUp(page: Page, seed: number): Promise<void> {
  await fresh(page, seed);
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.rp += 1;
    s.rpEarned += 1;
    for (const id of ["queue3", "rank2", "pick3", "filters"]) if (!s.owned.includes(id)) s.owned.push(id);
    s.dealer.tokens = 3;
  });
  await expect(page.locator("#t-filters")).toBeVisible({ timeout: 30_000 });
}

/** Fills the filters form (the fields not named are emptied or set to their widest) and saves it. */
async function saveFilters(page: Page, f: { pieces?: string; containers?: string; minP?: string; maxP?: string }) {
  if ((await page.locator("#t-filters").getAttribute("open")) === null)
    await page.locator("#t-filters summary").click();
  await page.fill("#t-f-pieces", f.pieces ?? "");
  await page.fill("#t-f-containers", f.containers ?? "");
  await page.fill("#t-f-minp", f.minP ?? "1");
  await page.fill("#t-f-maxp", f.maxP ?? "500");
  await page.locator('#t-filter-form button[type="submit"]').click();
  await expect(page.locator("#t-filter-note")).toContainText("Filters saved");
}

test("filters that match nothing say why in the note", async ({ page }) => {
  await setUp(page, 31);
  await saveFilters(page, { pieces: "3-10" });
  const note = page.locator("#t-filter-note");
  await expect(note).toContainText("No problem you can be dealt now fits them");
  await expect(note).toContainText("Open problems have sides of 21 to 100 and 40 to 500 pieces");
  await expect(note).toContainText("Reach: site records");
  // filters that match something do not carry the reason
  await saveFilters(page, { minP: "100", maxP: "150" });
  await expect(note).not.toContainText("No problem you can be dealt now fits them");
  await expect(note).toContainText("one problem outside the filters is dealt");
});

test("an empty queue is dealt a problem outside the filters, and the notice says so", async ({ page }) => {
  await setUp(page, 32);
  const first = await game(page, (s) => s.queue[0].key as string);
  await saveFilters(page, { pieces: "3-10" });
  // the queue is not empty, so nothing is dealt outside the filters yet
  expect(await game(page, (s) => s.queue.length)).toBe(1);
  await page.locator('#t-queue-list button[aria-label^="Drop "]').first().click();
  // the emptied queue does not wait out the pause of the search that found nothing
  await expect.poll(() => game(page, (s) => s.queue.length), { timeout: 20_000 }).toBe(1);
  const dealt = await game(page, (s) => ({ key: s.queue[0].key as string, N: s.queue[0].N as number }));
  expect(dealt.key).not.toBe(first);
  // the problem does not pass the filters (3 to 10 pieces), and the notice and the log say why it came
  expect(dealt.N).toBeGreaterThan(10);
  await expect(page.locator("#t-notice")).toContainText(
    "Nothing fits your dealer filters, so a problem outside them was dealt",
  );
  expect(await game(page, (s) => s.log.map((l: { text: string }) => l.text).join("\n"))).toContain(
    "a problem outside them was dealt",
  );
});

test("saving filters that match deals within seconds, not after the pause", async ({ page }) => {
  await setUp(page, 33);
  await saveFilters(page, { pieces: "3-10" });
  // the search finds nothing and the dealer pauses (30 s)
  await expect
    .poll(() => page.evaluate(() => (window as any).tighter.dealPause), { timeout: 20_000 })
    .toBeGreaterThan(15_000);
  expect(await game(page, (s) => s.picks.offers.length)).toBe(0);
  const saved = Date.now();
  await saveFilters(page, { minP: "100", maxP: "150" });
  await expect.poll(() => game(page, (s) => s.picks.offers.length), { timeout: 20_000 }).toBeGreaterThan(0);
  // the offers fit the new filters, and came well before the pause would have ended
  const ps = await game(page, (s) => s.picks.offers.map((x: { P: number }) => x.P));
  for (const P of ps) expect(P >= 100 && P <= 150).toBe(true);
  expect(Date.now() - saved).toBeLessThan(25_000);
});
