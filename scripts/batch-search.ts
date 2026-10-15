/**
 * Unattended batch search: run several search methods and seeds on many problems in parallel
 * worker threads, keep the best packing of each problem, and optionally submit it to a PolyPack
 * server when it improves on that problem's current leader.
 *
 *   npx tsx scripts/batch-search.ts --help
 *
 * See docs/AUTOMATION.md for how to run it on a local machine, a rented server or a cloud sandbox.
 * The pure parts (option parsing, ordering, resume keys, pacing) live in batch-search/lib.ts.
 */
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { type PackingConfig, type ProblemInfo, type SubmitResponse, improvesOn } from "@polypack/geometry";
import { registry } from "@polypack/solver";
import {
  ALL_PIECE_COUNTS,
  ALL_SHAPES,
  type Budget,
  MethodStats,
  ORDERS,
  type Order,
  Pacer,
  type Problem,
  type RecordsResponse,
  type SiteInfo,
  crossProblems,
  formatDuration,
  orderProblems,
  pairKey,
  parseIntList,
  parsePieceCounts,
  parseShapes,
  problemKey,
  runKey,
  sampleProblems,
  siteInfoByP,
  submissionBody,
  summaryTable,
} from "./batch-search/lib";
import type { WorkerRequest, WorkerResult } from "./batch-search/protocol";

const HELP = `Usage: npx tsx scripts/batch-search.ts [options]

Problem set
  --N LIST              piece shapes, e.g. 0,3,4,5,6,8,12 or 3-8 (0 = circle)
  --M LIST              container shapes, same syntax
  --P LIST              piece counts, e.g. 1-50
  --sample K            draw K random problems instead of taking every combination; --N/--M/--P
                        then restrict the draw and default to the full ranges (0,3-100 and 1-500)
  --seed-problems S     seed of the --sample draw and of --order random (default 1)
  --order ORDER         missing-first (default), smallest-first or random. missing-first: problems
                        with neither a site leader nor a published value, then those whose leader
                        is missing or worse than the published value, then the rest
  --skip-existing       leave out problems that already have an entry on the site, so that
                        several machines can fill gaps without repeating each other
Search
  --methods LIST        search methods (default asc,harden); see --list-methods
  --seeds LIST          random seeds per method, e.g. 1-3 (default 1)
  --evals E             evaluation budget per run (default 20000)
  --time T              time budget per run in seconds (default 15)
  --workers W           parallel searches (default: os.availableParallelism())
Run control
  --hours H             stop launching runs after H hours; runs in flight finish
  --out DIR             output directory (default ./batch-out): runs.jsonl and best/N-M-P.json;
                        runs already recorded there are skipped (resume)
  --status-every S      seconds between progress lines (default 60)
Submission (nothing is ever sent without --submit)
  --submit              submit each problem's best when it improves on the current leader
  --base URL            server (default https://polypack.fly.dev)
  --name NAME           display name of the entries (required with --submit); an AI agent
                        uses its model name, e.g. "Claude Haiku 5.5"
  --note TEXT           free text shown with the entries (default: none). The method, its
                        parameters, the seed and the budget are always sent in their own fields
  --note-prefix TEXT    deprecated name of --note
Other
  --list-methods        list the search methods and exit
  --help                this text
`;

function fail(message: string): never {
  console.error(`batch-search: ${message}`);
  process.exit(2);
}

