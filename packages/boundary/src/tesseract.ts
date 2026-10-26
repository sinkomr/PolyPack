/**
 * Tesseract fast path: exact "lattice word" developments (the research prototype's tess.py), an
 * independent method used to cross-check the generic chains.
 *
 * On the tesseract every ridge is a right angle in R^4, so a chain develops into cubes of the
 * lattice s Z^3 (cells centred at lattice points) and every lattice edge is the image of a
 * tesseract edge. A geodesic from u in cell c0 is a straight segment of the development avoiding
 * the lattice lines; it is determined by the sequence of lattice faces it crosses (a word). Each
 * word has, independently of u, an end cell and an affine map development -> R^4. The distance from
 * u to a point y of cell c is the least |y_w - u| over the words w ending in c whose image y_w of y
 * is reached by the segment u -> y_w crossing exactly w's faces in w's order. Words are monotone per
 * lattice axis with |m_k| <= mmax; mmax = 2 covers lengths < 2 for s >= sqrt 2.
 *
 * Crossing rule (tess.py): in cell (i, sg) (the cell x_i = sg s/2, id 2 i + (sg > 0)), the lattice
 * direction tau e_k maps to a signed 4D axis tj e_j; crossing that face leads to cell (j, tj), and
 * the rotation sends sg e_i -> tj e_j and tj e_j -> -sg e_i, fixing the 2-face.
 */

interface Word {
  steps: { k: number; level: number }[];
  m: [number, number, number];
  cell: number;
  /** development (local of the start cell, unit h) -> R^4: x = A y + h b, A is 4 x 3 */
  A: number[][];
  b: number[];
}

const axesOf = (i: number) => [0, 1, 2, 3].filter((j) => j !== i);

function frame(c: number): { A: number[][]; b: number[] } {
  const i = c >> 1;
  const sg = c & 1 ? 1 : -1;
  const A = [0, 1, 2, 3].map(() => [0, 0, 0]);
  axesOf(i).forEach((j, k) => (A[j][k] = 1));
  const b = [0, 0, 0, 0];
  b[i] = sg;
  return { A, b };
}

function buildWords(c0: number, mmax: number): Word[] {
  const out: Word[] = [];
  const f = frame(c0);
  const stack: Word[] = [{ steps: [], m: [0, 0, 0], cell: c0, A: f.A, b: f.b }];
  while (stack.length) {
    const w = stack.pop()!;
    out.push(w);
    for (let k = 0; k < 3; k++)
      for (const tau of [-1, 1]) {
        if (w.m[k] !== 0 && Math.sign(w.m[k]) !== tau) continue;
        if (Math.abs(w.m[k] + tau) > mmax) continue;
        const i = w.cell >> 1;
        const sg = w.cell & 1 ? 1 : -1;
        const col = [0, 1, 2, 3].map((r) => w.A[r][k] * tau);
        let j = 0;
        for (let r = 1; r < 4; r++) if (Math.abs(col[r]) > Math.abs(col[j])) j = r;
        const tj = Math.sign(col[j]);
        // R: sg e_i -> tj e_j, tj e_j -> -sg e_i; q = sg e_i + tj e_j (unit h)
        const R = (x: number[]) => {
          const y = x.slice();
          y[i] = -sg * tj * x[j];
          y[j] = sg * tj * x[i];
          return y;
        };
        const A2 = [0, 1, 2, 3].map(() => [0, 0, 0]);
        for (let c = 0; c < 3; c++) {
          const col2 = R([0, 1, 2, 3].map((r) => w.A[r][c]));
          for (let r = 0; r < 4; r++) A2[r][c] = col2[r];
        }
        const q = [0, 0, 0, 0];
        q[i] = sg;
        q[j] = tj;
        const b2 = R(w.b.map((x, r) => x - q[r])).map((x, r) => x + q[r]);
        const m2: [number, number, number] = [w.m[0], w.m[1], w.m[2]];
        const level = 2 * w.m[k] + tau;
        m2[k] += tau;
        stack.push({ steps: [...w.steps, { k, level }], m: m2, cell: 2 * j + (tj > 0 ? 1 : 0), A: A2, b: b2 });
      }
  }
  return out;
}

