import type { OpenRunRequest, RunState } from "./open-run";
import type { HostReply, HostRequest } from "./run-host";
import { type ChainEvent, type ChainLinkSpan, chainMsBetween, chainStateAt } from "./space-chain-core";
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
 * answers each step when the worker reports that the run reached what was allowed. That needs a
 * cross-origin isolated page. On a page that is not, a space run is a chain of shorter runs
 * (space-chain.ts): the worker streams events, the lane keeps them and answers each step with the
 * state as of what the step allowed, never with a find past it.
 */

export type OpenAnswer =
  { ok: true; params: Record<string, unknown>; state: RunState } | { ok: false; message: string };
export type OpenSpaceAnswer =
  { ok: true; params: Record<string, unknown>; state: SpaceRunState } | { ok: false; message: string };
export type AnyRunState = RunState | SpaceRunState;
/** What openSpace answers on a page that is not cross-origin isolated and has no workers either (a space run needs shared memory or a chain). */
export const NOT_ISOLATED = "needs a cross-origin isolated page";
/** Answers that only mean the lane was busy or closed under the open, not that the problem cannot run: the next job opens again. */
const INTERRUPTED = new Set(["a run is being opened", "closed while opening", "the lane was closed"]);
export const laneInterrupted = (message: string): boolean => INTERRUPTED.has(message);

/** Whether this page can run space problems: they need a SharedArrayBuffer, hence a cross-origin isolated page. */
export const spaceRunsHere = (): boolean =>
  !!globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
/** Whether this page can run space problems as a chain (space-chain.ts): without shared memory, but with workers. */
export const chainedRunsHere = (): boolean => typeof Worker !== "undefined";
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

