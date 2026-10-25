/**
 * Moving a centre on the boundary: the exponential map in the cells' local charts.
 *
 * A centre (cell c, local u) moved by a vector v of c's local frame follows the segment u + t v,
 * t in [0, 1], of c's development: straight inside c; where it crosses a facet of c (a ridge of
 * the polytope) it goes on in the neighbour, unfolded by the gluing (CellFacet.toNeighbor:
 * y' = A y + s b, an isometry fixing the ridge). Wherever the segment avoids the hinges, the map
 * v -> (end cell, end u) is a local isometry whose derivative is the product M of the crossed
 * gluings' linear parts, so the gradient of an energy with respect to v is M^T times its gradient
 * with respect to u.
 *
 * The searches minimise over v (one displacement per piece, in its anchor's chart) and re-anchor
 * each piece at its end point between L-BFGS runs, so a piece leaves its cell across a ridge as
 * smoothly as it moves inside it. A segment that meets a hinge has no continuation (the boundary
 * is not flat there): move() reports it and the energy is Infinity, which the line search treats
 * as too long a step.
 *
 * Only the public Polytope data is used (facet planes and gluings), so this works for every
 * polytope of the catalogue.
 */
import type { Polytope } from "../types";

export class Charts {
  readonly cellCount: number;
  /** Per cell: per facet n (3) and h (at s = 1), the facet being { y : n . y <= s h }. */
  private readonly planes: Float64Array[];
  /** Per cell: per facet the gluing's A (9, row-major) and b (3, at s = 1). */
  private readonly glue: Float64Array[];
  private readonly neighbor: Int32Array[];

