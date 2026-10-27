/**
 * The floating-point validator of the balls space, as a server runs it on untrusted input.
 *
 * A configuration {s, pieces} of a problem is valid at tolerance tol when
 *  - balls (radius r = BALL_RADIUS): every two centres are at least 2 r - tol apart; in a ball container every
 *    centre has |c| <= s - r + tol, in a cube container every coordinate |c_k| <= s / 2 - r + tol (the cube
 *    [-s/2, s/2]^3), in any other solid C every face has N_f . c <= s b_f - r + tol (N_f the unit outward normal and
 *    b_f the offset of face f of the canonical solid, container.ts);
 *  - Platonic solids: every vertex x of every piece has |x| <= s + tol, and no two pieces overlap by more than tol,
 *    i.e. the polyhedra space's separating-axis test (packages/polyhedra geom.ts: face normals of both pieces and
 *    the Gauss-map pruned edge cross products, which decide the penetration depth exactly up to rounding) shows a
 *    gap of at least -tol.
 * Pieces may touch. Gaps and protrusions are lengths in the pieces' units (ball radius BALL_RADIUS, solid edge 1).
 *
 * Work: P is bounded by the caller (the registry's SPACE_MAX_P, 100). Ball pairs cost a few flops each; solid
 * pairs whose centres are more than twice the circumradius apart are skipped, and the others stop at the first axis
 * with a gap of 1e-3. The check ends after maxErrors errors.
 */
import { type Pose, configErrors as polyhedraConfigErrors, getSolid, place, separation } from "@polypack/polyhedra";
import { BALL_DIAMETER, BALL_RADIUS, type BallsProblem, ballContainerRadius, ballContainerScore } from "./catalogue";
import { containerKind, containerOfProblem, sizeFor, wallGap } from "./container";

/** PolyPack's touching tolerance. */
export const BALLS_TOL = 1e-9;
/** Largest container size s accepted. */
export const BALLS_MAX_SIZE = 1e6;
/** Largest absolute value of a centre coordinate. */
export const BALLS_MAX_COORD = 1e4;

/** A ball's centre [x, y, z], or a solid's pose [x, y, z, qw, qx, qy, qz] (the polyhedra space's pose). */
export type BallsPose = number[];

export interface BallsConfig {
  /** The container's radius (ball), edge (cube) or scale (any other solid). */
  s: number;
  pieces: BallsPose[];
}

