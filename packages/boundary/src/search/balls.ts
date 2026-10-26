/**
 * Unit balls: the penalty energy and the exact violation of a state, by the distance form of the
 * validator (validate.ts): every centre at geodesic distance >= 1 from the hinges (clearance),
 * every two centres >= 2 apart along every geodesic, and every geodesic loop at a centre >= 2.
 *
 * Energy: the sum of the squared violations, (1 - clearance)^2 per near hinge, (2 - d)^2 for every
 * realised straight geodesic of length d < 2 between two centres, and (2 - d)^2 for every such loop.
 * Every short geodesic counts on its own (not only the shortest), since each is an overlap. The
 * gradient is analytic: a geodesic is a straight segment from u_i to the image y = M u_j + t of
 * u_j in u_i's development, so d(d)/du_i = (u_i - y) / d and d(d)/du_j = M^T (y - u_i) / d.
 *
 * Two metrics give the geodesics:
 *  - WordMetric (the tesseract): the lattice words of tesseract.ts (TesseractWords), flattened. A
 *    word's map is a signed permutation, y = M u_j + h t, and the word is realised when the
 *    segment u_i -> y crosses the word's lattice planes in its order (as TesseractWords.distances).
 *    Words with |m_k| <= 2 cover every geodesic shorter than 2 for s >= sqrt 2 (where every ball
 *    packing lives); for s >= 2 those with |m_k| <= 1 do (two planes of one axis are s apart), and
 *    below s = 2 at most one axis needs |m_k| = 2 (two such axes need a length >= sqrt 2 s >= 2).
 *    The clearance has the closed form of tesseractClearance, one term per edge direction. Pairs
 *    whose centres are >= 2 apart in R^4 are skipped: a geodesic is never shorter than the chord.
 *  - ChainMetric (any polytope): the chains of chains.ts from each centre (reach 2), the hinges
 *    clipped to each chain's window for the clearance. Slower (chains are enumerated at every
 *    evaluation); it serves the polytopes after the tesseract, and cross-checks the words.
 */
import { ChainLimitError, clampToCell, clipSegmentToWindow, enumerateChains, inWindow } from "../chains";
import { V3, isoApply, pointSegmentDistance3 } from "../linalg";
import { boundaryVolume, cellExcess, topo } from "../polytope";
import { TesseractWords } from "../tesseract";
import type { BoundaryConfig, BoundaryPiece, Polytope } from "../types";
import { randomCellPoint } from "./chart";
import { type PieceModel, type State, type TermOptions, copyState } from "./model";
import { randInt } from "./random";

export interface BallMetric {
  /**
   * The penalty energy at edge s (adding its gradient with respect to U into g when g is given), or
   * with `violation` the largest violation max(1 - clearance, 2 - distance, 2 - loop) over every
   * realised geodesic (-Infinity when nothing is near).
   */
  evaluate(cells: Int32Array, U: Float64Array, s: number, g: Float64Array | null, violation: boolean): number;
}

// ---------------------------------------------------------------- tesseract: lattice words

/** The fields of a TesseractWords word that the tables read. */
interface WordData {
  steps: { k: number; level: number }[];
  m: readonly number[];
  A: number[][];
  b: number[];
}

/** Words of one length class, flattened: y_r = sign_r u2[perm_r] + h t_r; steps (k, level), at most 6. */
interface WordTable {
  /** First word and count per (c1, c2), at 8 c1 + c2. */
  start: Int32Array;
  count: Int32Array;
  perm: Uint8Array;
  sign: Float64Array;
  t: Float64Array;
  nst: Uint8Array;
  stK: Uint8Array;
  stL: Float64Array;
}

const MAX_STEPS = 6;
const axesOf = (i: number) => [0, 1, 2, 3].filter((j) => j !== i);

