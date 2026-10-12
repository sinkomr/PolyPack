import { Page } from "@playwright/test";
import { Pose } from "@polypack/geometry";

declare const polypack: {
  board: { state: { N: number; pieces: Pose[]; phi: number } };
  view: { clientPoint(x: number, y: number): { x: number; y: number } };
};

export const pieces = (page: Page) => page.evaluate(() => polypack.board.state.pieces);

/** Page coordinates of the centre of piece i. */
export const pieceCentre = (page: Page, i: number) =>
  page.evaluate((i) => {
    const p = polypack.board.state.pieces[i];
    return polypack.view.clientPoint(p.x, p.y);
  }, i);

/** A fresh board for the given problem. */
export async function openProblem(page: Page, N: number, M: number, P: number): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/#p=${N},${M},${P}`);
  await page.reload();
  await page.locator("#count").filter({ hasText: `0 / ${P}` }).waitFor();
}
