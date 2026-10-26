/**
 * Gap functions (float64) for curved packings, with analytic gradients.
 *
 * Every constraint is a gap in geodesic length units: positive = clearance, 0 = touching,
 * negative = overlap or protrusion.
 *  - polygon pair: separating-axis value in the chart. For each edge line of one piece, the
 *    smallest signed distance of the other piece's vertices; the largest of these over both
 *    pieces' edges. A value >= 0 proves the interiors are disjoint (Klein / gnomonic charts map
 *    geodesics to straight lines, so the Euclidean separating-axis theorem applies there).
 *  - disk pair: centre distance - 2.
 *  - wall (polygon container): -(signed distance of a vertex from the wall line), or minus 1 for a disk.
 *  - rim (disk container): r - distance(O, vertex), or r - 1 - distance(O, centre) for a disk.
 * Gradients are taken with respect to the pose coordinates (x, y, theta) of the pieces involved
 * and the container variable t (apothem h or radius r).
 */
import { Space, CurvedPose, pieceWorld } from "./problem";
import {
  ORIGIN,
  applyPoint,
  applyTangent,
  bodyJacobian,
  covectorNorm2,
  generator,
  lineCovector,
  lineTangent,
  lineThrough,
  lineValue,
  pairVs,
  poseMotionInverse,
  type LPoint,
  type Motion,
} from "./space";
import { angK, asnK, csK, distFromVs, snK } from "./kfun";

export interface PieceState {
  G: Motion;
  Ginv: Motion;
  centre: LPoint;
  verts: LPoint[];
  /** outward world covectors of the edges, normalised to Qd = 1 */
  edges: [number, number, number][];
  /** body Jacobian: body velocity = Jb . (dx, dy, dtheta) */
  Jb: Float64Array;
}

export function pieceState(space: Space, pose: CurvedPose): PieceState {
  const { K } = space;
  const { G, centre, verts } = pieceWorld(space, pose);
  const Ginv = poseMotionInverse(K, pose.x, pose.y, pose.theta);
  return pieceStateOf(space, G, Ginv, centre, verts, bodyJacobian(K, pose.x, pose.y, pose.theta));
}

/**
 * A piece's state from its motion G (with inverse Ginv, centre G(O) and vertices G(V_k)) and the
 * Jacobian Jb from the caller's variables to G's body velocity. The gradients of the rows built
 * from it are then taken with respect to those variables: the pose (x, y, theta) in pieceState,
 * the chart offsets at an anchor in the methods' kernel (kernel.ts).
 */
export function pieceStateOf(
  space: Space,
  G: Motion,
  Ginv: Motion,
  centre: LPoint,
  verts: LPoint[],
  Jb: Float64Array,
): PieceState {
  const { K } = space;
  const edges: [number, number, number][] = [];
  const N = space.N;
  for (let e = 0; e < N; e++) {
    const a = verts[e];
    const b = verts[(e + 1) % N];
    const n = lineThrough(K, b, a); // b x a: outward for a counter-clockwise edge a -> b
    const q = Math.sqrt(covectorNorm2(K, n));
    edges.push([n[0] / q, n[1] / q, n[2] / q]);
  }
  return { G, Ginv, centre, verts, edges, Jb };
}

export function allStates(space: Space, poses: readonly CurvedPose[]): PieceState[] {
  return poses.map((p) => pieceState(space, p));
}

/** Container wall covectors for container variable t (apothem). */
export function wallCovectors(space: Space, t: number): [number, number, number][] {
  return space.wallAngles.map((a) => lineCovector(space.K, t, a));
}

export interface PairWitness {
  /** 0: axis is an edge of piece i; 1: of piece j; -1: disk pair */
  owner: 0 | 1 | -1;
  edge: number;
  vertex: number;
}

export interface PairGap {
  gap: number;
  witness: PairWitness;
}

/** Signed separation of two pieces (SAT value for polygons, distance - 2 for disks). */
export function pairGap(space: Space, A: PieceState, B: PieceState): PairGap {
  const { K, N } = space;
  if (N === 0) {
    const vs = pairVs(K, A.centre, B.centre);
    return { gap: distFromVs(K, vs) - 2, witness: { owner: -1, edge: -1, vertex: -1 } };
  }
  let best = -Infinity;
  let w: PairWitness = { owner: 0, edge: 0, vertex: 0 };
  for (let pass = 0; pass < 2; pass++) {
    const P = pass === 0 ? A : B;
    const Q = pass === 0 ? B : A;
    for (let e = 0; e < N; e++) {
      const n = P.edges[e];
      let m = Infinity;
      let mk = 0;
      for (let k = 0; k < N; k++) {
        const val = lineValue(K, n, Q.verts[k]);
        if (val < m) {
          m = val;
          mk = k;
        }
      }
      if (m > best) {
        best = m;
        w = { owner: pass as 0 | 1, edge: e, vertex: mk };
      }
    }
  }
  return { gap: asnK(K, best), witness: w };
}

