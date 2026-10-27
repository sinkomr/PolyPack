import { runSteps, runStepsAsync } from "@polypack/methods";
/**
 * Configuration parsing and validation of the spaces, with the work bounds the server needs for
 * untrusted input. Each space is checked by its own floating-point validator (packages/surface,
 * curved, sphere, torus, polyhedra) at PolyPack's touching tolerance SPACE_TOL = 1e-9: pieces may touch, and
 * an overlap or protrusion deeper than 1e-9 rejects the configuration. This is a float check, like
 * every other site entry; the research records' interval certificates are separate.
 *
 * Beating a research record: a configuration whose size is below the record's certified size by
 * more than the space's record margin (SPACE_RECORD_MARGIN: the tie tolerance, 1e-6 for polyhedra)
 * must also pass the validator at SPACE_STRICT_TOL = 1e-11. Without
 * this, a record's own configuration shrunk by about 1e-9 (its pieces then overlap by up to the
 * touching tolerance) would "beat" it; every research record passes at 1e-11 at its stated size.
 * A problem without a research record (status `no_record`, option `noRecord`) asks the strict check of every
 * entry, so that its leader is strictly valid too and cannot be "beaten" by its own configuration shrunk.
 *
 * Work bounds (every validator is at most quadratic in P, so these keep one check short):
 *  - P is at most SPACE_MAX_P of the space (the largest catalogue P when this was written; a test
 *    fails if the catalogue grows beyond it, so that the bounds are measured again);
 *  - sizes are at most SPACE_MAX_SIZE and coordinates, angles and quaternion components at most
 *    SPACE_MAX_COORD in absolute value;
 *  - the size must reach the problem's lower bound (minus 1e-9 relative), which also keeps a solid
 *    or a torus from being far too small for its pieces;
 *  - surface, fold: at most SURFACE_MAX_CHAINS chains of faces per piece;
 *  - torus: at most TORUS_MAX_TRANSLATES lattice translates per pair of pieces, and no lattice
 *    vector shorter than the piece's width (which would make a piece overlap its own translate);
 *  - boundary: s at most the boundary package's MAX_S = 1e4, at most BOUNDARY_MAX_CHAINS chains of
 *    cells per piece; the validator's volume bound refuses a polytope far too small for its pieces
 *    before any chain is enumerated, and its pair stages bin the pieces in a grid, so their work is
 *    linear in P.
 */
import { BoundaryConfig, PieceName, PolytopeName, getPolytope, validateBoundary } from "@polypack/boundary";
import { CurvedConfig, containerCircumradius, validationSteps as curvedSteps } from "@polypack/curved";
import { SCORE_TIE, boundingRadius, pieceInradius } from "@polypack/geometry";
import { SphereConfig, validationSteps as sphereSteps } from "@polypack/sphere";
import {
  ChainLimitError,
  SolidName,
  SurfaceConfig,
  getSolid,
  validate as validateSurface,
  validateAsync as validateSurfaceAsync,
} from "@polypack/surface";
import {
  Lattice,
  TORUS_MAX_P,
  TorusFamily,
  gaussReduce,
  maxImageCandidates,
  torusScore,
  validationSteps as torusSteps,
} from "@polypack/torus";
import {
  POLYHEDRA_MAX_P,
  type PolyhedraConfig,
  getProblem as getPolyhedraProblem,
  parsePolyhedraConfig,
  validatePolyhedra,
  validatePolyhedraAsync,
} from "@polypack/polyhedra";
import { type BallsConfig, getBallsProblem, ballsConfigErrors, validateBalls } from "@polypack/balls";
import { ParsedSpaceId, parseSpaceId } from "./ids";
import {
  BOUNDARY_MAX_CHAINS,
  BOUNDARY_MAX_S,
  SPACE_MAX_COORD,
  SPACE_MIN_QUATERNION_NORM,
  SPACE_RECORD_MARGIN,
  SPACE_STRICT_TOL,
  SPACE_TOL,
  SURFACE_MAX_CHAINS,
  TORUS_MAX_TRANSLATES,
} from "./info";
import { SpaceConfig, SpaceName } from "./types";

/**
 * Largest P each space accepts: its catalogue or domain cap (polyhedra P <= 500, 2026-10-26),
 * and for boundary (catalogue P <= 16) room for a larger catalogue: [CALC] checks of 64 pieces took
 * at most about 20 ms (docs/ARCHITECTURE.md). The server also caps P at its loaded catalogue's.
 * Surface, curved and sphere have domains with P <= 100; torus P <= 500 (2026-10-27).
 * Their server checks yield in slices, including torus storage rechecks; many-piece checks share
 * the heavy queue (also many-sided sphere pairs at small P).
 * Surface: [CALC] A check of 100 pieces stops at the first MAX_REASONS overlaps and
 * compares only parts closer than two circumradii; without that, 100 coincident 100-gons took up to
 * 0.57 s (random configurations of 100 pieces about 0.1 s). On a server the check runs in slices
 * (validateSpaceSubmissionAsync), and checks of many pieces are queued like the polyhedra ones.
 */
