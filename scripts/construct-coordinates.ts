// Constructs coordinates for published records that have none, using PolyPack's own solver
// library, and keeps a packing only when it reaches the published value. The successes go to
// data/sources/constructed.json; scripts/build-records.ts attaches them to the records.
//
//   npx tsx scripts/construct-coordinates.ts [--time-min 150] [--jobs 6] [--log construct-coordinates.log.jsonl]
//       [--only 4/0/3,5/5/6] [--max-p 50] [--max-tier 3] [--group proven|all] [--report]
//
// What a drawing means: it shows *a* packing whose size is the published value, within the
// record's own tolerance 10^-display_precision. It is not necessarily the arrangement of the
// source, which is often unknown here.
//
// Acceptance of one configuration (`check` below), all with the shared geometry:
//   - evaluate(config, {autoOrient: true}) is valid; the container angle it finds is stored;
//   - evaluated again at that stored angle, without auto-orientation, it is valid with the same
//     score (this is what packages/geometry/test/records.test.ts and build-records.ts check);
//   - strict: no pair penetrates by more than the solver's strict margin (1e-12, `strictTolerance`),
//     so the packing does not lean on the 1e-9 validity allowance, and it passes the server's
//     shrink test `strictVerify` (the test applied to submissions that beat a published value);
//   - published - tol <= score <= published + tol, tol = 10^-display_precision (doubled for a circle container, whose size
//     is the diameter: sourceTolerance in scripts/units.ts).
//     A score above that is never kept. A score below it is not stored as a drawing; it is logged
//     as "below" and listed by `--report`.
//
// Search, in tiers per record; a later tier runs only when the earlier ones found nothing:
//   0: the seed method (lattice, ring and row generators) and, when an adjacent record of the same
//      N and M has coordinates (in records.json or constructed earlier in the run), the seed
//      method's record_plus_one / record_minus_one from it. Each with the framework's final polish.
//   1: the adjacent-record seeds again (a neighbour may have been constructed meanwhile), then local
//      search at 3,000 evaluations, seed 1: harden for polygons, basin hopping for circles; basin
//      hopping from the best tier-0 configuration; ls_growth for circles.
//   2: morph (polygons) and mc_compress at 3,000 evaluations, seed 1; harden (polygons) or basin
//      hopping (circles) at 10,000 evaluations, seed 2.
//   3: harden and basin hopping (polygons) or basin hopping and ls_growth (circles) at 30,000
//      evaluations, seeds 1 and 2.
// Methods were chosen from the measurements in docs/methods/*.md (harden is the strongest on
// squares, basin hopping on circles, pentagons and hexagons).
// Budgets are evaluation counts (reproducible bit for bit with the same seed in the same Node
// version); a generous time limit only guards against runaway runs, and a run it cut short says
// so (termination "time") and is then not exactly reproducible.
//
// Order: proven and proven_unrefereed records first, then best_known by increasing P (see `phase`). Records are
// worked on by at most `--jobs` (<= 6) child processes. Every finished attempt is appended to the
// log, so a second invocation resumes where the first stopped. `--report` prints a summary of
// the log without searching.
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type LiteratureRecord,
  type PackingConfig,
  type Pose,
  evaluate,
  findOverlaps,
  isProven,
  strictVerify,
} from "@polypack/geometry";
import { identifyContacts, run, strictTolerance } from "@polypack/solver";
import { sourceTolerance } from "./units";

const RECORDS = "data/records.json";
const OUTPUT = "data/sources/constructed.json";
const MAX_JOBS = 6;
const TIERS = [0, 1, 2, 3];
const START_TIER0 = "best configuration of tier 0";

// ---------- shared types ----------

interface Neighbour {
  /** P of the adjacent record. */
  P: number;
  from: "records.json" | "constructed";
  config: PackingConfig;
}

interface Job {
  key: string;
  N: number;
  M: number;
  P: number;
  value: number;
  display_precision: number;
  tier: number;
  neighbours: Neighbour[];
  /** Best valid configuration of an earlier tier, as a start for tier 1. */
  start?: PackingConfig;
}

/** One solver run as it can be repeated. */
interface Recipe {
  method: string;
  params: Record<string, unknown>;
  seed: number;
  budget: { evals: number; time_s: number };
  finalPolish: boolean;
  /** Where the start or the adjacent record came from, if any. */
  start: string;
}

