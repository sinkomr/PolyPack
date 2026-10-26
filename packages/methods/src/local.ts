/**
 * Local solves shared by the methods, on any kernel: L-BFGS on the kernel's penalty energy with
 * every variable scaled to piece units (a variable divided by its `steps` entry), so one step
 * length suits every space.
 *
 *  - relax: the size fixed, minimise the energy (a repair: overlaps pushed apart);
 *  - squeeze: minimise size + mu * energy over the variables and the size together, for each mu of
 *    a rising schedule (a quadratic penalty method: the size shrinks as far as overlaps allow),
 *    then relax at the size reached.
 *
 * Both rebase the state's charts after each L-BFGS run and leave the state at its result. Every
 * energy call goes through the kernel given, so with the counted kernel of a method context they
 * are charged to the run and may throw its Stop.
 */
import type { KernelState, SpaceKernel } from "./kernel";
import { lbfgs } from "./lbfgs";

/** The typical step of every variable of x: the pieces' steps, then the globals'. */
export function variableSteps(k: SpaceKernel): Float64Array {
  const n = k.P * k.dim;
  const out = new Float64Array(n + k.globals);
  for (let i = 0; i < n; i++) out[i] = k.steps[i % k.dim];
  for (let g = 0; g < k.globals; g++) out[n + g] = k.globalSteps[g];
  return out;
}

export interface RelaxOptions {
  /** L-BFGS iterations (default 200). */
  maxIter?: number;
  /** Stop once the energy is below this (default 1e-20). */
  target?: number;
  /** Longest step in piece units (default 0.5). */
  maxStep?: number;
  /** Per-piece weights of the energy terms (see SpaceKernel.energy). */
  weights?: Float64Array;
}

/** Relaxes s at its size; returns the energy reached. */
export function relax(k: SpaceKernel, s: KernelState, o: RelaxOptions = {}): number {
  const steps = variableSteps(k);
  const n = steps.length;
  const grad = new Float64Array(n + 1);
  const y0 = new Float64Array(n);
  for (let i = 0; i < n; i++) y0[i] = s.x[i] / steps[i];
  const f = (y: Float64Array, g: Float64Array) => {
    for (let i = 0; i < n; i++) s.x[i] = y[i] * steps[i];
    const e = k.energy(s, grad, o.weights);
    for (let i = 0; i < n; i++) g[i] = grad[i] * steps[i];
    return e;
  };
  const r = lbfgs(f, y0, { maxIter: o.maxIter ?? 200, target: o.target ?? 1e-20, maxStep: o.maxStep ?? 0.5 });
  for (let i = 0; i < n; i++) s.x[i] = r.x[i] * steps[i];
  k.rebase(s);
  return r.f;
}

export interface SqueezeOptions {
  /** The penalty weights, in order (default 1e1, 1e2, ..., 1e6). */
  mus?: readonly number[];
  /** L-BFGS iterations per weight (default 200). */
  maxIter?: number;
  /** Longest step in piece units (default 0.25). */
  maxStep?: number;
  /** The size is kept above this (default the kernel's bound, else 0; pass a lower floor for soft shapes, for which the bound does not hold). */
  minSize?: number;
  weights?: Float64Array;
}

/** Squeezes s as far as its overlaps allow; returns the energy at the size reached. */
export function squeeze(k: SpaceKernel, s: KernelState, o: SqueezeOptions = {}): number {
  const steps = variableSteps(k);
  const n = steps.length;
  const minSize = o.minSize ?? k.bound ?? 0;
  const grad = new Float64Array(n + 1);
  for (const mu of o.mus ?? [1e1, 1e2, 1e3, 1e4, 1e5, 1e6]) {
    const y0 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) y0[i] = s.x[i] / steps[i];
    y0[n] = s.size;
    const f = (y: Float64Array, g: Float64Array) => {
      if (!(y[n] > minSize)) return Infinity;
      for (let i = 0; i < n; i++) s.x[i] = y[i] * steps[i];
      s.size = y[n];
      const e = k.energy(s, grad, o.weights);
      for (let i = 0; i < n; i++) g[i] = mu * grad[i] * steps[i];
      g[n] = 1 + mu * grad[n];
      return y[n] + mu * e;
    };
    const r = lbfgs(f, y0, { maxIter: o.maxIter ?? 200, target: -Infinity, maxStep: o.maxStep ?? 0.25 });
    for (let i = 0; i < n; i++) s.x[i] = r.x[i] * steps[i];
    s.size = r.x[n];
    k.rebase(s);
  }
  return relax(k, s, { maxIter: o.maxIter, weights: o.weights });
}