export const SPACE_MAX_P: Record<SpaceName, number> = {
  surface: 100,
  curved: 100,
  sphere: 100,
  torus: TORUS_MAX_P,
  boundary: 64,
  polyhedra: POLYHEDRA_MAX_P,
  // [CALC] a check of 100 balls is about 5,000 distance tests; of 100 dodecahedra about 2 ms
  balls: 100,
};
/** Largest size (s, size, rho, L, lattice vector component) accepted. */
export const SPACE_MAX_SIZE = 1e6;
/** Relative slack below the lower bound that a size may have (float rounding of the bound). */
export const SPACE_BOUND_SLACK = 1e-9;
/** The reason given when a configuration beats a research record only within the touching tolerance. */
export const SPACE_STRICT_REASON = `beats the research record only within the float tolerance; an improvement must be valid at tolerance ${SPACE_STRICT_TOL}`;
/** The reason given when an entry of a problem without a research record is valid only within the touching tolerance. */
export const SPACE_STRICT_NO_RECORD_REASON = `valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance ${SPACE_STRICT_TOL}`;
/** Overlap reasons listed at most per verdict. */
const MAX_REASONS = 20;

/** How a check ended: `valid`, or why not; `malformed` marks input that is not a configuration at all (HTTP 400). */
export interface SpaceVerdict {
  valid: boolean;
  /** The size stated in the configuration (null when it could not be read). */
  score: number | null;
  reasons: string[];
  /** True when the input is not a well-formed configuration of the space (as opposed to an invalid packing). */
  malformed: boolean;
  /** The configuration with only its known fields, as it is stored. */
  config: SpaceConfig | null;
}

export interface SpaceValidateOptions {
  /** The problem's lower bound on the score; sizes below it (minus SPACE_BOUND_SLACK relative) are rejected unchecked. */
  bound?: number | null;
  /** Largest P accepted; SPACE_MAX_P of the space by default, and never more. */
  maxP?: number;
  /**
   * The research record's certified size (certified.score). A configuration below it by more than
   * the space's record margin (beatsSpaceRecord) must also be valid at SPACE_STRICT_TOL; without it
   * there is no strict check.
   */
  certified?: number | null;
  /** True when the problem has no research record (status `no_record`): every entry then needs the strict check. */
  noRecord?: boolean;
}

type Failure = { ok: false; malformed: boolean; errors: string[] };
type Parsed<T> = { ok: true; config: T; score: number } | Failure;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads finite numbers with a range; collects what is wrong. */
class Reader {
  errors: string[] = [];
  num(v: unknown, path: string, max: number, positive = false): number {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.errors.push(`${path} must be a finite number`);
      return NaN;
    }
    if (Math.abs(v) > max) this.errors.push(`${path} must be at most ${max} in absolute value`);
    else if (positive && !(v > 0)) this.errors.push(`${path} must be positive`);
    return v;
  }
  full(): boolean {
    return this.errors.length >= MAX_REASONS;
  }
  /** A failure of the pieces list, together with the errors read so far (which make it malformed). */
  failWith(f: Failure): Failure {
    return this.errors.length ? { ok: false, malformed: true, errors: [...this.errors, ...f.errors] } : f;
  }
}

/** The pieces array, or a message; a wrong length is an invalid packing, not malformed input. */
function piecesOf(raw: Record<string, unknown>, key: string, P: number): unknown[] | Failure {
  const list = raw[key];
  if (!Array.isArray(list)) return { ok: false, malformed: true, errors: [`${key} must be an array`] };
  if (list.length !== P)
    return { ok: false, malformed: false, errors: [`expected ${P} pieces for this problem, got ${list.length}`] };
  return list;
}

function parseSurface(
  raw: Record<string, unknown>,
  id: ParsedSpaceId,
): Parsed<{ s: number; pieces: SurfaceConfig["pieces"] }> {
  const r = new Reader();
  const F = getSolid(id.fields.solid as SolidName).F;
  const s = r.num(raw.s, "s", SPACE_MAX_SIZE, true);
  const list = piecesOf(raw, "pieces", id.P);
  if (!Array.isArray(list)) return r.failWith(list);
  const pieces = list.map((p, i) => {
    if (r.full()) return { face: 0, x: 0, y: 0, theta: 0 };
    if (!isObject(p)) {
      r.errors.push(`pieces[${i}] must be an object {face, x, y, theta}`);
      return { face: 0, x: 0, y: 0, theta: 0 };
    }
    if (!Number.isInteger(p.face) || (p.face as number) < 0 || (p.face as number) >= F)
      r.errors.push(`pieces[${i}].face must be an integer from 0 to ${F - 1}`);
    return {
      face: p.face as number,
      x: r.num(p.x, `pieces[${i}].x`, SPACE_MAX_COORD),
      y: r.num(p.y, `pieces[${i}].y`, SPACE_MAX_COORD),
      theta: r.num(p.theta, `pieces[${i}].theta`, SPACE_MAX_COORD),
    };
  });
  if (r.errors.length) return { ok: false, malformed: true, errors: r.errors };
  return { ok: true, config: { s, pieces }, score: s };
}

