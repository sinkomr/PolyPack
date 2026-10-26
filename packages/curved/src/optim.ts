/**
 * Small numerical kernels: L-BFGS, a bounded primal simplex LP solver with elastic rows, and NNLS.
 * Dense and dependency-free; sized for packings of up to a few hundred variables.
 */

// ------------------------------------------------------------------------------------------
// L-BFGS with Armijo backtracking

export interface LbfgsResult {
  x: Float64Array;
  f: number;
  iterations: number;
}

export function lbfgs(
  fg: (x: Float64Array, g: Float64Array) => number,
  x0: Float64Array,
  opts: {
    maxIter?: number;
    m?: number;
    gtol?: number;
    ftol?: number;
    stopBelow?: number;
    /** Optional external stop, polled before every iteration; true ends the run at the current point. */
    shouldStop?: () => boolean;
  } = {},
): LbfgsResult {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 200;
  const m = opts.m ?? 8;
  const gtol = opts.gtol ?? 1e-12;
  const stopBelow = opts.stopBelow ?? -Infinity;
  const x = Float64Array.from(x0);
  const g = new Float64Array(n);
  let f = fg(x, g);
  const S: Float64Array[] = [];
  const Y: Float64Array[] = [];
  const rho: number[] = [];
  const d = new Float64Array(n);
  const xn = new Float64Array(n);
  const gn = new Float64Array(n);
  const alpha = new Float64Array(m);
  let it = 0;
  for (; it < maxIter; it++) {
    if (f <= stopBelow) break;
    if (opts.shouldStop?.()) break;
    let gn2 = 0;
    for (let i = 0; i < n; i++) gn2 += g[i] * g[i];
    if (Math.sqrt(gn2) < gtol) break;
    // two-loop recursion
    for (let i = 0; i < n; i++) d[i] = -g[i];
    const k = S.length;
    for (let j = k - 1; j >= 0; j--) {
      let a = 0;
      for (let i = 0; i < n; i++) a += S[j][i] * d[i];
      a *= rho[j];
      alpha[j] = a;
      for (let i = 0; i < n; i++) d[i] -= a * Y[j][i];
    }
    if (k > 0) {
      let sy = 0;
      let yy = 0;
      for (let i = 0; i < n; i++) {
        sy += S[k - 1][i] * Y[k - 1][i];
        yy += Y[k - 1][i] * Y[k - 1][i];
      }
      const gamma = sy / yy;
      for (let i = 0; i < n; i++) d[i] *= gamma;
    } else {
      // first step: scale to a modest move
      const s = 0.01 / Math.max(1e-12, Math.sqrt(gn2));
      for (let i = 0; i < n; i++) d[i] *= Math.min(1, s * 10);
    }
    for (let j = 0; j < k; j++) {
      let b = 0;
      for (let i = 0; i < n; i++) b += Y[j][i] * d[i];
      b *= rho[j];
      for (let i = 0; i < n; i++) d[i] += S[j][i] * (alpha[j] - b);
    }
    let dg = 0;
    for (let i = 0; i < n; i++) dg += d[i] * g[i];
    if (!(dg < 0)) {
      // not a descent direction: reset memory and use steepest descent
      S.length = 0;
      Y.length = 0;
      rho.length = 0;
      for (let i = 0; i < n; i++) d[i] = -g[i] * 0.01;
      dg = 0;
      for (let i = 0; i < n; i++) dg += d[i] * g[i];
    }
    let step = 1;
    let fn = 0;
    let ok = false;
    for (let ls = 0; ls < 30; ls++) {
      for (let i = 0; i < n; i++) xn[i] = x[i] + step * d[i];
      fn = fg(xn, gn);
      if (fn <= f + 1e-4 * step * dg) {
        ok = true;
        break;
      }
      step *= 0.5;
    }
    if (!ok) break;
    const s = new Float64Array(n);
    const y = new Float64Array(n);
    let sy = 0;
    for (let i = 0; i < n; i++) {
      s[i] = xn[i] - x[i];
      y[i] = gn[i] - g[i];
      sy += s[i] * y[i];
    }
    const df = f - fn;
    x.set(xn);
    g.set(gn);
    f = fn;
    if (sy > 1e-20) {
      S.push(s);
      Y.push(y);
      rho.push(1 / sy);
      if (S.length > m) {
        S.shift();
        Y.shift();
        rho.shift();
      }
    }
    if (opts.ftol !== undefined && df < opts.ftol * Math.max(1, Math.abs(f))) break;
  }
  return { x, f, iterations: it };
}

