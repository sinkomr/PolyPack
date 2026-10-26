/**
 * The volunteer client's engine for one space problem: which jobs to run, with which seeds,
 * budgets and starts, and when the problem is done. Like its polygon engine
 * (apps/volunteer/src/engine), it never touches the network, the file system, threads or the real
 * clock: jobs go through RunSpaceJob and time through input.now, so it is tested with a fake
 * RunSpaceJob and a fake clock. (The board runs its own short rounds instead: apps/web/src/space.)
 *
 * 1. Kinds. "iterate" jobs start from the engine's best, or from input.known (the problem's best
 *    configuration: the research record or the site's leader) before there is one; "fresh" jobs
 *    let the space's engine build its own start. The first job iterates when there is a start;
 *    every later one is fresh with probability 1/4 (always when there is no start), drawn from a
 *    stream seeded by input.seed.
 * 2. Budgets. Each kind has a level, starting at 0; its jobs get T0 2^level active seconds,
 *    T0 = maxSeconds / 20 clipped to [1, 30] s, up to a quarter of maxSeconds, clipped to the
 *    time left. The level rises after a job at that level improves the best, and after every
 *    two that do not (the doubling trick of the polygon engine). Once a kind's jobs have run for
 *    a second, every job also gets an evaluation cap, 0.8 of what its time buys at their
 *    measured rate, so that most jobs end on evaluations and are reproducible from the job.
 * 3. Stopping. No job starts when control.aborted is set ("aborted"), when the best is within
 *    1e-9 of the problem's lower bound or a valid job ended "bound" (its search reached its own
 *    floor, which can lie above the problem's bound: the boundary search's aligned cubes stop at
 *    s = 1) ("bound"), when less than T0 / 2 is left ("time"), or
 *    when the score to beat (the best, or input.known before the best beats it) has not improved
 *    by more than 1e-9 relative for max(maxSeconds / 4, elapsed / 2) seconds ("stagnation").
 *    The search then waits for the jobs in flight. Three failed jobs in a row (an error, or a lost
 *    thread) also end it ("stagnation").
 * Job seeds are mixed from input.seed and the job's index, so the same input, the same job
 * answers and the same clock give the same jobs.
 */
import type { SpaceConfig, SpaceName } from "../types";
import { methodOf } from "./model";
import type { SpaceJob, SpaceJobResult } from "./run";
import { mixSeed, seededStream, toUint32 } from "./seed";

/**
 * Stop and pause flags shared by the host and the running jobs (the volunteer client's Control):
 * `paused` holds the jobs without ending them, `aborted` ends them with their best so far.
 */
export interface Control {
  aborted: boolean;
  paused: boolean;
}

export type RunSpaceJob = (job: SpaceJob, control: Control) => Promise<SpaceJobResult>;

/** A configuration the engine found, with the job that produced it. */
export interface SpaceCandidate {
  config: SpaceConfig;
  score: number;
  job: SpaceJob;
}

export interface SpaceSearchInput {
  space: SpaceName;
  id: string;
  /** The problem's best configuration, to start from. */
  known?: { config: SpaceConfig; score: number; source: "certified" | "site" };
  /** The problem's lower bound, or null. */
  bound: number | null;
  /** The research record's certified size, or null: results are checked by the server's whole rule. */
  certified?: number | null;
  /** True when the problem has no research record yet (results then need the strict check too). */
  noRecord?: boolean;
  /** Most active seconds (see `now`) this problem may take. */
  maxSeconds: number;
  /** Most jobs at once. */
  lanes: number;
  seed: number;
  /** Active seconds, monotonic. */
  now: () => number;
  onResult?: (result: SpaceJobResult, best: SpaceCandidate | null) => void;
}

export interface SpaceSearchOutcome {
  best: SpaceCandidate | null;
  jobs: number;
  stopped: "time" | "stagnation" | "aborted" | "bound";
}

export const SPACE_POLICY = {
  freshShare: 0.25,
  baseShare: 1 / 20,
  baseMinSeconds: 1,
  baseMaxSeconds: 30,
  capShare: 1 / 4,
  missesPerLevel: 2,
  evaluationFill: 0.8,
  minEvaluations: 16,
  minImprovement: 1e-9,
  stagnationShare: 0.25,
};

type Kind = "iterate" | "fresh";

interface KindState {
  level: number;
  misses: number;
  evaluations: number;
  seconds: number;
}

