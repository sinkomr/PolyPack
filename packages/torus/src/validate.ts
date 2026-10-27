import { runSteps, runStepsAsync } from "@polypack/methods";
/**
 * Float validator for packings on flat tori. Not a proof: the rigorous certificate is
 * python/torus/certify_torus.py (interval arithmetic). This module is the shared float
 * check used by tests and viewers, built on the PolyPack geometry kernel.
 */
import { Pose, TOL, boundingRadius, isShapeCode, pieceArea, pieceSeparation } from "@polypack/geometry";
import { Lattice, TorusFamily, cellArea, latticeImages, torusScore } from "./lattice";

export interface TorusPacking {
  family: TorusFamily;
  /** 0 = disk of radius 1, N >= 3 = regular N-gon of side 1 */
  N: number;
  lattice: Lattice;
  poses: readonly Pose[];
}

export interface ImageContact {
  /** piece index */
  i: number;
  /** other piece index (j >= i) */
  j: number;
  /** lattice vector m b1 + n b2 applied to piece j */
  m: number;
  n: number;
  /** signed SAT separation (exact distance for disks; penetration depth when negative) */
  sep: number;
}

export interface TorusValidation {
  valid: boolean;
  /** smallest separation over all image pairs within reach (Infinity if none) */
  minSep: number;
  /** pairs with sep < -tol */
  overlaps: ImageContact[];
  /** pairs with |sep| <= contactTol (for drawing contact graphs) */
  contacts: ImageContact[];
  /** image pairs tested exactly */
  pairsChecked: number;
  score: number;
  density: number;
  errors: string[];
}

export interface ValidateOptions {
  /** overlap tolerance in piece units (default: the shared TOL = 1e-9) */
  tol?: number;
  maxErrors?: number;
  /** shrink factor applied to every piece about its centre (certificate-style checks) */
  scale?: number;
  /** contacts reported when |sep| <= contactTol */
  contactTol?: number;
}

/** Shift a pose by a vector (pieces are translated, never rotated, by lattice vectors). */
function shifted(p: Pose, v: readonly [number, number]): Pose {
  return { x: p.x + v[0], y: p.y + v[1], theta: p.theta };
}

/**
 * Check every pair (i, j >= i) and every lattice vector lambda with (i, lambda) != (j, 0) for
 * which the centres are closer than twice the bounding radius (farther pairs cannot overlap,
 * because each piece lies in its bounding disk). Lattice vectors come from the Cramer window in
 * `latticeImages`, so an unreduced basis is handled correctly.
 */
export function* validationSteps(p: TorusPacking, opts: ValidateOptions = {}): Generator<void, TorusValidation> {
  const tol = opts.tol ?? TOL;
  const scale = opts.scale ?? 1;
  const contactTol = opts.contactTol ?? 1e-7;
  const errors: string[] = [];
  const empty = (): TorusValidation => ({
    valid: false,
    minSep: NaN,
    overlaps: [],
    contacts: [],
    pairsChecked: 0,
    score: NaN,
    density: NaN,
    errors,
  });
  if (
    !p ||
    !Array.isArray(p.poses) ||
    !p.lattice ||
    !Array.isArray(p.lattice.b1) ||
    p.lattice.b1.length !== 2 ||
    !Array.isArray(p.lattice.b2) ||
    p.lattice.b2.length !== 2
  ) {
    errors.push("packing needs poses and a lattice with two vectors");
    return empty();
  }
  if (!isShapeCode(p.N)) errors.push(`invalid shape code ${p.N}`);
  if (p.poses.length === 0) errors.push("no pieces");
  for (const [k, q] of p.poses.entries()) {
    if (!q || ![q.x, q.y, q.theta].every(Number.isFinite)) errors.push(`pose ${k} is not finite`);
  }
  const l = p.lattice;
  if (![l.b1[0], l.b1[1], l.b2[0], l.b2[1]].every(Number.isFinite)) errors.push("lattice is not finite");
  const area = cellArea(l);
  if (!(area > 0)) errors.push("lattice is degenerate");
  if (!(scale > 0 && scale <= 1)) errors.push("scale must be in (0, 1]");
  if (errors.length) return empty();

  // centres at least 2R apart cannot overlap; the small margin keeps exact contacts
  // (disks at distance exactly 2) in the reported contact list
  const reach = 2 * boundingRadius(p.N) * scale + 2 * Math.max(contactTol, tol);
  const overlaps: ImageContact[] = [];
  const contacts: ImageContact[] = [];
  let minSep = Infinity;
  let pairsChecked = 0;
  const P = p.poses.length;
  try {
    pairs: for (let i = 0; i < P; i++) {
      const a = p.poses[i];
      for (let j = i; j < P; j++) {
        const b = p.poses[j];
        const imgs = latticeImages(l, [b.x - a.x, b.y - a.y], reach, i === j);
        for (const im of imgs) {
          // place piece i at the origin: pieceSeparation only uses relative positions
          const sep = pieceSeparation(
            p.N,
            { x: 0, y: 0, theta: a.theta },
            shifted({ x: 0, y: 0, theta: b.theta }, im.v),
            scale,
          ).sep;
          pairsChecked++;
          if (sep < minSep) minSep = sep;
          const c = { i, j, m: im.m, n: im.n, sep };
          if (sep < -tol) overlaps.push(c);
          if (Math.abs(sep) <= contactTol) contacts.push(c);
          yield;
          if (overlaps.length >= (opts.maxErrors ?? Infinity)) break pairs;
        }
        yield;
      }
    }
  } catch (e) {
    errors.push(String((e as Error).message ?? e));
    return empty();
  }
  return {
    valid: overlaps.length === 0,
    minSep,
    overlaps,
    contacts,
    pairsChecked,
    score: torusScore(p.family, l),
    density: (P * pieceArea(p.N)) / area,
    errors,
  };
}

/** Scale a packing about the origin (lattice and centres; pieces keep their size). */
export function scalePacking(p: TorusPacking, k: number): TorusPacking {
  return {
    ...p,
    lattice: { b1: [p.lattice.b1[0] * k, p.lattice.b1[1] * k], b2: [p.lattice.b2[0] * k, p.lattice.b2[1] * k] },
    poses: p.poses.map((q) => ({ x: q.x * k, y: q.y * k, theta: q.theta })),
  };
}

/** Lower bound on the score from the area: P * A_piece / densityBound <= cell area. */
export function areaScoreBound(family: TorusFamily, N: number, P: number, densityBound = 1): number {
  const area = (P * pieceArea(N)) / densityBound;
  return family === "hex" ? Math.sqrt(area / (Math.sqrt(3) / 2)) : Math.sqrt(area);
}

export function validateTorusPacking(p: TorusPacking, opts: ValidateOptions = {}): TorusValidation {
  return runSteps(validationSteps(p, opts));
}
export function validateTorusPackingAsync(p: TorusPacking, opts: ValidateOptions & { sliceMs?: number } = {}) {
  return runStepsAsync(validationSteps(p, opts), opts.sliceMs);
}