function buildTable(words: TesseractWords, keep: (m: readonly number[]) => boolean): WordTable {
  const lists: WordData[][] = [];
  for (let c1 = 0; c1 < 8; c1++)
    for (let c2 = 0; c2 < 8; c2++) lists.push(((words.by.get(`${c1},${c2}`) ?? []) as unknown as WordData[]).filter((w) => keep(w.m)));
  const n = lists.reduce((a, l) => a + l.length, 0);
  const T: WordTable = {
    start: new Int32Array(64),
    count: new Int32Array(64),
    perm: new Uint8Array(3 * n),
    sign: new Float64Array(3 * n),
    t: new Float64Array(3 * n),
    nst: new Uint8Array(n),
    stK: new Uint8Array(MAX_STEPS * n),
    stL: new Float64Array(MAX_STEPS * n),
  };
  let w = 0;
  lists.forEach((list, key) => {
    const c2 = key & 7;
    const i2 = c2 >> 1;
    const ax2 = axesOf(i2);
    const off2 = [0, 0, 0, 0];
    off2[i2] = c2 & 1 ? 1 : -1;
    T.start[key] = w;
    T.count[key] = list.length;
    for (const word of list) {
      // y = A^T (x2 - h b), x2 = E2 u2 + h off2: M = A^T E2 (M[r][k] = A[ax2[k]][r]), t = A^T (off2 - b)
      for (let r = 0; r < 3; r++) {
        let found = -1;
        for (let k = 0; k < 3; k++) {
          const v = word.A[ax2[k]][r];
          if (v !== 0) {
            if (found >= 0 || Math.abs(Math.abs(v) - 1) > 1e-12) throw new Error("search: a lattice word's map is not a signed permutation");
            found = k;
            T.perm[3 * w + r] = k;
            T.sign[3 * w + r] = Math.sign(v);
          }
        }
        if (found < 0) throw new Error("search: a lattice word's map is singular");
        let t = 0;
        for (let j = 0; j < 4; j++) t += word.A[j][r] * (off2[j] - word.b[j]);
        T.t[3 * w + r] = t;
      }
      if (word.steps.length > MAX_STEPS) throw new Error("search: a lattice word is too long");
      T.nst[w] = word.steps.length;
      word.steps.forEach((st, q) => {
        T.stK[MAX_STEPS * w + q] = st.k;
        T.stL[MAX_STEPS * w + q] = st.level;
      });
      w++;
    }
  });
  return T;
}

export class WordMetric implements BallMetric {
  /** |m_k| <= 2, at most one axis at 2: s < 2. */
  private readonly wide: WordTable;
  /** |m_k| <= 1: s >= 2. */
  private readonly narrow: WordTable;
  private x4 = new Float64Array(0);
  private readonly y = new Float64Array(3);
  private readonly u = new Float64Array(3);

  constructor(words = new TesseractWords(2)) {
    const abs = (m: readonly number[]) => m.map(Math.abs);
    this.wide = buildTable(words, (m) => Math.max(...abs(m)) <= 2 && abs(m).filter((x) => x === 2).length <= 1);
    this.narrow = buildTable(words, (m) => Math.max(...abs(m)) <= 1);
  }

  /**
   * Is the word realised from u (this.u) to y (this.y): are its planes crossed in its order, within
   * [0, 1]? A step whose plane holds the whole segment (both ends on it: two points of one
   * ridge, seen from either cell) is crossed at any time, so it does not constrain the order;
   * its crossing time would be 0 / 0.
   */
  private realised(T: WordTable, w: number, h: number): boolean {
    const u = this.u;
    const y = this.y;
    const eps = 1e-12 * Math.max(1, h);
    let prev = -Infinity;
    const ns = T.nst[w];
    for (let q = 0; q < ns; q++) {
      const k = T.stK[MAX_STEPS * w + q];
      const plane = h * T.stL[MAX_STEPS * w + q];
      if (Math.abs(u[k] - plane) <= eps && Math.abs(y[k] - plane) <= eps) continue;
      const tt = (plane - u[k]) / (y[k] - u[k]);
      if (!(tt >= -1e-12 && tt <= 1 + 1e-12 && tt > prev)) return false;
      prev = tt;
    }
    return true;
  }

