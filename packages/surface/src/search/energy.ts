import { boundingRadius, inradius, polygonSeparation } from "@polypack/geometry";
import { ChainNode, enumerateChains, inWedge } from "../chains";
import { SurfacePose, pieceParts } from "../parts";
import { apply, glue } from "../rigid";
import { Solid, faceApothem, frameVertex } from "../solids";

/**
 * Overlap energies for the fold search on a solid of edge `s` with pieces scaled by `lam`.
 * E = sum of squared penetrations: part-part overlaps on every face (two parts of one piece
 * included), cone points inside pieces, and for disks the distance form (centre images closer
 * than 2 lam, vertices closer than lam). E = 0 exactly when the float validator (tol 0) accepts.
 */

/** Move a pose whose centre left its face into the face that contains it (orientation preserved). */
export function canonicalize(solid: Solid, s: number, p: SurfacePose): SurfacePose {
  let { face, x, y, theta } = p;
  const M = solid.M;
  const ap = faceApothem(M, s);
  for (let step = 0; step < 64; step++) {
    let worst = 0;
    let kw = -1;
    for (let j = 0; j < M; j++) {
      const a = (2 * Math.PI * (j + 1)) / M - Math.PI / 2;
      const out = x * Math.cos(a) + y * Math.sin(a) - ap;
      if (out > worst) {
        worst = out;
        kw = j;
      }
    }
    if (kw < 0) return { face, x, y, theta };
    // glue maps the neighbour's frame into ours; invert it to express the point in the neighbour's frame
    const g = glue(solid, s, face, kw);
    const T = g.T;
    const ix = -(T.c * T.tx + T.s * T.ty);
    const iy = -(-T.s * T.tx + T.c * T.ty);
    const nx = T.c * x + T.s * y + ix;
    const ny = -T.s * x + T.c * y + iy;
    x = nx;
    y = ny;
    theta -= T.ang;
    face = g.face;
  }
  // A step that jumps across a vertex can circle it without ever landing (the cone angle is below
  // 2 pi, so "beyond the vertex" is not a point of any face). Pull the centre back into the face.
  const ap2 = faceApothem(M, s) * (1 - 1e-9);
  let worst = 0;
  for (let j = 0; j < M; j++) {
    const a = (2 * Math.PI * (j + 1)) / M - Math.PI / 2;
    worst = Math.max(worst, (x * Math.cos(a) + y * Math.sin(a)) / ap2);
  }
  if (worst > 1 || !Number.isFinite(worst)) {
    // scale towards the face centre until the point is inside
    const k = Number.isFinite(worst) ? 1 / worst : 0;
    x *= k;
    y *= k;
  }
  return { face, x, y, theta };
}

interface PartRec {
  piece: number;
  poly: Float64Array;
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

function bbox(piece: number, poly: Float64Array): PartRec {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    if (poly[i] < minx) minx = poly[i];
    if (poly[i] > maxx) maxx = poly[i];
    if (poly[i + 1] < miny) miny = poly[i + 1];
    if (poly[i + 1] > maxy) maxy = poly[i + 1];
  }
  return { piece, poly, minx, miny, maxx, maxy };
}

/**
 * Squared cone-point penetration of one piece. A vertex can show up in several chains (at the
 * same developed point when it lies on a wedge boundary), so each vertex counts once, with its
 * deepest appearance; that keeps the energy continuous.
 */