/** Runs a job and turns a rejection into a result. */
async function settle(runJob: RunSpaceJob, job: SpaceJob, control: Control): Promise<SpaceJobResult> {
  try {
    const r = await runJob(job, control);
    if (typeof r === "object" && r !== null) return r;
    throw new Error("runJob returned no result");
  } catch (error) {
    return {
      job,
      score: null,
      valid: false,
      evaluations: 0,
      wallTime: 0,
      termination: "error",
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function searchSpaceProblem(
  input: SpaceSearchInput,
  runJob: RunSpaceJob,
  control: Control,
): Promise<SpaceSearchOutcome> {
  const P = SPACE_POLICY;
  const maxSeconds = Number.isFinite(input.maxSeconds) ? Math.max(0, input.maxSeconds) : 0;
  const lanes = Number.isFinite(input.lanes) ? Math.max(1, Math.floor(input.lanes)) : 1;
  const seed = toUint32(input.seed);
  const random = seededStream(mixSeed(seed, 0xfffffffe));
  const t0 = input.now();
  const elapsed = () => input.now() - t0;
  const base = Math.min(P.baseMaxSeconds, Math.max(P.baseMinSeconds, maxSeconds * P.baseShare));
  const cap = Math.max(base, maxSeconds * P.capShare);
  const known = input.known && Number.isFinite(input.known.score) && input.known.score > 0 ? input.known : undefined;
  const kinds: Record<Kind, KindState> = {
    iterate: { level: 0, misses: 0, evaluations: 0, seconds: 0 },
    fresh: { level: 0, misses: 0, evaluations: 0, seconds: 0 },
  };
  let best: SpaceCandidate | null = null;
  /** Set once a valid job ended at its search's own floor: more jobs of that search cannot do better. */
  let atFloor = false;
  let lastProgress = 0;
  let jobs = 0;
  /** Failed jobs in a row: after three the problem is given up. */
  let failures = 0;
  const flights = new Map<
    number,
    {
      job: SpaceJob;
      kind: Kind;
      level: number;
      startedAt: number;
      done: Promise<{ id: number; result: SpaceJobResult }>;
    }
  >();
  const toBeat = () => Math.min(best?.score ?? Infinity, known?.score ?? Infinity);

  const decide = (): { job: SpaceJob; kind: Kind } | SpaceSearchOutcome["stopped"] => {
    if (control.aborted) return "aborted";
    if (failures >= 3) return "stagnation";
    if (atFloor || (best && input.bound !== null && input.bound > 0 && best.score <= input.bound * (1 + P.minImprovement)))
      return "bound";
    const t = elapsed();
    const available = maxSeconds - t;
    if (available < base / 2) return "time";
    if (t - lastProgress >= Math.max(maxSeconds * P.stagnationShare, t / 2)) return "stagnation";
    const start = best?.config ?? known?.config;
    // the first job always tries the start, so that a short search still begins from the problem's best
    const kind: Kind = !start || (jobs > 0 && random() < P.freshShare) ? "fresh" : "iterate";
    const st = kinds[kind];
    const seconds = Math.min(cap, base * 2 ** st.level, available);
    const rate = st.seconds >= 1 ? st.evaluations / st.seconds : null;
    const evals = rate === null ? undefined : Math.max(P.minEvaluations, Math.floor(rate * seconds * P.evaluationFill));
    const job: SpaceJob = {
      space: input.space,
      id: input.id,
      method: methodOf(input.space, input.id),
      seed: mixSeed(seed, jobs),
      budget: evals === undefined ? { time_s: seconds } : { time_s: seconds, evals },
      kind,
      rule: { bound: input.bound, certified: input.certified ?? null, ...(input.noRecord ? { noRecord: true } : {}) },
      ...(kind === "iterate" && start ? { start } : {}),
    };
    return { job, kind };
  };

  let stopped: SpaceSearchOutcome["stopped"] = "time";
  for (;;) {
    while (flights.size < lanes) {
      const next = decide();
      if (typeof next === "string") {
        stopped = next;
        break;
      }
      const id = jobs++;
      const kind = next.kind;
      const flight = {
        job: next.job,
        kind,
        level: kinds[kind].level,
        startedAt: elapsed(),
        done: settle(runJob, next.job, control).then((result) => ({ id, result })),
      };
      flights.set(id, flight);
    }
    if (flights.size === 0) break;
    const { id, result } = await Promise.race(Array.from(flights.values(), (f) => f.done));
    const flight = flights.get(id)!;
    flights.delete(id);
    const t = elapsed();
    const before = toBeat();
    let improved = false;
    if (
      result.valid &&
      result.config &&
      typeof result.score === "number" &&
      Number.isFinite(result.score) &&
      result.score > 0
    ) {
      if (!best || result.score < best.score) best = { config: result.config, score: result.score, job: flight.job };
      if (result.termination === "bound") atFloor = true;
      if (!Number.isFinite(before) || (before - result.score) / before > P.minImprovement) {
        improved = true;
        lastProgress = t;
      }
    }
    const st = kinds[flight.kind];
    const failed = result.termination === "error" || result.termination === "crashed";
    failures = failed ? failures + 1 : 0;
    if (!failed && result.evaluations > 0) {
      st.evaluations += result.evaluations;
      st.seconds += Math.max(0, t - flight.startedAt);
    }
    if (flight.level === st.level && (improved || ++st.misses >= P.missesPerLevel)) {
      if (base * 2 ** st.level < cap) st.level++;
      st.misses = 0;
    }
    try {
      input.onResult?.(result, best);
    } catch {
      // the host's log must not end the search
    }
  }
  return { best, jobs, stopped: control.aborted ? "aborted" : stopped };
}
