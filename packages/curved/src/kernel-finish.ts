/**
 * Finishing, the server's rule and the lower bound of the curved kernel (kernel.ts).
 *
 * finish: the package's SLP polish (polish.ts: minimise the container's apothem subject to every
 * gap >= a tiny margin), then the package's validator at tolerance 0 at the polished size, after
 * a legalisation when the polish stopped just short of feasibility. When that fails (overlaps the
 * polish could not resolve), the pieces are first separated as the package's search repairs a
 * start (L-BFGS on its penalty energy, growing the arrangement along setSize's map when that does
 * not separate them), and polished again. Curved space has no
 * similarity, so the polish, not a scaling, is what makes the pieces touch. The work is counted
 * in energy evaluations (row sweeps, L-BFGS evaluations, and the LP's tableau work converted with
 * lpWorkPerEnergy); the repair and the polish end once it passes FINISH_CAP times the kernel's
 * finishCost, or when the caller's stop says so (polled before every simplex pivot).
 *
 * curvedServerRule: what packages/spaces/src/validate.ts does for curved, without importing it:
 * P at most 100, the configuration's form and limits (size at most 1e6, coordinates at most 1e4),
 * the problem's lower bound (minus 1e-9 relative), the cheap far-centre test, then validate() of
 * validate.ts at the touching tolerance TOL = 1e-9 (the server's SPACE_TOL).
 */
import type { Finished, Validation } from "@polypack/methods";
import { type CurvedConfig, type CurvedPose, type CurvedProblem, type Space } from "./problem";
import { type KernelGeometry, containerVariable, scaleRadius } from "./kernel-energy";
import { scalePose } from "./kernel-chart";
import { energy as modelEnergy, posesFromVector, vectorFromPoses } from "./model";
import { lbfgs } from "./optim";
import { polish } from "./polish";
import { TOL, validate } from "./validate";
import { containerCircumradius, maxContainerSize, sideFromApothem } from "./shapes";
import { tForArea } from "./search";

/** The server's limits for curved problems and configurations (SPACE_MAX_P, SPACE_MAX_SIZE, SPACE_MAX_COORD, SPACE_BOUND_SLACK). */
export const MAX_P = 100;
const MAX_SIZE = 1e6;
const MAX_COORD = 1e4;
const BOUND_SLACK = 1e-9;
/** Iterations of the finishing polish (the package's search polishes with up to 300). */
export const FINISH_ITER = 40;
/** Gap margin of the finishing polish, so that rounding does not fail the check at tolerance 0. */
const FINISH_MARGIN = 1e-12;
/** The repair's target: the package's search counts a penalty energy this small as separated. */
const FEAS = 1e-22;
/** L-BFGS iterations per repair round, and the rounds (the first at the state's size, then grown). */
const REPAIR_ITER = 200;
const REPAIR_ROUNDS = 4;
/** The repair and the polish end once a finish has done this many times finishCost. */
export const FINISH_CAP = 4;

/**
 * LP tableau work (solveLp's pivot work) that costs about as much time as one energy() call
 * [CALC]: measured 1e4 to 2e4 at P = 10, 3e4 to 4e4 at P = 20 and 4.5e4 at P = 30 (the simplex's
 * inner loops are cheap per entry, an energy's work grows with the pairs).
 */
export function lpWorkPerEnergy(P: number): number {
  return 1500 * P;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A configuration of P pieces within the server's limits (a finite size in (0, 1e6], finite
 * coordinates at most 1e4 in absolute value), or the reasons it is not.
 */