function parseCurved(raw: Record<string, unknown>, id: ParsedSpaceId): Parsed<CurvedConfig> {
  const r = new Reader();
  const size = r.num(raw.size, "size", SPACE_MAX_SIZE, true);
  const list = piecesOf(raw, "pieces", id.P);
  if (!Array.isArray(list)) return r.failWith(list);
  const pieces = list.map((p, i) => {
    if (r.full()) return { x: 0, y: 0, theta: 0 };
    if (!isObject(p)) {
      r.errors.push(`pieces[${i}] must be an object {x, y, theta}`);
      return { x: 0, y: 0, theta: 0 };
    }
    return {
      x: r.num(p.x, `pieces[${i}].x`, SPACE_MAX_COORD),
      y: r.num(p.y, `pieces[${i}].y`, SPACE_MAX_COORD),
      theta: r.num(p.theta, `pieces[${i}].theta`, SPACE_MAX_COORD),
    };
  });
  if (r.errors.length) return { ok: false, malformed: true, errors: r.errors };
  return { ok: true, config: { size, pieces }, score: size };
}

function parseSphere(raw: Record<string, unknown>, id: ParsedSpaceId): Parsed<SphereConfig> {
  const r = new Reader();
  const rho = r.num(raw.rho, "rho", SPACE_MAX_SIZE, true);
  const list = piecesOf(raw, "pieces", id.P);
  if (!Array.isArray(list)) return r.failWith(list);
  const pieces = list.map((p, i) => {
    const q = isObject(p) ? p.q : undefined;
    if (r.full()) return { q: [1, 0, 0, 0] as [number, number, number, number] };
    if (!Array.isArray(q) || q.length !== 4) {
      r.errors.push(`pieces[${i}] must be an object {q: [w, x, y, z]}`);
      return { q: [1, 0, 0, 0] as [number, number, number, number] };
    }
    const v = q.map((c, k) => r.num(c, `pieces[${i}].q[${k}]`, SPACE_MAX_COORD)) as [number, number, number, number];
    // a tiny quaternion's squared norm underflows, and its rotation is then undefined
    if (v.every(Number.isFinite) && !(Math.hypot(...v) >= SPACE_MIN_QUATERNION_NORM))
      r.errors.push(`pieces[${i}].q must have a norm of at least ${SPACE_MIN_QUATERNION_NORM.toExponential()}`);
    return { q: v };
  });
  if (r.errors.length) return { ok: false, malformed: true, errors: r.errors };
  return { ok: true, config: { rho, pieces }, score: rho };
}

type TorusLatticeSpec = { L: number } | { b1: [number, number]; b2: [number, number] };

function parseTorus(
  raw: Record<string, unknown>,
  id: ParsedSpaceId,
): Parsed<{ lattice: TorusLatticeSpec; poses: [number, number, number][] }> {
  const r = new Reader();
  const family = id.fields.family as TorusFamily;
  const l = raw.lattice;
  let lattice: TorusLatticeSpec = { L: NaN };
  let basis: Lattice | null = null;
  if (!isObject(l))
    r.errors.push(family === "free" ? "lattice must be {b1: [x, y], b2: [x, y]}" : "lattice must be {L}");
  else if (family !== "free") {
    if (!("L" in l) || "b1" in l || "b2" in l) r.errors.push(`a ${family} lattice is given as {L}`);
    else {
      const L = r.num(l.L, "lattice.L", SPACE_MAX_SIZE, true);
      lattice = { L };
      basis = family === "sq" ? { b1: [L, 0], b2: [0, L] } : { b1: [L, 0], b2: [L / 2, (L * Math.sqrt(3)) / 2] };
    }
  } else {
    const vec = (v: unknown, name: string): [number, number] => {
      if (!Array.isArray(v) || v.length !== 2) {
        r.errors.push(`lattice.${name} must be [x, y]`);
        return [NaN, NaN];
      }
      return [r.num(v[0], `lattice.${name}[0]`, SPACE_MAX_SIZE), r.num(v[1], `lattice.${name}[1]`, SPACE_MAX_SIZE)];
    };
    if ("L" in l) r.errors.push("a free lattice is given as {b1: [x, y], b2: [x, y]}");
    else {
      const b1 = vec(l.b1, "b1");
      const b2 = vec(l.b2, "b2");
      lattice = { b1, b2 };
      basis = { b1, b2 };
      if (b1.every(Number.isFinite) && b2.every(Number.isFinite) && !(Math.abs(b1[0] * b2[1] - b1[1] * b2[0]) > 0))
        r.errors.push("lattice.b1 and lattice.b2 must be linearly independent");
    }
  }
  const list = piecesOf(raw, "poses", id.P);
  if (!Array.isArray(list)) return r.failWith(list);
  const poses = list.map((p, i): [number, number, number] => {
    if (r.full()) return [0, 0, 0];
    if (!Array.isArray(p) || p.length !== 3) {
      r.errors.push(`poses[${i}] must be [x, y, theta]`);
      return [0, 0, 0];
    }
    return [
      r.num(p[0], `poses[${i}][0]`, SPACE_MAX_COORD),
      r.num(p[1], `poses[${i}][1]`, SPACE_MAX_COORD),
      r.num(p[2], `poses[${i}][2]`, SPACE_MAX_COORD),
    ];
  });
  if (r.errors.length || !basis) return { ok: false, malformed: true, errors: r.errors };
  return { ok: true, config: { lattice, poses }, score: torusScore(family, basis) };
}

