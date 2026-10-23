import { findOverlaps } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import { MethodRegistry, strictTolerance } from "@polypack/solver";
import type { MethodContext, MethodDefinition, Problem, Result } from "@polypack/solver";
import type { RunStage } from "./methods/types";
import { METHODS } from "./methods/worker";

/**
 * An open run: one real solver run() that stays open between clicks and does exactly the
 * evaluations it is allowed. A click allows one evaluation (or as many as the player's upgrades
 * give); the run pauses through the framework's own control before the next one. Pausing changes
 * nothing in a seeded, evaluations-only run, so the run is the one the Solve panel would make with
 * the same start, method, seed and budget, and no final polish.
 *
 * One evaluation is the solver's counted unit: one scoring of the whole packing (overlaps and the
 * container fit). The start's scoring is the run's first evaluation and is done when it opens.
 */

/** A method's parameters as the framework resolves them (defaults, then the given values). */
export function resolvedParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const def = METHODS.find((m) => m.name === method);
  if (!def) throw new Error(`unknown method: ${method}`);
  return structuredClone({ ...def.defaults, ...params });
}

export interface OpenRunRequest {
  problem: Problem;
  method: string;
  params: Record<string, unknown>;
  /** Evaluations the run may do in all, the start's scoring included. */
  budget: { evals: number };
  seed: number;
  start: PackingConfig;
}

export interface RunState {
  /** Evaluations done so far, the start's scoring included. */
  evaluations: number;
  /** The best strict packing seen (the start's included) and its score as the solver scored it. */
  best: PackingConfig | null;
  score: number | null;
  /**
   * The score of the latest valid evaluation, the start's included, strict or not: where the run's
   * search is now, which may be well above its best. Null before any valid evaluation.
   */
  last: number | null;
  /**
   * The best score of a strict packing the method evaluated itself, the start's scoring excluded:
   * what the run found, even when it did not beat its start. Null before any.
   */
  found: number | null;
  /** The latest sub-run the run's own method started (none before its first). */
  stage?: RunStage;
  /** The run has finished (its budget, its own stopping rule, a close or an error): no more steps. */
  ended: boolean;
  /** It ended because it was closed, not by itself. */
  closed: boolean;
  error?: string;
}

type Evaluated = Awaited<ReturnType<MethodContext["evaluate"]>>;

export class OpenRun {
  /** The method's resolved parameters, as the run records them. */
  readonly params: Record<string, unknown>;
  private allowed = 1;
  private done = 0;
  private held = false;
  private aborted = false;
  private ended = false;
  /** The run ended because it was closed (not by itself). */
  private closedEarly = false;
  private error: string | undefined;
  private best: PackingConfig | null = null;
  private score: number | null = null;
  private last: number | null = null;
  private found: number | null = null;
  private stage: RunStage | undefined;
  /** Sub-runs the run's own method has started, by method. */
  private stages = new Map<string, number>();
  private top: MethodContext | null = null;
  private waiters: { target: number; resolve: (s: RunState) => void }[] = [];
  private lastProgress = 0;
  /** Settles when the run has ended. */
  readonly finished: Promise<void>;

  constructor(
    readonly request: OpenRunRequest,
    private readonly onProgress?: (s: RunState) => void,
  ) {
    this.params = resolvedParams(request.method, request.params);
    const registry = new MethodRegistry();
    for (const m of METHODS) registry.register(this.counted(m));
    const self = this;
    const control = {
      get aborted() {
        return self.aborted;
      },
      get paused() {
        return self.held || self.done >= self.allowed;
      },
    };
    this.finished = registry
      .run(request.problem, {
        method: request.method,
        params: request.params,
        budget: { evals: request.budget.evals },
        seed: request.seed,
        start: request.start,
        control,
        finalPolish: false,
      })
      .then(
        (r) => this.end(r),
        (e: unknown) => this.end(null, e instanceof Error ? e.message : String(e)),
      );
  }

  /** Allows `evals` more evaluations; resolves once they are done or the run has ended. */
  step(evals: number): Promise<RunState> {
    if (this.ended) return Promise.resolve(this.state());
    this.allowed += Math.max(0, Math.floor(evals));
    const target = this.allowed;
    return new Promise((resolve) => {
      this.waiters.push({ target, resolve });
      this.settle();
    });
  }