function parseOptions() {
  try {
    return parseArgs({
      options: {
        N: { type: "string" },
        M: { type: "string" },
        P: { type: "string" },
        sample: { type: "string" },
        "seed-problems": { type: "string", default: "1" },
        order: { type: "string", default: "missing-first" },
        "skip-existing": { type: "boolean", default: false },
        methods: { type: "string", default: "asc,harden" },
        seeds: { type: "string", default: "1" },
        evals: { type: "string", default: "20000" },
        time: { type: "string", default: "15" },
        workers: { type: "string" },
        hours: { type: "string" },
        out: { type: "string", default: "./batch-out" },
        "status-every": { type: "string", default: "60" },
        submit: { type: "boolean", default: false },
        base: { type: "string", default: "https://polypack.fly.dev" },
        name: { type: "string" },
        note: { type: "string" },
        "note-prefix": { type: "string" },
        "list-methods": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    fail(`${(error as Error).message}\n\n${HELP}`);
  }
}
const opts = parseOptions();
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

// identity and polish refine a configuration they are given; every batch run starts from nothing
const NEEDS_START = new Set(["identity", "polish"]);
const registered = registry.list().map((m) => m.name);
if (opts["list-methods"]) {
  for (const m of registry.list()) {
    const note = NEEDS_START.has(m.name) ? " (needs a start: not usable here)" : "";
    console.log(`${m.name.padEnd(14)} ${(m.schema as { description?: string }).description ?? ""}${note}`);
  }
  process.exit(0);
}

// ---------- options ----------

function positiveInteger(name: string, text: string): number {
  if (!/^\d{1,9}$/.test(text) || Number(text) < 1) fail(`--${name} must be a positive integer`);
  return Number(text);
}
function positiveNumber(name: string, text: string): number {
  const v = Number(text);
  if (text.trim() === "" || !Number.isFinite(v) || v <= 0) fail(`--${name} must be a positive number`);
  return v;
}
function list<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    fail((error as Error).message);
  }
}

const methods = [
  ...new Set(
    opts.methods
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
if (methods.length === 0) fail("--methods names no method");
for (const m of methods) {
  if (!registered.includes(m)) fail(`unknown method "${m}"; registered: ${registered.join(", ")}`);
  if (NEEDS_START.has(m)) fail(`"${m}" refines a starting configuration; the batch runner starts from nothing`);
}
const seeds = list(() => parseIntList(opts.seeds, "seeds", 0, 999_999));
const budget: Budget = { evals: positiveInteger("evals", opts.evals), time_s: positiveNumber("time", opts.time) };
const availableParallelism = os.availableParallelism();
const workerCount = opts.workers === undefined ? availableParallelism : positiveInteger("workers", opts.workers);
const hours = opts.hours === undefined ? Infinity : positiveNumber("hours", opts.hours);
const statusEvery = positiveNumber("status-every", opts["status-every"]);
const problemSeed = list(() => parseIntList(opts["seed-problems"], "seed-problems", 0, 999_999))[0];
if (!ORDERS.includes(opts.order as Order)) fail(`--order must be one of ${ORDERS.join(", ")}`);
const order = opts.order as Order;
const base = opts.base.replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) fail("--base must be an http(s) URL");
const name = (opts.name ?? "").trim();
if (opts.submit && !name) fail("--submit needs --name");
if (name.length > 40) fail("--name is limited to 40 characters by the server");
if (opts.note !== undefined && opts["note-prefix"] !== undefined) fail("give --note or --note-prefix, not both");
// --note-prefix is the old name: it was put before an automatic note, which is no longer written
const note = (opts.note ?? opts["note-prefix"] ?? "").trim();
if (note.length > 200) fail("--note is limited to 200 characters by the server");

let problems: Problem[];
if (opts.sample !== undefined) {
  const K = positiveInteger("sample", opts.sample);
  const Ns = opts.N === undefined ? ALL_SHAPES : list(() => parseShapes(opts.N!, "N"));
  const Ms = opts.M === undefined ? ALL_SHAPES : list(() => parseShapes(opts.M!, "M"));
  const Ps = opts.P === undefined ? ALL_PIECE_COUNTS : list(() => parsePieceCounts(opts.P!));
  problems = sampleProblems(K, problemSeed, Ns, Ms, Ps);
} else {
  if (opts.N === undefined || opts.M === undefined || opts.P === undefined)
    fail("give --N, --M and --P, or --sample K (see --help)");
  const Ns = list(() => parseShapes(opts.N!, "N"));
  const Ms = list(() => parseShapes(opts.M!, "M"));
  const Ps = list(() => parsePieceCounts(opts.P!));
  if (Ns.length * Ms.length * Ps.length > 200_000) fail("more than 200000 problems: narrow the set or use --sample");
  problems = crossProblems(Ns, Ms, Ps);
}

// ---------- shutdown, sleeping and the network ----------

/** Aborted on SIGINT/SIGTERM: cancels sleeps and requests so that the batch ends promptly. */
const shutdown = new AbortController();
const sleep = (ms: number) => delay(ms, undefined, { signal: shutdown.signal });

class HttpAnswer {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/**
 * One HTTP request with a 30 s timeout. Network failures and 5xx answers are retried with
 * exponential backoff (2 s doubling to 60 s, `attempts` tries); any other answer is returned.
 * Returns null when every attempt failed or the batch is shutting down; never throws.
 */
async function request(url: string, init: RequestInit = {}, attempts = 6): Promise<HttpAnswer | null> {
  for (let attempt = 0; attempt < attempts && !shutdown.signal.aborted; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: keep the text
      }
      if (response.status < 500) return new HttpAnswer(response.status, body);
      log(`HTTP ${response.status} from ${url}; retrying`);
    } catch (error) {
      if (shutdown.signal.aborted) return null;
      log(`request to ${url} failed: ${(error as Error).message}; retrying`);
    }
    try {
      await sleep(Math.min(60_000, 2000 * 2 ** attempt));
    } catch {
      return null;
    }
  }
  return null;
}

const started = Date.now();
function log(message: string): void {
  console.log(`[${formatDuration((Date.now() - started) / 1000).padStart(6)}] ${message}`);
}

// ---------- output directory and resume ----------

const outDir = resolve(opts.out);
const bestDir = join(outDir, "best");
mkdirSync(bestDir, { recursive: true });
const runsPath = join(outDir, "runs.jsonl");
const appendLine = (record: object) => appendFileSync(runsPath, JSON.stringify(record) + "\n");

console.log(
  `batch-search: Node ${process.version}, ${workerCount} worker(s); os.availableParallelism() ${availableParallelism}, ` +
    `os.cpus().length ${os.cpus().length}, memory ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB`,
);
console.log(
  `methods ${methods.join(",")}, seeds ${seeds.join(",")}, budget ${budget.evals} evaluations / ${budget.time_s} s per run, ` +
    `${problems.length} problem(s), order ${order}, output ${outDir}` +
    (Number.isFinite(hours) ? `, cap ${hours} h` : "") +
    (opts.submit ? `, submitting to ${base} as "${name}"` : ", not submitting"),
);

// ---------- what the site knows: one request per (N, M) pair ----------

const siteInfo = new Map<string, Map<number, SiteInfo>>();
{
  const pairs = [...new Set(problems.map((p) => pairKey(p.N, p.M)))];
  let unreachable = 0;
  // a few requests at a time: the records listing is not rate limited, but there may be thousands of pairs
  const queue = [...pairs];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        const [N, M] = key.split("-");
        const answer = await request(`${base}/api/records?N=${N}&M=${M}`, {}, 4);
        if (answer && answer.status === 200) siteInfo.set(key, siteInfoByP(answer.body as RecordsResponse));
        else unreachable++;
      }
    }),
  );
  if (unreachable)
    log(
      `could not read the records of ${unreachable} of ${pairs.length} (N, M) pair(s) from ${base}: ` +
        "their closed status, published values and leaders are unknown",
    );
}
const infoOf = (p: Problem) => siteInfo.get(pairKey(p.N, p.M))?.get(p.P);

