import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Page, type Route, expect, test } from "@playwright/test";
import { SPACE_INFO, type SpaceProblemResponse, type SpaceRecordsResponse } from "@polypack/spaces";
import { LAZY_VIEW, distinctColours, pageErrors } from "./helpers";

// The board's drawing and search on the surfaces beyond the Platonic solids. Those problems have no
// research records yet, so this test serves three of the certifier's test packings
// (python/surface/fixtures/general_packings.json) as if they were records: a Catalan solid, a prism
// and an antiprism. SURFACE_SHOTS, when set, names a folder for screenshots of the drawings.

const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, "../python/surface/fixtures/general_packings.json"), "utf8"),
).records as { id: string; solid: string; mode: string; N: number; P: number; s: number; pieces: unknown[] }[];
const SHOWN = [
  "surface/deltoidal_icositetrahedron/fold/6/3",
  "surface/prism5/fold/3/3",
  "surface/antiprism4/fold/6/3",
  "surface/rhombic_dodecahedron/nofold/6/14",
  "surface/prism7/fold/100/2",
];
const served = SHOWN.map((id) => fixtures.find((r) => r.id === id)!);

function summary(r: (typeof fixtures)[number]) {
  return {
    space: "surface" as const,
    id: r.id,
    fields: { solid: r.solid, mode: r.mode, N: r.N, P: r.P },
    P: r.P,
    certified: { score: r.s, display: r.s.toFixed(6), status: "best_known" as const },
    bound: null,
    site_best: null,
    best_score: r.s,
    accepts_submissions: true,
    status: "best_known" as const,
    closed_reason: null,
  };
}

async function serve(page: Page): Promise<void> {
  await page.route("**/api/spaces/surface/records", async (route: Route) => {
    const r = await route.fetch();
    const body = (await r.json()) as SpaceRecordsResponse;
    await route.fulfill({ response: r, json: { ...body, problems: [...body.problems, ...served.map(summary)] } });
  });
  for (const r of served)
    await page.route(`**/api/spaces/surface/problems/${r.id}`, (route) => {
      const json: SpaceProblemResponse = {
        ...summary(r),
        conventions: SPACE_INFO.surface.conventions,
        certified_config: { s: r.s, pieces: r.pieces },
        site_config: null,
      };
      return route.fulfill({ json });
    });
}

async function shot(page: Page, name: string): Promise<void> {
  const png = await page.locator(".space-draw").screenshot();
  expect(await distinctColours(page, png)).toBeGreaterThan(8);
  if (process.env.SURFACE_SHOTS) await page.locator(".space-view").screenshot({ path: join(process.env.SURFACE_SHOTS, `${name}.png`) });
}

test("the board draws a Catalan solid, a prism and an antiprism, as the solid and as a net", async ({ page }) => {
  const errors = pageErrors(page);
  await serve(page);
  for (const r of served.slice(0, 3)) {
    await page.goto(`/#space=${r.id}`);
    await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${r.id}`, LAZY_VIEW);
    await expect(page.locator("#space-score")).toHaveText(r.s.toFixed(6));
    await expect(page.locator(".space-draw > canvas")).toBeVisible();
    await expect(page.locator(".space-draw")).toHaveAttribute(
      "aria-label",
      /on a (deltoidal icositetrahedron|pentagonal prism|square antiprism) of (scale|edge) /,
    );
    await shot(page, `${r.solid}-solid`);
    await page.click('.space-tools button[data-view="net"]');
    await shot(page, `${r.solid}-net`);
    await page.click('.space-tools button[data-view="solid"]');
  }
  // a 100-gon, as in 2D in 2D's range of pieces
  const big = served[4];
  await page.goto(`/#space=${big.id}`);
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${big.id}`, LAZY_VIEW);
  await expect(page.locator(".space-draw")).toHaveAttribute("aria-label", /^2 100-gons on a heptagonal prism/);
  await shot(page, "prism7-100gons-solid");
  expect(errors).toEqual([]);
});

test("the problem picker groups the solids by family, in order", async ({ page }) => {
  await serve(page);
  await page.goto(`/#space=${SHOWN[1]}`);
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${SHOWN[1]}`, LAZY_VIEW);
  const groups = await page.locator("#space-f-solid optgroup").evaluateAll((gs) => gs.map((g) => (g as HTMLOptGroupElement).label));
  expect(groups).toEqual(["Platonic solids", "Catalan solids", "Prisms", "Antiprisms"]);
  await expect(page.locator('#space-f-solid optgroup[label="Prisms"] option')).toHaveText(["Pentagonal prism", "Heptagonal prism"]);
  await expect(page.locator('#space-f-solid optgroup[label="Platonic solids"] option')).toHaveText([
    "Tetrahedron",
    "Cube",
    "Octahedron",
    "Dodecahedron",
    "Icosahedron",
  ]);
  await expect(page.locator("#space-f-solid")).toHaveValue("prism5");
  // a Platonic problem is one choice away, and back
  await page.selectOption("#space-f-solid", "cube");
  await expect(page.locator("#space-problem-note")).toHaveText(/^Problem surface\/cube\//);
  await page.selectOption("#space-f-solid", "antiprism4");
  await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${SHOWN[2]}`);
});

test("a search round runs on a prism with folding and on a Catalan solid without", async ({ page }) => {
  test.setTimeout(180_000);
  await serve(page);
  for (const id of [SHOWN[1], SHOWN[3]]) {
    await page.goto(`/#space=${id}`);
    await expect(page.locator("#space-problem-note")).toHaveText(`Problem ${id}`, LAZY_VIEW);
    await page.selectOption("#space-solve-budget", "evals");
    await page.fill("#space-solve-evals", "2");
    await page.fill("#space-solve-seed", "1");
    await page.click("#space-solve-run");
    await expect(page.locator("#space-solve-stop")).toBeDisabled({ timeout: 120_000 });
    await expect(page.locator("#space-solve-run")).toBeEnabled();
    await expect(page.locator("#space-solve-score")).toHaveText(/^\d+\.\d{6}$/);
    if (id === SHOWN[3]) await shot(page, "rhombic_dodecahedron-nofold-result");
  }
});
