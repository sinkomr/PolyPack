/**
 * Developments of the boundary from a point: the exponential map at a centre u of a closed cell.
 *
 * A straight ray from u that avoids the hinges (the edges) crosses a sequence of ridges (a chain);
 * unfold the cells it passes into the anchor cell's local frame (each gluing is an isometry that
 * fixes its ridge). For a chain C = (R_1, ..., R_k), let W(C) be the set of directions whose rays
 * cross R_1, ..., R_k in this order: the window. It is a convex polyhedral cone with apex u:
 *
 *   W(R_1) = cone_u(R_1),   W(R_1..R_k) = W(R_1..R_k-1) ∩ cone_u(R_k) = cone_u(G_k),
 *   G_k = R_k ∩ W(R_1..R_k-1)   (the "gate": the part of the developed ridge the rays reach),
 *
 * where R_j is the developed ridge polygon and cone_u(G) the rays from u through G. Lemma (as in
 * the 2D surface track): a ray in the interior of W(C) crosses R_1, ..., R_k in this order and runs
 * inside each developed cell between consecutive crossings, because each developed cell lies on
 * the far side of the plane of the ridge it was entered through and a ray crosses a plane once.
 * The part of a piece X in the last cell is X ∩ (developed cell) ∩ W(C).
 *
 * Enumeration is breadth-first from the anchor cell. A branch is cut only when no hinge-avoiding
 * ray of length <= reach can follow it:
 * 1. side: u lies on or beyond the plane of the next ridge (seen from the current developed cell);
 *    such a ray would have to cross that plane at its start (only possible at the anchor cell,
 *    where a centre on a ridge sees the closed half-space beyond it as the window);
 * 2. distance: the gate is farther than `reach` from u;
 * 3. empty window: the gate has fewer than 3 vertices after clipping, or the window is thinner than
 *    MIN_WINDOW_ANGLE. Thinness is tested with an upper bound, never an estimate: for a face of
 *    the window with inward unit normal N (a plane through u) and any gate point p, N . (p - u) is
 *    linear in p, so it is at most its largest value over the gate's vertices, and |p - u| is at
 *    least dist(u, gate); hence the window's angular height above that face (the largest
 *    N . d over its unit directions d) is at most max_v N . (v - u) / dist(u, gate). A window is
 *    cut only when this bound is below MIN_WINDOW_ANGLE for some face, so every window cut is
 *    truly that thin and its part has a thickness below MIN_WINDOW_ANGLE x reach. (Measuring the
 *    height along the vertex rays alone, as an earlier version did, under-estimates it when u is
 *    near the gate's plane: every vertex ray is then nearly parallel to the plane although the
 *    window is nearly the whole half-space beyond it.)
 * 4. turn rule: a straight line not meeting an edge e sees e under exactly pi in the plane normal
 *    to e, so it can cross consecutive ridges around e only while the cells passed between them
 *    have dihedral angles at e summing to less than pi (at most one cube of the tesseract).
 * Termination: windows only shrink, the gate distance grows with each crossing (cells have
 * positive width), and `maxChains` / `maxDepth` bound the work for untrusted input.
 *
 * Centres near ridges (any convex polytope). The centre is first clamped into its closed anchor
 * cell and then snapped onto every facet plane of the anchor within the snap distance eta
 * (clampToCell; it moves by at most sqrt 3 eta). eta defaults to RIDGE_SNAP max(1, s); the
 * validator passes ridgeSnap(s, tol) = min(that, tol / 10), never below one rounding unit of s,
 * and charges each piece's actual snap displacement to its verdict (validate.ts), so the snap is
 * never extra tolerance. A centre on a facet's plane lies on that facet (it is in the closed
 * cell), and every ray from it into the open half-space beyond the facet crosses the ridge at its
 * start, so that half-space is the exact window of the chain through that facet. Every other
 * facet plane of the anchor is then more than eta away, and the cone over its ridge is computed:
 * its side normals carry a tilt of about eta / (distance to the ridge's edges); when eta is near
 * the rounding unit that tilt is noisy, but the noise only moves the window's faces by angles of
 * the order of the rounding unit / distance (the faces' main component, along the ridge's normal,
 * is large and exact in sign), and rule 3's bound stays sound. Deeper in a chain a ridge plane
 * within eta of u is skipped (rule 1): every ray through such a gate makes an angle below
 * eta / dist(u, gate) with the gate's plane, so the part lost lies in a slab of thickness below
 * reach x eta / dist(u, gate).
 */
