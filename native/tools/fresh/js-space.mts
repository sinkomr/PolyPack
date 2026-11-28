// The JavaScript volunteer client's search on one space problem, from scratch, as the benchmark contract
// (native/FRESH.md): searchSpaceProblem (packages/spaces/src/search/engine.ts, the client's scheduler) with one
// lane, runSpaceJob (run.ts) as the job runner, no known packing, process CPU time as the clock.
//
//   npx tsx native/tools/fresh/js-space.mts --id sphere/0/30 --seconds S --seed K
import { cpuUsage } from "node:process";
import { resolve } from "node:path";

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const id = arg("--id")!;
const seconds = Number(arg("--seconds", "60"));
const seed = Number(arg("--seed", "1"));
const space = id.split("/")[0]!;

const cpu = () => {
  const u = cpuUsage();
  return (u.user + u.system) / 1e6;
};
const t0 = cpu();
Object.defineProperty(globalThis.performance, "now", { value: () => (cpu() - t0) * 1000, configurable: true, writable: true });
const clock = () => performance.now() / 1000;

const root = resolve(import.meta.dirname, "../../..");
const { searchSpaceProblem, runSpaceJob } = await import(`${root}/packages/spaces/src/search/index.ts`);
const { checkSpaceConfig } = await import(`${root}/packages/spaces/src/search/model.ts`);

const control = { aborted: false, paused: false };
// the volunteer's worker runs runSpaceJob on the job (worker.ts); the clock it reads is performance.now, patched above
const runJob = async (job: unknown) => runSpaceJob(job as never, control);
let evaluations = 0;
const trace: { t: number; best: number }[] = [];
let last = Infinity;
const start = clock();
const outcome = await searchSpaceProblem(
  {
    space,
    id,
    bound: null,
    certified: null,
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
  runJob,
  control,
);
const best = outcome.best;
const check = best ? checkSpaceConfig(space, id, best.config, { bound: null, certified: null }) : null;
console.log(
  JSON.stringify({
    solver: "js",
    id,
    seed,
    seconds,
    clock: "cpu",
    score: best?.score ?? null,
    config: best?.config ?? null,
    evaluations,
    check_valid: check ? check.valid : null,
    trace,
    jobs: outcome.jobs,
    stopped: outcome.stopped,
    engine_seconds: clock() - start,
  }),
);