/** Quaternion norms the boundary validator accepts as unit: within this of 1. */
const BOUNDARY_UNIT_SLACK = 1e-9;

function parseBoundary(raw: Record<string, unknown>, id: ParsedSpaceId): Parsed<BoundaryConfig> {
  const r = new Reader();
  const C = getPolytope(id.fields.polytope as PolytopeName).cells.length;
  const ball = (id.fields.piece as PieceName) === "ball";
  const s = r.num(raw.s, "s", BOUNDARY_MAX_S, true);
  const list = piecesOf(raw, "pieces", id.P);
  if (!Array.isArray(list)) return r.failWith(list);
  const pieces = list.map((p, i): BoundaryConfig["pieces"][number] => {
    const none = { cell: 0, u: [0, 0, 0] };
    if (r.full()) return none;
    if (!isObject(p)) {
      r.errors.push(`pieces[${i}] must be an object {cell, u${ball ? "" : ", q?"}}`);
      return none;
    }
    if (!Number.isInteger(p.cell) || (p.cell as number) < 0 || (p.cell as number) >= C)
      r.errors.push(`pieces[${i}].cell must be an integer from 0 to ${C - 1}`);
    let u = [0, 0, 0];
    // read by index, so that a hole in a sparse array is seen
    if (!Array.isArray(p.u) || p.u.length !== 3) r.errors.push(`pieces[${i}].u must be [u0, u1, u2]`);
    else u = [0, 1, 2].map((k) => r.num((p.u as unknown[])[k], `pieces[${i}].u[${k}]`, SPACE_MAX_COORD));
    const piece: BoundaryConfig["pieces"][number] = { cell: p.cell as number, u };
    if (p.q === undefined) return piece;
    if (ball) {
      r.errors.push(`pieces[${i}] is a ball and has no rotation q`);
      return piece;
    }
    if (!Array.isArray(p.q) || p.q.length !== 4) {
      r.errors.push(`pieces[${i}].q must be a unit quaternion [w, x, y, z]`);
      return piece;
    }
    const q = [0, 1, 2, 3].map((k) => r.num((p.q as unknown[])[k], `pieces[${i}].q[${k}]`, SPACE_MAX_COORD));
    if (q.every(Number.isFinite) && !(Math.abs(Math.hypot(...q) - 1) <= BOUNDARY_UNIT_SLACK))
      r.errors.push(`pieces[${i}].q must be a unit quaternion (norm within ${BOUNDARY_UNIT_SLACK} of 1)`);
    return { ...piece, q: q as [number, number, number, number] };
  });
  if (r.errors.length) return { ok: false, malformed: true, errors: r.errors };
  return { ok: true, config: { s, pieces }, score: s };
}

/**
 * The configuration of a problem in its space's own format, with only the known fields, and the
 * size it states. Errors are `malformed` when the input is not such a configuration (types,
 * ranges), and not when only the number of pieces is wrong.
 */
export function parseSpaceConfig(id: ParsedSpaceId, raw: unknown): Parsed<SpaceConfig> {
  if (!isObject(raw)) return { ok: false, malformed: true, errors: ["config must be an object"] };
  switch (id.space) {
    case "surface":
      return parseSurface(raw, id) as Parsed<SpaceConfig>;
    case "curved":
      return parseCurved(raw, id) as Parsed<SpaceConfig>;
    case "sphere":
      return parseSphere(raw, id) as Parsed<SpaceConfig>;
    case "torus":
      return parseTorus(raw, id) as unknown as Parsed<SpaceConfig>;
    case "boundary":
      return parseBoundary(raw, id) as unknown as Parsed<SpaceConfig>;
    case "polyhedra": {
      const r = parsePolyhedraConfig(raw, id.P, MAX_REASONS);
      return r.ok ? { ok: true, config: r.config as unknown as SpaceConfig, score: r.score } : r;
    }
    case "balls":
      return parseBalls(raw, id);
  }
}

