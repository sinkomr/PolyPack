/**
 * Build the standalone viewer packages/sphere/viz/index.html from data/sphere/records.json.
 *   npx tsx packages/sphere/scripts/build-viz.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const data = JSON.parse(readFileSync(join(root, "data/sphere/records.json"), "utf8"));
const slim = {
  generated: data.generated,
  records: data.records.map((r: any) => ({
    id: r.id,
    N: r.N,
    P: r.P,
    display: r.display,
    score_float: r.score_float,
    score_cert: r.score_cert,
    gap_rel: r.gap_rel,
    density_float: r.density_float,
    status: r.status,
    bound: r.bound ? { kind: r.bound.kind, value: r.bound.value } : null,
    literature: r.literature,
    notes: r.notes,
    config: { pieces: r.config.pieces },
  })),
};
const tpl = readFileSync(join(here, "../viz/template.html"), "utf8");
const json = JSON.stringify(slim).replace(/</g, "\\u003c");
writeFileSync(join(here, "../viz/index.html"), tpl.replace("__DATA__", () => json));
console.log(`viewer: ${slim.records.length} records`);
