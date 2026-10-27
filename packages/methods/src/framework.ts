/**
 * Running a generic method on a kernel: the registry, the budget, the stop, the best result.
 *
 * A method is synchronous code that works on kernel states. It never checks validity itself: it
 * offers states (ctx.offer), and the framework finishes them with the kernel's exact finishing,
 * checks an improvement with the server's rule and keeps the best. So a run's result is always
 * valid, whatever the method does, and never worse than its start (a valid start is the first
 * best, uncharged).
 *
 * Budget. `evals` counts the kernel's energy evaluations: energy() is 1 (gradCost with a gradient), pieceEnergy() and clear()
 * 1/P each (one piece's share of a sweep), finish() the kernel's finishCost and validate() its
 * validateCost (finishCost unless the kernel says otherwise).
 * `time_s` is a ceiling read from `now` (the result then depends on the machine). The kernel the
 * method gets is a counting proxy: once the budget is spent, or `shouldStop` says so, or the best
 * reaches the problem's lower bound, its next call throws Stop, which ends the method; the run
 * returns the best so far. Methods therefore need no budget checks of their own, except in loops
 * that make no kernel calls (ctx.check()).
 *
 * Seeding: the method's random stream is mulberry32(seed); with an evaluation budget only, a run
 * is reproducible from (kernel, method, params, start, seed, evals).
 */
import { type ParameterSchema, checkSchema, clone, fillDefaults, validate } from "@polypack/solver/schema";
import type { Finished, KernelCapability, KernelState, Rng, SpaceKernel } from "./kernel";
import { mulberry32 } from "./random";

export interface SpaceMethodDefinition {
  /** The polygon method it ports ("basin_hopping"); lower case, digits and underscores. */
  name: string;
  /** The board's label ("Basin hopping"). */
  title: string;
  /** One plain sentence for the board and the game. */
  summary: string;
  /** docs/methods/dimensions/<name>.md */
  doc: string;
  /** Kernel capabilities the method needs; it is offered only where the kernel has them all. */
  requires: readonly KernelCapability[];
  schema: ParameterSchema;
  defaults: Record<string, unknown>;
  run(ctx: MethodContext): void;
}

/** Thrown by the counted kernel and ctx.check() when the run must end. */
export class Stop extends Error {
  constructor(readonly reason: "evals" | "time" | "stopped" | "bound") {
    super(`stop: ${reason}`);
  }
}

export interface MethodContext {
  /** The kernel, counted: every call is charged to the budget, and may throw Stop. */
  readonly kernel: SpaceKernel;
  /** The method's parameters, defaults filled in and checked against its schema. */
  readonly params: Record<string, unknown>;
  readonly rng: Rng;
  /** The start the run was given, as a state the method may change, or null. */
  readonly start: KernelState | null;
  /**
   * Finishes s (charged finishCost) and keeps it when it beats the best; the finished score, or
   * null when s does not finish or the server's rule refuses the finished configuration. Once the
   * run has a result, an offer whose finish and check no longer fit the budget ends the run.
   */
  offer(s: KernelState): number | null;
  /** The best so far: its state (a fresh copy at the finished size) and score, or null. */
  best(): { state: KernelState; score: number } | null;
  /** Evaluations used, and left (Infinity without an evaluation budget). */
  used(): number;
  remaining(): number;
  /** Throws Stop when the run must end. */
  check(): void;
}

export interface MethodRunOptions {
  seed: number;
  params?: Record<string, unknown>;
  /** A configuration in the space's format to start from (any size, valid or not). */
  start?: unknown;
  budget: { evals?: number; time_s?: number };
  /**
   * Polled at every kernel call, before the call is charged, with the evaluations charged so far
   * (never decreasing): true ends the run with its best so far. A caller that pauses the run
   * blocks inside it; a pause that ends on `used` reaching a number does not change a seeded run.
   * `finishing` is true when the poll comes from inside a finish, whose result is not kept yet: the
   * caller must not block or report then, only answer whether to stop.
   */
  shouldStop?: (used: number, finishing?: boolean) => boolean;
  /** Called with every improvement of the best. */
  onImprove?: (best: Finished) => void;
  /** Seconds, monotonic; default performance.now() / 1000. */
  now?: () => number;
}