/** Upper bound on how much the centre distance exceeds the reach where two pieces can interact. */
export function centreDistance(space: Space, A: PieceState, B: PieceState): number {
  return distFromVs(space.K, pairVs(space.K, A.centre, B.centre));
}

// ---------------------------------------------------------------------------------------------
// Rows with gradients

export interface Row {
  kind: "pair" | "wall" | "rim";
  i: number;
  /** second piece for pairs, else -1 */
  j: number;
  /** wall index (wall rows), else -1 */
  wall: number;
  /** vertex index of the moving point (-1 for disk centres / SAT summary rows) */
  vertex: number;
  /** for pair rows: axis owner (0: i, 1: j) and edge */
  owner: number;
  edge: number;
  value: number;
  /** d value / d (x, y, theta) of piece i and j, and d value / dt */
  gi: [number, number, number];
  gj: [number, number, number];
  gt: number;
}

function toPose(Jb: Float64Array, body: [number, number, number]): [number, number, number] {
  // pose gradient = Jb^T body gradient
  return [
    Jb[0] * body[0] + Jb[3] * body[1] + Jb[6] * body[2],
    Jb[1] * body[0] + Jb[4] * body[1] + Jb[7] * body[2],
    Jb[2] * body[0] + Jb[5] * body[1] + Jb[8] * body[2],
  ];
}

/**
 * Row for the signed distance of vertex k of piece Q from edge line e of piece P (value = asn(n . w)).
 * pi, qi are the piece indices of P and Q. The derivative with respect to P's body velocity is minus
 * that of moving w by the same spatial generator: -n . (G_P X G_P^{-1} w). With k < 0 the point is
 * Q's centre instead of a vertex (as in wallRow).
 */
export function vertexEdgeRow(
  space: Space,
  P: PieceState,
  e: number,
  Q: PieceState,
  k: number,
  pi: number,
  qi: number,
  owner: number,
): Row {
  const { K } = space;
  const n = P.edges[e];
  const w = k >= 0 ? Q.verts[k] : Q.centre;
  const y = lineValue(K, n, w);
  const value = asnK(K, y);
  const dval = 1 / Math.sqrt(Math.max(1e-300, 1 - K * y * y));
  const bodyQ: [number, number, number] = [0, 0, 0];
  const bodyP: [number, number, number] = [0, 0, 0];
  const v0 = k >= 0 ? space.vertices[k] : ORIGIN;
  const wP = applyPoint(P.Ginv, w);
  for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
    bodyQ[a] = dval * lineTangent(K, n, applyTangent(Q.G, generator(K, a, v0)));
    bodyP[a] = -dval * lineTangent(K, n, applyTangent(P.G, generator(K, a, wP)));
    if (a === 2) break;
  }
  const gP = toPose(P.Jb, bodyP);
  const gQ = toPose(Q.Jb, bodyQ);
  // rows are stored with i < j convention by the caller via pi/qi
  const r: Row = {
    kind: "pair",
    i: pi,
    j: qi,
    wall: -1,
    vertex: k,
    owner,
    edge: e,
    value,
    gi: gP,
    gj: gQ,
    gt: 0,
  };
  return r;
}

/** Disk pair row: distance(c_i, c_j) - 2. */
export function diskPairRow(space: Space, A: PieceState, B: PieceState, i: number, j: number): Row {
  const { K } = space;
  const vs = pairVs(K, A.centre, B.centre);
  const d = distFromVs(K, vs);
  const sn = snK(K, d);
  const inv = sn > 1e-300 ? 1 / sn : 0;
  const dx = A.centre.x - B.centre.x;
  const dy = A.centre.y - B.centre.y;
  const de = A.centre.e - B.centre.e;
  const bodyA: [number, number, number] = [0, 0, 0];
  const bodyB: [number, number, number] = [0, 0, 0];
  for (let a = 0 as 0 | 1; a < 2; a = (a + 1) as 0 | 1) {
    const tA = applyTangent(A.G, generator(K, a, ORIGIN));
    const tB = applyTangent(B.G, generator(K, a, ORIGIN));
    bodyA[a] = (dx * tA.x + dy * tA.y + K * de * tA.e) * inv;
    bodyB[a] = -(dx * tB.x + dy * tB.y + K * de * tB.e) * inv;
    if (a === 1) break;
  }
  return {
    kind: "pair",
    i,
    j,
    wall: -1,
    vertex: -1,
    owner: -1,
    edge: -1,
    value: d - 2,
    gi: toPose(A.Jb, bodyA),
    gj: toPose(B.Jb, bodyB),
    gt: 0,
  };
}

