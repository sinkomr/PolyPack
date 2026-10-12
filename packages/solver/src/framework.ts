import { Container, Evaluation, PackingConfig, evaluate, findOverlaps, parseConfig } from "@polypack/geometry";
import { now, yieldTask, delay } from "./runtime";
import { ParameterSchema, checkSchema, clone, fillDefaults, validate } from "./schema";
import { polishMethod } from "./methods";

export interface Problem {
  N: number;
  M: number;
  P: number;
}
export interface Budget {
  time_s?: number;
  evals?: number;
}
export interface StopSignal {
  readonly aborted: boolean;
  readonly paused?: boolean;
}
export interface StageIdentity {
  index: number;
  method: string;
}
export interface ProgressFrame {
  config?: PackingConfig;
  score: number | null;
  bestScore: number | null;
  valid: boolean;
  container: Container | null;
  stage: StageIdentity;
  elapsed: number;
  evaluations: number;
  final: boolean;
}
export interface RunOptions {
  method?: string;
  start?: PackingConfig;
  params?: Record<string, unknown>;
  budget: Budget;
  seed: number;
  onProgress?: (frame: ProgressFrame) => void;
  signal?: StopSignal;
  control?: StopSignal;
  finalPolish?: boolean;
}
/**
 * A configuration is strict when no pair of pieces penetrates by more than this. The server
 * accepts penetration up to 1e-9; a search method must reach contact and not use that allowance.
 */
export const STRICT_TOLERANCE = 1e-12;

/**
 * Strict margin for one configuration. Far from the origin a separation cannot be computed more
 * accurately than a few units in the last place of the coordinates (about 1.3e-10 at 6e5), so the
 * margin grows with the largest coordinate; near the origin it is STRICT_TOLERANCE.
 */
export function strictTolerance(config: PackingConfig): number {
  let reach = 0;
  for (const p of config.pieces) reach = Math.max(reach, Math.abs(p.x), Math.abs(p.y));
  return STRICT_TOLERANCE + 4 * Number.EPSILON * reach;
}

export type Termination = "completed" | "time" | "evals" | "aborted" | "error";
export interface StageResult {
  method: string;
  params: Record<string, unknown>;
  evaluations: number;
  wallTime: number;
  termination: Termination;
  bestScore: number | null;
}
export interface Result {
  best?: PackingConfig;
  score: number | null;
  valid: boolean;
  /** False when the best configuration is valid only thanks to the validity tolerance. */
  strict: boolean;
  container: Container | null;
  method: string;
  params: Record<string, unknown>;
  seed: number;
  wallTime: number;
  evaluations: number;
  trace: [number, number][];
  stages: StageResult[];
  termination: Termination;
  reasons: string[];
}
export interface SubRunOptions extends Budget {
  start?: PackingConfig;
}
export interface SubRunResult {
  /** Best valid configuration this sub-run itself evaluated, which may be worse than the run's best. */
  found?: PackingConfig;
  foundScore: number | null;
  /** Best of the whole run so far. */
  best?: PackingConfig;
  score: number | null;
  valid: boolean;
  container: Container | null;
  evaluations: number;
  termination: Termination;
  reasons: string[];
}
export interface MethodContext {
  readonly problem: Problem;
  readonly start?: PackingConfig;
  readonly starts: readonly PackingConfig[];
  readonly initialEvaluation?: Evaluation;
  readonly params: Record<string, unknown>;
  readonly random: () => number;
  shouldStop(): boolean;
  /** Budget still available to this method: evaluations and active seconds (Infinity when unlimited). */
  remaining(): { evals: number; time_s: number };
  checkpoint(): Promise<boolean>;
  evaluate(config: PackingConfig, options?: { autoOrient?: boolean }): Promise<Evaluation | undefined>;
  emit(config: PackingConfig): Promise<Evaluation | undefined>;
  run(method: string, params?: Record<string, unknown>, options?: SubRunOptions): Promise<SubRunResult>;
}
export interface MethodDefinition {
  name: string;
  schema: ParameterSchema;
  defaults: Record<string, unknown>;
  doc: string;
  execute(context: MethodContext): Promise<void>;
}
export interface PipelineStage {
  method: string;
  params?: Record<string, unknown>;
  budget?: Budget;
}
export interface Pipeline {
  stages: PipelineStage[];
}

