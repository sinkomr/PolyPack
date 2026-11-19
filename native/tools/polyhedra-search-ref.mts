// The TypeScript's answers for the polyhedra search, for the Rust port's fixture test
// (native/polyhedra/tests/search.rs), with evaluation-only budgets so that time never decides.
//
//   node --import tsx native/tools/polyhedra-search-ref.mts [OUT.jsonl] [--time]
//
// OUT defaults to native/polyhedra/tests/fixtures/search-ref.jsonl. The fixtures must be written by Node 24 on
// linux/amd64 (native/tools/LINUX_REFERENCE.md): a Mac's Node has other last bits in its sines, and a search then
// diverges.
//
//   export LINUXREF_DIR=<scratch dir outside the repository>; export LINUXREF_RW=1
//   native/tools/linuxref/bundle.sh polyhedra-search-ref
//   native/tools/linuxref/linux.sh psearch polyhedra-search-ref native/polyhedra/tests/fixtures/search-ref.jsonl
//
// One case per line: {id, kind, seed, evals, polished, start, result}. Kind "search" calls `searchPolyhedra` of
// packages/polyhedra (result: score, start_score, evaluations, hops, stopped, config); kind "job" calls
// `runSpaceJob` of packages/spaces (result: score, valid, evaluations, termination, config), which also checks
// the start and the result by the server's rule. Starts are research records (data/polyhedra/configs), results of
// earlier cases, and made-up starts: coinciding centres, a loose scaled copy, an invalid one.
//
// With --time the cases are also timed (best of three runs; milliseconds) and the times printed to stderr.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getProblem, searchPolyhedra, type PolyhedraConfig } from "../../packages/polyhedra/src/index.ts";
import { runSpaceJob } from "../../packages/spaces/src/search/run.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const timeIt = args.includes("--time");
const out = args.find((a) => !a.startsWith("--")) ?? `${root}native/polyhedra/tests/fixtures/search-ref.jsonl`;

/** The research record of a problem with P pieces (data/polyhedra/configs/<code>.jsonl). */
function record(code: string, P: number): PolyhedraConfig {
  const lines = readFileSync(`${root}data/polyhedra/configs/${code}.jsonl`, "utf8").split("\n").filter(Boolean);
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.P === P) return r.config;
  }
  throw new Error(`no record for ${code}/${P}`);
}

const finite = (x: number | null) => (x !== null && Number.isFinite(x) ? x : null);
const cases: string[] = [];
const results = new Map<string, PolyhedraConfig>();

interface Case {
  name: string;
  code: string;
  P: number;
  seed: number;
  evals: number;
  start?: PolyhedraConfig;
  polished?: boolean;
  job?: boolean;
}

function run(c: Case): void {
  const problem = getProblem(c.code)!;
  const go = () => {
    if (c.job) {
      const r = runSpaceJob(
        {
          space: "polyhedra",
          id: `polyhedra/${c.code}/${c.P}`,
          seed: c.seed,
          budget: { time_s: 1e9, evals: c.evals },
          ...(c.start ? { start: c.start as never } : {}),
          kind: c.start ? "warm" : "fresh",
        },
        { aborted: false, paused: false },
      );
      return {
        score: r.score,
        valid: r.valid,
        evaluations: r.evaluations,
        termination: r.termination,
        config: r.config ?? null,
        reasons: r.reasons,
      };
    }
    const r = searchPolyhedra(problem, c.P, {
      seed: c.seed,
      start: c.start,
      startPolished: c.polished === true,
      maxEvals: c.evals,
    });
    return {
      score: finite(r.score),
      start_score: r.startScore,
      evaluations: r.evaluations,
      hops: r.hops,
      stopped: r.stopped,
      config: r.config,
    };
  };
  const t0 = performance.now();
  const result = go();
  const t1 = performance.now();
  if (timeIt) {
    let best = t1 - t0;
    for (let k = 0; k < 2; k++) {
      const a = performance.now();
      go();
      best = Math.min(best, performance.now() - a);
    }
    console.error(`${c.name.padEnd(28)} ${c.job ? "job   " : "search"} evals ${String(c.evals).padStart(6)} ${best.toFixed(0).padStart(7)} ms`);
  }
  if (result.config) results.set(c.name, result.config as PolyhedraConfig);
  cases.push(
    JSON.stringify({
      id: `polyhedra/${c.code}/${c.P}`,
      name: c.name,
      kind: c.job ? "job" : "search",
      seed: c.seed,
      evals: c.evals,
      polished: c.polished === true,
      start: c.start ?? null,
      result,
    }),
  );
}

