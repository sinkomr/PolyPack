/**
 * The exact finishing and the server's rule of the methods kernel (kernel.ts), in both modes.
 *
 * finishSurface: from poses on the solid of scale 1 (pieces scaled by lam = 1/s, as the fold search
 * works), with the fold search's model of the mode (fold: parts developed across the edges; nofold:
 * every piece in its own face)
 *  1. tighten: the largest scale at or below lam at which the fold search's energy (search/
 *     energy.ts) is exactly zero, by bisection with the poses fixed. Pieces shrink about their
 *     centres as lam falls, and a shrunk piece lies inside the one before (it is developed along
 *     the same rays), so the energy only falls with lam and a bisection finds the edge. The
 *     pieces shrink to a tenth at most (relaxed starts whose pieces are larger than the faces can
 *     need a quarter). Folding, a scale at which a piece crosses more chains of faces than the
 *     server allows counts as infeasible before the model develops it, so a piece far too large for
 *     its solid costs one capped enumeration, not an unbounded one;
 *  2. polish: the fold search's contact-LP polish (search/slp.ts) within a work budget, which keeps
 *     the packing valid and never lowers the scale; a stop poll ends it early with its last valid
 *     packing;
 *  3. check: the configuration at scale s = 1 / lam must pass the mode's validator at tolerance 0. Float
 *     rounding at the new scale can leave a touching pair overlapping by about 1e-16, so the
 *     scale is lowered by 1e-13, 1e-12, ... (relative) until it passes, as the certificates' shrink
 *     does. A centre that rounding puts just outside its face is moved back in. Should the polished
 *     packing fail every step, the tightened one is checked the same way.
 *
 * validateSurfaceSubmission: the server's rule for a configuration of either mode (packages/spaces/
 * src/validate.ts): the submission's form and work bounds, the lower bound, and the mode's validator
 * at the touching tolerance with the server's chain limit. The constants mirror packages/spaces/src/
 * info.ts and validate.ts, which this package cannot import (spaces depends on surface).
 */
import { boundingRadius } from "@polypack/geometry";
import { ChainLimitError, enumerateChains } from "./chains";
import { centreDepth } from "./kernel-solid";
import type { SurfacePose } from "./parts";
import { canonicalize } from "./search/energy";
import { Packing } from "./search/optimize";
import { slpPolish } from "./search/slp";
import type { Solid } from "./solids";
import { type Mode, type SurfaceConfig, validate } from "./validate";

/** PolyPack's touching tolerance (SPACE_TOL). */
export const SERVER_TOL = 1e-9;
/** The strict tolerance (SPACE_STRICT_TOL) every entry of a problem without a research record must pass too. */
export const SERVER_STRICT_TOL = 1e-11;
/** The server's reason when such an entry passes only at the touching tolerance (SPACE_STRICT_NO_RECORD_REASON). */
const STRICT_NO_RECORD_REASON = `valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance ${SERVER_STRICT_TOL}`;
/** Most chains of faces per piece in the server's check (SURFACE_MAX_CHAINS). */
export const SERVER_MAX_CHAINS = 600;
/** Largest s (SPACE_MAX_SIZE) and largest |x|, |y|, |theta| (SPACE_MAX_COORD) the server accepts. */
export const SERVER_MAX_SIZE = 1e6;
export const SERVER_MAX_COORD = 1e4;
/** Relative slack below the lower bound (SPACE_BOUND_SLACK). */
export const SERVER_BOUND_SLACK = 1e-9;
/** Largest P of the surface catalogue (SPACE_MAX_P.surface). */
export const SERVER_MAX_P = 100;
/** Reasons listed at most (the server's MAX_REASONS). */
const MAX_REASONS = 20;

/** The submission format of a surface problem (docs/spaces/SURFACE.md): the edge and the poses at that edge. */
export interface SurfaceSubmission {
  s: number;
  pieces: SurfacePose[];
}

/** Contact-LP iterations of a finish at most (the fold search's final polish runs 120). */
export const FINISH_POLISH_ITERATIONS = 8;

/**
 * The polish's work budget, in its stop polls (slpPolish polls once per piece of its derivatives,
 * every 8 pivots of its dense simplex and per trial step): about eight iterations of a packing with
 * few contacts. A deterministic bound, since a jammed packing's degenerate LP can otherwise run its
 * 5000 pivots in every iteration.
 */
export function polishPolls(P: number): number {
  return 8 * (P + 16);
}

/** Relative lowerings of the scale tried by the final check, in order. */
const LADDER = [0, 1e-13, 3e-13, 1e-12, 3e-12, 1e-11, 1e-10, 1e-9, 1e-8, 1e-7, 1e-6];

