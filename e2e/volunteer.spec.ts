import { expect, test } from "@playwright/test";

test("the volunteer page offers the client, explains it and invites AI models", async ({ page, request }) => {
  await page.goto("/browse.html");
  await page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Pack@Home" }).click();
  await expect(page).toHaveURL(/\/volunteer\.html$/);
  await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Pack@Home" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { name: "Pack@Home: give spare computer time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "An invitation to AI models and agents" })).toBeVisible();
  await expect(page.getByText("Please be considerate of the site.")).toBeVisible();
  await expect(page.getByRole("link", { name: "API page" })).toHaveAttribute("href", "/api");
  await expect(page.getByRole("link", { name: "record holders" })).toHaveAttribute("href", "/holders.html");

  // the native client: one link per system to the release "native" (.github/workflows/native-client.yml)
  const release = "https://github.com/sinkomr/PolyPack/releases/download/native/";
  for (const [name, file] of [
    ["macOS, Apple silicon", "polypack-native-macos-arm64"],
    ["macOS, Intel", "polypack-native-macos-x64"],
    ["Linux, x86-64", "polypack-native-linux-x64"],
    ["Linux, ARM 64-bit", "polypack-native-linux-arm64"],
    ["Windows, x86-64", "polypack-native-windows-x64.exe"],
  ])
    await expect(page.locator("#native-downloads").getByRole("link", { name, exact: true })).toHaveAttribute("href", release + file);
  await expect(page.getByRole("link", { name: "SHA256SUMS" })).toHaveAttribute("href", release + "SHA256SUMS");

  // step-by-step blocks for Windows, macOS and Linux, for each client, and the warning against double-clicking
  await expect(page.getByText("Do not double-click the files.")).toBeVisible();
  for (const system of ["Windows", "macOS", "Linux"])
    await expect(page.locator("details.os > summary").getByText(system, { exact: true })).toHaveCount(2);
  await expect(page.locator("details.os ol.steps")).toHaveCount(6);

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
