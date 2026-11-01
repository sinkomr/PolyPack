/**
 * The floating-point validator of the nD spaces, as a server runs it on untrusted input.
 *
 * A configuration { s, pieces } of a problem (piece X, container C, both polytopes of the catalogue or balls) is valid at
 * tolerance tol when
 *  - containment: every piece lies in the container s C (centred at the origin) up to tol: every vertex x of a polytope
 *    piece satisfies N_f . x <= s b_f + tol for every facet f of a polytope container (unit normals), or |x| <= s/2 + tol
 *    in a ball container; a ball piece (centre c, radius 1/2) satisfies N_f . c + 1/2 <= s b_f + tol, or |c| + 1/2 <= s/2 + tol;
 *  - disjointness: no two pieces overlap by more than tol, i.e. the signed separation of their hulls (gjk.ts) is at least
 *    -tol; two balls are checked by their centres' distance.
 * Pieces may touch. Lengths are in the catalogue's units: the edge of a polytope piece is 1, a ball piece has diameter 1.
 *
 * A pair is accepted only with a certificate: a unit direction u whose gap min_B u.y - max_A u.x is at least -tol (the
 * gap of any unit vector is a lower bound of the separation). The certificate comes from the cheap candidate directions
 * (the line between the centres, and the facet normals of each piece that face the other most), else from GJK / EPA,
 * else from the max-margin LP (margin.ts). A pair is refused when the separation is proved below -tol, and also when
 * neither is proved: the validator fails closed.
 *
 * Work: the size of the configuration is capped before anything is done (limits.ts); pairs are found by a sweep over the
 * centres and skipped when their centres are farther apart than the sum of the circumradii (plus tol); vertices are placed
 * only for pieces that need them; a piece far from a wall skips the facet test. The check ends after maxErrors errors,
 * and after maxPairErrors (3) refused pairs, since a refused pair costs an EPA or LP run.
 */
import { dot } from "./linalg";
import { ballFacetGap, ballInBallGap, ballPairGap } from "./ball";
import { gapAlong, signedSeparation } from "./gjk";
import { sizeErrors, type NdLimits } from "./limits";
import { BALL, BALL_RADIUS, type NdConfig, type NdProblem, problemErrors, shapePolytope } from "./problem";
import { MAX_SIZE, readPose, placeVertices, type ReadPose } from "./pose";
import type { Polytope } from "./polytope";

/** PolyPack's touching tolerance (the polyhedra space's too). */
export const NDIM_TOL = 1e-9;

export interface ValidateOptions {
  tol?: number;
  /** Errors listed at most; the check ends after this many. Default 20. */
  maxErrors?: number;
  /** Refused pairs listed at most (each costs an EPA or LP run); the check ends after this many. Default 3. */
  maxPairErrors?: number;
  /** Limits on the size of the configuration, replacing the defaults of limits.ts (never above the hard ceilings). Trusted callers only. */
  limits?: Partial<NdLimits>;
  /** A time in the clock of performance.now() after which the check stops, invalid, with a reason (checked between pieces and pairs). */
  deadline?: number;
}

export interface NdValidation {
  valid: boolean;
  /** The container scale s when valid, else null. */
  score: number | null;
  reasons: string[];
  /**
   * Smallest wall gap over all pieces (negative: protrusion); Infinity for an empty check. A piece far from a wall
   * contributes a lower bound of its gap (the wall prefilter), so this is exact for the pieces that matter (any
   * protrusion, any gap below the pieces' reach) and never above the true smallest gap.
   */
  minWallGap: number;
  /** Smallest pair separation found (a lower bound of the true separation; negative: overlap depth); Infinity when no pair is near. */
  minPairSep: number;
  worstPair: [number, number] | null;
  /** Pairs given more than the quick centre-line test. */
  pairsTested: number;
}

/**
 * The errors of a configuration for a problem whose polytopes are loaded (empty when it is well formed and within the
 * size limits of limits.ts, which are checked first).
 */