interface Attempt extends Recipe {
  score: number | null;
  valid: boolean;
  strict: boolean;
  termination: string;
  evaluations: number;
  wallTime: number;
  verdict: "reached" | "above" | "below" | "invalid" | "not_strict";
  /** Contraction factor of `tighten` applied to the run's best, when that was needed. */
  tighten?: number;
  /** The run's best was refined by python/polish_mp.py (50-digit contact solve) before the check. */
  mpPolish?: boolean;
}

interface JobResult {
  key: string;
  tier: number;
  outcome: "reached" | "below" | "unsolved";
  attempts: Attempt[];
  /** The accepted configuration (reached) or the one below the published value. */
  config?: PackingConfig;
  score?: number;
  /** Index into attempts of the accepted or below configuration. */
  winner?: number;
  /** Best valid configuration seen, kept for the next tier's start. */
  best?: PackingConfig;
  bestScore?: number;
  seconds: number;
}

const tolerance = (r: { N: number; M: number; display_precision: number }) => sourceTolerance(r.N, r.M, r.display_precision);
const keyOf = (r: { N: number; M: number; P: number }) => `${r.N}/${r.M}/${r.P}`;

// ---------- acceptance ----------

export interface Check {
  verdict: Attempt["verdict"];
  score: number | null;
  config?: PackingConfig;
}

/** The acceptance rule described at the top of this file. */
export function check(config: PackingConfig, value: number, display_precision: number): Check {
  const auto = evaluate(config, { autoOrient: true });
  if (!auto.valid || !auto.container) return { verdict: "invalid", score: null };
  const stored: PackingConfig = {
    N: config.N,
    M: config.M,
    P: config.P,
    pieces: config.pieces.map((p) => ({ x: p.x, y: p.y, theta: p.theta })),
    container_phi: auto.container.phi,
  };
  const fixed = evaluate(stored);
  if (!fixed.valid || !fixed.container) return { verdict: "invalid", score: null };
  const score = fixed.score!;
  if (findOverlaps(stored.N, stored.pieces, strictTolerance(stored)).length) return { verdict: "not_strict", score };
  if (!strictVerify(stored.N, stored.pieces, fixed.container).ok) return { verdict: "not_strict", score };
  const tol = sourceTolerance(config.N, config.M, display_precision);
  if (score > value + tol) return { verdict: "above", score };
  if (score < value - tol) return { verdict: "below", score, config: stored };
  return { verdict: "reached", score, config: stored };
}

/**
 * Contracts all centres towards the container centre by the factor 1 - delta, taking the largest
 * delta in [0, 1e-6] (bisection) at which no pair of pieces penetrates at all in floating point
 * (separation >= 0, stricter than the strict margin) and the configuration still passes `check`'s
 * validity and strictness tests. Lattice seeds and the float polish stop a few 1e-13 short of
 * contact on purpose; this recovers that margin for values printed to 12 or more decimals. It
 * moves no piece relative to the others except by the common contraction, and keeps every angle.
 */
export function tighten(config: PackingConfig, value: number, display_precision: number): { delta: number; check: Check } | undefined {
  const auto = evaluate(config, { autoOrient: true });
  if (!auto.valid || !auto.container) return undefined;
  const { cx, cy } = auto.container;
  const at = (delta: number): PackingConfig => ({
    ...config,
    pieces: config.pieces.map((p) => ({ x: cx + (1 - delta) * (p.x - cx), y: cy + (1 - delta) * (p.y - cy), theta: p.theta })),
  });
  const ok = (delta: number) => {
    const c = at(delta);
    if (findOverlaps(c.N, c.pieces, 0).length) return undefined;
    const r = check(c, value, display_precision);
    return r.verdict === "invalid" || r.verdict === "not_strict" ? undefined : r;
  };
  let lo = 0;
  let hi = 1e-6;
  let best = ok(0);
  if (!best) return undefined;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const r = ok(mid);
    if (r) {
      lo = mid;
      best = r;
    } else hi = mid;
  }
  return { delta: lo, check: best };
}

// ---------- the worker: runs one tier of one record ----------