  constructor(readonly poly: Polytope) {
    this.cellCount = poly.cells.length;
    this.planes = poly.cells.map((c) => {
      const out = new Float64Array(4 * c.facets.length);
      c.facets.forEach((f, k) => {
        out[4 * k] = f.inside.n[0];
        out[4 * k + 1] = f.inside.n[1];
        out[4 * k + 2] = f.inside.n[2];
        out[4 * k + 3] = f.inside.h;
      });
      return out;
    });
    this.glue = poly.cells.map((c) => {
      const out = new Float64Array(12 * c.facets.length);
      c.facets.forEach((f, k) => {
        const A = f.toNeighbor.A;
        for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) out[12 * k + 3 * r + q] = A[r][q];
        for (let r = 0; r < 3; r++) out[12 * k + 9 + r] = f.toNeighbor.b[r];
      });
      return out;
    });
    this.neighbor = poly.cells.map((c) => Int32Array.from(c.facets.map((f) => f.neighbor)));
  }

  /**
   * Moves the centre (cell, U[uo..uo+2]) by v (in that cell's frame) at edge s. Writes the end
   * point into outU[ou..ou+2] (clamped into its closed cell) and the linear part M of the map
   * (start frame -> end frame, row-major) into outM[om..om+8]; returns the end cell, or -1 when the
   * segment meets a hinge.
   */
  move(cell: number, U: Float64Array, uo: number, v0: number, v1: number, v2: number, s: number, outU: Float64Array, ou: number, outM: Float64Array, om: number): number {
    let c = cell;
    let px = U[uo];
    let py = U[uo + 1];
    let pz = U[uo + 2];
    let m0 = 1, m1 = 0, m2 = 0, m3 = 0, m4 = 1, m5 = 0, m6 = 0, m7 = 0, m8 = 1;
    const len = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);
    if (len > 0) {
      let dx = v0 / len;
      let dy = v1 / len;
      let dz = v2 / len;
      let rem = len;
      const tolH = 1e-12 * Math.max(1, s);
      for (let step = 0; ; step++) {
        if (step > 64) return -1;
        const pl = this.planes[c];
        const F = pl.length >> 2;
        let best = Infinity;
        let k = -1;
        for (let f = 0; f < F; f++) {
          const nd = pl[4 * f] * dx + pl[4 * f + 1] * dy + pl[4 * f + 2] * dz;
          if (nd <= 1e-15) continue;
          const t = (s * pl[4 * f + 3] - (pl[4 * f] * px + pl[4 * f + 1] * py + pl[4 * f + 2] * pz)) / nd;
          if (t < best) {
            best = t;
            k = f;
          }
        }
        if (best >= rem || k < 0) {
          px += rem * dx;
          py += rem * dy;
          pz += rem * dz;
          break;
        }
        if (best < 0) best = 0;
        const qx = px + best * dx;
        const qy = py + best * dy;
        const qz = pz + best * dz;
        // the crossing point lies on another facet too: it is a point of a hinge
        for (let f = 0; f < F; f++) {
          if (f === k) continue;
          if (s * pl[4 * f + 3] - (pl[4 * f] * qx + pl[4 * f + 1] * qy + pl[4 * f + 2] * qz) < tolH) return -1;
        }
        const G = this.glue[c];
        const o = 12 * k;
        const a0 = G[o], a1 = G[o + 1], a2 = G[o + 2], a3 = G[o + 3], a4 = G[o + 4], a5 = G[o + 5], a6 = G[o + 6], a7 = G[o + 7], a8 = G[o + 8];
        px = a0 * qx + a1 * qy + a2 * qz + s * G[o + 9];
        py = a3 * qx + a4 * qy + a5 * qz + s * G[o + 10];
        pz = a6 * qx + a7 * qy + a8 * qz + s * G[o + 11];
        const ex = a0 * dx + a1 * dy + a2 * dz;
        const ey = a3 * dx + a4 * dy + a5 * dz;
        const ez = a6 * dx + a7 * dy + a8 * dz;
        dx = ex;
        dy = ey;
        dz = ez;
        const n0 = a0 * m0 + a1 * m3 + a2 * m6, n1 = a0 * m1 + a1 * m4 + a2 * m7, n2 = a0 * m2 + a1 * m5 + a2 * m8;
        const n3 = a3 * m0 + a4 * m3 + a5 * m6, n4 = a3 * m1 + a4 * m4 + a5 * m7, n5 = a3 * m2 + a4 * m5 + a5 * m8;
        const n6 = a6 * m0 + a7 * m3 + a8 * m6, n7 = a6 * m1 + a7 * m4 + a8 * m7, n8 = a6 * m2 + a7 * m5 + a8 * m8;
        m0 = n0; m1 = n1; m2 = n2; m3 = n3; m4 = n4; m5 = n5; m6 = n6; m7 = n7; m8 = n8;
        c = this.neighbor[c][k];
        rem -= best;
      }
    }
    // rounding may leave the point a hair outside its cell
    const pl = this.planes[c];
    for (let f = 0; f < pl.length >> 2; f++) {
      const ex = pl[4 * f] * px + pl[4 * f + 1] * py + pl[4 * f + 2] * pz - s * pl[4 * f + 3];
      if (ex > 0) {
        px -= ex * pl[4 * f];
        py -= ex * pl[4 * f + 1];
        pz -= ex * pl[4 * f + 2];
      }
    }
    outU[ou] = px;
    outU[ou + 1] = py;
    outU[ou + 2] = pz;
    outM[om] = m0; outM[om + 1] = m1; outM[om + 2] = m2;
    outM[om + 3] = m3; outM[om + 4] = m4; outM[om + 5] = m5;
    outM[om + 6] = m6; outM[om + 7] = m7; outM[om + 8] = m8;
    return c;
  }

  /** Largest violation of the cell's facet inequalities by the point (<= 0 inside the closed cell). */
  excess(cell: number, x: number, y: number, z: number, s: number): number {
    const pl = this.planes[cell];
    let worst = -Infinity;
    for (let f = 0; f < pl.length >> 2; f++) worst = Math.max(worst, pl[4 * f] * x + pl[4 * f + 1] * y + pl[4 * f + 2] * z - s * pl[4 * f + 3]);
    return worst;
  }
}

const CHARTS = new WeakMap<Polytope, Charts>();

/** The charts of a polytope, built once per polytope object. */
export function chartsOf(poly: Polytope): Charts {
  let c = CHARTS.get(poly);
  if (!c) {
    c = new Charts(poly);
    CHARTS.set(poly, c);
  }
  return c;
}

/**
 * A random point of a cell at edge s, `shrink` times the way from the cell's centre to its
 * boundary: uniform in the shrunk cube for the tesseract, a random convex combination of the
 * vertices otherwise.
 */
export function randomCellPoint(poly: Polytope, cell: number, s: number, rand: () => number, shrink: number): [number, number, number] {
  if (poly.name === "tesseract") {
    const h = (s / 2) * shrink;
    return [(2 * rand() - 1) * h, (2 * rand() - 1) * h, (2 * rand() - 1) * h];
  }
  const V = poly.cells[cell].vertices;
  const w = V.map(() => -Math.log(1 - rand()));
  const W = w.reduce((a, b) => a + b, 0);
  const p: [number, number, number] = [0, 0, 0];
  V.forEach((v, i) => {
    for (let k = 0; k < 3; k++) p[k] += (w[i] / W) * v[k] * s * shrink;
  });
  return p;
}
