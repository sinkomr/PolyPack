/**
 * The schedule of a hardening run, after Yohei Nakajima (https://github.com/yoheinakajima/soft-to-rigid,
 * MIT licence; paper Section "Method", engine/engine2d.js `runPath`): the three phases, the shape
 * path in the kernel's terms, and the length of a run under an evaluation budget
 * (docs/methods/dimensions/harden.md).
 */

/**
 * Paths of the reference that the kernel's shape family can follow. Its `grow` and `grow-area`
 * paths scale the pieces, which a kernel's soft shapes do not, so they are not offered here.
 */
export const HARDEN_PATHS = ["harden", "rigid", "snap"] as const;
export type HardenPath = (typeof HARDEN_PATHS)[number];

export interface PhaseSteps {
  compress: number;
  morph: number;
  settle: number;
}

/**
 * The kernel's shape t at progress u in [0, 1] of the path phase; compression holds u = 0 and
 * settling u = 1. The reference's softness tau is 1 - t: tau = 1 is the inscribed disk or ball,
 * tau = 0 the true shape. Every path ends at exactly t = 1, returned literally so that rounding in
 * a schedule cannot leave a slightly soft piece.
 *
 *  - harden: tau falls from tau0 to 0, so t = 1 - tau0 (1 - u);
 *  - rigid: the true shape throughout;
 *  - snap: inscribed disks through compression and the first path step, then the true shape at once.
 */
export function pathShape(path: HardenPath, u: number, tau0: number): number {
  if (u >= 1 || path === "rigid") return 1;
  const progress = Math.max(0, u);
  if (path === "harden") return 1 - tau0 * (1 - progress);
  return progress === 0 ? 0 : 1;
}

/**
 * Phase lengths of a run of `steps` momentum steps, in the proportion of the full-length run
 * (reference 2500 : 7500 : 1500). The path phase receives the rounding remainder and at least one
 * step. A run from a supplied arrangement has no compression: those steps go to the path.
 */
export function planPhases(steps: number, full: PhaseSteps, compression = true): PhaseSteps {
  const total = full.compress + full.morph + full.settle;
  const count = Math.max(1, Math.floor(steps));
  let compress = Math.round((count * full.compress) / total);
  let settle = Math.round((count * full.settle) / total);
  if (compress + settle >= count) {
    settle = Math.min(settle, count - 1);
    compress = Math.min(compress, count - 1 - settle);
  }
  if (!compression) compress = 0;
  return { compress, morph: count - compress - settle, settle };
}

/** What a run costs, in evaluations. */
export interface RunCosts {
  /** Evaluations one momentum step costs: an energy evaluation with its gradient (the kernel's gradCost). */
  step: number;
  /** Steps per measurement of the size's unit, which costs one more step (HardenDynamics.measureUnit; 0: none). */
  measure: number;
  /** Evaluations one offer may cost: a finish, and the validation of an improvement. */
  offer: number;
  /** The run's full-length phases, in whose proportion a shorter run is split. */
  full: PhaseSteps;
  /** Settling steps between offers (0: only at the end of the run). */
  interval: number;
  /** Evaluations of the closing squeeze and its offer (0: no squeeze). */
  polish: number;
}

/**
 * Offers a run of `steps` steps makes: one every `interval` steps while settling (true shapes,
 * nearly settled: the offers that a stop can use), one at its end. The closing squeeze's offer is
 * part of its own cost.
 */
export function offersPerRun(steps: number, c: RunCosts): number {
  const settle = planPhases(steps, c.full).settle;
  return (c.interval > 0 && settle > 0 ? Math.floor((settle - 1) / c.interval) : 0) + 1;
}

/** Evaluations a run of `steps` steps costs at most. */
export function runCost(steps: number, c: RunCosts): number {
  const measurements = c.measure > 0 ? Math.ceil(steps / c.measure) : 0;
  return (steps + measurements) * c.step + c.offer * offersPerRun(steps, c) + c.polish;
}

/**
 * The longest run that fits `share` evaluations, or 0. An evaluation budget therefore shortens all
 * three phases together and never cuts a run before it has settled and offered its result.
 * runCost grows with the steps, so a bisection finds it.
 */
export function stepsFor(share: number, c: RunCosts): number {
  if (runCost(1, c) > share) return 0;
  let lo = 1;
  let hi = Math.max(1, Math.ceil(share / c.step)) + 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (runCost(mid, c) <= share) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The shortest run an evaluation budget is split into, in steps (the polygon method's one assessment). */
export const MIN_RUN_STEPS = 32;

/**
 * Number of runs for an evaluation allowance: `restarts` when it is positive, otherwise as many
 * full-length runs as fit (at least one, shortened if necessary); never so many that a run could
 * not take MIN_RUN_STEPS steps.
 */
export function planRuns(evals: number, c: RunCosts, restarts: number): number {
  if (!Number.isFinite(evals)) return restarts > 0 ? restarts : Infinity;
  const fullSteps = c.full.compress + c.full.morph + c.full.settle;
  const wanted = restarts > 0 ? restarts : Math.floor(evals / runCost(fullSteps, c));
  const most = Math.floor(evals / runCost(Math.min(MIN_RUN_STEPS, fullSteps), { ...c, polish: 0 }));
  return Math.max(1, Math.min(wanted, most));
}
