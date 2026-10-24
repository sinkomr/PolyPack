/**
 * Chart-free float validator for whole-sphere packings.
 *
 * Pairs are NOT confined to one hemisphere, so no gnomonic/Klein chart is used. A convex spherical
 * polygon in an open hemisphere is S^2 intersected with the convex cone over its vertices; two such
 * pointed cones have disjoint interiors iff some plane through 0 weakly separates them. The
 * max-margin value
 *     m(A, B) = max over unit n of min( min_k n.a_k, min_l -n.b_l )
 * is the cosine of the radius of the smallest cap containing S = {a_k} u {-b_l}: m > 0 strictly
 * separated, m = 0 touching, m < 0 overlapping interiors. At the optimum at least two points of S
 * are active, so n is +-(p + q)/|p + q| for two points or +- the normal of the plane through three
 * points; a brute force over these candidates is exact (no candidate is missed).
 * Gaps are reported in length units on the sphere of radius rho: rho asin(m) for polygons (distance
 * from the separating great circle to the nearest vertex), rho (angle(c_i, c_j) - 2/rho) for disks.
 *
 * Not authoritative: this is a float check. Near the existence limit rho = N/(2 pi) the circumradius
 * R = asin(sin(a/2)/sin(pi/N)) approaches pi/2 and its float error grows like 1e-16/(pi/2 - R), so
 * strictlyValid can be wrong for |gap| below about 1e-11 there (the independent review found such
 * cases within 5e-8 relative of the limit). python/sphere/certify.py decides validity.
 */
import {
  type SphereConfig,
  type SphereProblem,
  type Vec3,
  centreOf,
  circumradiusAngle,
  cross,
  dot,
  norm,
  pieceExists,
  placedVertices,
} from "./geometry";

export interface MaxMargin {
  value: number;
  normal: Vec3;
}

export function maxMarginPlane(A: Vec3[], B: Vec3[]): MaxMargin {
  const S: Vec3[] = [...A, ...B.map((b) => [-b[0], -b[1], -b[2]] as Vec3)];
  const m = S.length;
  let best = -Infinity;
  let bestN: Vec3 = [0, 0, 1];
  const consider = (v: Vec3) => {
    const nv = norm(v);
    if (!(nv > 1e-12)) return;
    const n: Vec3 = [v[0] / nv, v[1] / nv, v[2] / nv];
    let lo = Infinity;
    for (const s of S) lo = Math.min(lo, dot(n, s));
    if (lo > best) {
      best = lo;
      bestN = n;
    }
  };
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      consider([S[i][0] + S[j][0], S[i][1] + S[j][1], S[i][2] + S[j][2]]);
      for (let k = j + 1; k < m; k++) {
        const u: Vec3 = [S[j][0] - S[i][0], S[j][1] - S[i][1], S[j][2] - S[i][2]];
        const w: Vec3 = [S[k][0] - S[i][0], S[k][1] - S[i][1], S[k][2] - S[i][2]];
        const c = cross(u, w);
        consider(c);
        consider([-c[0], -c[1], -c[2]]);
      }
    }
  }
  return { value: best, normal: bestN };
}

export interface PairGap {
  i: number;
  j: number;
  /** gap in length units on the sphere of radius rho (negative = overlap) */
  gap: number;
  kind: "far" | "plane" | "disk";
  normal?: Vec3;
}

export interface ValidationResult {
  valid: boolean;
  strictlyValid: boolean;
  minGap: number;
  worstPair: [number, number] | null;
  pairs: PairGap[];
  errors: string[];
}

/** Gaps of all pairs; far pairs (circumscribed caps disjoint) are reported with kind "far". */
export function pairGaps(problem: SphereProblem, config: SphereConfig): PairGap[] {
  const { N } = problem;
  const rho = config.rho;
  const P = config.pieces.length;
  const C = config.pieces.map((p) => centreOf(p.q));
  const out: PairGap[] = [];
  if (N === 0) {
    const a = 1 / rho;
    for (let i = 0; i < P; i++)
      for (let j = i + 1; j < P; j++) {
        const ang = Math.acos(Math.max(-1, Math.min(1, dot(C[i], C[j]))));
        out.push({ i, j, gap: rho * (ang - 2 * a), kind: "disk" });
      }
    return out;
  }
  const R = circumradiusAngle(N, rho);
  const X = config.pieces.map((p) => placedVertices(N, rho, p.q));
  for (let i = 0; i < P; i++)
    for (let j = i + 1; j < P; j++) {
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(C[i], C[j]))));
      if (ang > 2 * R + 1e-9) {
        out.push({ i, j, gap: rho * (ang - 2 * R), kind: "far" });
        continue;
      }
      const mm = maxMarginPlane(X[i], X[j]);
      out.push({ i, j, gap: rho * Math.asin(Math.max(-1, Math.min(1, mm.value))), kind: "plane", normal: mm.normal });
    }
  return out;
}

export function validate(problem: SphereProblem, config: SphereConfig, opts: { tol?: number } = {}): ValidationResult {
  const tol = opts.tol ?? 1e-9;
  const errors: string[] = [];
  const { N, P } = problem;
  if (![0, 3, 4, 5, 6, 8].includes(N)) errors.push("N must be one of 0, 3, 4, 5, 6, 8");
  if (!Number.isInteger(P) || P < 1) errors.push("P must be a positive integer");
  if (!config || !Array.isArray(config.pieces) || config.pieces.length !== P) errors.push("number of pieces differs from P");
  if (!(config?.rho > 0) || !Number.isFinite(config?.rho)) errors.push("rho must be positive and finite");
  else if (!pieceExists(N, config.rho)) errors.push("piece does not exist at this rho (needs rho > N/(2 pi))");
  for (const [k, p] of (config?.pieces ?? []).entries()) {
    if (!Array.isArray(p?.q) || p.q.length !== 4 || !p.q.every((c) => Number.isFinite(c))) errors.push(`piece ${k}: q must be 4 finite numbers`);
    else if (Math.hypot(...p.q) === 0) errors.push(`piece ${k}: zero quaternion`);
  }
  if (N === 0 && P >= 2 && config?.rho > 0 && 1 / config.rho > Math.PI / 2) errors.push("disks larger than a hemisphere cannot both fit");
  if (errors.length) return { valid: false, strictlyValid: false, minGap: -Infinity, worstPair: null, pairs: [], errors };
  const pairs = pairGaps(problem, config);
  let minGap = Infinity;
  let worst: [number, number] | null = null;
  for (const g of pairs)
    if (g.gap < minGap) {
      minGap = g.gap;
      worst = [g.i, g.j];
    }
  return { valid: minGap >= -tol, strictlyValid: minGap > 0, minGap, worstPair: worst, pairs, errors };
}