/** Evaluation and time budgets scaled with P: evaluations cost roughly linearly more for large P. */
function seconds(base: number, P: number): number {
  return Math.round(base * Math.max(1, P / 25));
}

function recipes(job: Job): Recipe[] {
  const { N, P, tier } = job;
  const out: Recipe[] = [];
  const neighbourRecipes = (): Recipe[] =>
    job.neighbours.map((nb) => ({
      method: "seed",
      params: { kind: nb.P === P - 1 ? "record_plus_one" : "record_minus_one", record: nb.config },
      seed: 1,
      // record_minus_one tries every deletion: P + 1 assessments, plus the polish reserve
      budget: { evals: Math.max(1500, 4 * (P + 1)), time_s: seconds(60, P) },
      finalPolish: true,
      start: `adjacent record ${keyOf({ N: job.N, M: job.M, P: nb.P })} (${nb.from})`,
    }));
  if (tier === 0) {
    out.push({
      method: "seed",
      params: { kind: "auto" },
      seed: 1,
      budget: { evals: 1500, time_s: seconds(60, P) },
      finalPolish: true,
      start: "none",
    });
    out.push(...neighbourRecipes());
  } else if (tier === 1) {
    // adjacent records may have been constructed since tier 0 ran
    out.push(...neighbourRecipes());
    const local = (method: string, seed: number, evals: number, base: number, start = "none"): Recipe => ({
      method, params: {}, seed, budget: { evals, time_s: seconds(base, P) }, finalPolish: true, start,
    });
    out.push(local(N === 0 ? "basin_hopping" : "harden", 1, 3000, 90));
    if (job.start) out.push(local("basin_hopping", 1, 3000, 90, START_TIER0));
    else if (N !== 0) out.push(local("basin_hopping", 1, 3000, 90));
    if (N === 0) out.push(local("ls_growth", 1, 3000, 90));
  } else if (tier === 2) {
    const local = (method: string, seed: number, evals: number, base: number): Recipe => ({
      method, params: {}, seed, budget: { evals, time_s: seconds(base, P) }, finalPolish: true, start: "none",
    });
    if (N !== 0) out.push(local("morph", 1, 3000, 90));
    out.push(local("mc_compress", 1, 3000, 90));
    out.push(local(N === 0 ? "basin_hopping" : "harden", 2, 10000, 150));
  } else {
    for (const seed of [1, 2]) {
      for (const method of N === 0 ? ["basin_hopping", "ls_growth"] : ["harden", "basin_hopping"]) {
        out.push({ method, params: {}, seed, budget: { evals: 30000, time_s: seconds(240, P) }, finalPolish: true, start: "none" });
      }
    }
  }
  return out;
}

async function work(job: Job): Promise<JobResult> {
  const t0 = performance.now();
  const problem = { N: job.N, M: job.M, P: job.P };
  const attempts: Attempt[] = [];
  let below: { config: PackingConfig; score: number; index: number } | undefined;
  let best: PackingConfig | undefined;
  let bestScore = Infinity;
  for (const recipe of recipes(job)) {
    const start = recipe.start === START_TIER0 ? job.start : undefined;
    let result;
    try {
      result = await run(problem, {
        method: recipe.method,
        params: recipe.params,
        budget: recipe.budget,
        seed: recipe.seed,
        finalPolish: recipe.finalPolish,
        ...(start ? { start } : {}),
      });
    } catch (error) {
      attempts.push({ ...recipe, score: null, valid: false, strict: false, termination: `error: ${(error as Error).message}`, evaluations: 0, wallTime: 0, verdict: "invalid" });
      continue;
    }
    let c: Check = result.best ? check(result.best, job.value, job.display_precision) : { verdict: "invalid", score: null };
    let tightened: number | undefined;
    // a near miss just above the value: recover the contact margin the search left
    if (result.best && result.valid && result.score !== null && c.verdict !== "reached" && c.verdict !== "below" &&
        result.score - job.value <= 1e-6 * Math.max(1, job.value)) {
      const t = tighten(result.best, job.value, job.display_precision);
      if (t && (t.check.verdict === "reached" || t.check.verdict === "below")) {
        c = t.check;
        tightened = t.delta;
      }
    }
    // the logged recipe omits the adjacent record's coordinates: the log names where they came from
    const logged = { ...recipe, params: recipe.params.record ? { ...recipe.params, record: "(adjacent record)" } : recipe.params };
    attempts.push({
      ...logged,
      score: c.score,
      valid: result.valid,
      strict: result.strict,
      termination: result.termination,
      evaluations: result.evaluations,
      wallTime: Math.round(result.wallTime * 1000) / 1000,
      verdict: c.verdict,
      ...(tightened !== undefined ? { tighten: tightened } : {}),
    });
    if (result.best && result.valid && result.score !== null && result.score < bestScore) {
      best = result.best;
      bestScore = result.score;
    }
    if (c.verdict === "reached") {
      return { key: job.key, tier: job.tier, outcome: "reached", attempts, config: c.config, score: c.score!, winner: attempts.length - 1, seconds: (performance.now() - t0) / 1000 };
    }
    if (c.verdict === "below" && (!below || c.score! < below.score)) below = { config: c.config!, score: c.score!, index: attempts.length - 1 };
  }
  const seconds_ = (performance.now() - t0) / 1000;
  if (below) return { key: job.key, tier: job.tier, outcome: "below", attempts, config: below.config, score: below.score, winner: below.index, seconds: seconds_ };
  return { key: job.key, tier: job.tier, outcome: "unsolved", attempts, best, bestScore: best ? bestScore : undefined, seconds: seconds_ };
}