// fresh starts: container and piece solids of every kind (few faces, many faces for the container's LP, pruned
// edge axes for the piece, Johnson solids, prisms, antiprisms), small and medium P
run({ name: "cube-in-cube-4", code: "cubincub", P: 4, seed: 1, evals: 12000 });
run({ name: "cube-in-tet-5", code: "cubintet", P: 5, seed: 2, evals: 60000 });
run({ name: "tet-in-cube-6", code: "tetincub", P: 6, seed: 3, evals: 36000 });
run({ name: "oct-in-cube-5", code: "octincub", P: 5, seed: 4, evals: 24000 });
run({ name: "ap6-in-cube-4", code: "ap6incub", P: 4, seed: 5, evals: 30000 });
run({ name: "ktt-in-cube-3", code: "kttincub", P: 3, seed: 6, evals: 24000 });
run({ name: "cube-in-tic-3", code: "cubintic", P: 3, seed: 7, evals: 18000 });
run({ name: "tte-in-rco-4", code: "tteinrco", P: 4, seed: 8, evals: 30000 });
run({ name: "cube-in-cube-14", code: "cubincub", P: 14, seed: 9, evals: 20000 });
run({ name: "tet-in-cube-12", code: "tetincub", P: 12, seed: 10, evals: 75000 });
run({ name: "pr3l15-in-cube-6", code: "pr3l15incub", P: 6, seed: 11, evals: 45000 });
run({ name: "j01-in-cube-5", code: "j01incub", P: 5, seed: 12, evals: 30000 });
run({ name: "cube-in-j26-4", code: "cubinj26", P: 4, seed: 13, evals: 30000 });
run({ name: "cube-in-cube-1", code: "cubincub", P: 1, seed: 14, evals: 4000 });
run({ name: "cube-in-cube-2-tiny", code: "cubincub", P: 2, seed: 15, evals: 600 });
run({ name: "dod-in-cube-3", code: "dodincub", P: 3, seed: 16, evals: 24000 });
run({ name: "bp5-in-cube-4", code: "bp5incub", P: 4, seed: 17, evals: 24000 });
run({ name: "cube-in-cube-30", code: "cubincub", P: 30, seed: 19, evals: 30000 });
run({ name: "cube-in-cube-3-none", code: "cubincub", P: 3, seed: 18, evals: 0 });
run({ name: "cube-in-cube-3-seed-big", code: "cubincub", P: 3, seed: 4294967295, evals: 15000 });

// warm starts: research records, earlier results, made-up starts
run({ name: "w-cube-in-tet-6", code: "cubintet", P: 6, seed: 21, evals: 24000, start: record("cubintet", 6) });
run({ name: "w-cube-in-cube-10", code: "cubincub", P: 10, seed: 22, evals: 8000, start: record("cubincub", 10) });
run({ name: "w-chain-cube-in-tet-5", code: "cubintet", P: 5, seed: 23, evals: 18000, start: results.get("cube-in-tet-5")! });
run({ name: "w-polished-cube-in-tet-6", code: "cubintet", P: 6, seed: 24, evals: 18000, start: record("cubintet", 6), polished: true });
{
  const r = record("cubintet", 6);
  // coinciding centres (the duplicate spiral of the legalization) and a loose, scaled copy
  const dup = { s: r.s, pieces: r.pieces.map((p, i) => (i === 1 ? [...r.pieces[0].slice(0, 3), ...p.slice(3)] : p)) } as PolyhedraConfig;
  run({ name: "w-duplicate-centres", code: "cubintet", P: 6, seed: 25, evals: 24000, start: dup });
  const k = 1.7;
  const loose = { s: r.s * k, pieces: r.pieces.map((p) => [p[0] * k, p[1] * k, p[2] * k, ...p.slice(3)]) } as PolyhedraConfig;
  run({ name: "w-loose-copy", code: "cubintet", P: 6, seed: 26, evals: 24000, start: loose });
}
run({ name: "w-ap6-in-cube", code: "ap6incub", P: 4, seed: 27, evals: 18000, start: results.get("ap6-in-cube-4")! });
run({ name: "w-cube-in-tic", code: "cubintic", P: 3, seed: 28, evals: 15000, start: results.get("cube-in-tic-3")! });

// the job runner: fresh, warm, a start that is not valid, no budget
run({ name: "job-fresh-cube-in-cube-5", code: "cubincub", P: 5, seed: 31, evals: 45000, job: true });
run({ name: "job-warm-cube-in-tet-6", code: "cubintet", P: 6, seed: 32, evals: 24000, job: true, start: record("cubintet", 6) });
{
  const r = record("cubintet", 6);
  const squeezed = { s: r.s * 0.9, pieces: r.pieces } as PolyhedraConfig;
  run({ name: "job-invalid-start", code: "cubintet", P: 6, seed: 33, evals: 18000, job: true, start: squeezed });
  run({ name: "job-start-no-budget", code: "cubintet", P: 6, seed: 34, evals: 0, job: true, start: r });
}

writeFileSync(out, cases.join("\n") + "\n");
console.error(`wrote ${cases.length} cases to ${out}`);
