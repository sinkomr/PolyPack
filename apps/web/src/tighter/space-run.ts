import { type SpaceKernel, mulberry32, runMethod } from "@polypack/methods";
import type { SpaceConfig } from "@polypack/spaces";
import {
  type SearchProblem,
  checkSpaceConfig,
  checkSpaceMethod,
  isAutoMethod,
  parseSearchProblem,
  readSpaceConfig,
  spaceKernel,
  spaceKernelError,
} from "@polypack/spaces/search";
import type { SpaceRunControl } from "./space-control";
import type { SpaceRunRequest, SpaceRunState, SpaceStartAnswer, SpaceStartRequest } from "./space-run-types";

/**
 * A space run on the lane's worker: one generic method (packages/methods) on the problem's kernel
 * (packages/spaces search/kernels.ts), kept open between clicks like a polygon run (open-run.ts).
 *
 * The method is synchronous code, so the run blocks the worker inside the framework's stop poll
 * whenever it has used what it was allowed, and the page steps, holds and ends it through shared
 * memory (SpaceRunControl) instead of messages. A poll pauses before the next evaluation is charged,
 * so pausing changes nothing in a seeded run with an evaluation budget: it is the run the board
 * would make with the same start, method, seed and budget. A step of `evals` game evaluations
 * allows `evals * unit` kernel evaluations; the run can pass that by the one charge that crosses it.
 *
 * The rule is the server's with `noRecord`, so every best the run keeps is strict. A valid start is
 * the first best, as in the framework.
 */

/** What a run tells its host: a state at most ten times a second, and the pause that answers steps. */
export interface SpaceRunSink {
  progress(state: SpaceRunState): void;
  /** The run reached what it was allowed (`target`: game evaluations in all) or ended (target Infinity). */
  stepped(target: number, state: SpaceRunState): void;
}

function openProblem(family: string, id: string): { p: SearchProblem; kernel: SpaceKernel } {
  const p = parseSearchProblem(id);
  if (!p || p.space !== family) throw new Error(`not a problem of ${family}: ${String(id).slice(0, 80)}`);
  const kernel = spaceKernel(p);
  if (!kernel) throw new Error(spaceKernelError(p) ?? `${id} has no kernel`);
  return { p, kernel };
}

const RULE = { noRecord: true } as const;

export class SpaceRun {
  readonly params: Record<string, unknown>;
  private readonly p: SearchProblem;
  private readonly kernel: SpaceKernel;
  private readonly start: SpaceConfig | null;
  private used = 0;
  private answered = 0;
  private best: SpaceConfig | null = null;
  private score: number | null = null;
  private last: number | null = null;
  private found: number | null = null;
  private ended = false;
  private closedEarly = false;
  private error: string | undefined;
  private offers = 0;
  private blockedMs = 0;
  private lastProgress = 0;

  constructor(
    readonly request: SpaceRunRequest,
    private readonly control: SpaceRunControl,
    private readonly sink: SpaceRunSink,
  ) {
    const { p, kernel } = openProblem(request.family, request.id);
    if (isAutoMethod(p.space, request.method)) throw new Error("a space run needs one of the generic methods");
    const why = checkSpaceMethod(p, request.method, request.params);
    if (why) throw new Error(why);
    if (!Number.isInteger(request.unit) || request.unit < 1) throw new Error("unit must be a positive whole number");
    this.p = p;
    this.params = structuredClone(request.params);
    this.start = request.start === null ? null : readSpaceConfig(p, request.start);
    if (request.start !== null && !this.start) throw new Error("the start is not a configuration of this problem");
    // the kernel under the server's rule, so that every best the framework keeps is strict; the
    // finishing is watched for the run's last and found scores
    this.kernel = {
      ...kernel,
      validate: (config) => checkSpaceConfig(p.space, p.id, config, RULE),
      finish: (s, poll) => {
        const f = kernel.finish(s, poll);
        if (f) this.offered(f.config as SpaceConfig, f.score);
        return f;
      },
    };
    if (this.start) {
      const c = checkSpaceConfig(p.space, p.id, this.start, RULE);
      if (c.valid && c.score !== null) {
        this.best = structuredClone(this.start);
        this.score = c.score;
        this.last = c.score;
      }
    }
  }

