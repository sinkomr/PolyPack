/**
 * The server's rule for a boundary configuration, for the generic methods' kernel (kernel.ts):
 * validateSpaceSubmission of packages/spaces/src/validate.ts with the problem's lower bound and no
 * certified record. It is rebuilt here because this package does not depend on the spaces
 * registry; packages/spaces/test/boundary-kernel.test.ts compares the two, verdict, score and
 * reasons. In order:
 *  1. P is at most the space's largest, SPACE_MAX_P.boundary = 64 (the live server also caps it
 *     at its catalogue's, 16);
 *  2. the form, in the server's words (parseBoundary): s a finite number in (0, 1e4]; a list of
 *     P pieces {cell, u, q?}, cell an integer from 0 to 7, u three finite numbers of at most
 *     SPACE_MAX_COORD = 1e4 in absolute value; a ball has no q, a cube's q is four such numbers of
 *     norm within 1e-9 of 1. A wrong number of pieces is an invalid packing, anything else here
 *     malformed input; either way the score is null;
 *  3. s at least the problem's lower bound less SPACE_BOUND_SLACK = 1e-9 relative, the bound as the
 *     records store it (boundaryBound);
 *  4. validateBoundary at SPACE_TOL = 1e-9, with at most BOUNDARY_MAX_CHAINS = 1024 chains per
 *     piece and 20 reasons.
 * Not here: the server's strict check at 1e-11 of an entry that beats the research record, which
 * needs the record. finish() gives configurations valid at tolerance 0, which pass it anyway.
 */
import type { Validation } from "@polypack/methods";
import type { BoundaryProblem, PieceName } from "./types";
import { MAX_S, validateBoundary } from "./validate";