function coneEnergy(solid: Solid, s: number, N: number, p: SurfacePose, nodes: ChainNode[], lam: number): number {
  const M = solid.M;
  const rin = N === 0 ? lam : inradius(N) * lam;
  const worst = new Map<number, number>();
  for (const node of nodes)
    for (let k = 0; k < M; k++) {
      const [fx, fy] = frameVertex(M, s, k);
      const [vx, vy] = apply(node.toAnchor, fx, fy);
      if (!inWedge(node.wedge, p.x, p.y, vx, vy, 1e-12)) continue;
      let out: number;
      if (N === 0) out = Math.hypot(vx - p.x, vy - p.y) - lam;
      else {
        out = -Infinity;
        for (let j = 0; j < N; j++) {
          const a = p.theta + Math.PI / 2 + Math.PI / N + (2 * Math.PI * j) / N;
          const t = (vx - p.x) * Math.cos(a) + (vy - p.y) * Math.sin(a) - rin;
          if (t > out) out = t;
        }
      }
      if (out < 0) {
        const id = solid.faces[node.face][k];
        const old = worst.get(id);
        if (old === undefined || out < old) worst.set(id, out);
      }
    }
  let e = 0;
  for (const v of worst.values()) e += CONE_WEIGHT * v * v;
  return e;
}

/** Cone points are pushed out first: inside a piece they make its development ill-defined. */
export const CONE_WEIGHT = 4;

/** Polygon pieces: energy with per-piece caches so that moving one piece costs only its own terms. */
export class PolygonEnergy {
  readonly solid: Solid;
  readonly s: number;
  readonly N: number;
  lam: number;
  poses: SurfacePose[];
  private parts: PartRec[][] = [];
  private partFaces: number[][] = [];
  private cone: number[] = [];
  private byFace: PartRec[][];

  constructor(solid: Solid, s: number, N: number, lam: number, poses: SurfacePose[]) {
    this.solid = solid;
    this.s = s;
    this.N = N;
    this.lam = lam;
    this.poses = poses.map((p) => canonicalize(solid, s, p));
    this.byFace = Array.from({ length: solid.F }, () => []);
    this.rebuild();
  }

  setScale(lam: number): void {
    this.lam = lam;
    this.rebuild();
  }

  private computePiece(i: number, pose: SurfacePose): { recs: PartRec[]; faces: number[]; cone: number } {
    const nodes = enumerateChains(this.solid, this.s, pose.face, pose.x, pose.y, this.lam * boundingRadius(this.N));
    const parts = pieceParts(this.solid, this.s, this.N, pose, i, this.lam, nodes);
    const recs: PartRec[] = [];
    const faces: number[] = [];
    for (const part of parts)
      if (part.poly.length >= 6) {
        recs.push(bbox(i, part.poly));
        faces.push(part.face);
      }
    return { recs, faces, cone: coneEnergy(this.solid, this.s, this.N, pose, nodes, this.lam) };
  }

  rebuild(): void {
    for (const l of this.byFace) l.length = 0;
    this.parts = [];
    this.partFaces = [];
    this.cone = [];
    this.poses.forEach((p, i) => {
      const r = this.computePiece(i, p);
      this.parts.push(r.recs);
      this.partFaces.push(r.faces);
      this.cone.push(r.cone);
      r.recs.forEach((rec, t) => this.byFace[r.faces[t]].push(rec));
    });
  }

  private static pen(a: PartRec, b: PartRec): number {
    if (a.maxx < b.minx || b.maxx < a.minx || a.maxy < b.miny || b.maxy < a.miny) return 0;
    const sep = polygonSeparation(a.poly, b.poly).sep;
    return sep < 0 ? sep * sep : 0;
  }

  /** Energy terms involving piece i if it had pose `pose` (others as cached). */
  localEnergy(i: number, pose: SurfacePose): number {
    const r = this.computePiece(i, pose);
    let e = r.cone;
    for (let t = 0; t < r.recs.length; t++) {
      const a = r.recs[t];
      const f = r.faces[t];
      for (const b of this.byFace[f]) if (b.piece !== i) e += PolygonEnergy.pen(a, b);
      for (let u = t + 1; u < r.recs.length; u++) if (r.faces[u] === f) e += PolygonEnergy.pen(a, r.recs[u]);
    }
    return e;
  }

