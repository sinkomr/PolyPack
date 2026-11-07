// The JavaScript client's engine on one problem, for comparison with `polypack-native bench`.
//
//   npx tsx native/tools/js-bench.mts ROOT N M P SECONDS SEED
//
// ROOT is a checkout of the repository (main, or a branch to compare). The search runs as the
// volunteer client runs it (searchProblem with inlineRunJob on one lane, no memory, no known
// packing), but every clock it reads is this process's CPU time (user + system, all of its
// threads): the engine's budget and the solver's job budgets are then CPU seconds, a fair
// measure on a loaded machine.
import { cpuUsage } from "node:process";

const [root, N, M, P, seconds, seed] = process.argv.slice(2);
const cpu = () => {
  const u = cpuUsage();
  return (u.user + u.system) / 1000;
};
const t0 = cpu();
const wall0 = Date.now();
// the solver's runtime reads performance.now() for budgets and checkpoints
Object.defineProperty(globalThis.performance, "now", { value: () => cpu() - t0, configurable: true, writable: true });

const { searchProblem, inlineRunJob } = await import(`${root}/apps/volunteer/src/engine/index.ts`);
const { areaLowerBound } = await import(`${root}/packages/geometry/src/index.ts`);
const problem = { N: Number(N), M: Number(M), P: Number(P) };
let evaluations = 0;
let jobs = 0;
const trace: unknown[] = [];
const start = performance.now();
const outcome = await searchProblem(
  {
    problem,
    leader: null,
    published: null,
    areaBound: areaLowerBound(problem.N, problem.M, problem.P),
    maxSeconds: Number(seconds),
    lanes: 1,
    seed: Number(seed),
    now: () => (performance.now() - start) / 1000,
    onResult: (r: { evaluations: number; job: { method: string; kind: string; budget: { time_s: number } }; score: number | null; strict: boolean }, best: { score: number } | null) => {
      evaluations += r.evaluations;
      jobs++;
      trace.push({ t: (performance.now() - start) / 1000, method: r.job.method, kind: r.job.kind, time_s: r.job.budget.time_s, evaluations: r.evaluations, score: r.score, best: best?.score ?? null });
    },
  },
  inlineRunJob,
  { aborted: false, paused: false },
);
const engineSeconds = (performance.now() - start) / 1000;
console.log(
  JSON.stringify({
    N: problem.N,
    M: problem.M,
    P: problem.P,
    seed: Number(seed),
    seconds: Number(seconds),
    score: outcome.best?.score ?? null,
    method: outcome.best?.job.method ?? null,
    jobs,
    evaluations,
    engine_seconds: engineSeconds,
    wall_seconds: (Date.now() - wall0) / 1000,
    evaluations_per_second: evaluations / engineSeconds,
    stopped: outcome.stopped,
    trace,
  }),
);
