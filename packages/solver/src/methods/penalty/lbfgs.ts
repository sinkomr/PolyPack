export interface ObjectiveValue {
  value: number;
  gradient: number[];
}
export interface LBFGSOptions {
  iterations: number;
  memory: number;
  tolerance: number;
  shouldStop?: () => boolean;
  checkpoint?: () => Promise<boolean>;
  onIteration?: (x: readonly number[], iteration: number) => Promise<boolean>;
}
export interface LBFGSResult {
  x: number[];
  value: number;
  iterations: number;
  status: "converged" | "limit" | "stopped" | "stalled" | "nonfinite";
}
function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
function finite(f: ObjectiveValue): boolean {
  return Number.isFinite(f.value) && f.gradient.every(Number.isFinite);
}
/** Two-loop inverse-Hessian recursion with an Armijo descent safeguard. */
export async function lbfgs(
  objective: (x: readonly number[]) => ObjectiveValue,
  initial: readonly number[],
  options: LBFGSOptions,
): Promise<LBFGSResult> {
  let x = Array.from(initial);
  let f = objective(x);
  let iterations = 0;
  const result = (status: LBFGSResult["status"]): LBFGSResult => ({ x, value: f.value, iterations, status });
  if (!finite(f)) return result("nonfinite");
  const history: { s: number[]; y: number[]; rho: number }[] = [];
  for (; iterations < options.iterations; iterations++) {
    if (options.shouldStop?.() || (options.checkpoint && !(await options.checkpoint()))) return result("stopped");
    if (Math.max(...f.gradient.map(Math.abs)) <= options.tolerance) return result("converged");
    const q = f.gradient.slice();
    const alpha = Array<number>(history.length);
    for (let k = history.length - 1; k >= 0; k--) {
      alpha[k] = history[k].rho * dot(history[k].s, q);
      for (let j = 0; j < q.length; j++) q[j] -= alpha[k] * history[k].y[j];
    }
    const last = history.at(-1);
    const scale = last ? dot(last.s, last.y) / dot(last.y, last.y) : 1;
    const direction = q.map((v) => v * scale);
    for (let k = 0; k < history.length; k++) {
      const beta = history[k].rho * dot(history[k].y, direction);
      for (let j = 0; j < q.length; j++) direction[j] += history[k].s[j] * (alpha[k] - beta);
    }
    for (let j = 0; j < q.length; j++) direction[j] = -direction[j];
    let slope = dot(f.gradient, direction);
    if (!Number.isFinite(slope) || slope >= -1e-16 * dot(f.gradient, f.gradient)) {
      history.length = 0;
      for (let j = 0; j < q.length; j++) direction[j] = -f.gradient[j];
      slope = -dot(f.gradient, f.gradient);
    }
    let step = history.length ? 1 : Math.min(1, 1 / Math.max(1, Math.sqrt(-slope)));
    let next: ObjectiveValue | undefined;
    let trial: number[] = [];
    // Nonfinite trials and feature switches cannot bypass the sufficient-decrease test.
    for (let line = 0; line < 48; line++) {
      if (options.shouldStop?.()) return result("stopped");
      trial = x.map((v, j) => v + step * direction[j]);
      const candidate = objective(trial);
      if (finite(candidate) && candidate.value <= f.value + 1e-4 * step * slope && candidate.value < f.value) {
        next = candidate;
        break;
      }
      step *= 0.5;
    }
    if (!next) return result("stalled");
    const s = trial.map((v, j) => v - x[j]);
    const y = next.gradient.map((v, j) => v - f.gradient[j]);
    const sy = dot(s, y);
    // Skip nonpositive or numerically vanishing curvature, preserving positive definiteness.
    if (sy > 1e-10 * Math.sqrt(dot(s, s) * dot(y, y))) {
      history.push({ s, y, rho: 1 / sy });
      if (history.length > options.memory) history.shift();
    }
    x = trial;
    f = next;
    if (options.onIteration && !(await options.onIteration(x, iterations))) return result("stopped");
  }
  return result("limit");
}