/** Wall row for point p (vertex k of piece S, or its centre when k < 0) against wall covector n(t). */
export function wallRow(space: Space, S: PieceState, i: number, k: number, wall: number, t: number): Row {
  const { K } = space;
  const n = lineCovector(K, t, space.wallAngles[wall]);
  const p = k >= 0 ? S.verts[k] : S.centre;
  const local = k >= 0 ? space.vertices[k] : ORIGIN;
  const y = lineValue(K, n, p);
  const sd = asnK(K, y);
  const dval = 1 / Math.sqrt(Math.max(1e-300, 1 - K * y * y));
  const body: [number, number, number] = [0, 0, 0];
  for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
    body[a] = -dval * lineTangent(K, n, applyTangent(S.G, generator(K, a, local)));
    if (a === 2) break;
  }
  // d(n . v)/dt with n = (-sn(t), cs(t) u): -cs(t) v0 - K sn(t) (u . v_vec)
  const u0 = Math.cos(space.wallAngles[wall]);
  const u1 = Math.sin(space.wallAngles[wall]);
  const dndt = -csK(K, t) * (1 - K * p.e) - K * snK(K, t) * (u0 * p.x + u1 * p.y);
  return {
    kind: "wall",
    i,
    j: -1,
    wall,
    vertex: k,
    owner: -1,
    edge: -1,
    value: -sd - (k >= 0 ? 0 : 1),
    gi: toPose(S.Jb, body),
    gj: [0, 0, 0],
    gt: -dval * dndt,
  };
}

/** Rim row for a disk container of radius t: t - d(O, p) (minus 1 for a disk piece centre). */
export function rimRow(space: Space, S: PieceState, i: number, k: number, t: number): Row {
  const { K } = space;
  const p = k >= 0 ? S.verts[k] : S.centre;
  const local = k >= 0 ? space.vertices[k] : ORIGIN;
  const d = distFromVs(K, p.e);
  const sn = snK(K, d);
  const inv = sn > 1e-300 ? 1 / sn : 0;
  const body: [number, number, number] = [0, 0, 0];
  for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
    body[a] = -applyTangent(S.G, generator(K, a, local)).e * inv;
    if (a === 2) break;
  }
  return {
    kind: "rim",
    i,
    j: -1,
    wall: -1,
    vertex: k,
    owner: -1,
    edge: -1,
    value: t - d - (k >= 0 ? 0 : 1),
    gi: toPose(S.Jb, body),
    gj: [0, 0, 0],
    gt: 1,
  };
}

/** Container gap of a piece (min over its vertices and walls), without gradients. */
export function containerGap(space: Space, S: PieceState, walls: [number, number, number][], t: number): number {
  const { K, N, M } = space;
  let g = Infinity;
  const pts = N === 0 ? [S.centre] : S.verts;
  const pad = N === 0 ? 1 : 0;
  for (const p of pts) {
    if (M === 0) {
      g = Math.min(g, t - distFromVs(K, p.e) - pad);
    } else {
      for (const n of walls) g = Math.min(g, -asnK(K, lineValue(K, n, p)) - pad);
    }
  }
  return g;
}

/**
 * Smallest container variable t (apothem or radius) that contains the piece, at the fixed centre O
 * and orientation phi = 0. For wall direction u write the point as v = (c0, X = u . v_vec, ...) and
 * A = sqrt(c0^2 + K X^2), a = ang_K(X, c0). Then n(t) . v = A sn_K(a - t), so a vertex needs t >= a
 * and a unit disk centre needs t >= a + asn_K(sn_K(1) / A).
 */
export function requiredT(space: Space, S: PieceState): number {
  const { K, N, M } = space;
  let t = -Infinity;
  const pts = N === 0 ? [S.centre] : S.verts;
  if (M === 0) {
    for (const p of pts) t = Math.max(t, distFromVs(K, p.e) + (N === 0 ? 1 : 0));
    return t;
  }
  const s1 = snK(K, 1);
  for (const p of pts) {
    const c0 = 1 - K * p.e;
    for (const ang of space.wallAngles) {
      const X = Math.cos(ang) * p.x + Math.sin(ang) * p.y;
      const a = angK(K, X, c0);
      if (N === 0) {
        const A = Math.sqrt(Math.max(0, c0 * c0 + K * X * X));
        t = Math.max(t, a + asnK(K, s1 / A));
      } else t = Math.max(t, a);
    }
  }
  return t;
}
