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

/**
 * How many distinct colours (to 4 bits a channel) a screenshot of an element has: a WebGL canvas
 * that drew nothing has one or two. The PNG is decoded by the browser, which needs no decoder in Node.
 */
export async function distinctColours(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4)
      seen.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
    return seen.size;
  }, png.toString("base64"));
}

/** Collects the page's console errors and uncaught errors, for a test to check at its end. */
export function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