/** Mulberry32's supported seed domain is explicit, avoiding silent modulo collisions. */
export function seededRandom(seed: number): () => number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("seed must be an integer in [0, 2^32 - 1]");
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkBudget(budget: Budget, required = false): void {
  if (!budget || (required && budget.time_s === undefined && budget.evals === undefined))
    throw new Error("at least one budget is required");
  if (budget.time_s !== undefined && (!Number.isFinite(budget.time_s) || budget.time_s < 0))
    throw new Error("time_s must be finite and nonnegative");
  if (budget.evals !== undefined && (!Number.isSafeInteger(budget.evals) || budget.evals < 1))
    throw new Error("evals must be a positive safe integer");
}

interface Scope {
  active: boolean;
  busy: boolean;
  pending?: Promise<unknown>;
  error?: Error;
  termination: Termination;
  evalLimit: number;
  timeLimit: number;
  parent?: Scope;
  frame: StageIdentity;
  /** Best valid configuration evaluated while this scope was the innermost one. */
  found?: PackingConfig;
  foundScore: number | null;
}

export class MethodRegistry {
  private readonly definitions = new Map<string, MethodDefinition>();
  register(method: MethodDefinition): void {
    if (!/^[a-z][a-z0-9_]*$/.test(method.name) || this.definitions.has(method.name))
      throw new Error("invalid or duplicate method name");
    if (method.doc !== `docs/methods/${method.name}.md`) throw new Error("method doc must match name");
    if (method.schema.type !== "object") throw new Error("parameter schema must be an object");
    checkSchema(method.schema);
    validate(method.schema, method.defaults);
    this.definitions.set(method.name, { ...method, schema: clone(method.schema), defaults: clone(method.defaults) });
  }
  list(): Omit<MethodDefinition, "execute">[] {
    return [...this.definitions.values()].map(({ execute: _, ...metadata }) => clone(metadata));
  }
  private resolve(stage: PipelineStage): MethodDefinition & { params: Record<string, unknown>; budget?: Budget } {
    const method = this.definitions.get(stage.method) ?? (stage.method === "polish" ? polishMethod : undefined);
    if (!method) throw new Error(`unknown method: ${stage.method}`);
    if (
      stage.params !== undefined &&
      (!stage.params || typeof stage.params !== "object" || Array.isArray(stage.params))
    )
      throw new Error("params must be an object");
    const params = fillDefaults(clone(method.defaults), stage.params ?? {});
    if (
      stage.method === "polish" &&
      stage.params?.iterations !== undefined &&
      stage.params.maxIterations === undefined
    ) {
      params.maxIterations = stage.params.iterations;
    }
    validate(method.schema, params);
    if (stage.budget) checkBudget(stage.budget);
    return { ...method, params: clone(params), budget: stage.budget ? { ...stage.budget } : undefined };
  }
  async run(problem: Problem, options: RunOptions): Promise<Result> {
    return this.runStages(problem, [{ method: options.method ?? "identity", params: options.params }], options, false);
  }
  async runPipeline(
    problem: Problem,
    pipeline: Pipeline,
    options: Omit<RunOptions, "method" | "params">,
  ): Promise<Result> {
    if (!pipeline || !Array.isArray(pipeline.stages) || pipeline.stages.length === 0)
      throw new Error("pipeline requires at least one stage");
    return this.runStages(problem, pipeline.stages, options, true);
  }
  private async runStages(
    problem: Problem,
    stages: PipelineStage[],
    options: RunOptions,
    pipeline: boolean,
  ): Promise<Result> {
    const begun = now();
    const parsedProblem = parseConfig({ ...problem, pieces: [], container_phi: 0 });
    if (!parsedProblem.ok) throw new Error(parsedProblem.errors.join("; "));
    const budget = { ...options.budget };
    checkBudget(budget, true);
    const random = seededRandom(options.seed);
    const methods = stages.map((stage) => this.resolve(stage));
    const appendPolish = options.finalPolish !== false && methods.at(-1)!.name !== "polish";
    if (appendPolish) methods.push(this.resolve({ method: "polish" }));
    let start: PackingConfig | undefined;
    if (options.start !== undefined) {
      const parsed = parseConfig(options.start);
      if (!parsed.ok) throw new Error(parsed.errors.join("; "));
      start = parsed.config;
      if (start.N !== problem.N || start.M !== problem.M || start.P !== problem.P)
        throw new Error("start does not match problem");
    }
    let evaluations = 0;
    let best: PackingConfig | undefined;
    let bestEvaluation: Evaluation | undefined;
    let score: number | null = null;
    let bestStrict = false;
    let container: Container | null = null;
    let reasons = ["no valid configuration evaluated"];
    let termination: Termination = "completed";
    let trace: [number, number][] = [];
    const stageResults: StageResult[] = [];
    let lastFrame = -Infinity;
    let lastYield = begun;
    let pausedAt: number | undefined;
    let pausedMilliseconds = 0;
    let closed = false;
    let currentFrame: StageIdentity = { index: 0, method: methods[0].name };
    const aborted = () => options.signal?.aborted || options.control?.aborted;
    const paused = () => options.control?.paused ?? options.signal?.paused ?? false;
    const wallTime = () => (now() - begun) / 1000;
    const activeMilliseconds = () => {
      const time = now();
      if (paused() && pausedAt === undefined) pausedAt = time;
      else if (!paused() && pausedAt !== undefined) {
        pausedMilliseconds += time - pausedAt;
        pausedAt = undefined;
      }
      return time - begun - pausedMilliseconds - (pausedAt === undefined ? 0 : time - pausedAt);
    };
    if (paused()) pausedAt = begun;
    const overallTimeLimit = (budget.time_s ?? Infinity) * 1000;
    const overallEvalLimit = budget.evals ?? Infinity;
    let innermost: Scope | undefined;
    const store = (config: PackingConfig, result: Evaluation) => {
      if (innermost && result.valid && result.score !== null && result.container) {
        if (innermost.foundScore === null || result.score < innermost.foundScore) {
          innermost.found = {
            ...config,
            pieces: config.pieces.map((p) => ({ ...p })),
            container_phi: result.container.phi,
          };
          innermost.foundScore = result.score;
        }
      }
      // A strict configuration always replaces one that leans on the validity tolerance, and is
      // never replaced by one, so a tolerance-band start cannot block an honest result.
      const strict = result.valid && findOverlaps(config.N, config.pieces, strictTolerance(config)).length === 0;
      const better =
        result.valid &&
        result.score !== null &&
        !!result.container &&
        (score === null || (strict && !bestStrict) || (strict === bestStrict && result.score < score));
      if (better && result.score !== null && result.container) {
        bestStrict = strict;
        best = { ...config, pieces: config.pieces.map((p) => ({ ...p })), container_phi: result.container.phi };
        score = result.score;
        container = { ...result.container };
        bestEvaluation = {
          ...result,
          reasons: result.reasons.slice(),
          overlaps: result.overlaps.map((o) => ({ ...o })),
          container: { ...result.container },
        };
        reasons = [];
        trace.push([wallTime(), score]);
        if (trace.length > 2000) trace = [trace[0], ...trace.slice(1, -1).filter((_, i) => i % 2 === 1), trace.at(-1)!];
      } else if (!best) reasons = result.reasons.slice();
    };
    const frame = (config: PackingConfig | undefined, result: Evaluation | undefined, final = false) => {
      if (!options.onProgress) return;
      const time = now();
      if (!final && time - lastFrame < 50) return;
      lastFrame = time;
      try {
        options.onProgress({
          config: config ? clone(config) : undefined,
          score: result?.score ?? null,
          bestScore: score,
          valid: result?.valid ?? false,
          container: result?.container ? { ...result.container } : null,
          stage: { ...currentFrame },
          elapsed: wallTime(),
          evaluations,
          final,
        });
      } catch {
        /* Observers cannot invalidate optimizer state. */
      }
    };
    const assess = (candidate: PackingConfig, autoOrient = true, parsed = parseConfig(candidate)): Evaluation => {
      evaluations++;
      let result: Evaluation;
      let config: PackingConfig | undefined;
      if (!parsed.ok)
        result = { valid: false, reasons: parsed.errors.slice(), overlaps: [], container: null, score: null };
      else if (parsed.config.N !== problem.N || parsed.config.M !== problem.M || parsed.config.P !== problem.P) {
        result = {
          valid: false,
          reasons: ["candidate N, M and P must match problem"],
          overlaps: [],
          container: null,
          score: null,
        };
      } else {
        config = parsed.config;
        result = evaluate(config, { autoOrient });
        store(config, result);
      }
      if (!best && !result.valid) reasons = result.reasons.slice();
      frame(config, result);
      return result;
    };
    // Initial scoring is mandatory even with an already-aborted signal or zero time budget.
    const initialEvaluation = start ? assess(start) : undefined;
    const remainingAfterStart = Math.max(0, overallEvalLimit - evaluations);
    const reserveEvals =
      appendPolish && Number.isFinite(overallEvalLimit)
        ? Math.min(remainingAfterStart, Math.ceil(overallEvalLimit / 10))
        : 0;
    const reserveTime = appendPolish && Number.isFinite(overallTimeLimit) ? overallTimeLimit / 10 : 0;
    const scopeStop = (scope: Scope): boolean => {
      if (!scope.active || closed) return true;
      if (scope.error) {
        scope.termination = "error";
        return true;
      }
      if (aborted()) {
        scope.termination = "aborted";
        return true;
      }
      if (scope.parent && scopeStop(scope.parent)) {
        scope.termination = scope.parent.termination;
        return true;
      }
      if (scope.timeLimit !== Infinity && activeMilliseconds() >= scope.timeLimit) {
        scope.termination = "time";
        return true;
      }
      if (evaluations >= scope.evalLimit) {
        scope.termination = "evals";
        return true;
      }
      return false;
    };
    const waitCheckpoint = async (scope: Scope): Promise<boolean> => {
      activeMilliseconds();
      while (paused() && !aborted() && scope.active && !closed && !scope.error) {
        await delay(12);
        activeMilliseconds();
      }
      if (scopeStop(scope)) return false;
      if (now() - lastYield >= 12) {
        await yieldTask();
        lastYield = now();
      }
      return !scopeStop(scope);
    };
    type Resolved = ReturnType<MethodRegistry["resolve"]>;
    const execute = async (
      method: Resolved,
      stageStart: PackingConfig | undefined,
      incoming: readonly PackingConfig[],
      index: number,
      evalLimit: number,
      timeLimit: number,
      parent?: Scope,
      initial?: Evaluation,
      countStart = evaluations,
      stageBegun = now(),
    ) => {
      const scope: Scope = {
        active: true,
        busy: false,
        termination: "completed",
        evalLimit,
        timeLimit,
        parent,
        frame: { index, method: method.name },
        foundScore: null,
      };
      // the start was scored before this scope existed; it counts as found by it
      if (stageStart && initial?.valid && initial.score !== null && initial.container) {
        scope.found = { ...clone(stageStart), container_phi: initial.container.phi };
        scope.foundScore = initial.score;
      }
      innermost = scope;
      currentFrame = scope.frame;
      const pool: PackingConfig[] = [];
      const guarded = <T>(operation: () => T | Promise<T>): Promise<T> => {
        if (scope.busy) {
          const error = new Error("framework calls must be sequential: await the pending call before making another");
          scope.error = error;
          return Promise.reject(error);
        }
        if (!scope.active || closed) return Promise.reject(new Error("framework context has ended"));
        scope.busy = true;
        let promise: Promise<T>;
        try {
          promise = Promise.resolve(operation());
        } catch (error) {
          promise = Promise.reject(error);
        }
        const request = promise.finally(() => {
          scope.busy = false;
        });
        scope.pending = request;
        request.catch(() => {});
        return request;
      };
      const submit = async (
        candidate: PackingConfig,
        opts: { autoOrient?: boolean } = {},
        parsed = parseConfig(candidate),
      ): Promise<Evaluation | undefined> => {
        if (scopeStop(scope)) return undefined;
        // Usually this path stays synchronous; a macrotask is only due after elapsed work.
        if (paused() || now() - lastYield >= 12) if (!(await waitCheckpoint(scope))) return undefined;
        currentFrame = scope.frame;
        return assess(candidate, opts.autoOrient !== false, parsed);
      };
      const context: MethodContext = {
        problem: { ...problem },
        start: stageStart ? clone(stageStart) : undefined,
        starts: incoming.map((c) => clone(c)),
        initialEvaluation: initial ? clone(initial) : undefined,
        params: clone(method.params),
        random,
        shouldStop: () => scopeStop(scope),
        remaining: () => {
          let evals = Infinity;
          let time = Infinity;
          for (let s: Scope | undefined = scope; s; s = s.parent) {
            evals = Math.min(evals, s.evalLimit - evaluations);
            time = Math.min(time, s.timeLimit - activeMilliseconds());
          }
          return { evals: Math.max(0, evals), time_s: Math.max(0, time) / 1000 };
        },
        checkpoint: () => guarded(() => waitCheckpoint(scope)),
        evaluate: (candidate, opts) => guarded(() => submit(candidate, opts)),
        emit: (candidate) =>
          guarded(async () => {
            const parsed = parseConfig(candidate);
            const result = await submit(candidate, {}, parsed);
            if (result?.valid) {
              if (parsed.ok && pool.length < 64) pool.push({ ...parsed.config, container_phi: result.container!.phi });
            }
            return result;
          }),
        run: (name, params = {}, slice = {}) =>
          guarded(async () => {
            const child = this.resolve({ method: name, params, budget: { evals: slice.evals, time_s: slice.time_s } });
            const childStart = slice.start ?? best ?? stageStart;
            const childCount = evaluations;
            const childTime = activeMilliseconds();
            const childEvalLimit = Math.min(scope.evalLimit, evaluations + (slice.evals ?? Infinity));
            const childTimeLimit = Math.min(scope.timeLimit, childTime + (slice.time_s ?? Infinity) * 1000);
            let childInitial: Evaluation | undefined;
            if (!scopeStop(scope) && childStart) childInitial = assess(childStart);
            const outcome = await execute(
              child,
              childStart,
              [],
              index,
              childEvalLimit,
              childTimeLimit,
              scope,
              childInitial,
              childCount,
            );
            currentFrame = scope.frame;
            innermost = scope;
            const childScope = outcome.scope;
            // what the child found also counts as found by its parent
            if (childScope.found && (scope.foundScore === null || childScope.foundScore! < scope.foundScore)) {
              scope.found = clone(childScope.found);
              scope.foundScore = childScope.foundScore;
            }
            // A failing sub-run is reported to the caller, which decides what to do; it does not end the parent.
            return {
              found: childScope.found ? clone(childScope.found) : undefined,
              foundScore: childScope.foundScore,
              best: best ? clone(best) : undefined,
              score,
              valid: !!best,
              container: container ? { ...container } : null,
              evaluations: evaluations - childCount,
              termination: outcome.record.termination,
              reasons: outcome.error ? [outcome.error.message] : [],
            };
          }),
      };
      try {
        // Methods see a paused context so their first checkpoint can wait without charging time.
        if (!scopeStop(scope)) await method.execute(context);
      } catch (error) {
        scope.error = error instanceof Error ? error : new Error(String(error));
      }
      if (scope.pending) await scope.pending.catch(() => {});
      if (scope.error) {
        scope.termination = "error";
        // only a failure of a stage itself is a reason of the run; a sub-run reports to its caller
        if (!parent)
          reasons = [...reasons.filter((r) => r !== "no valid configuration evaluated"), scope.error.message];
      }
      scope.active = false;
      innermost = parent;
      const record: StageResult = {
        method: method.name,
        params: clone(method.params),
        evaluations: evaluations - countStart,
        wallTime: (now() - stageBegun) / 1000,
        termination: scope.termination,
        bestScore: score,
      };
      return { record, pool, error: scope.error, scope };
    };
    let incoming: PackingConfig[] = [];
    for (let i = 0; i < methods.length; i++) {
      const method = methods[i];
      const beforeFinal = appendPolish && i < methods.length - 1;
      const evalCap = beforeFinal ? overallEvalLimit - reserveEvals : overallEvalLimit;
      const timeCap = beforeFinal ? overallTimeLimit - reserveTime : overallTimeLimit;
      const stageCount = i === 0 ? 0 : evaluations;
      const stageTime = i === 0 ? 0 : activeMilliseconds();
      const stageStart = best ?? start;
      const initial = bestEvaluation ?? (i === 0 ? initialEvaluation : undefined);
      const outcome = await execute(
        method,
        stageStart,
        incoming,
        i,
        Math.min(evalCap, stageCount + (method.budget?.evals ?? Infinity)),
        Math.min(timeCap, stageTime + (method.budget?.time_s ?? Infinity) * 1000),
        undefined,
        initial,
        stageCount,
        i === 0 ? begun : now(),
      );
      stageResults.push(outcome.record);
      if (outcome.pool.length) incoming = outcome.pool;
      start = best ?? stageStart;
      if (outcome.record.termination === "error" || outcome.record.termination === "aborted") {
        termination = outcome.record.termination;
        break;
      }
      if (outcome.record.termination !== "completed") termination = outcome.record.termination;
    }
    closed = true;
    // Final orientation is server-equivalent and intentionally outside the counted search budget.
    if (best) {
      const final = evaluate(best, { autoOrient: true });
      if (final.valid && final.container && final.score !== null) {
        const improved = final.score < score!;
        best = { ...best, container_phi: final.container.phi };
        score = final.score;
        container = { ...final.container };
        bestEvaluation = final;
        if (improved) {
          trace.push([wallTime(), score]);
          if (trace.length > 2000)
            trace = [trace[0], ...trace.slice(1, -1).filter((_, i) => i % 2 === 1), trace.at(-1)!];
        }
      }
    }
    if (stageResults.length) stageResults.at(-1)!.bestScore = score;
    frame(best, bestEvaluation, true);
    // Time metadata cannot reproduce bits, and time budgets depend on machine load and scheduling.
    return {
      best,
      score,
      valid: !!best,
      strict: !!best && bestStrict,
      container,
      method: pipeline ? "pipeline" : methods[0].name,
      params: pipeline
        ? { stages: methods.map((m) => ({ method: m.name, params: clone(m.params) })) }
        : clone(methods[0].params),
      seed: options.seed,
      wallTime: wallTime(),
      evaluations,
      trace: trace.map(([t, s]) => [t, s]),
      stages: stageResults,
      termination,
      reasons:
        best && !bestStrict
          ? [...reasons, `best configuration relies on the validity tolerance (penetration above ${STRICT_TOLERANCE})`]
          : reasons,
    };
  }
}
