/**
 * A kernel with globals, charts and a dear finish, for the tests and benchmarks of mc_compress and
 * asc: P unit disks on a flat torus whose cell is free. It is not a space; it copies the design of
 * the torus space's kernel (packages/torus/src/kernel.ts) in a small exact form.
 *
 * State. aux holds a base packing: a basis B (b1, b2) whose score is sb, and base centres u_i. The
 * plane is reached by M = (size / sb) F, F = [[e^t1, t2], [0, e^-t1]] (determinant 1), with t1 and
 * t2 the 2 globals: the cell is M B and centre i is M (u_i + x_i), x_i its offset (2 lengths). So
 * setSize changes the size alone and everything scales with it, a change of the globals deforms the
 * whole packing with the cell (Torquato and Jiao's strain), and rebase folds offsets, scale and
 * shear into the base and zeroes x, the globals included. The score is sqrt|det(M B)| = size.
 *
 * Images: the lattice vectors n1 L1 + n2 L2 of the plane basis L = M B within reach, found around
 * the nearest lattice point with a window from the basis's smallest singular value, so any basis is
 * enumerated correctly. One disk packs best in the hexagonal lattice, size sqrt(2 sqrt 3) = 1.86121
 * against 2 for the square cell; P disks in P copies of it, which is the bound.
 *
 * Configuration: { b1, b2, centres } in the plane. finish() scales centres and cell together until
 * the closest image pair touches; it costs 50 evaluations and a validation 10, as in the torus space.
 *
 * `instrument` wraps any kernel to record a run of either method: the chain's state, what the
 * offers cost, and collective trials that change nothing.
 */
import type { Finished, KernelState, SpaceKernel, Validation } from "../src/kernel";

type V2 = [number, number];

export interface TorusDisksConfig {
  b1: V2;
  b2: V2;
  centres: V2[];
}

interface Aux {
  /** The base basis b1x, b1y, b2x, b2y. */
  B: Float64Array;
  /** Its score sqrt|det B|. */
  sb: number;
  /** The base centres. */
  u: Float64Array;
}

/** A plane basis l1x, l1y, l2x, l2y with its smallest singular value: |L n| >= sigma |n|. */
interface Basis {
  L: Float64Array;
  sigma: number;
}

const basisOf = (L: Float64Array): Basis => {
  const [a, c, b, d] = L;
  // the columns are (a, c) and (b, d); the eigenvalues of L^T L are (T +- sqrt(T^2 - 4 det^2)) / 2
  const T = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return { L, sigma: Math.sqrt(Math.max(0, (T - Math.sqrt(Math.max(0, T * T - 4 * det * det))) / 2)) };
};

/** Lagrange-Gauss reduction: the same lattice, with a basis of its shortest vectors. */
function gaussReduce(L: Float64Array): Float64Array {
  let [ax, ay, bx, by] = L;
  for (let n = 0; n < 100; n++) {
    if (ax * ax + ay * ay > bx * bx + by * by) [ax, ay, bx, by] = [bx, by, ax, ay];
    const m = Math.round((ax * bx + ay * by) / (ax * ax + ay * ay));
    if (m === 0) break;
    bx -= m * ax;
    by -= m * ay;
  }
  return Float64Array.from([ax, ay, bx, by]);
}

/**
 * Calls fn with every image vector v = d - L n shorter than `reach`; for a disk and its own images
 * (self, d = 0) only one of each pair n, -n, and not n = 0.
 */
function images(b: Basis, dx: number, dy: number, self: boolean, fn: (vx: number, vy: number) => void, reach = 2) {
  const [a, c, bb, d] = b.L;
  const det = a * d - bb * c;
  // the lattice point nearest d, from its coordinates in the basis
  const m1 = self ? 0 : Math.round((d * dx - bb * dy) / det);
  const m2 = self ? 0 : Math.round((-c * dx + a * dy) / det);
  const r0 = Math.hypot(dx - m1 * a - m2 * bb, dy - m1 * c - m2 * d);
  // |d - L m - L k| < reach needs sigma |k| < reach + |d - L m|
  const K = Math.floor((reach + r0) / b.sigma);
  for (let k1 = -K; k1 <= K; k1++)
    for (let k2 = -K; k2 <= K; k2++) {
      if (self && !(k1 > 0 || (k1 === 0 && k2 > 0))) continue;
      const vx = dx - (m1 + k1) * a - (m2 + k2) * bb;
      const vy = dy - (m1 + k1) * c - (m2 + k2) * d;
      if (vx * vx + vy * vy < reach * reach) fn(vx, vy);
    }
}

