/**
 * The TypeScript reference of the surface Auto search (`surface_auto`): runs `runSpaceJob` of
 * packages/spaces on evaluation-budgeted jobs and writes what it returns.
 *
 *   node node_modules/tsx/dist/cli.mjs native/surface/tests/search-ref.mts fixtures native/surface/tests/fixtures/search.jsonl
 *   node node_modules/tsx/dist/cli.mjs native/surface/tests/search-ref.mts time ID EVALS SEED
 *
 * Every job has an hour of time, so only its evaluation budget ends it. A case with `startFrom`
 * starts from the result of an earlier case.
 */
import { writeFileSync } from "node:fs";
import { runSpaceJob } from "@polypack/spaces/search";

const control = { aborted: false, paused: false };

interface Case {
  name: string;
  id: string;
  seed: number;
  evals: number;
  startFrom?: string;
}

const cases: Case[] = [
  { name: "cube-fold-sq", id: "surface/cube/fold/4/4", seed: 7, evals: 3 },
  { name: "tetra-fold-tri", id: "surface/tetrahedron/fold/3/5", seed: 11, evals: 3 },
  { name: "tcube-fold-pent", id: "surface/truncated_cube/fold/5/4", seed: 3, evals: 3 },
  { name: "prism5-fold-sq", id: "surface/prism5/fold/4/5", seed: 5, evals: 3 },
  { name: "rhdodec-nofold-sq", id: "surface/rhombic_dodecahedron/nofold/4/5", seed: 9, evals: 3 },
  { name: "cuboct-nofold-tri", id: "surface/cuboctahedron/nofold/3/6", seed: 2, evals: 3 },
  { name: "cube-fold-disk", id: "surface/cube/fold/0/5", seed: 13, evals: 3 },
  { name: "cube-fold-sq-warm", id: "surface/cube/fold/4/4", seed: 21, evals: 3, startFrom: "cube-fold-sq" },
  { name: "prism5-nofold-disk-warm-base", id: "surface/prism5/nofold/0/4", seed: 4, evals: 2 },
  { name: "prism5-nofold-disk-warm", id: "surface/prism5/nofold/0/4", seed: 8, evals: 2, startFrom: "prism5-nofold-disk-warm-base" },
];

function run(c: Case, start?: unknown) {
  const t0 = performance.now();
  const r = runSpaceJob(
    {
      space: "surface",
      id: c.id,
      seed: c.seed,
      budget: { time_s: 3600, evals: c.evals },
      ...(start ? { start: start as never } : {}),
      kind: start ? "warm" : "fresh",
    },
    control,
  );
  return { r, ms: performance.now() - t0 };
}

const mode = process.argv[2];
if (mode === "fixtures") {
  const done = new Map<string, any>();
  const lines: string[] = [];
  for (const c of cases) {
    const start = c.startFrom ? done.get(c.startFrom).config : undefined;
    const { r, ms } = run(c, start);
    done.set(c.name, r);
    console.error(c.name, r.score, r.evaluations, r.termination, `${ms.toFixed(0)} ms`);
    lines.push(
      JSON.stringify({
        name: c.name,
        id: c.id,
        seed: c.seed,
        evals: c.evals,
        start: start ?? null,
        score: r.score,
        evaluations: r.evaluations,
        termination: r.termination,
        config: r.config ?? null,
      }),
    );
  }
  writeFileSync(process.argv[3], lines.join("\n") + "\n");
} else if (mode === "time") {
  const [id, evals, seed] = [process.argv[3], Number(process.argv[4]), Number(process.argv[5])];
  const { r, ms } = run({ name: "t", id, seed, evals });
  console.log(JSON.stringify({ score: r.score, evaluations: r.evaluations, termination: r.termination, ms }));
}
