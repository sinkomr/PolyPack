/**
 * Benchmark of basin_hopping on the reference kernel (unit disks in a circle), against the best
 * known radii of data/records.json (circles in a circle, N = M = 0; sources there). Run from the
 * repository root under nice:
 *
 *   nice -n 10 npx tsx packages/methods/scripts/bench-basin_hopping.ts [Pmin-Pmax] [seeds] [evals] [params JSON]
 *
 * Defaults: P 2-12, seeds 1-5, 30000 evaluations, the method's defaults. Prints one row per P:
 * the best known radius, each seed's score, the best score less the best known, the mean and worst ratio to the best known, the
 * evaluations used and the wall time per run (which depends on the machine and its load).
 */
import { readFileSync } from "node:fs";
import { runMethod } from "../src";
import { disksKernel, validateDisks } from "../src/reference/disks";

interface RecordRow {
  N: number;
  M: number;
  P: number;
  value: number;
}

export function bench(method: string, argv: string[]): void {
  const records = (
    JSON.parse(readFileSync(new URL("../../../data/records.json", import.meta.url), "utf8")) as { records: RecordRow[] }
  ).records;
  const known = (P: number) => records.find((r) => r.N === 0 && r.M === 0 && r.P === P)?.value ?? NaN;
  const [lo, hi] = (argv[0] ?? "2-12").split("-").map(Number);
  const seeds = Number(argv[1] ?? 5);
  const evals = Number(argv[2] ?? 30000);
  const params = argv[3] ? (JSON.parse(argv[3]) as Record<string, unknown>) : {};
  console.log(`${method}, ${evals} evaluations, seeds 1-${seeds}, params ${JSON.stringify(params)}`);
  console.log("| P | Best known | Scores | Best - known | Mean ratio | Worst ratio | Evaluations | Seconds |");
  console.log("|---|---|---|---|---|---|---|---|");
  let sum = 0;
  let runs = 0;
  for (let P = lo; P <= (hi ?? lo); P++) {
    const scores: number[] = [];
    let used = 0;
    const t0 = performance.now();
    for (let seed = 1; seed <= seeds; seed++) {
      const r = runMethod(disksKernel(P), method, { seed, params, budget: { evals } });
      if (r.score === null || !validateDisks(P, r.config, 0).valid)
        throw new Error(`P ${P} seed ${seed}: no valid result`);
      scores.push(r.score);
      used += r.evaluations;
    }
    const seconds = (performance.now() - t0) / 1000 / seeds;
    const ratios = scores.map((s) => s / known(P));
    const mean = ratios.reduce((t, v) => t + v, 0) / seeds;
    sum += ratios.reduce((t, v) => t + v, 0);
    runs += seeds;
    console.log(
      `| ${P} | ${known(P).toFixed(6)} | ${scores.map((s) => s.toFixed(6)).join(", ")} | ${(Math.min(...scores) - known(P)).toExponential(1)} | ${mean.toFixed(5)} | ${Math.max(...ratios).toFixed(5)} | ${Math.round(used / seeds)} | ${seconds.toFixed(2)} |`,
    );
  }
  console.log(`mean ratio over ${runs} runs: ${(sum / runs).toFixed(5)}`);
}

if (process.argv[1]?.endsWith("bench-basin_hopping.ts")) bench("basin_hopping", process.argv.slice(2));