/** The shortest image distance (pairs and each disk's own images), on a reduced basis. */
function closest(P: number, L: Float64Array, c: ArrayLike<number>): number {
  const b = basisOf(gaussReduce(L));
  // a pair's difference reduced to the cell, and b1 itself, are shorter than |b1| + |b2|
  const reach = Math.max(2, 1.01 * (Math.hypot(b.L[0], b.L[1]) + Math.hypot(b.L[2], b.L[3])));
  let dmin = Infinity;
  const see = (vx: number, vy: number) => (dmin = Math.min(dmin, Math.hypot(vx, vy)));
  for (let i = 0; i < P; i++) {
    images(b, 0, 0, true, see, reach);
    for (let j = i + 1; j < P; j++) images(b, c[2 * i] - c[2 * j], c[2 * i + 1] - c[2 * j + 1], false, see, reach);
  }
  return dmin;
}

const scoreOf = (b1: V2, b2: V2) => Math.sqrt(Math.abs(b1[0] * b2[1] - b1[1] * b2[0]));

export function validateTorusDisks(P: number, config: unknown, tol = 1e-9): Validation {
  const c = config as TorusDisksConfig;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const pair = (v: unknown): v is V2 => Array.isArray(v) && v.length === 2 && v.every(finite);
  if (!c || !pair(c.b1) || !pair(c.b2) || !Array.isArray(c.centres) || c.centres.length !== P || !c.centres.every(pair))
    return { valid: false, score: null, reasons: ["malformed configuration"] };
  const score = scoreOf(c.b1, c.b2);
  if (!(score > 0)) return { valid: false, score: null, reasons: ["degenerate cell"] };
  const d = closest(P, Float64Array.from([...c.b1, ...c.b2]), c.centres.flat());
  const valid = d >= 2 - tol;
  return { valid, score, reasons: valid ? [] : [`two disks are ${d} apart`] };
}