export function configErrors(
  problem: NdProblem,
  config: unknown,
  maxErrors = 20,
  limits?: Partial<NdLimits>,
): string[] {
  const bad = problemErrors(problem);
  if (bad.length) return bad;
  if (typeof config !== "object" || config === null || Array.isArray(config))
    return ["config must be an object {s, pieces}"];
  const c = config as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof c.s !== "number" || !Number.isFinite(c.s) || !(c.s > 0) || c.s > MAX_SIZE)
    errors.push(`s must be a positive finite number of at most ${MAX_SIZE}`);
  if (!Array.isArray(c.pieces) || c.pieces.length === 0) {
    errors.push("pieces must be a nonempty array of poses");
    return errors;
  }
  const big = sizeErrors(problem, c.pieces.length, limits);
  if (big.length) return [...errors, ...big];
  const ball = problem.piece === BALL;
  for (let i = 0; i < c.pieces.length && errors.length < maxErrors; i++) {
    const r = readPose(problem.d, c.pieces[i], ball);
    if (typeof r === "string") errors.push(`pieces[${i}] ${r}`);
  }
  return errors;
}

interface Placed {
  t: Float64Array;
  R: Float64Array | null;
  /** World vertices (polytope pieces), placed on first use. */
  X: Float64Array | null;
}

const norm = (v: ArrayLike<number>, d: number): number => Math.sqrt(dot(v, v, d));

/** The world vertices of a placed piece, placing them on first use. */
function vertices(P: Polytope, pc: Placed, d: number): Float64Array {
  if (!pc.X) pc.X = placeVertices(P.V, P.nV, d, pc.t, pc.R as Float64Array);
  return pc.X;
}

