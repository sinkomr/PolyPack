/**
 * Folding a net of the boundary up into R^4, and seeing it from a 4D eye.
 *
 * The net lies flat in the hyperplane w = 0 of the "folding frame" R^4 = (net coordinates, w). Each
 * tree edge of the net joins a cell to its parent across a ridge (a 2-face). Folding by a fraction
 * f in [0, 1] turns the cell, with its whole subtree, about that ridge in the 2-plane spanned by the
 * direction into the cell (inside the net) and w, by f times the angle between the two cells'
 * outward normals (pi - the 4D dihedral angle; 90 degrees on the tesseract). The turns compose
 * down the tree, so a grandchild turns about its ridge as already carried by its parent. All turns
 * go towards +w, the side where the polytope ends up: at f = 1 every cell lands on its cell of the
 * polytope, up to one isometry (foldAlignment) that takes the root to its place.
 *
 * The 4D eye sits at distance E from the root's hyperplane on the side w < 0, on the line through
 * the polytope's centre. A point (z, w) is seen at n0 + (z - n0) E / (E + w): the flat net (w = 0)
 * at its own size, and at f = 1 the root becomes the outer cell of the classic projection, the
 * opposite cell the small inner one. Composed with a cell's affine map, this is a projective map of
 * R^3, written as a 4x4 matrix H acting on (u, 1), with the point at (H u)_xyz / (H u)_w.
 *
 * Matrices are row-major. Folder.update writes into preallocated arrays: no allocation per step.
 */
import type { Affine, NetPlacement, Polytope } from "@polypack/boundary";
import { applyAffine, dot, invert4, matVec, transpose } from "./math";

/** Ratio of the inner (opposite) cell's size to the outer (root) cell's size at full fold. */
export const INNER_RATIO = 0.46;

/** 5x5 homogeneous maps of R^4, row-major in a Float64Array(25). */
function mul5(a: Float64Array, b: Float64Array, out: Float64Array) {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      let t = 0;
      for (let k = 0; k < 5; k++) t += a[i * 5 + k] * b[k * 5 + j];
      out[i * 5 + j] = t;
    }
  }
}

function identity5(out: Float64Array) {
  out.fill(0);
  for (let i = 0; i < 5; i++) out[i * 6] = 1;
}

interface Edge {
  cell: number;
  parent: number;
  /** Unit vector of the net (w = 0) pointing from the ridge into the cell. */
  p: [number, number, number];
  /** A point of the ridge, in the net. */
  z0: [number, number, number];
  /** The full fold angle: the angle between the two cells' outward normals. */
  angle: number;
}

export class Folder {
  readonly s: number;
  readonly root: number;
  /** Cells in tree order, the root first, every parent before its children. */
  readonly order: number[];
  /** Per cell: cell-local -> folding frame at the current fold (5x5). */
  readonly T: Float64Array[];
  /** Per cell: the projective map cell-local -> 3D view, 4x4 on (u, 1). */
  readonly H: Float64Array[];
  /** Per cell: the transpose of H's inverse, which maps tangent planes (n, -n.u) to the view. */
  readonly Hit: Float64Array[];
  /** The polytope's centre in the net, and its distance from the root's hyperplane. */
  readonly n0: [number, number, number];
  readonly w0: number;
  /** The eye's distance from the root's hyperplane. */
  readonly E: number;
  private readonly edges: Edge[];
  private readonly netMaps: Float64Array[];
  private readonly fold: Float64Array[];
  private readonly g = new Float64Array(25);
  private readonly inv = new Float64Array(16);

