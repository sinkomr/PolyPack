// The TypeScript side of the comparison of the nD space's Auto search (native/PORTING.md): runs the
// search of packages/spaces/src/search/run.ts and writes what it answers, for the fixture test of
// native/ndim (tests/search.rs).
//
//   node --import tsx native/tools/ndim-search-ref.mts [--out FILE] [--time] [--only NAME]
//
// Written to native/ndim/tests/fixtures/search-ref.jsonl (--out): one JSON object per case, in the
// order below. The fixtures MUST be written by Node 24 on linux/amd64, the production platform (a
// Mac's Node differs in the last bit of its sines, and a seeded search then diverges): see
// native/tools/LINUX_REFERENCE.md. In a container:
//
//   export LINUXREF_DIR=<scratch dir outside the repository>
//   native/tools/linuxref/bundle.sh ndim-search-ref
//   LINUXREF_RW=1 native/tools/linuxref/linux.sh ndim-search ndim-search-ref
//
// Cases. Every case has an evaluation budget only (the clock never decides) and is one of
//   job     runSpaceJob of packages/spaces/src/search/run.ts for the space "ndim" (method "auto": the
//           generic basin hopping on the problem's kernel), fresh or warm-started from the result of
//           another case: the score, the evaluations (rounded), the termination and the configuration;
//   method  runMethod("basin_hopping") of packages/methods on the ndim kernel with the job's rule as
//           its validate (what runGeneric builds): the raw evaluation count (a piece's share of a
//           sweep counts 1/P, so it is fractional), how the run stopped and the configuration.
// The problems cover dimensions 4 to 10, balls and polytopes as pieces and as containers, small and
// medium P.
//
// With --time the cases are run twice and the time of each is printed (a timing of this machine's
// Node, not part of the fixtures).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMethod } from "../../packages/methods/src/index.ts";
import { ndKernel } from "../../packages/ndspace/src/kernel.ts";
import { loadNdProblem } from "../../packages/ndspace/src/validate.ts";
import { parseNdId } from "../../packages/ndspace/src/catalogue.ts";
import { runSpaceJob } from "../../packages/spaces/src/search/run.ts";
import { checkSpaceConfig } from "../../packages/spaces/src/search/model.ts";
import type { SpaceConfig } from "../../packages/spaces/src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outFile = opt("--out") ?? join(here, "../ndim/tests/fixtures/search-ref.jsonl");
const timed = args.includes("--time");
const only = opt("--only");

interface Case {
  name: string;
  kind: "job" | "method";
  id: string;
  seed: number;
  evals: number;
  /** The name of an earlier case whose configuration is the start, or none for a fresh run. */
  from?: string;
}

