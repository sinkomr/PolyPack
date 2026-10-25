/**
 * A search on a space problem in the browser, as a sequence of rounds (model.ts roundJob). Each
 * round is one job of the space's search, run synchronously in a Web Worker (worker.ts). The
 * searches cannot read messages while they work, so the page does not ask a round to stop:
 *
 *  - stop ends the worker at once and keeps the best of the rounds that finished;
 *  - pause ends the worker at once too; resume starts a new worker and runs the interrupted round
 *    again from its beginning, with the same job, so a run that ends on its evaluations is the
 *    same with or without pauses;
 *  - the time budget counts the rounds that finished (an interrupted round's time is not counted,
 *    since its work is lost).
 *
 * Every round's result has passed the server's rule in the worker (runSpaceJob checks it); the
 * page checks the best once more before it offers it (mode.ts). The class takes the runner and
 * the clock as arguments, so that it is tested in Node with the real search and a fake clock.
 */
import type { SpaceConfig } from "@polypack/spaces";
import type { SearchProblem, SpaceJob, SpaceJobResult, SpaceRule } from "@polypack/spaces/search";
import { type RunSettings, roundJob } from "./model";

/** Runs one round; cancel() ends the round in flight, whose promise then rejects with CancelledRound. */
export interface RoundRunner {
  run(job: SpaceJob): Promise<SpaceJobResult>;
  cancel(): void;
  dispose(): void;
}

export class CancelledRound extends Error {
  constructor() {
    super("the round was cancelled");
  }
}

/** A configuration a run found, with the round that found it. */
export interface SpaceCandidate {
  config: SpaceConfig;
  score: number;
  round: number;
  /** The round's seed (mixSeed of the run's seed and the round). */
  seed: number;
}

export interface SpaceSearchProgress {
  state: "running" | "paused";
  /** Rounds finished. */
  rounds: number;
  /** Evaluations of the finished rounds, in the search's unit. */
  evaluations: number;
  /** Active seconds of the finished rounds. */
  seconds: number;
  best: SpaceCandidate | null;
  /** True when this round improved the best. */
  improved: boolean;
}

export type SpaceSearchEnd = "evals" | "time" | "bound" | "stopped" | "error";

export interface SpaceSearchResult {
  best: SpaceCandidate | null;
  rounds: number;
  evaluations: number;
  seconds: number;
  ended: SpaceSearchEnd;
  reasons: string[];
  /** Best score after each round that improved it, as [active seconds, score]. */
  trace: [number, number][];
}

export interface SpaceSearchOptions extends RunSettings {
  rule: SpaceRule;
  /** Called after every round and on pause and resume. */
  onProgress?: (p: SpaceSearchProgress) => void;
  /** Polled about every 200 ms and between rounds: true stops the run. */
  shouldStop?: () => boolean;
  /** Seconds; performance.now() / 1000 by default. */
  now?: () => number;
}

/** Rounds that fail one after another before the run gives up. */
const MAX_FAILURES = 3;
/** Relative distance to the lower bound at which a run ends (it cannot get smaller). */
const BOUND_SLACK = 1e-9;

export class SpaceSearch {
  readonly done: Promise<SpaceSearchResult>;
  private paused = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(
    private problem: SearchProblem,
    private start: SpaceConfig | null,
    private options: SpaceSearchOptions,
    private runner: RoundRunner,
  ) {
    if (options.shouldStop)
      this.poll = setInterval(() => {
        if (options.shouldStop?.()) this.stop();
      }, 200);
    this.done = this.loop().finally(() => {
      if (this.poll) clearInterval(this.poll);
      this.runner.dispose();
    });
  }

  get state(): "running" | "paused" | "stopped" {
    return this.stopped ? "stopped" : this.paused ? "paused" : "running";
  }