/** A balls configuration: errors of form are malformed input, except a wrong number of pieces. */
function parseBalls(raw: Record<string, unknown>, id: ParsedSpaceId): Parsed<SpaceConfig> {
  const problem = getBallsProblem(String(id.fields.code));
  if (!problem) return { ok: false, malformed: true, errors: [`unknown balls problem ${String(id.fields.code)}`] };
  const errors = ballsConfigErrors(problem, raw, undefined, MAX_REASONS);
  if (errors.length) return { ok: false, malformed: true, errors };
  const list = piecesOf(raw, "pieces", id.P);
  if (!Array.isArray(list)) return list;
  const width = problem.piece === "ball" ? 3 : 7;
  const pieces = (raw.pieces as number[][]).map((p) => p.slice(0, width));
  return { ok: true, config: { s: raw.s as number, pieces }, score: raw.s as number };
}

/** Reasons from a validator, at most MAX_REASONS, with a fallback when it gave none. */
function reasonsOf(errors: string[], fallback: string): string[] {
  const list = errors.slice(0, MAX_REASONS);
  return list.length ? list : [fallback];
}

/** Runs the space's own validator on a parsed configuration at `tol`; reasons are empty when it is valid. */
function* check(id: ParsedSpaceId, config: SpaceConfig, tol: number): Generator<void, string[]> {
  const f = id.fields;
  switch (id.space) {
    case "surface": {
      const c = config as { s: number; pieces: SurfaceConfig["pieces"] };
      const cfg: SurfaceConfig = { solid: f.solid as SolidName, N: f.N as number, s: c.s, pieces: c.pieces };
      const v = validateSurface(cfg, f.mode as "fold" | "nofold", {
        tol,
        maxErrors: MAX_REASONS,
        maxChains: SURFACE_MAX_CHAINS,
      });
      return v.ok ? [] : reasonsOf(v.errors, `not a valid packing (smallest clearance ${v.minPairSep})`);
    }
    case "curved": {
      const c = config as unknown as CurvedConfig;
      const K = f.K as number;
      const M = f.M as number;
      // A piece's centre lies in its piece, so in the container: a cheap first test that also
      // keeps far-away centres (whose coordinates overflow at K < 0) from reaching the validator.
      // Its slack of 1e-6 is far above the tolerance, so it refuses nothing the validator would accept.
      const reach = containerCircumradius(M, K, c.size);
      if (Number.isFinite(reach)) {
        const far = c.pieces.findIndex((p) => !(Math.hypot(p.x, p.y) <= reach * (1 + 1e-6) + 1e-6));
        if (far >= 0) return [`the centre of piece ${far} lies outside the container`];
      }
      const v = yield* curvedSteps({ N: f.N as number, M, P: id.P }, K, c, { tol, maxErrors: MAX_REASONS });
      return v.valid ? [] : reasonsOf(v.errors, `not a valid packing (smallest gap ${v.minGap})`);
    }
    case "sphere": {
      const v = yield* sphereSteps({ N: f.N as number, P: id.P }, config as unknown as SphereConfig, {
        tol,
        maxErrors: MAX_REASONS,
      });
      if (v.valid) return [];
      if (v.errors.length) return reasonsOf(v.errors, "");
      const [i, j] = v.worstPair ?? [-1, -1];
      return [`pieces ${i} and ${j} overlap by ${-v.minGap}`];
    }
    case "torus": {
      const family = f.family as TorusFamily;
      const N = f.N as number;
      const c = config as unknown as { lattice: TorusLatticeSpec; poses: [number, number, number][] };
      const L = c.lattice;
      const lattice: Lattice =
        "L" in L
          ? family === "sq"
            ? { b1: [L.L, 0], b2: [0, L.L] }
            : { b1: [L.L, 0], b2: [L.L / 2, (L.L * Math.sqrt(3)) / 2] }
          : { b1: L.b1, b2: L.b2 };
      // A piece contains its inscribed disk, and its width in every direction is at least twice
      // the inradius r, so a piece and its translate by a lattice vector of length l overlap by at
      // least 2r - l. A lattice vector shorter than 2r - TOL is therefore an overlap the validator
      // would reject as well, and refusing it first keeps the enumeration below small.
      const shortest = gaussReduce(lattice).lattice.b1;
      const width = 2 * pieceInradius(N);
      const len = Math.hypot(shortest[0], shortest[1]);
      if (len < width - tol)
        return [
          `the lattice has a vector of length ${len}, shorter than the piece's width ${width}: every piece overlaps its own translate`,
        ];
      // the validator's enumeration window, per pair of pieces (see packages/torus/src/lattice.ts)
      const reachR = 2 * boundingRadius(N) + 2 * 1e-7;
      // the most candidates (m, n) that the loop of latticeImages visits for one pair, exactly its bound
      const translates = maxImageCandidates(lattice, reachR);
      if (!(translates <= TORUS_MAX_TRANSLATES))
        return [
          `the lattice basis is too skewed: up to ${translates} translates per pair would need checking (at most ${TORUS_MAX_TRANSLATES}); send a Lagrange-Gauss reduced basis`,
        ];
      const v = yield* torusSteps(
        { family, N, lattice, poses: c.poses.map(([x, y, theta]) => ({ x, y, theta })) },
        { tol, maxErrors: MAX_REASONS },
      );
      if (v.valid && !v.errors.length) return [];
      if (v.errors.length) return reasonsOf(v.errors, "");
      return v.overlaps
        .slice(0, MAX_REASONS)
        .map((o) =>
          o.i === o.j
            ? `piece ${o.i} overlaps its own translate by (${o.m}, ${o.n}) lattice vectors, by ${-o.sep}`
            : `pieces ${o.i} and ${o.j} overlap (translate (${o.m}, ${o.n})) by ${-o.sep}`,
        );
    }
    case "boundary": {
      const problem = { polytope: f.polytope as PolytopeName, piece: f.piece as PieceName, P: id.P };
      // the validator's own volume bound and in-cell edge tests run before any chain is enumerated
      const v = validateBoundary(problem, config, { tol, maxReasons: MAX_REASONS, maxChains: BOUNDARY_MAX_CHAINS });
      return v.ok ? [] : reasonsOf(v.reasons, "not a valid packing");
    }
    case "polyhedra": {
      const problem = getPolyhedraProblem(f.code as string);
      if (!problem) return [`unknown polyhedra problem ${String(f.code)}`];
      const v = validatePolyhedra(problem, config as unknown as PolyhedraConfig, { tol, maxErrors: MAX_REASONS });
      return v.valid ? [] : reasonsOf(v.errors, `not a valid packing (smallest separation ${v.minPairSep})`);
    }
    case "balls": {
      const problem = getBallsProblem(String(f.code));
      if (!problem) return [`unknown balls problem ${String(f.code)}`];
      const v = validateBalls(problem, config as unknown as BallsConfig, { tol, maxErrors: MAX_REASONS });
      return v.valid ? [] : reasonsOf(v.errors, `not a valid packing (smallest separation ${v.minPairSep})`);
    }
  }
}