  /** Replace piece i's pose and caches. */
  update(i: number, pose: SurfacePose): void {
    const old = this.parts[i];
    this.partFaces[i].forEach((f, t) => {
      const l = this.byFace[f];
      const idx = l.indexOf(old[t]);
      if (idx >= 0) l.splice(idx, 1);
    });
    this.poses[i] = pose;
    const r = this.computePiece(i, pose);
    this.parts[i] = r.recs;
    this.partFaces[i] = r.faces;
    this.cone[i] = r.cone;
    r.recs.forEach((rec, t) => this.byFace[r.faces[t]].push(rec));
  }

  total(): number {
    let e = 0;
    for (const c of this.cone) e += c;
    for (const l of this.byFace)
      for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) e += PolygonEnergy.pen(l[a], l[b]);
    return e;
  }
}

/**
 * Disks: E = sum over ordered pairs of developed centre images 1/2 max(0, 2 lam - d)^2
 *  + sum over vertices max(0, lam - d)^2, with analytic gradient in each anchor frame.
 * Geodesic loops at a centre count as images of the centre itself.
 */
export function diskEnergy(solid: Solid, s: number, lam: number, poses: SurfacePose[], grad?: Float64Array): number {
  const M = solid.M;
  const byFace: number[][] = Array.from({ length: solid.F }, () => []);
  poses.forEach((p, i) => byFace[p.face].push(i));
  let e = 0;
  if (grad) grad.fill(0);
  const verts: [number, number][] = [];
  for (let k = 0; k < M; k++) verts.push(frameVertex(M, s, k));
  for (let i = 0; i < poses.length; i++) {
    const p = poses[i];
    const nodes = enumerateChains(solid, s, p.face, p.x, p.y, 2 * lam);
    let gx = 0;
    let gy = 0;
    const vbest = new Map<number, [number, number, number]>();
    nodes.forEach((node, ni) => {
      const T = node.toAnchor;
      for (const j of byFace[node.face]) {
        if (j === i && ni === 0) continue;
        const q = poses[j];
        const [qx, qy] = apply(T, q.x, q.y);
        if (!inWedge(node.wedge, p.x, p.y, qx, qy, 0)) continue;
        const dx = qx - p.x;
        const dy = qy - p.y;
        const d = Math.hypot(dx, dy);
        if (d >= 2 * lam || d === 0) continue;
        const pen = 2 * lam - d;
        e += 0.5 * pen * pen;
        if (j !== i) {
          // the pair's two ordered terms add up to pen^2, whose gradient in p is 2 pen (q' - p)/d
          gx += (2 * pen * dx) / d;
          gy += (2 * pen * dy) / d;
        } else {
          // loop: q' = R p + t, d/dp |q' - p| = (R - I)^T (q' - p)/d
          const ux = dx / d;
          const uy = dy / d;
          const rx = T.c * ux + T.s * uy - ux;
          const ry = -T.s * ux + T.c * uy - uy;
          gx += -pen * rx;
          gy += -pen * ry;
        }
      }
      for (let k = 0; k < M; k++) {
        const [vx, vy] = apply(T, verts[k][0], verts[k][1]);
        if (!inWedge(node.wedge, p.x, p.y, vx, vy, 1e-12)) continue;
        const dx = vx - p.x;
        const dy = vy - p.y;
        const d = Math.hypot(dx, dy);
        if (d >= lam) continue;
        // each vertex once, at its closest appearance (continuity, see coneEnergy)
        const id = solid.faces[node.face][k];
        const old = vbest.get(id);
        if (!old || d < old[0]) vbest.set(id, [d, dx, dy]);
      }
    });
    for (const [d, dx, dy] of vbest.values()) {
      const pen = lam - d;
      e += CONE_WEIGHT * pen * pen;
      if (d > 0) {
        gx += (2 * CONE_WEIGHT * pen * dx) / d;
        gy += (2 * CONE_WEIGHT * pen * dy) / d;
      }
    }
    vbest.clear();
    if (grad) {
      grad[2 * i] = gx;
      grad[2 * i + 1] = gy;
    }
  }
  return e;
}
