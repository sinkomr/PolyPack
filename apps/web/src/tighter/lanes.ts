import type { OpenRunRequest, RunState } from "./open-run";
import type { HostReply, HostRequest } from "./run-host";
import { SpaceRunControl } from "./space-control";
import type { SpaceRunRequest, SpaceRunState, SpaceStartAnswer, SpaceStartRequest } from "./space-run-types";

/**
 * One lane: one worker (run-worker.ts) holding at most one open run. The page opens a run on a
 * problem's board, then steps it: each step allows a number of evaluations (a click's, or one of
 * auto-eval's) and answers with the run's state once they are done. Steps of one run are done in
 * the order they were sent.
 *
 * A lane may instead hold a space run (space-run.ts), which blocks its worker while paused: its
 * steps, holds and close go through shared memory (space-control.ts), not messages, and the lane
 * answers each step when the worker reports that the run reached what was allowed. A space run
 * needs a cross-origin isolated page.
 */

export type OpenAnswer =
  { ok: true; params: Record<string, unknown>; state: RunState } | { ok: false; message: string };
export type OpenSpaceAnswer =
  { ok: true; params: Record<string, unknown>; state: SpaceRunState } | { ok: false; message: string };
export type AnyRunState = RunState | SpaceRunState;
export type StepAnswer = { ok: true; state: AnyRunState; ms: number } | { ok: false; message: string };

/** True for a space run's state, false for a polygon run's. */
export const isSpaceRunState = (s: AnyRunState | null | undefined): s is SpaceRunState =>
  !!s && "kind" in s && s.kind === "space";

interface SpaceStepWaiter {
  /** The run it belongs to. */
  id: number;
  /** Game evaluations in all, up to which the step allowed the run. */
  target: number;
  sentAt: number;
  resolve: (a: StepAnswer) => void;
}

export class Lane {
  private worker: Worker | null = null;
  private nextId = 0;
  private nextStep = 0;
  /** The open run's id (0: none). */
  private runId = 0;
  private opening: ((a: OpenAnswer | OpenSpaceAnswer) => void) | null = null;
  private steps = new Map<number, (a: StepAnswer) => void>();
  private closing = new Map<number, (s: AnyRunState | null) => void>();
  /** The open space run's control (null for a polygon run or none) and what it was allowed in all, in game evaluations. */
  private control: SpaceRunControl | null = null;
  private unit = 1;
  private allowedEvals = 0;
  private spaceState: SpaceRunState | null = null;
  private spaceSteps: SpaceStepWaiter[] = [];
  private starts = new Map<number, (a: SpaceStartAnswer) => void>();
  /** Workers that make a start while the lane's own is blocked by a space run. */
  private extra = new Set<Worker>();
  /** The open run's state while a long step goes, at most ten times a second. */
  onProgress: ((s: AnyRunState) => void) | null = null;

  constructor(readonly index: number) {}

  get open(): boolean {
    return this.runId !== 0;
  }

  /** Steps sent and not answered yet. */
  get pending(): number {
    return this.steps.size + this.spaceSteps.length + (this.opening ? 1 : 0);
  }