import {
  ISO_IDENTITY,
  Iso3,
  V3,
  cross3,
  dot3,
  isoApply,
  isoCompose,
  isoInverse,
  isoLinear,
  norm3,
  pointSegmentDistance3,
  sub3,
  toV3,
  unit3,
} from "./linalg";
import { topo } from "./polytope";
import type { Polytope } from "./types";

export interface ChainNode {
  /** The cell reached. */
  cell: number;
  /** This cell's local coordinates -> the anchor's local coordinates (the development), at edge s. */
  toAnchor: Iso3;
  /**
   * The window: unit normals N, in the anchor frame, of the planes through the centre u that bound
   * it, { y : N . (y - u) >= 0 }. Empty for the anchor (all directions).
   */
  window: V3[];
  /** The gate: the last ridge crossed, clipped to the parent's window, in the anchor frame (empty for the anchor). */
  gate: V3[];
  /** Distance from u to the gate (0 for the anchor). */
  gateDist: number;
  /** Facet of `cell` through which the chain entered (-1 for the anchor). */
  entry: number;
  /** Index of the parent node (-1 for the anchor). */
  parent: number;
  depth: number;
  /** Cells crossed, anchor first, this cell last. */
  cells: number[];
  /** Polytope edge shared by the last two ridges crossed (-1 if none), and the angle swept around it. */
  runEdge: number;
  runAngle: number;
}

/** Thrown when a point has more chains (or longer ones) than the caller allows. */
export class ChainLimitError extends Error {}

export interface ChainOptions {
  /** Most chains from one point (default 20000). */
  maxChains?: number;
  /** Longest chain (default 256 crossings). */
  maxDepth?: number;
  /** Snap distance eta for centres near the anchor's facet planes (default RIDGE_SNAP max(1, s)). */
  snap?: number;
}

/** Windows thinner than this (sine of an angle, by the upper bound of rule 3) are treated as empty. */
export const MIN_WINDOW_ANGLE = 1e-12;

/** Default snap: centres within RIDGE_SNAP max(1, s) of a facet plane of their anchor cell are snapped onto it. */
export const RIDGE_SNAP = 1e-14;

/**
 * The snap distance at edge s: RIDGE_SNAP max(1, s), or, given a tolerance, the smaller of that
 * and tol / 10, but never below one rounding unit of s (2^-52 max(1, s)), under which the side
 * of a ridge plane is not decided reliably.
 */
export function ridgeSnap(s: number, tol?: number): number {
  const base = RIDGE_SNAP * Math.max(1, s);
  if (tol === undefined) return base;
  return Math.max(2 ** -52 * Math.max(1, s), Math.min(base, tol / 10));
}

/**
 * The centre the development works from: u clamped into the closed cell (moved by at most the
 * largest facet violation), then snapped onto every facet plane within `snap` (default
 * RIDGE_SNAP max(1, s); see "Centres near ridges" above). Every computation of a piece (chains,
 * parts, distances) uses it. snap = 0 clamps only.
 */
export function clampToCell(poly: Polytope, cell: number, u: readonly number[], s: number, snap = ridgeSnap(s)): V3 {
  const ct = topo(poly).cells[cell];
  const p: V3 = [u[0], u[1], u[2]];
  const eta = snap;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const pl of ct.planes) {
      const ex = dot3(pl.n, p) - pl.h * s;
      if (ex > 0 || (ex > -eta && ex !== 0)) {
        p[0] -= ex * pl.n[0];
        p[1] -= ex * pl.n[1];
        p[2] -= ex * pl.n[2];
        moved = true;
      }
    }
    if (!moved) break;
  }
  return p;
}

/** Twice the area vector of a planar polygon (Newell): its direction is the counter-clockwise normal. */
export function polygonNormal(P: readonly V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Drops consecutive (cyclic) vertices closer than eps. */
export function dedupePolygon(P: V3[], eps: number): V3[] {
  const out: V3[] = [];
  for (const p of P) {
    const q = out[out.length - 1];
    if (q && Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps && Math.abs(p[2] - q[2]) <= eps) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps) out.pop();
    else break;
  }
  return out;
}

/**
 * Sutherland–Hodgman clip of a planar convex polygon by the half-space { y : N . (y - u) >= 0 }.
 * Intersection points are computed from the vertex inside to the vertex outside.
 */
