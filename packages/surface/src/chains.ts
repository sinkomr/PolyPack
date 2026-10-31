import { IDENTITY, Rigid, apply, compose, glue } from "./rigid";
import { Solid, faceVertex, frameVertex } from "./solids";

/**
 * Development of a neighbourhood of a point c of the surface into the plane of its face's frame
 * (the "anchor frame").
 *
 * A straight ray from c that avoids the vertices crosses a sequence of edges. Rays crossing the
 * same edge sequence (a chain) form a wedge with apex c. A chain node holds the last face of the
 * chain unfolded into the anchor frame and the closed wedge of directions whose rays cross the
 * chain's edges in order. The part of a piece on that face is piece ∩ unfolded face ∩ wedge.
 *
 * Enumeration is a depth-first search that keeps every chain any ray of length <= reach can
 * follow. Three prunings, each valid for every ray that avoids the vertices:
 * 1. distance: an edge farther than `reach` from c cannot be crossed by such a ray;
 * 2. empty wedge: no ray crosses the chain's edges in order (a wedge of width 0 is one ray through
 *    a vertex, so it counts as empty too);
 * 3. turn rule: a straight line that crosses several consecutive edges around one vertex V sweeps
 *    less than pi of angle around V (a line subtends exactly pi seen from a point off it), so
 *    the faces passed between the first and the last such edge have face angles at V summing to
 *    less than pi. A chain that breaks this cannot be followed by a ray. (On the Platonic solids
 *    every face angle is the same, (M - 2) pi / M; on the others the angles at V are summed.)
 * Rays that hit a vertex are covered by the closed wedges (their last face has that vertex).
 */

/** Closed angular interval [a0, a0 + w] of directions, 0 <= w <= pi, with unit end vectors. */
export interface Wedge {
  a0: number;
  w: number;
  lx: number;
  ly: number;
  hx: number;
  hy: number;
}

export interface ChainNode {
  face: number;
  /** face frame -> anchor frame */
  toAnchor: Rigid;
  /** null for the root (all directions) */
  wedge: Wedge | null;
  /** edge of `face` through which the chain entered it, -1 for the root */
  entry: number;
  depth: number;
  parent: number;
  /** edges crossed, as (face left, edge of that face) */
  path: { face: number; edge: number }[];
  /** vertex id shared by the last two crossed edges (-1 if none) and the number of faces passed around it */
  runVertex: number;
  runCount: number;
  /** sum of the face angles at runVertex of the faces passed around it (0 when runVertex is -1) */
  runAngle?: number;
  /**
   * Index of the first earlier node with the same face and the same development (see
   * `markTwins`), or undefined. Set on the later nodes of a group of twins only.
   */
  twin?: number;
}

export let MAX_CHAIN_DEPTH = 80;
/** For tests and debugging. */
export function setMaxChainDepth(d: number): void {
  MAX_CHAIN_DEPTH = d;
}

export function normAngle(a: number): number {
  let t = a % (2 * Math.PI);
  if (t <= -Math.PI) t += 2 * Math.PI;
  else if (t > Math.PI) t -= 2 * Math.PI;
  return t;
}

function makeWedge(a0: number, w: number): Wedge {
  const a1 = a0 + w;
  return { a0, w, lx: Math.cos(a0), ly: Math.sin(a0), hx: Math.cos(a1), hy: Math.sin(a1) };
}

/** Closed cone of rays from (cx, cy) through the segment A -> B, where c lies left of A -> B. */
export function coneOverEdge(cx: number, cy: number, ax: number, ay: number, bx: number, by: number): Wedge {
  const ux = ax - cx;
  const uy = ay - cy;
  const vx = bx - cx;
  const vy = by - cy;
  const a0 = Math.atan2(uy, ux);
  let w = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  // c on the edge line gives w = pi; rounding to the far side gives w near -pi
  if (w < 0) w = Math.PI;
  return makeWedge(a0, Math.min(w, Math.PI));
}

/**
 * Intersection of two closed wedges with the same apex, or null when it has no interior.
 * A wedge of width 0 is a single ray through a vertex (its boundary rays pass through edge
 * endpoints), which no vertex-avoiding ray follows, so widths below `minWidth` radians count as empty.
 */
export function intersectWedges(A: Wedge | null, B: Wedge, minWidth = 1e-12): Wedge | null {
  if (!A) return B.w < minWidth ? null : B;
  const d = normAngle(B.a0 - A.a0);
  const lo = Math.max(0, d);
  const hi = Math.min(A.w, d + B.w);
  if (hi - lo < minWidth) return null;
  return makeWedge(A.a0 + lo, hi - lo);
}

/** Is the point (x, y) within distance tol of the closed wedge with apex (cx, cy)? */
export function inWedge(W: Wedge | null, cx: number, cy: number, x: number, y: number, tol = 1e-9): boolean {
  if (!W) return true;
  const vx = x - cx;
  const vy = y - cy;
  // both half-planes bound the wedge exactly when w <= pi
  return W.lx * vy - W.ly * vx >= -tol && vx * W.hy - vy * W.hx >= -tol;
}

export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const L2 = ex * ex + ey * ey;
  let t = L2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * ex, py - ay - t * ey);
}

/** Thrown by enumerateChains when a point has more chains than the caller allows. */
export class ChainLimitError extends Error {}

/**
 * All chains from the point (cx, cy) of face `anchor` that a ray of length <= reach can follow.
 * The root (index 0) is the anchor face itself. `maxChains` bounds the work for untrusted input
 * (a solid far too small for its pieces): more chains than that throw a ChainLimitError.
 */
