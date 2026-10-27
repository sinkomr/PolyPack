import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// one address per tab, as its link makes it: the other kinds of a dimension are reached from its kind links
const TABS = [
  { dimension: "2D in 2D", kind: "Curved", hash: "#space=curved&K=-1&N=3&M=8" },
  { dimension: "2D on 3D", kind: "Sphere", hash: "#space=sphere&N=0" },
  { dimension: "2D on 3D", kind: "Torus", hash: "#space=torus&family=hex&N=0" },
  { dimension: "2D on 3D", kind: "Surfaces", hash: "#space=surface&solid=cube&mode=fold&N=0" },
  { dimension: "3D in 3D", kind: "Polyhedra", hash: "#space=polyhedra&code=cubincub" },
  { dimension: "3D in 3D", kind: "Balls", hash: "#space=balls&code=ballinball" },
  { dimension: "3D on 4D", kind: null, hash: "#space=boundary&polytope=tesseract&piece=ball" },
];

test("each dimension's tab shows its kinds with a table and a chart", async ({ page }) => {
  await page.goto("/browse.html#4,4");
  const tabs = page.getByRole("navigation", { name: "Dimension" });
  await expect(tabs.getByRole("link", { name: "2D in 2D" })).toHaveAttribute("aria-current", "page");
  // the polygons' page is unchanged: its table and its address still work
  await expect(page.locator("#rows tr").first()).toBeVisible();
  for (const d of ["2D on 3D", "3D in 3D", "3D on 4D"]) {
    await page.goto("/browse.html#4,4");
    await tabs.getByRole("link", { name: d }).click();
    await expect(page).toHaveURL(/\/records\.html#space=/);
    await expect(tabs.getByRole("link", { name: d })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#rec-rows tr").first()).toBeVisible();
  }
  for (const t of TABS) {
    await page.goto(`/records.html${t.hash}`);
    await expect(tabs.getByRole("link", { name: t.dimension })).toHaveAttribute("aria-current", "page");
    if (t.kind)
      await expect(page.getByRole("navigation", { name: "Kind" }).getByRole("link", { name: t.kind })).toHaveAttribute(
        "aria-current",
        "page",
      );
    await expect(page.locator("#pickers select").first()).toBeVisible();
    // balls have no records yet: their chart is drawn with its axes and says so
    if (t.kind === "Balls") {
      await expect(page.locator("#chart")).toContainText("No record or entry yet");
      await expect(page.locator("#table-note")).toContainText("No problem of this family has a record");
      continue;
    }
    await expect(page.locator("#rec-rows tr").first()).toBeVisible();
    // a run of P without a record breaks the line, so a chart has one line per run
    await expect(page.locator("#chart polyline.record").first()).toBeVisible();
    await expect(page.locator("#chart .lit-mark, #chart .proven-mark").first()).toBeVisible();
    await expect(page.locator("#chart-gap polyline.bound").first()).toBeAttached();
  }
});

test("a deep link names the problem, pickers change it, and Back returns to the last tab", async ({ page }) => {
  await page.goto("/records.html#space=torus&family=hex&N=0");
  await expect(page.locator("#pick-family")).toHaveValue("hex");
  await expect(page.locator("#rec-rows tr").first()).toContainText("1");
  await expect(page.locator("#chart-title")).toContainText("hexagonal, disk");
  await page.selectOption("#pick-family", "sq");
  await expect(page).toHaveURL(/family=sq/);
  await expect(page.locator("#chart-title")).toContainText("square, disk");
  // a table of every record of the kind, and a link back to a problem's chart
  await page.getByLabel("Every record of the kind").check();
  await expect(page).toHaveURL(/all=1/);
  await expect(page.locator("#rec-rows tr").nth(30)).toBeVisible();
  // hover and keyboard describe a point
  await page.getByLabel("This family").check();
  await page.locator("#chart").focus();
  await page.keyboard.press("Home");
  await expect(page.locator("#chart ~ .chart-tip")).toContainText("P = 1");
  // tabs are addresses of their own: Back returns to the previous one
  await page.getByRole("navigation", { name: "Dimension" }).getByRole("link", { name: "3D on 4D" }).click();
  await expect(page).toHaveURL(/space=boundary/);
  await page.goBack();
  await expect(page).toHaveURL(/space=torus/);
  await expect(page.locator("#chart-title")).toContainText("square, disk");
});

test("phone width: no page scroll on any tab, and the table scrolls in its own box", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const t of [{ hash: "" }, ...TABS]) {
    await page.goto(`/records.html${t.hash}`);
    await expect(page.locator("#pickers select").first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      t.hash,
    ).toBeLessThanOrEqual(1);
  }
  await page.goto("/records.html#space=surface&solid=cube&mode=fold&N=0");
  const wrap = page.locator(".table-wrap");
  await expect(wrap.locator("tbody tr").first()).toBeVisible();
  expect(await wrap.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  test(`no automatic accessibility violations on any tab at phone width (${scheme})`, async ({ browser }) => {
    const page = await (
      await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 844 } })
    ).newPage();
    for (const t of TABS) {
      await page.goto(`/records.html${t.hash}`);
      await expect(page.locator("#pickers select").first()).toBeVisible();
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(
        results.violations.map((v) => `${t.hash}: ${v.id} (${v.nodes.length}) ${v.nodes[0].html.slice(0, 80)}`),
      ).toEqual([]);
    }
  });
}