// [name, id, seed, evals]: fresh jobs; the warm ones follow
const CASES: Case[] = [
  { name: "4d-ball-ball-5", kind: "job", id: "ndim/4/ball/ball/5", seed: 1, evals: 8000 },
  { name: "4d-cube-cube-6", kind: "job", id: "ndim/4/cube/cube/6", seed: 2, evals: 1200 },
  { name: "4d-simplex-ball-6", kind: "job", id: "ndim/4/simplex/ball/6", seed: 3, evals: 1500 },
  { name: "4d-ball-cube-8", kind: "job", id: "ndim/4/ball/cube/8", seed: 4, evals: 15000 },
  { name: "4d-ortho-ortho-5", kind: "job", id: "ndim/4/ortho/ortho/5", seed: 5, evals: 1500 },
  { name: "4d-ball-24cell-8", kind: "job", id: "ndim/4/ball/24cell/8", seed: 6, evals: 10000 },
  { name: "5d-cube-ball-5", kind: "job", id: "ndim/5/cube/ball/5", seed: 7, evals: 700 },
  { name: "5d-demi-simplex-4", kind: "job", id: "ndim/5/demi/simplex/4", seed: 8, evals: 1000 },
  { name: "6d-ball-ball-7", kind: "job", id: "ndim/6/ball/ball/7", seed: 9, evals: 15000 },
  { name: "6d-cube-cube-4", kind: "job", id: "ndim/6/cube/cube/4", seed: 10, evals: 500 },
  { name: "7d-simplex-cube-4", kind: "job", id: "ndim/7/simplex/cube/4", seed: 11, evals: 1500 },
  { name: "8d-ball-cube-6", kind: "job", id: "ndim/8/ball/cube/6", seed: 12, evals: 10000 },
  { name: "9d-ball-ball-10", kind: "job", id: "ndim/9/ball/ball/10", seed: 13, evals: 8000 },
  { name: "10d-ball-ball-12", kind: "job", id: "ndim/10/ball/ball/12", seed: 14, evals: 8000 },
  { name: "4d-ball-ball-16", kind: "job", id: "ndim/4/ball/ball/16", seed: 15, evals: 20000 },
  { name: "4d-cube-cube-10", kind: "job", id: "ndim/4/cube/cube/10", seed: 16, evals: 800 },
  // warm-started from the fresh results above
  { name: "4d-ball-ball-5-warm", kind: "job", id: "ndim/4/ball/ball/5", seed: 21, evals: 4000, from: "4d-ball-ball-5" },
  { name: "4d-cube-cube-6-warm", kind: "job", id: "ndim/4/cube/cube/6", seed: 22, evals: 1000, from: "4d-cube-cube-6" },
  { name: "5d-cube-ball-5-warm", kind: "job", id: "ndim/5/cube/ball/5", seed: 23, evals: 600, from: "5d-cube-ball-5" },
  { name: "8d-ball-cube-6-warm", kind: "job", id: "ndim/8/ball/cube/6", seed: 24, evals: 5000, from: "8d-ball-cube-6" },
  // the method on the kernel, with raw counts and terminations
  { name: "m-4d-ball-ball-6", kind: "method", id: "ndim/4/ball/ball/6", seed: 31, evals: 6000 },
  { name: "m-4d-cube-ball-4", kind: "method", id: "ndim/4/cube/ball/4", seed: 32, evals: 800 },
  { name: "m-5d-simplex-cube-5", kind: "method", id: "ndim/5/simplex/cube/5", seed: 33, evals: 1000 },
  { name: "m-6d-ball-cube-5-tiny", kind: "method", id: "ndim/6/ball/cube/5", seed: 34, evals: 150 },
  { name: "m-4d-ortho-24cell-3-warm", kind: "method", id: "ndim/4/ortho/24cell/3", seed: 35, evals: 600 },
];

const idOf = (id: string) => {
  const n = parseNdId(id);
  if (typeof n === "string") throw new Error(n);
  return n;
};

const control = { aborted: false, paused: false };
const results = new Map<string, unknown>();
const lines: string[] = [];

for (const c of CASES) {
  if (only && c.name !== only && c.from !== only) continue;
  const n = idOf(c.id);
  await loadNdProblem(n);
  const start = c.from ? (results.get(c.from) as SpaceConfig | null) : undefined;
  if (c.from && !start) throw new Error(`${c.name}: no start from ${c.from}`);
  const run = (): { ms: number; record: Record<string, unknown> } => {
    const t0 = performance.now();
    if (c.kind === "job") {
      const r = runSpaceJob(
        {
          space: "ndim",
          id: c.id,
          seed: c.seed,
          budget: { time_s: 1e9, evals: c.evals },
          ...(start ? { start } : {}),
          kind: start ? "warm" : "fresh",
        },
        control,
      );
      const ms = performance.now() - t0;
      return {
        ms,
        record: {
          score: r.score,
          evaluations: r.evaluations,
          termination: r.termination,
          reasons: r.reasons,
          config: r.config ?? null,
        },
      };
    }
    // what runGeneric builds: the kernel with the job's rule (the default one) as its validate
    const own = ndKernel(n);
    const kernel = { ...own, validate: (config: unknown) => checkSpaceConfig("ndim", c.id, config, undefined) };
    const r = runMethod(kernel, "basin_hopping", {
      seed: c.seed,
      ...(start ? { start } : {}),
      budget: { evals: c.evals },
      shouldStop: () => false,
    });
    const ms = performance.now() - t0;
    return {
      ms,
      record: { score: r.score, evaluations: r.evaluations, stopped: r.stopped, reasons: r.reasons, config: r.config },
    };
  };
  let out = run();
  if (timed) {
    const again = run();
    console.log(`${c.name}: ${out.ms.toFixed(0)} ms, then ${again.ms.toFixed(0)} ms`);
    out = again;
  }
  results.set(c.name, (out.record.config as SpaceConfig | null) ?? null);
  lines.push(JSON.stringify({ ...c, start: start ?? null, result: out.record }));
  if (!timed) console.log(`${c.name}: score ${String(out.record.score)}, evaluations ${String(out.record.evaluations)}, ${String(out.record.termination ?? out.record.stopped)}`);
}
if (!only) writeFileSync(outFile, lines.join("\n") + "\n");
