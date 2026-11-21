// The JavaScript volunteer client's search on one flat problem, from scratch, as the benchmark contract
// (native/FRESH.md): one lane, no memory, no known packing, process CPU time as the clock.
//
//   npx tsx native/tools/fresh/js-flat.mts --id flat/N/M/P --seconds S --seed K
//
// Like native/tools/js-bench.mts: performance.now is replaced by this process's CPU time (user + system,
// all threads, so also the garbage collector's), which the engine's and the jobs' budgets read.
import { cpuUsage } from "node:process";
import { resolve } from "node:path";

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const id = arg("--id")!;
const seconds = Number(arg("--seconds", "60"));
const seed = Number(arg("--seed", "1"));
const m = /^flat\/(\d+)\/(\d+)\/(\d+)$/.exec(id);
if (!m) throw new Error(`not a flat id: ${id}`);
const problem = { N: Number(m[1]), M: Number(m[2]), P: Number(m[3]) };

const cpu = () => {
  const u = cpuUsage();
  return (u.user + u.system) / 1e6;
};
const t0 = cpu();
Object.defineProperty(globalThis.performance, "now", { value: () => (cpu() - t0) * 1000, configurable: true, writable: true });
const clock = () => performance.now() / 1000;

const root = resolve(import.meta.dirname, "../../..");
const { searchProblem, inlineRunJob } = await import(`${root}/apps/volunteer/src/engine/index.ts`);
const { areaLowerBound, evaluate } = await import(`${root}/packages/geometry/src/index.ts`);

let evaluations = 0;
const trace: { t: number; best: number }[] = [];
let last = Infinity;
const start = clock();
const outcome = await searchProblem(
  {
    problem,
    leader: null,
    published: null,
    areaBound: areaLowerBound(problem.N, problem.M, problem.P),
    maxSeconds: seconds,
    lanes: 1,
    seed,
    now: () => clock() - start,
    onResult: (r: { evaluations: number }, best: { score: number } | null) => {
      evaluations += r.evaluations;
      if (best && best.score < last) {
        last = best.score;
        trace.push({ t: clock() - start, best: best.score });
      }
    },
  },
  inlineRunJob,
  { aborted: false, paused: false },
);
const best = outcome.best;
const config = best
  ? {
      N: problem.N,
      M: problem.M,
      P: problem.P,
      container_phi: best.config.container_phi ?? best.config.phi ?? 0,
      pieces: best.config.pieces.map((p: { x: number; y: number; theta?: number }) => ({ x: p.x, y: p.y, theta: p.theta ?? 0 })),
    }
  : null;
const check = config ? evaluate(config, { stopWhenInvalid: true }) : null;
console.log(
  JSON.stringify({
    solver: "js",
    id,
    seed,
    seconds,
    clock: "cpu",
    score: best?.score ?? null,
    config,
    evaluations,
    check_valid: check ? check.valid : null,
    trace,
    stopped: outcome.stopped,
    engine_seconds: clock() - start,
  }),
);