/** The server's constants (packages/spaces/src/info.ts and validate.ts). */
export const BOUNDARY_SERVER_RULE = {
  /** SPACE_TOL */
  tol: 1e-9,
  /** BOUNDARY_MAX_CHAINS */
  maxChains: 1024,
  /** MAX_REASONS */
  maxReasons: 20,
  /** SPACE_MAX_P.boundary */
  maxP: 64,
  /** SPACE_MAX_COORD */
  maxCoord: 1e4,
  /** SPACE_BOUND_SLACK */
  boundSlack: 1e-9,
  /** The boundary parser's tolerance on a quaternion's norm. */
  unitSlack: 1e-9,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The server's parse of a boundary configuration (parseBoundary), with its limits: what is wrong
 * with its form, in the server's words; empty when it is well formed.
 */
export function serverForm(problem: BoundaryProblem, raw: unknown): string[] {
  const R = BOUNDARY_SERVER_RULE;
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
  num(raw.s, "s", MAX_S, true);
  const list = raw.pieces;
  if (!Array.isArray(list)) return [...errors, "pieces must be an array"];
  if (list.length !== problem.P)
    return [...errors, `expected ${problem.P} pieces for this problem, got ${list.length}`];
  const ball = problem.piece === "ball";
  for (let i = 0; i < list.length; i++) {
    if (errors.length >= R.maxReasons) break;
    // the server maps over the list, which skips a hole; the validator then refuses it
    if (!(i in list)) continue;
    const p: unknown = list[i];
    if (!isObject(p)) {
      errors.push(`pieces[${i}] must be an object {cell, u${ball ? "" : ", q?"}}`);
      continue;
    }
    if (!Number.isInteger(p.cell) || (p.cell as number) < 0 || (p.cell as number) >= 8)
      errors.push(`pieces[${i}].cell must be an integer from 0 to 7`);
    if (!Array.isArray(p.u) || p.u.length !== 3) errors.push(`pieces[${i}].u must be [u0, u1, u2]`);
    else for (let k = 0; k < 3; k++) num((p.u as unknown[])[k], `pieces[${i}].u[${k}]`, R.maxCoord);
    if (p.q === undefined) continue;
    if (ball) {
      errors.push(`pieces[${i}] is a ball and has no rotation q`);
      continue;
    }
    if (!Array.isArray(p.q) || p.q.length !== 4) {
      errors.push(`pieces[${i}].q must be a unit quaternion [w, x, y, z]`);
      continue;
    }
    const q = [0, 1, 2, 3].map((k) => num((p.q as unknown[])[k], `pieces[${i}].q[${k}]`, R.maxCoord));
    if (q.every(Number.isFinite) && !(Math.abs(Math.hypot(...q) - 1) <= R.unitSlack))
      errors.push(`pieces[${i}].q must be a unit quaternion (norm within ${R.unitSlack} of 1)`);
  }
  return errors;
}

/** The server's verdict on a configuration of the problem (header). */
export function serverRule(problem: BoundaryProblem, config: unknown, bound: number): Validation {
  const R = BOUNDARY_SERVER_RULE;
  const fail = (reasons: string[], score: number | null = null): Validation => ({ valid: false, score, reasons });
  if (problem.P > R.maxP)
    return fail([`P = ${problem.P} is above the largest P of the boundary catalogue (${R.maxP})`]);
  const errors = serverForm(problem, config);
  if (errors.length) return fail(errors.slice(0, R.maxReasons));
  const s = (config as { s: number }).s;
  if (s < bound * (1 - R.boundSlack))
    return fail([`the size ${s} is below the lower bound ${bound} of this problem`], s);
  let reasons: string[];
  try {
    const v = validateBoundary(problem, config, { tol: R.tol, maxChains: R.maxChains, maxReasons: R.maxReasons });
    reasons = v.ok ? [] : v.reasons.length ? v.reasons.slice(0, R.maxReasons) : ["not a valid packing"];
  } catch (e) {
    reasons = [`the check failed: ${e instanceof Error ? e.message : String(e)}`];
  }
  return reasons.length ? fail(reasons, s) : { valid: true, score: s, reasons: [] };
}

// ---------------------------------------------------------------- the lower bound

/**
 * The problem's lower bound on s as the records store it (python/boundary/build_records.py
 * bounds_of; docs/spaces/BOUNDARY.md section 5): the larger of the volume bound and the one-piece
 * bound, each the largest binary64 value not above its exact value. Balls (diameter 1): (P pi / 48)^(1/3) and
 * 1 / sqrt 2, exactly half the values for balls of radius 1; cubes: (P / 8)^(1/3) and 1 / sqrt 2. Each comparison is decided exactly, with integers.
 */
export function boundaryBound(piece: PieceName, P: number): number {
  if (piece === "ball") {
    // x^3 <= P pi / 48, with pi bracketed to 60 decimals (no binary64 cube lies in the bracket's width)
    const volume = largestFloat(
      (x) => compare(x, 3, BigInt(P) * PI_60, 48n * 10n ** 60n) <= 0,
      Math.cbrt((P * Math.PI) / 48),
    );
    const one = largestFloat((x) => compare(x, 2, 1n, 2n) <= 0, Math.SQRT1_2);
    return Math.max(volume, one);
  }
  const volume = largestFloat((x) => compare(x, 3, BigInt(P), 8n) <= 0, Math.cbrt(P / 8));
  const one = largestFloat((x) => compare(x, 2, 1n, 2n) <= 0, Math.SQRT1_2);
  return Math.max(volume, one);
}

/** floor(pi 10^60). */
const PI_60 = 3141592653589793238462643383279502884197169399375105820974944n;

/** The largest binary64 x with check(x) true, near approx (check monotone in x). */
function largestFloat(check: (x: number) => boolean, approx: number): number {
  let f = approx;
  while (!check(f)) f = step(f, -1);
  while (check(step(f, 1))) f = step(f, 1);
  return f;
}

/** The next binary64 value above (dir 1) or below (dir -1) a positive finite x. */
function step(x: number, dir: 1 | -1): number {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  b.setBigUint64(0, b.getBigUint64(0) + BigInt(dir));
  return b.getFloat64(0);
}

/** The sign of x^p - num / den, exactly, for a positive finite x and positive integers num, den. */
function compare(x: number, p: number, num: bigint, den: bigint): number {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  const bits = b.getBigUint64(0);
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  // x = m 2^e
  const m = exp === 0 ? frac : frac | (1n << 52n);
  const e = (exp === 0 ? 1 : exp) - 1075;
  let left = m ** BigInt(p) * den;
  let right = num;
  if (e * p >= 0) left <<= BigInt(e * p);
  else right <<= BigInt(-e * p);
  return left > right ? 1 : left < right ? -1 : 0;
}
