/**
 * The worker pool: one search thread per lane, one job per thread, and a queue for the jobs the
 * engine asks for while every lane is busy. Its runJob is the engine's RunJob.
 *
 *  - Pausing (the battery) holds the queue and pauses the running jobs inside their threads; a
 *    job whose own control says paused is treated alike.
 *  - A job whose control is aborted is told so in its thread, which returns its best so far; a
 *    queued one resolves at once as aborted.
 *  - A watchdog replaces a thread that has not answered within time_s * 3 + 60 s of active time
 *    (pauses excluded), or within 10 s of being aborted, and the job resolves as "crashed". So
 *    does a job whose thread dies.
 *
 * Control flags are plain objects shared with the engine, so a 100 ms tick forwards their changes
 * to the threads.
 */
import { Worker } from "node:worker_threads";
import { workerScript } from "./bundle";
import type { Control, Job, JobResult, RunJob } from "./types";
import { type FromWorker, type ToWorker, WORKER_ROLE, type WorkerData } from "./worker";

export interface PoolOptions {
  /** Number of threads (lanes). */
  size: number;
  priority: "low" | "normal";
  /** Active seconds a job may run without answering; default time_s * 3 + 60. */
  watchdogSeconds?: (job: Job) => number;
  /** Milliseconds an aborted job may take to answer; default 10 s. */
  abortGraceMs?: number;
  tickMs?: number;
  /** Makes a thread; tests use it to stand in a thread that never answers. */
  spawn?: (data: WorkerData) => Worker;
  log?: (message: string) => void;
}

export const defaultWatchdogSeconds = (job: Job) => job.budget.time_s * 3 + 60;

/** A result for a job that produced nothing. */
export function emptyResult(job: Job, termination: string, reason: string): JobResult {
  return {
    job,
    score: null,
    valid: false,
    strict: false,
    evaluations: 0,
    wallTime: 0,
    termination,
    reasons: [reason],
  };
}

interface Queued {
  id: number;
  job: Job;
  control: Control;
  resolve: (r: JobResult) => void;
}

interface Running extends Queued {
  /** Whether the thread was last told to pause. */
  sentPaused: boolean;
  /** performance.now() when the thread was told to abort, or null. */
  abortSentAt: number | null;
  activeMs: number;
  limitMs: number;
}

interface Lane {
  worker: Worker;
  running: Running | null;
}

export interface PoolStats {
  lanes: number;
  /** Lanes running a job that is not paused. */
  busy: number;
  /** Lanes holding a paused job. */
  paused: number;
  idle: number;
  queued: number;
}

export class WorkerPool {
  private readonly lanes: Lane[] = [];
  private queue: Queued[] = [];
  private paused = false;
  private stopping = false;
  private closed = false;
  private nextId = 1;
  private lastTick = performance.now();
  private readonly timer: NodeJS.Timeout;
  private readonly watchdogSeconds: (job: Job) => number;
  private readonly abortGraceMs: number;
  private readonly log: (message: string) => void;

  private constructor(
    private readonly script: URL | null,
    private readonly options: PoolOptions,
  ) {
    this.watchdogSeconds = options.watchdogSeconds ?? defaultWatchdogSeconds;
    this.abortGraceMs = options.abortGraceMs ?? 10_000;
    this.log = options.log ?? (() => {});
    for (let i = 0; i < Math.max(1, options.size); i++) {
      const lane: Lane = { worker: undefined as unknown as Worker, running: null };
      this.lanes.push(lane);
      this.spawn(lane);
    }
    this.timer = setInterval(() => this.tick(), options.tickMs ?? 100);
  }

  static async create(options: PoolOptions): Promise<WorkerPool> {
    return new WorkerPool(options.spawn ? null : await workerScript(), options);
  }

  get size(): number {
    return this.lanes.length;
  }

  /** The engine's RunJob. Never rejects. */
  readonly runJob: RunJob = (job, control) =>
    new Promise<JobResult>((resolve) => {
      if (this.closed || this.stopping || control.aborted) {
        resolve(emptyResult(job, "aborted", "aborted before it started"));
        return;
      }
      this.queue.push({ id: this.nextId++, job, control, resolve });
      this.dispatch();
    });

  /** Holds the queue and pauses the running jobs, or lets them go on. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    for (const lane of this.lanes) this.sync(lane);
    if (!paused) this.dispatch();
  }

  /** Aborts every running and queued job, and every later one: the client is stopping. */
  stop(): void {
    this.stopping = true;
    for (const lane of this.lanes) this.sync(lane);
    this.dispatch();
  }

  stats(): PoolStats {
    let busy = 0;
    let paused = 0;
    for (const lane of this.lanes) {
      if (!lane.running) continue;
      if (this.isPaused(lane.running)) paused++;
      else busy++;
    }
    return {
      lanes: this.lanes.length,
      busy,
      paused,
      idle: this.lanes.length - busy - paused,
      queued: this.queue.length,
    };
  }

