/**
 * The boundary space's kernel for the generic search methods (packages/methods/src/kernel.ts,
 * docs/methods/dimensions/README.md): P unit balls or unit cubes on the boundary of a polytope
 * (the tesseract), the pieces folding across ridges. It is the boundary search (search/search.ts)
 * taken apart: its model's energy (search/model.ts, balls.ts, cubes.ts), its charts (chart.ts),
 * its structured starts and its finalize stage, with validateBoundary as the judge.
 *
 * State. aux holds each piece's anchor: a cell and a centre in that cell's local frame, recorded
 * at the edge s0 (aux.s0). At the state's size the anchor is that centre scaled by size / s0 about
 * the cell's centre, so the anchors move with the container. x holds each piece's displacement
 * from its anchor, 3 lengths in the anchor's frame. The piece's centre is the end of the straight
 * segment from the anchor along it, unfolded across every ridge it crosses (the chart's
 * exponential map, Charts.move), as in the search's relaxation. rebase moves every anchor to its
 * piece's centre and zeroes x. The size is the edge s, the score.
 *
 * Energy: the model's penalty energy at the centres, weighted per piece (model.ts TermOptions).
 * Its gradient in a piece's x is M^T times its gradient at the centre, M being the linear part of
 * the gluings crossed (as in the search). In the size it is the model's dE/ds at fixed centres plus
 * the centres' own motion: the geometry at edge s is the edge-1 geometry scaled by s, so a centre
 * y = s G(a, v / s) (a the anchor at edge 1, v the displacement) moves as dy/ds = (y - M v) / s.
 * A segment that meets a hinge (an edge of the polytope) has no continuation; such a displacement
 * (a set of measure zero) leaves its piece at the anchor, with no derivative in x. So does one
 * longer than MAX_WALK_EDGES edges, far beyond any geodesic the boundary needs.
 *
 * Moves change x only, so writing a piece's x back undoes them: jiggle adds to it, and randomPose
 * writes the displacement to a uniformly random target along the shortest geodesic
 * (kernel-pose.ts). Anchors change only in rebase.
 *
 * finish: the search's finalize (finalizeState) with `shrink`. The scale of the configuration is
 * bisected between where the model's exact rule fails and where it holds, so a state with room is
 * drawn in and an overlapping one pushed out (by at most a factor 2); then it is nudged up until
 * validateBoundary accepts it at tolerance 0. validate: the server's rule (kernel-validate.ts),
 * the problem's lower bound included.
 *
 * Cubes stay axis-aligned: the cube model's exact rule covers aligned cubes only (search/model.ts
 * describes what turned cubes would need), and the kernel never produces what its model cannot
 * judge. A configuration with a turned cube is not one the kernel can start from (fromConfig gives
 * null), unless its rotation is a symmetry of the cube.
 *
 * Capabilities: "seeds" (the cell layouts of kernel-seeds.ts; for cubes also the search's two
 * rings), and for balls "shape", a no-op (a ball is its own inscribed ball). Cubes have no soft
 * shapes (the cube model has no rounded cubes), and no piece has an orientation to swap.
 */
import type { Finished, KernelCapability, KernelState, Rng, SpaceKernel, Validation } from "@polypack/methods";
import { formatBoundaryId, isPieceCount, isPieceName } from "./ids";
import { displacementTo } from "./kernel-pose";
import { cellLayout } from "./kernel-seeds";
import { BOUNDARY_SERVER_RULE, boundaryBound, serverForm, serverRule } from "./kernel-validate";
import { getPolytope, isPolytopeName } from "./polytope";
import { type Charts, chartsOf, randomCellPoint } from "./search/chart";
import type { PieceModel, State } from "./search/model";
import { randInt } from "./search/random";
import { finalizeState, modelOf } from "./search/search";
import type { BoundaryConfig, BoundaryProblem, PieceName, PolytopeName } from "./types";
import { validateBoundary } from "./validate";

export { BOUNDARY_SERVER_RULE, boundaryBound } from "./kernel-validate";

/**
 * Energy evaluations one finish() and one validate() cost. A finish is one validator call (at
 * tolerance 0) and 20 to 45 evaluations of the model's rule; a validate is one validator call.
 * [CALC] In process CPU time, relative to an energy() call with its gradient, on squeezed random
 * starts and on the records at P = 4, 8, 12 and 16: finish median 930, validate median 960, each
 * from about 360 to 4300 (cubes at P = 4, near s = 1, cost most). docs/spaces/BOUNDARY.md section 14.
 */
export const BOUNDARY_FINISH_COST = 1000;
export const BOUNDARY_VALIDATE_COST = 1000;

