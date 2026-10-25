/**
 * Unit cubes on the tesseract, the axis-aligned family (the research prototype's cubes_aligned.py,
 * with mixed crossing directions: any cell, any face crossed).
 *
 * Every gluing of the tesseract maps local axes to local axes (a signed permutation), so a cube
 * aligned with its anchor's axes stays aligned in every cell it reaches, and it is the box
 * u +- 1/2 in its anchor's local coordinates. With 1 <= s its interior avoids the hinges exactly
 * when it crosses the anchor's faces (u_k +- 1/2 contains +-s/2) in at most one axis: crossing in
 * two axes k, l puts a piece of the edge {x_k = +-s/2, x_l = +-s/2} inside it. A cube crossing
 * face k (depth d = |u_k| + 1/2 - s/2 > 0) has two parts, both boxes:
 *  - the box clipped to the anchor cell (i, sg): [u - 1/2, u + 1/2] with the crossed bound at
 *    +-s/2;
 *  - the slab beyond the face, in the neighbour (j, tau), j the 4D axis of local axis k and tau
 *    the sign of u_k: along the old normal axis i it runs from the shared 2-face (x_i = sg s/2)
 *    depth d into the neighbour; along the other two axes it keeps the anchor's bounds.
 * So validity is: at most one crossing per cube, and boxes of distinct cubes in a cell disjoint.
 *
 * Energy (as the prototype): for each cube the squared crossing depths except the largest (line
 * crossing), and for each pair of parts of distinct cubes in a cell the squared penetration depth
 * of the two boxes (the smallest overlap over the three axes). Every box bound is a * u + b in a
 * single coordinate, so the gradient is exact.
 *
 * Starts: the two rings (cube_rings.py): the cycles of cells (+-e1, +-e2) and (+-e3, +-e4) each
 * develop into a straight row of four cells with trivial holonomy, a flat solid torus of length
 * 4 s, so ceil(P / 2) cubes slide round one of them at s = ceil(P / 2) / 4 (and the rest round the
 * other); random layouts at s = 2; hops that move one to three cubes.
 */
import { quaternionToMatrix } from "../linalg";
import type { BoundaryConfig, BoundaryPiece, Polytope } from "../types";
import { clampedPieces, plainState } from "./balls";
import { type Charts, randomCellPoint } from "./chart";
import { type PieceModel, type State, copyState } from "./model";
import { randInt } from "./random";

/** Local axis k of tesseract cell (i, sg) is the 4D axis AX[i][k]. */
const AX = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].filter((j) => j !== i));

/** At most 4 parts per cube (an invalid cube crossing three faces has three slabs). */
const MAX_PARTS = 4;

export class AlignedCubeModel implements PieceModel {
  readonly target = 1e-20;
  readonly maxStep = 0.25;
  readonly floor: number;
  // parts: cell, cube, and per axis the bounds lo = loA U[loI] + loB, hi = hiA U[hiI] + hiB (I = -1: constant)
  private readonly pCell: Int32Array;
  private readonly pCube: Int32Array;
  private readonly loI: Int32Array;
  private readonly loA: Float64Array;
  private readonly loB: Float64Array;
  private readonly hiI: Int32Array;
  private readonly hiA: Float64Array;
  private readonly hiB: Float64Array;
  private readonly order: Int32Array;
  private readonly first = new Int32Array(9);

  constructor(
    readonly poly: Polytope,
    readonly P: number,
    readonly charts: Charts,
  ) {
    if (poly.name !== "tesseract") throw new Error("search: aligned cubes exist on the tesseract only");
    // no aligned unit cube fits in a cell of edge < 1; and the volume bound P <= 8 s^3
    this.floor = Math.max(1, Math.cbrt(P / 8));
    const n = MAX_PARTS * P;
    this.pCell = new Int32Array(n);
    this.pCube = new Int32Array(n);
    this.loI = new Int32Array(3 * n);
    this.loA = new Float64Array(3 * n);
    this.loB = new Float64Array(3 * n);
    this.hiI = new Int32Array(3 * n);
    this.hiA = new Float64Array(3 * n);
    this.hiB = new Float64Array(3 * n);
    this.order = new Int32Array(n);
  }