export interface MethodRunResult {
  method: string;
  params: Record<string, unknown>;
  /** The best valid configuration (the start's when nothing beat it), or null. */
  config: unknown | null;
  score: number | null;
  evaluations: number;
  stopped: "evals" | "time" | "stopped" | "bound" | "done" | "error";
  reasons: string[];
}

const registry = new Map<string, SpaceMethodDefinition>();

export function registerMethod(def: SpaceMethodDefinition): void {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name) || registry.has(def.name))
    throw new Error(`invalid or duplicate method ${def.name}`);
  if (def.name === "auto") throw new Error('"auto" is the space\'s own search, not a generic method');
  if (def.doc !== `docs/methods/dimensions/${def.name}.md`) throw new Error("method doc must match name");
  if (def.schema.type !== "object") throw new Error("parameter schema must be an object");
  checkSchema(def.schema);
  validate(def.schema, def.defaults);
  registry.set(def.name, def);
}

/** Every registered method, in registration order. */
export function listMethods(): readonly SpaceMethodDefinition[] {
  return [...registry.values()];
}

/** The methods a kernel can run: those whose required capabilities it has. */
export function methodsFor(kernel: Pick<SpaceKernel, "capabilities">): readonly SpaceMethodDefinition[] {
  return listMethods().filter((m) => m.requires.every((c) => kernel.capabilities.includes(c)));
}

export function getMethod(name: string): SpaceMethodDefinition | undefined {
  return registry.get(name);
}

/** The method's parameters: its defaults with `params` over them, checked against its schema (throws when they fail). */
export function methodParams(
  def: SpaceMethodDefinition,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object");
  const filled = fillDefaults(clone(def.defaults), params);
  validate(def.schema, filled);
  return filled;
}