/** The anchors (aux of a state): cells and centres, the centres recorded at edge s0. */
interface Anchors {
  cells: Int32Array;
  U: Float64Array;
  s0: number;
}

/** A displacement longer than this many edges is walked in parts (Charts.move gives up after 64 crossings). */
const WALK_EDGES = 8;
/**
 * A displacement longer than this many edges leaves its piece at the anchor, so that no
 * displacement costs more than 8 parts. It is far beyond the boundary's diameter: [CALC] over
 * 80,000 random pairs of points the shortest geodesic was at most 2.3 s.
 */
const MAX_WALK_EDGES = 64;
/** Targets randomPose draws before it gives up and leaves the piece where it is. */
const POSE_TRIES = 16;

export function boundaryKernel(problem: { polytope: PolytopeName; piece: PieceName; P: number }): SpaceKernel {
  if (!problem || !isPolytopeName(problem.polytope) || !isPieceName(problem.piece) || !isPieceCount(problem.P))
    throw new Error("boundaryKernel: invalid problem");
  // the server takes no larger P, so a method could never submit what such a kernel finds
  if (problem.P > BOUNDARY_SERVER_RULE.maxP)
    throw new Error(`boundaryKernel: P = ${problem.P} is above the server's largest, ${BOUNDARY_SERVER_RULE.maxP}`);
  const prob: BoundaryProblem = { polytope: problem.polytope, piece: problem.piece, P: problem.P };
  const { P, piece } = prob;
  const poly = getPolytope(prob.polytope);
  const charts = chartsOf(poly);
  const model: PieceModel = modelOf(prob);
  const n = 3 * P;
  const ball = piece === "ball";
  // a typical step: the piece's inradius (a ball's radius 1, half a cube's edge)
  const step = ball ? 1 : 0.5;

  // scratch for the centres of a state (nothing in it outlives one call)
  const placed: State = { cells: new Int32Array(P), U: new Float64Array(n) };
  const Ms = new Float64Array(9 * P);
  const gU = new Float64Array(n);
  const ds = new Float64Array(1);
  const start = new Float64Array(3);
  const partM = new Float64Array(9);
  // 1 where a piece's path has no continuation (it is left at its anchor, with no derivative in x)
  const stuck = new Uint8Array(P);
  const poseU = new Float64Array(3);
  const poseM = new Float64Array(9);
  // the problem's lower bound as the server applies it (cubes: turned ones included)
  const serverBound = boundaryBound(piece, P);

  const anchorsOf = (s: KernelState) => s.aux as Anchors;

  /**
   * The pieces of s at their centres (cells and U at s.size, in the scratch `placed`), with each
   * map's linear part in Ms (zero for a piece left at its anchor).
   */
  const place = (s: KernelState): State => {
    const a = anchorsOf(s);
    const size = s.size;
    const k = size === a.s0 ? 1 : size / a.s0;
    const x = s.x;
    for (let q = 0; q < P; q++) {
      const o = 3 * q;
      start[0] = a.U[o] * k;
      start[1] = a.U[o + 1] * k;
      start[2] = a.U[o + 2] * k;
      const ax = start[0];
      const ay = start[1];
      const az = start[2];
      const c = walk(charts, a.cells[q], start, x[o], x[o + 1], x[o + 2], size, placed.U, o, Ms, 9 * q, partM);
      stuck[q] = c >= 0 ? 0 : 1;
      if (c >= 0) placed.cells[q] = c;
      else {
        placed.cells[q] = a.cells[q];
        placed.U[o] = ax;
        placed.U[o + 1] = ay;
        placed.U[o + 2] = az;
        Ms.fill(0, 9 * q, 9 * q + 9);
      }
    }
    return placed;
  };

  const stateOf = (st: State, size: number): KernelState => ({
    x: new Float64Array(n),
    size,
    aux: { cells: Int32Array.from(st.cells), U: Float64Array.from(st.U), s0: size } satisfies Anchors,
  });

  const accept = (config: BoundaryConfig) => validateBoundary(prob, config, { tol: 0 }).ok;

  const capabilities: KernelCapability[] = ball ? ["shape", "seeds"] : ["seeds"];

  const kernel: SpaceKernel = {
    space: "boundary",
    id: formatBoundaryId(prob),
    P,
    dim: 3,
    steps: Float64Array.from([step, step, step]),
    // s is the polytope's edge, a length; a ball's inradius is 1, a cube's 1/2
    inradius: step,
    globals: 0,
    globalSteps: new Float64Array(0),
    // balls: the proven bound max(one ball, volume); cubes: max(1, volume), below which no aligned
    // cube packing exists (the problem's own bound for cubes, 1 / sqrt 2, allows turned cubes)
    bound: model.floor,
    finishCost: BOUNDARY_FINISH_COST,
    validateCost: BOUNDARY_VALIDATE_COST,
    capabilities,

    fromConfig(config) {
      // only what the server could take: its form and limits (s and coordinates at most 1e4, a
      // ball without rotation; P <= 64 is the factory's); then a cube's rotation must be a symmetry
      // of the cube (model.stateOf), the model judging aligned cubes only
      if (serverForm(prob, config).length) return null;
      const c = config as BoundaryConfig;
      const st = model.stateOf(c);
      return st ? stateOf(st, c.s) : null;
    },

    toConfig(s): BoundaryConfig {
      return { s: s.size, pieces: model.pieces(place(s), s.size) };
    },

    clone(s) {
      const a = anchorsOf(s);
      return {
        x: Float64Array.from(s.x),
        size: s.size,
        aux: { cells: Int32Array.from(a.cells), U: Float64Array.from(a.U), s0: a.s0 } satisfies Anchors,
      };
    },

    rebase(s) {
      const st = place(s);
      const a = anchorsOf(s);
      a.cells.set(st.cells);
      a.U.set(st.U);
      a.s0 = s.size;
      s.x.fill(0);
    },

    randomStart(rng) {
      if (ball) {
        const s = model.startEdge();
        return stateOf(model.randomState(s, rng), s);
      }
      // cubes: the search's start up to P = 16 (edge 2, each cube inside its cell, its centre
      // within 1/2 of the cell's); for more, an edge at which the cubes fill at most a quarter of
      // the boundary (8 s^3 >= 4 P), each cube still inside its cell. [CALC] At edge 2, random
      // starts of P = 26, 27 and 31 to 64 cubes often relaxed to nothing finish could use.
      const s = Math.max(model.startEdge(), Math.cbrt(P / 2));
      const cells = new Int32Array(P);
      const U = new Float64Array(n);
      for (let q = 0; q < P; q++) {
        cells[q] = randInt(rng, 8);
        U.set(randomCellPoint(poly, cells[q], s, rng, 1 - 1 / s), 3 * q);
      }
      return stateOf({ cells, U }, s);
    },

    randomPose(s, i, rng) {
      // a target as the search's hops draw one: any cell; balls kept off the edges (0.6 of the way
      // out), cubes anywhere. It becomes piece i's displacement from its anchor (kernel-pose.ts),
      // checked by walking it; a target the walk misses (within rounding of a hinge or a ridge) is
      // drawn again, and after POSE_TRIES misses the piece stays where it is
      const a = anchorsOf(s);
      const size = s.size;
      const k = size === a.s0 ? 1 : size / a.s0;
      const from = [a.U[3 * i] * k, a.U[3 * i + 1] * k, a.U[3 * i + 2] * k];
      const tol = 1e-9 * Math.max(1, size);
      for (let t = 0; t < POSE_TRIES; t++) {
        const cell = randInt(rng, poly.cells.length);
        const u = randomCellPoint(poly, cell, size, rng, ball ? 0.6 : 1);
        const v = displacementTo(a.cells[i], from, cell, u, size);
        if (!v) continue;
        start.set(from);
        const c = walk(charts, a.cells[i], start, v[0], v[1], v[2], size, poseU, 0, poseM, 0, partM);
        if (
          c !== cell ||
          !(Math.max(Math.abs(poseU[0] - u[0]), Math.abs(poseU[1] - u[1]), Math.abs(poseU[2] - u[2])) <= tol)
        )
          continue;
        s.x.set(v, 3 * i);
        return;
      }
    },

    jiggle(s, i, amount, rng) {
      for (let m = 0; m < 3; m++) s.x[3 * i + m] += (2 * rng() - 1) * amount * step;
    },

    setSize(s, size) {
      // the anchors scale with the size; scaling the displacements too scales every centre exactly
      // (the geometry at edge k s is the one at edge s scaled by k)
      const k = size / s.size;
      for (let i = 0; i < n; i++) s.x[i] *= k;
      s.size = size;
    },

    energy(s, grad, weights) {
      const st = place(s);
      const size = s.size;
      if (!grad) return model.terms(st, size, null, false, { w: weights ?? null });
      const e = model.terms(st, size, gU, false, { w: weights ?? null, ds });
      let dsize = ds[0];
      const x = s.x;
      for (let q = 0; q < P; q++) {
        const o = 3 * q;
        const m = 9 * q;
        const ga = gU[o];
        const gb = gU[o + 1];
        const gc = gU[o + 2];
        // dE/dv = M^T dE/dy
        grad[o] = Ms[m] * ga + Ms[m + 3] * gb + Ms[m + 6] * gc;
        grad[o + 1] = Ms[m + 1] * ga + Ms[m + 4] * gb + Ms[m + 7] * gc;
        grad[o + 2] = Ms[m + 2] * ga + Ms[m + 5] * gb + Ms[m + 8] * gc;
        // the centre's motion with the size: dy/ds = (y - M v) / s (y / s for a piece at its anchor)
        const free = stuck[q] ? 0 : 1;
        const v0 = free && x[o];
        const v1 = free && x[o + 1];
        const v2 = free && x[o + 2];
        const d0 = st.U[o] - (Ms[m] * v0 + Ms[m + 1] * v1 + Ms[m + 2] * v2);
        const d1 = st.U[o + 1] - (Ms[m + 3] * v0 + Ms[m + 4] * v1 + Ms[m + 5] * v2);
        const d2 = st.U[o + 2] - (Ms[m + 6] * v0 + Ms[m + 7] * v1 + Ms[m + 8] * v2);
        dsize += (ga * d0 + gb * d1 + gc * d2) / size;
      }
      grad[n] = dsize;
      return e;
    },

    pieceEnergy(s, i, weights) {
      return model.terms(place(s), s.size, null, false, { w: weights ?? null, focus: i });
    },

    clear(s, i, tol) {
      return model.terms(place(s), s.size, null, true, { focus: i }) <= tol;
    },

    finish(s): Finished | null {
      const st = place(s);
      const copy: State = { cells: Int32Array.from(st.cells), U: Float64Array.from(st.U) };
      const f = finalizeState(model, copy, s.size, accept, { shrink: true });
      return f ? { config: f.config, score: f.score } : null;
    },

    validate(config): Validation {
      return serverRule(prob, config, serverBound);
    },

    seeds(rng: Rng, count: number) {
      const out: KernelState[] = [];
      for (let t = 0; t < count; t++) {
        // cubes alternate the two rings (first) and the cell layout
        const built = !ball && t % 2 === 0 ? model.constructedStart(rng) : cellLayout(piece, P, rng);
        if (built) out.push(stateOf(built.st, built.s));
      }
      return out;
    },
  };
  // a ball is its own inscribed ball: every soft shape is the ball itself
  if (ball) kernel.setShape = () => {};
  return kernel;
}