// ---------- output file ----------

/** One stored construction; the format of data/sources/constructed.json (see docs/RECORDS.md). */
export interface Construction {
  N: number;
  M: number;
  P: number;
  /** The published value the packing was checked against, and its precision. */
  published: number;
  display_precision: number;
  /** Score of the stored configuration at the stored container_phi. */
  score: number;
  method: string;
  /** Method parameters; an adjacent record is named in `start`, not repeated. */
  params: Record<string, unknown>;
  seed: number;
  budget: { evals: number; time_s: number };
  finalPolish: boolean;
  start: string;
  termination: string;
  evaluations: number;
  tier: number;
  /** Contraction of all centres towards the container centre by 1 - tighten after the run, if applied. */
  tighten?: number;
  /** The run's best was refined by python/polish_mp.py before the check (the `--mp` pass). */
  mpPolish?: boolean;
  constructed: string;
  pieces: Pose[];
  container_phi: number;
}

interface LogLine {
  key: string;
  tier: number;
  outcome: JobResult["outcome"] | "killed";
  date: string;
  seconds: number;
  attempts: Attempt[];
  score?: number;
  winner?: number;
  config?: PackingConfig;
  bestScore?: number;
  best?: PackingConfig;
}

function readLog(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogLine);
}

function writeConstructions(log: LogLine[], records: Map<string, LiteratureRecord>): number {
  const out: Construction[] = [];
  const seen = new Set<string>();
  for (const line of log) {
    if (line.outcome !== "reached" || seen.has(line.key)) continue;
    const r = records.get(line.key);
    if (!r || !line.config) continue;
    const a = line.attempts[line.winner!];
    seen.add(line.key);
    out.push({
      N: r.N, M: r.M, P: r.P,
      published: r.value,
      display_precision: r.display_precision,
      score: line.score!,
      method: a.method,
      params: a.params,
      seed: a.seed,
      budget: a.budget,
      finalPolish: a.finalPolish,
      start: a.start,
      termination: a.termination,
      evaluations: a.evaluations,
      tier: line.tier,
      ...(a.tighten !== undefined ? { tighten: a.tighten } : {}),
      ...(a.mpPolish ? { mpPolish: true } : {}),
      constructed: line.date,
      pieces: line.config.pieces,
      container_phi: line.config.container_phi,
    });
  }
  out.sort((a, b) => a.N - b.N || a.M - b.M || a.P - b.P);
  writeFileSync(
    OUTPUT,
    JSON.stringify({
      description:
        "Coordinates constructed by PolyPack's solver for published records that have none. Each packing reaches the published value within 10^-display_precision; it is not necessarily the source's arrangement. Produced by scripts/construct-coordinates.ts; see docs/RECORDS.md.",
      constructions: out,
    }) + "\n",
  );
  return out.length;
}

// ---------- the coordinator ----------

