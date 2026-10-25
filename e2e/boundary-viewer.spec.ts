import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { SPACE_INFO, type SpaceProblemResponse } from "@polypack/spaces";
import { foldGain, gainText, plainNofoldLabel } from "../apps/web/src/boundary-model";
import { distinctColours, pageErrors } from "./helpers";

// The 3D on 4D viewer at /spaces/boundary.html, built by vite from apps/web/spaces/boundary.html,
// against the local stack (playwright.config.ts): the catalogue and the problems come from the
// server's research records (data/boundary/records.json).

/** Waits until the viewer shows a problem, drawn. */
async function shown(page: Page, id: string): Promise<void> {
  await expect(page.locator("#viewer-problem-note")).toHaveText(`Problem ${id}`);
  await expect(page.locator("#viewer-score")).not.toHaveText("—");
  await expect(page.locator(".pp3 canvas")).toBeVisible();
  await expect(page.locator(".pp3-status")).toContainText(/edge \d\.\d{6}\./);
}

const button = (page: Page, name: string) => page.locator(".pp3").getByRole("button", { name, exact: true });

/** A problem as the server has it now: the records change as better packings are certified, so none is written here. */
async function problemOf(page: Page, id: string): Promise<SpaceProblemResponse> {
  return (await (await page.request.get(`/api/spaces/boundary/problems/${id}`)).json()) as SpaceProblemResponse;
}