// ---------- per-problem state ----------

interface BestFile {
  N: number;
  M: number;
  P: number;
  score: number;
  strict: boolean;
  method: string;
  seed: number;
  budget: Budget;
  evaluations: number;
  found_at: string;
  published: number | null;
  config: PackingConfig;
  /** The method's resolved parameters; absent in files written before they were kept. */
  params?: Record<string, unknown>;
}
interface ProblemState {
  problem: Problem;
  key: string;
  /** Runs of this invocation's method x seed set still to do. */
  remaining: number;
  /** Runs completed by this invocation. */
  newRuns: number;
  /** Best of the runs of the current method x seed x budget set (for the per-method statistics). */
  setBest: { score: number; method: string } | null;
  /** Best of best/N-M-P.json; undefined until read. Kept in memory only while the problem is active. */
  file?: BestFile | null;
  done: boolean;
}

const skippedClosed = problems.filter((p) => infoOf(p)?.closed);
// The leaders were read once at start; a problem filled by another machine since then is still searched.
const skippedExisting = opts["skip-existing"]
  ? problems.filter((p) => !infoOf(p)?.closed && infoOf(p)?.leader != null)
  : [];
const open = orderProblems(
  problems.filter((p) => !infoOf(p)?.closed && !skippedExisting.includes(p)),
  order,
  infoOf,
  problemSeed,
);
const states = new Map<string, ProblemState>();
for (const p of open)
  states.set(problemKey(p), {
    problem: p,
    key: problemKey(p),
    remaining: methods.length * seeds.length,
    newRuns: 0,
    setBest: null,
    done: false,
  });
