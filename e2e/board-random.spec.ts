import { expect, test } from "@playwright/test";

// The board's Random problem button: a polygon problem drawn from every N and M and P up to 100 on the
// classic board, and a problem of the shown kind in a space mode.

declare const polypack: { board: { state: { N: number; M: number; P: number } } };

test("Random problem opens a drawn polygon problem, and one of the shown kind in a space mode", async ({ page }) => {
  await page.goto("/");
  const button = page.getByRole("button", { name: "Random problem" });
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    await button.click();
    const { N, M, P } = await page.evaluate(() => polypack.board.state);
    for (const sides of [N, M]) expect(sides === 0 || (sides >= 3 && sides <= 100)).toBe(true);
    expect(P).toBeGreaterThanOrEqual(1);
    expect(P).toBeLessThanOrEqual(100);
    // the menus show the drawn problem
    await expect(page.locator("#p-input")).toHaveValue(String(P));
    seen.add(`${N}/${M}/${P}`);
  }
  // six draws of about 990,000 problems are not all one
  expect(seen.size).toBeGreaterThan(1);

  await page.selectOption("#family-select", "torus");
  const note = page.locator("#space-problem-note");
  await expect(note).toHaveText(/^Problem torus\//, { timeout: 30_000 });
  const before = await page.evaluate(() => polypack.board.state);
  const ids = new Set<string>();
  for (let i = 0; i < 4; i++) {
    await button.click();
    await expect(note).toHaveText(/^Problem torus\//);
    ids.add((await note.textContent()) ?? "");
  }
  expect(ids.size).toBeGreaterThan(1);
  // the classic board is left as it was while the space mode answers the button
  expect(await page.evaluate(() => polypack.board.state)).toMatchObject({ N: before.N, M: before.M, P: before.P });
});