/**
 * Checks a configuration for a problem of a space: the id, the number of pieces, the work bounds,
 * the lower bound when one is given, and then the space's own validator at the size the
 * configuration states (TOL = 1e-9); when `certified` is given and the size beats it by more than
 * the space's record margin, also at SPACE_STRICT_TOL. It never throws; a validator that gives up (a
 * work limit) gives an invalid verdict with its reason.
 */
export function validateSpaceSubmission(
  space: SpaceName,
  id: string,
  rawConfig: unknown,
  opts: SpaceValidateOptions = {},
): SpaceVerdict {
  const prep = prepare(space, id, rawConfig, opts);
  if (!("run" in prep)) return prep;
  const reasons = prep.run((tol) => checked(prep.id, prep.config, tol));
  return prep.finish(reasons, (tol) => checked(prep.id, prep.config, tol));
}

/**
 * validateSpaceSubmission for a server: the same checks, with polyhedra, surface, curved, sphere and torus configurations checked
 * in slices that give the event loop a turn every `sliceMs` (validatePolyhedraAsync, the surface package's
 * validateAsync), so that no check of 100 large pieces holds the loop for long. `workMs` is the time the checks
 * took, without the turns.
 */
export async function validateSpaceSubmissionAsync(
  space: SpaceName,
  id: string,
  rawConfig: unknown,
  opts: SpaceValidateOptions & { sliceMs?: number } = {},
): Promise<SpaceVerdict & { workMs: number; slices: number; longestSliceMs: number }> {
  const t0 = performance.now();
  const prep = prepare(space, id, rawConfig, opts);
  const first = performance.now() - t0;
  if (!("run" in prep)) return { ...prep, workMs: first, slices: 1, longestSliceMs: first };
  let workMs = first;
  let slices = 1;
  let longestSliceMs = first;
  const run = async (tol: number): Promise<string[]> => {
    if (prep.id.space === "surface") {
      // the surface check in slices too: 100 many-sided pieces take a few hundred ms of work at worst
      const f = prep.id.fields;
      const c = prep.config as { s: number; pieces: SurfaceConfig["pieces"] };
      const cfg: SurfaceConfig = { solid: f.solid as SolidName, N: f.N as number, s: c.s, pieces: c.pieces };
      try {
        const v = await validateSurfaceAsync(cfg, f.mode as "fold" | "nofold", {
          tol,
          maxErrors: MAX_REASONS,
          maxChains: SURFACE_MAX_CHAINS,
          sliceMs: opts.sliceMs,
        });
        workMs += v.workMs;
        slices += v.slices;
        longestSliceMs = Math.max(longestSliceMs, v.longestSliceMs);
        return v.ok ? [] : reasonsOf(v.errors, `not a valid packing (smallest clearance ${v.minPairSep})`);
      } catch (e) {
        return [
          e instanceof ChainLimitError
            ? `the fold check gave up: ${e.message}`
            : `the check failed: ${e instanceof Error ? e.message : String(e)}`,
        ];
      }
    }
    if (["curved", "sphere", "torus"].includes(prep.id.space)) {
      try {
        // Include preflights and geometry in the same timed slices as the synchronous check.
        const v = await runStepsAsync(
          (function* () {
            return { reasons: yield* check(prep.id, prep.config, tol) };
          })(),
          opts.sliceMs,
        );
        workMs += v.workMs;
        slices += v.slices;
        longestSliceMs = Math.max(longestSliceMs, v.longestSliceMs);
        return v.reasons;
      } catch (e) {
        return [`the check failed: ${e instanceof Error ? e.message : String(e)}`];
      }
    }
    if (prep.id.space !== "polyhedra") {
      const t = performance.now();
      const r = checked(prep.id, prep.config, tol);
      workMs += performance.now() - t;
      longestSliceMs = Math.max(longestSliceMs, performance.now() - t);
      return r;
    }
    const problem = getPolyhedraProblem(prep.id.fields.code as string);
    if (!problem) return [`unknown polyhedra problem ${String(prep.id.fields.code)}`];
    const v = await validatePolyhedraAsync(problem, prep.config as unknown as PolyhedraConfig, {
      tol,
      maxErrors: MAX_REASONS,
      sliceMs: opts.sliceMs,
    });
    workMs += v.workMs;
    slices += v.slices;
    longestSliceMs = Math.max(longestSliceMs, v.longestSliceMs);
    return v.valid ? [] : reasonsOf(v.errors, `not a valid packing (smallest separation ${v.minPairSep})`);
  };
  const reasons = await run(SPACE_TOL);
  const strict = prep.needsStrict(reasons) ? await run(SPACE_STRICT_TOL) : [];
  return { ...prep.verdict(reasons, strict), workMs, slices, longestSliceMs };
}

