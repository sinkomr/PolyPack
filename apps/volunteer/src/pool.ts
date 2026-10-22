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
 *  - A thread that dies is started again after a backoff (0.5 s doubling to 60 s while it keeps
 *    dying). If threads die five times before any job has finished, the pool gives up: something
 *    is wrong with the thread's code or the machine, and starting it again will not help.
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
  /** Milliseconds before a lane's thread is started again after its `failures`-th death in a row. */
  respawnDelayMs?: (failures: number) => number;
  /** Thread deaths before any job finished after which the pool gives up; default 5. */
  maxStartupFailures?: number;
  /** Called once when the pool gives up; every job then resolves as crashed. */
  onFatal?: (message: string) => void;
  /** Makes a thread; tests use it to stand in a thread that never answers. */
  spawn?: (data: WorkerData) => Worker;
  log?: (message: string) => void;
}

export const defaultWatchdogSeconds = (job: Job) => job.budget.time_s * 3 + 60;
export const defaultRespawnDelayMs = (failures: number) => Math.min(60_000, 500 * 2 ** Math.max(0, failures - 1));

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
  /** Null while a dead thread waits to be started again. */
  worker: Worker | null;
  running: Running | null;
  /** Deaths of this lane's thread since it last finished a job. */
  failures: number;
  respawn: NodeJS.Timeout | null;
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
  /** Why the pool gave up, or null. */
  private fatal: string | null = null;
  /** Whether any thread has finished a job; until then deaths count as startup failures. */
  private succeeded = false;
  private startupFailures = 0;
  private nextId = 1;
  private lastTick = performance.now();
  private readonly timer: NodeJS.Timeout;
  private readonly watchdogSeconds: (job: Job) => number;
  private readonly abortGraceMs: number;
  private readonly respawnDelayMs: (failures: number) => number;
  private readonly maxStartupFailures: number;
  private readonly log: (message: string) => void;

  private constructor(
    private readonly script: URL | null,
    private readonly options: PoolOptions,
  ) {
    this.watchdogSeconds = options.watchdogSeconds ?? defaultWatchdogSeconds;
    this.abortGraceMs = options.abortGraceMs ?? 10_000;
    this.respawnDelayMs = options.respawnDelayMs ?? defaultRespawnDelayMs;
    this.maxStartupFailures = options.maxStartupFailures ?? 5;
    this.log = options.log ?? (() => {});
    for (let i = 0; i < Math.max(1, options.size); i++) {
      const lane: Lane = { worker: null, running: null, failures: 0, respawn: null };
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

  /** Why the pool gave up, or null while it works. */
  get failure(): string | null {
    return this.fatal;
  }

  /** The engine's RunJob. Never rejects. */
  readonly runJob: RunJob = (job, control) =>
    new Promise<JobResult>((resolve) => {
      if (this.fatal) {
        resolve(emptyResult(job, "crashed", this.fatal));
        return;
      }
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
    for (const lane of this.lanes) {
      if (lane.respawn) clearTimeout(lane.respawn);
      if (lane.running) this.settle(lane, emptyResult(lane.running.job, "aborted", "the client stopped"));
    }
    await Promise.all(this.lanes.map((lane) => lane.worker?.terminate().catch(() => 0)));
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
      this.succeeded = true;
      lane.failures = 0;
      // the engine gets its own Job object back, not the copy that travelled to the thread
      this.settle(lane, { ...m.result, job: r.job });
    });
    worker.on("error", (error) => this.lost(lane, worker, `the search thread crashed: ${error.message}`));
    worker.on("exit", (code) => this.lost(lane, worker, `the search thread exited with code ${code}`));
  }

  /**
   * A thread died: its job resolves as crashed, and a new thread takes the lane after a backoff,
   * unless threads keep dying before any job has finished.
   */
  private lost(lane: Lane, worker: Worker, why: string): void {
    if (worker !== lane.worker || this.closed || this.fatal) return;
    lane.worker = null;
    lane.failures++;
    if (!this.succeeded) this.startupFailures++;
    if (lane.running) this.settle(lane, emptyResult(lane.running.job, "crashed", why));
    if (!this.succeeded && this.startupFailures >= this.maxStartupFailures) {
      this.giveUp(`the search threads stopped ${this.startupFailures} times before finishing any job (last: ${why})`);
      return;
    }
    const delay = this.respawnDelayMs(lane.failures);
    this.log(`${why}; starting a new one in ${delay / 1000} s`);
    lane.respawn = setTimeout(() => {
      lane.respawn = null;
      if (this.closed || this.fatal) return;
      this.spawn(lane);
      this.dispatch();
    }, delay);
  }

  /** Every job ends as crashed, now and later. */
  private giveUp(message: string): void {
    this.fatal = message;
    this.log(`Giving up: ${message}`);
    for (const q of this.queue.splice(0)) q.resolve(emptyResult(q.job, "crashed", message));
    for (const lane of this.lanes) {
      if (lane.respawn) clearTimeout(lane.respawn);
      lane.respawn = null;
      if (lane.running) this.settle(lane, emptyResult(lane.running.job, "crashed", message));
    }
    this.options.onFatal?.(message);
  }

  /** Replaces a stuck thread at once: it did start, so there is nothing to back off from. */
  private replace(lane: Lane, why: string): void {
    const stuck = lane.worker;
    this.log(`${why}: replacing the search thread`);
    // the new thread first: settling dispatches the next job to the lane's thread
    this.spawn(lane);
    void stuck?.terminate().catch(() => 0);
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
      lane.worker?.postMessage(message);
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
    if (this.closed || this.fatal) return;
    // jobs aborted while queued end at once
    this.queue = this.queue.filter((q) => {
      if (!this.stopping && !q.control.aborted) return true;
      q.resolve(emptyResult(q.job, "aborted", "aborted before it started"));
      return false;
    });
    for (const lane of this.lanes) {
      if (lane.running || !lane.worker) continue;
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
