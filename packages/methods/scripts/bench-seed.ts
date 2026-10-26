/**
 * The seed method on the reference kernel (unit disks in a circle): for each P and each variant,
 * runs seeds 1..S at a fixed evaluation budget and prints the best, median and worst score relative
 * to a reference, the runs within 1e-6 of it, and the mean evaluations and time. The reference is
 * the best known value of data/records.json (circles in a circle, N = M = 0; marked *) where it has
 * P, else the best score of the whole table. Every result is checked with the reference rule at
 * tolerance 0.
 *
 * Usage: nice -n 10 npx tsx packages/methods/scripts/bench-seed.ts [evals] [seeds] [P,P,...] [variant ...]
 * Variants: default, relax, squeeze2, iterations30, iterations100, random, seeds, jitter0.
 */
import { readFileSync } from "node:fs";
import { runMethod } from "../src";
import { disksKernel, validateDisks } from "../src/reference/disks";

const records = JSON.parse(readFileSync(new URL("../../../data/records.json", import.meta.url), "utf8")) as {
  records: { N: number; M: number; P: number; value: number }[];
};
const bestKnown = (P: number) => records.records.find((r) => r.N === 0 && r.M === 0 && r.P === P)?.value;

const VARIANTS: Record<string, Record<string, unknown>> = {
  default: {},
  relax: { squeeze: 0 },
  squeeze2: { squeeze: 2 },
  iterations30: { iterations: 30, squeeze: 3 },
  iterations100: { iterations: 100 },
  random: { seedShare: 0 },
  seeds: { seedShare: 1 },
  jitter0: { jitter: 0 },
};

const [evalsArg, seedsArg, psArg, ...names] = process.argv.slice(2);
const evals = Number(evalsArg ?? 20000);
const seeds = Number(seedsArg ?? 10);
const Ps = (psArg ?? "2,3,4,5,6,7,8,9,10").split(",").map(Number);
const variants = names.length ? names : ["default"];
for (const name of variants) if (!VARIANTS[name]) throw new Error(`unknown variant ${name}`);

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toExponential(1);
console.log(`seed, ${evals} evaluations, seeds 1-${seeds}; score / reference - 1 (best, median, worst)`);
for (const P of Ps) {
  const rows = variants.map((name) => {
    const scores: number[] = [];
    let used = 0;
    const t0 = performance.now();
    for (let seed = 1; seed <= seeds; seed++) {
      const r = runMethod(disksKernel(P), "seed", { seed, params: VARIANTS[name], budget: { evals } });
      if (r.score === null || !validateDisks(P, r.config, 0).valid) throw new Error(`P=${P} seed ${seed}: invalid`);
      scores.push(r.score);
      used += r.evaluations;
    }
    scores.sort((a, b) => a - b);
    return { name, scores, used: used / seeds, ms: (performance.now() - t0) / seeds };
  });
  const known = bestKnown(P);
  const ref = known ?? Math.min(...rows.map((r) => r.scores[0]));
  for (const { name, scores, used, ms } of rows) {
    const rel = (x: number) => fmt(x / ref - 1);
    console.log(
      [
        `P=${String(P).padStart(2)}`,
        `${known ? "*" : " "}${ref.toFixed(9)}`,
        name.padEnd(10),
        `best ${rel(scores[0])}`,
        `median ${rel(scores[(seeds - 1) >> 1])}`,
        `worst ${rel(scores[seeds - 1])}`,
        `hits ${scores.filter((x) => x <= ref * (1 + 1e-6)).length}/${seeds}`,
        `evals ${used.toFixed(0)}`,
        `${ms.toFixed(0)} ms/run`,
      ].join("  "),
    );
  }
}