  /** Holds the run (a hidden tab, battery power) without changing what it allows. */
  hold(held: boolean): void {
    this.held = held;
  }

  /** Ends the run; resolves with its final state. */
  async close(): Promise<RunState> {
    this.aborted = true;
    await this.finished;
    return this.state();
  }

  state(): RunState {
    return {
      evaluations: this.done,
      best: this.best ? structuredClone(this.best) : null,
      score: this.score,
      last: this.last,
      found: this.found,
      ...(this.stage ? { stage: { ...this.stage } } : {}),
      ended: this.ended,
      closed: this.closedEarly,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  // ---------- inside the run ----------

  /** The method, counting each evaluation and keeping the best strict packing. */
  private counted(def: MethodDefinition): MethodDefinition {
    return {
      ...def,
      execute: (ctx) => {
        if (!this.top) this.enter(ctx);
        return def.execute({
          ...ctx,
          evaluate: async (c, o) => this.seen(c, await ctx.evaluate(c, o)),
          emit: async (c) => this.seen(c, await ctx.emit(c)),
          run: async (...args) => {
            if (ctx === this.top) this.subRun(args[0]);
            const r = await ctx.run(...args);
            this.count();
            return r;
          },
        });
      },
    };
  }

  /** The run's own stage begins: its start has been scored (the first evaluation). */
  private enter(ctx: MethodContext): void {
    this.top = ctx;
    this.count();
    const e = ctx.initialEvaluation;
    if (e?.valid && e.score !== null) this.last = e.score;
    if (ctx.start && e?.valid && e.container && e.score !== null && this.better(e.score) && this.strict(ctx.start))
      this.keep(ctx.start, e.score, e.container.phi);
  }

  /** The run's own method starts a sub-run of `method`, at the evaluations done so far. */
  private subRun(method: string): void {
    const count = (this.stages.get(method) ?? 0) + 1;
    this.stages.set(method, count);
    const at = this.top ? this.request.budget.evals - this.top.remaining().evals : this.done;
    this.stage = { method, count, at };
  }

  /** Evaluations done, from the run's own count (sub-runs' starts included). */
  private count(): void {
    if (this.top) this.done = this.request.budget.evals - this.top.remaining().evals;
    this.settle();
  }

  private seen(candidate: PackingConfig, r: Evaluated): Evaluated {
    if (r?.valid && r.score !== null) {
      this.last = r.score;
      const better = !!r.container && this.better(r.score);
      const finds = this.found === null || r.score < this.found;
      // the strictness test is the costly part: only for a score that would be kept
      if ((better || finds) && this.strict(candidate)) {
        if (finds) this.found = r.score;
        if (better) this.keep(candidate, r.score, r.container!.phi);
      }
    }
    this.count();
    return r;
  }

  /** The score beats the run's best. */
  private better(score: number): boolean {
    return this.score === null || score < this.score;
  }

  /** Only a strict packing (no penetration beyond the strict tolerance) is ever kept or sent. */
  private strict(candidate: PackingConfig): boolean {
    return findOverlaps(candidate.N, candidate.pieces, strictTolerance(candidate)).length === 0;
  }

  private keep(candidate: PackingConfig, score: number, phi: number): void {
    this.best = { ...structuredClone(candidate), container_phi: phi };
    this.score = score;
  }

  private end(r: Result | null, error?: string): void {
    // the final auto-orientation is free and is what the server will score (at the phi sent): it may
    // lower the score
    if (r?.valid && r.strict && r.best && r.score !== null && (this.score === null || r.score < this.score)) {
      this.best = structuredClone(r.best);
      this.score = r.score;
    }
    if (r) this.done = Math.max(this.done, r.evaluations);
    if (error) this.error = error;
    this.closedEarly = this.aborted;
    this.ended = true;
    this.settle();
  }

  private settle(): void {
    const s = this.waiters.length ? this.state() : null;
    this.waiters = this.waiters.filter((w) => {
      if (!this.ended && this.done < w.target) return true;
      w.resolve(s!);
      return false;
    });
    if (this.onProgress && !this.ended) {
      const t = Date.now();
      if (t - this.lastProgress >= 100) {
        this.lastProgress = t;
        this.onProgress(this.state());
      }
    }
  }
}
