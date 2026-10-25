/**
 * The floating-point validator of the polyhedra space, as a server runs it on untrusted input.
 *
 * A configuration { s, pieces } of a problem (piece solid P, container solid C) is valid at tolerance
 * tol when
 *  - containment: every vertex x of every piece satisfies N_f . x <= s b_f + tol for every face f of
 *    the container s C (unit outward normals N_f, offsets b_f of the canonical C, centred at the origin);
 *  - disjointness: no two pieces overlap by more than tol, i.e. some candidate axis of the separating-
 *    axis test (geom.ts) shows a gap of at least -tol. The candidates contain every face normal of the
 *    Minkowski difference, so this decides "penetration depth <= tol" exactly (up to float rounding).
 * Pieces may touch. Distances are in the units of the canonical solids (edge 1 for most solids).
 *
 * Work: pairs whose centres are farther apart than twice the piece's circumradius (plus tol) are
 * disjoint and skipped; the others get one separating-axis test each, which stops at the first axis
 * with a gap of at least `stopAt` (default 1e-3: such a pair is valid whatever tol is). The check
 * ends after maxErrors errors. Both bound the time of one check (measured in test/validate.test.ts).
 */
import { type Placed, type Pose, place, separation, wallGap } from "./geom";
import { getSolid } from "./solids";
import type { PolyhedraProblem } from "./problems";

/** PolyPack's touching tolerance. */
export const POLYHEDRA_TOL = 1e-9;
/** Smallest accepted norm of a pose's quaternion. */
export const POLYHEDRA_MIN_QUATERNION_NORM = 1e-6;
/** Largest absolute value of a centre coordinate. */
export const POLYHEDRA_MAX_COORD = 1e4;
/**
 * Largest absolute value of a quaternion component. Only the direction of q matters (the rotation is
 * H(q) / |q|^2), and exact rational rotations are stored with large integer quaternions (some records use
 * components near 5e48), so the bound only keeps |q|^2 far from overflow.
 */
export const POLYHEDRA_MAX_QUATERNION = 1e100;
/** Largest container scale accepted. */
export const POLYHEDRA_MAX_SIZE = 1e6;

export interface PolyhedraConfig {
  /** Container scale: the container is s times the canonical container solid, centred at the origin. */
  s: number;
  /** One pose [x, y, z, qw, qx, qy, qz] per piece. */
  pieces: Pose[];
}

export interface ValidateOptions {
  tol?: number;
  /** Errors listed at most; the check ends after this many. Default 20. */
  maxErrors?: number;
  /** A pair is settled as soon as an axis shows this gap; default 1e-3. Use Infinity for exact separations. */
  stopAt?: number;
}