/** The events of a chained run as the page keeps them, and how far the chain has got. */
interface ChainView {
  /** The state before the events kept (they are folded into it once revealed). */
  initial: SpaceRunState;
  events: ChainEvent[];
  links: ChainLinkSpan[];
  /** Kernel evaluations at the end of the last link (or of the chain). */
  computed: number;
  /** Kernel evaluations of the latest event, a heartbeat included. */
  known: number;
  /** Kernel evaluations whose compute time steps have been paid so far. */
  paid: number;
  ended: boolean;
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
  /** The open chained space run (null for any other). */
  private chain: ChainView | null = null;
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
    this.endChain();
  }

  /** The open chained run's state as of what it was allowed (and no further than it has computed), which is all the page may know of it. */
  private revealed(c: ChainView): SpaceRunState {
    return chainStateAt(c.initial, c.events, this.allowedEvals * this.unit, this.unit, c.known);
  }

  /**
   * Drops the open chained run, if any, and answers its steps as ended at what they were allowed. A
   * worker in the middle of a link cannot read a message for as long as the link takes, so it is
   * terminated (the lane makes a new one when it is next needed); an idle one is told to close.
   */
  private endChain(id = this.runId): SpaceRunState | null {
    const c = this.chain;
    if (!c) return null;
    this.chain = null;
    const state = { ...this.revealed(c), ended: true, closed: true };
    const waiting = this.spaceSteps.filter((w) => w.id === id);
    this.spaceSteps = this.spaceSteps.filter((w) => w.id !== id);
    for (const w of waiting) w.resolve({ ok: true, state, ms: 0 });
    const worker = this.worker;
    if (!worker) return state;
    if (!c.ended && this.allowedEvals * this.unit > c.computed) {
      worker.terminate();
      this.worker = null;
    } else worker.postMessage({ type: "close", id } satisfies HostRequest);
    return state;
  }

  /** Answers the steps the chain has computed far enough for, each with the state as of its allowance. */
  private settleChain(): void {
    const c = this.chain;
    if (!c) return;
    const unit = this.unit;
    const ready = this.spaceSteps.filter((w) => w.id === this.runId && (c.ended || c.computed >= w.target * unit));
    if (!ready.length) return;
    this.spaceSteps = this.spaceSteps.filter((w) => !ready.includes(w));
    let state = c.initial;
    for (const w of ready) {
      const allowed = w.target * unit;
      state = chainStateAt(c.initial, c.events, allowed, unit, c.computed);
      const to = Math.min(allowed, c.computed);
      // the compute these evaluations cost, not the wait: the work may have been done ahead
      const ms = chainMsBetween(c.links, c.paid, to);
      c.paid = Math.max(c.paid, to);
      this.spaceState = state;
      w.resolve({ ok: true, state, ms });
    }
    if (state.ended) {
      this.runId = 0;
      this.chain = null;
      return;
    }
    // what is revealed stays so: fold it into the start of the timeline
    const last = ready[ready.length - 1]!.target * unit;
    c.initial = state;
    c.events = c.events.filter((e) => e.at > last);
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
    if (!spaceRunsHere()) return this.openChain(request);
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

  /** Opens a chained space run (closing the one open), for a page that cannot share memory with a worker. */
  private openChain(request: SpaceRunRequest): Promise<OpenSpaceAnswer> {
    if (!chainedRunsHere()) return Promise.resolve({ ok: false, message: NOT_ISOLATED });
    const id = ++this.nextId;
    this.release();
    this.runId = id;
    this.unit = request.unit;
    this.allowedEvals = 0;
    this.spaceState = null;
    const none: SpaceRunState = {
      kind: "space",
      evaluations: 0,
      best: null,
      score: null,
      last: null,
      found: null,
      offers: 0,
      ended: false,
      closed: false,
    };
    this.chain = { initial: none, events: [], links: [], computed: 0, known: 0, paid: 0, ended: false };
    return new Promise<OpenSpaceAnswer>((resolve) => {
      this.opening = resolve as (a: OpenAnswer | OpenSpaceAnswer) => void;
      try {
        this.post({ type: "open-chain", id, request });
      } catch (error) {
        this.opening = null;
        this.runId = 0;
        this.chain = null;
        resolve({ ok: false, message: `the solver could not start: ${String(error)}` });
      }
    });
  }

  /** Allows `evals` more evaluations of the open run. */
  step(evals: number): Promise<StepAnswer> {
    if (!this.runId) return Promise.resolve({ ok: false, message: "no open run" });
    if (this.chain) {
      const c = this.chain;
      if (!(evals >= 1)) return Promise.resolve({ ok: true, state: this.revealed(c), ms: 0 });
      this.allowedEvals += Math.floor(evals);
      return new Promise<StepAnswer>((resolve) => {
        this.spaceSteps.push({ id: this.runId, target: this.allowedEvals, sentAt: performance.now(), resolve });
        this.post({ type: "chain-allow", id: this.runId, total: this.allowedEvals });
        this.settleChain();
      });
    }
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
    if (!this.runId || this.chain) return;
    if (this.control) this.control.hold(held);
    else this.post({ type: "hold", id: this.runId, held });
  }

  /** Closes the open run; resolves with its final state (null without one). */
  close(): Promise<AnyRunState | null> {
    const id = this.runId;
    if (!id || !this.worker) return Promise.resolve(null);
    // a run still opening is dropped: its opening is answered, so that the next open works
    const opening = this.opening;
    this.opening = null;
    opening?.({ ok: false, message: "closed while opening" });
    this.runId = 0;
    // a chained run answers at once with what was revealed
    if (this.chain) return Promise.resolve(this.endChain(id));
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
        if (!this.control && !this.chain) {
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
    if (m.type === "chain-events") {
      this.receiveChain(m);
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
      if (this.chain && isSpaceRunState(m.state)) this.chain.initial = m.state;
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

  /** Keeps a chained run's events and answers the steps they complete. */
  private receiveChain(m: Extract<HostReply, { type: "chain-events" }>): void {
    const c = this.chain;
    if (!c || m.id !== this.runId) return;
    let beat = false;
    for (const e of m.events) {
      c.known = Math.max(c.known, e.at);
      if (e.k === "progress") {
        beat = true;
        continue;
      }
      if (e.k === "link") {
        c.links.push({ from: c.computed, to: e.at, ms: e.ms });
        c.computed = e.at;
      } else if (e.k === "end") {
        c.ended = true;
        c.computed = Math.max(c.computed, e.at);
      }
      c.events.push(e);
    }
    this.settleChain();
    if (beat && this.chain === c && !c.ended) {
      try {
        this.onProgress?.(this.revealed(c));
      } catch {
        // a failing observer must not stop the run
      }
    }
  }

  private fail(message: string): void {
    this.runId = 0;
    this.control = null;
    this.chain = null;
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
