import type { OpenRunRequest, RunState } from "./open-run";
import type { HostReply, HostRequest } from "./run-host";

/**
 * One lane: one worker (run-worker.ts) holding at most one open run. The page opens a run on a
 * problem's board, then steps it: each step allows a number of evaluations (a click's, or one of
 * auto-eval's) and answers with the run's state once they are done. Steps of one run are done in
 * the order they were sent.
 */

export type OpenAnswer =
  { ok: true; params: Record<string, unknown>; state: RunState } | { ok: false; message: string };
export type StepAnswer = { ok: true; state: RunState; ms: number } | { ok: false; message: string };

export class Lane {
  private worker: Worker | null = null;
  private nextId = 0;
  private nextStep = 0;
  /** The open run's id (0: none). */
  private runId = 0;
  private opening: ((a: OpenAnswer) => void) | null = null;
  private steps = new Map<number, (a: StepAnswer) => void>();
  private closing = new Map<number, (s: RunState | null) => void>();
  /** The open run's state while a long step goes, at most ten times a second. */
  onProgress: ((s: RunState) => void) | null = null;

  constructor(readonly index: number) {}

  get open(): boolean {
    return this.runId !== 0;
  }

  /** Steps sent and not answered yet. */
  get pending(): number {
    return this.steps.size + (this.opening ? 1 : 0);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./run-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<HostReply>) => {
      if (worker === this.worker) this.receive(e.data);
    };
    const failed = (message: string) => {
      if (worker !== this.worker) return;
      worker.terminate();
      this.worker = null;
      this.fail(message);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      failed(e.message || "the solver worker failed");
    };
    worker.onmessageerror = () => failed("a message from the solver could not be read");
    this.worker = worker;
    return worker;
  }

  private post(m: HostRequest): void {
    this.ensureWorker().postMessage(m);
  }

  /** Opens a run (closing the one open). */
  openRun(request: OpenRunRequest): Promise<OpenAnswer> {
    if (this.opening) return Promise.resolve({ ok: false, message: "a run is being opened" });
    const id = ++this.nextId;
    this.runId = id;
    return new Promise<OpenAnswer>((resolve) => {
      this.opening = resolve;
      try {
        this.post({ type: "open", id, request });
      } catch (error) {
        this.opening = null;
        this.runId = 0;
        resolve({ ok: false, message: `the solver could not start: ${String(error)}` });
      }
    });
  }

  /** Allows `evals` more evaluations of the open run. */
  step(evals: number): Promise<StepAnswer> {
    if (!this.runId) return Promise.resolve({ ok: false, message: "no open run" });
    const step = ++this.nextStep;
    return new Promise<StepAnswer>((resolve) => {
      this.steps.set(step, resolve);
      this.post({ type: "step", id: this.runId, step, evals });
    });
  }

  /** Closes the open run; resolves with its final state (null without one). */
  close(): Promise<RunState | null> {
    const id = this.runId;
    if (!id || !this.worker) return Promise.resolve(null);
    this.runId = 0;
    return new Promise((resolve) => {
      this.closing.set(id, resolve);
      this.post({ type: "close", id });
    });
  }

  private receive(m: HostReply): void {
    if (m.type === "closed") {
      this.closing.get(m.id)?.(m.state);
      this.closing.delete(m.id);
      return;
    }
    // a step is answered whatever happened to its run since (a close answers it as ended)
    if (m.type === "stepped" || (m.type === "error" && m.step !== undefined)) {
      const resolve = this.steps.get(m.step!);
      this.steps.delete(m.step!);
      if (m.type === "stepped") {
        resolve?.({ ok: true, state: m.state, ms: m.ms });
        if (m.state.ended && m.id === this.runId) this.runId = 0;
      } else resolve?.({ ok: false, message: m.message });
      return;
    }
    if (m.id !== this.runId) return;
    if (m.type === "opened") {
      const resolve = this.opening;
      this.opening = null;
      resolve?.({ ok: true, params: m.params, state: m.state });
    } else if (m.type === "progress") {
      try {
        this.onProgress?.(m.state);
      } catch {
        // a failing observer must not stop the run
      }
    } else if (m.type === "error") {
      this.runId = 0;
      this.fail(m.message);
    }
  }

  private fail(message: string): void {
    this.runId = 0;
    const opening = this.opening;
    this.opening = null;
    opening?.({ ok: false, message });
    for (const resolve of this.steps.values()) resolve({ ok: false, message });
    this.steps.clear();
    for (const resolve of this.closing.values()) resolve(null);
    this.closing.clear();
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.fail("the lane was closed");
  }
}