export interface PolyhedraValidation {
  valid: boolean;
  errors: string[];
  /** Smallest wall gap s b_f - N_f . x over all vertices and faces (negative: protrusion). */
  minWallGap: number;
  /** Smallest pair separation found (negative: overlap depth); Infinity when no pair is near. */
  minPairSep: number;
  /** The pair with the smallest separation. */
  worstPair: [number, number] | null;
  /** Pairs given a separating-axis test. */
  pairsTested: number;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Reads a configuration: s positive and at most POLYHEDRA_MAX_SIZE, each pose 7 finite numbers, the centre's at
 * most POLYHEDRA_MAX_COORD and the quaternion's at most POLYHEDRA_MAX_QUATERNION in absolute value, with a
 * quaternion norm of at least POLYHEDRA_MIN_QUATERNION_NORM. Returns the errors (empty when it is well formed).
 */
export function configErrors(config: unknown, P?: number, maxErrors = 20): string[] {
  const errors: string[] = [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) return ["config must be an object {s, pieces}"];
  const c = config as Record<string, unknown>;
  if (!isFiniteNumber(c.s) || !(c.s > 0) || c.s > POLYHEDRA_MAX_SIZE)
    errors.push(`s must be a positive finite number of at most ${POLYHEDRA_MAX_SIZE}`);
  if (!Array.isArray(c.pieces)) {
    errors.push("pieces must be an array of [x, y, z, qw, qx, qy, qz]");
    return errors;
  }
  if (P !== undefined && c.pieces.length !== P) errors.push(`expected ${P} pieces for this problem, got ${c.pieces.length}`);
  for (let i = 0; i < c.pieces.length && errors.length < maxErrors; i++) {
    const p = c.pieces[i];
    if (!Array.isArray(p) || p.length !== 7 || !p.every(isFiniteNumber)) {
      errors.push(`pieces[${i}] must be [x, y, z, qw, qx, qy, qz] of finite numbers`);
      continue;
    }
    if (p.slice(0, 3).some((v) => Math.abs(v) > POLYHEDRA_MAX_COORD))
      errors.push(`pieces[${i}]: x, y and z must be at most ${POLYHEDRA_MAX_COORD} in absolute value`);
    else if (p.slice(3).some((v) => Math.abs(v) > POLYHEDRA_MAX_QUATERNION))
      errors.push(`pieces[${i}]: quaternion components must be at most ${POLYHEDRA_MAX_QUATERNION} in absolute value`);
    else if (!(Math.hypot(p[3], p[4], p[5], p[6]) >= POLYHEDRA_MIN_QUATERNION_NORM))
      errors.push(`pieces[${i}]: the quaternion must have a norm of at least ${POLYHEDRA_MIN_QUATERNION_NORM}`);
  }
  return errors;
}

/** Checks a well-formed configuration (see configErrors) of a problem at its stated s. Never throws. */
export function validatePolyhedra(
  problem: PolyhedraProblem,
  config: PolyhedraConfig,
  opts: ValidateOptions = {},
): PolyhedraValidation {
  const tol = opts.tol ?? POLYHEDRA_TOL;
  const maxErrors = opts.maxErrors ?? 20;
  const stopAt = opts.stopAt ?? 1e-3;
  const out: PolyhedraValidation = {
    valid: false,
    errors: [],
    minWallGap: Infinity,
    minPairSep: Infinity,
    worstPair: null,
    pairsTested: 0,
  };
  const bad = configErrors(config, undefined, maxErrors);
  if (bad.length) {
    out.errors = bad;
    return out;
  }
  const P = getSolid(problem.piece);
  const C = getSolid(problem.container);
  const n = config.pieces.length;
  const s = config.s;
  const placed: Placed[] = config.pieces.map((p) => place(P, p));
  for (let i = 0; i < n && out.errors.length < maxErrors; i++) {
    const g = wallGap(C, s, placed[i].X);
    if (g < out.minWallGap) out.minWallGap = g;
    if (!(g >= -tol)) out.errors.push(`piece ${i} sticks out of the container by ${-g}`);
  }
  // pieces lie in their circumscribed balls: centres more than 2 R apart cannot overlap
  const reach = 2 * P.circumradius + tol;
  const reach2 = reach * reach;
  for (let i = 0; i < n && out.errors.length < maxErrors; i++) {
    const a = placed[i].c;
    for (let j = i + 1; j < n && out.errors.length < maxErrors; j++) {
      const b = placed[j].c;
      const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (d2 > reach2) continue;
      out.pairsTested++;
      const r = separation(placed[i], placed[j], stopAt);
      if (r.sep < out.minPairSep) {
        out.minPairSep = r.sep;
        out.worstPair = [i, j];
      }
      if (!(r.sep >= -tol)) out.errors.push(`pieces ${i} and ${j} overlap by ${-r.sep}`);
    }
  }
  out.valid = out.errors.length === 0;
  return out;
}

/**
 * The smallest container scale holding the pieces as placed (the container stays centred at the
 * origin): max over vertices and container faces of N_f . x / b_f.
 */
export function tightScale(problem: PolyhedraProblem, pieces: Pose[]): number {
  const P = getSolid(problem.piece);
  const C = getSolid(problem.container);
  let s = 0;
  for (const p of pieces) {
    const X = place(P, p).X;
    for (let f = 0; f < C.offsets.length; f++) {
      const nx = C.N[3 * f];
      const ny = C.N[3 * f + 1];
      const nz = C.N[3 * f + 2];
      for (let j = 0; j < X.length; j += 3) {
        const r = (X[j] * nx + X[j + 1] * ny + X[j + 2] * nz) / C.offsets[f];
        if (r > s) s = r;
      }
    }
  }
  return s;
}