const stats = new Map(methods.map((m) => [m, new MethodStats()]));
const doneKeys = new Set<string>();
const wanted = new Set(methods);
const wantedSeeds = new Set(seeds);

interface RunLine {
  type: "run";
  N: number;
  M: number;
  P: number;
  method: string;
  seed: number;
  evals: number;
  time_s: number;
  score: number | null;
  valid: boolean;
  wall_s: number;
}

/** Account one run (new or read back from runs.jsonl) in its problem's state and the statistics. */
function account(st: ProblemState, line: Pick<RunLine, "method" | "score" | "valid" | "wall_s">): void {
  st.remaining--;
  const s = stats.get(line.method)!;
  s.runs++;
  s.wall.push(line.wall_s);
  const published = infoOf(st.problem)?.published ?? null;
  if (line.valid && line.score !== null) {
    if (published) s.ratios.push(line.score / published);
    if (!st.setBest || improvesOn(line.score, st.setBest.score))
      st.setBest = { score: line.score, method: line.method };
  }
}

let resumed = 0;
if (existsSync(runsPath)) {
  const lines = createInterface({ input: createReadStream(runsPath), crlfDelay: Infinity });
  for await (const text of lines) {
    let line: RunLine;
    try {
      line = JSON.parse(text);
    } catch {
      continue; // a line cut short by a crash
    }
    if (line?.type !== "run") continue;
    const key = runKey(line, line.method, line.seed, { evals: line.evals, time_s: line.time_s });
    if (doneKeys.has(key)) continue;
    doneKeys.add(key);
    const st = states.get(problemKey(line));
    if (!st || !wanted.has(line.method) || !wantedSeeds.has(line.seed)) continue;
    if (line.evals !== budget.evals || line.time_s !== budget.time_s) continue;
    account(st, line);
    resumed++;
  }
}

const totalRuns = open.length * methods.length * seeds.length;
let runsDone = resumed;
let newRunsDone = 0;
let problemsDone = 0;
const sub = { sent: 0, accepted: 0, leading: 0, skipped: 0, failed: 0 };
log(
  `${open.length} open problem(s), ${skippedClosed.length} closed skipped` +
    (opts["skip-existing"] ? `, ${skippedExisting.length} with an entry skipped` : "") +
    `; ${totalRuns} run(s), ` +
    `${resumed} already in ${runsPath}`,
);

function bestPath(p: Problem): string {
  return join(bestDir, `${problemKey(p)}.json`);
}
function loadBest(st: ProblemState): BestFile | null {
  if (st.file === undefined) {
    try {
      st.file = existsSync(bestPath(st.problem))
        ? (JSON.parse(readFileSync(bestPath(st.problem), "utf8")) as BestFile)
        : null;
    } catch {
      st.file = null; // unreadable: the next valid run rewrites it
    }
  }
  return st.file;
}
function saveBest(st: ProblemState, best: BestFile): void {
  // write and rename, so that an interruption never leaves a half-written file
  const path = bestPath(st.problem);
  writeFileSync(`${path}.tmp`, JSON.stringify(best, null, 1));
  renameSync(`${path}.tmp`, path);
  st.file = best;
}

// ---------- submissions ----------

/** At most 25 POSTs per sliding minute across the whole batch; the server allows 120 per address, shared by every copy behind one. */
const pacer = new Pacer(25, 60_000, Date.now, sleep);
const submitQueue: ProblemState[] = [];
let submitter: Promise<void> | null = null;

