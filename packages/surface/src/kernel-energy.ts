/**
 * The penalty model of the methods kernel (kernel.ts) for the fold mode: the fold search's
 * energy (search/energy.ts) with what the generic methods also need, namely per-piece weights,
 * the terms of one piece, a hard clearance test, the derivative in the scale, and soft pieces.
 *
 * Everything here works as the fold search does: on the solid of edge 1 with pieces scaled by
 * lam = 1/s, poses in their anchor face's frame (canonical: the centre in the closed face). The
 * kernel turns the results into piece units (a length at edge s is lam times shorter here, so an
 * energy is multiplied by s^2).
 *
 * Terms, as in the fold search: for polygons, the squared penetration depth of every pair of
 * overlapping parts on a face (two parts of one piece included, which is the embedding
 * condition) and CONE_WEIGHT times the squared depth of every cone point inside a piece (each
 * vertex once, at its deepest appearance, so that the energy is continuous); for disks, the
 * distance form of docs/spaces/SURFACE.md 2.3 (centre images closer than 2 lam, vertices closer
 * than lam, geodesic loops at a centre shorter than 2 lam).
 *
 * Separating axes. A part is the piece cut by the two rays of its chain's wedge and by its face's
 * edges, and clipping can leave it an edge of length about 1e-15, whose direction (and so its
 * separating axis) rounding makes arbitrary: the separating-axis depth then jumps at isolated
 * poses, which a line search finds (it seeks low energy). So the depth here uses as axes the
 * exact half-planes each part was cut from (piece sides, wedge rays, face edges), mapped into the
 * face's frame. Every edge of a part lies on one of them, and a half-plane that does not touch
 * the part only gives a smaller gap, so the largest gap over them is the separating-axis depth
 * with exact normals.
 *
 * A polygon piece's geometry (its chains, parts and cone terms) depends on its own pose only, so
 * it is cached by pose; moving one piece then costs one piece's development.
 */
import { boundingRadius, inradius, pieceVertices } from "@polypack/geometry";
import { type ChainNode, enumerateChains, inWedge } from "./chains";
import { type FaceShape, faceShapes } from "./kernel-solid";
import { type SurfacePose, developParts, wedgeHalfPlanes } from "./parts";
import { apply } from "./rigid";
import { CONE_WEIGHT, type PartRec, bbox } from "./search/energy";
import type { Solid } from "./solids";

/**
 * Most chains of faces per piece in the model, twice the server's cap of 600 (Platonic records
 * need about 35): a piece far too large for its solid makes the energy Infinity after a bounded
 * enumeration.
 */
export const MODEL_MAX_CHAINS = 1200;

/** Thrown inside the model when a piece has too many chains (caught by the kernel). */
export class TooLarge extends Error {}

/** A convex outline in the anchor frame: its corners and the half-planes nx x + ny y <= b of its sides (unit normals). */
export interface Outline {
  poly: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
  b: Float64Array;
}

/** A part on a face: its corners and bounding box (PartRec) and the half-planes it was cut from, in the face's frame. */
interface Part extends PartRec {
  hx: Float64Array;
  hy: Float64Array;
  hb: Float64Array;
}

/** One piece's developed geometry. */
export interface PieceGeom {
  parts: Part[];
  /** face of each part */
  faces: number[];
  /** sum of CONE_WEIGHT * depth^2 over the cone points inside the piece */
  cone: number;
  /** deepest cone point inside the piece (0 when none) */
  coneDepth: number;
}

/** The pair weight of pieces i and j: (w_i + w_j) / 2, or w_i for two parts of one piece. */
const pairWeight = (w: Float64Array | undefined, i: number, j: number) => (!w ? 1 : i === j ? w[i] : (w[i] + w[j]) / 2);

/** Largest gap of the corners q beyond one of A's half-planes; it stops early once the parts are apart. */
function axisGap(A: Part, q: Float64Array, best: number): number {
  for (let h = 0; h < A.hb.length && best < 0; h++) {
    const nx = A.hx[h];
    const ny = A.hy[h];
    const b = A.hb[h];
    let m = Infinity;
    for (let k = 0; k < q.length && m > best; k += 2) {
      const d = nx * q[k] + ny * q[k + 1] - b;
      if (d < m) m = d;
    }
    if (m > best) best = m;
  }
  return best;
}