  constructor(poly: Polytope, net: NetPlacement[], s: number, innerRatio = INNER_RATIO) {
    this.s = s;
    const n = poly.cells.length;
    const byCell = new Map(net.map((p) => [p.cell, p]));
    const rootP = net.find((p) => p.parent === null);
    if (!rootP) throw new Error("The net has no root.");
    this.root = rootP.cell;
    // tree order (breadth first)
    const children = new Map<number, number[]>();
    for (const p of net) if (p.parent) children.set(p.parent.cell, [...(children.get(p.parent.cell) ?? []), p.cell]);
    this.order = [this.root];
    for (let i = 0; i < this.order.length; i++) this.order.push(...(children.get(this.order[i]) ?? []));
    this.edges = [];
    for (const c of this.order) {
      const p = byCell.get(c)!;
      if (!p.parent) continue;
      const facet = poly.cells[c].facets[p.parent.facet];
      const nl = Math.hypot(...facet.inside.n);
      const nLocal = facet.inside.n.map((x) => x / nl);
      const hLocal = (facet.inside.h / nl) * s;
      // the ridge in the net: m.z = h + m.(s b), m = A n (out of the cell, towards the parent)
      const m = matVec(p.place.A, nLocal);
      const yOnRidge = nLocal.map((x) => x * hLocal); // a point of the ridge, cell-local
      const z0 = applyAffine(p.place, yOnRidge, s) as [number, number, number];
      const cosA = Math.max(-1, Math.min(1, dot(poly.cells[c].normal, poly.cells[p.parent.cell].normal)));
      this.edges.push({ cell: c, parent: p.parent.cell, p: [-m[0], -m[1], -m[2]], z0, angle: Math.acos(cosA) });
    }
    // cell-local -> flat net in the folding frame: (A u + s b, 0)
    this.netMaps = [];
    for (let c = 0; c < n; c++) {
      const M = new Float64Array(25);
      const p = byCell.get(c);
      if (p) {
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) M[i * 5 + j] = p.place.A[i][j];
          M[i * 5 + 4] = s * p.place.b[i];
        }
      }
      M[3 * 5 + 3] = 1;
      M[24] = 1;
      this.netMaps.push(M);
    }
    this.fold = Array.from({ length: n }, () => new Float64Array(25));
    this.T = Array.from({ length: n }, () => new Float64Array(25));
    this.H = Array.from({ length: n }, () => new Float64Array(16));
    this.Hit = Array.from({ length: n }, () => new Float64Array(16));
    // the polytope's centre in the folding frame: the inverse of the alignment at the origin
    const Q = foldAlignment(poly, net, s);
    const QAt = transpose(Q.A);
    const c0 = matVec(QAt, Q.b.map((v) => -v));
    this.n0 = [c0[0], c0[1], c0[2]];
    this.w0 = Math.max(c0[3], 1e-9);
    // inner/outer = E / (E + 2 w0)
    this.E = (innerRatio * 2 * this.w0) / (1 - innerRatio);
    this.update(0);
  }

  /** Folds to fraction f in [0, 1] and refreshes T, H and Hit for every cell. */
  update(f: number) {
    const g = this.g;
    identity5(this.fold[this.root]);
    for (let ei = 0; ei < this.edges.length; ei++) {
      const e = this.edges[ei];
      const th = f * e.angle;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      // R = I + (cos - 1)(p p^T + w w^T) + sin (w p^T - p w^T), about the ridge point z0
      identity5(g);
      const p = e.p;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) g[i * 5 + j] += (cs - 1) * p[i] * p[j];
      g[3 * 5 + 3] += cs - 1;
      for (let j = 0; j < 3; j++) {
        g[3 * 5 + j] += sn * p[j];
        g[j * 5 + 3] -= sn * p[j];
      }
      // translation z0 - R z0 (z0 has w = 0)
      for (let i = 0; i < 4; i++) {
        let rz = 0;
        for (let j = 0; j < 3; j++) rz += g[i * 5 + j] * e.z0[j];
        g[i * 5 + 4] = (i < 3 ? e.z0[i] : 0) - rz;
      }
      mul5(this.fold[e.parent], g, this.fold[e.cell]);
    }
    const E = this.E;
    const [a, b, c] = this.n0;
    for (let oi = 0; oi < this.order.length; oi++) {
      const cell = this.order[oi];
      const T = this.T[cell];
      mul5(this.fold[cell], this.netMaps[cell], T);
      // view: X = z + n0 w / E, W = 1 + w / E; drop the input w column (cells have u_w = 0)
      const H = this.H[cell];
      for (let j = 0; j < 4; j++) {
        const k = j === 3 ? 4 : j;
        const zw = T[15 + k];
        H[j] = T[k] + (a * zw) / E;
        H[4 + j] = T[5 + k] + (b * zw) / E;
        H[8 + j] = T[10 + k] + (c * zw) / E;
        H[12 + j] = zw / E + (k === 4 ? 1 : 0);
      }
      if (!invert4(H, this.inv)) continue;
      const Hit = this.Hit[cell];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) Hit[i * 4 + j] = this.inv[j * 4 + i];
    }
  }

  /** The 4D point (folding frame) of cell-local u at the current fold. */
  point4(cell: number, u: readonly number[]): number[] {
    const T = this.T[cell];
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) out[i] = T[i * 5] * u[0] + T[i * 5 + 1] * u[1] + T[i * 5 + 2] * u[2] + T[i * 5 + 4];
    return out;
  }

  /** The view (3D) point of cell-local u at the current fold. */
  project(cell: number, u: readonly number[], out: number[] = [0, 0, 0]): number[] {
    const H = this.H[cell];
    const W = H[12] * u[0] + H[13] * u[1] + H[14] * u[2] + H[15];
    out[0] = (H[0] * u[0] + H[1] * u[1] + H[2] * u[2] + H[3]) / W;
    out[1] = (H[4] * u[0] + H[5] * u[1] + H[6] * u[2] + H[7]) / W;
    out[2] = (H[8] * u[0] + H[9] * u[1] + H[10] * u[2] + H[11]) / W;
    return out;
  }
}

/**
 * The isometry of R^4 that takes the folding frame (net coordinates, w) to the polytope: the root's
 * net placement undone, its hyperplane to the root cell's, and +w to the polytope's inside.
 * With it, a fully folded cell lands on toAmbient of the same cell.
 */
export function foldAlignment(poly: Polytope, net: NetPlacement[], s: number): Affine {
  const rootP = net.find((p) => p.parent === null);
  if (!rootP) throw new Error("The net has no root.");
  const cell = poly.cells[rootP.cell];
  const d = poly.d;
  // x = s o + F A^T (z - s b) - w N, F = frame as columns (d x 3)
  const At = transpose(rootP.place.A);
  const A: number[][] = [];
  for (let i = 0; i < d; i++) {
    const row: number[] = [];
    for (let j = 0; j < 3; j++) {
      let t = 0;
      for (let k = 0; k < 3; k++) t += cell.frame[k][i] * At[k][j];
      row.push(t);
    }
    row.push(-cell.normal[i]);
    A.push(row);
  }
  const sb = [...rootP.place.b.map((v) => v * s), 0];
  const b = cell.origin.map((o, i) => s * o - dot(A[i], sb));
  return { A, b };
}