  /**
   * As BallMetric.evaluate; `opts` (the kernel's options, model.ts) weights the terms, keeps only
   * one piece's, and gives dE/ds at fixed U. Without `opts` the arithmetic is the search's own (a
   * weight of 1 multiplies exactly). dE/ds: s enters through h = s / 2 in the clearance
   * (A = h - |u_k|, so d cl / ds = (A_a + A_b) / (2 cl)) and in a word's translation
   * (y = M u_j + h t, so d d / ds = r . t / (2 d)); whether a word is realised changes only at
   * isolated s.
   */
  evaluate(cells: Int32Array, U: Float64Array, s: number, g: Float64Array | null, violation: boolean, opts?: TermOptions): number {
    const P = cells.length;
    const h = s / 2;
    const T = h >= 1 ? this.narrow : this.wide;
    const W = opts?.w ?? null;
    const focus = opts?.focus ?? -1;
    const ds = opts?.ds ?? null;
    let dEds = 0;
    let E = 0;
    let worst = -Infinity;
    // clearance, closed form: the nearest edge of each of the three directions
    for (let i = 0; i < P; i++) {
      if (focus >= 0 && i !== focus) continue;
      const wi = W ? W[i] : 1;
      const o = 3 * i;
      const A0 = h - Math.abs(U[o]);
      const A1 = h - Math.abs(U[o + 1]);
      const A2 = h - Math.abs(U[o + 2]);
      for (let e = 0; e < 3; e++) {
        const a = e === 0 ? 1 : 0;
        const b = e === 2 ? 1 : 2;
        const Aa = a === 0 ? A0 : A1;
        const Ab = b === 1 ? A1 : A2;
        const cl = Math.sqrt(Aa * Aa + Ab * Ab);
        if (violation) {
          if (1 - cl > worst) worst = 1 - cl;
        } else if (cl < 1) {
          E += wi * (1 - cl) * (1 - cl);
          if ((g || ds) && cl > 0) {
            const c = (2 * wi * (1 - cl)) / cl;
            if (g) {
              g[o + a] += c * Aa * (U[o + a] >= 0 ? 1 : -1);
              g[o + b] += c * Ab * (U[o + b] >= 0 ? 1 : -1);
            }
            if (ds) dEds -= 0.5 * c * (Aa + Ab);
          }
        }
      }
    }
    // centres in R^4, for the chord test
    if (this.x4.length < 4 * P) this.x4 = new Float64Array(4 * P);
    const X = this.x4;
    for (let i = 0; i < P; i++) {
      const c = cells[i];
      const ax = c >> 1;
      let k = 0;
      for (let j = 0; j < 4; j++) X[4 * i + j] = j === ax ? (c & 1 ? h : -h) : U[3 * i + k++];
    }
    const y = this.y;
    const u = this.u;
    for (let i = 0; i < P; i++) {
      u[0] = U[3 * i];
      u[1] = U[3 * i + 1];
      u[2] = U[3 * i + 2];
      for (let j = i; j < P; j++) {
        if (focus >= 0 && i !== focus && j !== focus) continue;
        const self = j === i;
        if (!self) {
          const d0 = X[4 * i] - X[4 * j];
          const d1 = X[4 * i + 1] - X[4 * j + 1];
          const d2 = X[4 * i + 2] - X[4 * j + 2];
          const d3 = X[4 * i + 3] - X[4 * j + 3];
          if (d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3 >= 4) continue;
        }
        const key = 8 * cells[i] + cells[j];
        const w0 = T.start[key];
        const w1 = w0 + T.count[key];
        const o = 3 * j;
        for (let w = w0; w < w1; w++) {
          if (self && T.nst[w] === 0) continue;
          y[0] = T.sign[3 * w] * U[o + T.perm[3 * w]] + h * T.t[3 * w];
          y[1] = T.sign[3 * w + 1] * U[o + T.perm[3 * w + 1]] + h * T.t[3 * w + 1];
          y[2] = T.sign[3 * w + 2] * U[o + T.perm[3 * w + 2]] + h * T.t[3 * w + 2];
          const r0 = y[0] - u[0];
          const r1 = y[1] - u[1];
          const r2 = y[2] - u[2];
          const dd = r0 * r0 + r1 * r1 + r2 * r2;
          // a realised geodesic shorter than 2 (or, for the violation, any realised one)
          if (!violation && dd >= 4) continue;
          if (self && dd <= 1e-24) continue;
          if (!this.realised(T, w, h)) continue;
          const d = Math.sqrt(dd);
          if (violation) {
            if (2 - d > worst) worst = 2 - d;
            continue;
          }
          // a pair weighs (w_i + w_j) / 2, a loop w_i
          const wij = W ? 0.5 * (W[i] + W[j]) : 1;
          E += wij * (2 - d) * (2 - d);
          if (!g && !ds) continue;
          const c = (2 * wij * (2 - d)) / Math.max(d, 1e-15);
          if (ds) dEds -= 0.5 * c * (r0 * T.t[3 * w] + r1 * T.t[3 * w + 1] + r2 * T.t[3 * w + 2]);
          if (!g) continue;
          // dE/du_i = c r; dE/du_j = -c M^T r (for a loop both, on the same piece)
          g[3 * i] += c * r0;
          g[3 * i + 1] += c * r1;
          g[3 * i + 2] += c * r2;
          g[o + T.perm[3 * w]] -= c * T.sign[3 * w] * r0;
          g[o + T.perm[3 * w + 1]] -= c * T.sign[3 * w + 1] * r1;
          g[o + T.perm[3 * w + 2]] -= c * T.sign[3 * w + 2] * r2;
        }
      }
    }
    if (ds) ds[0] = dEds;
    return violation ? worst : E;
  }
}

