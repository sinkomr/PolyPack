// Headless screenshots of the sweep viewer (development check only).
//   node packages/curved/scripts/sweep/shoot.mjs FILE.html OUTDIR key1,key2,... [dark] [K]
import { chromium } from "playwright";
const [file, outDir, keys, dark, Kstr] = process.argv.slice(2);
const browser = await chromium.launch();
const errors = [];
const page = await browser.newPage({ viewport: { width: 1360, height: 1050 }, colorScheme: dark === "dark" ? "dark" : "light" });
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("file://" + file);
await page.waitForTimeout(400);
for (const key of (keys || "").split(",").filter(Boolean)) {
  const idx = await page.evaluate((k) => DATA.problems.findIndex((p) => p.key === k), key);
  if (idx < 0) continue;
  await page.selectOption("#prob", String(idx));
  if (Kstr) {
    await page.evaluate((K) => { st.K = K; renderAll(); }, Number(Kstr));
  }
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/p-${key}${dark === "dark" ? "-dark" : ""}.png` });
}
if (keys === "atlas") {
  await page.click('#tabs button[data-tab="atlas"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/atlas${dark === "dark" ? "-dark" : ""}.png`, fullPage: true });
}
await browser.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
