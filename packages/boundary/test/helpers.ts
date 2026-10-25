import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BoundaryConfig, Polytope } from "../src/index";
import { toAmbient } from "../src/index";

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

/** A uniformly random unit vector of R^3. */
export function randomDirection(rand: () => number): number[] {
  for (;;) {
    const v = [2 * rand() - 1, 2 * rand() - 1, 2 * rand() - 1];
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n > 0.1 && n <= 1) return v.map((x) => x / n);
  }
}

/** A uniformly random point of a tesseract cell at edge s (local coordinates), at least `margin` inside. */
export function randomCellPoint(s: number, rand: () => number, margin = 0): number[] {
  const h = s / 2 - margin;
  return [0, 1, 2].map(() => (2 * rand() - 1) * h);
}

export interface Fixture {
  id: string;
  source: string;
  config: BoundaryConfig;
}

export function loadFixtures(name: "balls" | "cubes"): Fixture[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")).configs;
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

/**
 * Independent reference for the development, working in R^4 only (as the research prototype's
 * poly4d.py): walk the ray from local point u of `cell` in local direction dir for length L. Inside
 * a cell the ray is straight; at the first other cell's hyperplane it meets it is rotated by the
 * rotation in span(n_c, n_c') taking n_c to n_c'. Uses only the cells' normals, origins and
 * frames, not the engine's gluing maps. Returns the end point and the cells passed, or null when
 * the ray passes within `htol` of a hinge.
 */
export function trace4d(poly: Polytope, s: number, cell: number, u: number[], dir: number[], L: number, htol = 1e-9): { cell: number; u: number[]; cells: number[] } | null {
  const cells = poly.cells;
  let c = cell;
  let p = toAmbient(poly, cell, u, s);
  const f = cells[cell].frame;
  let v = [0, 1, 2, 3].map((i) => f[0][i] * dir[0] + f[1][i] * dir[1] + f[2][i] * dir[2]);
  const nv = Math.hypot(...v);
  v = v.map((x) => x / nv);
  const beta = cells.map((cc) => s * dot(cc.normal, cc.origin));
  let rem = L;
  const passed = [c];
  for (let step = 0; step < 10000; step++) {
    let best = Infinity;
    let next = -1;
    cells.forEach((cc, k) => {
      if (k === c) return;
      const den = dot(cc.normal, v);
      if (den <= 1e-15) return;
      const t = (beta[k] - dot(cc.normal, p)) / den;
      if (t < best) {
        best = t;
        next = k;
      }
    });
    if (best >= rem) {
      p = p.map((x, i) => x + rem * v[i]);
      // local coordinates in the cell the walk ended in
      const cc = cells[c];
      const d = p.map((x, i) => x - s * cc.origin[i]);
      return { cell: c, u: cc.frame.map((fr) => dot(fr, d)), cells: passed };
    }
    best = Math.max(best, 0);
    const q = p.map((x, i) => x + best * v[i]);
    // hinge test: another hyperplane (besides c's and next's) tight at q
    for (let k = 0; k < cells.length; k++) {
      if (k === c || k === next) continue;
      if (beta[k] - dot(cells[k].normal, q) < htol) return null;
    }
    const n = cells[c].normal;
    const n2 = cells[next].normal;
    const cphi = dot(n, n2);
    const e0 = n2.map((x, i) => x - cphi * n[i]);
    const en = Math.hypot(...e0);
    const e = e0.map((x) => x / en);
    const sphi = dot(n2, e);
    const rot = (x: number[]) => {
      const a = dot(n, x);
      const b = dot(e, x);
      return x.map((xi, i) => xi + (cphi - 1) * (a * n[i] + b * e[i]) + sphi * (a * e[i] - b * n[i]));
    };
    v = rot(v);
    const vn = dot(n2, v);
    v = v.map((x, i) => x - vn * n2[i]);
    p = q;
    rem -= best;
    c = next;
    passed.push(c);
  }
  throw new Error("trace4d: too many crossings");
}

/** A 4-simplex with unit edge centred at the origin: e_0..e_4 of R^5 in an orthonormal basis of their hyperplane. */
export function simplexVertices(): number[][] {
  const E = [0, 1, 2, 3, 4].map((k) => [0, 1, 2, 3, 4].map((i) => (i === k ? 1 : 0)));
  const c = [0.2, 0.2, 0.2, 0.2, 0.2];
  // orthonormal basis of { x : sum x = 0 }
  const B: number[][] = [];
  for (let k = 0; k < 4; k++) {
    let r = E[k].map((x, i) => x - c[i]);
    for (const b of B) {
      const t = dot(r, b);
      r = r.map((x, i) => x - t * b[i]);
    }
    const n = Math.hypot(...r);
    B.push(r.map((x) => x / n));
  }
  return E.map((e) => B.map((b) => dot(e.map((x, i) => x - c[i]), b) / Math.SQRT2));
}

/** The 16-cell with unit edge: +-e_k / sqrt 2. */
export function cell16Vertices(): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < 4; k++)
    for (const sg of [-1, 1]) out.push([0, 1, 2, 3].map((i) => (i === k ? sg / Math.SQRT2 : 0)));
  return out;
}

/** The 24-cell with unit edge: permutations of (+-1, +-1, 0, 0) / sqrt 2. */
export function cell24Vertices(): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < 4; a++)
    for (let b = a + 1; b < 4; b++)
      for (const sa of [-1, 1])
        for (const sb of [-1, 1]) out.push([0, 1, 2, 3].map((i) => (i === a ? sa / Math.SQRT2 : i === b ? sb / Math.SQRT2 : 0)));
  return out;
}