export interface BallsValidation {
  valid: boolean;
  errors: string[];
  /** Smallest gap to the container's boundary (negative: protrusion). */
  minWallGap: number;
  /**
   * Smallest gap between two near pieces (negative: overlap depth); Infinity when no pair is near (balls: centres
   * less than 2.5 radii apart; solids: centres less than twice the circumradius apart). A solid pair's test stops at the
   * first axis with a gap of 1e-3, so a gap above that is a lower bound.
   */
  minPairSep: number;
  worstPair: [number, number] | null;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The errors of a configuration's form (empty when it is well formed): s positive and at most BALLS_MAX_SIZE;
 * P pieces when P is given; a ball is [x, y, z] of finite numbers of at most BALLS_MAX_COORD; a solid is a pose of
 * 7 finite numbers as the polyhedra space reads it (centre at most 1e4, quaternion components at most 1e100, norm
 * at least 1e-6).
 */
export function ballsConfigErrors(problem: BallsProblem, config: unknown, P?: number, maxErrors = 20): string[] {
  if (problem.piece !== "ball") {
    const errors = polyhedraConfigErrors(config, P, maxErrors);
    const s = (config as { s?: unknown } | null)?.s;
    if (!errors.length && isFiniteNumber(s) && s > BALLS_MAX_SIZE)
      errors.push(`s must be a positive finite number of at most ${BALLS_MAX_SIZE}`);
    return errors;
  }
  const errors: string[] = [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) return ["config must be an object {s, pieces}"];
  const c = config as Record<string, unknown>;
  if (!isFiniteNumber(c.s) || !(c.s > 0) || c.s > BALLS_MAX_SIZE)
    errors.push(`s must be a positive finite number of at most ${BALLS_MAX_SIZE}`);
  if (!Array.isArray(c.pieces)) {
    errors.push("pieces must be an array of [x, y, z]");
    return errors;
  }
  if (P !== undefined && c.pieces.length !== P) errors.push(`expected ${P} pieces for this problem, got ${c.pieces.length}`);
  for (let i = 0; i < c.pieces.length && errors.length < maxErrors; i++) {
    const p = c.pieces[i];
    // read by index, so that a hole in a sparse array is seen
    if (!Array.isArray(p) || p.length !== 3 || ![0, 1, 2].every((k) => isFiniteNumber(p[k]))) {
      errors.push(`pieces[${i}] must be [x, y, z] of finite numbers`);
      continue;
    }
    if (p.some((v) => Math.abs(v) > BALLS_MAX_COORD))
      errors.push(`pieces[${i}]: x, y and z must be at most ${BALLS_MAX_COORD} in absolute value`);
  }
  return errors;
}

/** Checks a well-formed configuration (see ballsConfigErrors) of a problem at its stated s. Never throws. */
export function validateBalls(
  problem: BallsProblem,
  config: BallsConfig,
  opts: { tol?: number; maxErrors?: number } = {},
): BallsValidation {
  const tol = opts.tol ?? BALLS_TOL;
  const maxErrors = opts.maxErrors ?? 20;
  const out: BallsValidation = { valid: false, errors: [], minWallGap: Infinity, minPairSep: Infinity, worstPair: null };
  const bad = ballsConfigErrors(problem, config, undefined, maxErrors);
  if (bad.length) {
    out.errors = bad;
    return out;
  }
  const { s, pieces } = config;
  const n = pieces.length;
  const pair = (i: number, j: number, sep: number) => {
    if (sep < out.minPairSep) {
      out.minPairSep = sep;
      out.worstPair = [i, j];
    }
    if (!(sep >= -tol)) out.errors.push(`pieces ${i} and ${j} overlap by ${-sep}`);
  };
  const wall = (i: number, gap: number) => {
    if (gap < out.minWallGap) out.minWallGap = gap;
    if (!(gap >= -tol)) out.errors.push(`piece ${i} sticks out of the container by ${-gap}`);
  };
  if (problem.piece === "ball") {
    const kind = containerKind(problem);
    const C = containerOfProblem(problem);
    const half = s / 2 - BALL_RADIUS;
    for (let i = 0; i < n && out.errors.length < maxErrors; i++) {
      const [x, y, z] = pieces[i];
      wall(
        i,
        kind === "ball"
          ? ballContainerRadius(s) - BALL_RADIUS - Math.hypot(x, y, z)
          : kind === "cube"
            ? half - Math.max(Math.abs(x), Math.abs(y), Math.abs(z))
            : wallGap(C!, s, BALL_RADIUS, x, y, z),
      );
    }
    // pairs 0.25 diameters or more beyond contact are valid at any tolerance and are not near
    const near2 = (BALL_DIAMETER * 1.25) ** 2;
    for (let i = 0; i < n && out.errors.length < maxErrors; i++) {
      const a = pieces[i];
      for (let j = i + 1; j < n && out.errors.length < maxErrors; j++) {
        const b = pieces[j];
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        const dz = a[2] - b[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= near2) continue;
        pair(i, j, Math.sqrt(d2) - BALL_DIAMETER);
      }
    }
  } else {
    const S = getSolid(problem.piece);
    const placed = pieces.map((p) => place(S, p as Pose));
    for (let i = 0; i < n && out.errors.length < maxErrors; i++) {
      const X = placed[i].X;
      let far = 0;
      for (let k = 0; k < X.length; k += 3) far = Math.max(far, Math.hypot(X[k], X[k + 1], X[k + 2]));
      wall(i, ballContainerRadius(s) - far);
    }
    // pieces lie in their circumscribed balls: centres more than 2 R apart cannot overlap
    const reach = 2 * S.circumradius + tol;
    for (let i = 0; i < n && out.errors.length < maxErrors; i++) {
      const a = placed[i].c;
      for (let j = i + 1; j < n && out.errors.length < maxErrors; j++) {
        const b = placed[j].c;
        if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 > reach * reach) continue;
        pair(i, j, separation(placed[i], placed[j], 1e-3).sep);
      }
    }
  }
  out.valid = out.errors.length === 0;
  return out;
}

/**
 * The smallest container size holding the pieces as placed (the container stays centred at the origin): for balls
 * max |c| + r (ball), 2 max |c_k| + 2 r (cube) or the largest over centres and faces of (N_f . c + r) / b_f (any
 * other solid); for solids the largest vertex distance from the origin.
 */
export function tightSize(problem: BallsProblem, pieces: BallsPose[]): number {
  let s = 0;
  if (problem.piece === "ball") {
    const kind = containerKind(problem);
    const C = containerOfProblem(problem);
    for (const [x, y, z] of pieces)
      s = Math.max(
        s,
        kind === "ball"
          ? ballContainerScore(Math.hypot(x, y, z) + BALL_RADIUS)
          : kind === "cube"
            ? 2 * Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) + 2 * BALL_RADIUS
            : sizeFor(C!, BALL_RADIUS, x, y, z),
      );
    return s;
  }
  const S = getSolid(problem.piece);
  for (const p of pieces) {
    const X = place(S, p as Pose).X;
    for (let k = 0; k < X.length; k += 3) s = Math.max(s, Math.hypot(X[k], X[k + 1], X[k + 2]));
  }
  return ballContainerScore(s);
}