test("each kind's problems are fetched once however fast the tabs change", async ({ page }) => {
  const counts: Record<string, number> = {};
  await page.route("**/api/spaces/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    counts[path] = (counts[path] ?? 0) + 1;
    return route.continue();
  });
  await page.goto("/records.html#space=surface");
  const kinds = page.getByRole("navigation", { name: "Kind" });
  await kinds.getByRole("link", { name: "Sphere" }).click();
  await kinds.getByRole("link", { name: "Surfaces" }).click();
  await kinds.getByRole("link", { name: "Torus" }).click();
  await kinds.getByRole("link", { name: "Surfaces" }).click();
  await expect(page.locator("#chart-title")).toContainText("cube");
  await expect(page.locator("#rec-rows tr").first()).toBeVisible();
  for (const path of ["/api/spaces/surface/records", "/api/spaces/surface/site-only", "/api/spaces/sphere/records"])
    expect(counts[path] ?? 0, path).toBeLessThanOrEqual(1);
});

test("zoom stays where it is when a request is too narrow, and the table has no empty scroll box", async ({ page }) => {
  await page.goto("/records.html#space=sphere&N=0");
  const chart = page.locator("#chart");
  await chart.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("+");
  const range = page.locator("#chart-range");
  await expect(range).toContainText("P = ");
  const before = await range.textContent();
  // halving again and again narrows the range; once it is under two P wide the zoom stays
  for (let i = 0; i < 8; i++) await page.keyboard.press("+");
  await expect(range).toContainText("P = ");
  expect(before).not.toBe("");
  await page.keyboard.press("0");
  await expect(range).toHaveText("");
  // balls have no records: no rows, no scroll box
  await page.goto("/records.html#space=balls&code=ballinball");
  await expect(page.locator("#table-note")).toContainText("No problem of this family");
  await expect(page.locator("#rec-wrap")).toBeHidden();
});

test("a row's gap is the shown record minus the shown bound, a curved caption says K = value, and other hashes go to the polygons", async ({
  page,
}) => {
  await page.goto("/records.html#space=curved&K=-1&N=3&M=8");
  await expect(page.locator("#chart-title")).toContainText("K = −1, triangle, octagon");
  const rows = page.locator("#rec-rows tr");
  await expect(rows.first()).toBeVisible();
  for (let i = 0; i < Math.min(await rows.count(), 12); i++) {
    const cells = await rows.nth(i).locator("td").allTextContents();
    // P, record, status, held by, lower bound, gap, links
    const record = Number(cells[1]);
    const bound = Number(cells[4].match(/^−?\d+\.\d{6}/)?.[0].replace("−", "-"));
    const gap = Number(cells[5].replace("−", "-"));
    if (Number.isFinite(record) && Number.isFinite(bound) && Number.isFinite(gap))
      expect(Math.round((record - bound) * 1e6), cells.join("|")).toBe(Math.round(gap * 1e6));
  }
  // the polygons' page takes the hash on (and puts a hash it cannot read right itself)
  await page.goto("/records.html#0,4");
  await expect(page).toHaveURL(/\/browse\.html#0,4$/);
  for (const hash of ["#space=polygon", "#space=nowhere"]) {
    await page.goto(`/records.html${hash}`);
    await expect(page).toHaveURL(/\/browse\.html#/);
  }
});
