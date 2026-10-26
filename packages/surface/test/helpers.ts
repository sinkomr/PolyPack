import { Solid, apply, applyDir, faceApothem, faceDepth, faceVertices, frameVertex, glue } from "../src/index";

/** Seeded generator (mulberry32) so that every test is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniformly random point of face polygon (rejection sampling from the circumscribed disk). */
export function randomFacePoint(solid: Solid, s: number, rand: () => number, margin = 0): [number, number] {
  const ap = faceApothem(solid.M, s);
  for (;;) {
    const x = (2 * rand() - 1) * ap * 1.3;
    const y = (2 * rand() - 1) * ap * 1.3;
    let inside = true;
    for (let j = 0; j < solid.M; j++) {
      const a = (2 * Math.PI * (j + 1)) / solid.M - Math.PI / 2;
      if (x * Math.cos(a) + y * Math.sin(a) > ap - margin) inside = false;
    }
    if (inside) return [x, y];
  }
}

/**
 * Independent reference for the development: walk a straight ray from (x, y) on `face` in
 * direction (dx, dy) (unit) for length L, re-anchoring in the neighbour's frame at every edge.
 * Returns the end point, or null when the ray passes within `vtol` of a vertex.
 */
export function walkRay(solid: Solid, s: number, face: number, x: number, y: number, dx: number, dy: number, L: number, vtol = 1e-9): { face: number; x: number; y: number } | null {
  const M = solid.M;
  let f = face;
  let px = x;
  let py = y;
  let ux = dx;
  let uy = dy;
  let left = L;
  let entry = -1;
  const ap = faceApothem(M, s);
  for (let step = 0; step < 1000; step++) {
    // exit parameter through each edge line: n_j . (p + t u) = ap
    let tBest = Infinity;
    let kBest = -1;
    for (let j = 0; j < M; j++) {
      if (j === entry) continue;
      const a = (2 * Math.PI * (j + 1)) / M - Math.PI / 2;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      const un = ux * nx + uy * ny;
      if (un <= 1e-15) continue;
      const t = (ap - (px * nx + py * ny)) / un;
      if (t < tBest) {
        tBest = t;
        kBest = j;
      }
    }
    if (tBest >= left) return { face: f, x: px + left * ux, y: py + left * uy };
    const ex = px + tBest * ux;
    const ey = py + tBest * uy;
    const [ax, ay] = frameVertex(M, s, kBest);
    const [bx, by] = frameVertex(M, s, kBest + 1);
    if (Math.hypot(ex - ax, ey - ay) < vtol || Math.hypot(ex - bx, ey - by) < vtol) return null;
    // glue maps the neighbour's frame into ours; we need ours -> neighbour's
    const g = glue(solid, s, f, kBest);
    const T = g.T;
    const inv = { ang: -T.ang, c: T.c, s: -T.s, tx: -(T.c * T.tx + T.s * T.ty), ty: -(-T.s * T.tx + T.c * T.ty) };
    [px, py] = apply(inv, ex, ey);
    [ux, uy] = applyDir(inv, ux, uy);
    left -= tBest;
    f = g.face;
    entry = g.edge;
  }
  throw new Error("walkRay: too many steps");
}

/** A uniformly random point of face f of any solid at scale s, at least `margin` inside (rejection from the bounding box). */
export function randomPointOf(solid: Solid, s: number, f: number, rand: () => number, margin = 0): [number, number] {
  const u = solid.unitFaces[f];
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < u.length; i += 2) {
    x0 = Math.min(x0, s * u[i]);
    x1 = Math.max(x1, s * u[i]);
    y0 = Math.min(y0, s * u[i + 1]);
    y1 = Math.max(y1, s * u[i + 1]);
  }
  for (;;) {
    const x = x0 + rand() * (x1 - x0);
    const y = y0 + rand() * (y1 - y0);
    if (faceDepth(solid, s, f, x, y) > margin) return [x, y];
  }
}

/**
 * walkRay for any convex faces: an independent ray walk that leaves each face through the edge whose
 * line the ray meets first and re-anchors in the neighbour's frame. Null when the ray passes within
 * `vtol` of a vertex.
 */
export function walkRayOf(solid: Solid, s: number, face: number, x: number, y: number, dx: number, dy: number, L: number, vtol = 1e-9): { face: number; x: number; y: number } | null {
  let f = face;
  let px = x;
  let py = y;
  let ux = dx;
  let uy = dy;
  let left = L;
  let entry = -1;
  for (let step = 0; step < 1000; step++) {
    const V = faceVertices(solid, s, f);
    const M = V.length;
    let tBest = Infinity;
    let kBest = -1;
    for (let j = 0; j < M; j++) {
      if (j === entry) continue;
      const [ax, ay] = V[j];
      const [bx, by] = V[(j + 1) % M];
      // outward normal of edge j (the face lies to its left)
      const nx = by - ay;
      const ny = -(bx - ax);
      const un = ux * nx + uy * ny;
      if (un <= 1e-15) continue;
      const t = (nx * (ax - px) + ny * (ay - py)) / un;
      if (t < tBest) {
        tBest = t;
        kBest = j;
      }
    }
    if (tBest >= left) return { face: f, x: px + left * ux, y: py + left * uy };
    const ex = px + tBest * ux;
    const ey = py + tBest * uy;
    const [ax, ay] = V[kBest];
    const [bx, by] = V[(kBest + 1) % M];
    if (Math.hypot(ex - ax, ey - ay) < vtol || Math.hypot(ex - bx, ey - by) < vtol) return null;
    const g = glue(solid, s, f, kBest);
    const T = g.T;
    const inv = { ang: -T.ang, c: T.c, s: -T.s, tx: -(T.c * T.tx + T.s * T.ty), ty: -(-T.s * T.tx + T.c * T.ty) };
    [px, py] = apply(inv, ex, ey);
    [ux, uy] = applyDir(inv, ux, uy);
    left -= tBest;
    f = g.face;
    entry = g.edge;
  }
  throw new Error("walkRayOf: too many steps");
}