/** Separation of two parts (negative: penetration depth), exact to rounding when they overlap, else some value >= 0. */
function separation(a: Part, b: Part): number {
  if (a.maxx < b.minx || b.maxx < a.minx || a.maxy < b.miny || b.maxy < a.miny) return Infinity;
  return axisGap(b, a.poly, axisGap(a, b.poly, -Infinity));
}

const penetration2 = (a: Part, b: Part): number => {
  const sep = separation(a, b);
  return sep < 0 ? sep * sep : 0;
};

/**
 * The outline of a piece of shape parameter t (kernel.ts, capability "shape") at scale lam: the
 * polygon scaled by t about its centre and dilated by rho = (1 - t) r_in. The dilation's round
 * corners are replaced by chords between points of the arcs, so the soft outline lies inside the
 * rounded one, which lies inside the piece: t K + B(rho) is inside t K + (1 - t) K = K because K
 * is convex and contains B(r_in) about its centre. Each corner's arc, from the outward normal of
 * the side before it to that of the side after it (2 pi / N), gets chords of at most 30 degrees.
 * The sides' half-planes are written from their angles, not from the corners, so that short
 * chords (t near 1) keep exact normals.
 */
export function pieceOutline(N: number, p: SurfacePose, lam: number, t: number): Outline {
  const ext = (2 * Math.PI) / N;
  const rIn = inradius(N) * lam;
  if (t >= 1 - 1e-9) {
    const poly = pieceVertices(N, p, lam);
    const nx = new Float64Array(N);
    const ny = new Float64Array(N);
    const b = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      // side k joins corners k and k + 1 (at theta + pi/2 + 2 pi k / N); its normal is halfway
      const a = p.theta + Math.PI / 2 + (k + 0.5) * ext;
      nx[k] = Math.cos(a);
      ny[k] = Math.sin(a);
      b[k] = nx[k] * p.x + ny[k] * p.y + rIn;
    }
    return { poly, nx, ny, b };
  }
  // below 1e-12 the corners are taken to coincide at the centre (a change of at most 1e-12 R)
  const tt = t > 1e-12 ? t : 0;
  const R = boundingRadius(N) * lam;
  const rho = (1 - tt) * rIn;
  const J = Math.ceil(12 / N);
  const half = ext / (2 * J);
  // with the corners at the centre the end of one arc is the start of the next
  const per = tt > 0 ? J + 1 : J;
  const count = N * per;
  const poly = new Float64Array(2 * count);
  const nx = new Float64Array(count);
  const ny = new Float64Array(count);
  const b = new Float64Array(count);
  let o = 0;
  for (let k = 0; k < N; k++) {
    const a = p.theta + Math.PI / 2 + k * ext;
    const cx = p.x + tt * R * Math.cos(a);
    const cy = p.y + tt * R * Math.sin(a);
    for (let q = 0; q < per; q++) {
      const phi = a - ext / 2 + (ext * q) / J;
      poly[2 * o] = cx + rho * Math.cos(phi);
      poly[2 * o + 1] = cy + rho * Math.sin(phi);
      // the side leaving this point: a chord of the arc, or (q = J) the offset side to the next corner
      const na = q < J ? phi + half : phi;
      const off = q < J ? rho * Math.cos(half) : rho;
      nx[o] = Math.cos(na);
      ny[o] = Math.sin(na);
      b[o] = nx[o] * cx + ny[o] * cy + off;
      o++;
    }
  }
  return { poly, nx, ny, b };
}

/** The radius about the centre that holds the soft piece (the chains' reach). */
function softReach(N: number, lam: number, t: number): number {
  if (t >= 1 - 1e-9) return boundingRadius(N) * lam;
  return (t * boundingRadius(N) + (1 - t) * inradius(N)) * lam;
}

/**
 * Cone points inside an outline developed along `nodes`: a point's depth is its distance to the
 * nearest side line, each vertex once at its deepest appearance.
 */
