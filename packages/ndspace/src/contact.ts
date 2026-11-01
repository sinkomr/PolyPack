/**
 * Contact points of two convex polytopes along a separating (or penetration) direction, for the gradient of their
 * separation with respect to the pieces' rotations.
 *
 * The signed separation of A and B along its optimal unit direction u is sep = min_B u.y - max_A u.x. Its derivative with
 * respect to anything that moves the pieces is u . (d b* - d a*) at the contact points a* and b*, not at an arbitrary
 * vertex: where the contact is an edge against an edge (the generic case of two polytopes in contact) the two vertices of
 * each edge tie along u, and the contact points are the points of the edges nearest to each other. They solve
 * "P(a - b) = 0 for a in the face F_A of A that maximises u.x, b in the face F_B of B that minimises u.y", P the projection
 * orthogonal to u: the minimum-norm point of the polytope {P(a_i - b_j)}, which GJK finds (packages/ndim closestPoints)
 * with a corral of at most d points whose convex weights give a* and b*.
 */
import { closestPoints } from "@polypack/ndim";

export interface Contact {
  /** Vertex indices of A and the convex weights (sum 1) whose combination is a*. */
  ia: number[];
  wa: number[];
  ib: number[];
  wb: number[];
}

/** Faces with more vertex pairs than this are taken at their centroids (the separation is not smooth there anyway). */
const MAX_PAIRS = 1024;
const EPS = 1e-9;

/** Solves the small dense system M x = r (Gaussian elimination, partial pivoting); null when singular. */
function solveSmall(M: number[][], r: number[]): number[] | null {
  const n = r.length;
  const A = M.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    if (!(Math.abs(A[p][c]) > 1e-300)) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const f = A[i][c] / A[c][c];
      if (f !== 0) for (let j = c; j <= n; j++) A[i][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

export function contactPoints(
  XA: Float64Array,
  XB: Float64Array,
  nV: number,
  d: number,
  u: ArrayLike<number>,
): Contact {
  let maxA = -Infinity;
  let minB = Infinity;
  const pa = new Float64Array(nV);
  const pb = new Float64Array(nV);
  for (let v = 0; v < nV; v++) {
    let sa = 0;
    let sb = 0;
    for (let c = 0; c < d; c++) {
      sa += u[c] * XA[v * d + c];
      sb += u[c] * XB[v * d + c];
    }
    pa[v] = sa;
    pb[v] = sb;
    if (sa > maxA) maxA = sa;
    if (sb < minB) minB = sb;
  }
  const FA: number[] = [];
  const FB: number[] = [];
  for (let v = 0; v < nV; v++) {
    if (pa[v] >= maxA - EPS) FA.push(v);
    if (pb[v] <= minB + EPS) FB.push(v);
  }
  const uniform = (F: number[]) => F.map(() => 1 / F.length);
  if (FA.length === 1 && FB.length === 1) return { ia: FA, wa: [1], ib: FB, wb: [1] };
  if (FA.length * FB.length > MAX_PAIRS) return { ia: FA, wa: uniform(FA), ib: FB, wb: uniform(FB) };
  // the polytope of the tangential differences P(a_i - b_j)
  const nZ = FA.length * FB.length;
  const Z = new Float64Array(nZ * d);
  const tmp = new Float64Array(d);
  let k = 0;
  for (const i of FA)
    for (const j of FB) {
      let dp = 0;
      for (let c = 0; c < d; c++) {
        tmp[c] = XA[i * d + c] - XB[j * d + c];
        dp += tmp[c] * u[c];
      }
      for (let c = 0; c < d; c++) Z[k * d + c] = tmp[c] - dp * u[c];
      k++;
    }
  const res = closestPoints(Z, nZ, new Float64Array(d), 1, d);
  const corral = res.corral;
  // convex weights of the minimum-norm point of the corral's affine hull
  const m = corral.length;
  let lam: number[] = [1];
  if (m > 1) {
    const M: number[][] = [];
    for (let i = 0; i < m; i++) {
      const row: number[] = [];
      for (let j = 0; j < m; j++) {
        let g = 0;
        for (let c = 0; c < d; c++) g += corral[i][c] * corral[j][c];
        row.push(g);
      }
      row.push(1);
      M.push(row);
    }
    M.push([...new Array(m).fill(1), 0]);
    const sol = solveSmall(M, [...new Array(m).fill(0), 1]);
    if (sol) {
      lam = sol.slice(0, m).map((v) => Math.max(0, v));
      const tot = lam.reduce((s, v) => s + v, 0);
      lam = tot > 0 ? lam.map((v) => v / tot) : new Array(m).fill(1 / m);
    } else lam = new Array(m).fill(1 / m);
  }
  const ia: number[] = [];
  const wa: number[] = [];
  const ib: number[] = [];
  const wb: number[] = [];
  for (let q = 0; q < m; q++) {
    // the corral point is an exact copy of one row of Z
    let at = -1;
    for (let r = 0; r < nZ && at < 0; r++) {
      let same = true;
      for (let c = 0; c < d && same; c++) same = Z[r * d + c] === corral[q][c];
      if (same) at = r;
    }
    if (at < 0 || !(lam[q] > 0)) continue;
    ia.push(FA[Math.floor(at / FB.length)]);
    ib.push(FB[at % FB.length]);
    wa.push(lam[q]);
    wb.push(lam[q]);
  }
  if (!ia.length) return { ia: FA, wa: uniform(FA), ib: FB, wb: uniform(FB) };
  return { ia, wa, ib, wb };
}
