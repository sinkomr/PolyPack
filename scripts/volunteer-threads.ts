/**
 * Simulates the volunteer client's search of one problem with K ideal threads, on one real core.
 * docs/VOLUNTEER.md ("Several problems at once") reports what it measured.
 *
 * The engine (apps/volunteer/src/engine) takes its clock (`now`), its number of lanes and its job
 * runner as arguments. Here every job really runs, one at a time, with the client's own inline
 * runner, and its measured duration decides when, on a virtual clock, its result is handed back.
 * K lanes then behave as K cores that never contend, and the engine makes the decisions it would
 * make on them. A run of K lanes for T seconds takes about K * T seconds of one core.
 *
 * The problem and its start (the site leader's packing) come from a file of the records release,
 * https://github.com/sinkomr/PolyPack/releases/tag/records, such as 20-3.json.gz.
 *
 * Usage: npx tsx scripts/volunteer-threads.ts <N-M.json.gz> <P> <lanes> <maxSeconds> <seed> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { areaLowerBound, type PackingConfig } from "../packages/geometry/src/index";
import { inlineRunJob, searchProblem } from "../apps/volunteer/src/engine/index";
import type { Control, JobResult, RunJob } from "../apps/volunteer/src/types";

const [recordsPath, pArg, lanesArg, secondsArg, seedArg, outPath] = process.argv.slice(2);
const P = Number(pArg);
const lanes = Number(lanesArg);
const maxSeconds = Number(secondsArg);
const seed = Number(seedArg);

const file = JSON.parse(gunzipSync(readFileSync(recordsPath)).toString("utf8"));
const rec = file.records.find((r: { P: number }) => r.P === P);
if (!rec) throw new Error(`no record for P=${P}`);
const known: PackingConfig = {
  N: file.N,
  M: file.M,
  P,
  pieces: rec.pieces.map(([x, y, theta]: number[]) => ({ x, y, theta })),
  container_phi: rec.container_phi,
};
const leader: number = rec.score;

// ---- the virtual clock and the serialized runner ----
let V = 0;
let computing = 0;
let chain: Promise<unknown> = Promise.resolve();
const pending: { finish: number; resolve: (r: JobResult) => void; result: JobResult }[] = [];
let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(tick);
}

/** Hands back the earliest result once no job is being computed and the engine has had its turn. */
function tick(): void {
  scheduled = false;
  if (computing > 0 || pending.length === 0) return;
  pending.sort((a, b) => a.finish - b.finish);
  const next = pending.shift()!;
  V = Math.max(V, next.finish);
  next.resolve(next.result);
  schedule();
}

let cpuSeconds = 0;
const runJob: RunJob = (job, control: Control) => {
  computing++;
  const start = V;
  return new Promise<JobResult>((resolve) => {
    chain = chain.then(async () => {
      const t0 = performance.now();
      const result = await inlineRunJob(job, control);
      const d = (performance.now() - t0) / 1000;
      cpuSeconds += d;
      computing--;
      pending.push({ finish: start + d, resolve, result });
      schedule();
    });
  });
};

const curve: [number, number][] = [];
const control: Control = { aborted: false, paused: false };
const wall0 = performance.now();
const outcome = await searchProblem(
  {
    problem: { N: known.N, M: known.M, P },
    known: { config: known, score: leader, source: "site" },
    leader,
    published: null,
    areaBound: areaLowerBound(known.N, known.M, P),
    maxSeconds,
    lanes,
    seed,
    now: () => V,
    onResult: (_r, best) => {
      if (best && (curve.length === 0 || best.score < curve[curve.length - 1][1])) curve.push([V, best.score]);
    },
  },
  runJob,
  control,
);
const best = outcome.best?.score ?? null;
const out = {
  N: known.N,
  M: known.M,
  P,
  lanes,
  maxSeconds,
  seed,
  leader,
  best,
  gainPct: best === null ? null : (100 * (leader - best)) / leader,
  beatLeader: best !== null && best < leader * (1 - 1e-9),
  jobs: outcome.jobs,
  stopped: outcome.stopped,
  virtualSeconds: V,
  cpuSeconds,
  wallSeconds: (performance.now() - wall0) / 1000,
  curve,
};
writeFileSync(outPath, JSON.stringify(out));
console.log(
  `${known.N}/${known.M}/${P} lanes=${lanes} seed=${seed}: gain ${out.gainPct?.toFixed(3)}% jobs ${out.jobs} ${out.stopped} v=${V.toFixed(0)}s cpu=${cpuSeconds.toFixed(0)}s`,
);