/** Checks a configuration of a problem at its stated s. Never throws on bad input: the reasons say what is wrong. */
export function validateNd(problem: NdProblem, config: NdConfig, opts: ValidateOptions = {}): NdValidation {
  const steps = ndCheck(problem, config, opts);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Pairs without a heavy test between two turns of validateNdAsync's generator. */
const QUICK_PAIRS_PER_STEP = 64;

/**
 * validateNd for a server: the same check, giving the event loop a turn (setTimeout 0) whenever a slice of work reaches
 * `sliceMs` (default 20 ms); with `timeoutMs` the check stops, invalid with a reason, when that much time has passed.
 * The slices are between pieces and pairs; one EPA or LP run is not interrupted (it is bounded: see gjk.ts, margin.ts).
 * `workMs` is the time the check took without the turns.
 */
export async function validateNdAsync(
  problem: NdProblem,
  config: NdConfig,
  opts: ValidateOptions & { sliceMs?: number; timeoutMs?: number } = {},
): Promise<NdValidation & { workMs: number; slices: number; longestSliceMs: number }> {
  const sliceMs = opts.sliceMs ?? 20;
  const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  await turn();
  const start = performance.now();
  const deadline =
    opts.timeoutMs === undefined ? opts.deadline : Math.min(opts.deadline ?? Infinity, start + opts.timeoutMs);
  const steps = ndCheck(problem, config, { ...opts, deadline });
  let workMs = 0;
  let slices = 1;
  let longestSliceMs = 0;
  let t = performance.now();
  for (;;) {
    const r = steps.next();
    const now = performance.now();
    if (r.done) {
      workMs += now - t;
      longestSliceMs = Math.max(longestSliceMs, now - t);
      return { ...r.value, workMs, slices, longestSliceMs };
    }
    if (now - t >= sliceMs) {
      workMs += now - t;
      longestSliceMs = Math.max(longestSliceMs, now - t);
      slices++;
      await turn();
      t = performance.now();
    }
  }
}

/** The check as steps: a generator that yields between pieces and pairs, and returns the result. */
export function* ndCheck(
  problem: NdProblem,
  config: NdConfig,
  opts: ValidateOptions = {},
): Generator<void, NdValidation> {
  const tol = opts.tol ?? NDIM_TOL;
  const maxErrors = opts.maxErrors ?? 20;
  const maxPairErrors = opts.maxPairErrors ?? 3;
  const deadline = opts.deadline ?? Infinity;
  const out: NdValidation = {
    valid: false,
    score: null,
    reasons: [],
    minWallGap: Infinity,
    minPairSep: Infinity,
    worstPair: null,
    pairsTested: 0,
  };
  const bad = configErrors(problem, config, maxErrors, opts.limits);
  if (bad.length) {
    out.reasons = bad;
    return out;
  }
  const d = problem.d;
  const s = config.s;
  const P = shapePolytope(problem.piece);
  const C = shapePolytope(problem.container);
  const n = config.pieces.length;
  const placed: Placed[] = [];
  for (let i = 0; i < n; i++) {
    const r = readPose(d, config.pieces[i], P === null) as ReadPose;
    placed.push({ t: r.t, R: r.R, X: null });
  }
  const timedOut = (): boolean => {
    if (performance.now() <= deadline) return false;
    out.reasons.push("the time budget of the check ran out before it finished");
    return true;
  };
  // ---- containment
  for (let i = 0; i < n && out.reasons.length < maxErrors; i++) {
    const g = wallGap(P, C, s, placed[i], d, false);
    if (g < out.minWallGap) out.minWallGap = g;
    if (!(g >= -tol)) out.reasons.push(`piece ${i} sticks out of the container by ${-g}`);
    yield;
    if (timedOut()) return out;
  }
  // ---- disjointness: a sweep along the coordinate of the largest spread finds the pairs within reach
  const rP = P ? P.circumradius : BALL_RADIUS;
  const reach = 2 * rP + tol;
  const reach2 = reach * reach;
  let axis = 0;
  let spread = -1;
  for (let c = 0; c < d; c++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const pc of placed) {
      lo = Math.min(lo, pc.t[c]);
      hi = Math.max(hi, pc.t[c]);
    }
    if (hi - lo > spread) {
      spread = hi - lo;
      axis = c;
    }
  }
  const order = placed.map((_, i) => i).sort((x, y) => placed[x].t[axis] - placed[y].t[axis] || x - y);
  const u = new Float64Array(d);
  let pairErrors = 0;
  let quick = 0;
  for (let ia = 0; ia < n; ia++) {
    const i0 = order[ia];
    for (let ib = ia + 1; ib < n; ib++) {
      const j0 = order[ib];
      if (placed[j0].t[axis] - placed[i0].t[axis] > reach) break;
      if (out.reasons.length >= maxErrors || pairErrors >= maxPairErrors) {
        out.valid = false;
        return out;
      }
      const i = Math.min(i0, j0);
      const j = Math.max(i0, j0);
      let d2 = 0;
      for (let c = 0; c < d; c++) {
        const e = placed[i].t[c] - placed[j].t[c];
        d2 += e * e;
      }
      if (d2 > reach2) continue;
      let sep: number;
      let refused = false;
      let heavy = false;
      if (!P) {
        sep = ballPairGap(placed[i].t, BALL_RADIUS, placed[j].t, BALL_RADIUS, d); // two balls
        out.pairsTested++;
        refused = !(sep >= -tol);
        if (refused) out.reasons.push(`pieces ${i} and ${j} overlap by ${-sep}`);
      } else {
        const A = vertices(P, placed[i], d);
        const B = vertices(P, placed[j], d);
        sep = quickGap(P, placed[i], placed[j], d, Math.sqrt(d2), u, A, B);
        if (!(sep >= -tol)) {
          out.pairsTested++;
          heavy = true;
          const r = signedSeparation(A, P.nV, B, P.nV, d, { tol });
          sep = r.converged ? r.sep : Number.isFinite(r.lower) ? r.lower : r.upper;
          if (!(r.lower >= -tol)) {
            refused = true;
            if (r.upper < -tol)
              out.reasons.push(`pieces ${i} and ${j} overlap by ${r.converged ? -r.sep : `at least ${-r.upper}`}`);
            else
              out.reasons.push(
                `pieces ${i} and ${j} could not be shown to be separated within the tolerance (their separation lies in [${r.lower}, ${r.upper}])`,
              );
          }
        }
      }
      if (sep < out.minPairSep) {
        out.minPairSep = sep;
        out.worstPair = [i, j];
      }
      if (refused) pairErrors++;
      if (refused || heavy || ++quick % QUICK_PAIRS_PER_STEP === 0) {
        yield;
        if (timedOut()) return out;
      }
    }
  }
  out.valid = out.reasons.length === 0;
  out.score = out.valid ? s : null;
  return out;
}