let WORDS: WordMetric | null = null;

/** The word metric, built once per thread (about 16,000 words). */
export function wordMetric(): WordMetric {
  WORDS ??= new WordMetric();
  return WORDS;
}

// ---------------------------------------------------------------- any polytope: chains

export class ChainMetric implements BallMetric {
  constructor(readonly poly: Polytope) {}

  evaluate(cells: Int32Array, U: Float64Array, s: number, g: Float64Array | null, violation: boolean): number {
    const poly = this.poly;
    const T = topo(poly);
    const P = cells.length;
    const byCell: number[][] = poly.cells.map(() => []);
    for (let i = 0; i < P; i++) byCell[cells[i]].push(i);
    const nE = poly.edges.length;
    const edgeD = new Float64Array(nE);
    const edgeP = new Float64Array(3 * nE);
    let E = 0;
    let worst = -Infinity;
    for (let i = 0; i < P; i++) {
      const u = clampToCell(poly, cells[i], [U[3 * i], U[3 * i + 1], U[3 * i + 2]], s);
      let nodes;
      try {
        nodes = enumerateChains(poly, s, cells[i], u, 2, { maxChains: 4096 });
      } catch (e) {
        if (e instanceof ChainLimitError) return Infinity;
        throw e;
      }
      // Clearance: one term per polytope edge, its least distance over the chains. (An edge of
      // the anchor also lies on the boundary of its neighbours' windows, where rounding decides
      // whether a chain sees it; the least distance does not depend on that.)
      edgeD.fill(Infinity);
      nodes.forEach((node, ni) => {
        const V = T.cells[node.cell].verts.map((p) => isoApply(node.toAnchor, [p[0] * s, p[1] * s, p[2] * s]));
        poly.cells[node.cell].hinges.forEach(([a, b], hi) => {
          const iv = clipSegmentToWindow(node.window, u, V[a], V[b]);
          if (!iv) return;
          const e: V3 = [V[b][0] - V[a][0], V[b][1] - V[a][1], V[b][2] - V[a][2]];
          const L2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
          let t = L2 > 0 ? ((u[0] - V[a][0]) * e[0] + (u[1] - V[a][1]) * e[1] + (u[2] - V[a][2]) * e[2]) / L2 : 0;
          t = Math.min(iv[1], Math.max(iv[0], t));
          const p: V3 = [V[a][0] + t * e[0], V[a][1] + t * e[1], V[a][2] + t * e[2]];
          const d = Math.hypot(u[0] - p[0], u[1] - p[1], u[2] - p[2]);
          const ge = T.hingeEdge[node.cell][hi];
          if (d < edgeD[ge]) {
            edgeD[ge] = d;
            edgeP.set(p, 3 * ge);
          }
        });
        // centres of the other balls (j > i) and of this one (loops) in the chain's window
        for (const j of byCell[node.cell]) {
          if (j < i || (j === i && ni === 0)) continue;
          const y = isoApply(node.toAnchor, j === i ? u : [U[3 * j], U[3 * j + 1], U[3 * j + 2]]);
          if (!inWindow(node, u, y)) continue;
          const r: V3 = [y[0] - u[0], y[1] - u[1], y[2] - u[2]];
          const d = Math.hypot(r[0], r[1], r[2]);
          if (j === i && d <= 1e-12) continue;
          if (violation) {
            worst = Math.max(worst, 2 - d);
            continue;
          }
          if (d >= 2) continue;
          E += (2 - d) * (2 - d);
          if (!g) continue;
          const c = (2 * (2 - d)) / Math.max(d, 1e-15);
          const m = node.toAnchor.m;
          for (let k = 0; k < 3; k++) {
            g[3 * i + k] += c * r[k];
            // M^T r, M the chain's linear part (cell of j -> anchor of i)
            g[3 * j + k] -= c * (m[k] * r[0] + m[3 + k] * r[1] + m[6 + k] * r[2]);
          }
        }
      });
      for (let e = 0; e < nE; e++) {
        const d = edgeD[e];
        if (!(d < Infinity)) continue;
        if (violation) {
          worst = Math.max(worst, 1 - d);
          continue;
        }
        if (d >= 1) continue;
        E += (1 - d) * (1 - d);
        // the nearest point held fixed: d(d)/du = (u - p) / d
        if (g && d > 0) for (let k = 0; k < 3; k++) g[3 * i + k] -= ((2 * (1 - d)) / d) * (u[k] - edgeP[3 * e + k]);
      }
    }
    return violation ? worst : E;
  }
}

