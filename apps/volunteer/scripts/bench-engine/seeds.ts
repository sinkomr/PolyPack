/**
 * Start quality: the `seed` method (kind auto) at 24 evaluations (shrink_repair's slice) and at
 * 400, with and without the final polish, against the reference, for every panel problem.
 *   npx tsx apps/volunteer/scripts/bench-engine/seeds.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@polypack/solver";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = JSON.parse(fs.readFileSync(path.join(here, "panel.json"), "utf8"));
for (const p of panel) {
  const ref = Math.min(p.literature, p.site_best ?? Infinity);
  const out: string[] = [`${p.N}/${p.M}/${p.P}`.padEnd(10)];
  for (const [evals, finalPolish] of [
    [24, false],
    [400, false],
    [400, true],
  ] as const) {
    const t = performance.now();
    const r = await run(
      { N: p.N, M: p.M, P: p.P },
      { method: "seed", params: { kind: "auto" }, seed: 1, budget: { evals, time_s: 30 }, finalPolish },
    );
    const gap = r.score === null ? NaN : (100 * (r.score - ref)) / ref;
    out.push(
      `${evals}${finalPolish ? "+pol" : ""}: ${gap.toFixed(3)}% (${((performance.now() - t) / 1000).toFixed(1)}s)`,
    );
  }
  console.log(out.join("  "));
}
