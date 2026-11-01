import { expect, test } from "@playwright/test";
import type { HolderResponse } from "@polypack/geometry";

const NAME = "Holder Page Test";

/** n heptagons side by side, far enough apart not to touch, in a container of M sides. */
const heptagons = (M: number, P: number) => ({
  N: 7,
  M,
  P,
  container_phi: 0,
  name: NAME,
  pieces: Array.from({ length: P }, (_, i) => ({ x: 3 * i, y: 0, theta: 0 })),
});

test("a name on the holders page leads to the page of what it holds, and a pair to its records", async ({
  page,
  request,
}) => {
  // heptagons in an 11-gon (two problems) and in a 12-gon (one): problems no other test enters
  for (const [M, P] of [
    [11, 2],
    [11, 3],
    [12, 2],
  ] as const) {
    const sent = await request.post("/api/submit", { data: { ...heptagons(M, P), found_with: "hand" } });
    expect((await sent.json()).leader).toBe(true);
  }

  await page.goto("/holders.html");
  const cell = page.locator("#rows tr", { hasText: NAME }).locator("td.name");
  await expect(cell.getByRole("link", { name: NAME })).toHaveAttribute(
    "href",
    "/holder.html?name=Holder%20Page%20Test",
  );
  await cell.getByRole("link", { name: NAME }).click();

  await expect(page).toHaveURL(/\/holder\.html\?name=Holder(%20|\+)Page(%20|\+)Test$/);
  await expect(page.getByRole("heading", { name: `Records held by ${NAME}` })).toBeVisible();
  await expect(page).toHaveTitle(`PolyPack — Records held by ${NAME}`);
  await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Records" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("#note")).toHaveText(
    `${NAME} leads 3 problems in 2 pairs of shapes; 3 of these are records.`,
  );
  await expect(page.locator("#asof")).toHaveText(
    /^As of \d{1,2}:\d{2}.* This list refreshes at most every 15 minutes\.$/,
  );
  // the pair in words, problems led, records, beat published, awaiting review, and the values of P
  const rows = page.locator("#rows tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td")).toHaveText(["7-gons in an 11-gon", "2", "2", "0", "0", "2–3"]);
  await expect(rows.nth(1).locator("td")).toHaveText(["7-gons in a 12-gon", "1", "1", "0", "0", "2"]);

  // the pair leads to the records of the pair, where the name leads back
  const pair = rows.nth(0).getByRole("link", { name: "7-gons in an 11-gon" });
  await expect(pair).toHaveAttribute("href", "/browse.html#7,11");
  await pair.click();
  await expect(page).toHaveURL(/\/browse\.html#7,11$/);
  await expect(page.locator("#n-select")).toHaveValue("7");
  await expect(page.locator("#m-select")).toHaveValue("11");
  const entry = page.locator("#rows tr", { hasText: NAME }).first();
  const by = entry.locator("td").nth(2);
  await expect(by).toHaveText(`${NAME} (by hand)`);
  // the link is the name alone; how the packing was found stays outside it
  await expect(by.getByRole("link")).toHaveText(NAME);
  await expect(by.getByRole("link")).toHaveAttribute("href", "/holder.html?name=Holder%20Page%20Test");
  await by.getByRole("link").click();
  await expect(page.getByRole("heading", { name: `Records held by ${NAME}` })).toBeVisible();
  await expect(page.locator("#rows tr")).toHaveCount(2);
});

test("a name that holds nothing, no name, and an unreachable server each get a message", async ({ page }) => {
  await page.goto("/holder.html?name=Nobody%20holds%20this");
  await expect(page.getByRole("heading", { name: "Records held by Nobody holds this" })).toBeVisible();
  await expect(page.locator("#note")).toContainText("This name leads no problem at the moment.");
  await expect(page.locator("#results")).toBeHidden();
  await expect(page.locator("#asof")).toBeHidden();

  await page.goto("/holder.html");
  await expect(page.locator("#note")).toContainText("No name given.");
  await expect(page.locator("#note").getByRole("link", { name: "record holders page." })).toHaveAttribute(
    "href",
    "/holders.html",
  );
  await expect(page.locator("#results")).toBeHidden();

  await page.goto("/holder.html?name=");
  await expect(page.locator("#note")).toContainText("No name given.");

  await page.route(/\/api\/holder\?/, (route) => route.abort());
  await page.goto("/holder.html?name=ann");
  await expect(page.locator("#note")).toHaveText("The server is not reachable.");
  await expect(page.locator("#results")).toBeHidden();

  await page.unroute(/\/api\/holder\?/);
  await page.route(/\/api\/holder\?/, (route) => route.fulfill({ status: 400, json: { error: "too long" } }));
  await page.goto("/holder.html?name=ann");
  await expect(page.locator("#note")).toHaveText("The server does not take this as a name.");
});

test("a name is only ever shown as text", async ({ page }) => {
  const name = `<img src=x onerror="window.pwned = 1"> & <b>bold</b>`;
  const answer: HolderResponse = {
    name,
    records: 1,
    beat_published: 0,
    site_bests: 1,
    pending: 0,
    computed_at: "2026-11-01T14:05:00.000Z",
    pairs: [{ N: 4, M: 4, P: [3], records: 1, beat_published: 0, pending: 0 }],
  };
  await page.route(/\/api\/holder\?/, (route) => route.fulfill({ json: answer }));
  await page.goto(`/holder.html?name=${encodeURIComponent(name)}`);
  await expect(page.locator("#title")).toHaveText(`Records held by ${name}`);
  await expect(page.locator("#note")).toContainText(name);
  await expect(page.locator("main img, main b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test("thousands of pairs are listed at once, in runs of P", async ({ page }) => {
  // squares to 70-gons in every container from 3 to 74 sides: 5,040 pairs
  const pairs: HolderResponse["pairs"] = [];
  for (let N = 3; N <= 72; N++)
    for (let M = 3; M <= 74; M++) {
      const P =
        N === 4 && M === 4 ? Array.from({ length: 480 }, (_, i) => i + 1).filter((p) => p % 7 !== 0) : [1, 2, 3, 9];
      pairs.push({ N, M, P, records: P.length, beat_published: 0, pending: 0 });
    }
  // the server sends the pair with most problems first, then by N, then by M
  pairs.sort((a, b) => b.P.length - a.P.length || a.N - b.N || a.M - b.M);
  const total = pairs.reduce((n, p) => n + p.P.length, 0);
  const answer: HolderResponse = {
    name: "Busy",
    records: total,
    beat_published: 0,
    site_bests: total,
    pending: 0,
    computed_at: "2026-11-01T14:05:00.000Z",
    pairs,
  };
  let sent = 0;
  await page.route(/\/api\/holder\?/, (route) => {
    sent = Date.now();
    return route.fulfill({ json: answer });
  });
  await page.goto("/holder.html?name=Busy");
  await expect(page.locator("#rows tr")).toHaveCount(5040);
  // from the answer to the last row, with the wait of the test's polling in it
  expect(Date.now() - sent).toBeLessThan(3000);
  await expect(page.locator("#rows tr").first().locator("td")).toHaveText([
    "squares in a square",
    "412",
    "412",
    "0",
    "0",
    /^1–6, 8–13, 15–20,/,
  ]);
  await expect(page.locator("#rows tr").nth(1).locator("td").last()).toHaveText("1–3, 9");
  await expect(page.locator("#note")).toContainText("in 5,040 pairs of shapes");
});
