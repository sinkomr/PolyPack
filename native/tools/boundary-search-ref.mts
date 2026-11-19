// Writes the fixture that holds the Rust port of the boundary search (native/boundary, module `search`, and `auto`) to the
// TypeScript's: searchBoundary of packages/boundary/src/search/search.ts (and the d-cube and nD searches it dispatches to) and
// runSpaceJob of packages/spaces/src/search/run.ts, each run with an evaluation budget only, so that no clock decides.
//
//   node --import tsx native/tools/boundary-search-ref.mts            writes native/boundary/tests/fixtures/search-ref.jsonl
//   BOUNDARY_SEARCH_REF_OUT=file ...                                  writes there instead (for a timing run on this machine)
//
// RUN IT UNDER NODE 24 ON LINUX x86-64, the production platform (native/tools/LINUX_REFERENCE.md says how, from any machine,
// with LINUXREF_RW=1 so that it can write into the crate): a search computes with sin, cos, log and atan2, and a Mac's Node
// gives another last bit for a few arguments, after which a seeded search follows another path.
//
// One line per case: its name, the kind ("search": searchBoundary; "job": runSpaceJob with method auto), the problem id, the seed,
// the evaluation budget, the start (a configuration, or null for a fresh run) and the result. A start is named by another case
// ("from") and is that case's configuration, as it is or with s and every centre scaled by "scale" (valid at the larger edge).
// The result holds the configuration, its score, the evaluations, how it ended, and for "search" the improvements in order.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BoundaryConfig, type ContainerName, type PieceName, parseBoundaryId, searchBoundary } from "../../packages/boundary/src/index.ts";
import { type SpaceJob, runSpaceJob } from "../../packages/spaces/src/search/run.ts";

const target = process.env.BOUNDARY_SEARCH_REF_OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "boundary", "tests", "fixtures", "search-ref.jsonl");

interface Case {
  name: string;
  kind: "search" | "job";
  id: string;
  seed: number;
  evals: number;
  from?: string;
  scale?: number;
}

// Small and medium P, balls and solids on every container family, fresh and warm-started; the budgets are in evaluations
// (a validator call counts 500, a d-cube or nD finish 1,000 or 500).
const cases: Case[] = [
  // the tesseract: balls by the lattice words, cubes by the two rings, the other solids rotated
  { name: "tess-ball-4", kind: "search", id: "boundary/tesseract/ball/4", seed: 1, evals: 40000 },
  { name: "tess-ball-4-warm", kind: "search", id: "boundary/tesseract/ball/4", seed: 2, evals: 15000, from: "tess-ball-4" },
  { name: "tess-ball-4-loose", kind: "search", id: "boundary/tesseract/ball/4", seed: 3, evals: 15000, from: "tess-ball-4", scale: 1.15 },
  { name: "tess-ball-9", kind: "search", id: "boundary/tesseract/ball/9", seed: 4, evals: 100000 },
  { name: "tess-ball-1", kind: "search", id: "boundary/tesseract/ball/1", seed: 5, evals: 5000 },
  { name: "tess-cube-6", kind: "search", id: "boundary/tesseract/cube/6", seed: 6, evals: 60000 },
  { name: "tess-cube-10", kind: "search", id: "boundary/tesseract/cube/10", seed: 7, evals: 60000 },
  { name: "tess-cube-10-warm", kind: "search", id: "boundary/tesseract/cube/10", seed: 8, evals: 20000, from: "tess-cube-10" },
  { name: "tess-tetra-1", kind: "search", id: "boundary/tesseract/tetrahedron/1", seed: 9, evals: 5000 },
  // the other 4-polytopes: balls by chains
  { name: "5cell-ball-2", kind: "search", id: "boundary/5cell/ball/2", seed: 10, evals: 8000 },
  { name: "5cell-ball-2-warm", kind: "search", id: "boundary/5cell/ball/2", seed: 11, evals: 4000, from: "5cell-ball-2" },
  { name: "16cell-ball-2", kind: "search", id: "boundary/16cell/ball/2", seed: 12, evals: 4000 },
  { name: "24cell-ball-2", kind: "search", id: "boundary/24cell/ball/2", seed: 13, evals: 20000 },
  { name: "120cell-ball-1", kind: "search", id: "boundary/120cell/ball/1", seed: 14, evals: 20000 },
  { name: "600cell-ball-3", kind: "search", id: "boundary/600cell/ball/3", seed: 15, evals: 5000 },
  // the other 4-polytopes: rotated solids (a cube on a 4-polytope other than the tesseract is rotated too)
  { name: "5cell-cube-1", kind: "search", id: "boundary/5cell/cube/1", seed: 16, evals: 5000 },
  { name: "16cell-tetra-1", kind: "search", id: "boundary/16cell/tetrahedron/1", seed: 17, evals: 3000 },
  { name: "24cell-octa-1", kind: "search", id: "boundary/24cell/octahedron/1", seed: 18, evals: 3500 },
  { name: "24cell-octa-1-warm", kind: "search", id: "boundary/24cell/octahedron/1", seed: 19, evals: 1500, from: "24cell-octa-1" },
  { name: "tess-octa-2", kind: "search", id: "boundary/tesseract/octahedron/2", seed: 20, evals: 2000 },
  // the d-cubes: balls and axis-aligned cubes
  { name: "5cube-ball-5", kind: "search", id: "boundary/5cube/ball/5", seed: 21, evals: 5000 },
  { name: "5cube-ball-5-warm", kind: "search", id: "boundary/5cube/ball/5", seed: 22, evals: 4000, from: "5cube-ball-5" },
  { name: "5cube-ball-20", kind: "search", id: "boundary/5cube/ball/20", seed: 23, evals: 20000 },
  { name: "6cube-cube-10", kind: "search", id: "boundary/6cube/cube/10", seed: 24, evals: 10000 },
  { name: "8cube-ball-7", kind: "search", id: "boundary/8cube/ball/7", seed: 25, evals: 8000 },
  { name: "10cube-cube-6", kind: "search", id: "boundary/10cube/cube/6", seed: 26, evals: 5000 },
  { name: "9cube-ball-12", kind: "search", id: "boundary/9cube/ball/12", seed: 27, evals: 5000 },
  { name: "7cube-ball-60", kind: "search", id: "boundary/7cube/ball/60", seed: 28, evals: 6000 },
  // the simplex, orthoplex and demicube: balls
  { name: "5simplex-ball-3", kind: "search", id: "boundary/5simplex/ball/3", seed: 29, evals: 5000 },
  { name: "5simplex-ball-7", kind: "search", id: "boundary/5simplex/ball/7", seed: 30, evals: 5000 },
  { name: "6orthoplex-ball-2", kind: "search", id: "boundary/6orthoplex/ball/2", seed: 31, evals: 5000 },
  { name: "5demicube-ball-4", kind: "search", id: "boundary/5demicube/ball/4", seed: 32, evals: 5000 },
  { name: "6demicube-ball-2", kind: "search", id: "boundary/6demicube/ball/2", seed: 33, evals: 5000 },
  { name: "7demicube-ball-3", kind: "search", id: "boundary/7demicube/ball/3", seed: 34, evals: 3000 },
  { name: "5simplex-ball-7-warm", kind: "search", id: "boundary/5simplex/ball/7", seed: 35, evals: 3000, from: "5simplex-ball-7" },
  // whole jobs (runSpaceJob, method auto): the start is a candidate, the best by the server's rule is the result
  { name: "job-tess-ball-5", kind: "job", id: "boundary/tesseract/ball/5", seed: 41, evals: 30000 },
  { name: "job-tess-ball-5-warm", kind: "job", id: "boundary/tesseract/ball/5", seed: 42, evals: 10000, from: "job-tess-ball-5" },
  { name: "job-tess-cube-7", kind: "job", id: "boundary/tesseract/cube/7", seed: 43, evals: 30000 },
  { name: "job-5cell-ball-2", kind: "job", id: "boundary/5cell/ball/2", seed: 44, evals: 4000 },
  { name: "job-5cube-ball-6", kind: "job", id: "boundary/5cube/ball/6", seed: 45, evals: 5000 },
  { name: "job-5cube-ball-6-zero", kind: "job", id: "boundary/5cube/ball/6", seed: 46, evals: 0, from: "job-5cube-ball-6" },
  { name: "job-16cell-tetra-1", kind: "job", id: "boundary/16cell/tetrahedron/1", seed: 47, evals: 2500 },
];

