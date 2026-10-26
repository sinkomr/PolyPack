/**
 * The two weight schedules of the penalty method, on any kernel. Both minimise
 * size + mu * energy over the variables and the size together, for a sequence of weights mu, and
 * end with a relaxation at the size reached (docs/methods/dimensions/penalty.md).
 *
 *  - quadratic: mu = initialWeight * growthFactor^k for k = 0 ... outerIterations - 1, the squeeze
 *    of local.ts.
 *  - augmented: per-piece weights as multipliers. The polygon method's Powell-Hestenes-Rockafellar
 *    term shifts each constraint by lambda / (2 mu); a kernel's energy has no per-constraint shift,
 *    only per-piece weights. At a solve's minimum each contact carries the force its geometry needs,
 *    about 2 * w * depth, so a piece whose residual depth r must fall to tau needs its weight times
 *    r / tau. After each solve the method measures every piece's residual depth (the square root of
 *    its terms). While the largest residual falls to violationReduction times the last one, mu is
 *    held and only the lagging pieces' weights rise; otherwise mu grows by growthFactor. The first
 *    solve holds mu, setting the baseline, as in the polygon method.
 */
import type { KernelState, SpaceKernel } from "../kernel";
import { lbfgs } from "../lbfgs";
import { relax, squeeze, variableSteps } from "../local";

export interface ScheduleOptions {
  schedule: "quadratic" | "augmented";
  initialWeight: number;
  growthFactor: number;
  outerIterations: number;
  innerIterations: number;
  violationReduction: number;
}

/** The weights mu of the quadratic schedule. */
export function quadraticWeights(o: Pick<ScheduleOptions, "initialWeight" | "growthFactor" | "outerIterations">) {
  return Array.from({ length: o.outerIterations }, (_, k) => o.initialWeight * o.growthFactor ** k);
}

/**
 * One solve of size + mu * energy(weights), like one weight of local.ts squeeze, without its closing
 * relaxation (the augmented schedule measures the residuals the solve leaves).
 */
function solve(k: SpaceKernel, s: KernelState, mu: number, weights: Float64Array, maxIter: number): void {
  const steps = variableSteps(k);
  const n = steps.length;
  const minSize = k.bound ?? 0;
  const grad = new Float64Array(n + 1);
  const y0 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) y0[i] = s.x[i] / steps[i];
  y0[n] = s.size;
  const f = (y: Float64Array, g: Float64Array) => {
    if (!(y[n] > minSize)) return Infinity;
    for (let i = 0; i < n; i++) s.x[i] = y[i] * steps[i];
    s.size = y[n];
    const e = k.energy(s, grad, weights);
    for (let i = 0; i < n; i++) g[i] = mu * grad[i] * steps[i];
    g[n] = 1 + mu * grad[n];
    return y[n] + mu * e;
  };
  const r = lbfgs(f, y0, { maxIter, target: -Infinity, maxStep: 0.25 });
  for (let i = 0; i < n; i++) s.x[i] = r.x[i] * steps[i];
  s.size = r.x[n];
  k.rebase(s);
}

/** Runs the schedule on s; leaves s at its result and returns the energy left there. */
export function descend(k: SpaceKernel, s: KernelState, o: ScheduleOptions): number {
  if (o.schedule === "quadratic") return squeeze(k, s, { mus: quadraticWeights(o), maxIter: o.innerIterations });
  const P = k.P;
  const weights = new Float64Array(P).fill(1);
  const residual = new Float64Array(P);
  let mu = o.initialWeight;
  let previous = Infinity;
  for (let outer = 0; outer < o.outerIterations; outer++) {
    solve(k, s, mu, weights, o.innerIterations);
    // each piece's residual depth: the root of its unweighted squared hinge terms, a length
    let largest = 0;
    for (let i = 0; i < P; i++) {
      residual[i] = Math.sqrt(k.pieceEnergy(s, i));
      largest = Math.max(largest, residual[i]);
    }
    // with no residual left (a solve cut short) tau is 0 and no weight changes
    if (largest <= o.violationReduction * previous) {
      const tau = o.violationReduction * largest;
      for (let i = 0; i < P; i++) if (residual[i] > tau) weights[i] *= residual[i] / tau;
    } else mu *= o.growthFactor;
    previous = largest;
  }
  return relax(k, s, { maxIter: o.innerIterations, weights });
}