function coneTerms(faces: FaceShape[], nodes: ChainNode[], cx: number, cy: number, o: Outline): { e: number; depth: number } {
  let worst: Map<number, number> | null = null;
  for (const node of nodes) {
    const F = faces[node.face];
    for (let k = 0; k < F.ids.length; k++) {
      const [vx, vy] = apply(node.toAnchor, F.poly[2 * k], F.poly[2 * k + 1]);
      if (!inWedge(node.wedge, cx, cy, vx, vy, 1e-12)) continue;
      let out = -Infinity;
      for (let e = 0; e < o.b.length; e++) {
        const d = o.nx[e] * vx + o.ny[e] * vy - o.b[e];
        if (d > out) out = d;
      }
      if (out < 0) {
        worst ??= new Map();
        const id = F.ids[k];
        const old = worst.get(id);
        if (old === undefined || -out > old) worst.set(id, -out);
      }
    }
  }
  let e = 0;
  let depth = 0;
  if (worst)
    for (const d of worst.values()) {
      e += CONE_WEIGHT * d * d;
      if (d > depth) depth = d;
    }
  return { e, depth };
}

/**
 * The half-planes a part on node's face was cut from, in that face's frame: the outline's sides
 * and the wedge's rays (anchor frame, mapped back) and the face's own edges.
 */
function partHalfPlanes(node: ChainNode, o: Outline, cx: number, cy: number, F: FaceShape): { hx: Float64Array; hy: Float64Array; hb: Float64Array } {
  const wedge = node.wedge ? wedgeHalfPlanes(node.wedge, cx, cy) : [];
  const n = o.b.length + wedge.length + F.b.length;
  const hx = new Float64Array(n);
  const hy = new Float64Array(n);
  const hb = new Float64Array(n);
  // x_anchor = R x_face + t, so n . x_anchor <= b reads (R^T n) . x_face <= b - n . t
  const T = node.toAnchor;
  let h = 0;
  const add = (ax: number, ay: number, b: number) => {
    hx[h] = T.c * ax + T.s * ay;
    hy[h] = -T.s * ax + T.c * ay;
    hb[h] = b - (ax * T.tx + ay * T.ty);
    h++;
  };
  for (let k = 0; k < o.b.length; k++) add(o.nx[k], o.ny[k], o.b[k]);
  for (const w of wedge) add(w.ax, w.ay, w.b);
  for (let k = 0; k < F.b.length; k++) {
    hx[h] = F.nx[k];
    hy[h] = F.ny[k];
    hb[h] = F.b[k];
    h++;
  }
  return { hx, hy, hb };
}

/** The polygon pieces' model on one solid: geometry per pose (cached), energies, clearances. */
export class PolygonModel {
  private readonly faces: FaceShape[];
  private readonly cache = new Map<string, PieceGeom>();
  private readonly cap: number;

  constructor(
    readonly solid: Solid,
    readonly N: number,
    readonly P: number,
  ) {
    this.faces = faceShapes(solid);
    this.cap = 4 * P + 32;
  }

