import { autoOrientSet, enclose, encloseSet, extremePoints } from "./enclose";
import { Overlap, TOL, findOverlaps } from "./overlap";
import { Container, MAX_COORD, MAX_PIECES, MAX_SIDES, Pose, isShapeCode } from "./shapes";

/** The configuration schema shared by export/import, share URLs and the API. */
export interface PackingConfig {
  N: number;
  M: number;
  P: number;
  pieces: Pose[];
  container_phi: number;
  name?: string;
  agent_note?: string;
}

export type ParseResult = { ok: true; config: PackingConfig } | { ok: false; errors: string[] };

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Checks the shape and ranges of an untrusted configuration. It does not check geometry
 * (overlaps, piece count against P); `evaluate` does that.
 */
export function parseConfig(input: unknown): ParseResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) return { ok: false, errors: ["body must be a JSON object"] };
  const o = input as Record<string, unknown>;
  const shapeMsg = `must be 0 (circle) or an integer from 3 to ${MAX_SIDES}`;
  if (!isShapeCode(o.N)) errors.push(`N ${shapeMsg}`);
  if (!isShapeCode(o.M)) errors.push(`M ${shapeMsg}`);
  if (typeof o.P !== "number" || !Number.isInteger(o.P) || o.P < 1 || o.P > MAX_PIECES) {
    errors.push(`P must be an integer from 1 to ${MAX_PIECES}`);
  }
  const pieces: Pose[] = [];
  if (!Array.isArray(o.pieces)) {
    errors.push("pieces must be an array");
  } else if (o.pieces.length > MAX_PIECES) {
    errors.push(`pieces must have at most ${MAX_PIECES} entries`);
  } else {
    for (let i = 0; i < o.pieces.length; i++) {
      const p = o.pieces[i] as Record<string, unknown> | null;
      const theta = p && p.theta === undefined ? 0 : p?.theta;
      if (!p || !isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(theta)) {
        errors.push(`pieces[${i}] must have finite numbers x, y, theta`);
        break;
      }
      if (Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD) {
        errors.push(`pieces[${i}] is outside the coordinate limit of ${MAX_COORD}`);
        break;
      }
      pieces.push({ x: p.x, y: p.y, theta });
    }
  }
  const phi = o.container_phi === undefined ? 0 : o.container_phi;
  if (!isFiniteNumber(phi)) errors.push("container_phi must be a finite number");
  // `agent` ("human" | "ai") was replaced by found_with (see parseProvenance); old clients still send it, and it is ignored
  if (o.name !== undefined && typeof o.name !== "string") errors.push("name must be a string");
  if (o.agent_note !== undefined && typeof o.agent_note !== "string") errors.push("agent_note must be a string");
  if (errors.length) return { ok: false, errors };
  const config: PackingConfig = {
    N: o.N as number,
    M: o.M as number,
    P: o.P as number,
    pieces,
    container_phi: phi as number,
  };
  if (o.name !== undefined) config.name = o.name as string;
  if (o.agent_note !== undefined) config.agent_note = o.agent_note as string;
  return { ok: true, config };
}

export interface Evaluation {
  valid: boolean;
  /** Human-readable reasons when not valid. */
  reasons: string[];
  overlaps: Overlap[];
  /** Smallest enclosing container found; null when there are no pieces, or with `stopWhenInvalid` when not valid. */
  container: Container | null;
  /** container.size, the score. Only meaningful as a record when valid. */
  score: number | null;
}

/**
 * Validity and score of a configuration. This is the single scoring routine for client and server.
 * With `autoOrient` the container is computed at the given phi and at the auto-oriented phi,
 * and the smaller one is kept. With `maxOverlaps`, at most that many overlapping pairs are found
 * and reported (the server's guard against slow, deliberately invalid submissions).
 * With `stopWhenInvalid`, a configuration found invalid (wrong piece count, overlaps) returns at
 * once, with the same reasons and overlaps but no container or score. The server passes it: its
 * refusal carries the reasons only, and the container is the costly part for large hulls.
 */
export function evaluate(
  config: PackingConfig,
  opts: { autoOrient?: boolean; maxOverlaps?: number; stopWhenInvalid?: boolean } = {},
): Evaluation {
  const { N, M, P, pieces } = config;
  const reasons: string[] = [];
  if (pieces.length !== P) reasons.push(`expected exactly ${P} pieces, got ${pieces.length}`);
  const limit = opts.maxOverlaps ?? Infinity;
  const overlaps = findOverlaps(N, pieces, TOL, 1, limit);
  if (overlaps.length) {
    const worst = overlaps.reduce((a, b) => (b.sep < a.sep ? b : a));
    const count = overlaps.length >= limit ? `at least ${overlaps.length}` : `${overlaps.length}`;
    reasons.push(
      `${count} overlapping pair(s); deepest found is pieces ${worst.i} and ${worst.j}, ` +
        `penetration ${(-worst.sep).toExponential(3)} (tolerance ${TOL})`,
    );
  }
  if (opts.stopWhenInvalid && reasons.length) return { valid: false, reasons, overlaps, container: null, score: null };
  let container: Container | null = null;
  if (pieces.length > 0 && opts.autoOrient && M !== 0) {
    const set = extremePoints(N, pieces);
    container = encloseSet(set, M, config.container_phi);
    const best = autoOrientSet(set, M, config.container_phi);
    if (best.size < container.size) container = best;
  } else if (pieces.length > 0) {
    // at one orientation the hull of all the vertices is rarely needed (see `enclose`)
    container = enclose(N, pieces, M, config.container_phi);
  }
  return { valid: reasons.length === 0, reasons, overlaps, container, score: container ? container.size : null };
}

export interface StrictResult {
  ok: boolean;
  /** Container size certified by the shrink test: size / (1 - eps). */
  certifiedSize: number;
  eps: number;
  reason?: string;
}

/**
 * Stricter check for submissions that beat the literature (the shrink test).
 * Every piece is shrunk by (1 - eps) about its centre. The shrunk pieces must be strictly
 * separated (no tolerance) and must fit a container of the same shape and orientation that is
 * strictly smaller than the given one. Scaling the whole picture by 1 / (1 - eps) then gives
 * unit pieces in a container of size size / (1 - eps), which is the certified value.
 */
export function strictVerify(N: number, pieces: readonly Pose[], container: Container, eps = 1e-8): StrictResult {
  const scale = 1 - eps;
  const certifiedSize = container.size / scale;
  // tol = 0 would still accept exact contact; require a strictly positive gap
  const touching = findOverlaps(N, pieces, -Number.MIN_VALUE, scale);
  if (touching.length) {
    return {
      ok: false,
      certifiedSize,
      eps,
      reason: `${touching.length} pair(s) not strictly separated after shrinking`,
    };
  }
  const shrunk = encloseSet(extremePoints(N, pieces, scale), container.M, container.phi);
  if (!(shrunk.size < container.size)) {
    return { ok: false, certifiedSize, eps, reason: "shrunk pieces do not fit strictly inside the container" };
  }
  return { ok: true, certifiedSize, eps };
}
