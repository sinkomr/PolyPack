/**
 * Lattices of flat tori R^2 / Lambda, Lambda = Z b1 + Z b2.
 *
 * Families (docs/spaces/TORUS.md):
 *   sq    b1 = L (1, 0), b2 = L (0, 1)              score L
 *   hex   b1 = L (1, 0), b2 = L (1/2, sqrt(3)/2)    score L
 *   free  any basis                                  score sqrt(|det(b1, b2)|)
 */

export type TorusFamily = "sq" | "hex" | "free";
export const TORUS_FAMILIES: readonly TorusFamily[] = ["sq", "hex", "free"];

/** Largest P of a torus problem (the domain, the server and the search). */
export const TORUS_MAX_P = 500;

/**
 * Radius of a disk piece (N = 0) in site units: disks have diameter 1 (the unit change of
 * 2026-10-27; they had radius 1). The same number as DISK_RADIUS of @polypack/geometry.
 * disk.ts says how the search keeps its radius-1 tuning in working units.
 */
export const TORUS_DISK_RADIUS = 0.5;

export type Vec2 = readonly [number, number];

export interface Lattice {
  b1: Vec2;
  b2: Vec2;
}

/** Description stored in records: {L} for sq/hex, {b1, b2} for free. */
export type LatticeSpec = { L: number } | { b1: Vec2; b2: Vec2 };

export const SQRT3_2 = Math.sqrt(3) / 2;

export function familyLattice(family: "sq" | "hex", L: number): Lattice {
  return family === "sq"
    ? { b1: [L, 0], b2: [0, L] }
    : { b1: [L, 0], b2: [L / 2, L * SQRT3_2] };
}

export function latticeFromSpec(family: TorusFamily, spec: LatticeSpec): Lattice {
  if (family === "free") {
    if (!("b1" in spec)) throw new Error("free lattice needs b1 and b2");
    return { b1: [spec.b1[0], spec.b1[1]], b2: [spec.b2[0], spec.b2[1]] };
  }
  if (!("L" in spec)) throw new Error(`${family} lattice needs L`);
  return familyLattice(family, spec.L);
}

export function det(l: Lattice): number {
  return l.b1[0] * l.b2[1] - l.b1[1] * l.b2[0];
}

export function cellArea(l: Lattice): number {
  return Math.abs(det(l));
}

/** Score of a torus: side L for sq/hex (|b1|), sqrt(cell area) for free. */
export function torusScore(family: TorusFamily, l: Lattice): number {
  return family === "free" ? Math.sqrt(cellArea(l)) : Math.hypot(l.b1[0], l.b1[1]);
}

/** Integer change of basis: reduced = basis * M, M = [[m11, m12], [m21, m22]] (columns). */
export type Unimodular = readonly [readonly [number, number], readonly [number, number]];

/**
 * Lagrange-Gauss reduction: returns a basis of the same lattice with
 * |b1| <= |b2| and |b1 . b2| <= |b1|^2 / 2 (so the angle between them is in
 * [60, 120] degrees and b1 is a shortest nonzero vector).
 */
export function gaussReduce(l: Lattice): { lattice: Lattice; M: Unimodular } {
  let u: [number, number] = [l.b1[0], l.b1[1]];
  let v: [number, number] = [l.b2[0], l.b2[1]];
  // columns of M express u and v in the original basis
  let mu: [number, number] = [1, 0];
  let mv: [number, number] = [0, 1];
  const n2 = (a: readonly number[]) => a[0] * a[0] + a[1] * a[1];
  if (n2(v) < n2(u)) {
    [u, v] = [v, u];
    [mu, mv] = [mv, mu];
  }
  for (let iter = 0; iter < 10000; iter++) {
    const k = Math.round((u[0] * v[0] + u[1] * v[1]) / n2(u));
    if (k === 0) break;
    v = [v[0] - k * u[0], v[1] - k * u[1]];
    mv = [mv[0] - k * mu[0], mv[1] - k * mu[1]];
    if (n2(v) >= n2(u)) break;
    [u, v] = [v, u];
    [mu, mv] = [mv, mu];
  }
  return { lattice: { b1: u, b2: v }, M: [[mu[0], mv[0]], [mu[1], mv[1]]] };
}

/**
 * Coordinates (alpha, beta) of a vector w in the basis: w = alpha b1 + beta b2.
 */
