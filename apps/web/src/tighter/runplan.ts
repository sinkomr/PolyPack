import { Bandit, Prior, choose, normalizeBandit, observe, posterior } from "./bandit";
import { mulberry32 } from "./dealer";
import type { PolygonKey } from "./frontier";
import type { EvolveMethod } from "./upgrades";

/**
 * How runs are planned (plan §4).
 *
 * - Method match: with "Auto" chosen, the game picks each new run's method (and with Auto-tune its
 *   tuning level) by Thompson sampling over arms (kind of problem × method @ level). An arm's reward
 *   is the RP earned on the problem during one run, per evaluation of that run, observed when the
 *   run ends or is replaced. Runs of every mode are observed, so the bandit has learned something by
 *   the time Method match is bought.
 * - Pipelines: the player orders methods; each new seed on a problem runs the next stage, in a loop.
 *   A stage advances when a run ends by itself (its method stopped improving); a run the game closed
 *   (another problem, a reload) is reopened at the same stage.
 *
 * Every choice passes the cycle rule's test (ruleAllowsMethod), given here as `allowed`.
 */

export interface RunPlanState {
  /** The method is chosen by the game (Method match), not by the select. */
  auto: boolean;
  /** Methods in the order successive seeds run them (Pipelines); empty: the chosen method each time. */
  pipeline: EvolveMethod[];
  /** RP per evaluation by (kind of problem, method and setting). */
  bandit: Bandit;
  /** Draws made from the plan's random sequence (seeded by the dealer's seed). */
  draws: number;
}

export const newRunPlan = (): RunPlanState => ({ auto: false, pipeline: [], bandit: {}, draws: 0 });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Most stages in a pipeline. */
export const MAX_STAGES = 9;

export function normalizeRunPlan(v: unknown, known: readonly string[]): RunPlanState {
  const d = newRunPlan();
  if (!isObj(v)) return d;
  return {
    auto: typeof v.auto === "boolean" ? v.auto : false,
    pipeline: Array.isArray(v.pipeline)
      ? (v.pipeline.filter((m) => typeof m === "string" && known.includes(m)) as EvolveMethod[]).slice(0, MAX_STAGES)
      : [],
    bandit: normalizeBandit(v.bandit),
    draws: Number.isSafeInteger(v.draws) && (v.draws as number) >= 0 ? (v.draws as number) : 0,
  };
}

/** The plan's next uniform value in [0, 1): mulberry32 over (seed, draw count), as the dealer draws. */
export function planRandom(plan: RunPlanState, seed: number): () => number {
  return () => mulberry32((seed + 0x632be5ab + Math.imul(plan.draws++, 0x9e3779b1)) >>> 0);
}

// ---------- kinds of problems ----------

/** Size rings by N+M+P, as the problem sets unlock them (largest first). */
const RINGS = [300, 200, 120, 80, 50, 30, 0];

/** Piece shapes in classes: circles, few sides (3–8), many (9–20), near-circular (21 and up). */
function shapeClass(N: number): string {
  if (N === 0) return "c";
  if (N <= 8) return "f";
  if (N <= 20) return "m";
  return "r";
}

/** A kind of problem for the bandit: tier, size ring and piece-shape class, e.g. "open|t120|r". */
export function problemKind(p: PolygonKey & { tier: string }): string {
  const t = p.N + p.M + p.P;
  return `${p.tier}|t${RINGS.find((r) => t >= r) ?? 0}|${shapeClass(p.N)}`;
}

/** The arm of a method at a tuning level on a kind of problem: "open|t120|r|mc_compress@2". */
export const armKey = (kind: string, method: EvolveMethod, level: number): string => `${kind}|${method}@${level}`;

/** Splits an arm key into its kind, method and level, or null. */
export function parseArm(key: string): { kind: string; method: EvolveMethod; level: number } | null {
  const m = /^(.*)\|([a-z_]+)@(\d)$/.exec(key);
  return m ? { kind: m[1], method: m[2] as EvolveMethod, level: Number(m[3]) } : null;
}

/**
 * What an untried arm is believed to pay: the mean of the arms already tried on this kind of
 * problem (else of all arms), with a spread as wide as that mean, so new arms get tried.
 */