export function clipPolygonByPlane(P: V3[], N: V3, u: V3, eps: number): V3[] {
  const n = P.length;
  if (n === 0) return P;
  const d = P.map((p) => N[0] * (p[0] - u[0]) + N[1] * (p[1] - u[1]) + N[2] * (p[2] - u[2]));
  if (d.every((x) => x >= 0)) return P;
  if (d.every((x) => x <= 0)) return [];
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (d[i] >= 0) out.push(P[i]);
    if ((d[i] > 0 && d[j] < 0) || (d[i] < 0 && d[j] > 0)) {
      const [a, da, b, db] = d[i] > 0 ? [P[i], d[i], P[j], d[j]] : [P[j], d[j], P[i], d[i]];
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return dedupePolygon(out, eps);
}

/** Distance from u to a planar convex polygon P, counter-clockwise around the unit normal m. */
export function polygonDistance(u: V3, P: readonly V3[], m: V3): number {
  const h = dot3(sub3(u, P[0]), m);
  const f: V3 = [u[0] - h * m[0], u[1] - h * m[1], u[2] - h * m[2]];
  let inside = true;
  for (let i = 0; i < P.length && inside; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    if (dot3(cross3(sub3(b, a), sub3(f, a)), m) < 0) inside = false;
  }
  if (inside) return Math.abs(h);
  let best = Infinity;
  for (let i = 0; i < P.length; i++) best = Math.min(best, pointSegmentDistance3(u, P[i], P[(i + 1) % P.length]));
  return best;
}

/**
 * The cone from u over a planar convex polygon G (counter-clockwise around the direction the rays
 * travel, u strictly before G's plane), as inward unit normals of its faces; null when the cone is
 * thinner than MIN_WINDOW_ANGLE by the upper bound of rule 3. `dist` is dist(u, G) when the caller
 * has it (computed from G's own plane otherwise).
 */
export function coneOver(u: V3, G: readonly V3[], dist = polygonDistance(u, G, unit3(polygonNormal(G)))): V3[] | null {
  const n = G.length;
  const rays = G.map((p) => unit3(sub3(p, u)));
  const normals: V3[] = [];
  for (let j = 0; j < n; j++) {
    const c = cross3(rays[j], rays[(j + 1) % n]);
    const L = norm3(c);
    if (L < 1e-15) continue;
    normals.push([c[0] / L, c[1] / L, c[2] / L]);
  }
  if (normals.length < 3) return null;
  if (!(dist > 0)) return normals;
  // upper bound on the window's angular height above each face (rule 3): max_v N.(v - u) / dist(u, G)
  let thin = Infinity;
  for (const N of normals) {
    let hmax = 0;
    for (const p of G) hmax = Math.max(hmax, N[0] * (p[0] - u[0]) + N[1] * (p[1] - u[1]) + N[2] * (p[2] - u[2]));
    thin = Math.min(thin, hmax / dist);
  }
  return thin < MIN_WINDOW_ANGLE ? null : normals;
}

/**
 * All chains from the point u (local coordinates at edge s) of cell `anchor` that a ray of length
 * <= reach avoiding the hinges can follow. The anchor itself is node 0.
 */
export function enumerateChains(poly: Polytope, s: number, anchor: number, u: readonly number[], reach: number, opts: ChainOptions = {}): ChainNode[] {
  const maxChains = opts.maxChains ?? 20000;
  const maxDepth = opts.maxDepth ?? 256;
  const T = topo(poly);
  const eta = opts.snap ?? ridgeSnap(s);
  const uc = clampToCell(poly, anchor, u, s, eta);
  const sc = Math.max(1, s);
  const eps = 1e-14 * sc;
  const slack = 1e-12 * sc;
  const out: ChainNode[] = [
    { cell: anchor, toAnchor: ISO_IDENTITY, window: [], gate: [], gateDist: 0, entry: -1, parent: -1, depth: 0, cells: [anchor], runEdge: -1, runAngle: 0 },
  ];
  for (let idx = 0; idx < out.length; idx++) {
    const node = out[idx];
    const ct = T.cells[node.cell];
    const uLoc = isoApply(isoInverse(node.toAnchor), uc);
    const isRoot = node.depth === 0;
    for (let k = 0; k < ct.F; k++) {
      if (k === node.entry) continue;
      const pl = ct.planes[k];
      // > 0: u strictly on the inner side of this facet's plane (seen from the developed cell).
      // At the anchor the clamped centre is in the closed cell, so delta <= eta (even < 0, by
      // rounding) means it lies on this facet: the half-space window below. Deeper, rule 1.
      const delta = pl.h * s - dot3(pl.n, uLoc);
      if (!isRoot && delta <= eta) continue;
      let runEdge = -1;
      let runAngle = 0;
      if (!isRoot) {
        const h = ct.pairHinge[node.entry * ct.F + k];
        if (h >= 0) {
          const e = T.hingeEdge[node.cell][h];
          runAngle = (e === node.runEdge ? node.runAngle : 0) + ct.hingeDihedral[h];
          if (runAngle >= Math.PI - 1e-9) continue;
          runEdge = e;
        }
      }
      let Q = ct.polys[k].map((p) => isoApply(node.toAnchor, [p[0] * s, p[1] * s, p[2] * s]));
      // m: the direction rays travel when they cross this ridge
      const m = isoLinear(node.toAnchor, pl.n);
      if (dot3(polygonNormal(Q), m) < 0) Q = Q.reverse();
      let gate: V3[];
      let window: V3[];
      let gateDist: number;
      if (isRoot && delta <= eta) {
        // the centre lies on this ridge: rays leaving through it fill the closed half-space beyond
        gate = Q;
        window = [m];
        gateDist = polygonDistance(uc, Q, m);
        if (gateDist > reach + slack) continue;
      } else {
        gate = Q;
        for (const N of node.window) {
          gate = clipPolygonByPlane(gate, N, uc, eps);
          if (gate.length < 3) break;
        }
        if (gate.length < 3) continue;
        gateDist = polygonDistance(uc, gate, m);
        if (gateDist > reach + slack) continue;
        const cone = coneOver(uc, gate, gateDist);
        if (!cone) continue;
        window = cone;
      }
      if (out.length >= maxChains)
        throw new ChainLimitError(`more than ${maxChains} chains of cells within distance ${reach} of a point of cell ${anchor}: the polytope is far too small for its pieces`);
      if (node.depth + 1 > maxDepth) throw new ChainLimitError(`a chain of more than ${maxDepth} cells from a point of cell ${anchor}`);
      const g = ct.glue[k];
      const gs: Iso3 = { m: g.m, t: [g.t[0] * s, g.t[1] * s, g.t[2] * s] };
      const facet = poly.cells[node.cell].facets[k];
      out.push({
        cell: facet.neighbor,
        toAnchor: isoCompose(node.toAnchor, isoInverse(gs)),
        window,
        gate,
        gateDist,
        entry: facet.neighborFacet,
        parent: idx,
        depth: node.depth + 1,
        cells: [...node.cells, facet.neighbor],
        runEdge,
        runAngle,
      });
    }
  }
  return out;
}

/** Is the point y (anchor frame) in the node's closed window, up to tol? */
export function inWindow(node: ChainNode, u: V3, y: V3, tol = 0): boolean {
  for (const N of node.window) if (N[0] * (y[0] - u[0]) + N[1] * (y[1] - u[1]) + N[2] * (y[2] - u[2]) < -tol) return false;
  return true;
}

/** The parameter interval [t0, t1] of the segment a + t (b - a), t in [0, 1], inside the closed window; null if empty. */
export function clipSegmentToWindow(window: readonly V3[], u: V3, a: V3, b: V3): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  for (const N of window) {
    const fa = N[0] * (a[0] - u[0]) + N[1] * (a[1] - u[1]) + N[2] * (a[2] - u[2]);
    const fb = N[0] * (b[0] - u[0]) + N[1] * (b[1] - u[1]) + N[2] * (b[2] - u[2]);
    // f(t) = fa + t (fb - fa) >= 0
    const df = fb - fa;
    if (df === 0) {
      if (fa < 0) return null;
      continue;
    }
    const t = -fa / df;
    if (df > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/** A point of the boundary: a cell and local coordinates at the configuration's s. */
export interface BoundaryPoint {
  cell: number;
  u: number[];
}

/**
 * Lengths of the straight developed paths from the centre of `nodes` to the point y of cell `cell`
 * (local coordinates): one per chain ending in that cell whose closed window holds y's image.
 */
export function pathLengths(nodes: readonly ChainNode[], u: V3, cell: number, y: readonly number[], skipRoot = false): number[] {
  const out: number[] = [];
  nodes.forEach((node, i) => {
    if (node.cell !== cell || (skipRoot && i === 0)) return;
    const img = isoApply(node.toAnchor, y);
    if (!inWindow(node, u, img)) return;
    out.push(norm3(sub3(img, u)));
  });
  return out;
}

/**
 * Geodesic (intrinsic) distance between two points of the boundary at edge s, when it is at most
 * `reach`; Infinity otherwise. Shortest paths avoid the hinges [EST: Miller, Pak 2008, Prop. 1.2],
 * so they develop into straight segments.
 */
export function geodesicDistance(poly: Polytope, s: number, a: BoundaryPoint, b: BoundaryPoint, reach = 2): number {
  const nodes = enumerateChains(poly, s, a.cell, a.u, reach);
  const u = clampToCell(poly, a.cell, a.u, s);
  const y = clampToCell(poly, b.cell, b.u, s);
  let best = Infinity;
  for (const d of pathLengths(nodes, u, b.cell, y)) best = Math.min(best, d);
  return best <= reach + 1e-12 ? best : Infinity;
}

/** Shortest geodesic loop at a point (a straight developed path back to it), if at most `reach`; Infinity otherwise. */
export function geodesicLoop(poly: Polytope, s: number, a: BoundaryPoint, reach = 2): number {
  const nodes = enumerateChains(poly, s, a.cell, a.u, reach);
  const u = clampToCell(poly, a.cell, a.u, s);
  let best = Infinity;
  for (const d of pathLengths(nodes, u, a.cell, u, true)) if (d > 1e-12) best = Math.min(best, d);
  return best <= reach + 1e-12 ? best : Infinity;
}

/** Distances from u to the hinges seen through each chain (the hinge segment clipped to the window), minimum over all. */
export function hingeDistanceOverChains(poly: Polytope, s: number, nodes: readonly ChainNode[], u: V3): number {
  const T = topo(poly);
  let best = Infinity;
  for (const node of nodes) {
    const ct = T.cells[node.cell];
    const V = ct.verts.map((p) => isoApply(node.toAnchor, [p[0] * s, p[1] * s, p[2] * s]));
    for (const [i, j] of poly.cells[node.cell].hinges) {
      const a = V[i];
      const b = V[j];
      const iv = clipSegmentToWindow(node.window, u, a, b);
      if (!iv) continue;
      const e = sub3(b, a);
      const p0: V3 = [a[0] + iv[0] * e[0], a[1] + iv[0] * e[1], a[2] + iv[0] * e[2]];
      const p1: V3 = [a[0] + iv[1] * e[0], a[1] + iv[1] * e[1], a[2] + iv[1] * e[2]];
      best = Math.min(best, pointSegmentDistance3(u, p0, p1));
    }
  }
  return best;
}

/** Geodesic distance from a point to the hinges (the 1-skeleton), if at most `reach`; Infinity otherwise. */
export function hingeClearance(poly: Polytope, s: number, a: BoundaryPoint, reach = 1): number {
  const nodes = enumerateChains(poly, s, a.cell, a.u, reach);
  const d = hingeDistanceOverChains(poly, s, nodes, clampToCell(poly, a.cell, a.u, s));
  return d <= reach + 1e-12 ? d : Infinity;
}

/**
 * Walks the geodesic ray from u (cell `cell`) in direction `dir` (local, any length) for `length`,
 * crossing ridges by the gluings. Returns the end point and the cells passed, or hitHinge = true
 * (with the point where it happened) when the ray meets a hinge within `hingeTol`.
 */
export function traceGeodesic(
  poly: Polytope,
  s: number,
  cell: number,
  u: readonly number[],
  dir: readonly number[],
  length: number,
  hingeTol = 1e-12,
): { cell: number; u: number[]; cells: number[]; hitHinge: boolean } {
  const T = topo(poly);
  let c = cell;
  let p = clampToCell(poly, cell, u, s);
  let d = unit3(toV3(dir));
  let rem = length;
  const cells = [c];
  for (let step = 0; step < 100000; step++) {
    const ct = T.cells[c];
    let best = Infinity;
    let k = -1;
    for (let f = 0; f < ct.F; f++) {
      const pl = ct.planes[f];
      const nd = dot3(pl.n, d);
      if (nd <= 1e-15) continue;
      const t = (pl.h * s - dot3(pl.n, p)) / nd;
      if (t < best) {
        best = t;
        k = f;
      }
    }
    if (best >= rem) {
      p = [p[0] + rem * d[0], p[1] + rem * d[1], p[2] + rem * d[2]];
      return { cell: c, u: p, cells, hitHinge: false };
    }
    best = Math.max(best, 0);
    const q: V3 = [p[0] + best * d[0], p[1] + best * d[1], p[2] + best * d[2]];
    for (let f = 0; f < ct.F; f++) {
      if (f === k) continue;
      const pl = ct.planes[f];
      if (pl.h * s - dot3(pl.n, q) < hingeTol * Math.max(1, s)) return { cell: c, u: q, cells, hitHinge: true };
    }
    const g = ct.glue[k];
    const gs: Iso3 = { m: g.m, t: [g.t[0] * s, g.t[1] * s, g.t[2] * s] };
    p = isoApply(gs, q);
    d = isoLinear(gs, d);
    c = poly.cells[c].facets[k].neighbor;
    cells.push(c);
    rem -= best;
  }
  throw new Error("traceGeodesic: too many crossings");
}