/** check() that turns a thrown error into a reason. */
function checked(id: ParsedSpaceId, config: SpaceConfig, tol: number): string[] {
  try {
    return runSteps(check(id, config, tol));
  } catch (e) {
    return [
      e instanceof ChainLimitError
        ? `the fold check gave up: ${e.message}`
        : `the check failed: ${e instanceof Error ? e.message : String(e)}`,
    ];
  }
}

/**
 * What both checks share: the verdict on the id, P, the configuration's form and the lower bound, or what is
 * needed to finish: the parsed id and configuration, and the verdict from the check's reasons.
 */
function prepare(
  space: SpaceName,
  id: string,
  rawConfig: unknown,
  opts: SpaceValidateOptions,
):
  | SpaceVerdict
  | {
      id: ParsedSpaceId;
      config: SpaceConfig;
      run: (check: (tol: number) => string[]) => string[];
      finish: (reasons: string[], check: (tol: number) => string[]) => SpaceVerdict;
      needsStrict: (reasons: string[]) => boolean;
      verdict: (reasons: string[], strict: string[]) => SpaceVerdict;
    } {
  const fail = (
    reasons: string[],
    malformed: boolean,
    score: number | null = null,
    config: SpaceConfig | null = null,
  ): SpaceVerdict => ({
    valid: false,
    score,
    reasons,
    malformed,
    config,
  });
  const parsedId = parseSpaceId(space, id);
  if (typeof parsedId === "string") return fail([parsedId], true);
  const maxP = Math.min(opts.maxP ?? SPACE_MAX_P[space], SPACE_MAX_P[space]);
  if (parsedId.P > maxP)
    return fail([`P = ${parsedId.P} is above the largest P of the ${space} catalogue (${maxP})`], true);
  const parsed = parseSpaceConfig(parsedId, rawConfig);
  if (!parsed.ok) return fail(parsed.errors.slice(0, MAX_REASONS), parsed.malformed);
  const { config, score } = parsed;
  const bound = opts.bound;
  if (typeof bound === "number" && Number.isFinite(bound) && score < bound * (1 - SPACE_BOUND_SLACK))
    return fail([`the size ${score} is below the lower bound ${bound} of this problem`], false, score, config);
  const certified = opts.certified;
  const noRecord = opts.noRecord === true;
  const needsStrict = (reasons: string[]) =>
    !reasons.length && (noRecord || (typeof certified === "number" && beatsSpaceRecord(space, score, certified)));
  const verdict = (reasons: string[], strict: string[]): SpaceVerdict => {
    if (reasons.length) return fail(reasons, false, score, config);
    if (strict.length)
      return fail(
        [noRecord ? SPACE_STRICT_NO_RECORD_REASON : SPACE_STRICT_REASON, ...strict.slice(0, 3)],
        false,
        score,
        config,
      );
    return { valid: true, score, reasons: [], malformed: false, config };
  };
  return {
    id: parsedId,
    config,
    run: (c) => c(SPACE_TOL),
    finish: (reasons, c) => verdict(reasons, needsStrict(reasons) ? c(SPACE_STRICT_TOL) : []),
    needsStrict,
    verdict,
  };
}

/** True when `score` beats `best` by more than the tie tolerance (as on the main site: score < best (1 - SCORE_TIE)). */
export function beatsSpaceScore(score: number, best: number | null | undefined): boolean {
  return best === null || best === undefined || score < best * (1 - SCORE_TIE);
}