type Result = Record<string, unknown> & { config: BoundaryConfig | null };
const results = new Map<string, Result>();

/** A configuration with s and every centre scaled by k. */
function scaled(c: BoundaryConfig, k: number): BoundaryConfig {
  return { s: c.s * k, pieces: c.pieces.map((p) => ({ cell: p.cell, u: p.u.map((x) => x * k), ...(p.q ? { q: [...p.q] as typeof p.q } : {}) })) };
}

const lines: string[] = [];
for (const c of cases) {
  let start: BoundaryConfig | null = null;
  if (c.from) {
    const base = results.get(c.from)?.config;
    if (!base) throw new Error(`${c.name}: the case ${c.from} has no configuration to start from`);
    start = c.scale ? scaled(base, c.scale) : base;
  }
  const b = parseBoundaryId(c.id);
  if (typeof b === "string") throw new Error(`${c.name}: ${b}`);
  const t0 = performance.now();
  let result: Result;
  if (c.kind === "search") {
    const r = searchBoundary(
      { polytope: b.polytope as ContainerName, piece: b.piece as PieceName, P: b.P },
      { seed: c.seed, budget: { evals: c.evals }, ...(start ? { start } : {}) },
    );
    result = {
      config: r.config,
      score: r.score,
      evals: r.evals,
      ended: r.ended,
      startScore: r.startScore,
      starts: r.starts,
      trace: r.trace.map((e) => ({ evals: e.evals, score: e.score, source: e.source, stage: e.stage })),
    };
  } else {
    const job: SpaceJob = {
      space: "boundary",
      id: c.id,
      seed: c.seed,
      budget: { time_s: 1e9, evals: c.evals },
      kind: start ? "warm" : "fresh",
      ...(start ? { start: start as never } : {}),
    };
    const r = runSpaceJob(job, { aborted: false, paused: false });
    result = { config: (r.config ?? null) as BoundaryConfig | null, score: r.score, valid: r.valid, evals: r.evaluations, ended: r.termination };
  }
  const ms = performance.now() - t0;
  console.log(`${c.name}: ${String(result.ended)} score ${String(result.score)} evals ${String(result.evals)} (${ms.toFixed(0)} ms)`);
  results.set(c.name, result);
  lines.push(JSON.stringify({ name: c.name, kind: c.kind, id: c.id, seed: c.seed, evals: c.evals, start, result }));
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} cases to ${target}`);