/**
 * Relative drops of the scale the tightening tries until one is feasible: fine steps (1e-12,
 * 4e-12, ..., about 0.27) for a packing that is nearly valid, then coarse ones down to a tenth.
 */
const DROPS = [...Array.from({ length: 20 }, (_, k) => 1e-12 * 4 ** k), 0.5, 0.75, 0.9];

/** Does every piece cross at most the server's number of chains of faces at scale lam (the reach of the fold search's model)? */
function withinChainCap(solid: Solid, N: number, lam: number, poses: SurfacePose[]): boolean {
  const reach = N === 0 ? 2 * lam : lam * boundingRadius(N);
  for (const p of poses)
    try {
      enumerateChains(solid, 1, p.face, p.x, p.y, reach, SERVER_MAX_CHAINS);
    } catch {
      // more chains than the cap (or a chain deeper than the enumeration allows)
      return false;
    }
  return true;
}

export interface FinishOptions {
  /** Contact-LP iterations at most (default FINISH_POLISH_ITERATIONS; 0 skips the polish). */
  polishIterations?: number;
  /** The polish's work budget in stop polls (default polishPolls(P)). */
  polls?: number;
  /** Polled by the polish: true ends it with its last valid packing. */
  shouldStop?: () => boolean;
  /** "fold" (default) or "nofold". */
  mode?: Mode;
}

/**
 * The finished configuration from poses on the unit solid at scale lam, or null when shrinking
 * the pieces about their centres to a tenth does not clear their overlaps (a centre on a cone
 * point, two centres at one point) or the final check fails.
 */
export function finishSurface(solid: Solid, N: number, lam0: number, poses0: SurfacePose[], o: FinishOptions = {}): SurfaceSubmission | null {
  const mode = o.mode ?? "fold";
  const polishIterations = o.polishIterations ?? FINISH_POLISH_ITERATIONS;
  const polls = o.polls ?? polishPolls(poses0.length);
  if (!(lam0 > 0) || !Number.isFinite(lam0)) return null;
  const poses = poses0.map((p) => canonicalize(solid, 1, p));
  // the fold search's model, built at the first scale within the chain cap; a piece's chains only
  // grow with the scale, so the largest scale within the cap and the smallest above it are kept
  let pk: Packing | null = null;
  let capOk = 0;
  let capOver = Infinity;
  const zeroAt = (lam: number): boolean => {
    if (lam >= capOver) return false;
    if (lam > capOk) {
      if (mode === "fold" && !withinChainCap(solid, N, lam, poses)) {
        capOver = lam;
        return false;
      }
      capOk = lam;
    }
    if (pk) pk.setScale(lam);
    else pk = new Packing(solid, N, lam, poses, mode);
    return pk.energy() === 0;
  };
  // 1. tighten: a feasible scale below lam0 (DROPS), then bisection
  let lo = lam0;
  let hi = lam0;
  if (!zeroAt(lam0)) {
    let found = false;
    for (const drop of DROPS) {
      const l = lam0 * (1 - drop);
      if (zeroAt(l)) {
        lo = l;
        found = true;
        break;
      }
      hi = l;
    }
    if (!found) return null;
    while (hi / lo - 1 > 1e-13) {
      const mid = Math.sqrt(lo * hi);
      if (!(mid > lo && mid < hi)) break;
      if (zeroAt(mid)) lo = mid;
      else hi = mid;
    }
  }
  // 2. polish (it needs, and keeps, a valid packing)
  const candidates = [{ lam: lo, poses }];
  if (polishIterations > 0 && !o.shouldStop?.()) {
    let used = 0;
    const stop = () => ++used > polls || !!o.shouldStop?.();
    const pol = slpPolish(solid, N, lo, poses, { iterations: polishIterations, shouldStop: stop, mode });
    if (pol.lam > lo) candidates.unshift({ lam: pol.lam, poses: pol.poses });
  }
  // 3. the validator at tolerance 0 decides
  for (const c of candidates) {
    const r = checked(solid, N, c.lam, c.poses, mode);
    if (r) return r;
  }
  return null;
}

/** The configuration at the first scale of the ladder at which it passes the validator at tolerance 0, or null. */
function checked(solid: Solid, N: number, lam: number, best: SurfacePose[], mode: Mode): SurfaceSubmission | null {
  for (const eps of LADDER) {
    const s = 1 / (lam * (1 - eps));
    const pieces = best.map((p) => inFace(solid, p.face, s, p.x * s, p.y * s, p.theta));
    const cfg: SurfaceConfig = { solid: solid.name, N, s, pieces };
    try {
      if (validate(cfg, mode, { tol: 0, maxErrors: 1, maxChains: SERVER_MAX_CHAINS }).ok) return { s, pieces };
    } catch (e) {
      if (!(e instanceof ChainLimitError)) throw e;
      return null;
    }
  }
  return null;
}

