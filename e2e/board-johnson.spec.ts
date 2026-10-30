import { type Page, expect, test } from "@playwright/test";
import { LAZY_VIEW, distinctColours } from "./helpers";

// The 92 Johnson solids on the board: their problems have no research records, so each opens empty,
// runs briefly from a new arrangement and draws the result. The menus group them as "Johnson solids".

declare const polypack: {
  space?: {
    lastResult: { valid: boolean } | null;
    renderer: { measureFrames?(n: number): number | null } | null;
  };
};

async function opened(page: Page, id: string): Promise<void> {
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`, LAZY_VIEW);
}

/** A short run from a new arrangement; waits for its end and for a frame of the drawing. */
async function runAndDraw(page: Page, evals: number, frames = true): Promise<void> {
  await page.selectOption("#space-solve-budget", "evals");
  await page.fill("#space-solve-evals", String(evals));
  await page.click("#space-solve-run");
  await expect(page.locator("#space-solve-stop")).toBeDisabled({ timeout: 90_000 });
  await expect(page.locator("#space-solve-run")).toBeEnabled();
  expect(await page.evaluate(() => polypack.space!.lastResult?.valid)).toBe(true);
  await expect(page.locator(".space-draw > canvas")).toBeVisible(LAZY_VIEW);
  // the surface drawing has no frame counter; the screenshot check below shows it drew
  if (frames) await expect.poll(() => page.evaluate(() => polypack.space!.renderer?.measureFrames?.(1) ?? null), LAZY_VIEW).not.toBeNull();
  expect(await distinctColours(page, await page.locator(".space-draw").screenshot())).toBeGreaterThan(8);
}

test("Polyhedra groups the 92 Johnson solids and draws J5 in J1", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#space=polyhedra/j05inj01/3");
  await opened(page, "polyhedra/j05inj01/3");
  for (const menu of ["piece", "container"]) {
    const group = page.locator(`#space-f-${menu} optgroup[label="Johnson solids"] option`);
    await expect(group).toHaveCount(92);
    await expect(group.first()).toHaveText("J1 square pyramid");
    await expect(group.last()).toHaveText("J92 triangular hebesphenorotunda");
  }
  await expect(page.locator("#space-f-piece")).toHaveValue("j05");
  await expect(page.locator("#space-f-container")).toHaveValue("j01");
  await expect(page.locator("#space-f-piece option:checked")).toHaveText("J5 pentagonal cupola");
  await runAndDraw(page, 4000);
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /^3 J5 pentagonal cupolas in a J1 square pyramid of scale \d+\.\d{6}, drawn in 3D\./);
});

test("Balls groups the Johnson solids and draws a ball in J44", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#space=balls/ballinj44/4");
  await opened(page, "balls/ballinj44/4");
  await expect(page.locator("#space-f-code option:checked")).toHaveText(/^Balls in a J44 /);
  await expect(page.locator('#space-f-code optgroup[label="Balls in a Johnson solid"] option')).toHaveCount(92);
  await expect(page.locator('#space-f-code optgroup[label="Johnson solids in a ball"] option')).toHaveCount(92);
  await runAndDraw(page, 4000);
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /^4 balls in a J44 gyroelongated triangular bicupola scaled by \d+\.\d{6}, drawn in 3D\./);
});

test("Surfaces group the Johnson solids; one draws folded, and the nofold problem says it is a 2D in 2D problem", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/#space=surface/square_pyramid/fold/3/2");
  await opened(page, "surface/square_pyramid/fold/3/2");
  const group = page.locator('#space-f-solid optgroup[label="Johnson solids"] option');
  await expect(group).toHaveCount(92);
  await expect(group.first()).toHaveText("J1 square pyramid");
  await expect(page.locator("#space-f-solid option:checked")).toHaveText("J1 square pyramid");
  await runAndDraw(page, 4, false);
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /^\d+ \w+ on a J1 square pyramid of edge \d+\.\d{6}, folding over edges; drawn as the solid\./);
  await page.click('.space-tools button[data-view="net"]');
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /on a J1 square pyramid .*drawn as a net\./);
  expect(await distinctColours(page, await page.locator(".space-draw").screenshot())).toBeGreaterThan(8);

  await page.selectOption("#space-f-mode", "nofold");
  await opened(page, "surface/square_pyramid/nofold/3/2");
  await expect(page.locator("#space-same-as")).toContainText("Take the smallest over all splits.");
  await expect(page.locator('#space-same-as a[href^="/#p=3,3,"]')).toBeVisible();
  // the nofold search runs the polygon solver on a face and draws the result on the solid
  await runAndDraw(page, 300, false);
});