  state(): SpaceRunState {
    return {
      kind: "space",
      evaluations: Math.floor(this.used / this.request.unit),
      best: this.best ? structuredClone(this.best) : null,
      score: this.score,
      last: this.last,
      found: this.found,
      offers: this.offers,
      ended: this.ended,
      closed: this.closedEarly,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private offered(config: SpaceConfig, score: number): void {
    this.last = score;
    // the strictness test is the costly part: only for a score that would be the run's best find
    if (this.found === null || score < this.found) {
      const c = checkSpaceConfig(this.p.space, this.p.id, config, RULE);
      if (c.valid && c.score !== null) this.found = score;
    }
    const t = Date.now();
    if (t - this.lastProgress >= 100) {
      this.lastProgress = t;
      this.sink.progress(this.state());
    }
  }

  /**
   * The framework's stop poll: pauses at what is allowed, true only once the run is aborted. A poll
   * from inside a finish never blocks or reports: the finish has been charged but has no result yet,
   * so the step is answered at the next check, after it, with the result in the state.
   */
  private poll = (used: number, finishing?: boolean): boolean => {
    this.used = used;
    const c = this.control;
    if (finishing) return c.aborted;
    // the run's own budget is reached: the framework's evaluation stop ends it, not a pause
    if (used >= this.request.budget.evals * this.request.unit) return c.aborted;
    for (;;) {
      // the epoch first: a change after it makes the wait below return at once
      const epoch = c.epoch();
      if (c.aborted) return true;
      const allowed = c.allowed;
      if (used < allowed) {
        if (!c.held) return false;
      } else if (allowed !== this.answered) {
        this.answered = allowed;
        this.sink.stepped(allowed / this.request.unit, this.state());
      }
      const t = performance.now();
      c.wait(epoch);
      this.blockedMs += performance.now() - t;
    }
  };

  /** Runs to its end (its budget, its kernel's bound, an error or an abort), blocking while paused. */
  run(): SpaceRunState {
    const unit = this.request.unit;
    try {
      const r = runMethod(this.kernel, this.request.method, {
        seed: this.request.seed,
        params: this.request.params,
        ...(this.start ? { start: this.start } : {}),
        // time never ends a run; its clock leaves out the time spent paused
        budget: { evals: this.request.budget.evals * unit, time_s: 3600 },
        shouldStop: this.poll,
        now: () => (performance.now() - this.blockedMs) / 1000,
        onOffer: () => {
          this.offers++;
        },
        onImprove: (f) => {
          this.best = structuredClone(f.config as SpaceConfig);
          this.score = f.score;
        },
      });
      this.used = Math.max(this.used, r.evaluations);
      if (r.stopped === "error") this.error = r.reasons.join("; ") || "the method failed";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.closedEarly = this.control.aborted;
    this.ended = true;
    const s = this.state();
    this.sink.stepped(Infinity, s);
    return s;
  }
}

/** A start for a space problem: the kernel's first seed layout, else a random start, finished and checked strict. */
/**
 * How much more room the loose start has than the smallest size at which every piece is clear: the
 * board is grown by this factor once more, so that Compact has open space to remove.
 */
export const LOOSE_ROOM = 1.3;

/** The most growths by 10 % that make every piece of a start clear. */
const CLEAR_GROWTHS = 80;

/**
 * The start spread out: the same layout with the board grown until no piece touches or overlaps
 * another, and then once more by LOOSE_ROOM. Null when the kernel cannot make a valid board of it
 * (on curved polygons growth can open overlaps), or the result is not valid by the server's rule.
 */
function looseStart(p: SearchProblem, kernel: SpaceKernel, start: ReturnType<SpaceKernel["randomStart"]>) {
  const s = kernel.clone(start);
  const allClear = (t: typeof s) => {
    for (let i = 0; i < kernel.P; i++) if (!kernel.clear(t, i, 0)) return false;
    return true;
  };
  for (let grown = 0; !allClear(s) && grown < CLEAR_GROWTHS; grown++) kernel.setSize(s, s.size * 1.1);
  if (!allClear(s)) return null;
  const wide = kernel.clone(s);
  kernel.setSize(wide, wide.size * LOOSE_ROOM);
  const board = allClear(wide) ? wide : s;
  const config = kernel.toConfig(board) as SpaceConfig;
  const c = checkSpaceConfig(p.space, p.id, config, RULE);
  return c.valid && c.score !== null && c.score > 0 ? { config, score: c.score } : null;
}

/**
 * Load all's start for a space problem: the kernel's first seed layout, else a random start, spread
 * out (looseStart) so that the first Compact has open space to remove. When no try gives a valid
 * loose start it falls back to the finished start, which is jammed already (`loose` false).
 */
export function spaceStart(request: SpaceStartRequest): SpaceStartAnswer {
  try {
    const { p, kernel } = openProblem(request.family, request.id);
    const seed = request.seed;
    const starts = (): (() => ReturnType<SpaceKernel["randomStart"]> | undefined)[] => {
      const rng = mulberry32(seed);
      const tries: (() => ReturnType<SpaceKernel["randomStart"]> | undefined)[] = [];
      if (kernel.seeds) tries.push(() => kernel.seeds!(rng, 5)[0]);
      tries.push(() => kernel.randomStart(rng));
      return tries;
    };
    for (const make of starts()) {
      try {
        const s = make();
        const loose = s ? looseStart(p, kernel, s) : null;
        if (loose) return { ok: true, config: loose.config, score: loose.score, loose: true };
      } catch {
        // a kernel that cannot make this start: the next try
      }
    }
    for (const make of starts()) {
      try {
        const s = make();
        const f = s ? kernel.finish(s) : null;
        if (!f) continue;
        const c = checkSpaceConfig(p.space, p.id, f.config, RULE);
        if (c.valid && c.score !== null) return { ok: true, config: f.config as SpaceConfig, score: c.score, loose: false };
      } catch {
        // a kernel that cannot make this start: the next try
      }
    }
    return { ok: false, message: "no valid start was found" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