// ---------------------------------------------------------------- the model

/**
 * Proven lower bounds on s for P balls: one ball needs its centre at distance >= 1 from every
 * hinge, and every point of a regular cell lies within (midradius) s of one of its edges, so
 * s >= 1 / midradius (sqrt 2 for the tesseract); and P ball volumes fit in the boundary's volume.
 * (The midradius is taken as the distance from each cell's centre to its nearest edge, which is
 * right for regular cells, all the catalogue has.)
 */
export function ballFloor(poly: Polytope, P: number): number {
  const T = topo(poly);
  let rho = 0;
  poly.cells.forEach((c, ci) => {
    let near = Infinity;
    for (const [a, b] of c.hinges) near = Math.min(near, pointSegmentDistance3([0, 0, 0], T.cells[ci].verts[a], T.cells[ci].verts[b]));
    rho = Math.max(rho, near);
  });
  const volume = Math.cbrt((P * 4 * Math.PI) / 3 / boundaryVolume(poly));
  return Math.max(1 / rho, volume);
}

export class BallModel implements PieceModel {
  readonly target = 1e-22;
  readonly maxStep = 0.5;
  readonly floor: number;

  constructor(
    readonly poly: Polytope,
    readonly P: number,
    readonly metric: BallMetric = poly.name === "tesseract" ? wordMetric() : new ChainMetric(poly),
  ) {
    this.floor = ballFloor(poly, P);
  }