test("the viewer opens from the dimensions page, draws any problem and links to the board and the notes", async ({
  page,
}) => {
  const errors = pageErrors(page);
  await page.goto("/dimensions.html");
  await page
    .locator('#dimension-groups li[data-space="boundary"]')
    .getByRole("link", { name: /^Viewer/ })
    .click();
  await expect(page).toHaveURL(/\/spaces\/boundary\.html#id=boundary\/tesseract\/ball\/9$/);
  await shown(page, "boundary/tesseract/ball/9");
  await expect(page).toHaveTitle("PolyPack — 3D on 4D: 9 balls");
  await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link")).toHaveText([
    "Board",
    "Records",
    "Dimensions",
    "Volunteer",
    "API",
    "Tighter",
  ]);
  await expect(page.getByRole("heading", { name: "3D on 4D viewer" })).toBeVisible();

  // all three views
  for (const view of ["Cells", "Net", "Slice"]) {
    await button(page, view).click();
    await expect(button(page, view)).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(200);
    expect(await distinctColours(page, await page.locator(".pp3 canvas").screenshot()), view).toBeGreaterThan(30);
  }
  await button(page, "Net").click();
  await page.getByRole("slider", { name: "Fold" }).fill("1000");
  await expect(page.getByRole("slider", { name: "Fold" })).toHaveAttribute("aria-valuetext", "folded");

  // the values, in the board's words
  const api = await problemOf(page, "boundary/tesseract/ball/9");
  const nofold = api.extra!.nofold!;
  await expect(page.locator("#viewer-score")).toHaveText(api.certified!.display);
  await expect(page.locator("#viewer-shown")).toHaveText("the research record");
  const facts = page.locator("#viewer-facts");
  await expect(facts).toContainText(`Certified value${api.certified!.display}`);
  await expect(facts).toContainText(`Without folding${nofold.value.toFixed(6)}`);
  await expect(facts).toContainText(`Folding gains${gainText(foldGain(api.best_score, nofold.value))}`);
  await facts.locator("summary", { hasText: "Why" }).click();
  await expect(facts).toContainText(plainNofoldLabel(nofold.label));

  // the packing menu: the research record, and no site entry yet
  const packing = page.locator("#viewer-packing");
  await expect(packing).toHaveValue("certified");
  await expect(packing.locator("option")).toHaveText(["Research record", "Site best (none yet)"]);
  await expect(packing.locator('option[value="site"]')).toBeDisabled();

  // the links name the problem shown
  await expect(page.locator("#viewer-board")).toHaveAttribute("href", "/#space=boundary/tesseract/ball/9");
  await expect(page.locator("#viewer-docs")).toHaveAttribute("href", SPACE_INFO.boundary.docs);
  await expect(page.locator("#viewer-json")).toHaveAttribute(
    "href",
    "/api/spaces/boundary/problems/boundary/tesseract/ball/9",
  );

  // another P keeps the drawing and its view; another piece opens a new one in the same view
  await page.locator(".pp3 canvas").evaluate((c) => ((c as HTMLCanvasElement & { kept?: boolean }).kept = true));
  await page.selectOption("#viewer-f-P", "12");
  await shown(page, "boundary/tesseract/ball/12");
  expect(await page.locator(".pp3 canvas").evaluate((c) => (c as HTMLCanvasElement & { kept?: boolean }).kept)).toBe(
    true,
  );
  await expect(button(page, "Net")).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/#id=boundary\/tesseract\/ball\/12$/);
  await page.selectOption("#viewer-f-piece", "cube");
  await shown(page, "boundary/tesseract/cube/12");
  await expect(button(page, "Net")).toHaveAttribute("aria-pressed", "true");
  const twelve = (await problemOf(page, "boundary/tesseract/cube/12")).best_score!.toFixed(6);
  await expect(page.locator("#viewer-score")).toHaveText(twelve);
  await expect(page.locator(".pp3-status")).toContainText(`12 cubes, edge ${twelve}.`);

  // to the board, with the same problem
  await page.locator("#viewer-board").click();
  await expect(page).toHaveURL(/\/#space=boundary\/tesseract\/cube\/12$/);
  await expect(page.locator("#space-problem-note")).toHaveText("Problem boundary/tesseract/cube/12");
  await expect(page.locator(".pp3 canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

test("?id= and #id= open a problem; one that is not listed opens the nearest", async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto("/spaces/boundary.html?id=boundary/tesseract/cube/3");
  await shown(page, "boundary/tesseract/cube/3");
  await expect(page.locator("#viewer-f-piece")).toHaveValue("cube");
  await expect(page.locator("#viewer-f-P")).toHaveValue("3");
  // the hash wins over the query, and follows the problem shown
  await page.evaluate(() => (location.hash = "#id=boundary/tesseract/ball/5"));
  await shown(page, "boundary/tesseract/ball/5");
  // a P beyond the catalogue's opens its largest
  const listed = (await (await page.request.get("/api/spaces/boundary/records")).json()) as {
    problems: { id: string; P: number }[];
  };
  const P = Math.max(...listed.problems.filter((p) => p.id.startsWith("boundary/tesseract/ball/")).map((p) => p.P));
  const last = `boundary/tesseract/ball/${P}`;
  await page.goto("about:blank");
  await page.goto("/spaces/boundary.html#id=boundary/tesseract/ball/9999");
  await shown(page, last);
  await expect(page.locator("#viewer-status")).toHaveText(
    `boundary/tesseract/ball/9999 is not in the catalogue, so ${last} is shown.`,
  );
  await expect(page).toHaveURL(new RegExp(`#id=${last}$`));
  expect(errors).toEqual([]);
});

test("the viewer shows a site entry when the problem has one, and the research record on request", async ({ page }) => {
  const id = "boundary/tesseract/ball/7";
  // a site entry 1% larger than the record (the server keeps only better ones, so the answer is extended here)
  await page.route(`**/api/spaces/boundary/problems/${id}`, async (route) => {
    const r = await route.fetch();
    const body = (await r.json()) as SpaceProblemResponse;
    const c = body.certified_config as { s: number; pieces: { cell: number; u: number[] }[] };
    const site = { s: c.s * 1.01, pieces: c.pieces.map((p) => ({ ...p, u: p.u.map((x) => x * 1.01) })) };
    await route.fulfill({
      response: r,
      json: {
        ...body,
        site_best: { id: 5, score: site.s, name: "E2E viewer", created_at: "2026-10-25T10:00:00Z" },
        site_config: site,
      },
    });
  });
  await page.goto(`/spaces/boundary.html#id=${id}`);
  await shown(page, id);
  const record = (await page.locator("#viewer-score").textContent())!;
  // the better packing first: the research record
  await expect(page.locator("#viewer-packing")).toHaveValue("certified");
  await expect(page.locator('#viewer-packing option[value="site"]')).toBeEnabled();
  await page.selectOption("#viewer-packing", "site");
  await expect(page.locator("#viewer-shown")).toHaveText("the site's best entry, by E2E viewer");
  await expect(page.locator("#viewer-score")).toHaveText((Number(record) * 1.01).toFixed(6));
  await expect(page.locator("#viewer-facts")).toContainText("E2E viewer, 2026-10-25");
  await expect(page.locator("#viewer-status")).toContainText("the site's best entry, by E2E viewer");
  await page.selectOption("#viewer-packing", "certified");
  await expect(page.locator("#viewer-score")).toHaveText(record);
});

test("the viewer says when the catalogue cannot be read, and Try again reads it", async ({ page }) => {
  await page.route("**/api/spaces/boundary/records", (route) => route.abort());
  await page.goto("/spaces/boundary.html");
  await expect(page.locator("#viewer-busy")).toContainText("The problems of this kind could not be loaded.");
  await page.unroute("**/api/spaces/boundary/records");
  await page.click("#viewer-retry");
  await shown(page, "boundary/tesseract/ball/9");
  await expect(page.locator("#viewer-busy")).toBeHidden();
});

for (const scheme of ["light", "dark"] as const) {
  test(`the viewer has no automatic accessibility violations (${scheme})`, async ({ browser }) => {
    const page = await (await browser.newContext({ colorScheme: scheme })).newPage();
    const errors = pageErrors(page);
    await page.goto("/spaces/boundary.html#id=boundary/tesseract/cube/9");
    await shown(page, "boundary/tesseract/cube/9");
    for (const view of ["Cells", "Net", "Slice"]) {
      await button(page, view).click();
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(
        results.violations.map((v) => `${view}: ${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`),
      ).toEqual([]);
    }
    await page.locator("details summary", { hasText: "How to read the drawing" }).click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.map((v) => `${v.id} ${v.nodes[0].html.slice(0, 80)}`)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
