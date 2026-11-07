/**
 * Quality benchmark for flat 2D: the volunteer engine (or one method) on panel.json at a fixed
 * CPU budget, several seeds. The clock is this process's CPU time (process.cpuUsage), installed as
 * globalThis.performance.now so that the solver's time budgets and the engine's clock both count
 * CPU seconds, not wall seconds: results hold on a loaded machine. One process runs one cell at a
 * time; run several shards in parallel.
 *
 *   npx tsx apps/volunteer/scripts/bench-engine/bench.ts --budget 10 --seeds 1,2,3 --tag base [--shard 0/7]
 *     [--mode engine | method:<name>] [--only 0,3,5] [--known site|lit]
 *
 * Writes one JSON line per (problem, seed) to apps/volunteer/scripts/bench-engine/results/<tag>-<budget>.jsonl:
 * final score, gap to the reference (min of literature and site best), the anytime trace
 * (cpu seconds, best) and the job log.
 */
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const wall = globalThis.performance;
Object.defineProperty(globalThis, "performance", {
  configurable: true,
  value: new Proxy(wall, {
    get(target, key) {
      if (key === "now") return cpuMs;
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }),
});

const { areaLowerBound } = await import("@polypack/geometry");
const { run } = await import("@polypack/solver");
// --engine base: the engine before this study, in base-engine/ (see README.md)
const engineArg = process.argv.indexOf("--engine");
const { searchProblem } =
  engineArg > 0 && process.argv[engineArg + 1] === "base"
    ? await import("./base-engine/engine/search")
    : await import("../../src/engine/index");
const { inlineRunJob } = await import("../../src/engine/inline");

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const budget = Number(args.get("budget") ?? 10);
const seeds = (args.get("seeds") ?? "1,2,3").split(",").map(Number);
const tag = args.get("tag") ?? "base";
const mode = args.get("mode") ?? "engine";
const [shard, shards] = (args.get("shard") ?? "0/1").split("/").map(Number);
const panelFile = args.get("panel") ?? path.join(here, "panel.json");
const panel: { N: number; M: number; P: number; literature: number; site_best: number | null }[] = JSON.parse(
  fs.readFileSync(panelFile, "utf8"),
);
const only = args.get("only")?.split(",").map(Number);
// Several lanes: jobs run on worker threads (lane.ts), each timed by its own thread's CPU, and the
// engine's clock is the process's CPU time divided by the lanes
const lanes = Number(args.get("lanes") ?? 1);
type RunJob = typeof inlineRunJob;
let runJob: RunJob = inlineRunJob;
const workers: Worker[] = [];
if (lanes > 1) {
  const idle: Worker[] = [];
  const waiting: (() => void)[] = [];
  const pending = new Map<number, (r: Awaited<ReturnType<RunJob>>) => void>();
  let next = 0;
  for (let l = 0; l < lanes; l++) {
    const w = new Worker(new URL("./lane.ts", import.meta.url), { execArgv: ["--import", "tsx"] });
    w.on("message", (m: { id: number; result: Awaited<ReturnType<RunJob>> }) => {
      pending.get(m.id)!(m.result);
      pending.delete(m.id);
      idle.push(w);
      waiting.shift()?.();
    });
    workers.push(w);
    idle.push(w);
  }
  runJob = async (job) => {
    while (!idle.length) await new Promise<void>((resolve) => waiting.push(resolve));
    const w = idle.pop()!;
    const id = next++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      w.postMessage({ id, job });
    });
  };
}
const clock = () => (lanes > 1 ? cpuMs() / 1000 / lanes : cpuMs() / 1000);

const cells = panel
  .map((p, i) => ({ p, i }))
  .filter(({ i }) => !only || only.includes(i))
  .flatMap(({ p, i }) => seeds.map((seed) => ({ p, i, seed })))
  // Large problems first so that shards end together
  .sort((a, b) => b.p.P * Math.max(1, b.p.N) - a.p.P * Math.max(1, a.p.N));
fs.mkdirSync(path.join(here, "results"), { recursive: true });
const out = path.join(here, "results", `${tag}-${budget}${lanes > 1 ? `x${lanes}` : ""}.jsonl`);

for (let k = shard; k < cells.length; k += shards) {
  const { p, i, seed } = cells[k];
  const problem = { N: p.N, M: p.M, P: p.P };
  const warm = (
    p as { known?: { pieces: { x: number; y: number; theta: number }[]; container_phi: number; score: number } }
  ).known;
  const ref = warm ? p.literature : Math.min(p.literature, p.site_best ?? Infinity);
  const known = warm
    ? {
        config: { ...problem, pieces: warm.pieces, container_phi: warm.container_phi },
        score: warm.score,
        source: "site" as const,
      }
    : undefined;
  const t0 = clock();
  const trace: [number, number][] = [];
  const jobs: unknown[] = [];
  let best = Infinity;
  let stopped = "";
  if (mode === "engine") {
    const outcome = await searchProblem(
      {
        problem,
        leader: p.site_best,
        known,
        published: p.literature,
        areaBound: areaLowerBound(p.N, p.M, p.P),
        maxSeconds: budget,
        lanes,
        seed,
        now: () => clock() - t0,
        onResult: (r, b) => {
          const t = clock() - t0;
          jobs.push({
            t: +t.toFixed(3),
            m: r.job.method,
            k: r.job.kind,
            p: r.job.params ? JSON.stringify(r.job.params) : undefined,
            b: +r.job.budget.time_s.toFixed(2),
            e: r.evaluations,
            s: r.strict ? r.score : null,
            term: r.termination,
          });
          if (b && b.score < best) {
            best = b.score;
            trace.push([+t.toFixed(3), best]);
          }
        },
      },
      runJob,
      { aborted: false, paused: false },
    );
    best = outcome.best?.score ?? Infinity;
    stopped = outcome.stopped;
  } else {
    const method = mode.replace(/^method:/, "");
    const r = await run(problem, { method, seed, budget: { time_s: budget }, start: known?.config });
    if (r.strict && r.score !== null) best = r.score;
    trace.push([+(cpuMs() / 1000 - t0).toFixed(3), best]);
  }
  // A warm search's result is the better of its own best and the start it was given
  if (known) best = Math.min(best, known.score);
  const cpu = clock() - t0;
  const row = {
    i,
    N: p.N,
    M: p.M,
    P: p.P,
    seed,
    budget,
    stopped,
    start: known?.score,
    cpu: +cpu.toFixed(2),
    best,
    ref,
    gap: (best - ref) / ref,
    trace,
    jobs,
  };
  fs.appendFileSync(out, JSON.stringify(row) + "\n");
  console.log(
    `${p.N}/${p.M}/${p.P} s${seed} best ${best} gap ${(((best - ref) / ref) * 100).toFixed(4)}% cpu ${cpu.toFixed(1)}`,
  );
}
for (const w of workers) await w.terminate();