/**
 * Charts.move for a displacement of any length: one call when it is shorter than WALK_EDGES
 * edges, else in equal parts, each started where and in the frame the previous one ended (the
 * exponential map follows one straight segment, so its parts compose and their linear parts
 * multiply). Returns the end cell, or -1 when the segment meets a hinge. `p` holds the start
 * point and is overwritten; `partM` is scratch (9 numbers).
 */
function walk(
  charts: Charts,
  cell: number,
  p: Float64Array,
  v0: number,
  v1: number,
  v2: number,
  s: number,
  outU: Float64Array,
  ou: number,
  outM: Float64Array,
  om: number,
  partM: Float64Array,
): number {
  const len = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);
  // too long (or not a number): no continuation
  if (!(len <= MAX_WALK_EDGES * s)) return -1;
  const parts = Math.ceil(len / (WALK_EDGES * s));
  if (!(parts > 1)) return charts.move(cell, p, 0, v0, v1, v2, s, outU, ou, outM, om);
  const M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const N = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  // d: one part of the displacement, in the frame of the cell it starts in
  let d0 = v0 / parts;
  let d1 = v1 / parts;
  let d2 = v2 / parts;
  let c = cell;
  for (let t = 0; t < parts; t++) {
    c = charts.move(c, p, 0, d0, d1, d2, s, p, 0, partM, 0);
    if (c < 0) return -1;
    const A = partM;
    const e0 = A[0] * d0 + A[1] * d1 + A[2] * d2;
    const e1 = A[3] * d0 + A[4] * d1 + A[5] * d2;
    const e2 = A[6] * d0 + A[7] * d1 + A[8] * d2;
    d0 = e0;
    d1 = e1;
    d2 = e2;
    for (let r = 0; r < 3; r++)
      for (let q = 0; q < 3; q++) N[3 * r + q] = A[3 * r] * M[q] + A[3 * r + 1] * M[3 + q] + A[3 * r + 2] * M[6 + q];
    for (let i = 0; i < 9; i++) M[i] = N[i];
  }
  outU[ou] = p[0];
  outU[ou + 1] = p[1];
  outU[ou + 2] = p[2];
  for (let i = 0; i < 9; i++) outM[om + i] = M[i];
  return c;
}