/**
 * Gap of a piece to the walls: s b_f - max N_f . x over the piece and the container's facets (polytope container), or
 * s/2 minus the farthest point (ball container); positive: inside, negative: protrusion.
 *
 * With exact = false the walls and facets that the piece's circumscribed ball (radius R about its centre t) cannot
 * reach are skipped, each contributing the lower bound of its gap from the ball: s b_f - N_f . t - R, or s/2 - |t| - R.
 */
function wallGap(P: Polytope | null, C: Polytope | null, s: number, pc: Placed, d: number, exact = true): number {
  const R = P ? P.circumradius : BALL_RADIUS;
  if (C === null) {
    const room = s / 2;
    if (P === null) return ballInBallGap(pc.t, BALL_RADIUS, room, d);
    const tn = norm(pc.t, d);
    if (!exact && tn + R <= room) return room - tn - R;
    let far = 0;
    const X = vertices(P, pc, d);
    for (let v = 0; v < P.nV; v++) far = Math.max(far, norm(X.subarray(v * d, v * d + d), d));
    return room - far;
  }
  let gap = Infinity;
  if (!exact && P && norm(pc.t, d) + R <= s * C.inradius) return s * C.inradius - norm(pc.t, d) - R;
  for (let f = 0; f < C.nF; f++) {
    if (P === null) {
      gap = Math.min(gap, ballFacetGap(pc.t, BALL_RADIUS, C, f, s));
      continue;
    }
    if (!exact) {
      const bound = s * C.b[f] - dot(C.N, pc.t, d, f * d, 0) - R;
      if (bound > 0) {
        gap = Math.min(gap, bound);
        continue;
      }
    }
    const X = vertices(P, pc, d);
    let top = -Infinity;
    for (let v = 0; v < P.nV; v++) top = Math.max(top, dot(C.N, X, d, f * d, v * d));
    gap = Math.min(gap, s * C.b[f] - top);
  }
  return gap;
}

/**
 * A lower bound of the separation of two placed polytope pieces from a few directions: the line between the centres
 * and the two facet normals of each piece that face the other most.
 */
function quickGap(
  P: Polytope,
  a: Placed,
  b: Placed,
  d: number,
  dist: number,
  u: Float64Array,
  A: Float64Array,
  B: Float64Array,
): number {
  let best = -Infinity;
  if (dist > 0) {
    for (let c = 0; c < d; c++) u[c] = (b.t[c] - a.t[c]) / dist;
    best = gapAlong(A, P.nV, B, P.nV, d, u);
    if (best >= 1e-3) return best;
  } else u.fill(0);
  const w = new Float64Array(d);
  const lu = new Float64Array(d);
  for (const [me, sgn] of [
    [a, 1],
    [b, -1],
  ] as const) {
    // the two facets of `me` whose world normals R n best align with sgn * u, i.e. n with the largest n . (R^T sgn u)
    const R = me.R as Float64Array;
    for (let i = 0; i < d; i++) {
      let t = 0;
      for (let j = 0; j < d; j++) t += R[j * d + i] * u[j];
      lu[i] = sgn * t;
    }
    let f1 = -1;
    let f2 = -1;
    let v1 = -Infinity;
    let v2 = -Infinity;
    for (let f = 0; f < P.nF; f++) {
      const v = dot(P.N, lu, d, f * d, 0);
      if (v > v1) {
        f2 = f1;
        v2 = v1;
        f1 = f;
        v1 = v;
      } else if (v > v2) {
        f2 = f;
        v2 = v;
      }
    }
    for (const f of [f1, f2]) {
      if (f < 0) continue;
      for (let i = 0; i < d; i++) {
        let t = 0;
        for (let j = 0; j < d; j++) t += R[i * d + j] * P.N[f * d + j];
        w[i] = sgn * t; // the world normal, pointing from a to b
      }
      best = Math.max(best, gapAlong(A, P.nV, B, P.nV, d, w));
    }
  }
  return best;
}