  private newWorker(): Worker {
    return new Worker(new URL("./run-worker.ts", import.meta.url), { type: "module" });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.newWorker();
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

  /** Ends the open space run, if any, so that its blocked worker can read the next message. */
  private release(): void {
    this.control?.abort();
    this.control = null;
  }

  /** Opens a run (closing the one open). */
  openRun(request: OpenRunRequest): Promise<OpenAnswer> {
    if (this.opening) return Promise.resolve({ ok: false, message: "a run is being opened" });
    const id = ++this.nextId;
    this.release();
    this.runId = id;
    return new Promise<OpenAnswer>((resolve) => {
      this.opening = resolve as (a: OpenAnswer | OpenSpaceAnswer) => void;
      try {
        this.post({ type: "open", id, request });
      } catch (error) {
        this.opening = null;
        this.runId = 0;
        resolve({ ok: false, message: `the solver could not start: ${String(error)}` });
      }
    });
  }

  /** Opens a space run (closing the one open); it needs a cross-origin isolated page. */
  openSpace(request: SpaceRunRequest): Promise<OpenSpaceAnswer> {
    if (this.opening) return Promise.resolve({ ok: false, message: "a run is being opened" });
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
      return Promise.resolve({ ok: false, message: "needs a cross-origin isolated page" });
    const id = ++this.nextId;
    this.release();
    const control = new SpaceRunControl();
    this.runId = id;
    this.control = control;
    this.unit = request.unit;
    this.allowedEvals = 0;
    this.spaceState = null;
    return new Promise<OpenSpaceAnswer>((resolve) => {
      this.opening = resolve as (a: OpenAnswer | OpenSpaceAnswer) => void;
      try {
        this.post({ type: "open-space", id, request, control: control.buffer });
      } catch (error) {
        this.opening = null;
        this.runId = 0;
        this.control = null;
        resolve({ ok: false, message: `the solver could not start: ${String(error)}` });
      }
    });
  }

  /** Allows `evals` more evaluations of the open run. */
  step(evals: number): Promise<StepAnswer> {
    if (!this.runId) return Promise.resolve({ ok: false, message: "no open run" });
    if (this.control) {
      const state = this.spaceState;
      if (!(evals >= 1))
        return Promise.resolve(state ? { ok: true, state, ms: 0 } : { ok: false, message: "no open run" });
      this.allowedEvals += Math.floor(evals);
      return new Promise<StepAnswer>((resolve) => {
        this.spaceSteps.push({ id: this.runId, target: this.allowedEvals, sentAt: performance.now(), resolve });
        this.control!.allow(this.allowedEvals * this.unit);
      });
    }
    const step = ++this.nextStep;
    return new Promise<StepAnswer>((resolve) => {
      this.steps.set(step, resolve);
      this.post({ type: "step", id: this.runId, step, evals });
    });
  }

  /** Holds the open run (a hidden tab, battery power) or lets it go on, without changing what it allows. */
  hold(held: boolean): void {
    if (!this.runId) return;
    if (this.control) this.control.hold(held);
    else this.post({ type: "hold", id: this.runId, held });
  }

  /** Closes the open run; resolves with its final state (null without one). */
  close(): Promise<AnyRunState | null> {
    const id = this.runId;
    if (!id || !this.worker) return Promise.resolve(null);
    this.runId = 0;
    this.release();
    return new Promise((resolve) => {
      this.closing.set(id, resolve);
      this.post({ type: "close", id });
    });
  }

  /**
   * A start for a space problem (space-run.ts spaceStart). While a space run blocks the lane's
   * worker it is made by a worker of its own, which ends with the answer.
   */
  spaceStart(r: SpaceStartRequest): Promise<SpaceStartAnswer> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      try {
        if (!this.control) {
          this.starts.set(id, resolve);
          this.post({ type: "space-start", id, request: r });
          return;
        }
        const w = this.newWorker();
        this.extra.add(w);
        const done = (a: SpaceStartAnswer) => {
          if (!this.extra.delete(w)) return;
          w.terminate();
          resolve(a);
        };
        w.onmessage = (e: MessageEvent<HostReply>) => {
          if (e.data.type === "started" && e.data.id === id) done(e.data.answer);
        };
        w.onerror = (e) => {
          e.preventDefault();
          done({ ok: false, message: e.message || "the solver worker failed" });
        };
        w.postMessage({ type: "space-start", id, request: r } satisfies HostRequest);
      } catch (error) {
        this.starts.delete(id);
        resolve({ ok: false, message: `the solver could not start: ${String(error)}` });
      }
    });
  }

  private receive(m: HostReply): void {
    if (m.type === "closed") {
      this.closing.get(m.id)?.(m.state);
      this.closing.delete(m.id);
      return;
    }
    if (m.type === "started") {
      this.starts.get(m.id)?.(m.answer);
      this.starts.delete(m.id);
      return;
    }
    if (m.type === "space-stepped") {
      // a step is answered whatever happened to its run since (an abort answers it as ended)
      const now = performance.now();
      const done = this.spaceSteps.filter((w) => w.id === m.id && w.target <= m.target);
      this.spaceSteps = this.spaceSteps.filter((w) => !done.includes(w));
      if (m.id === this.runId) {
        this.spaceState = m.state;
        if (m.state.ended) {
          this.runId = 0;
          this.control = null;
        }
      }
      for (const w of done) w.resolve({ ok: true, state: m.state, ms: now - w.sentAt });
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
      if (isSpaceRunState(m.state)) this.spaceState = m.state;
      resolve?.({ ok: true, params: m.params, state: m.state } as OpenAnswer | OpenSpaceAnswer);
    } else if (m.type === "progress") {
      try {
        this.onProgress?.(m.state);
      } catch {
        // a failing observer must not stop the run
      }
    } else if (m.type === "error") {
      this.runId = 0;
      this.control = null;
      this.fail(m.message);
    }
  }

  private fail(message: string): void {
    this.runId = 0;
    this.control = null;
    const opening = this.opening;
    this.opening = null;
    opening?.({ ok: false, message });
    for (const resolve of this.steps.values()) resolve({ ok: false, message });
    this.steps.clear();
    for (const w of this.spaceSteps) w.resolve({ ok: false, message });
    this.spaceSteps = [];
    for (const resolve of this.closing.values()) resolve(null);
    this.closing.clear();
    for (const resolve of this.starts.values()) resolve({ ok: false, message });
    this.starts.clear();
  }

  terminate(): void {
    this.control?.abort();
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.extra) w.terminate();
    this.extra.clear();
    this.fail("the lane was closed");
  }
}
