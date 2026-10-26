/**
 * Seeded local search for whole-sphere packings sphere/N/P, in TypeScript (the research search is
 * python/sphere/search.py; this one serves the volunteer client and has no dependencies).
 *
 * Work is done on the unit sphere with the piece's angular size a = 1/rho as the size variable
 * (geometry.ts). Three parts:
 *
 *  - Penalty relaxation. Variables: one rotation vector w_i per piece (the pose is
 *    q_i = exp(w_i) q_i0, a rotation about a world axis applied to the base pose, so moving the
 *    centre and spinning the piece are both covered) and the size a. Minimise -a + mu E for
 *    mu = 1e2 ... 1e8 with L-BFGS, where E sums the squared overlap of near pairs:
 *      polygons: the separating-edge value of the pair (the largest, over the edge great circles of
 *        both pieces, of the smallest sine distance of the other piece's vertices beyond the edge;
 *        a positive value separates the cones over the pieces, see docs/spaces/SPHERE.md section 3),
 *      disks: 2 sin(a) - |c_i - c_j| (the chord between the centres must reach 2 sin a).
 *    The gradient is a central difference of each piece's local energy, plus one of the total
 *    energy for a.
 *  - Tight size. For fixed quaternions a larger rho shrinks every piece inside itself (SPHERE.md
 *    section 3), so validity is monotone in rho and the smallest valid rho is found by bisection
 *    with the float validator (validate.ts), to 1e-13 relative, keeping every gap >= 0. Every score
 *    this search returns comes from that bisection, so the returned configuration is valid by the
 *    validator at its stated rho.
 *  - Basin hopping from the current packing: jiggle every piece, re-place one to three pieces at
 *    random, or spin a quarter of the polygons about their centres; then relax and take the tight
 *    size. A better packing is kept; a worse one becomes the current packing with probability
 *    exp(-(rho'/rho - 1)/T), T = 1e-3, and the current packing returns to the best after ten hops
 *    without a gain.
 *
 * Budget: `maxEvals` counts objective and gradient evaluations (each one costs about one sweep
 * over the near pairs), `maxSeconds` is a wall-clock ceiling and `shouldStop` an external stop
 * (polled at every evaluation). All randomness comes from mulberry32(seed), so a run that ends
 * on `maxEvals` is reproducible from (problem, start, seed, maxEvals).
 */
import {
  type Quat,
  type SphereConfig,
  type SphereProblem,
  areaBound,
  circumradiusAngle,
  pieceExists,
  quatMul,
  standardVertices,
} from "./geometry";
import { validate } from "./validate";

export interface SphereSearchOptions {
  /** Integer seed of the run's random choices. */
  seed: number;
  /** Packing to start from (any rho; an invalid one is first enlarged until it is valid). */
  start?: SphereConfig;
  /** Most objective and gradient evaluations; default 20,000. */
  maxEvals?: number;
  /** Wall-clock ceiling in seconds (makes the result depend on the machine); default none. */
  maxSeconds?: number;
  /** Polled at every evaluation: true ends the run with the best so far. */
  shouldStop?: () => boolean;
  /** Seconds, for maxSeconds; default performance.now() / 1000. */
  now?: () => number;
  log?: (message: string) => void;
}

export interface SphereSearchResult {
  /** The best packing found, valid by `validate` with every gap >= 0, or null when none was found. */
  config: SphereConfig | null;
  /** Its rho (Infinity when there is none). */
  score: number;
  /** rho of the start after the tight-size bisection, or null without a start. */
  startScore: number | null;
  evaluations: number;
  hops: number;
  stopped: "evals" | "time" | "aborted";
}

/** mulberry32: uniform draws in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** exp(w) as a unit quaternion: the rotation by |w| about w. */
export function expQuat(wx: number, wy: number, wz: number): Quat {
  const t = Math.hypot(wx, wy, wz);
  if (t < 1e-300) return [1, 0, 0, 0];
  const s = Math.sin(t / 2) / t;
  return [Math.cos(t / 2), wx * s, wy * s, wz * s];
}

