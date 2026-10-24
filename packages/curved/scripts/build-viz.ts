/**
 * Build the standalone viewer packages/curved/viz/index.html from data/curved/records.json.
 *   npx tsx packages/curved/scripts/build-viz.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const data = JSON.parse(readFileSync(join(root, "data/curved/records.json"), "utf8"));
const slim = {
  generated: data.generated,
  catalogue: data.catalogue,
  records: data.records
    .filter((r: any) => r.config)
    .map((r: any) => ({
      id: r.id,
      K: r.K,
      N: r.N,
      M: r.M,
      P: r.P,
      display: r.display,
      score_float: r.score_float,
      certified: r.certified,
      config: r.config,
      bound: r.bound,
      euclidean_record: r.euclidean_record,
      sensitivity: r.sensitivity ? { dsdK_envelope: r.sensitivity.dsdK_envelope } : null,
      notes: r.notes,
    })),
};
const tpl = readFileSync(join(here, "../viz/template.html"), "utf8");
const json = JSON.stringify(slim).replace(/</g, "\\u003c");
writeFileSync(
  join(here, "../viz/index.html"),
  tpl.replace("__DATA__", () => json),
);
console.log(`viewer: ${slim.records.length} records`);