  /** Geometry of a piece at canonical pose p (scale lam, soft shape t); `cache` keeps it for later calls. */
  geom(p: SurfacePose, lam: number, t: number, piece: number, cache: boolean): PieceGeom {
    const key = cache ? `${p.face} ${p.x} ${p.y} ${p.theta} ${lam} ${t}` : "";
    if (cache) {
      const hit = this.cache.get(key);
      // the parts carry their piece's index for the pair loops
      if (hit) return hit.parts.length && hit.parts[0].piece !== piece ? { ...hit, parts: hit.parts.map((q) => ({ ...q, piece })) } : hit;
    }
    let nodes: ChainNode[];
    try {
      nodes = enumerateChains(this.solid, 1, p.face, p.x, p.y, softReach(this.N, lam, t), MODEL_MAX_CHAINS);
    } catch (e) {
      throw new TooLarge(e instanceof Error ? e.message : String(e));
    }
    const outline = pieceOutline(this.N, p, lam, t);
    const parts: Part[] = [];
    const faces: number[] = [];
    for (const part of developParts(this.solid, 1, outline, p, piece, nodes))
      if (part.poly.length >= 6) {
        const hp = partHalfPlanes(nodes[part.chain], outline, p.x, p.y, this.faces[part.face]);
        parts.push({ ...bbox(piece, part.poly, part.cuts), ...hp });
        faces.push(part.face);
      }
    const cone = coneTerms(this.faces, nodes, p.x, p.y, outline);
    const g: PieceGeom = { parts, faces, cone: cone.e, coneDepth: cone.depth };
    if (cache) {
      if (this.cache.size >= this.cap) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, g);
    }
    return g;
  }

  /** Every piece's geometry and the parts on each face. */
  layout(poses: SurfacePose[], lam: number, t: number, cache = true): { geoms: PieceGeom[]; byFace: Part[][] } {
    const byFace: Part[][] = Array.from({ length: this.solid.F }, () => []);
    const geoms = poses.map((p, i) => {
      const g = this.geom(p, lam, t, i, cache);
      g.parts.forEach((r, k) => byFace[g.faces[k]].push(r));
      return g;
    });
    return { geoms, byFace };
  }

  /** Total energy (unit solid) of a layout. */
  total(geoms: PieceGeom[], byFace: Part[][], w?: Float64Array): number {
    let e = 0;
    geoms.forEach((g, i) => (e += (w ? w[i] : 1) * g.cone));
    for (const list of byFace)
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          const pen = penetration2(list[a], list[b]);
          if (pen > 0) e += pairWeight(w, list[a].piece, list[b].piece) * pen;
        }
    return e;
  }

  /** The terms of piece i if its geometry were g, against the other pieces' parts in byFace. */
  local(i: number, g: PieceGeom, byFace: Part[][], w?: Float64Array): number {
    let e = (w ? w[i] : 1) * g.cone;
    for (let a = 0; a < g.parts.length; a++) {
      const A = g.parts[a];
      const f = g.faces[a];
      for (const B of byFace[f]) if (B.piece !== i) e += pairWeight(w, i, B.piece) * penetration2(A, B);
      for (let b = a + 1; b < g.parts.length; b++) if (g.faces[b] === f) e += pairWeight(w, i, i) * penetration2(A, g.parts[b]);
    }
    return e;
  }

  /** True when piece i overlaps nothing (other pieces, itself, cone points) by more than tol (unit solid). */
  clear(i: number, g: PieceGeom, byFace: Part[][], tol: number): boolean {
    if (g.coneDepth > tol) return false;
    for (let a = 0; a < g.parts.length; a++) {
      const A = g.parts[a];
      const f = g.faces[a];
      for (const B of byFace[f]) if (B.piece !== i && separation(A, B) < -tol) return false;
      for (let b = a + 1; b < g.parts.length; b++) if (g.faces[b] === f && separation(A, g.parts[b]) < -tol) return false;
    }
    return true;
  }
}


/**
 * Central difference of f at a step h, except across a jump of the energy (a chain appearing or
 * vanishing around a cone point inside a piece, see search/optimize.ts): there the one-sided
 * differences disagree and the smaller one is taken, as the fold search does.
 */
export function jumpAwareDifference(em: number, e0: number, ep: number, h: number): number {
  const fwd = (ep - e0) / h;
  const bwd = (e0 - em) / h;
  if (Math.abs(fwd - bwd) > 0.5 * (Math.abs(fwd) + Math.abs(bwd)) + 1e-9) return Math.abs(fwd) < Math.abs(bwd) ? fwd : bwd;
  return (ep - em) / (2 * h);
}

/**
 * Disks: the fold search's distance energy (search/energy.ts, diskEnergy) with weights. Returns
 * the energy on the unit solid and its derivative in lam; with `grad` (2 per piece), dE/d(x, y)
 * of each centre in its canonical frame. With `only`, the terms of that disk alone: its pairs in
 * full (diskEnergy counts each pair half from either end) and its loops and vertices.
 */