  /**
   * Builds the parts of every cube; returns their count and the line-crossing term (energy, or
   * with `violation` the largest second crossing depth), adding the term's gradient into g.
   */
  private build(st: State, s: number, g: Float64Array | null, violation: boolean): { n: number; line: number } {
    const h = s / 2;
    const U = st.U;
    let n = 0;
    let line = violation ? -Infinity : 0;
    const dep = [0, 0, 0];
    const lo4I = [0, 0, 0, 0];
    const lo4A = [0, 0, 0, 0];
    const lo4B = [0, 0, 0, 0];
    const hi4I = [0, 0, 0, 0];
    const hi4A = [0, 0, 0, 0];
    const hi4B = [0, 0, 0, 0];
    for (let q = 0; q < this.P; q++) {
      const c = st.cells[q];
      const i = c >> 1;
      const sg = c & 1 ? 1 : -1;
      const o = 3 * q;
      let ncross = 0;
      let kmax = -1;
      for (let k = 0; k < 3; k++) {
        dep[k] = Math.abs(U[o + k]) + 0.5 - h;
        if (dep[k] > 0) {
          ncross++;
          if (kmax < 0 || dep[k] > dep[kmax]) kmax = k;
        }
      }
      if (violation) {
        // the second largest depth: <= 0 exactly when at most one axis crosses
        const sorted = dep.slice().sort((a, b) => b - a);
        line = Math.max(line, sorted[1]);
      } else if (ncross >= 2)
        for (let k = 0; k < 3; k++)
          if (dep[k] > 0 && k !== kmax) {
            line += dep[k] * dep[k];
            if (g) g[o + k] += 2 * dep[k] * (U[o + k] >= 0 ? 1 : -1);
          }
      // the part in the anchor cell
      const a = n++;
      this.pCell[a] = c;
      this.pCube[a] = q;
      for (let k = 0; k < 3; k++) {
        const x = 3 * a + k;
        this.loI[x] = o + k;
        this.loA[x] = 1;
        this.loB[x] = -0.5;
        this.hiI[x] = o + k;
        this.hiA[x] = 1;
        this.hiB[x] = 0.5;
        if (dep[k] > 0) {
          if (U[o + k] > 0) {
            this.hiI[x] = -1;
            this.hiA[x] = 0;
            this.hiB[x] = h;
          } else {
            this.loI[x] = -1;
            this.loA[x] = 0;
            this.loB[x] = -h;
          }
        }
      }
      // a slab beyond each crossed face
      for (let k = 0; k < 3; k++) {
        if (!(dep[k] > 0)) continue;
        const tau = U[o + k] > 0 ? 1 : -1;
        const j = AX[i][k];
        const c2 = 2 * j + (tau > 0 ? 1 : 0);
        // along the old normal axis i: from the shared 2-face x_i = sg h, depth d = tau u_k + 1/2 - h
        if (sg > 0) {
          lo4I[i] = o + k;
          lo4A[i] = -tau;
          lo4B[i] = 2 * h - 0.5;
          hi4I[i] = -1;
          hi4A[i] = 0;
          hi4B[i] = h;
        } else {
          lo4I[i] = -1;
          lo4A[i] = 0;
          lo4B[i] = -h;
          hi4I[i] = o + k;
          hi4A[i] = tau;
          hi4B[i] = 0.5 - 2 * h;
        }
        for (let m = 0; m < 3; m++) {
          if (m === k) continue;
          const gm = AX[i][m];
          const x = 3 * a + m;
          lo4I[gm] = this.loI[x];
          lo4A[gm] = this.loA[x];
          lo4B[gm] = this.loB[x];
          hi4I[gm] = this.hiI[x];
          hi4A[gm] = this.hiA[x];
          hi4B[gm] = this.hiB[x];
        }
        const b = n++;
        this.pCell[b] = c2;
        this.pCube[b] = q;
        for (let p = 0; p < 3; p++) {
          const gp = AX[j][p];
          const x = 3 * b + p;
          this.loI[x] = lo4I[gp];
          this.loA[x] = lo4A[gp];
          this.loB[x] = lo4B[gp];
          this.hiI[x] = hi4I[gp];
          this.hiA[x] = hi4A[gp];
          this.hiB[x] = hi4B[gp];
        }
      }
    }
    return { n, line };
  }

  private bound(I: Int32Array, A: Float64Array, B: Float64Array, x: number, U: Float64Array): number {
    return I[x] < 0 ? B[x] : A[x] * U[I[x]] + B[x];
  }