export function priorFor(b: Bandit, kind: string): Prior {
  const pool = (prefix: string | null) =>
    Object.entries(b).filter(([k, a]) => a.n > 0 && (prefix === null || k.startsWith(`${prefix}|`)));
  let arms = pool(kind);
  if (!arms.length) arms = pool(null);
  if (!arms.length) return { mean: 0, sd: 1 };
  const n = arms.reduce((t, [, a]) => t + a.n, 0);
  const mean = arms.reduce((t, [, a]) => t + a.mean * a.n, 0) / n;
  const spread = Math.sqrt(arms.reduce((t, [, a]) => t + a.n * (a.mean - mean) ** 2, 0) / n);
  return { mean, sd: Math.max(spread, Math.abs(mean), 1e-6) };
}

export interface RunChoice {
  method: EvolveMethod;
  /** Tuning level: the owned level, or with Auto-tune any level up to it. */
  level: number;
}

/**
 * Method match: the method (and with `tune`, the level) for a new run on a problem of `kind`, among
 * the owned methods that `allowed` lets through; null when none is allowed.
 */
export function chooseRun(
  plan: RunPlanState,
  opts: {
    kind: string;
    methods: readonly EvolveMethod[];
    levelOf: (m: EvolveMethod) => number;
    tune: boolean;
    allowed: (m: EvolveMethod) => boolean;
    rand: () => number;
  },
): RunChoice | null {
  const arms: string[] = [];
  for (const m of opts.methods) {
    if (!opts.allowed(m)) continue;
    const top = opts.levelOf(m);
    if (opts.tune) for (let l = 0; l <= top; l++) arms.push(armKey(opts.kind, m, l));
    else arms.push(armKey(opts.kind, m, top));
  }
  if (!arms.length) return null;
  const pick =
    arms.length === 1 ? arms[0] : choose(plan.bandit, arms, () => priorFor(plan.bandit, opts.kind), opts.rand)!;
  const a = parseArm(pick)!;
  return { method: a.method, level: a.level };
}

/** Runs shorter than this are not observed: too few evaluations to say what the arm pays. */
export const MIN_OBSERVED_EVALS = 20;

/** A run's result, as the bandit learns it: RP earned during the run, per evaluation. */
export function observeRun(
  plan: RunPlanState,
  kind: string,
  method: EvolveMethod,
  level: number,
  rp: number,
  evaluations: number,
): boolean {
  if (!(evaluations >= MIN_OBSERVED_EVALS) || !Number.isFinite(rp)) return false;
  observe(plan.bandit, armKey(kind, method, level), rp / evaluations);
  return true;
}

/** What the bandit believes the arms of one kind of problem pay, best first (for the Runs panel). */
export function learned(
  plan: RunPlanState,
  kind: string,
): { method: EvolveMethod; level: number; mean: number; runs: number }[] {
  const prior = priorFor(plan.bandit, kind);
  return Object.entries(plan.bandit)
    .filter(([k, a]) => a.n > 0 && k.startsWith(`${kind}|`))
    .map(([k, a]) => {
      const p = parseArm(k)!;
      return { method: p.method, level: p.level, mean: posterior(plan.bandit, k, prior).mean, runs: a.n };
    })
    .sort((x, y) => y.mean - x.mean);
}

/** Runs observed in all. */
export const runsObserved = (plan: RunPlanState): number => Object.values(plan.bandit).reduce((t, a) => t + a.n, 0);

// ---------- pipelines ----------

/**
 * The method of the next run on a problem whose runs have ended `endedRuns` times by themselves: the
 * pipeline's stage at that count, in a loop, skipping stages that `allowed` refuses. Null for an
 * empty pipeline or when no stage is allowed.
 */
export function pipelineMethod(
  pipeline: readonly EvolveMethod[],
  endedRuns: number,
  allowed: (m: EvolveMethod) => boolean,
): { method: EvolveMethod; stage: number } | null {
  const n = pipeline.length;
  for (let i = 0; i < n; i++) {
    const stage = (endedRuns + i) % n;
    if (allowed(pipeline[stage])) return { method: pipeline[stage], stage };
  }
  return null;
}

/** Edits of the pipeline from the Runs panel. Each returns the new pipeline. */
export function addStage(pipeline: readonly EvolveMethod[], m: EvolveMethod): EvolveMethod[] {
  return pipeline.length >= MAX_STAGES ? [...pipeline] : [...pipeline, m];
}
export function removeStage(pipeline: readonly EvolveMethod[], i: number): EvolveMethod[] {
  return pipeline.filter((_, k) => k !== i);
}
export function moveStage(pipeline: readonly EvolveMethod[], i: number, by: -1 | 1): EvolveMethod[] {
  const j = i + by;
  const out = [...pipeline];
  if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
