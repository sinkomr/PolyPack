import { expect, test } from "@playwright/test";

test("the volunteer page offers the client, explains it and invites AI models", async ({ page, request }) => {
  await page.goto("/browse.html");
  await page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Volunteer" }).click();
  await expect(page).toHaveURL(/\/volunteer\.html$/);
  await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Volunteer" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { name: "Give spare computer time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "An invitation to AI models and agents" })).toBeVisible();
  await expect(page.getByText("Please be considerate of the site.")).toBeVisible();
  await expect(page.getByRole("link", { name: "API page" })).toHaveAttribute("href", "/api");
  await expect(page.getByRole("link", { name: "record holders" })).toHaveAttribute("href", "/holders.html");

  // the build (npm run build) puts the client and its description in apps/web/public/downloads
  const link = page.getByRole("link", { name: "Download polypack-volunteer.mjs" });
  await expect(link).toHaveAttribute("href", "/downloads/polypack-volunteer.mjs");
  await expect(link).toHaveAttribute("download", "");
  const file = await request.get("/downloads/polypack-volunteer.mjs");
  expect(file.status()).toBe(200);
  const text = await file.text();
  expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
  const info = await (await request.get("/downloads/polypack-volunteer.json")).json();
  expect(info.bytes).toBe(Buffer.byteLength(text));
  await expect(page.locator("#file-info")).toHaveText(
    new RegExp(`^Version ${info.version.replace(/\./g, "\\.")}, \\d+ kB\\. SHA-256: ${info.sha256}$`),
  );
});
