/**
 * Fragmentation: shrink_repair for `total` CPU seconds as one run, against a chain of runs of
 * `piece` seconds, each from the previous best (what the engine's iterate arm does).
 *   npx tsx scratch/methods-flat/chain.ts total piece seed id1,id2,...
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
const [total, piece, seed] = process.argv.slice(2, 5).map(Number);
const only = process.argv[5].split(",");
// Parameters of the iterated runs (all but the first), as JSON
const params = process.argv[6] ? JSON.parse(process.argv[6]) : undefined;
for (const p of panel) {
  const id = `${p.N}/${p.M}/${p.P}`;
  if (!only.includes(id)) continue;
  const ref = Math.min(p.literature, p.site_best ?? Infinity);
  const problem = { N: p.N, M: p.M, P: p.P };
  let best: Awaited<ReturnType<typeof run>> | null = null;
  const t = cpuMs();
  for (let k = 0; k < Math.round(total / piece); k++) {
    const r = await run(problem, { method: "shrink_repair", params: k > 0 ? params : undefined, seed: seed * 1000 + k, start: best?.best, budget: { time_s: piece } });
    if (r.strict && r.score !== null && (!best || r.score < best.score!)) best = r;
  }
  const gap = best ? (100 * (best.score! - ref)) / ref : NaN;
  console.log(JSON.stringify({ id, total, piece, seed, gap, cpu: (cpuMs() - t) / 1000 }));
}