// ------------------------------------------------------------------------------------------
// Linear programming: minimise c.x subject to sparse rows A x >= b, lo <= x <= hi.
// Elastic rows: A x + s >= b with s >= 0 at cost `penalty` each, so x = lo is always feasible.

export interface LpRow {
  idx: number[];
  val: number[];
  rhs: number;
}

export interface LpResult {
  x: Float64Array;
  /** elastic slack per row (0 when the row holds) */
  slack: Float64Array;
  /** dual multiplier per row (>= 0) */
  dual: Float64Array;
  objective: number;
  status: "optimal" | "iteration_limit";
}

/**
 * Bounded-variable primal simplex on a dense tableau. Columns: structural x' = x - lo in [0, hi - lo],
 * elastic s_k >= 0 (cost `penalty`), surplus r_k >= 0. Row k: A_k x' + s_k - r_k = b_k - A_k lo.
 *
 * `poll`, when given, is called before every pivot with the pivot's work (the tableau entries it
 * reads and writes, about m (n + 2m) + m (n + m)); true ends the solve at the current basis, a
 * feasible point of the elastic LP, with status "iteration_limit". Without it nothing changes.
 */
export function solveLp(
  c: Float64Array,
  rows: LpRow[],
  lo: Float64Array,
  hi: Float64Array,
  penalty = 1e4,
  maxPivots = 5000,
  poll?: (work: number) => boolean,
): LpResult {
  const n = c.length;
  const m = rows.length;
  const U = new Float64Array(n);
  for (let j = 0; j < n; j++) U[j] = hi[j] - lo[j];
  // tableau over columns [x' (n) | s (m)]; the column of r_k is the negative of that of s_k
  const W = n + m;
  const T = new Float64Array(m * W);
  const rhs = new Float64Array(m);
  const basis = new Int32Array(m); // column index; >= n + m means r_(k) with k = col - n - m
  for (let k = 0; k < m; k++) {
    const r = rows[k];
    let beta = r.rhs;
    for (let q = 0; q < r.idx.length; q++) beta -= r.val[q] * lo[r.idx[q]];
    const sign = beta >= 0 ? 1 : -1;
    // basic variable: s_k if beta >= 0 else r_k; scale the row so the basic column is +e_k
    for (let q = 0; q < r.idx.length; q++) T[k * W + r.idx[q]] += sign * r.val[q];
    T[k * W + n + k] = sign; // s_k column (times sign)
    rhs[k] = sign * beta;
    basis[k] = sign > 0 ? n + k : n + m + k;
  }
  // column helpers: cost and tableau entry for virtual r columns
  const cost = (col: number) => (col < n ? c[col] : col < n + m ? penalty : 0);
  const entry = (k: number, col: number) => (col < n + m ? T[k * W + col] : -T[k * W + (col - m)]);
  const atUpper = new Uint8Array(n); // structural nonbasic at upper bound
  const isBasic = new Uint8Array(n + 2 * m);
  for (let k = 0; k < m; k++) isBasic[basis[k]] = 1;
  const dual = new Float64Array(m);
  const tolD = 1e-11;
  const tolP = 1e-10;
  let status: LpResult["status"] = "optimal";
  let degenerate = 0;
  const pivotWork = m * (n + 2 * m) + m * W;
  for (let piv = 0; ; piv++) {
    if (piv >= maxPivots || poll?.(pivotWork)) {
      status = "iteration_limit";
      break;
    }
    // duals y_k = cost(basis_k) * (row scaling already in T): reduced cost d_j = c_j - sum_k cB_k T_kj
    // pick entering column (Dantzig, Bland under prolonged degeneracy)
    let enter = -1;
    let bestScore = 0;
    let enterDir = 0;
    const useBland = degenerate > 50;
    for (let col = 0; col < n + 2 * m; col++) {
      if (isBasic[col]) continue;
      let d = cost(col);
      for (let k = 0; k < m; k++) {
        const e = entry(k, col);
        if (e !== 0) d -= cost(basis[k]) * e;
      }
      let dir = 0;
      if (col < n) {
        if (!atUpper[col] && d < -tolD && U[col] > 0) dir = 1;
        else if (atUpper[col] && d > tolD) dir = -1;
      } else if (d < -tolD) dir = 1;
      if (dir === 0) continue;
      const score = Math.abs(d);
      if (useBland) {
        enter = col;
        enterDir = dir;
        break;
      }
      if (score > bestScore) {
        bestScore = score;
        enter = col;
        enterDir = dir;
      }
    }
    if (enter < 0) break;
    // ratio test: moving entering var by theta*dir changes basic k by -dir*theta*entry(k, enter)
    let theta = enter < n ? U[enter] : Infinity;
    let leave = -1;
    let leaveToUpper = false;
    for (let k = 0; k < m; k++) {
      const a = enterDir * entry(k, enter);
      const bk = basis[k];
      if (a > tolP) {
        const t = rhs[k] / a;
        if (t < theta - 1e-15 || (t <= theta && leave >= 0 && bk < basis[leave])) {
          theta = t;
          leave = k;
          leaveToUpper = false;
        }
      } else if (a < -tolP && bk < n) {
        const t = (rhs[k] - U[bk]) / a;
        if (t < theta - 1e-15) {
          theta = t;
          leave = k;
          leaveToUpper = true;
        }
      }
    }
    if (!Number.isFinite(theta)) {
      status = "iteration_limit"; // unbounded cannot happen for bounded x and costed slacks
      break;
    }
    if (theta < 1e-14) degenerate++;
    else degenerate = 0;
    if (leave < 0) {
      // bound flip of the entering structural variable
      for (let k = 0; k < m; k++) rhs[k] -= enterDir * theta * entry(k, enter);
      atUpper[enter] = enterDir > 0 ? 1 : 0;
      continue;
    }
    // update rhs for the step
    for (let k = 0; k < m; k++) if (k !== leave) rhs[k] -= enterDir * theta * entry(k, enter);
    const leaving = basis[leave];
    // new value of entering variable
    const enterValue = enter < n ? (atUpper[enter] ? U[enter] : 0) + enterDir * theta : theta;
    // pivot on (leave, enter)
    const pivotVal = entry(leave, enter);
    // materialise the entering column (r columns are virtual)
    const colVals = new Float64Array(m);
    for (let k = 0; k < m; k++) colVals[k] = entry(k, enter);
    const rowL = leave * W;
    for (let j = 0; j < W; j++) T[rowL + j] /= pivotVal;
    for (let k = 0; k < m; k++) {
      if (k === leave) continue;
      const f = colVals[k];
      if (f === 0) continue;
      const rk = k * W;
      for (let j = 0; j < W; j++) {
        const v = T[rowL + j];
        if (v !== 0) T[rk + j] -= f * v;
      }
    }
    rhs[leave] = enterValue;
    if (leaving < n) atUpper[leaving] = leaveToUpper ? 1 : 0;
    isBasic[leaving] = 0;
    isBasic[enter] = 1;
    basis[leave] = enter;
    if (enter < n) atUpper[enter] = 0;
  }
  // extract solution
  const xp = new Float64Array(n);
  for (let j = 0; j < n; j++) xp[j] = atUpper[j] ? U[j] : 0;
  const slack = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const col = basis[k];
    if (col < n) xp[col] = rhs[k];
    else if (col < n + m) slack[col - n] = rhs[k];
  }
  const x = new Float64Array(n);
  let obj = 0;
  for (let j = 0; j < n; j++) {
    x[j] = lo[j] + xp[j];
    obj += c[j] * x[j];
  }
  for (let k = 0; k < m; k++) obj += penalty * slack[k];
  // duals: reduced cost of surplus r_k = 0 - sum_i cB_i entry(i, r_k) = y_k
  for (let k = 0; k < m; k++) {
    const col = n + m + k;
    let d = 0;
    for (let i = 0; i < m; i++) {
      const e = entry(i, col);
      if (e !== 0) d -= cost(basis[i]) * e;
    }
    dual[k] = isBasic[col] ? 0 : Math.max(0, d);
  }
  return { x, slack, dual, objective: obj, status };
}

