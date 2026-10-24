/**
 * Build the standalone curvature-sweep viewer packages/curved/viz/sweep.html from
 * data/curved/sweep/viewer.json (written by python/curved/sweep_curate.py) and viz/sweep-template.html.
 *   npx tsx packages/curved/scripts/sweep/build-sweep-viz.ts [viewer.json] [out.html]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const src = process.argv[2] ?? join(root, "data/curved/sweep/viewer.json");
const out = process.argv[3] ?? join(here, "../../viz/sweep.html");
const data = JSON.parse(readFileSync(src, "utf8"));
const tpl = readFileSync(join(here, "../../viz/sweep-template.html"), "utf8");
const json = JSON.stringify(data).replace(/</g, "\\u003c");
writeFileSync(out, tpl.replace("__DATA__", () => json));
console.log(`sweep viewer: ${data.problems.length} problems, ${(json.length / 1e6).toFixed(2)} MB -> ${out}`);