export function torusDisksKernel(P: number): SpaceKernel {
  const n = 2 * P;
  const auxOf = (s: KernelState) => s.aux as Aux;
  /** M = k F as m11, m12, m22 (m21 = 0), with k = size / sb and e = e^t1. */
  const frame = (s: KernelState) => {
    const k = s.size / auxOf(s).sb;
    const e = Math.exp(s.x[n]);
    return { k, e, m11: k * e, m12: k * s.x[n + 1], m22: k / e };
  };
  /** The plane basis M B and the plane centres M (u + x). */
  const plane = (s: KernelState) => {
    const { m11, m12, m22 } = frame(s);
    const { B, u } = auxOf(s);
    const L = Float64Array.from([m11 * B[0] + m12 * B[1], m22 * B[1], m11 * B[2] + m12 * B[3], m22 * B[3]]);
    const c = new Float64Array(n);
    for (let i = 0; i < P; i++) {
      const px = u[2 * i] + s.x[2 * i];
      const py = u[2 * i + 1] + s.x[2 * i + 1];
      c[2 * i] = m11 * px + m12 * py;
      c[2 * i + 1] = m22 * py;
    }
    return { L, c };
  };

  const energy = (s: KernelState, grad?: Float64Array, w?: Float64Array): number => {
    const { k, e, m11, m12, m22 } = frame(s);
    const { L, c } = plane(s);
    const b = basisOf(L);
    if (grad) grad.fill(0);
    let E = 0;
    // One image term of weight ww. Its vector is v = M q, q in the base frame, so dv/dsize =
    // v / size, dv/dt1 = k (e q_x, -q_y / e), dv/dt2 = k (q_y, 0), and for a pair dv/dx_i = M.
    const term = (ww: number, vx: number, vy: number, i: number, j: number) => {
      const r = Math.hypot(vx, vy);
      const over = 2 - r;
      E += ww * over * over;
      if (!grad || !(r > 0)) return;
      const gx = (-2 * ww * over * vx) / r;
      const gy = (-2 * ww * over * vy) / r;
      const qy = vy / m22;
      const qx = (vx - m12 * qy) / m11;
      grad[n + 2] += (gx * vx + gy * vy) / s.size;
      grad[n] += gx * k * e * qx - (gy * k * qy) / e;
      grad[n + 1] += gx * k * qy;
      if (j >= 0) {
        // M^T times dE/dv
        const tx = m11 * gx;
        const ty = m12 * gx + m22 * gy;
        grad[2 * i] += tx;
        grad[2 * i + 1] += ty;
        grad[2 * j] -= tx;
        grad[2 * j + 1] -= ty;
      }
    };
    for (let i = 0; i < P; i++) {
      const wi = w ? w[i] : 1;
      images(b, 0, 0, true, (vx, vy) => term(wi, vx, vy, i, -1));
      for (let j = i + 1; j < P; j++) {
        const wij = w ? (w[i] + w[j]) / 2 : 1;
        images(b, c[2 * i] - c[2 * j], c[2 * i + 1] - c[2 * j + 1], false, (vx, vy) => term(wij, vx, vy, i, j));
      }
    }
    return E;
  };

  const pieceEnergy = (s: KernelState, i: number, w?: Float64Array): number => {
    const { L, c } = plane(s);
    const b = basisOf(L);
    let E = 0;
    const wi = w ? w[i] : 1;
    images(b, 0, 0, true, (vx, vy) => (E += wi * (2 - Math.hypot(vx, vy)) ** 2));
    for (let j = 0; j < P; j++) {
      if (j === i) continue;
      const wij = w ? (w[i] + w[j]) / 2 : 1;
      images(b, c[2 * i] - c[2 * j], c[2 * i + 1] - c[2 * j + 1], false, (vx, vy) => {
        E += wij * (2 - Math.hypot(vx, vy)) ** 2;
      });
    }
    return E;
  };

  const stateOf = (L: Float64Array, centres: ArrayLike<number>): KernelState => {
    const sb = Math.sqrt(Math.abs(L[0] * L[3] - L[1] * L[2]));
    const aux: Aux = { B: Float64Array.from(L), sb, u: Float64Array.from(centres) };
    return { x: new Float64Array(n + 2), size: sb, aux };
  };
  const bound = Math.sqrt(2 * Math.sqrt(3) * P);

  return {
    space: "test",
    id: `test/torus-disks/${P}`,
    P,
    dim: 2,
    steps: Float64Array.from([1, 1]),
    inradius: 1,
    globals: 2,
    globalSteps: Float64Array.from([1 / bound, 1 / bound]),
    bound,
    finishCost: 50,
    validateCost: 10,
    capabilities: [],
    fromConfig(config) {
      const c = config as TorusDisksConfig;
      const pair = (v: unknown): v is V2 => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
      if (!c || !pair(c.b1) || !pair(c.b2) || !Array.isArray(c.centres) || c.centres.length !== P) return null;
      if (!c.centres.every(pair) || !(scoreOf(c.b1, c.b2) > 0)) return null;
      return stateOf(Float64Array.from([...c.b1, ...c.b2]), c.centres.flat());
    },
    toConfig(s): TorusDisksConfig {
      const { L, c } = plane(s);
      return {
        b1: [L[0], L[1]],
        b2: [L[2], L[3]],
        centres: Array.from({ length: P }, (_, i) => [c[2 * i], c[2 * i + 1]] as V2),
      };
    },
    clone(s) {
      const a = auxOf(s);
      const aux: Aux = { B: Float64Array.from(a.B), sb: a.sb, u: Float64Array.from(a.u) };
      return { x: Float64Array.from(s.x), size: s.size, aux };
    },
    rebase(s) {
      const a = auxOf(s);
      const { L, c } = plane(s);
      // a basis that has become skewed is replaced by a reduced one (the same lattice), as the torus space does
      const red = gaussReduce(L);
      const n2 = (q: Float64Array) => q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2;
      a.B.set(n2(L) > 1.5 * n2(red) ? red : L);
      a.sb = s.size;
      a.u.set(c);
      s.x.fill(0);
    },
    randomStart(rng) {
      const size = 2.5 * Math.sqrt(P) + 1;
      return stateOf(
        Float64Array.from([size, 0, 0, size]),
        Array.from({ length: n }, () => size * rng()),
      );
    },
    randomPose(s, i, rng) {
      // an offset uniform over the base cell moves the disk to a uniform position modulo the lattice
      const B = auxOf(s).B;
      const fa = rng();
      const fb = rng();
      s.x[2 * i] = fa * B[0] + fb * B[2];
      s.x[2 * i + 1] = fa * B[1] + fb * B[3];
    },
    jiggle(s, i, amount, rng) {
      s.x[2 * i] += (2 * rng() - 1) * amount;
      s.x[2 * i + 1] += (2 * rng() - 1) * amount;
    },
    setSize(s, size) {
      s.size = size;
    },
    energy,
    pieceEnergy,
    clear(s, i, tol) {
      const { L, c } = plane(s);
      const b = basisOf(L);
      let ok = true;
      const see = (vx: number, vy: number) => {
        if (Math.hypot(vx, vy) < 2 - tol) ok = false;
      };
      images(b, 0, 0, true, see);
      for (let j = 0; j < P && ok; j++)
        if (j !== i) images(b, c[2 * i] - c[2 * j], c[2 * i + 1] - c[2 * j + 1], false, see);
      return ok;
    },
    finish(s): Finished | null {
      const { L, c } = plane(s);
      const d = closest(P, L, c);
      if (!(d > 1e-9)) return null;
      // every image distance scales with the centres and the cell together; make the closest 2
      let lambda = 2 / d;
      for (let tries = 0; tries < 60; tries++) {
        const config: TorusDisksConfig = {
          b1: [lambda * L[0], lambda * L[1]],
          b2: [lambda * L[2], lambda * L[3]],
          centres: Array.from({ length: P }, (_, i) => [lambda * c[2 * i], lambda * c[2 * i + 1]] as V2),
        };
        if (validateTorusDisks(P, config, 0).valid) return { config, score: scoreOf(config.b1, config.b2) };
        lambda *= 1 + 4 * Number.EPSILON * (tries + 1);
      }
      return null;
    },
    validate: (config) => validateTorusDisks(P, config),
  };
}