// ------------------------------------------------------------------------------------------
// Non-negative least squares (Lawson-Hanson): minimise |A x - b| subject to x >= 0. A is m x n, column-major list.

export function nnls(cols: Float64Array[], b: Float64Array, maxIter = 500): { x: Float64Array; residual: number } {
  const n = cols.length;
  const m = b.length;
  const x = new Float64Array(n);
  const passive = new Uint8Array(n);
  const resid = () => {
    const r = Float64Array.from(b);
    for (let j = 0; j < n; j++) if (x[j] !== 0) for (let i = 0; i < m; i++) r[i] -= cols[j][i] * x[j];
    return r;
  };
  const solvePassive = (): Float64Array => {
    // least squares on passive columns via normal equations with Cholesky (small systems)
    const P: number[] = [];
    for (let j = 0; j < n; j++) if (passive[j]) P.push(j);
    const k = P.length;
    const G = new Float64Array(k * k);
    const h = new Float64Array(k);
    for (let a = 0; a < k; a++) {
      for (let c2 = 0; c2 <= a; c2++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += cols[P[a]][i] * cols[P[c2]][i];
        G[a * k + c2] = s;
        G[c2 * k + a] = s;
      }
      let s = 0;
      for (let i = 0; i < m; i++) s += cols[P[a]][i] * b[i];
      h[a] = s;
    }
    for (let a = 0; a < k; a++) G[a * k + a] += 1e-14 * (1 + G[a * k + a]);
    // Cholesky
    const Lm = new Float64Array(k * k);
    for (let a = 0; a < k; a++) {
      for (let c2 = 0; c2 <= a; c2++) {
        let s = G[a * k + c2];
        for (let q = 0; q < c2; q++) s -= Lm[a * k + q] * Lm[c2 * k + q];
        if (a === c2) Lm[a * k + a] = Math.sqrt(Math.max(s, 1e-300));
        else Lm[a * k + c2] = s / Lm[c2 * k + c2];
      }
    }
    const z = new Float64Array(k);
    for (let a = 0; a < k; a++) {
      let s = h[a];
      for (let q = 0; q < a; q++) s -= Lm[a * k + q] * z[q];
      z[a] = s / Lm[a * k + a];
    }
    for (let a = k - 1; a >= 0; a--) {
      let s = z[a];
      for (let q = a + 1; q < k; q++) s -= Lm[q * k + a] * z[q];
      z[a] = s / Lm[a * k + a];
    }
    const out = new Float64Array(n);
    P.forEach((j, a) => (out[j] = z[a]));
    return out;
  };
  for (let it = 0; it < maxIter; it++) {
    const r = resid();
    let best = -1;
    let bw = 1e-13;
    for (let j = 0; j < n; j++) {
      if (passive[j]) continue;
      let w = 0;
      for (let i = 0; i < m; i++) w += cols[j][i] * r[i];
      if (w > bw) {
        bw = w;
        best = j;
      }
    }
    if (best < 0) break;
    passive[best] = 1;
    for (let inner = 0; inner < 100; inner++) {
      const z = solvePassive();
      let ok = true;
      for (let j = 0; j < n; j++) if (passive[j] && z[j] <= 0) ok = false;
      if (ok) {
        x.set(z);
        break;
      }
      let alpha = Infinity;
      for (let j = 0; j < n; j++) {
        if (passive[j] && z[j] <= 0) {
          const a = x[j] / (x[j] - z[j]);
          if (a < alpha) alpha = a;
        }
      }
      for (let j = 0; j < n; j++) {
        if (!passive[j]) continue;
        x[j] += alpha * (z[j] - x[j]);
        if (x[j] <= 1e-15) {
          x[j] = 0;
          passive[j] = 0;
        }
      }
    }
  }
  const r = resid();
  let rn = 0;
  for (let i = 0; i < m; i++) rn += r[i] * r[i];
  return { x, residual: Math.sqrt(rn) };
}

// ------------------------------------------------------------------------------------------
// Seeded random numbers (mulberry32)

export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
