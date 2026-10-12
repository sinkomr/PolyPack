import { expect, test } from "@playwright/test";

// The review API is covered by the server tests. Here the page is checked against a canned
// pending entry, because no honest submission beats a published value on demand.
test("the admin page lists pending entries and sends a review", async ({ page }) => {
  const entry = {
    id: 7, N: 4, M: 4, P: 11, name: "<b>Eve</b>", agent: "ai", agent_note: "annealing", score: 3.87,
    created_at: "2026-10-07T12:00:00.000Z", literature_value: 3.87708359002281,
    strict_check: { ok: true, certifiedSize: 3.8700000387, eps: 1e-8 }, pieces: [],
  };
  let reviewed: unknown = null;
  await page.route("**/api/admin/pending", (route) =>
    route.request().headers().authorization === "Bearer good"
      ? route.fulfill({ json: { pending: reviewed ? [] : [entry] } })
      : route.fulfill({ status: 401, json: { error: "unauthorized" } }),
  );
  await page.route("**/api/admin/review", (route) => {
    reviewed = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/admin.html");
  await page.fill("#token", "bad");
  await page.click("#load");
  await expect(page.locator("#note")).toHaveText("Wrong token.");
  await page.fill("#token", "good");
  await page.click("#load");
  const row = page.locator("#rows tr");
  await expect(row).toContainText("11 squares in a square");
  // names are shown as text, never as markup
  await expect(row).toContainText("<b>Eve</b>");
  await expect(row).toContainText("passed, certified 3.8700000387");
  await row.getByRole("button", { name: "Reject" }).click();
  await expect(page.locator("#note")).toHaveText("Nothing is pending.");
  expect(reviewed).toEqual({ id: 7, decision: "rejected" });
});

test("the real admin API refuses a wrong token", async ({ request }) => {
  expect((await request.get("/api/admin/pending", { headers: { authorization: "Bearer nope" } })).status()).toBe(401);
  expect((await request.get("/api/admin/pending", { headers: { authorization: "Bearer e2e-token" } })).status()).toBe(200);
});
