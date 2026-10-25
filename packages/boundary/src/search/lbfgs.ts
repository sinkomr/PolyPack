/**
 * Minimal L-BFGS with a backtracking (Armijo) line search, for the penalty energies of the boundary
 * searches. The energies are sums of squared violations: zero on the feasible set and about
 * quadratic with unit curvature near it, so the first step is -g / 2 (exact for one violation)
 * and every step is capped at `maxStep` (a length: the variables are displacements).
 *
 * `f` returns the value and writes the gradient into `g`; it may return Infinity (a centre whose
 * path met a hinge), which the line search treats as too long a step. It may also throw (the
 * search's stop), which ends the run at once. Buffers are allocated once per call.
 */

export interface LbfgsOptions {
  maxIter: number;
  /** Stop as soon as the value is below this. */
  target: number;
  /** Longest step (Euclidean norm of the change of x). */
  maxStep: number;
  /** Correction pairs kept (default 12). */
  memory?: number;
}

export interface LbfgsResult {
  x: Float64Array;
  f: number;
}

export function lbfgs(f: (x: Float64Array, g: Float64Array) => number, x0: Float64Array, o: LbfgsOptions): LbfgsResult {
  const n = x0.length;
  const m = o.memory ?? 12;
  let x = Float64Array.from(x0);
  let g = new Float64Array(n);
  let fx = f(x, g);
  if (!(fx < Infinity) || fx < o.target || n === 0) return { x, f: fx };
  const S = Array.from({ length: m }, () => new Float64Array(n));
  const Y = Array.from({ length: m }, () => new Float64Array(n));
  const rho = new Float64Array(m);
  const alpha = new Float64Array(m);
  let head = 0;
  let len = 0;
  const d = new Float64Array(n);
  let xn = new Float64Array(n);
  let gn = new Float64Array(n);
  for (let it = 0; it < o.maxIter && fx >= o.target; it++) {
    let gg = 0;
    for (let k = 0; k < n; k++) gg += g[k] * g[k];
    if (!(gg > 1e-300)) break;
    // two-loop recursion, newest pair first
    for (let k = 0; k < n; k++) d[k] = -g[k];
    for (let j = 0; j < len; j++) {
      const i = (head - 1 - j + 2 * m) % m;
      const Si = S[i];
      let a = 0;
      for (let k = 0; k < n; k++) a += Si[k] * d[k];
      a *= rho[i];
      alpha[i] = a;
      const Yi = Y[i];
      for (let k = 0; k < n; k++) d[k] -= a * Yi[k];
    }
    if (len) {
      const i = (head - 1 + m) % m;
      let sy = 0;
      let yy = 0;
      for (let k = 0; k < n; k++) {
        sy += S[i][k] * Y[i][k];
        yy += Y[i][k] * Y[i][k];
      }
      const gamma = sy / yy;
      for (let k = 0; k < n; k++) d[k] *= gamma;
    } else for (let k = 0; k < n; k++) d[k] *= 0.5;
    for (let j = len - 1; j >= 0; j--) {
      const i = (head - 1 - j + 2 * m) % m;
      const Yi = Y[i];
      let b = 0;
      for (let k = 0; k < n; k++) b += Yi[k] * d[k];
      b *= rho[i];
      const Si = S[i];
      for (let k = 0; k < n; k++) d[k] += (alpha[i] - b) * Si[k];
    }
    let slope = 0;
    for (let k = 0; k < n; k++) slope += g[k] * d[k];
    if (!(slope < 0)) {
      // not a descent direction: forget the history and take a steepest-descent step
      len = 0;
      for (let k = 0; k < n; k++) d[k] = -0.5 * g[k];
      slope = -0.5 * gg;
    }
    let dn = 0;
    for (let k = 0; k < n; k++) dn += d[k] * d[k];
    dn = Math.sqrt(dn);
    if (dn > o.maxStep) {
      const c = o.maxStep / dn;
      for (let k = 0; k < n; k++) d[k] *= c;
      slope *= c;
    }
    let t = 1;
    let fn = Infinity;
    for (let ls = 0; ls < 40; ls++) {
      for (let k = 0; k < n; k++) xn[k] = x[k] + t * d[k];
      fn = f(xn, gn);
      if (fn <= fx + 1e-4 * t * slope) break;
      t *= 0.5;
    }
    if (!(fn < fx)) break;
    const i = head;
    const Si = S[i];
    const Yi = Y[i];
    let sy = 0;
    let ss = 0;
    let yy = 0;
    for (let k = 0; k < n; k++) {
      Si[k] = xn[k] - x[k];
      Yi[k] = gn[k] - g[k];
      sy += Si[k] * Yi[k];
      ss += Si[k] * Si[k];
      yy += Yi[k] * Yi[k];
    }
    // keep the pair only when it carries positive curvature (the penalties are piecewise quadratic)
    if (sy > 1e-12 * Math.sqrt(ss * yy) && sy > 1e-300) {
      rho[i] = 1 / sy;
      head = (head + 1) % m;
      len = Math.min(len + 1, m);
    }
    const rel = (fx - fn) / fx;
    [x, xn] = [xn, x];
    [g, gn] = [gn, g];
    fx = fn;
    if (rel < 1e-14) break;
  }
  return { x, f: fx };
}