export function enumerateChains(solid: Solid, s: number, anchor: number, cx: number, cy: number, reach: number, maxChains = Infinity): ChainNode[] {
  const uniform = solid.uniform;
  const out: ChainNode[] = [
    { face: anchor, toAnchor: IDENTITY, wedge: null, entry: -1, depth: 0, parent: -1, path: [], runVertex: -1, runCount: 0, runAngle: 0 },
  ];
  // the Platonic solids: one frame for every face, as before the generalisation
  const shared: [number, number][] = [];
  if (uniform) for (let k = 0; k < solid.M; k++) shared.push(frameVertex(solid.M, s, k));
  const slack = 1e-12 * Math.max(1, s);
  for (let idx = 0; idx < out.length; idx++) {
    const node = out[idx];
    if (node.depth >= MAX_CHAIN_DEPTH)
      throw new Error(`chain depth limit reached: ${node.path.map((e) => `${e.face}:${e.edge}`).join(" ")} w=${node.wedge?.w}`);
    const T = node.toAnchor;
    const M = solid.sides[node.face];
    let verts = shared;
    if (!uniform) {
      verts = [];
      for (let k = 0; k < M; k++) verts.push(faceVertex(solid, s, node.face, k));
    }
    for (let k = 0; k < M; k++) {
      if (k === node.entry) continue;
      const [ax, ay] = apply(T, verts[k][0], verts[k][1]);
      const [bx, by] = apply(T, verts[(k + 1) % M][0], verts[(k + 1) % M][1]);
      // c strictly beyond this edge's line: no ray from c crosses it out of the face
      if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < -slack * s) continue;
      if (pointSegmentDistance(cx, cy, ax, ay, bx, by) > reach + slack) continue;
      let runVertex = -1;
      let runCount = 0;
      let runAngle = 0;
      if (node.entry >= 0) {
        let local = -1;
        if (k === (node.entry + 1) % M) local = k;
        else if (k === (node.entry + M - 1) % M) local = node.entry;
        if (local >= 0) {
          runVertex = solid.faces[node.face][local];
          const same = runVertex === node.runVertex;
          runCount = same ? node.runCount + 1 : 1;
          runAngle = (same ? (node.runAngle ?? 0) : 0) + solid.corner[node.face][local];
          if ((uniform ? runCount * solid.faceAngle : runAngle) >= Math.PI - 1e-9) continue;
        }
      }
      const W = intersectWedges(node.wedge, coneOverEdge(cx, cy, ax, ay, bx, by));
      if (!W) continue;
      if (out.length >= maxChains)
        throw new ChainLimitError(`more than ${maxChains} chains of faces from one point (face ${anchor}): the solid is far too small for its pieces`);
      const g = glue(solid, s, node.face, k);
      out.push({
        face: g.face,
        toAnchor: compose(T, g.T),
        wedge: W,
        entry: g.edge,
        depth: node.depth + 1,
        parent: idx,
        path: [...node.path, { face: node.face, edge: k }],
        runVertex,
        runCount,
        runAngle,
      });
    }
  }
  markTwins(out, slack);
  return out;
}

/**
 * Mark chains whose developments coincide. At a vertex of cone angle exactly pi (three triangles
 * meet), going around the vertex to the left or to the right reaches the same face with the same
 * rigid motion, since a rotation by pi equals one by -pi. The two wedges then only share a boundary
 * ray through that vertex, and a point on it (such as a disk's own image p' = 2A - p) lies in both.
 * Energies count a point once over a group of twins (the union of their wedges); see diskEnergy.
 * The fields of the nodes and their order are unchanged.
 */
export function markTwins(nodes: ChainNode[], slack: number): void {
  const byFace = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    const list = byFace.get(n.face);
    if (!list) {
      byFace.set(n.face, [i]);
      return;
    }
    for (const j of list) {
      const a = nodes[j].toAnchor;
      const b = n.toAnchor;
      if (
        Math.abs(a.c - b.c) <= slack &&
        Math.abs(a.s - b.s) <= slack &&
        Math.abs(a.tx - b.tx) <= slack &&
        Math.abs(a.ty - b.ty) <= slack
      ) {
        n.twin = nodes[j].twin ?? j;
        return;
      }
    }
    list.push(i);
  });
}

/** The later twins of each node that has some, by the index of the first of the group. */
export function twinGroups(nodes: ChainNode[]): Map<number, ChainNode[]> {
  const groups = new Map<number, ChainNode[]>();
  for (const node of nodes)
    if (node.twin !== undefined) {
      const l = groups.get(node.twin);
      if (l) l.push(node);
      else groups.set(node.twin, [node]);
    }
  return groups;
}

/**
 * Does node `ni` count the developed image (x, y) of a centre c = (cx, cy)? A twin node never does;
 * the first of a group does when the image lies in any of the group's wedges (the shared boundary
 * ray included, tolerance 1e-12), so the group counts it once; any other node tests its own wedge.
 */
export function countsImage(nodes: ChainNode[], groups: Map<number, ChainNode[]>, ni: number, cx: number, cy: number, x: number, y: number): boolean {
  const node = nodes[ni];
  if (node.twin !== undefined) return false;
  const group = groups.get(ni);
  if (!group) return inWedge(node.wedge, cx, cy, x, y, 0);
  return inWedge(node.wedge, cx, cy, x, y, 1e-12) || group.some((m) => inWedge(m.wedge, cx, cy, x, y, 1e-12));
}
