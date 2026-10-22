/**
 * The contract between the two halves of the volunteer client:
 *
 *  - the engine (src/engine/), which decides what to run on one problem: which methods, with
 *    which parameters, seeds, budgets and starting packings, and when the problem is done;
 *  - the host (everything else in src/), which runs those jobs on worker threads, talks to the
 *    server, keeps local state across restarts and holds the machine's limits (cores, priority,
 *    battery).
 *
 * The engine never touches the network, the file system, threads or the real clock: everything
 * reaches it through SearchInput and RunJob, so it is tested with a fake RunJob and a fake clock.
 */
import type { PackingConfig } from "@polypack/geometry";

export interface Problem {
  N: number;
  M: number;
  P: number;
}

/**
 * Stop and pause flags, shared by the host and the running searches. The solver polls them about
 * every 12 ms of its work (its `control` option): `paused` holds a run without ending it, and
 * `aborted` ends it, returning the best found so far.
 */
export interface Control {
  aborted: boolean;
  paused: boolean;
}

/** One solver run that the engine asks the host for. */
export interface Job {
  problem: Problem;
  /** A method registered in @polypack/solver, other than "identity". "polish" needs `start`. */
  method: string;
  /** Method parameters; those left out take the method's defaults. */
  params?: Record<string, unknown>;
  /** Integer from 0 to 2^32 - 1. */
  seed: number;
  /** Seconds of active time (pauses excluded); `evals` may cap the run further. */
  budget: { time_s: number; evals?: number };
  /** Packing to start from; without it the method builds its own. */
  start?: PackingConfig;
  /** Whether the solver appends its automatic final polish; true when left out. */
  finalPolish?: boolean;
  /** Short label for logs and statistics, such as "fresh", "warm" or "polish". */
  kind: string;
}

/** What one job produced, from @polypack/solver's run() result. */
export interface JobResult {
  job: Job;
  /** The server-equivalent score of the best valid packing, or null when there is none. */
  score: number | null;
  valid: boolean;
  /** True when the best packing does not rely on the server's validity tolerance. */
  strict: boolean;
  best?: PackingConfig;
  /** The method's resolved parameters. */
  params?: Record<string, unknown>;
  evaluations: number;
  /** Seconds. */
  wallTime: number;
  /** The solver's termination, or "crashed" when the host lost the worker thread. */
  termination: string;
  reasons: string[];
}

/** Runs one job until it ends or `control.aborted` is set. Never rejects: failures are results. */
export type RunJob = (job: Job, control: Control) => Promise<JobResult>;

/** A packing the engine found, with what produced it. */
export interface Candidate {
  config: PackingConfig;
  score: number;
  strict: boolean;
  /** The job whose result it was, and that job's resolved parameters. */
  job: Job;
  params?: Record<string, unknown>;
}

/**
 * What the engine learned across problems, such as how often each method found a problem's best.
 * The host stores it as JSON between problems and runs and hands it back unchanged; its shape
 * belongs to the engine, which must accept anything (an older version, a corrupted file) and
 * fall back to its defaults.
 */
export type EngineMemory = unknown;

export interface SearchInput {
  problem: Problem;
  /** The best packing known for the problem, to start from: the site leader's or the published one. */
  known?: { config: PackingConfig; score: number; source: "site" | "literature" };
  /** The site leader's score, or null when the problem has no entry. */
  leader: number | null;
  /** The published value, or null. */
  published: number | null;
  /** The area lower bound: no packing is smaller. */
  areaBound: number;
  /** Most active seconds (see `now`) this problem may take. */
  maxSeconds: number;
  /** Most jobs to run at once: the worker threads the host has. */
  lanes: number;
  /** Seed of the engine's own choices. */
  seed: number;
  memory?: EngineMemory;
  /** Active seconds, monotonic: the host stops this clock while the search is paused. */
  now: () => number;
  /** Called after every job, for the host's log and status line. */
  onResult?: (result: JobResult, best: Candidate | null) => void;
}

export interface SearchOutcome {
  /** The best strict packing this search found, if any. It need not beat the leader. */
  best: Candidate | null;
  jobs: number;
  /**
   * "time": maxSeconds ran out; "stagnation": the engine judged further work unlikely to pay;
   * "aborted": control.aborted was set; "bound": the best reached the area bound.
   */
  stopped: "time" | "stagnation" | "aborted" | "bound";
  memory: EngineMemory;
}

/** The engine's entry point, exported as `searchProblem` from src/engine/index.ts. */
export type SearchProblem = (input: SearchInput, runJob: RunJob, control: Control) => Promise<SearchOutcome>;
