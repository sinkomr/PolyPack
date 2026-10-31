import { expect, Page, test } from "@playwright/test";

// The board is not drawn while the tech tree is shown over it, and is drawn at the current best
// when it comes back. Counts the 2D canvas's stroke calls, which every polygon draw makes.

const focused = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).tighter.state;
    return structuredClone(s.queue.find((p: { key: string }) => p.key === s.focus));
  });
const strokes = (page: Page): Promise<number> => page.evaluate(() => (window as any).__strokes as number);
const evaluations = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).tighter.state.stats.evaluations as number);
/** Two animation frames: a draw already queued when the view changed has run. */
const settled = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test("tighter: the hidden board is not drawn while improvements land, and shows the current best when it returns", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    (window as any).__strokes = 0;
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args: any[]) {
      (window as any).__strokes++;
      return (stroke as any).apply(this, args);
    };
  });
  await page.goto("/tighter.html?seed=5&tutorial=off");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/tighter.html?seed=5&tutorial=off");
  await expect(page.locator("#t-title")).toHaveText(/pieces$/, { timeout: 30_000 });
  await expect(page.locator("#t-evolve")).toHaveText("Evolve (compacts first)", { timeout: 30_000 });
  await page.click("#t-evolve");
  await expect
    .poll(
      async () => (await focused(page)).phase === "ready" && !(await page.evaluate(() => (window as any).tighter.busy)),
      {
        timeout: 60_000,
      },
    )
    .toBe(true);

  // auto-eval keeps improving the problem while the tree is open
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.rp += 6000;
    s.rpEarned += 6000;
  });
  await page.locator("#t-tab-tree").click();
  for (const id of ["trace", "click2", "click3", "click4", "auto1"]) {
    const node = page.locator(`.t-card[data-id="${id}"]`);
    await expect(node).toHaveAttribute("data-state", "buyable", { timeout: 10_000 });
    await node.locator(".t-node-act").click();
    await expect.poll(() => page.evaluate((i) => (window as any).tighter.state.owned.includes(i), id)).toBe(true);
  }
  // 30 evaluations a second (29 levels of Faster auto-eval), so improvements come within seconds
  await page.evaluate(() => {
    const s = (window as any).tighter.state;
    s.owned.push("autox");
    s.levels.autox = 29;
  });
  await page.locator("#t-tab-board").click();
  await page.click("#t-auto");
  await expect(page.locator("#t-auto")).toHaveText("Auto-eval: on");

  // the tree over the board
  await page.locator("#t-tab-tree").click();
  await expect(page.locator("#t-upgrades")).toBeVisible();
  await settled(page);
  const bestAtOpen = (await focused(page)).best as number;
  const evalsAtOpen = await evaluations(page);
  const drawn = await strokes(page);
  await expect
    .poll(
      async () => ((await focused(page)).best as number) < bestAtOpen && (await evaluations(page)) > evalsAtOpen + 3,
      {
        timeout: 120_000,
      },
    )
    .toBe(true);
  await settled(page);
  expect(await strokes(page)).toBe(drawn);

  // back on the board: it is drawn again, at the current best
  await page.locator("#t-tab-board").click();
  await expect.poll(() => strokes(page)).toBeGreaterThan(drawn);
  await expect
    .poll(async () => {
      const best = (await focused(page)).best as number;
      const size = await page.evaluate(() => (window as any).tighter.board.container?.size as number);
      return Math.abs(size - best) / best;
    })
    .toBeLessThan(1e-6);
});
