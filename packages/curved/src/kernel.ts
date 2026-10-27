/**
 * The curved space's kernel for the generic search methods (packages/methods/src/kernel.ts,
 * docs/methods/dimensions/README.md, docs/spaces/CURVED.md "Kernel for the generic methods").
 *
 *  - State: each piece's chart offsets (u, v, phi) at an anchor pose (kernel-chart.ts; disks have
 *    no phi), and size = the container's side s (M >= 3) or radius r (M = 0), the score itself.
 *  - Starts: random centres spread over where a piece fits; rings about O as "seeds" (kernel-start.ts).
 *  - Energy: the package's gap rows squared (kernel-energy.ts), with soft shapes for "shape".
 *  - setSize: each centre's geodesic polar radius about O scaled by the ratio of the container's
 *    apothem (K <= 0) or circumradius (K > 0) at the new and old size (scaleRadius); directions
 *    and orientations (theta, relative to the frame carried from O) kept. At K = 0 this is the
 *    Euclidean homothety. Growth can open small overlaps between polygons far from O at strong
 *    curvature (docs/spaces/CURVED.md §13): no setSize that moves the pieces avoids it.
 *  - finish: repair, the SLP polish and the validator at tolerance 0 (kernel-finish.ts), its work
 *    capped at FINISH_CAP times finishCost.
 *  - validate: the server's rule for curved; fromConfig refuses what the server would refuse as
 *    malformed (its limits and its far-centre test).
 *  - id: the catalogue's, with K written as the curved records write it (formatCurvature).
 */
import type { KernelState, Rng, SpaceKernel } from "@polypack/methods";
import { type CurvedPose, makeSpace } from "./problem";
import { compose, poseMotion } from "./space";
import { maxContainerSize, sideFromApothem } from "./shapes";
import { tForArea } from "./search";
import { randomCentreInside, ringLayout, spreadCentres } from "./kernel-start";
import {
  type CurvedAux,
  cloneAux,
  makeAux,
  piecePose,
  poseOfMotion,
  rebaseAll,
  scalePose,
  setAnchor,
} from "./kernel-chart";
import { type KernelGeometry, containerVariable, kernelClear, kernelEnergy, scaleRadius } from "./kernel-energy";
import { VALIDATE_WORK, curvedBound, curvedFinish, curvedServerRule, farPiece, serverForm } from "./kernel-finish";

/**
 * Energy evaluations one finish() costs [CALC]. Measured as a finish's counted work (kernel-finish.ts)
 * on 3 relaxed and 3 squeezed random starts of 70 problems (K = +-1, N = 0, 3, 4, 6, M = 0, 3, 8,
 * P = 1 to 30): a median 0.8 times this (0.08 to 2.3 by problem), at most 3.8 times, under the
 * finish's cap of FINISH_CAP = 4 times. The polish's linear programs grow with the contacts.
 */
function finishCost(N: number, P: number): number {
  return 100 + (N === 0 ? 8 : 25) * P * P;
}

/**
 * K as the curved records and the server's ids write it (packages/spaces/src/ids.ts,
 * formatCurvature): an integer as an integer, any other value as Python's repr of the binary64
 * number ("1.225778283313099", "1e-06").
 */
export function formatCurvature(K: number): string {
  if (!Number.isFinite(K)) throw new RangeError(`K must be finite, not ${K}`);
  if (Object.is(K, -0)) return "0";
  if (Number.isInteger(K) && Math.abs(K) < 1e16) return String(K);
  const [mantissa, exp] = K.toExponential().split("e");
  const e = Number(exp);
  // Python's repr uses fixed notation for decimal exponents -4 <= e < 16, where it agrees with String()
  if (e >= -4 && e < 16) return String(K);
  const digits = String(Math.abs(e)).padStart(2, "0");
  return `${mantissa}e${e < 0 ? "-" : "+"}${digits}`;
}