export function serverForm(P: number, raw: unknown): { config: CurvedConfig } | { reasons: string[] } {
  if (!isObject(raw)) return { reasons: ["the configuration must be an object"] };
  const errors: string[] = [];
  const num = (v: unknown, path: string, max: number, positive = false): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${path} must be a finite number`);
    else if (Math.abs(v) > max) errors.push(`${path} must be at most ${max} in absolute value`);
    else if (positive && !(v > 0)) errors.push(`${path} must be positive`);
    return v as number;
  };
  const size = num(raw.size, "size", MAX_SIZE, true);
  if (!Array.isArray(raw.pieces)) return { reasons: [...errors, "pieces must be an array"] };
  if (raw.pieces.length !== P)
    return { reasons: errors.length ? errors : [`expected ${P} pieces for this problem, got ${raw.pieces.length}`] };
  const pieces = raw.pieces.map((p, i): CurvedPose => {
    if (!isObject(p)) {
      errors.push(`pieces[${i}] must be an object {x, y, theta}`);
      return { x: 0, y: 0, theta: 0 };
    }
    return {
      x: num(p.x, `pieces[${i}].x`, MAX_COORD),
      y: num(p.y, `pieces[${i}].y`, MAX_COORD),
      theta: num(p.theta, `pieces[${i}].theta`, MAX_COORD),
    };
  });
  return errors.length ? { reasons: errors.slice(0, 20) } : { config: { size, pieces } };
}

/**
 * The first piece whose centre lies beyond the container's circumradius (with the server's slack
 * of 1e-6), or -1: a piece's centre lies in its piece, so in the container. The server's cheap
 * first test; it also keeps far centres, whose coordinates overflow at K < 0, from the geometry.
 */
export function farPiece(M: number, K: number, c: CurvedConfig): number {
  const reach = containerCircumradius(M, K, c.size);
  if (!Number.isFinite(reach)) return -1;
  return c.pieces.findIndex((p) => !(Math.hypot(p.x, p.y) <= reach * (1 + 1e-6) + 1e-6));
}

/** The server's verdict on a configuration of problem curved/K/N/M/P (see the header). */
export function curvedServerRule(problem: CurvedProblem, K: number, raw: unknown, bound: number | null): Validation {
  const bad = (reasons: string[], score: number | null = null): Validation => ({ valid: false, score, reasons });
  if (problem.P > MAX_P) return bad([`P = ${problem.P} is above the largest P of the curved catalogue (${MAX_P})`]);
  const form = serverForm(problem.P, raw);
  if ("reasons" in form) return bad(form.reasons);
  const { size } = form.config;
  if (bound !== null && size < bound * (1 - BOUND_SLACK))
    return bad([`the size ${size} is below the lower bound ${bound} of this problem`], size);
  try {
    const far = farPiece(problem.M, K, form.config);
    if (far >= 0) return bad([`the centre of piece ${far} lies outside the container`], size);
    const v = validate(problem, K, form.config, { tol: TOL });
    return v.valid
      ? { valid: true, score: size, reasons: [] }
      : bad(v.errors.length ? v.errors.slice(0, 20) : [`not a valid packing (smallest gap ${v.minGap})`], size);
  } catch (e) {
    return bad([`the check failed: ${e instanceof Error ? e.message : String(e)}`], size);
  }
}

/** theta reduced to [-pi, pi] (a turn by 2 pi is no turn); unchanged when it is already there. */
function wrapAngle(theta: number): number {
  const k = Math.round(theta / (2 * Math.PI));
  return k === 0 ? theta : theta - 2 * Math.PI * k;
}

export interface FinishOptions {
  bound: number | null;
  /** The kernel's finishCost: the repair and the polish end after FINISH_CAP times it. */
  cost: number;
  shouldStop?: () => boolean;
  /** Receives the work done, in energy evaluations (for measuring finishCost). */
  stats?: { work: number };
}

/**
 * The finishing of a state (its poses and size): polish and legalise, else repair, polish and
 * legalise (see the header); null when nothing valid is found near it. Once the work cap is
 * reached or the stop fires, the repair and the polish end where they are, and legalise (a few
 * dozen validator calls) makes that point valid if it can.
 */
export function curvedFinish(g: KernelGeometry, poses: CurvedPose[], size: number, o: FinishOptions): Finished | null {
  const { space, P } = g;
  const { K, N, M } = space;
  const problem = { N, M, P };
  let work = 0;
  let stopped = false;
  const spend = (units: number): boolean => {
    work += units;
    if (!stopped && (work > FINISH_CAP * o.cost || o.shouldStop?.())) stopped = true;
    return stopped;
  };
  const done = (f: Finished | null) => {
    if (o.stats) o.stats.work = work;
    return f;
  };
  const finite = (ps: CurvedPose[]) =>
    ps.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.theta));
  // polish from `start`, then legalise
  const attempt = (start: CurvedPose[]): Finished | null => {
    let pol;
    try {
      pol = polish(space, start, undefined, {
        margin: FINISH_MARGIN,
        maxIter: FINISH_ITER,
        fit: false,
        poll: (sweeps, lpWork) => spend(sweeps + lpWork / lpWorkPerEnergy(P)),
      });
    } catch {
      return null;
    }
    if (!(pol.t < space.tMax) || !(pol.size < maxContainerSize(M, K))) return null;
    const pieces = pol.poses.map((p) => ({ x: p.x, y: p.y, theta: wrapAngle(p.theta) }));
    if (!finite(pieces)) return null;
    const config = legalise(g, problem, { size: pol.size, pieces }, () => (work += VALIDATE_WORK));
    if (!config || !curvedServerRule(problem, K, config, o.bound).valid) return null;
    return { config, score: config.size };
  };
  if (!finite(poses) || !(size > 0)) return done(null);
  const first = attempt(poses);
  if (first || stopped) return done(first);
  // the polish left overlaps it could not resolve: separate the pieces first, then polish again
  try {
    const z = repair(g, vectorFromPoses(poses), size, spend, () => stopped);
    return done(z && !stopped ? attempt(posesFromVector(z)) : null);
  } catch {
    return done(null);
  }
}

/** A validator call, in energy evaluations (the kernel's validateCost). */
export const VALIDATE_WORK = 3;

/**
 * Separates overlapping pieces, as the package's search repairs a start: L-BFGS on the penalty
 * energy at the state's size; when that leaves overlaps, the arrangement is grown along setSize's
 * map (by 15%, or halfway to the hemisphere's limit) and repaired again, up to REPAIR_ROUNDS
 * rounds. Returns the poses reached (overlapping or not: the polish takes over), or null when the
 * energy is not finite (pieces beyond float range).
 */
function repair(
  g: KernelGeometry,
  z0: Float64Array,
  size0: number,
  spend: (units: number) => boolean,
  stopped: () => boolean,
): Float64Array | null {
  const { space } = g;
  let z = z0;
  let size = size0;
  let t = containerVariable(g, size).t;
  const grad = new Float64Array(z.length);
  spend(1);
  let e = modelEnergy(space, z, t, grad);
  if (!Number.isFinite(e)) return null;
  for (let round = 0; e > FEAS && round < REPAIR_ROUNDS && !stopped(); round++) {
    if (round > 0) {
      const next = Number.isFinite(g.sizeCap) ? Math.min(size * 1.15, size + 0.5 * (g.sizeCap - size)) : size * 1.15;
      const lambda = scaleRadius(g, next) / scaleRadius(g, size);
      z = vectorFromPoses(posesFromVector(z).map((p) => scalePose(p, lambda)));
      size = next;
      t = containerVariable(g, size).t;
    }
    const r = lbfgs(
      (x, gr) => {
        spend(1);
        return modelEnergy(space, x, t, gr);
      },
      z,
      { maxIter: REPAIR_ITER, stopBelow: FEAS, m: 10, shouldStop: stopped },
    );
    if (!Number.isFinite(r.f)) break;
    z = r.x;
    e = r.f;
  }
  return z;
}

/**
 * A configuration near c that the validator accepts at tolerance 0: c itself; or, when only the
 * container is too tight, the smallest container about c's pieces (a few ulps up); or c grown
 * along setSize's map (scaleRadius) by the smallest factor 1 + eps that is accepted (eps by
 * quadrupling from 1e-13, then bisection to 0.1%). The polish ends with gaps about -1e-11 when it
 * stops before converging, which a growth of that order removes. Validity need not be monotone
 * in the factor: only an accepted configuration is returned. Null when no eps up to 1e-3 works.
 */
function legalise(g: KernelGeometry, problem: CurvedProblem, c: CurvedConfig, count: () => void): CurvedConfig | null {
  const { K } = g.space;
  const valid = (cfg: CurvedConfig) => (count(), validate(problem, K, cfg, { tol: 0 }).valid);
  count();
  const v = validate(problem, K, c, { tol: 0 });
  if (v.valid) return c;
  if (v.minPairGap >= 0 && Number.isFinite(v.tightSize)) {
    let size = Math.max(c.size, v.tightSize);
    for (let k = 0; k < 8; k++, size *= 1 + 4 * Number.EPSILON) {
      const cfg = { size, pieces: c.pieces };
      if (valid(cfg)) return cfg;
    }
  }
  const r0 = scaleRadius(g, c.size);
  const grown = (eps: number): CurvedConfig => {
    const size = c.size * (1 + eps);
    const lambda = scaleRadius(g, size) / r0;
    return { size, pieces: c.pieces.map((p) => scalePose(p, lambda)) };
  };
  let lo = 0;
  let hi = 1e-13;
  while (!valid(grown(hi))) {
    lo = hi;
    hi *= 4;
    if (hi > 1e-3) return null;
  }
  while (hi - lo > 1e-3 * hi) {
    const mid = (lo + hi) / 2;
    if (valid(grown(mid))) hi = mid;
    else lo = mid;
  }
  return grown(hi);
}

/**
 * A lower bound on the score [CALC], deflated by 1e-12 relative against rounding, or null when
 * none is finite inside the admissible range (an infeasible problem):
 *  - area: P disjoint pieces of area A lie in the container, so its area is at least P A;
 *  - one piece: a polygon container contains the piece's inscribed disk, so its inradius is at
 *    least rho; a disk container contains the piece's vertices, so r >= R;
 *  - two pieces in a disk: two disjoint inscribed disks have centres within r - rho of O and at
 *    least 2 rho apart, so r >= 2 rho.
 * These are the bounds of the research records (data/curved/records.json, `bound.kind`).
 */
export function curvedBound(space: Space, P: number): number | null {
  const { K, M, piece } = space;
  const sizeOfT = (t: number) => sideFromApothem(M, K, t); // (a disk container's size is its diameter 2 t)
  let b = sizeOfT(tForArea(space, P * piece.area));
  b = Math.max(b, sizeOfT(M === 0 ? piece.R : piece.rho));
  if (M === 0 && P >= 2) b = Math.max(b, sizeOfT(2 * piece.rho));
  if (!Number.isFinite(b) || !(b < maxContainerSize(M, K))) return null;
  return b * (1 - 1e-12);
}