/** What `instrument` records of a run of mc_compress or asc. */
export interface ChainProbe {
  /** The chain's state object, as the last jiggle or random re-placement saw it. */
  chain: KernelState | null;
  /** Evaluations spent finishing and validating, at the kernel's costs. */
  offerCost: number;
  finishes: number;
  /** Collective trials that checked a state equal to the chain's own: trials that change nothing. */
  empty: number;
}

/** A kernel that records a run (ChainProbe) and otherwise is `base`. */
export function instrument(base: SpaceKernel): { kernel: SpaceKernel; probe: ChainProbe } {
  const probe: ChainProbe = { chain: null, offerCost: 0, finishes: 0, empty: 0 };
  let checked: KernelState | null = null;
  const kernel: SpaceKernel = {
    ...base,
    jiggle(s, i, amount, rng) {
      probe.chain = s;
      base.jiggle(s, i, amount, rng);
    },
    randomPose(s, i, rng) {
      probe.chain = s;
      base.randomPose(s, i, rng);
    },
    clear(s, i, tol) {
      const c = probe.chain;
      // a collective trial checks a clone; one equal to the chain's state moved nothing
      if (c && s !== c && s !== checked && s.size === c.size && s.x.every((v, j) => v === c.x[j])) probe.empty++;
      checked = s;
      return base.clear(s, i, tol);
    },
    finish(s, stop) {
      probe.offerCost += base.finishCost;
      probe.finishes++;
      return base.finish(s, stop);
    },
    validate(config) {
      probe.offerCost += base.validateCost ?? base.finishCost;
      return base.validate(config);
    },
  };
  return { kernel, probe };
}
