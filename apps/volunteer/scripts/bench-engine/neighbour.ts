/**
 * Neighbour starts: the P+1 literature packing minus its best piece (seed record_minus_one) and
 * the P-1 packing plus one piece (record_plus_one), each then shrink_repair for `budget` CPU
 * seconds, against shrink_repair from scratch. Panel problems whose neighbours have coordinates
 * in data/records.json.
 *   npx tsx apps/volunteer/scripts/bench-engine/neighbour.ts [budget] [only]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: cpuMs } });
const { run } = await import("@polypack/solver");

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = JSON.parse(fs.readFileSync(path.join(here, "panel.json"), "utf8"));
const recs = new Map<string, { pieces?: unknown[]; container_phi?: number; value: number }>();
for (const r of JSON.parse(fs.readFileSync(path.join(here, "../../../../data/records.json"), "utf8")).records)
  recs.set(`${r.N}/${r.M}/${r.P}`, r);
const budget = Number(process.argv[2] ?? 10);
const only = process.argv[3]?.split(",");
for (const p of panel) {
  const id = `${p.N}/${p.M}/${p.P}`;
  if (only && !only.includes(id)) continue;
  const ref = Math.min(p.literature, p.site_best ?? Infinity);
  const problem = { N: p.N, M: p.M, P: p.P };
  const out = [id.padEnd(10)];
  for (const [kind, dP] of [
    ["record_minus_one", 1],
    ["record_plus_one", -1],
  ] as const) {
    const r = recs.get(`${p.N}/${p.M}/${p.P + dP}`);
    if (!r?.pieces) {
      out.push(`${kind}: none`);
      continue;
    }
    const record = { N: p.N, M: p.M, P: p.P + dP, pieces: r.pieces, container_phi: r.container_phi ?? 0 };
    const t = cpuMs();
    const s = await run(problem, {
      method: "seed",
      params: { kind, record },
      seed: 1,
      budget: { evals: 400, time_s: 20 },
    });
    const seedGap = s.score === null ? NaN : (100 * (s.score - ref)) / ref;
    const sr = s.best
      ? await run(problem, { method: "shrink_repair", seed: 1, start: s.best, budget: { time_s: budget } })
      : null;
    const srGap = sr?.strict && sr.score !== null ? (100 * (sr.score - ref)) / ref : NaN;
    out.push(`${kind}: seed ${seedGap.toFixed(3)}% -> sr ${srGap.toFixed(3)}% (${((cpuMs() - t) / 1000).toFixed(1)}s)`);
  }
  console.log(out.join("  "));
}