export function curvedKernel(problem: { K: number; N: number; M: number; P: number }): SpaceKernel {
  const { K, N, M, P } = problem;
  if (!Number.isInteger(P) || P < 1 || P > 100) throw new RangeError("P must be an integer in [1, 100]");
  // throws for a non-finite K, a bad N or M, or a unit piece that does not exist at K
  const space = makeSpace(K, N, M);
  const dim = N === 0 ? 2 : 3;
  const sMax = maxContainerSize(M, K);
  const g: KernelGeometry = { space, P, dim, sizeCap: K > 0 ? sMax * (1 - 1e-12) : Infinity };
  const bound = curvedBound(space, P);
  const sizeOfT = (t: number) => (M === 0 ? t : sideFromApothem(M, K, t));
  const { rho, R } = space.piece;

  // A roomy start: area density 0.45 as the package's search, or, when the space has too little
  // room for that (K > 0, and polygon containers at K < 0), 95% of the way from the pieces' area to
  // the largest container's.
  const areaPieces = P * space.piece.area;
  const areaMax = K > 0 ? (2 * Math.PI) / K : K < 0 && M > 0 ? ((M - 2) * Math.PI) / -K : Infinity;
  const tStart = tForArea(
    space,
    areaPieces < areaMax ? Math.min(areaPieces / 0.45, areaPieces + 0.95 * (areaMax - areaPieces)) : 0.9 * areaMax,
  );

  const state = (anchors: CurvedPose[], size: number): KernelState => ({
    x: new Float64Array(P * dim),
    size,
    aux: makeAux(K, anchors),
  });
  const randomAnchor = (t: number, rng: Rng): CurvedPose => {
    const c = randomCentreInside(space, t, rng);
    return { x: c.x, y: c.y, theta: N === 0 ? 0 : 2 * Math.PI * rng() };
  };
  const poses = (s: KernelState): CurvedPose[] =>
    Array.from({ length: P }, (_, i) => piecePose(K, s.aux as CurvedAux, s.x, dim, i));
  const rebasePiece = (s: KernelState, i: number) => {
    const aux = s.aux as CurvedAux;
    setAnchor(K, aux, i, piecePose(K, aux, s.x, dim, i));
    for (let a = 0; a < dim; a++) s.x[i * dim + a] = 0;
  };

  const kernel: SpaceKernel = {
    space: "curved",
    id: `curved/${formatCurvature(K)}/${N}/${M}/${P}`,
    P,
    dim,
    steps: Float64Array.from(N === 0 ? [1, 1] : [rho, rho, rho / R]),
    globals: 0,
    globalSteps: new Float64Array(0),
    inradius: rho,
    bound,
    finishCost: finishCost(N, P),
    // one pass of the validator over the pairs and walls: 1 to 4 energies on records [CALC]
    validateCost: VALIDATE_WORK,
    capabilities: N === 0 ? ["shape", "seeds"] : ["shape", "seeds", "swap"],
    // growth turns flush polygons against each other (Gauss-Bonnet, CURVED.md section 13); disks keep apart
    growthMayOverlap: N !== 0,

    fromConfig(config) {
      const form = serverForm(P, config);
      if ("reasons" in form || farPiece(M, K, form.config) >= 0) return null;
      return state(form.config.pieces, form.config.size);
    },
    toConfig: (s) => ({ size: s.size, pieces: poses(s) }),
    clone: (s) => ({ x: Float64Array.from(s.x), size: s.size, aux: cloneAux(s.aux as CurvedAux) }),
    rebase(s) {
      rebaseAll(K, s.aux as CurvedAux, s.x, dim, P);
    },
    randomStart(rng) {
      const centres = spreadCentres(space, tStart, P, rng);
      return state(
        centres.map((c) => ({ x: c.x, y: c.y, theta: N === 0 ? 0 : 2 * Math.PI * rng() })),
        sizeOfT(tStart),
      );
    },
    randomPose(s, i, rng) {
      // the new pose as chart offsets at the piece's anchor (anchors change only in rebase): the
      // pose of A^-1 G, with A the anchor's motion and G the new pose's (a disk's turn is dropped)
      const aux = s.aux as CurvedAux;
      const p = randomAnchor(containerVariable(g, s.size).t, rng);
      const off = poseOfMotion(K, compose(aux.inverses[i], poseMotion(K, p.x, p.y, p.theta)));
      s.x[i * dim] = off.x;
      s.x[i * dim + 1] = off.y;
      if (dim === 3) s.x[i * dim + 2] = off.theta;
    },
    jiggle(s, i, amount, rng) {
      for (let a = 0; a < dim; a++) s.x[i * dim + a] += (2 * rng() - 1) * amount * kernel.steps[a];
    },
    setSize(s, size) {
      // polar radius about O scaled with the container's; the direction and theta kept
      const lambda = scaleRadius(g, size) / scaleRadius(g, s.size);
      const aux = s.aux as CurvedAux;
      rebaseAll(K, aux, s.x, dim, P);
      for (let i = 0; i < P; i++) setAnchor(K, aux, i, scalePose(aux.anchors[i], lambda));
      s.size = size;
    },
    energy: (s, grad, weights) => kernelEnergy(g, s, grad, weights),
    pieceEnergy: (s, i, weights) => kernelEnergy(g, s, undefined, weights, i),
    clear: (s, i, tol) => kernelClear(g, s, i, tol),
    finish: (s, shouldStop) => curvedFinish(g, poses(s), s.size, { bound, cost: kernel.finishCost, shouldStop }),
    validate: (config) => curvedServerRule({ N, M, P }, K, config, bound),

    setShape(s, t) {
      (s.aux as CurvedAux).shape = Math.min(1, Math.max(0, t));
    },
    seeds(rng, count) {
      // rings about O (kernel-start.ts): none, one, or about a quarter or a third of the pieces
      // inside; each piece with a vertex out, a vertex in or an edge in; the outer ring's first
      // piece towards the middle of a wall, towards a corner, or at random (a polygon container
      // keeps its room in the corners at K < 0)
      const inners = [...new Set([0, 1, Math.floor(P / 4), Math.floor(P / 3)])].filter((m) => m < P);
      const turns = N === 0 ? [0] : [-Math.PI / 2, Math.PI / 2, Math.PI / 2 + Math.PI / N];
      const phases = M === 0 ? [NaN] : [-Math.PI / 2, -Math.PI / 2 + Math.PI / M, NaN];
      const combos = inners.flatMap((inner) =>
        turns.flatMap((turn) => phases.map((phase) => ({ inner, turn, phase }))),
      );
      const out: KernelState[] = [];
      for (let c = 0; out.length < count && c < combos.length; c++) {
        const { inner, turn, phase } = combos[c];
        const ph = Number.isNaN(phase) ? 2 * Math.PI * rng() : phase;
        const lay = ringLayout(space, P, inner, turn, ph, ph + Math.PI / Math.max(1, P - inner));
        if (lay) out.push(state(lay.pieces, lay.size));
      }
      return out;
    },
  };
  if (N > 0)
    kernel.swap = (s, i, j) => {
      rebasePiece(s, i);
      rebasePiece(s, j);
      const aux = s.aux as CurvedAux;
      const a = aux.anchors[i];
      const b = aux.anchors[j];
      setAnchor(K, aux, i, { x: a.x, y: a.y, theta: b.theta });
      setAnchor(K, aux, j, { x: b.x, y: b.y, theta: a.theta });
    };
  return kernel;
}
