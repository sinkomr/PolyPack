/**
 * Curvature sensitivity at a polished optimum.
 *
 * For min s subject to g_k(z, s; K) >= 0 the Lagrangian is L = s - sum lambda_k g_k. With a unique
 * multiplier vector the value function has ds/dK = -sum lambda_k dg_k/dK (fixed z, s). When the
 * multipliers are not unique (degenerate contact graphs, common for tilings and symmetric records)
 * the one-sided derivatives are bounded by the extremes of -sum lambda_k dg_k/dK over the multiplier
 * polytope (Gauvin-Tolle type directional derivative: right slope = max, left slope = min, for a
 * fixed optimal configuration; switching to another optimal branch can only lower them).
 * `multiplierRange` computes those extremes by LP; `oneSidedSlopes` measures the actual slopes by
 * warm-started re-polishing at K +- dK.
 */
import { CurvedConfig, CurvedProblem, makeSpace } from "./problem";
import { allStates } from "./evaluate";
import { collectRows } from "./model";
import { PolishResult } from "./polish";
import { LpRow, solveLp } from "./optim";
import { dSideDApothem, apothemFromSide } from "./shapes";
import { polishAt, rowValueAt } from "./engine";

export interface MultiplierRange {
  /** min and max of -sum lambda_k dg_k/dK over multipliers satisfying stationarity */
  min: number;
  max: number;
  /** rows in the active set used */
  rows: number;
}

export function multiplierRange(
  problem: CurvedProblem,
  K: number,
  config: CurvedConfig,
  pol: PolishResult,
  tol = 1e-7,
): MultiplierRange {
  const space = makeSpace(K, problem.N, problem.M);
  const t = apothemFromSide(problem.M, K, config.size);
  const states = allStates(space, config.pieces);
  const rows = collectRows(space, states, t, { below: pol.margin + 1e-8, pairMode: "vertices" });
  const P = config.pieces.length;
  const n = 3 * P + 1;
  if (rows.length === 0) return { min: NaN, max: NaN, rows: 0 };
  const dtds = 1 / dSideDApothem(problem.M, K, t);
  // dg_k/dK at fixed z and s (row identity fixed)
  const h = 1e-6 * Math.max(1, Math.abs(K));
  const c = new Float64Array(rows.length);
  rows.forEach((r, k) => {
    const id = {
      kind: r.kind,
      i: r.i,
      j: r.j,
      wall: r.wall,
      vertex: r.vertex,
      owner: r.owner,
      edge: r.edge,
      gap: r.value,
      lambda: 0,
    };
    c[k] = -(rowValueAt(problem, K + h, config, id) - rowValueAt(problem, K - h, config, id)) / (2 * h);
  });
  // stationarity: sum_k lambda_k grad_(z, s) g_k = e_s, as two-sided inequalities with slack tol
  const A: number[][] = Array.from({ length: n }, () => new Array(rows.length).fill(0));
  rows.forEach((r, k) => {
    for (let a = 0; a < 3; a++) {
      A[3 * r.i + a][k] += r.gi[a];
      if (r.j >= 0) A[3 * r.j + a][k] += r.gj[a];
    }
    A[3 * P][k] = r.gt * dtds;
  });
  const lpRows: LpRow[] = [];
  for (let e = 0; e < n; e++) {
    const idx: number[] = [];
    const val: number[] = [];
    A[e].forEach((v, k) => {
      if (v !== 0) {
        idx.push(k);
        val.push(v);
      }
    });
    const b = e === 3 * P ? 1 : 0;
    lpRows.push({ idx, val, rhs: b - tol });
    lpRows.push({ idx, val: val.map((v) => -v), rhs: -b - tol });
  }
  const lo = new Float64Array(rows.length);
  const hi = new Float64Array(rows.length).fill(1e4);
  const minLp = solveLp(c, lpRows, lo, hi, 1e6);
  const neg = c.map((v) => -v);
  const maxLp = solveLp(neg, lpRows, lo, hi, 1e6);
  const val = (x: Float64Array) => x.reduce((s, v, k) => s + v * c[k], 0);
  return { min: val(minLp.x), max: val(maxLp.x), rows: rows.length };
}

export interface OneSided {
  left: number;
  right: number;
  sMinus: number;
  sPlus: number;
}

/** Warm-started one-sided slopes (s(K) - s(K - dK))/dK and (s(K + dK) - s(K))/dK. */
export function oneSidedSlopes(problem: CurvedProblem, K: number, config: CurvedConfig, dK = 1e-4): OneSided {
  const s0 = config.size;
  const plus = polishAt(problem, K + dK, config);
  const minus = polishAt(problem, K - dK, config);
  return {
    left: (s0 - minus.config.size) / dK,
    right: (plus.config.size - s0) / dK,
    sMinus: minus.config.size,
    sPlus: plus.config.size,
  };
}
