import AxeBuilder from "@axe-core/playwright";
import { APIRequestContext, Page, expect, test } from "@playwright/test";
import type {
  SpaceName,
  SpaceProblemResponse,
  SpaceProblemSummary,
  SpaceRecordsResponse,
  SpacesResponse,
} from "@polypack/spaces";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SPACE_VIEWERS } from "../apps/web/scripts/space-viewers";
import { filterProblems, settleFilters } from "../apps/web/src/spaces-model";

// The spaces page against the local stack (playwright.config.ts): the server lists the research
// records of data/<space>/records.json, and the web server serves the viewers from packages/*/viz.

const root = resolve(import.meta.dirname, "..");
const SPACES: SpaceName[] = ["surface", "curved", "sphere", "torus"];

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const r = await request.get(url);
  expect(r.status(), url).toBe(200);
  return (await r.json()) as T;
}

const rows = (page: Page) => page.locator("#space-rows tr");
const rowIds = (page: Page) => rows(page).evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).dataset.id));

test("the spaces page lists the four spaces and the exhibit, and says what its values mean", async ({
  page,
  request,
}) => {
  const api = await getJson<SpacesResponse>(request, "/api/spaces");
  expect(api.spaces.map((s) => s.space)).toEqual(SPACES);

  await page.goto("/browse.html");
  const nav = page.getByRole("navigation", { name: "Site" });
  await nav.getByRole("link", { name: "Spaces" }).click();
  await expect(page).toHaveURL(/\/spaces\.html/);
  await expect(nav.getByRole("link", { name: "Spaces" })).toHaveAttribute("aria-current", "page");

  for (const s of api.spaces) {
    expect(s.viewer).toBe(`/spaces/${s.space}.html`);
    const card = page.locator(`#space-cards > li[data-space="${s.space}"]`);
    await expect(card.getByRole("heading", { name: s.title, exact: true })).toBeVisible();
    await expect(card).toContainText(s.summary);
    await expect(card).toContainText(s.problems.toLocaleString("en-US"));
    await expect(card.getByRole("link", { name: /^Viewer/ })).toHaveAttribute("href", s.viewer);
    await expect(card.getByRole("link", { name: /^Notes/ })).toHaveAttribute("href", s.docs);
  }
  expect(api.exhibits.map((x) => x.viewer)).toContain("/spaces/sweep.html");
  for (const x of api.exhibits) {
    const card = page.locator(`#exhibit-cards > li[data-space="${x.name}"]`);
    await expect(card.getByRole("heading", { name: x.title, exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: /^Viewer/ })).toHaveAttribute("href", x.viewer);
    await expect(card.getByRole("link", { name: /^Notes/ })).toHaveAttribute("href", x.docs);
  }

  const main = page.getByRole("main");
  await expect(main).toContainText("proven valid with interval arithmetic");
  await expect(main.getByRole("link", { name: "API", exact: true })).toHaveAttribute("href", "/api");
  await expect(main.getByRole("link", { name: "volunteer client" })).toHaveAttribute("href", "/volunteer.html");
  await expect(page.locator("#space-head")).toContainText("proven valid by interval arithmetic");
  await expect(page.locator("#space-head")).toContainText("site entry, checked by the server");

  // a card's viewer link opens the viewer
  await page
    .locator('#space-cards > li[data-space="sphere"]')
    .getByRole("link", { name: /^Viewer/ })
    .click();
  await expect(page).toHaveURL(/\/spaces\/sphere\.html$/);
  const html = readFileSync(resolve(root, SPACE_VIEWERS["spaces/sphere.html"]), "utf8");
  await expect(page).toHaveTitle(/<title>([^<]*)<\/title>/.exec(html)![1]);
});

