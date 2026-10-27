import { runSteps, runStepsAsync } from "@polypack/methods";
/**
 * Float64 validator for curved packings. Independent rigorous certification is done by
 * python/curved/certify.py; this validator mirrors PolyPack's touching tolerance (1e-9).
 */
import { CurvedConfig, CurvedProblem, Space, containerT, isFinitePose, makeSpace } from "./problem";
import { allStates, pairGap, requiredT, wallCovectors, centreDistance, type PairWitness } from "./evaluate";
import { asnK, distFromVs } from "./kfun";
import { lineValue } from "./space";
import { maxContainerSize, sideFromApothem } from "./shapes";

export const TOL = 1e-9;

export interface ValidationOptions {
  /** overlap tolerance: a gap >= -tol counts as touching (default 1e-9) */
  tol?: number;
  /** Stop after this many overlapping pairs (server use). */
  maxErrors?: number;
  /** gaps <= contactTol are reported as contacts (default 1e-7) */
  contactTol?: number;
}

export interface ValidationContact {
  kind: "pair" | "wall" | "rim";
  i: number;
  j: number;
  wall: number;
  vertex: number;
  gap: number;
  witness?: PairWitness;
}

export interface ValidationResult {
  valid: boolean;
  /** every gap strictly positive in float64 (not a proof) */
  strictlyValid: boolean;
  /** the configuration's container size (score) */
  score: number;
  /** smallest container size at the fixed centre and orientation that contains every piece */
  tightSize: number;
  minGap: number;
  minPairGap: number;
  minContainerGap: number;
  contacts: ValidationContact[];
  errors: string[];
}

function fail(errors: string[], size = NaN): ValidationResult {
  return {
    valid: false,
    strictlyValid: false,
    score: size,
    tightSize: NaN,
    minGap: NaN,
    minPairGap: NaN,
    minContainerGap: NaN,
    contacts: [],
    errors,
  };
}

export function* validationSteps(
  problem: CurvedProblem,
  K: number,
  config: CurvedConfig,
  options: ValidationOptions = {},
): Generator<void, ValidationResult> {
  const tol = options.tol ?? TOL;
  const contactTol = options.contactTol ?? 1e-7;
  const errors: string[] = [];
  if (!Number.isFinite(K)) return fail(["K must be finite"]);
  if (!config || !Array.isArray(config.pieces)) return fail(["config.pieces must be an array"]);
  const { N, M, P } = problem;
  if (!Number.isInteger(P) || P < 1) return fail(["P must be a positive integer"]);
  if (config.pieces.length !== P) return fail([`expected ${P} pieces, got ${config.pieces.length}`]);
  if (!config.pieces.every(isFinitePose)) return fail(["every pose needs finite x, y, theta"]);
  if (!(typeof config.size === "number" && Number.isFinite(config.size) && config.size > 0))
    return fail(["size must be a positive finite number"]);
  let space: Space;
  try {
    space = makeSpace(K, N, M);
  } catch (e) {
    return fail([(e as Error).message], config.size);
  }
  const sMax = maxContainerSize(M, K);
  if (!(config.size < sMax)) return fail([`size must be below ${sMax} (open hemisphere) at K=${K}`], config.size);
  const t = containerT(space, config.size);
  if (!Number.isFinite(t)) return fail(["container size not representable"], config.size);
  if (K > 0) {
    // keep exponential coordinates in the open hemisphere so that the pose is unambiguous
    const lim = Math.PI / (2 * Math.sqrt(K));
    for (const p of config.pieces)
      if (!(Math.hypot(p.x, p.y) < lim)) return fail(["piece centre outside the open hemisphere"], config.size);
  }
  const states = allStates(space, config.pieces);
  if (K > 0) {
    for (const s of states)
      for (const v of N === 0 ? [s.centre] : s.verts)
        if (!(1 - K * v.e > 0)) errors.push("vertex outside the open hemisphere");
  }
  const contacts: ValidationContact[] = [];
  let minPair = Infinity;
  let minCont = Infinity;
  const reach = 2 * space.piece.R + 1e-6;
  let overlaps = 0;
  pairs: for (let i = 0; i < P; i++) {
    for (let j = i + 1; j < P; j++) {
      if (centreDistance(space, states[i], states[j]) > reach) continue;
      const g = pairGap(space, states[i], states[j]);
      minPair = Math.min(minPair, g.gap);
      yield;
      if (g.gap < -tol && ++overlaps >= (options.maxErrors ?? Infinity)) break pairs;
      if (g.gap <= contactTol)
        contacts.push({ kind: "pair", i, j, wall: -1, vertex: g.witness.vertex, gap: g.gap, witness: g.witness });
    }
  }
  const walls = wallCovectors(space, t);
  let tReq = -Infinity;
  for (let i = 0; i < P; i++) {
    const s = states[i];
    tReq = Math.max(tReq, requiredT(space, s));
    const pts = N === 0 ? [s.centre] : s.verts;
    const pad = N === 0 ? space.piece.R : 0;
    for (const [k, p] of pts.entries()) {
      const vertex = N === 0 ? -1 : k;
      if (M === 0) {
        const g = t - distFromVs(K, p.e) - pad;
        minCont = Math.min(minCont, g);
        if (g <= contactTol) contacts.push({ kind: "rim", i, j: -1, wall: -1, vertex, gap: g });
      } else {
        for (const [w, n] of walls.entries()) {
          const g = -asnK(K, lineValue(K, n, p)) - pad;
          minCont = Math.min(minCont, g);
          if (g <= contactTol) contacts.push({ kind: "wall", i, j: -1, wall: w, vertex, gap: g });
        }
      }
      yield;
    }
  }
  const minGap = Math.min(minPair, minCont);
  const tightSize = sideFromApothem(M, K, tReq);
  const valid = errors.length === 0 && minGap >= -tol;
  if (minPair < -tol) errors.push(`pieces overlap by ${-minPair}`);
  if (minCont < -tol) errors.push(`a piece protrudes by ${-minCont}`);
  return {
    valid,
    strictlyValid: valid && minGap > 0,
    score: config.size,
    tightSize,
    minGap,
    minPairGap: minPair,
    minContainerGap: minCont,
    contacts,
    errors,
  };
}

export function validate(
  problem: CurvedProblem,
  K: number,
  config: CurvedConfig,
  options: ValidationOptions = {},
): ValidationResult {
  return runSteps(validationSteps(problem, K, config, options));
}
export function validateAsync(
  problem: CurvedProblem,
  K: number,
  config: CurvedConfig,
  options: ValidationOptions & { sliceMs?: number } = {},
) {
  return runStepsAsync(validationSteps(problem, K, config, options), options.sliceMs);
}