  /** Ends the threads; jobs still running or queued resolve as aborted. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const q of this.queue.splice(0)) q.resolve(emptyResult(q.job, "aborted", "the client stopped"));
    for (const lane of this.lanes)
      if (lane.running) this.settle(lane, emptyResult(lane.running.job, "aborted", "the client stopped"));
    await Promise.all(this.lanes.map((lane) => lane.worker.terminate().catch(() => 0)));
  }

  private spawn(lane: Lane): void {
    const data: WorkerData = { role: WORKER_ROLE, priority: this.options.priority };
    // execArgv: [] keeps tsx's loader flags, if any, out of the thread: its code is plain JavaScript
    const worker = this.options.spawn
      ? this.options.spawn(data)
      : new Worker(this.script!, { workerData: data, execArgv: [] });
    lane.worker = worker;
    worker.on("message", (m: FromWorker) => {
      const r = lane.running;
      if (worker !== lane.worker || !r || m?.type !== "result" || m.id !== r.id) return;
      // the engine gets its own Job object back, not the copy that travelled to the thread
      this.settle(lane, { ...m.result, job: r.job });
    });
    worker.on("error", (error) => this.lost(lane, worker, `the search thread crashed: ${error.message}`));
    worker.on("exit", (code) => this.lost(lane, worker, `the search thread exited with code ${code}`));
  }

  /** A thread died: its job resolves as crashed and, unless the pool is closed, a new thread takes its lane. */
  private lost(lane: Lane, worker: Worker, why: string): void {
    if (worker !== lane.worker || this.closed) return;
    // the new thread first: settling dispatches the next job to the lane's thread
    this.spawn(lane);
    if (lane.running) {
      this.log(`${why}; started a new one`);
      this.settle(lane, emptyResult(lane.running.job, "crashed", why));
    } else this.dispatch();
  }

  /** Replaces a stuck thread. */
  private replace(lane: Lane, why: string): void {
    const stuck = lane.worker;
    this.log(`${why}: replacing the search thread`);
    this.spawn(lane);
    void stuck.terminate().catch(() => 0);
    if (lane.running) this.settle(lane, emptyResult(lane.running.job, "crashed", why));
    else this.dispatch();
  }

  private settle(lane: Lane, result: JobResult): void {
    const r = lane.running!;
    lane.running = null;
    r.resolve(result);
    this.dispatch();
  }

  private isPaused(r: Queued): boolean {
    return this.paused || r.control.paused;
  }

  private post(lane: Lane, message: ToWorker): void {
    try {
      lane.worker.postMessage(message);
    } catch {
      // the thread is gone: its exit event settles the job
    }
  }

  /** Forwards the running job's pause and abort flags to its thread. */
  private sync(lane: Lane): void {
    const r = lane.running;
    if (!r) return;
    if ((this.stopping || r.control.aborted) && r.abortSentAt === null) {
      r.abortSentAt = performance.now();
      this.post(lane, { type: "abort", id: r.id });
    }
    const paused = this.isPaused(r);
    if (paused !== r.sentPaused) {
      r.sentPaused = paused;
      this.post(lane, { type: paused ? "pause" : "resume", id: r.id });
    }
  }

  private dispatch(): void {
    if (this.closed) return;
    // jobs aborted while queued end at once
    this.queue = this.queue.filter((q) => {
      if (!this.stopping && !q.control.aborted) return true;
      q.resolve(emptyResult(q.job, "aborted", "aborted before it started"));
      return false;
    });
    for (const lane of this.lanes) {
      if (lane.running) continue;
      const i = this.queue.findIndex((q) => !this.isPaused(q));
      if (i < 0) return;
      const [q] = this.queue.splice(i, 1);
      const limitMs = this.watchdogSeconds(q.job) * 1000;
      lane.running = { ...q, sentPaused: false, abortSentAt: null, activeMs: 0, limitMs };
      try {
        lane.worker.postMessage({ type: "run", id: q.id, job: q.job } satisfies ToWorker);
      } catch (error) {
        // a job that cannot be sent (a value structured clone refuses) is an error, not a crash
        this.settle(lane, emptyResult(q.job, "error", `could not send the job: ${(error as Error).message}`));
      }
    }
  }

  private tick(): void {
    const t = performance.now();
    const dt = t - this.lastTick;
    this.lastTick = t;
    for (const lane of this.lanes) {
      const r = lane.running;
      if (!r) continue;
      this.sync(lane);
      if (!this.isPaused(r) || r.abortSentAt !== null) r.activeMs += dt;
      if (r.activeMs > r.limitMs)
        this.replace(lane, `a ${r.job.method} job gave no answer within ${Math.round(r.limitMs / 1000)} s`);
      else if (r.abortSentAt !== null && t - r.abortSentAt > this.abortGraceMs)
        this.replace(lane, `a ${r.job.method} job did not stop within ${this.abortGraceMs / 1000} s of being aborted`);
    }
    this.dispatch();
  }
}