function enqueueSubmission(st: ProblemState): void {
  if (!opts.submit) {
    st.file = undefined; // nothing more to do with it: free the configuration
    return;
  }
  submitQueue.push(st);
  submitter ??= (async () => {
    for (let next = submitQueue.shift(); next && !shutdown.signal.aborted; next = submitQueue.shift()) {
      try {
        await submitBest(next);
      } catch (error) {
        if (!shutdown.signal.aborted) log(`submission for ${next.key} failed: ${(error as Error).message}`);
      }
      next.file = undefined;
    }
    submitter = null;
  })();
}

/** Submit a problem's best when it improves on the current leader (re-read just before). */
async function submitBest(st: ProblemState): Promise<void> {
  const best = loadBest(st);
  if (!best) return;
  const p = st.problem;
  const info = infoOf(p);
  const record = (fields: object) =>
    appendLine({
      type: "submission",
      time: new Date().toISOString(),
      ...p,
      method: best.method,
      seed: best.seed,
      ...best.budget,
      score: best.score,
      ...fields,
    });
  // the cached leader saves a request when the best is already known not to improve on it
  if (info?.leader != null && !improvesOn(best.score, info.leader)) {
    sub.skipped++;
    return record({ submitted: false, decision: "not better than the cached leader", leader_score: info.leader });
  }
  const fresh = await request(`${base}/api/problems/${p.N}/${p.M}/${p.P}`);
  if (!fresh || fresh.status !== 200) {
    sub.failed++;
    return record({ submitted: false, decision: "could not read the problem", status: fresh?.status ?? null });
  }
  const problemInfo = fresh.body as ProblemInfo;
  const leader = problemInfo.site_best?.score ?? null;
  if (info) info.leader = leader;
  if (problemInfo.accepts_submissions === false) {
    if (info) info.closed = true;
    sub.skipped++;
    return record({ submitted: false, decision: "closed" });
  }
  if (leader !== null && !improvesOn(best.score, leader)) {
    sub.skipped++;
    return record({ submitted: false, decision: "not better than the leader", leader_score: leader });
  }
  const body = JSON.stringify(submissionBody(best, name, note));
  let answer: HttpAnswer | null = null;
  for (let attempt = 0; ; attempt++) {
    await pacer.acquire();
    sub.sent++;
    answer = await request(`${base}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (answer?.status !== 429 || attempt === 3) break;
    // the server counts every POST from this address; hold every submission back for a minute
    log(`HTTP 429 for ${st.key}; waiting 65 s`);
    pacer.block(65_000);
  }
  if (!answer) {
    sub.failed++;
    return record({ submitted: true, decision: "network error", status: null });
  }
  const response = answer.body as SubmitResponse;
  if (answer.status === 409 && info) info.closed = true;
  if (answer.status === 200 && response.valid) {
    sub.accepted++;
    if (response.leader) {
      sub.leading++;
      if (info) info.leader = response.score;
    }
  } else sub.failed++;
  log(
    `submitted ${st.key} ${best.score.toFixed(6)} (${best.method}, seed ${best.seed}): HTTP ${answer.status}` +
      (answer.status === 200
        ? response.leader
          ? ", leader"
          : `, leader stays ${response.leader_score}`
        : `, ${(response.reasons ?? []).join("; ")}`),
  );
  record({
    submitted: true,
    status: answer.status,
    valid: response.valid ?? false,
    leader: response.leader ?? false,
    server_score: response.score ?? null,
    leader_score: response.leader_score ?? null,
    id: response.id ?? null,
    pending_verification: response.pending_verification ?? false,
    reasons: response.reasons ?? [],
  });
}

function problemFinished(st: ProblemState): void {
  st.done = true;
  problemsDone++;
  if (st.setBest) stats.get(st.setBest.method)!.bests++;
  enqueueSubmission(st);
}

// problems completed entirely by earlier invocations: still submit their best if it improves
for (const st of states.values()) if (st.remaining === 0) problemFinished(st);

// ---------- the worker pool ----------

interface Task {
  st: ProblemState;
  method: string;
  seed: number;
}
function* taskList(): Generator<Task> {
  for (const st of states.values()) {
    if (st.done) continue;
    for (const method of methods)
      for (const seed of seeds) if (!doneKeys.has(runKey(st.problem, method, seed, budget))) yield { st, method, seed };
  }
}
const tasks = taskList();
const deadline = started + hours * 3600_000;
let stopping = false;
let interrupted = false;
let nextId = 1;
// The worker is bundled into one plain JavaScript file first. Threads do not reliably inherit tsx's
// loader: on Node 22, which strips TypeScript types itself, a thread loads the .ts entry natively and
// then fails on the sources' extensionless imports.
const workerFile = join(os.tmpdir(), `polypack-batch-worker-${process.pid}.mjs`);
await build({
  entryPoints: [new URL("./batch-search/worker.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: workerFile,
  logLevel: "error",
});
const workerUrl = new URL(`file://${workerFile}`);
process.on("exit", () => rmSync(workerFile, { force: true }));
// A cooperative run ends within its time budget; this only catches a stuck or runaway thread.
const watchdogMs = (budget.time_s * 3 + 60) * 1000;

/** One worker thread running one search at a time; a crashed or stuck thread is replaced. */
class Slot {
  private worker!: Worker;
  private pending: { id: number; resolve: (r: WorkerResult) => void; timer: NodeJS.Timeout } | null = null;

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    const worker = new Worker(workerUrl, { execArgv: [] });
    this.worker = worker;
    worker.on("message", (m: WorkerResult) => {
      if (this.pending && m.id === this.pending.id) this.settle(m);
    });
    worker.on("error", (error) => this.lost(worker, `crashed: ${error.message}`));
    worker.on("exit", (code) => this.lost(worker, `exited with code ${code}`));
  }

  private lost(worker: Worker, why: string): void {
    if (worker !== this.worker) return;
    if (this.pending) this.settle(failed(this.pending.id, "crashed", why));
    if (!stopping) this.spawn();
  }

  private settle(result: WorkerResult): void {
    const pending = this.pending!;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(result);
  }

  run(request: Extract<WorkerRequest, { type: "run" }>): Promise<WorkerResult> {
    return new Promise((resolveRun) => {
      const timer = setTimeout(() => {
        const stuck = this.worker;
        this.settle(failed(request.id, "timeout", `no answer within ${watchdogMs / 1000} s`));
        this.spawn();
        void stuck.terminate();
      }, watchdogMs);
      this.pending = { id: request.id, resolve: resolveRun, timer };
      this.worker.postMessage(request);
    });
  }

  abort(): void {
    if (this.pending) this.worker.postMessage({ type: "abort" } satisfies WorkerRequest);
  }

  /** Ends the thread; a search still in flight resolves as aborted. */
  async close(): Promise<void> {
    if (this.pending) this.settle(failed(this.pending.id, "aborted", "terminated at shutdown"));
    await this.worker.terminate();
  }

  get busy(): boolean {
    return this.pending !== null;
  }
}

function failed(id: number, termination: string, reason: string): WorkerResult {
  return {
    type: "result",
    id,
    score: null,
    valid: false,
    strict: false,
    evaluations: 0,
    wallTime: 0,
    termination,
    reasons: [reason],
  };
}

function handleResult(task: Task, r: WorkerResult): void {
  const { st, method, seed } = task;
  const p = st.problem;
  // An interrupted run is not a finished experiment: it is not recorded and runs again on resume.
  if (r.termination === "aborted") return;
  const published = infoOf(p)?.published ?? null;
  const line = {
    type: "run",
    time: new Date().toISOString(),
    ...p,
    method,
    seed,
    evals: budget.evals,
    time_s: budget.time_s,
    score: r.score,
    valid: r.valid,
    strict: r.strict,
    evaluations: r.evaluations,
    wall_s: Math.round(r.wallTime * 1000) / 1000,
    termination: r.termination,
    published,
    ratio: r.valid && r.score !== null && published ? r.score / published : null,
    ...(r.valid ? {} : { reasons: r.reasons }),
  };
  appendLine(line);
  doneKeys.add(runKey(p, method, seed, budget));
  account(st, line as RunLine);
  st.newRuns++;
  runsDone++;
  newRunsDone++;
  if (r.valid && r.score !== null && r.best) {
    const current = loadBest(st);
    if (!current || improvesOn(r.score, current.score)) {
      saveBest(st, {
        ...p,
        score: r.score,
        strict: r.strict,
        method,
        seed,
        budget,
        evaluations: r.evaluations,
        found_at: line.time,
        published,
        config: r.best,
        ...(r.params ? { params: r.params } : {}),
      });
    }
  }
  if (st.remaining === 0) problemFinished(st);
}

async function workerLoop(slot: Slot): Promise<void> {
  while (!stopping) {
    if (Date.now() >= deadline) {
      if (!stopping) log(`the ${hours} h cap is reached: no new runs are started`);
      stopping = true;
      break;
    }
    const next = tasks.next();
    if (next.done) break;
    const task = next.value;
    const result = await slot.run({
      type: "run",
      id: nextId++,
      problem: task.st.problem,
      method: task.method,
      seed: task.seed,
      budget,
    });
    handleResult(task, result);
  }
}

// ---------- progress ----------

function statusLine(): string {
  const elapsed = (Date.now() - started) / 1000;
  const perMinute = newRunsDone / Math.max(elapsed / 60, 1e-9);
  const left = totalRuns - runsDone;
  const eta = left === 0 ? 0 : perMinute > 0 ? (left / perMinute) * 60 : Infinity;
  const bests = methods.map((m) => `${m} ${stats.get(m)!.bests}`).join(", ");
  return (
    `runs ${runsDone}/${totalRuns}, problems ${problemsDone}/${open.length}, ` +
    `submissions sent ${sub.sent} accepted ${sub.accepted} leading ${sub.leading}, ` +
    `${perMinute.toFixed(1)} runs/min, ETA ${formatDuration(eta)}` +
    (Number.isFinite(hours) ? ` (cap in ${formatDuration((deadline - Date.now()) / 1000)})` : "") +
    `; best for its problem: ${bests}`
  );
}
const ticker = setInterval(() => log(statusLine()), statusEvery * 1000);

// ---------- signals ----------

let slots: Slot[] = [];
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interrupted) {
      console.log(`${signal} again: exiting at once`);
      process.exit(0);
    }
    interrupted = true;
    stopping = true;
    log(`${signal}: no new runs; aborting ${slots.filter((s) => s.busy).length} run(s) in flight`);
    shutdown.abort();
    for (const slot of slots) slot.abort();
    // a search that does not stop at its next cooperative check is terminated
    setTimeout(() => {
      for (const slot of slots) if (slot.busy) void slot.close();
    }, 5000).unref();
  });
}

// ---------- run ----------

const pendingRuns = totalRuns - runsDone;
slots = Array.from({ length: Math.max(0, Math.min(workerCount, pendingRuns)) }, () => new Slot());
await Promise.all(slots.map(workerLoop));
stopping = true;
await Promise.all(slots.map((slot) => slot.close()));

if (!interrupted && opts.submit) {
  // the cap stopped some problems part way: their best so far is still worth submitting
  for (const st of states.values()) if (!st.done && st.newRuns > 0) enqueueSubmission(st);
  if (submitter) log("waiting for the remaining submissions");
}
while (submitter && !interrupted) await submitter;
clearInterval(ticker);

log(statusLine());
console.log(
  `\nsummary over the runs of this problem set and budget in ${runsPath} (including earlier invocations); ` +
    "ratio = score / published value where one exists, bests = problems whose best run came from the method\n",
);
console.log(summaryTable(stats));
console.log(
  `\nsubmissions: ${sub.sent} sent, ${sub.accepted} accepted, ${sub.leading} took the lead, ` +
    `${sub.skipped} not needed, ${sub.failed} refused or failed` +
    (interrupted
      ? "\ninterrupted: unfinished runs and submissions are picked up by running the same command again"
      : ""),
);
process.exit(0);