  /** Penalty energy (violation = false) or largest violation of the state at edge s. */
  private evaluate(st: State, s: number, g: Float64Array | null, violation: boolean): number {
    const { n, line } = this.build(st, s, g, violation);
    const U = st.U;
    let E = line;
    // parts by cell (counting sort)
    const first = this.first;
    first.fill(0);
    for (let p = 0; p < n; p++) first[this.pCell[p] + 1]++;
    for (let c = 0; c < 8; c++) first[c + 1] += first[c];
    const fill = first.slice(0, 8);
    for (let p = 0; p < n; p++) this.order[fill[this.pCell[p]]++] = p;
    for (let c = 0; c < 8; c++)
      for (let x = first[c]; x < first[c + 1]; x++) {
        const a = this.order[x];
        for (let y = x + 1; y < first[c + 1]; y++) {
          const b = this.order[y];
          if (this.pCube[a] === this.pCube[b]) continue;
          let best = Infinity;
          let hiX = -1;
          let loX = -1;
          for (let m = 0; m < 3; m++) {
            const ha = this.bound(this.hiI, this.hiA, this.hiB, 3 * a + m, U);
            const hb = this.bound(this.hiI, this.hiA, this.hiB, 3 * b + m, U);
            const la = this.bound(this.loI, this.loA, this.loB, 3 * a + m, U);
            const lb = this.bound(this.loI, this.loA, this.loB, 3 * b + m, U);
            const ov = Math.min(ha, hb) - Math.max(la, lb);
            if (ov < best) {
              best = ov;
              hiX = ha < hb ? 3 * a + m : 3 * b + m;
              loX = la > lb ? 3 * a + m : 3 * b + m;
            }
            if (!violation && ov <= 0) break;
          }
          if (violation) {
            E = Math.max(E, best);
            continue;
          }
          if (!(best > 0)) continue;
          E += best * best;
          if (!g) continue;
          if (this.hiI[hiX] >= 0) g[this.hiI[hiX]] += 2 * best * this.hiA[hiX];
          if (this.loI[loX] >= 0) g[this.loI[loX]] -= 2 * best * this.loA[loX];
        }
      }
    return E;
  }

  energy(st: State, s: number, g: Float64Array): number {
    g.fill(0);
    return this.evaluate(st, s, g, false);
  }

  violation(st: State, s: number): number {
    return this.evaluate(st, s, null, true);
  }

  startEdge(): number {
    // 8 k^3 aligned cubes fit at s = k (k^3 per cell); s = 2 holds 64
    return Math.max(2, Math.ceil(Math.cbrt(this.P / 8)));
  }

  randomState(s: number, rand: () => number): State {
    const cells = new Int32Array(this.P);
    const U = new Float64Array(3 * this.P);
    // centres within 1/2 of the cell's centre (the prototype's start at s = 2)
    const shrink = Math.min(1, 1 / s);
    for (let q = 0; q < this.P; q++) {
      cells[q] = randInt(rand, 8);
      U.set(randomCellPoint(this.poly, cells[q], s, rand, shrink), 3 * q);
    }
    return { cells, U };
  }

  hop(st: State, s: number, rand: () => number): State {
    const out = copyState(st);
    const k = 1 + randInt(rand, 3);
    for (let t = 0; t < k; t++) {
      const q = randInt(rand, this.P);
      out.cells[q] = randInt(rand, 8);
      out.U.set(randomCellPoint(this.poly, out.cells[q], s, rand, 1), 3 * q);
    }
    return out;
  }

  /** The two rings at s = max(1, ceil(P / 2) / 4) (1 + 1e-6), with a random phase. */
  constructedStart(rand: () => number): { st: State; s: number } {
    const nA = Math.ceil(this.P / 2);
    const s = Math.max(1, nA / 4) * (1 + 1e-6);
    return { st: twoRings(this.charts, s, nA, this.P - nA, rand()), s };
  }

  stateOf(config: BoundaryConfig): State | null {
    const st = plainState(this.poly, config, this.P);
    if (!st) return null;
    // a rotation is fine when it maps the cube's axes to axes (a symmetry of the cube)
    for (const p of config.pieces) {
      if (!p.q) continue;
      const m = quaternionToMatrix(p.q);
      if (m.some((x) => Math.min(Math.abs(x), Math.abs(Math.abs(x) - 1)) > 1e-9)) return null;
    }
    return st;
  }

  pieces(st: State, s: number): BoundaryPiece[] {
    return clampedPieces(this.poly, st, s);
  }
}

/**
 * The two-rings layout at edge s: nA cubes round the ring of cells 0..3 (from the centre of cell 1
 * along its local axis 0, the 4D axis 1) and nB round the ring of cells 4..7 (from the centre of
 * cell 5 along its local axis 2, the 4D axis 3), evenly spaced along the ring's length 4 s from
 * `phase`. The rays run through the centres of the cells' faces, far from the hinges.
 */
export function twoRings(charts: Charts, s: number, nA: number, nB: number, phase: number): State {
  const P = nA + nB;
  const cells = new Int32Array(P);
  const U = new Float64Array(3 * P);
  const M = new Float64Array(9);
  const zero = new Float64Array(3);
  const L = 4 * s;
  let q = 0;
  for (const [c0, k, n] of [
    [1, 0, nA],
    [5, 2, nB],
  ] as const)
    for (let j = 0; j < n; j++) {
      const d = (phase + (j * L) / n) % L;
      const v = [0, 0, 0];
      v[k] = d;
      const c = charts.move(c0, zero, 0, v[0], v[1], v[2], s, U, 3 * q, M, 0);
      if (c < 0) throw new Error("search: a ring ray met a hinge");
      cells[q++] = c;
    }
  return { cells, U };
}