  /**
   * Holds the run: the round in flight is ended and will run again from its start on resume.
   * pause() and resume() may follow each other in any order, in one tick too.
   */
  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.runner.cancel();
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.wake?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.runner.cancel();
    this.wake?.();
  }

  private async loop(): Promise<SpaceSearchResult> {
    const o = this.options;
    const now = o.now ?? (() => performance.now() / 1000);
    const bound = o.rule.bound ?? null;
    let best: SpaceCandidate | null = null;
    let rounds = 0;
    let evaluations = 0;
    let seconds = 0;
    let failures = 0;
    /** Rounds without a start that found nothing: each doubles the next one (model.ts roundJob). */
    let freshTries = 0;
    let reasons: string[] = [];
    const trace: [number, number][] = [];
    const progress = (improved: boolean) => {
      try {
        o.onProgress?.({ state: this.paused ? "paused" : "running", rounds, evaluations, seconds, best, improved });
      } catch {
        // an observer's error must not end the run
      }
    };
    const end = (ended: SpaceSearchEnd): SpaceSearchResult => ({
      best,
      rounds,
      evaluations,
      seconds,
      ended,
      reasons,
      trace,
    });
    for (;;) {
      if (this.stopped || o.shouldStop?.()) return end("stopped");
      if (this.paused) {
        progress(false);
        // a resume and a pause in one tick leave the run paused: wait again until it is not
        while (this.paused && !this.stopped) {
          await new Promise<void>((resolve) => (this.wake = resolve));
          this.wake = null;
        }
        if (this.stopped) return end("stopped");
        progress(false);
      }
      if (o.budget.time_s !== undefined && seconds >= o.budget.time_s) return end("time");
      if (best && bound !== null && bound > 0 && best.score <= bound * (1 + BOUND_SLACK)) return end("bound");
      const startOf = best?.config ?? (o.fresh ? null : this.start);
      const plan = roundJob(this.problem, o.rule, o, rounds, { evals: evaluations, seconds }, startOf, freshTries);
      if (!plan) return end("evals");
      const job = plan.job;
      const t0 = now();
      let result: SpaceJobResult;
      try {
        result = await this.runner.run(job);
      } catch (error) {
        // a round ended by pause or stop: the loop waits, ends, or runs the same round again
        if (error instanceof CancelledRound) continue;
        result = {
          job,
          score: null,
          valid: false,
          evaluations: 0,
          wallTime: now() - t0,
          termination: "crashed",
          reasons: [error instanceof Error ? error.message : String(error)],
        };
      }
      const failed = result.termination === "error" || result.termination === "crashed";
      seconds += Math.max(0, now() - t0);
      // a failed round did no search; a round that did not count its work counts the round's evaluations
      evaluations += failed ? 0 : result.evaluations > 0 ? result.evaluations : plan.evals;
      rounds++;
      let improved = false;
      const found =
        result.valid &&
        !!result.config &&
        typeof result.score === "number" &&
        Number.isFinite(result.score) &&
        result.score > 0;
      if (found && (!best || result.score! < best.score)) {
        best = { config: result.config!, score: result.score!, round: rounds - 1, seed: job.seed };
        trace.push([seconds, result.score!]);
        improved = true;
      }
      if (!startOf && !found) freshTries++;
      failures = failed ? failures + 1 : 0;
      if (failed) reasons = result.reasons.slice(0, 3);
      progress(improved);
      if (failures >= MAX_FAILURES) return end("error");
    }
  }
}

/** Runs rounds in a module Web Worker (worker.ts), one at a time; cancel ends the worker. */
export class WorkerRoundRunner implements RoundRunner {
  private worker: Worker | null = null;
  private pending: { id: number; resolve: (r: SpaceJobResult) => void; reject: (e: Error) => void } | null = null;
  private nextId = 0;

  run(job: SpaceJob): Promise<SpaceJobResult> {
    if (this.pending) return Promise.reject(new Error("a round is already running"));
    const worker = this.worker ?? this.create();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      worker.postMessage({ id, job });
    });
  }

  private create(): Worker {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result: SpaceJobResult }>) => {
      const p = this.pending;
      if (worker !== this.worker || !p || e.data?.id !== p.id) return;
      this.pending = null;
      p.resolve(e.data.result);
    };
    const fail = (message: string) => {
      if (worker !== this.worker) return;
      worker.terminate();
      this.worker = null;
      const p = this.pending;
      this.pending = null;
      p?.reject(new Error(message));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      fail(`the search thread failed: ${e.message || "worker error"}`);
    };
    worker.onmessageerror = () => fail("a message from the search thread could not be read");
    this.worker = worker;
    return worker;
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    const p = this.pending;
    this.pending = null;
    p?.reject(new CancelledRound());
  }

  dispose(): void {
    this.cancel();
  }
}

/** Starts a search of a problem in a Web Worker, from `start` (or a fresh start with options.fresh). */
export function startSpaceSearch(
  problem: SearchProblem,
  start: SpaceConfig | null,
  options: SpaceSearchOptions,
  runner: RoundRunner = new WorkerRoundRunner(),
): SpaceSearch {
  return new SpaceSearch(problem, start, options, runner);
}