export function latticeCoordinates(l: Lattice, w: Vec2): [number, number] {
  const D = det(l);
  return [(w[0] * l.b2[1] - w[1] * l.b2[0]) / D, (l.b1[0] * w[1] - l.b1[1] * w[0]) / D];
}

/**
 * Enumeration window (docs/spaces/TORUS.md, "Which lattice vectors matter").
 * If v = alpha b1 + beta b2 then, by Cramer's rule, |alpha| = |v x b2| / |det| <= |v| |b2| / |det|
 * and |beta| = |b1 x v| / |det| <= |v| |b1| / |det|. Every v with |v| < reach therefore has
 * |alpha| < X1 = reach |b2| / |det| and |beta| < X2 = reach |b1| / |det|. The bound holds for any
 * basis; a reduced basis only keeps the window small.
 */
export function imageWindow(l: Lattice, reach: number): { X1: number; X2: number } {
  const A = cellArea(l);
  return { X1: (reach * Math.hypot(l.b2[0], l.b2[1])) / A, X2: (reach * Math.hypot(l.b1[0], l.b1[1])) / A };
}

export interface Image {
  m: number;
  n: number;
  /** d + m b1 + n b2 */
  v: [number, number];
}

/** Hard cap on enumerated candidates; a nearly degenerate basis throws instead of hanging. */
export const MAX_IMAGE_CANDIDATES = 1_000_000;

/** The integer ranges of m and n that latticeImages loops over for a displacement d (one extra on each side). */
export function imageRanges(l: Lattice, d: Vec2, reach: number) {
  const { X1, X2 } = imageWindow(l, reach);
  const [a0, b0] = latticeCoordinates(l, d);
  if (!Number.isFinite(X1) || !Number.isFinite(X2) || !Number.isFinite(a0) || !Number.isFinite(b0)) {
    throw new Error("degenerate lattice or non-finite displacement");
  }
  return {
    mLo: Math.floor(-a0 - X1) - 1,
    mHi: Math.ceil(-a0 + X1) + 1,
    nLo: Math.floor(-b0 - X2) - 1,
    nHi: Math.ceil(-b0 + X2) + 1,
  };
}

/** Candidates (m, n) that latticeImages loops over for a displacement d. */
export function imageCandidates(l: Lattice, d: Vec2, reach: number): number {
  const { mLo, mHi, nLo, nHi } = imageRanges(l, d, reach);
  return (mHi - mLo + 1) * (nHi - nLo + 1);
}

/**
 * The most candidates latticeImages loops over for any displacement: per axis ceil(x + X) - floor(x - X) + 3 is
 * at most ceil(2 X) + 4, so (ceil(2 X1) + 4)(ceil(2 X2) + 4). This is what the server's limit counts.
 */
export function maxImageCandidates(l: Lattice, reach: number): number {
  const { X1, X2 } = imageWindow(l, reach);
  return (Math.ceil(2 * X1) + 4) * (Math.ceil(2 * X2) + 4);
}

/**
 * All lattice translates v = d + m b1 + n b2 with |v| < reach, by the Cramer window above
 * (one extra integer on each side of the window guards against rounding). With
 * `halfPlane`, only (m, n) with m > 0 or (m = 0 and n > 0) are returned: for a piece and its
 * own images, lambda and -lambda describe the same pair.
 */
export function latticeImages(l: Lattice, d: Vec2, reach: number, halfPlane = false): Image[] {
  const { mLo, mHi, nLo, nHi } = imageRanges(l, d, reach);
  if ((mHi - mLo + 1) * (nHi - nLo + 1) > MAX_IMAGE_CANDIDATES) {
    throw new Error("lattice image enumeration too large (nearly degenerate basis)");
  }
  const out: Image[] = [];
  const r2 = reach * reach;
  for (let m = mLo; m <= mHi; m++) {
    for (let n = nLo; n <= nHi; n++) {
      if (halfPlane && !(m > 0 || (m === 0 && n > 0))) continue;
      const vx = d[0] + m * l.b1[0] + n * l.b2[0];
      const vy = d[1] + m * l.b1[1] + n * l.b2[1];
      if (vx * vx + vy * vy < r2) out.push({ m, n, v: [vx, vy] });
    }
  }
  return out;
}
