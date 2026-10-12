import { expect, Page, test } from "@playwright/test";
import { Pose, findOverlaps } from "@polypack/geometry";
import { openProblem, pieces } from "./helpers";

const square = (x: number, y: number, angle = 0): Pose => ({ x, y, theta: Math.PI / 4 + angle });
async function fixture(page: Page, ps: Pose[]) {
  await openProblem(page, 4, 4, ps.length);
  await page.setInputFiles("#import-file", {
    name: "snap-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ N: 4, M: 4, P: ps.length, pieces: ps, container_phi: 0 })),
  });
  await expect(page.locator("#status")).toContainText("Imported");
  await page.evaluate(() => {
    const v = (window as any).polypack.view;
    v.cam.zoom = 60;
    v.requestDraw();
  });
}
const screen = (page: Page, x: number, y: number) =>
  page.evaluate(({ x, y }) => (window as any).polypack.view.clientPoint(x, y), { x, y });

test("mouse face snap aligns an off-centre grab, stays stable, and undoes as one gesture", async ({ page }) => {
  const start = [square(0, 0), square(1.4, 0, Math.PI / 60)];
  await fixture(page, start);
  await page.selectOption("#mouse-snap", "edges");
  const a = await screen(page, 1.5, 0.1),
    b = await screen(page, 1.18, 0.1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y);
  let ps = await pieces(page);
  expect(ps[1].x).toBeCloseTo(1, 9);
  expect(ps[1].y).toBeCloseTo(0, 9);
  expect(ps[1].theta).toBeCloseTo(Math.PI / 4, 9);
  for (let i = 0; i < 5; i++) await page.mouse.move(b.x, b.y);
  const stable = await pieces(page);
  expect(stable[1].x).toBeCloseTo(ps[1].x, 10);
  expect(stable[1].y).toBeCloseTo(ps[1].y, 10);
  expect(stable[1].theta).toBeCloseTo(ps[1].theta, 10);
  ps = stable;
  await page.mouse.up();
  await expect(page.locator("#status")).toContainText("Faces aligned");
  expect(findOverlaps(4, await pieces(page))).toHaveLength(0);
  await page.keyboard.press("Control+z");
  expect(await pieces(page)).toEqual(start);
  await page.keyboard.press("Control+Shift+z");
  expect(await pieces(page)).toEqual(ps);
});

test("corner snapping releases when pulled away; Option and Off allow free dragging", async ({ page }) => {
  await fixture(page, [square(0, 0), square(1.4, 1.4)]);
  await page.selectOption("#mouse-snap", "corners");
  const a = await screen(page, 1.4, 1.4),
    b = await screen(page, 1.08, 1.06),
    far = await screen(page, 1.6, 1.6);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y);
  expect((await pieces(page))[1].x).toBeCloseTo(1, 9);
  expect((await pieces(page))[1].y).toBeCloseTo(1, 9);
  await page.mouse.move(far.x, far.y);
  expect((await pieces(page))[1].x).toBeCloseTo(1.6, 9);
  await page.keyboard.down("Alt");
  await page.mouse.move(b.x, b.y);
  expect((await pieces(page))[1].x).toBeCloseTo(1.08, 6);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.selectOption("#mouse-snap", "off");
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  const off = await screen(page, 1.16, 1.06);
  await page.mouse.move(off.x, off.y);
  await page.mouse.up();
  expect((await pieces(page))[1].x).toBeCloseTo(1.16, 6);
  expect(findOverlaps(4, await pieces(page))).toHaveLength(0);
});