export function runMethod(kernel: SpaceKernel, name: string, o: MethodRunOptions): MethodRunResult {
  const def = registry.get(name);
  if (!def) throw new Error(`unknown method: ${name}`);
  const missing = def.requires.filter((c) => !kernel.capabilities.includes(c));
  if (missing.length)
    throw new Error(`${name} needs the kernel capability ${missing.join(", ")}, which ${kernel.space} lacks`);
  const params = methodParams(def, o.params);
  if (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff)
    throw new Error("seed must be an integer in [0, 2^32 - 1]");
  const evalLimit = o.budget.evals ?? Infinity;
  const timeLimit = o.budget.time_s ?? Infinity;
  if (!(evalLimit > 0) || !(timeLimit >= 0)) throw new Error("the budget must be positive");
  if (evalLimit === Infinity && timeLimit === Infinity && !o.shouldStop)
    throw new Error("a budget or a stop is required");
  const now = o.now ?? (() => performance.now() / 1000);
  const t0 = now();
  const P = kernel.P;
  let used = 0;
  let best: { config: unknown; score: number } | null = null;
  const atBound = () =>
    best !== null && kernel.bound !== null && kernel.bound > 0 && best.score <= kernel.bound * (1 + 1e-9);

  const check = () => {
    if (o.shouldStop?.(used)) throw new Stop("stopped");
    if (used >= evalLimit) throw new Stop("evals");
    if (timeLimit < Infinity && now() - t0 >= timeLimit) throw new Stop("time");
    if (atBound()) throw new Stop("bound");
  };
  /** For a finish under way: true once the external stop or the clock says so (the budget was charged before it began). */
  const polled = () => !!o.shouldStop?.(used, true) || (timeLimit < Infinity && now() - t0 >= timeLimit);
  const charge = (cost: number) => {
    check();
    used += cost;
  };

  const counted: SpaceKernel = {
    space: kernel.space,
    id: kernel.id,
    P: kernel.P,
    dim: kernel.dim,
    steps: kernel.steps,
    globals: kernel.globals,
    globalSteps: kernel.globalSteps,
    inradius: kernel.inradius,
    bound: kernel.bound,
    finishCost: kernel.finishCost,
    validateCost: kernel.validateCost,
    gradCost: kernel.gradCost,
    capabilities: kernel.capabilities,
    growthMayOverlap: kernel.growthMayOverlap,
    fromConfig: (c) => kernel.fromConfig(c),
    toConfig: (s) => kernel.toConfig(s),
    clone: (s) => kernel.clone(s),
    rebase: (s) => kernel.rebase(s),
    randomStart: (rng) => (charge(1), kernel.randomStart(rng)),
    randomPose: (s, i, rng) => kernel.randomPose(s, i, rng),
    jiggle: (s, i, a, rng) => kernel.jiggle(s, i, a, rng),
    setSize: (s, size) => kernel.setSize(s, size),
    energy: (s, g, w) => (charge(g ? (kernel.gradCost ?? 1) : 1), kernel.energy(s, g, w)),
    pieceEnergy: (s, i, w) => (charge(1 / P), kernel.pieceEnergy(s, i, w)),
    clear: (s, i, tol) => (charge(1 / P), kernel.clear(s, i, tol)),
    // a finish that is under way still ends on the external stop or the clock, through its poll
    finish: (s) => (charge(kernel.finishCost), kernel.finish(s, polled)),
    validate: (c) => (charge(kernel.validateCost ?? kernel.finishCost), kernel.validate(c)),
    ...(kernel.setShape ? { setShape: (s: KernelState, t: number) => kernel.setShape!(s, t) } : {}),
    ...(kernel.seeds ? { seeds: (rng: Rng, n: number) => (charge(n), kernel.seeds!(rng, n)) } : {}),
    ...(kernel.swap ? { swap: (s: KernelState, i: number, j: number) => kernel.swap!(s, i, j) } : {}),
  };

  /** Keeps f when it beats the best; "rejected" when the server's rule refuses it (a finish that broke its contract). */
  const keep = (f: Finished): "kept" | "worse" | "rejected" => {
    if (best && !(f.score < best.score)) return "worse";
    // an improvement is checked with the server's rule before it is kept (charged like a finish)
    used += kernel.validateCost ?? kernel.finishCost;
    const v = kernel.validate(f.config);
    if (!v.valid || v.score === null || !(v.score <= f.score * (1 + 1e-12))) return "rejected";
    best = { config: f.config, score: f.score };
    o.onImprove?.(f);
    return "kept";
  };

  // a valid start is the first best, uncharged, so a run never returns worse than it was given
  // (a kernel that throws on a start is treated as refusing it: the run goes on without one)
  let start: KernelState | null = null;
  if (o.start !== undefined) {
    try {
      start = kernel.fromConfig(o.start);
      if (start) {
        const v = kernel.validate(o.start);
        if (v.valid && v.score !== null) best = { config: o.start, score: v.score };
      }
    } catch {
      start = null;
    }
  }

  const ctx: MethodContext = {
    kernel: counted,
    params,
    rng: mulberry32(o.seed),
    start: start ? kernel.clone(start) : null,
    offer(s) {
      // once the run has a result, an offer whose finish no longer fits the budget ends the run
      // rather than overrunning it by a whole finish (the first result is always allowed)
      if (best && evalLimit - used < kernel.finishCost + (kernel.validateCost ?? kernel.finishCost))
        throw new Stop("evals");
      const f = counted.finish(s);
      if (!f) return null;
      return keep(f) === "rejected" ? null : f.score;
    },
    best() {
      if (!best) return null;
      const state = kernel.fromConfig(best.config);
      return state ? { state, score: best.score } : null;
    },
    used: () => used,
    remaining: () => Math.max(0, evalLimit - used),
    check,
  };

  let stopped: MethodRunResult["stopped"] = "done";
  const reasons: string[] = [];
  try {
    check();
    def.run(ctx);
  } catch (e) {
    if (e instanceof Stop) stopped = e.reason;
    else {
      stopped = "error";
      reasons.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (stopped === "done" && atBound()) stopped = "bound";
  const final = best as { config: unknown; score: number } | null;
  return {
    method: name,
    params,
    config: final?.config ?? null,
    score: final?.score ?? null,
    evaluations: used,
    stopped,
    reasons: final ? reasons : [...reasons, "no valid configuration found"],
  };
}