/** The words of every start cell, grouped by (start, end) cell. */
export class TesseractWords {
  readonly by = new Map<string, Word[]>();
  readonly count: number;
  constructor(mmax = 2) {
    let n = 0;
    for (let c0 = 0; c0 < 8; c0++)
      for (const w of buildWords(c0, mmax)) {
        const key = `${c0},${w.cell}`;
        const list = this.by.get(key) ?? [];
        list.push(w);
        this.by.set(key, list);
        n++;
      }
    this.count = n;
  }

  /**
   * Lengths of all realised straight geodesics from (c1, u1) to (c2, u2) at edge s (local
   * coordinates at s). With excludeEmpty, the empty word is skipped (for loops). A step whose
   * lattice plane holds both ends (within 1e-12 max(1, s/2)) puts no constraint on the crossing
   * order, as in the search's word tables (search/balls.ts).
   *
   * Caution: with that rule a word can also report a segment that runs inside one lattice plane
   * and crosses another, i.e. passes through (or within 1e-12 of) a lattice line, a hinge. Such a
   * length is not a geodesic distance but a path through a hinge, of length >= d(x, hinge) +
   * d(hinge, y): for unit balls whose clearances are >= 1 it is >= 2, so ball checks are not
   * affected; callers using these lengths for anything else should not take them as distances.
   */
  distances(c1: number, u1: number[], c2: number, u2: number[], s: number, excludeEmpty = false, tol = 1e-12): number[] {
    return this.images(c1, u1, c2, u2, s, excludeEmpty, tol).map((y) => Math.hypot(y[0] - u1[0], y[1] - u1[1], y[2] - u1[2]));
  }

  /**
   * The images y of (c2, u2) in the development from (c1, u1) at edge s (local coordinates of c1)
   * under the realised words, as distances() takes them: each geodesic is the segment u1 -> y.
   * The same caution applies: a segment within 1e-12 of a hinge may be reported.
   */
  images(c1: number, u1: number[], c2: number, u2: number[], s: number, excludeEmpty = false, tol = 1e-12): number[][] {
    const h = s / 2;
    const ws = this.by.get(`${c1},${c2}`) ?? [];
    const x2 = embed(c2, u2, h);
    const out: number[][] = [];
    const eps = 1e-12 * Math.max(1, h);
    for (const w of ws) {
      if (excludeEmpty && w.steps.length === 0) continue;
      // y = A^T (x2 - h b)
      const y = [0, 1, 2].map((c) => [0, 1, 2, 3].reduce((acc, r) => acc + w.A[r][c] * (x2[r] - h * w.b[r]), 0));
      if (![0, 1, 2].every((k) => Math.abs(y[k] - 2 * h * w.m[k]) <= h * (1 + 1e-12) + tol)) continue;
      let ok = true;
      let prev = -Infinity;
      for (const st of w.steps) {
        const plane = h * st.level;
        // a plane holding the whole segment (both ends on it: two points of one ridge, seen from
        // either cell) is crossed at any time, so it does not constrain the order; its crossing
        // time would be 0 / 0 (tess.py drops such words)
        if (Math.abs(u1[st.k] - plane) <= eps && Math.abs(y[st.k] - plane) <= eps) continue;
        const den = y[st.k] - u1[st.k];
        const t = (plane - u1[st.k]) / den;
        if (!(t >= -tol && t <= 1 + tol) || !(t > prev)) {
          ok = false;
          break;
        }
        prev = t;
      }
      if (!ok) continue;
      out.push(y);
    }
    return out;
  }

  distance(c1: number, u1: number[], c2: number, u2: number[], s: number): number {
    return Math.min(Infinity, ...this.distances(c1, u1, c2, u2, s));
  }

  loop(c1: number, u1: number[], s: number): number {
    return Math.min(Infinity, ...this.distances(c1, u1, c1, u1, s, true));
  }
}

/** R^4 point of local coordinates u of tesseract cell c at half-edge h. */
export function embed(c: number, u: number[], h: number): number[] {
  const i = c >> 1;
  const p = [0, 0, 0, 0];
  p[i] = (c & 1 ? 1 : -1) * h;
  axesOf(i).forEach((j, k) => (p[j] = u[k]));
  return p;
}

/**
 * Geodesic distance from local point u (in [-s/2, s/2]^3) to the hinges, in closed form: the
 * nearest lattice line of the development is an edge of the anchor cube.
 */
export function tesseractClearance(u: number[], s: number): number {
  const h = s / 2;
  const a = u.map((x) => h - Math.abs(x));
  return Math.min(Math.hypot(a[1], a[2]), Math.hypot(a[0], a[2]), Math.hypot(a[0], a[1]));
}