/** A pose at edge s whose centre the validator sees in its closed face: rounding can leave it outside by about 1e-16 s. */
function inFace(solid: Solid, face: number, s: number, x: number, y: number, theta: number): SurfacePose {
  for (let k = 0; k < 8 && centreDepth(solid, face, s, x, y) < 0; k++) {
    // towards the frame origin, which is inside the face
    const f = 1 - 4 * Number.EPSILON * 2 ** k;
    x *= f;
    y *= f;
  }
  return { face, x, y, theta };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A submission in the surface format for a problem of P pieces on this solid, or the reasons it
 * is malformed, in the server's words and order (packages/spaces/src/validate.ts parseSurface:
 * s positive and at most 1e6, exactly P pieces, a face index in range, x, y and theta at most 1e4
 * in absolute value; at most 20 reasons).
 */
export function parseSurfaceSubmission(solid: Solid, P: number, raw: unknown): SurfaceSubmission | string[] {
  if (!isObject(raw)) return ["config must be an object"];
  const errors: string[] = [];
  const num = (v: unknown, path: string, max: number, positive = false): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${path} must be a finite number`);
      return NaN;
    }
    if (Math.abs(v) > max) errors.push(`${path} must be at most ${max} in absolute value`);
    else if (positive && !(v > 0)) errors.push(`${path} must be positive`);
    return v;
  };
  const s = num(raw.s, "s", SERVER_MAX_SIZE, true);
  const list = raw.pieces;
  if (!Array.isArray(list)) return [...errors, "pieces must be an array"];
  if (list.length !== P) return [...errors, `expected ${P} pieces for this problem, got ${list.length}`];
  const pieces: SurfacePose[] = list.map((p: unknown, i: number) => {
    if (errors.length >= MAX_REASONS) return { face: 0, x: 0, y: 0, theta: 0 };
    if (!isObject(p)) {
      errors.push(`pieces[${i}] must be an object {face, x, y, theta}`);
      return { face: 0, x: 0, y: 0, theta: 0 };
    }
    if (!Number.isInteger(p.face) || (p.face as number) < 0 || (p.face as number) >= solid.F)
      errors.push(`pieces[${i}].face must be an integer from 0 to ${solid.F - 1}`);
    return {
      face: p.face as number,
      x: num(p.x, `pieces[${i}].x`, SERVER_MAX_COORD),
      y: num(p.y, `pieces[${i}].y`, SERVER_MAX_COORD),
      theta: num(p.theta, `pieces[${i}].theta`, SERVER_MAX_COORD),
    };
  });
  return errors.length ? errors.slice(0, MAX_REASONS) : { s, pieces };
}

/**
 * The server's rule for a submission (see the head of this file). With `noRecord`, for a problem
 * without a research record, an entry must pass at SERVER_STRICT_TOL too, as the server asks of
 * every entry of such a problem. The server's further check of an entry that beats a research
 * record (valid also at 1e-11) needs the record and is left to it.
 */
export function validateSurfaceSubmission(
  solid: Solid,
  N: number,
  P: number,
  bound: number | null,
  raw: unknown,
  mode: Mode = "fold",
  noRecord = false,
): { valid: boolean; score: number | null; reasons: string[] } {
  if (P > SERVER_MAX_P) return { valid: false, score: null, reasons: [`P = ${P} is above the largest P of the surface catalogue (${SERVER_MAX_P})`] };
  const parsed = parseSurfaceSubmission(solid, P, raw);
  if (Array.isArray(parsed)) return { valid: false, score: null, reasons: parsed.slice(0, MAX_REASONS) };
  const { s, pieces } = parsed;
  if (bound !== null && s < bound * (1 - SERVER_BOUND_SLACK))
    return { valid: false, score: s, reasons: [`the size ${s} is below the lower bound ${bound} of this problem`] };
  try {
    const at = (tol: number) => {
      const v = validate({ solid: solid.name, N, s, pieces }, mode, { tol, maxErrors: MAX_REASONS, maxChains: SERVER_MAX_CHAINS });
      return v.ok ? [] : v.errors.length ? v.errors.slice(0, MAX_REASONS) : [`not a valid packing (smallest clearance ${v.minPairSep})`];
    };
    const reasons = at(SERVER_TOL);
    if (reasons.length) return { valid: false, score: s, reasons };
    const strict = noRecord ? at(SERVER_STRICT_TOL) : [];
    if (strict.length) return { valid: false, score: s, reasons: [STRICT_NO_RECORD_REASON, ...strict.slice(0, 3)] };
    return { valid: true, score: s, reasons: [] };
  } catch (e) {
    return {
      valid: false,
      score: s,
      reasons: [e instanceof ChainLimitError ? `the fold check gave up: ${e.message}` : `the check failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}