test("the records table loads the problems of each space", async ({ page, request }) => {
  await page.goto("/spaces.html");
  for (const space of SPACES) {
    const data = await getJson<SpaceRecordsResponse>(request, `/api/spaces/${space}/records`);
    expect(data.problems.length).toBeGreaterThan(0);
    await page.locator(`#space-pick input[value="${space}"]`).check();
    // the table starts with the space's default filters
    const filters = settleFilters(space, data.problems);
    const expected = filterProblems(space, data.problems, filters).map((p) => p.id);
    expect(expected.length).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(expected.length);
    expect(await rowIds(page)).toEqual(expected);
    await expect(page).toHaveURL(new RegExp(`#space=${space}&`));
    const first = data.problems.find((p) => p.id === expected[0])!;
    await expect(rows(page).first().locator("td.num").first()).toHaveText(String(first.P));
    if (first.certified) await expect(rows(page).first()).toContainText(first.certified.display);
    // a closed problem says so, with the server's reason when it gives one
    const closed = data.problems.find((p) => expected.includes(p.id) && !p.accepts_submissions) as
      (SpaceProblemSummary & { closed_reason?: string | null }) | undefined;
    if (closed) {
      const row = page.locator(`#space-rows tr[data-id="${closed.id}"]`);
      await expect(row).toContainText("closed");
      if (closed.closed_reason) await expect(row).toContainText(closed.closed_reason.trim(), { ignoreCase: true });
    }
  }
});

test("a filter narrows the table and stays in the address", async ({ page, request }) => {
  const data = await getJson<SpaceRecordsResponse>(request, "/api/spaces/torus/records");
  const hex = data.problems.filter((p) => p.id.startsWith("torus/hex/"));
  expect(hex.length).toBeGreaterThan(0);

  // a card's Records link chooses its space
  await page.goto("/spaces.html");
  await page
    .locator('#space-cards > li[data-space="torus"]')
    .getByRole("link", { name: /^Records/ })
    .click();
  await expect(page.locator('#space-pick input[value="torus"]')).toBeChecked();
  await expect(page.locator("#filter-family")).toBeVisible();

  await page.selectOption("#filter-family", "hex");
  await page.selectOption("#filter-N", "all");
  await expect(rows(page)).toHaveCount(hex.length);
  expect((await rowIds(page)).every((id) => id?.startsWith("torus/hex/"))).toBe(true);
  // the pieces are not fixed by a filter, so a column names them
  await expect(page.locator("#space-head th").first()).toHaveText("Pieces");
  await expect(page).toHaveURL(/#space=torus&family=hex&N=all$/);

  await page.reload();
  await expect(page.locator("#filter-family")).toHaveValue("hex");
  await expect(rows(page)).toHaveCount(hex.length);

  // each row offers its problem with the configurations
  const first = rows(page).first();
  const id = (await first.getAttribute("data-id"))!;
  const link = first.getByRole("link", { name: /^JSON/ });
  await expect(link).toHaveAttribute("href", `/api/spaces/torus/problems/${id}`);
  const problem = await getJson<SpaceProblemResponse>(request, `/api/spaces/torus/problems/${id}`);
  expect(problem.id).toBe(id);
  expect(problem.certified_config).not.toBeNull();
});

test("the viewers are served at /spaces/<name>.html as they are in their packages", async ({ request }) => {
  for (const [published, source] of Object.entries(SPACE_VIEWERS)) {
    const r = await request.get(`/${published}`);
    expect(r.status(), published).toBe(200);
    expect(r.headers()["content-type"], published).toMatch(/^text\/html/);
    expect((await r.body()).equals(readFileSync(resolve(root, source))), published).toBe(true);
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`the spaces page has no automatic accessibility violations (${scheme})`, async ({ browser }) => {
    const page = await (await browser.newContext({ colorScheme: scheme })).newPage();
    for (const hash of ["", "#space=curved&K=1&N=all&M=all", "#space=torus&family=all&N=0"]) {
      await page.goto("about:blank");
      await page.goto(`/spaces.html${hash}`);
      await expect(rows(page).first()).toBeVisible();
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(
        results.violations.map((v) => `${hash}: ${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`),
      ).toEqual([]);
    }
  });
}