/**
 * True when `score` beats a research record's certified value by more than the space's record margin
 * (SPACE_RECORD_MARGIN: the tie tolerance, or 1e-6 for polyhedra, whose records keep a clearance).
 */
export function beatsSpaceRecord(space: SpaceName, score: number, certified: number | null | undefined): boolean {
  return certified === null || certified === undefined || score < certified * (1 - SPACE_RECORD_MARGIN[space]);
}

/**
 * True when an entry improves on a problem's best values: the research record by its space's record margin and
 * the site leader by the tie tolerance. For every space but polyhedra this is beating the smaller of the two by
 * the tie tolerance.
 */
export function improvesSpaceBest(
  space: SpaceName,
  score: number,
  certified: number | null | undefined,
  leader: number | null | undefined,
): boolean {
  return beatsSpaceRecord(space, score, certified) && beatsSpaceScore(score, leader);
}

/**
 * The configuration as the server stores it. A free torus lattice that is skewed or left-handed
 * is stored Lagrange-Gauss reduced with det(b1, b2) > 0: the same lattice, so the same packing and
 * score, in a basis that every reader can draw and search without a long walk over translates. The
 * poses stay as they are, since positions count modulo the lattice. The stored form is checked
 * again by the same rule and replaces the one sent only when it passes with the same score (to
 * within SCORE_TIE); anything else is stored as it was sent.
 */
function reducedSpaceConfig(space: SpaceName, id: string, config: SpaceConfig): SpaceConfig {
  if (space !== "torus") return config;
  const parsed = parseSpaceId(space, id);
  if (typeof parsed === "string" || parsed.fields.family !== "free") return config;
  const sent = config.lattice as { b1?: [number, number]; b2?: [number, number] } | undefined;
  if (!sent?.b1 || !sent?.b2) return config;
  const det0 = sent.b1[0] * sent.b2[1] - sent.b1[1] * sent.b2[0];
  const { b1, b2: r2 } = gaussReduce({ b1: sent.b1, b2: sent.b2 }).lattice;
  // -b2 spans the same lattice as b2
  const b2: [number, number] = b1[0] * r2[1] - b1[1] * r2[0] < 0 ? [-r2[0], -r2[1]] : [r2[0], r2[1]];
  const length2 = (u: readonly number[], v: readonly number[]) => u[0] ** 2 + u[1] ** 2 + v[0] ** 2 + v[1] ** 2;
  // a reduced, right-handed basis is kept as it was sent, so that stored records are not rewritten
  if (det0 > 0 && length2(b1, b2) >= length2(sent.b1, sent.b2) * (1 - 1e-12)) return config;
  return { ...config, lattice: { b1: [b1[0], b1[1]], b2 } };
}

export function storedSpaceConfig(
  space: SpaceName,
  id: string,
  config: SpaceConfig,
  opts: SpaceValidateOptions = {},
  sentScore?: number,
): SpaceConfig {
  const candidate = reducedSpaceConfig(space, id, config);
  if (candidate === config) return config;
  // `sentScore`: the score of the verdict that has just accepted `config`; the check is not repeated
  const before = { score: sentScore ?? validateSpaceSubmission(space, id, config, opts).score };
  const after = validateSpaceSubmission(space, id, candidate, opts);
  if (
    !after.valid ||
    !after.config ||
    before.score === null ||
    after.score === null ||
    Math.abs(after.score - before.score) > SCORE_TIE * before.score
  )
    return config;
  return after.config;
}

/** The storage recheck in slices too, including the work in the submission's heavy-check turn. */
export async function storedSpaceConfigAsync(
  space: SpaceName,
  id: string,
  config: SpaceConfig,
  opts: SpaceValidateOptions & { sliceMs?: number } = {},
  sentScore?: number,
): Promise<{ config: SpaceConfig; workMs: number; slices: number; longestSliceMs: number }> {
  const start = performance.now();
  const candidate = reducedSpaceConfig(space, id, config);
  const first = performance.now() - start;
  if (candidate === config) return { config, workMs: first, slices: 1, longestSliceMs: first };
  // `sentScore`: the score of the verdict that has just accepted `config`; the check is not repeated
  const before =
    sentScore !== undefined
      ? { score: sentScore, workMs: 0, slices: 0, longestSliceMs: 0 }
      : await validateSpaceSubmissionAsync(space, id, config, opts);
  const after = await validateSpaceSubmissionAsync(space, id, candidate, opts);
  const keep =
    after.valid &&
    after.config &&
    before.score !== null &&
    after.score !== null &&
    Math.abs(after.score - before.score) <= SCORE_TIE * before.score;
  return {
    config: keep ? after.config! : config,
    workMs: first + before.workMs + after.workMs,
    slices: 1 + before.slices + after.slices,
    longestSliceMs: Math.max(first, before.longestSliceMs, after.longestSliceMs),
  };
}