function placeOne(problem: NdProblem, pose: number[]): { P: Polytope | null; pc: Placed } {
  const P = shapePolytope(problem.piece);
  const r = readPose(problem.d, pose, P === null);
  if (typeof r === "string") throw new RangeError(`malformed pose: ${r}`);
  return { P, pc: { t: r.t, R: r.R, X: P && r.R ? placeVertices(P.V, P.nV, problem.d, r.t, r.R) : null } };
}

/**
 * The gap of one piece to the container's walls at scale s: positive inside, negative by the depth of the worst
 * protrusion. Throws a RangeError for a malformed pose; the problem's polytopes must be loaded.
 */
export function pieceWallGap(problem: NdProblem, s: number, pose: number[]): number {
  const { P, pc } = placeOne(problem, pose);
  return wallGap(P, shapePolytope(problem.container), s, pc, problem.d);
}

/**
 * The signed separation of two pieces: the distance between them when disjoint, minus the penetration depth when
 * they overlap (exact to about 1e-12, see gjk.ts; the validator uses cheaper bounds first). When the pair is so
 * degenerate that EPA fails, a certified lower bound of the separation is returned (never an optimistic 0). Throws a
 * RangeError for a malformed pose.
 */
export function pairSeparation(problem: NdProblem, poseA: number[], poseB: number[]): number {
  const a = placeOne(problem, poseA);
  const b = placeOne(problem, poseB);
  if (a.P === null) return ballPairGap(a.pc.t, BALL_RADIUS, b.pc.t, BALL_RADIUS, problem.d);
  const r = signedSeparation(a.pc.X as Float64Array, a.P.nV, b.pc.X as Float64Array, a.P.nV, problem.d);
  return r.converged ? r.sep : Number.isFinite(r.lower) ? r.lower : r.upper;
}

/**
 * The smallest container scale holding the pieces as placed (the container stays centred at the origin): the maximum of
 * N_f . x / b_f over the pieces' vertices (a ball: N_f . c + 1/2) and the facets, or twice the farthest point from the origin
 * in a ball container. Poses must be well formed (see configErrors).
 */
export function tightScale(problem: NdProblem, pieces: number[][]): number {
  const d = problem.d;
  const P = shapePolytope(problem.piece);
  const C = shapePolytope(problem.container);
  let s = 0;
  for (const pose of pieces) {
    const r = readPose(d, pose, P === null);
    if (typeof r === "string") throw new RangeError(`malformed pose: ${r}`);
    const X = P && r.R ? placeVertices(P.V, P.nV, d, r.t, r.R) : null;
    if (C === null) {
      if (!X) s = Math.max(s, 2 * (norm(r.t, d) + BALL_RADIUS));
      else for (let v = 0; v < P!.nV; v++) s = Math.max(s, 2 * norm(X.subarray(v * d, v * d + d), d));
      continue;
    }
    for (let f = 0; f < C.nF; f++) {
      if (!X) s = Math.max(s, (dot(C.N, r.t, d, f * d, 0) + BALL_RADIUS) / C.b[f]);
      else for (let v = 0; v < P!.nV; v++) s = Math.max(s, dot(C.N, X, d, f * d, v * d) / C.b[f]);
    }
  }
  return s;
}
