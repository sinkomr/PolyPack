import { CDPSession, Page, expect, test } from "@playwright/test";
import { findOverlaps, pieceContainsPoint } from "@polypack/geometry";
import { openProblem, pieceCentre, pieces } from "./helpers";

type Point = { x: number; y: number; id: number };

async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", points: Point[]): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
}

async function canvasPoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator("#board").boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

test("phone: touch drag and two-finger rotate", async ({ page }) => {
  await openProblem(page, 4, 4, 3);
  await page.tap("#add-all");
  await expect(page.locator("#count")).toContainText("3 / 3");
  const cdp = await page.context().newCDPSession(page);

  // one finger drags a piece into its neighbour: contact, no overlap
  const a = await pieceCentre(page, 0);
  const b = await pieceCentre(page, 1);
  await touch(cdp, "touchStart", [{ ...a, id: 1 }]);
  for (let i = 1; i <= 15; i++) {
    await touch(cdp, "touchMove", [{ x: a.x + ((b.x - a.x) * 2 * i) / 15, y: a.y + ((b.y - a.y) * 2 * i) / 15, id: 1 }]);
  }
  await touch(cdp, "touchEnd", []);
  let ps = await pieces(page);
  expect(findOverlaps(4, ps)).toHaveLength(0);
  const moved = Math.hypot(ps[0].x - 0, ps[0].y - 0);
  expect(moved).toBeGreaterThan(0.1);

  // with the piece selected, a two-finger twist rotates it
  const theta0 = ps[0].theta;
  const c = await canvasPoint(page, 0.5, 0.8);
  const fingers = (angle: number): Point[] => [
    { x: c.x + 60 * Math.cos(angle), y: c.y - 60 * Math.sin(angle), id: 1 },
    { x: c.x - 60 * Math.cos(angle), y: c.y + 60 * Math.sin(angle), id: 2 },
  ];
  await touch(cdp, "touchStart", [fingers(0)[0]]);
  await touch(cdp, "touchStart", fingers(0));
  for (let i = 1; i <= 10; i++) await touch(cdp, "touchMove", fingers((i * 0.5) / 10));
  await touch(cdp, "touchEnd", []);
  ps = await pieces(page);
  expect(findOverlaps(4, ps)).toHaveLength(0);
  expect(Math.abs(ps[0].theta - theta0)).toBeGreaterThan(0.2);

  // with nothing selected, a pinch zooms the view
  await page.evaluate(() => (window as any).polypack.board.select([]));
  const zoom0 = await page.evaluate(() => (window as any).polypack.view.cam.zoom);
  // Toolbar wrapping changes the canvas height. Pick actual empty space instead of assuming
  // the fixed twist point is still empty after the pieces have moved.
  const scene = await page.evaluate(() => {
    const { board, view } = (window as any).polypack;
    const r = document.getElementById("board")!.getBoundingClientRect();
    return { config: board.toConfig(), cam: view.cam, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
  const pinchCentre = [0.08, 0.18, 0.82, 0.92].map((fy) => ({ x: scene.rect.x + scene.rect.width / 2, y: scene.rect.y + scene.rect.height * fy })).find((p) =>
    [-40, 40].every((dx) => {
      const x = scene.cam.x + (p.x + dx - scene.rect.x - scene.rect.width / 2) / scene.cam.zoom;
      const y = scene.cam.y - (p.y - scene.rect.y - scene.rect.height / 2) / scene.cam.zoom;
      return !scene.config.pieces.some((piece: { x: number; y: number; theta: number }) => pieceContainsPoint(scene.config.N, piece, x, y));
    }),
  );
  expect(pinchCentre).toBeDefined();
  const pinch = (d: number): Point[] => [
    { x: pinchCentre!.x - d, y: pinchCentre!.y, id: 1 },
    { x: pinchCentre!.x + d, y: pinchCentre!.y, id: 2 },
  ];
  await touch(cdp, "touchStart", [pinch(40)[0]]);
  expect(await page.evaluate(() => (window as any).polypack.board.selection.size)).toBe(0);
  await touch(cdp, "touchStart", pinch(40));
  for (let i = 1; i <= 8; i++) await touch(cdp, "touchMove", pinch(40 + i * 6));
  await touch(cdp, "touchEnd", []);
  const zoom1 = await page.evaluate(() => (window as any).polypack.view.cam.zoom);
  expect(zoom1).toBeGreaterThan(zoom0 * 1.5);
  expect(await pieces(page)).toEqual(scene.config.pieces);

  // the page fits the phone: no horizontal scrolling, and the controls are reachable
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator("#submit").scrollIntoViewIfNeeded();
  await expect(page.locator("#submit")).toBeVisible();
});

test("phone: run an optimizer and accept its preview", async ({ page }) => {
  await openProblem(page, 0, 0, 3);
  await expect(page.locator("#solve-run")).toBeEnabled();
  await page.selectOption("#solve-method", "ls_growth");
  await page.selectOption("#solve-budget", "evals");
  await page.fill("#solve-evals", "100");
  await page.tap("#solve-run");
  await expect(page.locator("#solve-accept")).toBeEnabled();
  expect(await pieces(page)).toEqual([]);
  await page.tap("#solve-accept");
  await expect(page.locator("#count")).toContainText("3 / 3");
  await expect(page.locator("#found-with")).toContainText("Found with the PolyPack optimizer;");
  expect(findOverlaps(0, await pieces(page))).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("phone: the volunteer page and the records pages fit, with the site menu wrapped", async ({ page }) => {
  for (const path of ["/volunteer.html", "/browse.html", "/holders.html"]) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Volunteer" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      path,
    ).toBeLessThanOrEqual(1);
  }
});