async function coordinator(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      "time-min": { type: "string", default: "150" },
      jobs: { type: "string", default: String(MAX_JOBS) },
      log: { type: "string", default: "construct-coordinates.log.jsonl" },
      only: { type: "string" },
      "max-p": { type: "string" },
      "max-tier": { type: "string", default: "3" },
      group: { type: "string", default: "all" },
      report: { type: "boolean", default: false },
      mp: { type: "boolean", default: false },
    },
  });
  const capMs = Number(args["time-min"]) * 60_000;
  const jobs = Math.min(MAX_JOBS, Math.max(1, Number(args.jobs)));
  const maxTier = Number(args["max-tier"]);
  const maxP = args["max-p"] ? Number(args["max-p"]) : Infinity;
  const only = args.only ? new Set(args.only.split(",")) : undefined;

  const { records: all } = JSON.parse(readFileSync(RECORDS, "utf8")) as { records: LiteratureRecord[] };
  const byKey = new Map(all.map((r) => [keyOf(r), r]));
  const log = readLog(args.log!);
  if (args.report) return report(log, byKey);

  // coordinates usable as adjacent records: published ones, then those constructed in this or an earlier run
  const coords = new Map<string, Neighbour["from"]>();
  const configs = new Map<string, PackingConfig>();
  for (const r of all) {
    if (r.pieces) {
      coords.set(keyOf(r), "records.json");
      configs.set(keyOf(r), { N: r.N, M: r.M, P: r.P, pieces: r.pieces, container_phi: r.container_phi ?? 0 });
    }
  }
  const done = new Map<string, number>(); // key -> highest tier finished without a drawing
  const bestOf = new Map<string, PackingConfig>();
  const solved = new Set<string>();
  for (const line of log) {
    if (line.outcome === "reached" && line.config) {
      solved.add(line.key);
      if (!coords.has(line.key)) {
        coords.set(line.key, "constructed");
        configs.set(line.key, line.config);
      }
    } else if (line.outcome !== "killed") {
      done.set(line.key, Math.max(done.get(line.key) ?? -1, line.tier));
      if (line.best) bestOf.set(line.key, line.best);
    } else {
      done.set(line.key, Math.max(done.get(line.key) ?? -1, line.tier));
    }
  }

  if (args.mp) {
    await mpPass(log, byKey, configs, coords, solved, (line) => {
      appendFileSync(args.log!, JSON.stringify(line) + "\n");
      log.push(line);
    }, only);
    writeConstructions(log, byKey);
    return report(log, byKey);
  }

  const targets = all
    .filter((r) => !r.pieces && r.P <= maxP && (!only || only.has(keyOf(r))))
    .filter((r) => args.group === "all" || isProven(r.status));
  // Queue entries are (record, tier). Every tier of the proven records comes first. The
  // best_known records follow by increasing P, in phases: tiers 0 and 1 for P <= 50 (by P, so a
  // record's tier 1 runs before the tier 0 of larger P), then tiers 0 and 1 for P > 50, tier 2,
  // tier 3. (P > 50 are the squares in a square to 307 at 14 decimals and the circles in a square
  // from 101 at 10 decimals, where a float search rarely reaches the printed digits.)
  const phase = (r: LiteratureRecord, tier: number) => {
    if (isProven(r.status)) return tier;
    const small = r.P <= 50;
    return 10 + (tier <= 1 ? (small ? 0 : 2) : tier === 2 ? 3 : 5);
  };
  const queue = targets
    .flatMap((r) => TIERS.filter((t) => t <= maxTier).map((tier) => ({ r, tier })))
    .sort((a, b) => phase(a.r, a.tier) - phase(b.r, b.tier) || a.r.P - b.r.P || a.r.N - b.r.N || a.r.M - b.r.M);

  const started = Date.now();
  const running = new Map<string, number>(); // key -> tier running
  const workers: { child: ChildProcess; busy?: { key: string; tier: number; timer: NodeJS.Timeout } }[] = [];
  let finished = 0;
  let reached = 0;

  const ready = (r: LiteratureRecord, tier: number) => {
    const k = keyOf(r);
    if (solved.has(k) || running.has(k)) return false;
    return (done.get(k) ?? -1) === tier - 1;
  };
  const next = () => {
    if (Date.now() - started > capMs) return undefined;
    const i = queue.findIndex((q) => ready(q.r, q.tier));
    if (i < 0) return undefined;
    return queue.splice(i, 1)[0];
  };

  const record = (line: LogLine) => {
    appendFileSync(args.log!, JSON.stringify(line) + "\n");
    log.push(line);
  };

  await new Promise<void>((resolveAll) => {
    let closed = false;
    const finishIfIdle = () => {
      if (closed || workers.some((w) => w.busy)) return;
      if (Date.now() - started <= capMs && queue.some((q) => ready(q.r, q.tier))) return;
      closed = true;
      for (const w of workers) w.child.kill();
      resolveAll();
    };
    /** Gives work to every idle worker; stops when there is none left. */
    const pump = () => {
      for (let i = 0; i < workers.length; i++) dispatch(i);
      finishIfIdle();
    };
    const spawn = (slot: number) => {
      const child = fork(fileURLToPath(import.meta.url), ["--worker"], { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
      const w: (typeof workers)[number] = { child };
      workers[slot] = w;
      child.on("message", (msg: JobResult) => {
        if (!w.busy) return;
        clearTimeout(w.busy.timer);
        running.delete(msg.key);
        w.busy = undefined;
        finished++;
        const line: LogLine = {
          key: msg.key, tier: msg.tier, outcome: msg.outcome, date: new Date().toISOString().slice(0, 10),
          seconds: Math.round(msg.seconds * 100) / 100, attempts: msg.attempts, score: msg.score, winner: msg.winner,
          config: msg.config, bestScore: msg.bestScore,
          // only the tier-0 best is used later, as a start
          best: msg.tier === 0 ? msg.best : undefined,
        };
        record(line);
        if (msg.outcome === "reached") {
          reached++;
          solved.add(msg.key);
          if (!coords.has(msg.key)) {
            coords.set(msg.key, "constructed");
            configs.set(msg.key, msg.config!);
          }
          writeConstructions(log, byKey);
        } else {
          done.set(msg.key, msg.tier);
          if (msg.best && msg.tier === 0) bestOf.set(msg.key, msg.best);
        }
        const won = msg.outcome === "reached" ? msg.attempts[msg.winner!] : undefined;
        console.log(
          `[${((Date.now() - started) / 60000).toFixed(1)} min] ${msg.key} tier ${msg.tier}: ${msg.outcome}` +
            (msg.score !== undefined ? ` ${msg.score}` : msg.bestScore !== undefined ? ` (best ${msg.bestScore})` : "") +
            (won ? ` by ${won.method} seed ${won.seed}` : "") + ` in ${msg.seconds.toFixed(1)} s; ${reached} reached of ${finished} finished`,
        );
        pump();
      });
      child.on("exit", () => {
        if (w.busy) {
          // killed for running too long, or crashed: log it so a resume moves on to the next tier
          clearTimeout(w.busy.timer);
          const { key, tier } = w.busy;
          running.delete(key);
          w.busy = undefined;
          if (Date.now() - started <= capMs) {
            record({ key, tier, outcome: "killed", date: new Date().toISOString().slice(0, 10), seconds: 0, attempts: [] });
            done.set(key, tier);
            console.log(`${key} tier ${tier}: worker stopped (time limit or crash)`);
          }
        }
        if (!closed && workers[slot] === w && Date.now() - started <= capMs) {
          spawn(slot);
          pump();
        } else finishIfIdle();
      });
    };
    const dispatch = (slot: number) => {
      const w = workers[slot];
      if (!w || w.busy || !w.child.connected || closed) return;
      const q = next();
      if (!q) return;
      const r = q.r;
      const k = keyOf(r);
      const neighbours: Neighbour[] = [];
      for (const P of [r.P - 1, r.P + 1]) {
        const nk = keyOf({ N: r.N, M: r.M, P });
        if (P >= 1 && configs.has(nk)) neighbours.push({ P, from: coords.get(nk)!, config: configs.get(nk)! });
      }
      const job: Job = {
        key: k, N: r.N, M: r.M, P: r.P, value: r.value, display_precision: r.display_precision,
        tier: q.tier, neighbours, start: q.tier === 1 ? bestOf.get(k) : undefined,
      };
      // hard limit: the sum of the runs' time limits, plus slack for start-up and final assessments
      const limit = recipes(job).reduce((s, x) => s + x.budget.time_s, 0) * 1000 * 1.2 + 30_000;
      running.set(k, q.tier);
      w.busy = { key: k, tier: q.tier, timer: setTimeout(() => w.child.kill("SIGKILL"), limit) };
      w.child.send(job);
    };
    for (let i = 0; i < jobs; i++) spawn(i);
    pump();
    // the total cap: stop running jobs, which a resume repeats
    setTimeout(() => {
      for (const w of workers) if (w.busy) w.child.kill("SIGKILL");
    }, capMs + 1000).unref();
  });
  const n = writeConstructions(log, byKey);
  console.log(`${n} constructions in ${OUTPUT}; ${((Date.now() - started) / 60000).toFixed(1)} min`);
  report(log, byKey);
}

/**
 * The `--mp` pass, for records whose best float64 result is within 1e-7 of the published value
 * but not within its tolerance (values printed to 9 to 14 decimals): the run that gave that best
 * is repeated (same recipe, so the same configuration), its contacts are refined at 50 digits by
 * python/polish_mp.py (P <= 100, needs python/.venv, see python/README.md), and the refined
 * configuration goes through the same `check`, with `tighten` when it is just above.
 */
async function mpPass(
  log: LogLine[],
  byKey: Map<string, LiteratureRecord>,
  configs: Map<string, PackingConfig>,
  coords: Map<string, Neighbour["from"]>,
  solved: Set<string>,
  record: (line: LogLine) => void,
  only?: Set<string>,
): Promise<void> {
  const python = "python/.venv/bin/python";
  if (!existsSync(python)) throw new Error(`${python} is missing; see python/README.md`);
  const candidates = new Map<string, { line: LogLine; attempt: Attempt }>();
  for (const line of log) {
    const r = byKey.get(line.key);
    if (!r || solved.has(line.key) || r.P > 100 || (only && !only.has(line.key))) continue;
    if (log.some((l) => l.key === line.key && l.tier === 99)) continue; // done by an earlier --mp pass
    for (const a of line.attempts) {
      if (a.score === null || !a.valid || a.score - r.value > 1e-7 || a.score < r.value - tolerance(r)) continue;
      const prev = candidates.get(line.key);
      if (!prev || a.score < prev.attempt.score!) candidates.set(line.key, { line, attempt: a });
    }
  }
  console.log(`--mp: ${candidates.size} near misses`);
  for (const [key, { line, attempt }] of candidates) {
    const r = byKey.get(key)!;
    const t0 = performance.now();
    // repeat the recipe; an adjacent record or tier-0 start is looked up as the run had it
    let params = attempt.params;
    let start: PackingConfig | undefined;
    if (params.record) {
      const P = params.kind === "record_plus_one" ? r.P - 1 : r.P + 1;
      const nk = keyOf({ N: r.N, M: r.M, P });
      if (!configs.has(nk)) continue;
      params = { ...params, record: configs.get(nk) };
    }
    if (attempt.start === START_TIER0) {
      start = log.find((l) => l.key === key && l.tier === 0)?.best;
      if (!start) continue;
    }
    const result = await run({ N: r.N, M: r.M, P: r.P }, {
      method: attempt.method, params, seed: attempt.seed, budget: attempt.budget, finalPolish: attempt.finalPolish, ...(start ? { start } : {}),
    });
    if (!result.best || !result.container) continue;
    const dir = mkdtempSync(join(tmpdir(), "polypack-mp-"));
    let c: Check = { verdict: "invalid", score: null };
    let tightened: number | undefined;
    try {
      const input = join(dir, "contacts.json");
      const output = join(dir, "refined.json");
      writeFileSync(input, JSON.stringify({ config: result.best, container: result.container, contacts: identifyContacts(result.best, result.container) }));
      execFileSync(python, ["python/polish_mp.py", input, "--out", output], { timeout: 600_000, stdio: ["ignore", "ignore", "inherit"] });
      const refined = JSON.parse(readFileSync(output, "utf8")).config as PackingConfig | null;
      if (refined && refined.pieces?.length === r.P) {
        c = check(refined, r.value, r.display_precision);
        if (c.verdict !== "reached" && c.verdict !== "below" && c.score !== null && c.score - r.value <= 1e-6) {
          const t = tighten(refined, r.value, r.display_precision);
          if (t && (t.check.verdict === "reached" || t.check.verdict === "below")) {
            c = t.check;
            tightened = t.delta;
          }
        }
      }
    } catch (error) {
      console.log(`${key}: polish_mp failed: ${(error as Error).message.split("\n")[0]}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const seconds_ = (performance.now() - t0) / 1000;
    const done: Attempt = {
      ...attempt, score: c.score, verdict: c.verdict, mpPolish: true,
      ...(tightened !== undefined ? { tighten: tightened } : {}),
    };
    delete (done as Partial<Attempt>).tighten;
    if (tightened !== undefined) done.tighten = tightened;
    const outcome = c.verdict === "reached" ? "reached" : c.verdict === "below" ? "below" : "unsolved";
    record({
      key, tier: 99, outcome, date: new Date().toISOString().slice(0, 10), seconds: Math.round(seconds_ * 100) / 100,
      attempts: [done], score: c.score ?? undefined, winner: 0, config: c.config,
    });
    if (outcome === "reached") {
      solved.add(key);
      coords.set(key, "constructed");
      configs.set(key, c.config!);
    }
    console.log(`${key} --mp: ${c.verdict} ${c.score} (float best ${attempt.score}, published ${r.display}) in ${seconds_.toFixed(1)} s`);
  }
}

function report(log: LogLine[], byKey: Map<string, LiteratureRecord>): void {
  const last = new Map<string, LogLine>();
  for (const line of log) {
    const prev = last.get(line.key);
    if (!prev || prev.outcome !== "reached") last.set(line.key, line);
  }
  const reachedLines = [...last.values()].filter((l) => l.outcome === "reached");
  const status = (k: string) => byKey.get(k)?.status ?? "?";
  const tally = (lines: LogLine[], f: (l: LogLine) => string) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(f(l), (m.get(f(l)) ?? 0) + 1);
    return [...m].sort().map(([k, v]) => `${k}: ${v}`).join(", ");
  };
  console.log(`attempted ${last.size} records; reached ${reachedLines.length}`);
  console.log(`reached by status: ${tally(reachedLines, (l) => status(l.key))}`);
  console.log(`attempted by status: ${tally([...last.values()], (l) => status(l.key))}`);
  console.log(`reached by family: ${tally(reachedLines, (l) => l.key.split("/").slice(0, 2).join("/"))}`);
  console.log(`reached by method: ${tally(reachedLines, (l) => `${l.attempts[l.winner!].method}${l.attempts[l.winner!].params.kind ? `:${l.attempts[l.winner!].params.kind}` : ""}`)}`);
  console.log(`reached by tier: ${tally(reachedLines, (l) => String(l.tier))}`);
  const times = new Map<string, number[]>();
  for (const l of reachedLines) {
    const a = l.attempts[l.winner!];
    times.set(a.method, [...(times.get(a.method) ?? []), a.wallTime]);
  }
  for (const [m, t] of times) {
    t.sort((a, b) => a - b);
    console.log(`  ${m}: median run ${t[Math.floor(t.length / 2)]} s, max ${t[t.length - 1]} s`);
  }
  const belowLines = log.filter((l) => l.outcome === "below");
  console.log(`below the published value by more than its tolerance (not stored): ${belowLines.length}`);
  for (const l of belowLines) console.log(`  ${l.key} published ${byKey.get(l.key)?.display} found ${l.score}`);
  const unsolved = [...last.values()].filter((l) => l.outcome !== "reached");
  console.log(`unsolved (last tier tried): ${unsolved.length}`);
  for (const l of unsolved.filter((l) => isProven(status(l.key) as LiteratureRecord["status"]))) {
    const best = log.filter((x) => x.key === l.key).map((x) => x.bestScore).filter((x): x is number => x !== undefined);
    console.log(`  ${l.key} ${status(l.key)} published ${byKey.get(l.key)?.display} best found ${best.length ? Math.min(...best) : "none"} (tier ${l.tier}, ${l.outcome})`);
  }
}

// ---------- entry ----------

if (process.argv.includes("--worker")) {
  // a worker ends with its coordinator
  process.on("disconnect", () => process.exit(0));
  process.on("message", async (job: Job) => {
    const result = await work(job);
    process.send!(result);
  });
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await coordinator();
}
