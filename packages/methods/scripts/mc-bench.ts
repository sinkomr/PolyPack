/**
 * The benchmark that bench-mc_compress.ts and bench-asc.ts run: a method on the reference kernel
 * (unit disks in a circle, against DISKS_IN_CIRCLE_BEST) and on the free-torus test kernel, over
 * seeds, at an evaluation budget, so every number is reproducible from the command line.
 *
 * Options: --P 2-10 (or 2,5,7), --seeds 10, --evals 30000, --params '{"maxRestarts":0}',
 * --torus 1-3 (P of the free-torus kernel; 0 to skip).
 */
import { performance } from "node:perf_hooks";
import { runMethod } from "../src";
import { DISKS_IN_CIRCLE_BEST, disksKernel } from "../src/reference/disks";
import type { SpaceKernel } from "../src/kernel";
import { torusDisksKernel } from "../test/mc-torus-kernel";

const option = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const range = (text: string): number[] =>
  text.includes("-")
    ? (([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))(text.split("-").map(Number))
    : text.split(",").map(Number).filter((v) => v > 0);

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function table(method: string, rows: { name: string; make: () => SpaceKernel; best: number }[]) {
  const seeds = Number(option("seeds", "10"));
  const evals = Number(option("evals", "30000"));
  const params = JSON.parse(option("params", "{}"));
  console.log(`${method}, seeds 1-${seeds}, ${evals} evaluations, params ${JSON.stringify(params)}, Node ${process.version}`);
  console.log("| Problem | Best known | Best | Median | Worst | Median excess | Within 1e-3 | Median evals | Mean s |");
  console.log("|---|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const row of rows) {
    const scores: number[] = [];
    const used: number[] = [];
    let time = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const t0 = performance.now();
      const r = runMethod(row.make(), method, { seed, params, budget: { evals } });
      time += (performance.now() - t0) / 1000;
      scores.push(r.score ?? Infinity);
      used.push(r.evaluations);
    }
    const within = scores.filter((s) => s <= row.best * (1 + 1e-3)).length;
    console.log(
      `| ${row.name} | ${row.best.toFixed(6)} | ${Math.min(...scores).toFixed(6)} | ${median(scores).toFixed(6)} | ` +
        `${Math.max(...scores).toFixed(6)} | ${(median(scores) / row.best - 1).toExponential(2)} | ${within}/${seeds} | ` +
        `${Math.round(median(used))} | ${(time / seeds).toFixed(2)} |`,
    );
  }
}

export function bench(method: string): void {
  const rows = range(option("P", "2-10")).map((P) => ({
    name: `disks in a circle, P=${P}`,
    make: () => disksKernel(P),
    best: DISKS_IN_CIRCLE_BEST[P],
  }));
  // the bound of the free-torus kernel is the hexagonal packing's, which one disk attains
  const torus = range(option("torus", "1")).map((P) => ({
    name: `disks on a free torus, P=${P}`,
    make: () => torusDisksKernel(P),
    best: torusDisksKernel(P).bound!,
  }));
  table(method, [...rows, ...torus]);
}