  energy(st: State, s: number, g: Float64Array): number {
    g.fill(0);
    return this.metric.evaluate(st.cells, st.U, s, g, false);
  }

  violation(st: State, s: number): number {
    return this.metric.evaluate(st.cells, st.U, s, null, true);
  }

  /** The kernel's terms (model.ts); the lattice words only (the chain metric has no dE/ds). */
  terms(st: State, s: number, g: Float64Array | null, violation: boolean, o: TermOptions): number {
    if (!(this.metric instanceof WordMetric)) throw new Error("search: the kernel's terms need the lattice-word metric (the tesseract)");
    if (g) g.fill(0);
    if (o.ds) o.ds[0] = 0;
    return this.metric.evaluate(st.cells, st.U, s, g, violation, o);
  }

  startEdge(): number {
    return 1.35 * this.floor;
  }

  randomState(s: number, rand: () => number): State {
    const C = this.poly.cells.length;
    const cells = new Int32Array(this.P);
    const U = new Float64Array(3 * this.P);
    for (let i = 0; i < this.P; i++) {
      cells[i] = randInt(rand, C);
      U.set(randomCellPoint(this.poly, cells[i], s, rand, 0.6), 3 * i);
    }
    return { cells, U };
  }

  hop(st: State, s: number, rand: () => number): State {
    const out = copyState(st);
    const k = 1 + randInt(rand, 3);
    for (let t = 0; t < k; t++) {
      const i = randInt(rand, this.P);
      out.cells[i] = randInt(rand, this.poly.cells.length);
      out.U.set(randomCellPoint(this.poly, out.cells[i], s, rand, 0.6), 3 * i);
    }
    return out;
  }

  constructedStart(): null {
    return null;
  }

  stateOf(config: BoundaryConfig): State | null {
    return plainState(this.poly, config, this.P);
  }

  pieces(st: State, s: number): BoundaryPiece[] {
    return clampedPieces(this.poly, st, s);
  }
}

/**
 * Cells and centres of a configuration with P pieces in range, or null. Centres are clamped into
 * their closed cells (the charts move centres from inside their cells).
 */
export function plainState(poly: Polytope, config: BoundaryConfig, P: number): State | null {
  if (!config || !Array.isArray(config.pieces) || config.pieces.length !== P) return null;
  if (!(typeof config.s === "number" && Number.isFinite(config.s) && config.s > 0)) return null;
  const cells = new Int32Array(P);
  const U = new Float64Array(3 * P);
  for (let i = 0; i < P; i++) {
    const p = config.pieces[i];
    if (!p || !Number.isInteger(p.cell) || p.cell < 0 || p.cell >= poly.cells.length || !Array.isArray(p.u) || p.u.length !== 3 || !p.u.every(Number.isFinite)) return null;
    cells[i] = p.cell;
    U.set(clampToCell(poly, p.cell, p.u, config.s), 3 * i);
  }
  return { cells, U };
}

/** The pieces of a state, each centre clamped into its closed anchor cell exactly (the validator checks it at tol 0). */
export function clampedPieces(poly: Polytope, st: State, s: number): BoundaryPiece[] {
  const out: BoundaryPiece[] = [];
  for (let i = 0; i < st.cells.length; i++) {
    const c = st.cells[i];
    let u = [st.U[3 * i], st.U[3 * i + 1], st.U[3 * i + 2]];
    if (poly.name === "tesseract") {
      // the cell is [-s/2, s/2]^3 and the validator compares u_k with s * 0.5: clamping is exact
      const h = s * 0.5;
      u = u.map((x) => Math.min(h, Math.max(-h, x)));
    } else {
      u = clampToCell(poly, c, u, s);
      // the cell is convex around its centre (the origin): pull in until no facet is exceeded
      for (let k = 0; k < 60 && cellExcess(poly, c, u, s) > 0; k++) u = u.map((x) => x * (1 - 2 ** -50 * 2 ** k));
    }
    out.push({ cell: c, u });
  }
  return out;
}