export function normalized(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Uniformly random rotation (Shoemake). */
export function randomQuat(r: () => number): Quat {
  const u1 = r();
  const u2 = 2 * Math.PI * r();
  const u3 = 2 * Math.PI * r();
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

/** Rotation matrix of a unit quaternion, row-major into m[0..8]. */
function matrixInto(q: Quat, m: Float64Array): void {
  const [w, x, y, z] = q;
  const n = w * w + x * x + y * y + z * z;
  m[0] = (w * w + x * x - y * y - z * z) / n;
  m[1] = (2 * (x * y - w * z)) / n;
  m[2] = (2 * (x * z + w * y)) / n;
  m[3] = (2 * (x * y + w * z)) / n;
  m[4] = (w * w - x * x + y * y - z * z) / n;
  m[5] = (2 * (y * z - w * x)) / n;
  m[6] = (2 * (x * z - w * y)) / n;
  m[7] = (2 * (y * z + w * x)) / n;
  m[8] = (w * w - x * x - y * y + z * z) / n;
}

/** Stop reasons, thrown out of the inner loops and caught by searchSphere. */
class Stop extends Error {
  constructor(readonly why: "evals" | "time" | "aborted") {
    super(why);
  }
}

/**
 * Minimal L-BFGS with a backtracking (Armijo) line search. `f` returns the value and writes the
 * gradient into `g`; `tick` is called once per evaluation and may throw Stop.
 */
function lbfgs(
  f: (x: Float64Array, g: Float64Array) => number,
  x0: Float64Array,
  maxIter: number,
  tick: () => void,
): Float64Array {
  const n = x0.length;
  const m = 8;
  let x = Float64Array.from(x0);
  let g = new Float64Array(n);
  tick();
  let fx = f(x, g);
  const S: Float64Array[] = [];
  const Y: Float64Array[] = [];
  const rhos: number[] = [];
  const d = new Float64Array(n);
  const alpha = new Array<number>(m);
  for (let it = 0; it < maxIter; it++) {
    let gg = 0;
    for (let k = 0; k < n; k++) gg += g[k] * g[k];
    if (!(gg > 1e-30)) break;
    // two-loop recursion
    for (let k = 0; k < n; k++) d[k] = -g[k];
    for (let j = S.length - 1; j >= 0; j--) {
      let a = 0;
      for (let k = 0; k < n; k++) a += S[j][k] * d[k];
      a *= rhos[j];
      alpha[j] = a;
      for (let k = 0; k < n; k++) d[k] -= a * Y[j][k];
    }
    if (S.length) {
      const j = S.length - 1;
      let sy = 0;
      let yy = 0;
      for (let k = 0; k < n; k++) {
        sy += S[j][k] * Y[j][k];
        yy += Y[j][k] * Y[j][k];
      }
      const gamma = sy / yy;
      for (let k = 0; k < n; k++) d[k] *= gamma;
    } else {
      // first step: at most 1e-3 radians along the gradient
      const scale = 1e-3 / Math.sqrt(gg);
      for (let k = 0; k < n; k++) d[k] *= scale;
    }
    for (let j = 0; j < S.length; j++) {
      let b = 0;
      for (let k = 0; k < n; k++) b += Y[j][k] * d[k];
      b *= rhos[j];
      for (let k = 0; k < n; k++) d[k] += S[j][k] * (alpha[j] - b);
    }
    let slope = 0;
    for (let k = 0; k < n; k++) slope += g[k] * d[k];
    if (!(slope < 0)) {
      // not a descent direction: restart from steepest descent
      S.length = 0;
      Y.length = 0;
      rhos.length = 0;
      continue;
    }
    let t = 1;
    let xn = new Float64Array(n);
    let gn = new Float64Array(n);
    let fn = Infinity;
    for (let ls = 0; ls < 30; ls++) {
      for (let k = 0; k < n; k++) xn[k] = x[k] + t * d[k];
      tick();
      fn = f(xn, gn);
      if (fn <= fx + 1e-4 * t * slope) break;
      t *= 0.3;
    }
    if (!(fn < fx)) break;
    const s = new Float64Array(n);
    const y = new Float64Array(n);
    let sy = 0;
    for (let k = 0; k < n; k++) {
      s[k] = xn[k] - x[k];
      y[k] = gn[k] - g[k];
      sy += s[k] * y[k];
    }
    if (sy > 1e-30) {
      S.push(s);
      Y.push(y);
      rhos.push(1 / sy);
      if (S.length > m) {
        S.shift();
        Y.shift();
        rhos.shift();
      }
    }
    const rel = (fx - fn) / Math.max(1e-300, Math.abs(fx));
    [x, xn] = [xn, x];
    [g, gn] = [gn, g];
    fx = fn;
    if (rel < 1e-15) break;
  }
  return x;
}

/** Largest admissible angular size: the piece must exist (and two disks must fit). */
export function maxAngle(N: number, P: number): number {
  if (N === 0) return P >= 2 ? Math.PI / 2 : Math.PI;
  return ((2 * Math.PI) / N) * (1 - 1e-9);
}

/**
 * The tight size of fixed poses: the smallest rho at which they are valid by the float validator
 * at tolerance 0 (every gap >= 0), by bisection to 1e-13 relative from rho0 (validity is monotone
 * in rho, see the header); null when no valid rho is found within a factor of about 14 above rho0.
 * `tick` is called before each validator call and may throw (the searches' budgets).
 */
export function tightRho(problem: SphereProblem, q: Quat[], rho0: number, tick: () => void = () => {}): number | null {
  const { N, P } = problem;
  const aMax = maxAngle(N, P);
  /** Valid with every gap >= 0 at rho. */
  const validAt = (rho: number): boolean => {
    tick();
    if (!(1 / rho < aMax) || !pieceExists(N, rho)) return false;
    const v = validate(problem, { rho, pieces: q.map((x) => ({ q: x })) }, { tol: 0 });
    return v.errors.length === 0 && v.minGap >= 0;
  };
  return tightSize(validAt, rho0, 1 / aMax);
}

/**
 * The bisection of tightRho for any test of validity that is monotone in rho: from rho0 (raised
 * to just above `floor`, the smallest admissible rho), up by steps of 1e-3, 2e-3, ... until valid
 * or down by such steps until invalid, then bisection to 1e-13 relative; the smallest valid rho
 * found, or null when none is found within a factor of about 14 above rho0.
 */
export function tightSize(validAt: (rho: number) => boolean, rho0: number, floor: number): number | null {
  const bisect = (lo: number, hi: number): number => {
    while (hi - lo > 1e-13 * hi) {
      const mid = 0.5 * (lo + hi);
      if (validAt(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  let hi = Math.max(rho0, floor * (1 + 1e-12));
  let step = 1e-3;
  if (!validAt(hi)) {
    let lo = hi;
    for (;;) {
      if (step > 4) return null;
      hi = lo * (1 + step);
      if (validAt(hi)) break;
      lo = hi;
      step *= 2;
    }
    return bisect(lo, hi);
  }
  let lo = hi;
  for (;;) {
    const next = Math.max(floor * (1 + 1e-12), hi * (1 - step));
    if (next >= hi) return hi;
    if (!validAt(next)) {
      lo = next;
      break;
    }
    hi = next;
    step = Math.min(0.5, step * 2);
  }
  return bisect(lo, hi);
}

/**
 * The near-pair energy model at fixed base poses. Pieces carry their placed vertices and the unit
 * normals of their edge planes (pointing into the piece), or only their centre for disks.
 */
class Model {
  readonly P: number;
  readonly N: number;
  /** base quaternions, unit */
  base: Quat[];
  /** neighbour lists over the near pairs (both directions) */
  private nbrs: number[][] = [];
  private pairs: [number, number][] = [];
  /** per piece: centre (3), vertices (3N), edge normals (3N) */
  private C: Float64Array[];
  private V: Float64Array[];
  private E: Float64Array[];
  private stdV: Float64Array;
  private a = NaN;
  private readonly mat = new Float64Array(9);
  private readonly tmpC = new Float64Array(3);
  private readonly tmpV: Float64Array;
  private readonly tmpE: Float64Array;

  constructor(N: number, base: Quat[]) {
    this.N = N;
    this.P = base.length;
    this.base = base.map(normalized);
    const k = Math.max(1, N);
    this.C = base.map(() => new Float64Array(3));
    this.V = base.map(() => new Float64Array(3 * k));
    this.E = base.map(() => new Float64Array(3 * k));
    this.stdV = new Float64Array(3 * k);
    this.tmpV = new Float64Array(3 * k);
    this.tmpE = new Float64Array(3 * k);
  }

  /** Sets the standard piece for angular size a. */
  setSize(a: number): void {
    if (a === this.a) return;
    this.a = a;
    if (this.N === 0) return;
    const R = circumradiusAngle(this.N, 1 / a);
    const sv = standardVertices(this.N, R);
    for (let k = 0; k < this.N; k++) {
      this.stdV[3 * k] = sv[k][0];
      this.stdV[3 * k + 1] = sv[k][1];
      this.stdV[3 * k + 2] = sv[k][2];
    }
  }

  /** Places piece i with pose q into (c, v, e). */
  private place(q: Quat, c: Float64Array, v: Float64Array, e: Float64Array): void {
    const m = this.mat;
    matrixInto(q, m);
    c[0] = m[2];
    c[1] = m[5];
    c[2] = m[8];
    const N = this.N;
    if (N === 0) return;
    const s = this.stdV;
    for (let k = 0; k < N; k++) {
      const x = s[3 * k];
      const y = s[3 * k + 1];
      const z = s[3 * k + 2];
      v[3 * k] = m[0] * x + m[1] * y + m[2] * z;
      v[3 * k + 1] = m[3] * x + m[4] * y + m[5] * z;
      v[3 * k + 2] = m[6] * x + m[7] * y + m[8] * z;
    }
    for (let k = 0; k < N; k++) {
      const j = (k + 1) % N;
      // a_k x a_{k+1} points into the piece for counter-clockwise vertices (seen from outside)
      const ax = v[3 * k];
      const ay = v[3 * k + 1];
      const az = v[3 * k + 2];
      const bx = v[3 * j];
      const by = v[3 * j + 1];
      const bz = v[3 * j + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      e[3 * k] = nx;
      e[3 * k + 1] = ny;
      e[3 * k + 2] = nz;
    }
  }

  /** Pose of piece i for rotation vector w (3 numbers at x[o..o+2]). */
  pose(i: number, wx: number, wy: number, wz: number): Quat {
    return quatMul(expQuat(wx, wy, wz), this.base[i]);
  }

  placeAll(x: Float64Array): void {
    for (let i = 0; i < this.P; i++)
      this.place(this.pose(i, x[3 * i], x[3 * i + 1], x[3 * i + 2]), this.C[i], this.V[i], this.E[i]);
  }

  /** Near pairs at angular size aMax: centre angle below 2R + slack. */
  refreshPairs(aMax: number): void {
    const R = this.N === 0 ? aMax : circumradiusAngle(this.N, 1 / aMax);
    const reach = Math.min(Math.PI, 2 * R + 0.5 * R + 0.05);
    const cosReach = Math.cos(reach);
    this.pairs = [];
    this.nbrs = Array.from({ length: this.P }, () => []);
    for (let i = 0; i < this.P; i++)
      for (let j = i + 1; j < this.P; j++) {
        const ci = this.C[i];
        const cj = this.C[j];
        if (ci[0] * cj[0] + ci[1] * cj[1] + ci[2] * cj[2] > cosReach) {
          this.pairs.push([i, j]);
          this.nbrs[i].push(j);
          this.nbrs[j].push(i);
        }
      }
  }

  /** Overlap of two placed pieces (positive when they overlap). */
  private overlap(
    ca: Float64Array,
    va: Float64Array,
    ea: Float64Array,
    cb: Float64Array,
    vb: Float64Array,
    eb: Float64Array,
  ): number {
    if (this.N === 0) {
      const chord = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
      return 2 * Math.sin(this.a) - chord;
    }
    const N = this.N;
    let sat = -Infinity;
    for (let pass = 0; pass < 2; pass++) {
      const e = pass === 0 ? ea : eb;
      const w = pass === 0 ? vb : va;
      for (let k = 0; k < N; k++) {
        const nx = e[3 * k];
        const ny = e[3 * k + 1];
        const nz = e[3 * k + 2];
        let lo = Infinity;
        for (let l = 0; l < N; l++) {
          // sine distance of the vertex beyond the edge great circle (positive outside)
          const d = -(nx * w[3 * l] + ny * w[3 * l + 1] + nz * w[3 * l + 2]);
          if (d < lo) lo = d;
        }
        if (lo > sat) sat = lo;
      }
    }
    return -sat;
  }

  total(): number {
    let E = 0;
    for (const [i, j] of this.pairs) {
      const o = this.overlap(this.C[i], this.V[i], this.E[i], this.C[j], this.V[j], this.E[j]);
      if (o > 0) E += o * o;
    }
    return E;
  }

  /** Energy of piece i's pairs with piece i at pose q (the others as placed). */
  local(i: number, q: Quat): number {
    this.place(q, this.tmpC, this.tmpV, this.tmpE);
    let E = 0;
    for (const j of this.nbrs[i]) {
      const o = this.overlap(this.tmpC, this.tmpV, this.tmpE, this.C[j], this.V[j], this.E[j]);
      if (o > 0) E += o * o;
    }
    return E;
  }
}

/** Search state: the poses and the tight rho of a valid packing. */
interface Packing {
  q: Quat[];
  rho: number;
}

export function searchSphere(problem: SphereProblem, o: SphereSearchOptions): SphereSearchResult {
  const { N, P } = problem;
  if (![0, 3, 4, 5, 6, 8].includes(N) || !Number.isInteger(P) || P < 1) throw new Error("bad sphere problem");
  const rand = mulberry32(o.seed);
  const maxEvals = o.maxEvals ?? 20_000;
  const clock = o.now ?? (() => performance.now() / 1000);
  const t0 = clock();
  const log = o.log ?? (() => {});
  const aMax = maxAngle(N, P);
  let evaluations = 0;
  const tick = () => {
    evaluations++;
    if (evaluations > maxEvals) throw new Stop("evals");
    if (o.shouldStop?.()) throw new Stop("aborted");
    if (o.maxSeconds !== undefined && clock() - t0 > o.maxSeconds) throw new Stop("time");
  };

  const tight = (q: Quat[], rho0: number): number | null => tightRho(problem, q, rho0, tick);

  /** Penalty continuation from poses q at angular size a0; returns the relaxed poses and size. */
  const relax = (q: Quat[], a0: number, mus: number[]): { q: Quat[]; a: number } => {
    const model = new Model(N, q);
    const x = new Float64Array(3 * P + 1);
    x[3 * P] = Math.min(a0, aMax * (1 - 1e-6));
    let cur = { q: model.base.map((b) => [...b] as Quat), a: x[3 * P] };
    const h = 1e-7;
    for (const mu of mus) {
      for (let round = 0; round < 3; round++) {
        // a new base at the current poses keeps the rotation vectors small
        model.base = cur.q.map(normalized);
        x.fill(0);
        x[3 * P] = cur.a;
        model.setSize(cur.a);
        model.placeAll(x);
        model.refreshPairs(Math.min(aMax, cur.a * 1.05));
        const f = (z: Float64Array, g: Float64Array): number => {
          const a = z[3 * P];
          if (!(a > 0 && a < aMax)) {
            g.fill(0);
            return Infinity;
          }
          model.setSize(a);
          model.placeAll(z);
          const E = model.total();
          for (let i = 0; i < P; i++) {
            for (let c = 0; c < 3; c++) {
              const w = [z[3 * i], z[3 * i + 1], z[3 * i + 2]];
              w[c] += h;
              const ep = model.local(i, model.pose(i, w[0], w[1], w[2]));
              w[c] -= 2 * h;
              const em = model.local(i, model.pose(i, w[0], w[1], w[2]));
              g[3 * i + c] = (mu * (ep - em)) / (2 * h);
            }
          }
          const ha = 1e-9 * a;
          let Ep = Infinity;
          let Em = Infinity;
          if (a + ha < aMax) {
            model.setSize(a + ha);
            model.placeAll(z);
            Ep = model.total();
          }
          model.setSize(a - ha);
          model.placeAll(z);
          Em = model.total();
          model.setSize(a);
          model.placeAll(z);
          g[3 * P] = -1 + (Number.isFinite(Ep) ? (mu * (Ep - Em)) / (2 * ha) : (mu * (E - Em)) / ha);
          return -a + mu * E;
        };
        const z = lbfgs(f, x, 150, tick);
        cur = {
          q: Array.from({ length: P }, (_, i) => normalized(model.pose(i, z[3 * i], z[3 * i + 1], z[3 * i + 2]))),
          a: Math.min(z[3 * P], aMax * (1 - 1e-9)),
        };
      }
    }
    return cur;
  };

  /** Relax, then the tight size; null when no valid size was found near the relaxed one. */
  const local = (q: Quat[], a0: number, mus: number[]): Packing | null => {
    const r = relax(q, a0, mus);
    const rho = tight(r.q, 1 / r.a);
    return rho === null ? null : { q: r.q, rho };
  };

  const randomStart = (): Packing | null => {
    const q = Array.from({ length: P }, () => randomQuat(rand));
    return local(q, 0.7 / areaBound(N, P), [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8]);
  };

  const perturb = (pk: Packing): Quat[] => {
    const q = pk.q.map((x) => [...x] as Quat);
    const a = 1 / pk.rho;
    const kind = rand();
    if (kind < 0.4) {
      const sigma = (0.05 + 0.15 * rand()) * a;
      for (let i = 0; i < P; i++)
        q[i] = normalized(quatMul(expQuat(sigma * gauss(rand), sigma * gauss(rand), sigma * gauss(rand)), q[i]));
    } else if (kind < 0.75 || N === 0) {
      const k = 1 + Math.floor(rand() * Math.min(3, Math.max(1, Math.floor(P / 4))));
      for (let t = 0; t < k; t++) q[Math.floor(rand() * P)] = randomQuat(rand);
    } else {
      const k = Math.max(1, Math.floor(P / 4));
      for (let t = 0; t < k; t++) {
        const i = Math.floor(rand() * P);
        // a rotation about the piece's own centre spins it in place
        const m = new Float64Array(9);
        matrixInto(q[i], m);
        const phi = (rand() - 0.5) * ((2 * Math.PI) / N);
        q[i] = normalized(quatMul(expQuat(phi * m[2], phi * m[5], phi * m[8]), q[i]));
      }
    }
    return q;
  };

  let best: Packing | null = null;
  let startScore: number | null = null;
  let hops = 0;
  let stopped: SphereSearchResult["stopped"] = "evals";
  try {
    if (o.start && Array.isArray(o.start.pieces) && o.start.pieces.length === P && o.start.rho > 0) {
      const q = o.start.pieces.map((p) => normalized(p.q));
      const rho = tight(q, o.start.rho);
      if (rho !== null) {
        best = { q, rho };
        startScore = rho;
        log(`start: rho ${rho}`);
      }
      const r = local(best?.q ?? q, best ? 1 / best.rho : 1 / o.start.rho, [1e4, 1e5, 1e6, 1e7, 1e8]);
      if (r && (!best || r.rho < best.rho)) best = r;
    }
    while (!best) best = randomStart();
    let cur: Packing = best;
    let misses = 0;
    for (;;) {
      hops++;
      const q = perturb(cur);
      const r = local(q, (1 / cur.rho) * 0.99, [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8]);
      if (!r) continue;
      if (r.rho < best.rho * (1 - 1e-13)) {
        best = r;
        log(`hop ${hops}: rho ${r.rho}`);
      }
      if (r.rho < cur.rho * (1 - 1e-13) || rand() < Math.exp(-(r.rho / cur.rho - 1) / 1e-3)) {
        cur = r;
        misses = 0;
      } else if (++misses >= 10) {
        cur = best;
        misses = 0;
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    stopped = e.why;
  }
  const b = best as Packing | null;
  return {
    config: b ? { rho: b.rho, pieces: b.q.map((q) => ({ q })) } : null,
    score: b ? b.rho : Infinity,
    startScore,
    evaluations: Math.min(evaluations, maxEvals),
    hops,
    stopped,
  };
}
