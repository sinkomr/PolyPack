/**
 * penalty and seed on the space kernels: for each case, budget and variant, runs seeds 1..S and
 * prints the scores relative to the space's record (data/<space>/records.json, score_cert), the
 * runs within 1e-3 of it, the runs with no result, and the evaluations used. Every result is checked with the kernel's own
 * validator.
 *
 * Usage: nice -n 10 npx tsx packages/methods/scripts/bench-penalty-seed-real.ts <method> [budgets] [seeds] [case prefix] [variant ...]
 *   budgets: comma-separated evaluation budgets (default 1000,5000,20000); variants: see VARIANTS.
 */
import { readFileSync } from "node:fs";
import { boundaryKernel } from "@polypack/boundary";
import { curvedKernel } from "@polypack/curved";
import { polyhedraKernel } from "@polypack/polyhedra";
import { sphereKernel } from "@polypack/sphere";
import { surfaceKernel } from "@polypack/surface";
import { torusKernel } from "@polypack/torus";
import { type SpaceKernel, runMethod } from "../src";

const VARIANTS: Record<string, Record<string, unknown>> = {
  default: {},
  jitter0: { jitter: 0 },
  "jitter1e-5": { jitter: 1e-5 },
  "jitter1e-2": { jitter: 1e-2 },
  "jitter0.03": { jitter: 0.03 },
  "jitter0.1": { jitter: 0.1 },
  "jitter0.3": { jitter: 0.3 },
  no_polish: { polish: false },
  polish: { polish: true },
};

const record = (space: string, id: string): number | undefined => {
  const file = JSON.parse(readFileSync(new URL(`../../../data/${space}/records.json`, import.meta.url), "utf8")) as {
    records: { id?: string; problem?: string; score_cert?: number }[];
  };
  return file.records.find((r) => (r.id ?? r.problem) === id)?.score_cert;
};

const CASES: [string, () => SpaceKernel][] = [
  ["surface/cube/fold/4/7", () => surfaceKernel({ solid: "cube", N: 4, P: 7 })],
  ["sphere/4/12", () => sphereKernel({ N: 4, P: 12 })],
  ["sphere/0/13", () => sphereKernel({ N: 0, P: 13 })],
  ["torus/free/3/6", () => torusKernel({ family: "free", N: 3, P: 6 })],
  ["boundary/tesseract/cube/9", () => boundaryKernel({ polytope: "tesseract", piece: "cube", P: 9 })],
  ["polyhedra/tetintet/6", () => polyhedraKernel({ code: "tetintet", P: 6 })],
  ["curved/-1/0/0/7", () => curvedKernel({ K: -1, N: 0, M: 0, P: 7 })],
  ["curved/-1/3/4/5", () => curvedKernel({ K: -1, N: 3, M: 4, P: 5 })],
  ["curved/1/4/4/3", () => curvedKernel({ K: 1, N: 4, M: 4, P: 3 })],
];

const [method, budgetsArg, seedsArg, prefix, ...names] = process.argv.slice(2);
if (method !== "penalty" && method !== "seed") throw new Error("method must be penalty or seed");
const budgets = (budgetsArg ?? "1000,5000,20000").split(",").map(Number);
const seeds = Number(seedsArg ?? 3);
const variants = names.length ? names : ["default"];
for (const name of variants) if (!VARIANTS[name]) throw new Error(`unknown variant ${name}`);

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toExponential(1);
console.log(
  `${method}, seeds 1-${seeds}; score / record - 1 (best, median, worst), runs within 1e-3, runs without a result`,
);
for (const [id, make] of CASES.filter(([id]) => !prefix || prefix === "all" || id.startsWith(prefix))) {
  const ref = record(id.split("/")[0], id);
  for (const evals of budgets)
    for (const name of variants) {
      const scores: number[] = [];
      let none = 0;
      let used = 0;
      const t0 = performance.now();
      for (let seed = 1; seed <= seeds; seed++) {
        const r = runMethod(make(), method, { seed, params: VARIANTS[name], budget: { evals } });
        used += r.evaluations;
        if (r.score === null) {
          none++;
          continue;
        }
        if (!make().validate(r.config).valid) throw new Error(`${id} seed ${seed}: invalid`);
        scores.push(r.score);
      }
      scores.sort((a, b) => a - b);
      const rel = (x: number | undefined) => (x === undefined ? "-" : ref ? fmt(x / ref - 1) : x.toFixed(9));
      console.log(
        [
          id.padEnd(26),
          String(evals).padStart(6),
          name.padEnd(10),
          `best ${rel(scores[0])}`,
          `median ${rel(scores[(scores.length - 1) >> 1])}`,
          `worst ${rel(scores[scores.length - 1])}`,
          `near ${ref ? scores.filter((x) => x <= ref * (1 + 1e-3)).length : "-"}/${seeds}`,
          `none ${none}/${seeds}`,
          `evals ${(used / seeds).toFixed(0)}`,
          `${((performance.now() - t0) / seeds / 1000).toFixed(1)} s/run`,
        ].join("  "),
      );
    }
}
