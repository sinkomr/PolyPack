// Fails when a data file that record suites read is missing or unreadable. Those suites skip
// themselves when their file is absent (describe.skipIf / skipTest), so on CI a missing
// checkout would otherwise pass silently with less coverage.
import { readFileSync } from "node:fs";

const required = [
  "data/polyhedra/records.json",
  "data/sphere/records.json",
  "data/torus/records.json",
  "data/curved/records.json",
  "data/boundary/records.json",
  "data/corpus/N3-M3-P6.json",
  "python/polyhedra/fixtures/crosscheck.json",
];

const root = new URL("../", import.meta.url);
let bad = 0;
for (const path of required) {
  try {
    const text = readFileSync(new URL(path, root), "utf8");
    const doc = JSON.parse(text);
    if (doc === null || typeof doc !== "object") throw new Error("not a JSON object or array");
  } catch (e) {
    bad++;
    console.error(`missing or unreadable fixture ${path}: ${e.message}`);
  }
}
if (bad > 0) process.exit(1);
console.log(`${required.length} required data fixtures present`);
