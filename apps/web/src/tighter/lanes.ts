import type { Container, PackingConfig } from "@polypack/geometry";
import type { Result } from "@polypack/solver";
import type { SolveRequest, SolveResponse } from "../solve-protocol";

/**
 * One lane: one solver worker (the Board page's solve-worker.ts), running one run() at a time.
 * Every run is exactly what the Solve panel sends: a method, its parameters, a seed, an
 * evaluations-only budget and the current board as start. Controls are the worker's own: pause,
 * resume and stop. A stop the worker does not answer within STOP_GRACE_MS ends with the worker
 * terminated and replaced, keeping the last strict preview it sent, as the Solve panel does.
 */
export const STOP_GRACE_MS = 1500;

export interface LaneRequest {
  problem: { N: number; M: number; P: number };
  method: string;
  params: Record<string, unknown>;
  budget: { evals: number };
  seed: number;
  start: PackingConfig;
}

export interface LaneProgress {
  evaluations: number;
  elapsed: number;
  /** The best strict configuration so far, and its auto-oriented container. */
  preview?: PackingConfig;
  previewContainer?: Container;
}

export type LaneEnd =
  | { kind: "result"; result: Result }
  /** Stopped by force: only the last strict preview is left. */
  | { kind: "stopped"; preview?: PackingConfig; container?: Container; evaluations: number; elapsed: number }
  | { kind: "error"; message: string };

export class Lane {
  private worker: Worker | null = null;
  private nextId = 0;
  private active: {
    id: number;
    resolve: (end: LaneEnd) => void;
    onProgress: (p: LaneProgress) => void;
    last: LaneProgress;
    stopTimer: number;
  } | null = null;
  paused = false;

  constructor(readonly index: number) {}

  get busy(): boolean {
    return this.active !== null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("../solve-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<SolveResponse>) => {
      if (worker === this.worker) this.receive(e.data);
    };
    const failed = (message: string) => {
      if (worker !== this.worker) return;
      worker.terminate();
      this.worker = null;
      this.finish({ kind: "error", message });
    };
    worker.onerror = (e) => {
      e.preventDefault();
      failed(e.message || "the solver worker failed");
    };
    worker.onmessageerror = () => failed("a message from the solver could not be read");
    this.worker = worker;
    return worker;
  }

  /** Starts a run; resolves when it ends. One run at a time. */
  run(request: LaneRequest, onProgress: (p: LaneProgress) => void): Promise<LaneEnd> {
    if (this.active) return Promise.resolve({ kind: "error", message: "this lane is busy" });
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.resolve({ kind: "error", message: `the solver could not start: ${String(error)}` });
    }
    const id = ++this.nextId;
    return new Promise<LaneEnd>((resolve) => {
      this.active = { id, resolve, onProgress, last: { evaluations: 0, elapsed: 0 }, stopTimer: 0 };
      const message: SolveRequest = { type: "run", id, ...request };
      // a fresh worker queues this until its script has loaded
      worker.postMessage(message);
      if (this.paused) worker.postMessage({ type: "pause", id } satisfies SolveRequest);
    });
  }

  private receive(m: SolveResponse): void {
    const a = this.active;
    if (m.type === "ready" || !a || m.id !== a.id) return;
    if (m.type === "progress") {
      a.last = {
        evaluations: m.frame.evaluations,
        elapsed: m.frame.elapsed,
        preview: m.preview ?? a.last.preview,
        previewContainer: m.previewContainer ?? a.last.previewContainer,
      };
      try {
        a.onProgress(a.last);
      } catch {
        // a failing observer must not stop the run
      }
    } else if (m.type === "result") this.finish({ kind: "result", result: m.result });
    else if (m.type === "error") this.finish({ kind: "error", message: m.message });
  }

  private finish(end: LaneEnd): void {
    const a = this.active;
    if (!a) return;
    clearTimeout(a.stopTimer);
    this.active = null;
    a.resolve(end);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (this.active && this.worker)
      this.worker.postMessage({ type: paused ? "pause" : "resume", id: this.active.id } satisfies SolveRequest);
  }

  /** Stops the current run; it ends with its best result so far. */
  stop(): void {
    const a = this.active;
    if (!a || !this.worker || a.stopTimer) return;
    this.worker.postMessage({ type: "stop", id: a.id } satisfies SolveRequest);
    a.stopTimer = window.setTimeout(() => {
      if (this.active !== a) return;
      this.worker?.terminate();
      this.worker = null;
      this.finish({
        kind: "stopped",
        preview: a.last.preview,
        container: a.last.previewContainer,
        evaluations: a.last.evaluations,
        elapsed: a.last.elapsed,
      });
    }, STOP_GRACE_MS);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.finish({ kind: "error", message: "the lane was closed" });
  }
}