export function diskTerms(
  solid: Solid,
  lam: number,
  poses: SurfacePose[],
  w?: Float64Array,
  grad?: Float64Array,
  only?: number,
): { e: number; dlam: number } {
  const faces = faceShapes(solid);
  const byFace: number[][] = Array.from({ length: solid.F }, () => []);
  poses.forEach((p, i) => byFace[p.face].push(i));
  if (grad) grad.fill(0);
  let e = 0;
  let dlam = 0;
  const first = only ?? 0;
  const end = only === undefined ? poses.length : only + 1;
  const pairShare = only === undefined ? 0.5 : 1;
  for (let i = first; i < end; i++) {
    const p = poses[i];
    const wi = w ? w[i] : 1;
    let nodes: ChainNode[];
    try {
      nodes = enumerateChains(solid, 1, p.face, p.x, p.y, 2 * lam, MODEL_MAX_CHAINS);
    } catch (err) {
      throw new TooLarge(err instanceof Error ? err.message : String(err));
    }
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
        if (d >= 2 * lam) continue;
        const pen = 2 * lam - d;
        const wij = pairWeight(w, i, j);
        // a loop is seen from both of its ends at i, so each image carries half of it
        const share = j === i ? 0.5 : pairShare;
        e += share * wij * pen * pen;
        dlam += share * wij * 4 * pen;
        // two centres at one point overlap fully; their pair has no direction to push along
        if (!grad || d === 0) continue;
        if (j !== i) {
          // the pair's two halves add up to wij pen^2, whose gradient in p is 2 wij pen (q' - p) / d
          gx += (2 * wij * pen * dx) / d;
          gy += (2 * wij * pen * dy) / d;
        } else {
          // loop: q' = R p + t, so d/dp |q' - p| = (R - I)^T (q' - p) / d
          const ux = dx / d;
          const uy = dy / d;
          const rx = T.c * ux + T.s * uy - ux;
          const ry = -T.s * ux + T.c * uy - uy;
          gx += -wij * pen * rx;
          gy += -wij * pen * ry;
        }
      }
      const F = faces[node.face];
      for (let k = 0; k < F.ids.length; k++) {
        const [vx, vy] = apply(T, F.poly[2 * k], F.poly[2 * k + 1]);
        if (!inWedge(node.wedge, p.x, p.y, vx, vy, 1e-12)) continue;
        const dx = vx - p.x;
        const dy = vy - p.y;
        const d = Math.hypot(dx, dy);
        if (d >= lam) continue;
        // each vertex once, at its closest appearance (continuity, as in the fold search)
        const id = F.ids[k];
        const old = vbest.get(id);
        if (!old || d < old[0]) vbest.set(id, [d, dx, dy]);
      }
    });
    for (const [d, dx, dy] of vbest.values()) {
      const pen = lam - d;
      e += CONE_WEIGHT * wi * pen * pen;
      dlam += 2 * CONE_WEIGHT * wi * pen;
      if (grad && d > 0) {
        gx += (2 * CONE_WEIGHT * wi * pen * dx) / d;
        gy += (2 * CONE_WEIGHT * wi * pen * dy) / d;
      }
    }
    if (grad) {
      grad[2 * i] = gx;
      grad[2 * i + 1] = gy;
    }
  }
  return { e, dlam };
}

/** True when disk i overlaps nothing (other disks, itself, cone points) by more than tol (unit solid). */
export function diskClear(solid: Solid, lam: number, poses: SurfacePose[], i: number, tol: number): boolean {
  const faces = faceShapes(solid);
  const p = poses[i];
  let nodes: ChainNode[];
  try {
    nodes = enumerateChains(solid, 1, p.face, p.x, p.y, 2 * lam, MODEL_MAX_CHAINS);
  } catch (err) {
    throw new TooLarge(err instanceof Error ? err.message : String(err));
  }
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const T = node.toAnchor;
    for (let j = 0; j < poses.length; j++) {
      const q = poses[j];
      if (q.face !== node.face || (j === i && ni === 0)) continue;
      const [qx, qy] = apply(T, q.x, q.y);
      if (!inWedge(node.wedge, p.x, p.y, qx, qy, 0)) continue;
      if (Math.hypot(qx - p.x, qy - p.y) < 2 * lam - tol) return false;
    }
    const F = faces[node.face];
    for (let k = 0; k < F.ids.length; k++) {
      const [vx, vy] = apply(T, F.poly[2 * k], F.poly[2 * k + 1]);
      if (!inWedge(node.wedge, p.x, p.y, vx, vy, 1e-12)) continue;
      if (Math.hypot(vx - p.x, vy - p.y) < lam - tol) return false;
    }
  }
  return true;
}
