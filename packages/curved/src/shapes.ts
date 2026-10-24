/**
 * Unit pieces and regular containers in the plane of constant curvature K.
 *
 * Right-triangle relations (centre angle pi/n, legs: apothem a and half side b, hypotenuse R):
 *   tn_K(b) = sn_K(a) tan(pi/n)        sn_K(b) = sn_K(R) sin(pi/n)        cos(pi/n) = cs_K(b) sin(alpha/2)
 * where alpha is the interior angle. For K = 0 these are the Euclidean formulas of PROMPT.md §2.
 */
import { asnK, atnK, csK, snK, tnK, vsK } from "./kfun";

export interface PieceGeometry {
  N: number;
  K: number;
  /** circumradius (radius 1 for a disk piece) */
  R: number;
  snR: number;
  csR: number;
  /** inradius (apothem; 1 for a disk) */
  rho: number;
  snRho: number;
  csRho: number;
  /** interior angle in radians (NaN for a disk) */
  alpha: number;
  area: number;
}

/**
 * True when a unit piece of code N exists (and fits in an open hemisphere for K > 0).
 * On the sphere of radius 1/sqrt K a convex regular N-gon with circumradius R < pi/(2 sqrt K) has
 * sin(sqrt K a/2) = sin(sqrt K R) sin(pi/N), so its side a ranges over (0, 2 pi/(N sqrt K)): a unit
 * N-gon exists iff sqrt K < 2 pi/N (perimeter N below 2 pi/sqrt K). The sine condition
 * sqrt K sn_K(1/2) < sin(pi/N) alone is necessary but not sufficient (it holds again for large K).
 */
export function pieceExists(N: number, K: number): boolean {
  if (N === 0) return !(K > 0) || 1 < Math.PI / (2 * Math.sqrt(K));
  if (!(K > 0)) return true;
  return Math.sqrt(K) * N < 2 * Math.PI && Math.sqrt(K) * snK(K, 0.5) < Math.sin(Math.PI / N);
}

/** Area of a right triangle with legs a and b: tan(|K| A / 2) = |K| tn_K(a/2) tn_K(b/2). */
function rightTriangleArea(K: number, a: number, b: number): number {
  const p = tnK(K, a / 2) * tnK(K, b / 2);
  const z = Math.abs(K) * p;
  if (z < 1e-8) return 2 * p * (1 - (z * z) / 3);
  return (2 * Math.atan(z)) / Math.abs(K);
}

export function pieceGeometry(N: number, K: number): PieceGeometry {
  if (!pieceExists(N, K)) throw new RangeError(`no unit piece N=${N} at K=${K}`);
  if (N === 0) {
    return {
      N,
      K,
      R: 1,
      snR: snK(K, 1),
      csR: csK(K, 1),
      rho: 1,
      snRho: snK(K, 1),
      csRho: csK(K, 1),
      alpha: NaN,
      area: 2 * Math.PI * vsK(K, 1),
    };
  }
  const snR = snK(K, 0.5) / Math.sin(Math.PI / N);
  const R = asnK(K, snR);
  const snRho = tnK(K, 0.5) / Math.tan(Math.PI / N);
  const rho = asnK(K, snRho);
  const alpha = 2 * Math.asin(Math.cos(Math.PI / N) / csK(K, 0.5));
  return {
    N,
    K,
    R,
    snR,
    csR: csK(K, R),
    rho,
    snRho,
    csRho: csK(K, rho),
    alpha,
    area: 2 * N * rightTriangleArea(K, rho, 0.5),
  };
}

/** Largest admissible container size: Infinity except K > 0, where the container stays in an open hemisphere. */
export function maxContainerSize(M: number, K: number): number {
  if (!(K > 0)) return Infinity;
  return M === 0 ? Math.PI / (2 * Math.sqrt(K)) : (2 * Math.PI) / (M * Math.sqrt(K));
}

/** Apothem h of the ideal regular M-gon (K < 0): sn_K(h) = 1 / (sqrt(-K) tan(pi/M)). Infinity otherwise. */
export function idealApothem(M: number, K: number): number {
  if (!(K < 0) || M === 0) return Infinity;
  return asnK(K, 1 / (Math.sqrt(-K) * Math.tan(Math.PI / M)));
}

/**
 * Container "radius variable" t used internally: the apothem h for polygon containers, the radius r
 * for disk containers. Walls of a polygon container are the lines at distance h from O.
 */
export function apothemFromSide(M: number, K: number, s: number): number {
  if (M === 0) return s;
  return asnK(K, tnK(K, s / 2) / Math.tan(Math.PI / M));
}

/** Inverse of apothemFromSide; Infinity at or beyond the ideal apothem (K < 0). */
export function sideFromApothem(M: number, K: number, h: number): number {
  if (M === 0) return h;
  return 2 * atnK(K, snK(K, h) * Math.tan(Math.PI / M));
}

/** ds/dh for a polygon container (1 for a disk container). */
export function dSideDApothem(M: number, K: number, h: number): number {
  if (M === 0) return 1;
  // s = 2 atn(y), y = sn(h) tan(pi/M); d atn/dy = 1/(1 + K y^2); dy/dh = cs(h) tan(pi/M)
  const T = Math.tan(Math.PI / M);
  const y = snK(K, h) * T;
  return (2 * csK(K, h) * T) / (1 + K * y * y);
}

/** Circumradius of a regular M-gon container with side s. */
export function containerCircumradius(M: number, K: number, s: number): number {
  if (M === 0) return s;
  return asnK(K, snK(K, s / 2) / Math.sin(Math.PI / M));
}

/** Area of a regular M-gon of side s (or disk of radius s for M = 0) at curvature K. */
export function containerArea(M: number, K: number, s: number): number {
  if (M === 0) return 2 * Math.PI * vsK(K, s);
  const h = apothemFromSide(M, K, s);
  return 2 * M * rightTriangleArea(K, h, s / 2);
}

/** Outward unit normal angle of container wall k (phi = 0: wall 0 is the bottom edge). */
export function wallAngle(M: number, k: number): number {
  return -Math.PI / 2 + (2 * Math.PI * k) / M;
}

/** Outward normal angle of edge e of the standard piece (vertex 0 straight up). */
export function pieceEdgeAngle(N: number, e: number): number {
  return Math.PI / 2 + Math.PI / N + (2 * Math.PI * e) / N;
}

/** Direction of vertex k of the standard piece. */
export function pieceVertexAngle(N: number, k: number): number {
  return Math.PI / 2 + (2 * Math.PI * k) / N;
}
