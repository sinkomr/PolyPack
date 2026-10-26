/**
 * The search for unit balls in the smallest ball or cube (PolyPack's own code): a penalty method with the
 * container size as a variable, a legalization that makes the result exactly valid with a clearance, and basin
 * hopping between legalized packings.
 *
 * Polish. The variables are s and the centres c_i. Minimised, for penalty weights mu = 1e1, 1e2, ..., 1e10:
 *
 *   s + mu [ sum_{i<j} (2 + g - |c_i - c_j|)_+^2 + sum_i W_i ],
 *   W_i = (|c_i| - (s - 1 - w))_+^2 (ball), or sum_k (|c_ik| - (s/2 - 1 - w))_+^2 (cube),
 *
 * by L-BFGS from the previous stage's minimiser (g: pair clearance, w: wall clearance). A pair farther apart than
 * 2 + g contributes nothing; the pairs are read from a Verlet list (objective), which gives the same function.
 *
 * Legalization. The penalty leaves overlaps of about 1/mu. For a cube the centres are first translated so that
 * their bounding box is centred at the origin. Then, if the smallest centre distance d is below 2 + g, every
 * centre is scaled about the origin by (2 + g) / d, which makes every distance at least 2 + g, and s is set to the
 * smallest size with wall clearance w (max |c| + 1 + w, or 2 max |c_k| + 2 + 2 w), times 1 + 4 eps against the
 * rounding of a check. The result is checked with the validator at tolerance 0.
 *
 * Starts. A given configuration is legalized and polished. Without one: random centres in a container about 30 %
 * larger than the volume bound, or a cut of a lattice packing of unit balls (face-centred cubic or hexagonal
 * close-packed, turned and shifted at random; for a cube also the axis-aligned simple cubic and face-centred cubic
 * lattices): the P lattice points nearest the centre in the container's norm.
 *
 * Hops, from the best so far: move one to three balls to random places, move one or two of the loosest balls into
 * the largest holes found by sampling, shake every ball by a small normal step, or (one in ten) a new start; each in a container 0.5 to 4 % larger, then polished and legalized. A smaller
 * result replaces the best.
 */
import { StopSearch, lbfgs } from "@polypack/polyhedra";
import type { BallsProblem } from "./catalogue";
import { ballsBound } from "./problems";
import { type Rng, gauss, mulberry32, randomQuaternion, rotationOf } from "./random";
import { type BallsConfig, validateBalls } from "./validate";

export interface BallPiecesOptions {
  rng: Rng;
  /** Called once per objective evaluation; throws StopSearch to end the run. */
  tick: () => void;
  /** Called between evaluations (no evaluation counted); throws StopSearch to end the run. */
  poll: () => void;
  /** Pair and wall clearance of every legalized result. */
  clearance: number;
}

type Vec3 = [number, number, number];

/** Penalty weights of a full polish. */
export const BALL_MUS = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10];

/** Width of the margin of the pair list: pairs within 2 + g + SKIN of each other when it is made. */
const SKIN = 0.5;

/**
 * The objective of one stage on z = [s, x0, y0, z0, x1, ...]; returns f and fills grad.
 *
 * The pairs are taken from a list of those within 2 + g + SKIN, made again whenever a ball has moved SKIN / 2 or
 * more since (a Verlet list): a pair left out is then farther apart than 2 + g and contributes nothing, so the
 * function is the sum over all pairs, evaluated in the same order with the same rounding, at a cost of about the
 * dozen neighbours of each ball instead of all P - 1.
 */
function objective(cube: boolean, n: number, mu: number, g: number, w: number, tick: () => void) {
  const lim2 = (2 + g) * (2 + g);
  const ref = new Float64Array(3 * n);
  let pairs = new Int32Array(0);
  let count = 0;
  let made = false;
  // a little under SKIN / 2, so that rounding never lets a pair in reach that was left out
  const move2 = (0.499 * SKIN) ** 2;
  const reach2 = (2 + g + SKIN) ** 2;
  const relist = (z: Float64Array) => {
    const list: number[] = [];
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = z[1 + 3 * i] - z[1 + 3 * j];
        const dy = z[2 + 3 * i] - z[2 + 3 * j];
        const dz = z[3 + 3 * i] - z[3 + 3 * j];
        if (dx * dx + dy * dy + dz * dz < reach2) list.push(i, j);
      }
    pairs = Int32Array.from(list);
    count = list.length / 2;
    ref.set(z.subarray(1, 1 + 3 * n));
    made = true;
  };
  return (z: Float64Array, grad: Float64Array): number => {
    tick();
    let stale = !made;
    for (let i = 0; i < n && !stale; i++) {
      const dx = z[1 + 3 * i] - ref[3 * i];
      const dy = z[2 + 3 * i] - ref[3 * i + 1];
      const dz = z[3 + 3 * i] - ref[3 * i + 2];
      if (!(dx * dx + dy * dy + dz * dz < move2)) stale = true;
    }
    if (stale) relist(z);
    grad.fill(0);
    const s = z[0];
    let pen = 0;
    let gs = 0;
    if (cube) {
      const h = s / 2 - 1 - w;
      for (let i = 0; i < n; i++)
        for (let k = 0; k < 3; k++) {
          const v = z[1 + 3 * i + k];
          const viol = Math.abs(v) - h;
          if (viol <= 0) continue;
          pen += viol * viol;
          grad[1 + 3 * i + k] += 2 * mu * viol * Math.sign(v);
          gs -= mu * viol;
        }
    } else {
      const h = s - 1 - w;
      for (let i = 0; i < n; i++) {
        const x = z[1 + 3 * i];
        const y = z[2 + 3 * i];
        const q = z[3 + 3 * i];
        const r = Math.hypot(x, y, q);
        const viol = r - h;
        if (viol <= 0 || r === 0) continue;
        pen += viol * viol;
        const c = (2 * mu * viol) / r;
        grad[1 + 3 * i] += c * x;
        grad[2 + 3 * i] += c * y;
        grad[3 + 3 * i] += c * q;
        gs -= 2 * mu * viol;
      }
    }
    for (let p = 0; p < count; p++) {
      const i = pairs[2 * p];
      const j = pairs[2 * p + 1];
      const dx = z[1 + 3 * i] - z[1 + 3 * j];
      const dy = z[2 + 3 * i] - z[2 + 3 * j];
      const dz = z[3 + 3 * i] - z[3 + 3 * j];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= lim2) continue;
      const d = Math.sqrt(d2);
      const viol = 2 + g - d;
      pen += viol * viol;
      if (d === 0) continue;
      const c = (2 * mu * viol) / d;
      grad[1 + 3 * i] -= c * dx;
      grad[2 + 3 * i] -= c * dy;
      grad[3 + 3 * i] -= c * dz;
      grad[1 + 3 * j] += c * dx;
      grad[2 + 3 * j] += c * dy;
      grad[3 + 3 * j] += c * dz;
    }
    grad[0] = 1 + gs;
    return s + mu * pen;
  };
}

/**
 * A valid configuration near the given centres (see the file comment). Coincident centres are first moved apart
 * deterministically, since scaling cannot separate them.
 */
export function legalizeBalls(problem: BallsProblem, centres: Vec3[], g: number, w: number): BallsConfig {
  const cube = problem.container === "cube";
  let c = centres.map((p): Vec3 => [p[0], p[1], p[2]]);
  if (cube) {
    const mid = [0, 1, 2].map((k) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of c) {
        lo = Math.min(lo, p[k]);
        hi = Math.max(hi, p[k]);
      }
      return (lo + hi) / 2;
    });
    c = c.map((p): Vec3 => [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]]);
  }
  const n = c.length;
  for (let i = 1; i < n; i++)
    for (let j = 0; j < i; j++)
      if (c[i][0] === c[j][0] && c[i][1] === c[j][1] && c[i][2] === c[j][2]) {
        // a step of 2.2 along a spiral direction, different for each i
        const phi = Math.acos(1 - 2 * ((i * 0.6180339887498949) % 1));
        const th = 2.399963229728653 * i;
        c[i] = [c[i][0] + 2.2 * Math.sin(phi) * Math.cos(th), c[i][1] + 2.2 * Math.sin(phi) * Math.sin(th), c[i][2] + 2.2 * Math.cos(phi)];
      }
  let dmin = Infinity;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      dmin = Math.min(dmin, Math.hypot(c[i][0] - c[j][0], c[i][1] - c[j][1], c[i][2] - c[j][2]));
  if (dmin < 2 + g) {
    // distances scale by k exactly up to rounding; 4 eps more absorbs it
    const k = ((2 + g) / dmin) * (1 + 4 * Number.EPSILON);
    c = c.map((p): Vec3 => [p[0] * k, p[1] * k, p[2] * k]);
  }
  let s = 0;
  for (const p of c)
    s = Math.max(s, cube ? 2 * Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])) + 2 + 2 * w : Math.hypot(p[0], p[1], p[2]) + 1 + w);
  return { s: s * (1 + 4 * Number.EPSILON), pieces: c };
}

/**
 * Penalty polish (file comment) of the centres at size s, then legalization; on a stop, at an evaluation or between
 * the stages, the thrown StopSearch's `partial` holds the last finite iterate, legalized.
 */
export function polishBalls(
  problem: BallsProblem,
  start: BallsConfig,
  o: BallPiecesOptions,
  mus: readonly number[] = BALL_MUS,
): BallsConfig {
  const n = start.pieces.length;
  const cube = problem.container === "cube";
  const g = o.clearance;
  const w = o.clearance;
  const z = new Float64Array(1 + 3 * n);
  z[0] = start.s;
  start.pieces.forEach((p, i) => z.set([p[0], p[1], p[2]], 1 + 3 * i));
  const iters = 300 + 10 * n;
  const centres = (y: Float64Array) =>
    Array.from({ length: n }, (_, i): Vec3 => [y[1 + 3 * i], y[2 + 3 * i], y[3 + 3 * i]]);
  // the iterate before the stage under way, for a stop that comes after the stage's iterate stopped being finite
  const last = Float64Array.from(z);
  for (const mu of mus) {
    last.set(z);
    try {
      o.poll();
      lbfgs(objective(cube, n, mu, g, w, o.tick), z, iters);
    } catch (e) {
      // every stop hands over the last finite iterate, legalized (the legalization is a sweep over the pairs)
      if (e instanceof StopSearch)
        throw Object.assign(e, { partial: legalizeBalls(problem, centres(z.every(Number.isFinite) ? z : last), g, w) });
      throw e;
    }
    if (!z.every(Number.isFinite)) break;
  }
  return legalizeBalls(problem, centres(z), g, w);
}

// ------------------------------------------------------------------ starts

/** Points of a lattice packing of unit balls (nearest neighbours 2 apart) within radius `reach` of the origin. */
function latticePoints(kind: "fcc" | "hcp" | "sc", reach: number): Vec3[] {
  const out: Vec3[] = [];
  if (kind === "fcc") {
    // the cubic setting: a / 2 (i, j, k) with i + j + k even, a = 2 sqrt 2
    const h = Math.SQRT2;
    const m = Math.ceil(reach / h) + 1;
    for (let i = -m; i <= m; i++)
      for (let j = -m; j <= m; j++)
        for (let k = -m; k <= m; k++) if ((((i + j + k) % 2) + 2) % 2 === 0) out.push([i * h, j * h, k * h]);
  } else if (kind === "sc") {
    const m = Math.ceil(reach / 2) + 1;
    for (let i = -m; i <= m; i++) for (let j = -m; j <= m; j++) for (let k = -m; k <= m; k++) out.push([2 * i, 2 * j, 2 * k]);
  } else {
    // hexagonal layers of spacing 2, stacked ABAB at height 2 sqrt(2/3)
    const dz = 2 * Math.sqrt(2 / 3);
    const m = Math.ceil(reach / 2) + 2;
    const mz = Math.ceil(reach / dz) + 1;
    for (let l = -mz; l <= mz; l++) {
      const off = ((l % 2) + 2) % 2 === 1 ? [1, 1 / Math.sqrt(3)] : [0, 0];
      for (let i = -m; i <= m; i++)
        for (let j = -m; j <= m; j++) out.push([2 * i + j + off[0], j * Math.sqrt(3) + off[1], l * dz]);
    }
  }
  return out.filter((p) => Math.hypot(p[0], p[1], p[2]) <= reach);
}

/** The P points of a turned and shifted lattice nearest the centre in the container's norm. */
export function latticeCut(problem: BallsProblem, P: number, rng: Rng, kind: "fcc" | "hcp" | "sc", turn: boolean): Vec3[] {
  const cube = problem.container === "cube";
  const reach = 2 * Math.cbrt(P) + 6;
  const R = turn ? rotationOf(randomQuaternion(rng)) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const t: Vec3 = [2 * rng() - 1, 2 * rng() - 1, 2 * rng() - 1];
  const pts = latticePoints(kind, reach).map((p): Vec3 => [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
  ]);
  const norm = (p: Vec3) => (cube ? Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])) : Math.hypot(p[0], p[1], p[2]));
  // ties broken by a small random key, so that equal shells are cut differently from seed to seed
  const keyed = pts.map((p) => ({ p, k: norm(p) + 1e-9 * rng() }));
  keyed.sort((a, b) => a.k - b.k);
  return keyed.slice(0, P).map((e) => e.p);
}

/** Random centres in a container about 30 % larger than the lower bound's. */
export function randomCentres(problem: BallsProblem, P: number, rng: Rng): BallsConfig {
  const s = 1.3 * ballsBound(problem, P).value;
  const cube = problem.container === "cube";
  const pieces: Vec3[] = [];
  for (let i = 0; i < P; i++) {
    if (cube) {
      const h = Math.max(0, s / 2 - 1);
      pieces.push([h * (2 * rng() - 1), h * (2 * rng() - 1), h * (2 * rng() - 1)]);
    } else {
      // uniform in the ball of radius s - 1
      const r = Math.max(0, s - 1) * Math.cbrt(rng());
      const u = 2 * rng() - 1;
      const phi = 2 * Math.PI * rng();
      const q = Math.sqrt(1 - u * u);
      pieces.push([r * q * Math.cos(phi), r * q * Math.sin(phi), r * u]);
    }
  }
  return { s, pieces };
}

/** A new start: random centres or a lattice cut (legalized with the clearance g), chosen by the seed. */
export function freshStart(problem: BallsProblem, P: number, rng: Rng, g: number): BallsConfig {
  const cube = problem.container === "cube";
  const r = rng();
  if (r < 0.4) return randomCentres(problem, P, rng);
  const kinds: ["fcc" | "hcp" | "sc", boolean][] = cube
    ? [
        ["fcc", false],
        ["sc", false],
        ["fcc", true],
        ["hcp", true],
      ]
    : [
        ["fcc", true],
        ["hcp", true],
      ];
  const [kind, turn] = kinds[Math.floor(rng() * kinds.length)];
  const c = latticeCut(problem, P, rng, kind, turn);
  return legalizeBalls(problem, c, g, g);
}

/**
 * A hop from a configuration (file comment). `hops` "holes" (the default) also moves the loosest balls into the
 * largest holes found by sampling; "plain" is the hop of the first compute sweep (random places or a shake only).
 */
export function hopBalls(problem: BallsProblem, b: BallsConfig, rng: Rng, hops: "holes" | "plain" = "holes"): BallsConfig {
  const P = b.pieces.length;
  const cube = problem.container === "cube";
  const e = 1 + 0.005 + 0.035 * rng();
  const s = b.s * e;
  const pieces = b.pieces.map((p): Vec3 => [p[0] * e, p[1] * e, p[2] * e]);
  const r = rng();
  const somewhere = (): Vec3 => {
    if (cube) {
      const h = Math.max(0, s / 2 - 1);
      return [h * (2 * rng() - 1), h * (2 * rng() - 1), h * (2 * rng() - 1)];
    }
    const rr = Math.max(0, s - 1) * Math.cbrt(rng());
    const u = 2 * rng() - 1;
    const phi = 2 * Math.PI * rng();
    const q = Math.sqrt(1 - u * u);
    return [rr * q * Math.cos(phi), rr * q * Math.sin(phi), rr * u];
  };
  if (hops === "plain" ? r < 0.55 : r < 0.4 || P < 3) {
    const k = 1 + Math.floor(rng() * Math.min(3, P));
    for (let t = 0; t < k; t++) pieces[Math.floor(rng() * P)] = somewhere();
  } else if (r < 0.7 && hops === "holes") {
    // into holes: one or two of the loosest balls (fewest neighbours within 2.1, ties at random) each go to the
    // best of 64 random places, the one farthest from every other centre
    const near = pieces.map((p, i) => {
      let m = 0;
      for (let j = 0; j < P; j++)
        if (j !== i && Math.hypot(p[0] - pieces[j][0], p[1] - pieces[j][1], p[2] - pieces[j][2]) < 2.1 * e) m++;
      return { i, key: m + rng() };
    });
    near.sort((a, b) => a.key - b.key);
    const k = 1 + Math.floor(rng() * 2);
    for (let t = 0; t < k; t++) {
      const i = near[t].i;
      let best: Vec3 = pieces[i];
      let far = -Infinity;
      for (let n = 0; n < 64; n++) {
        const x = somewhere();
        let d = Infinity;
        for (let j = 0; j < P; j++)
          if (j !== i) d = Math.min(d, Math.hypot(x[0] - pieces[j][0], x[1] - pieces[j][1], x[2] - pieces[j][2]));
        if (d > far) {
          far = d;
          best = x;
        }
      }
      pieces[i] = best;
    }
  } else {
    const sigma = 0.02 + 0.25 * rng() * rng();
    for (const p of pieces) for (let k = 0; k < 3; k++) p[k] += sigma * gauss(rng);
  }
  return { s, pieces };
}

/** True when a configuration is valid at tolerance 0 (every legalized result should be). */
export function strictlyValid(problem: BallsProblem, c: BallsConfig): boolean {
  return validateBalls(problem, c, { tol: 0 }).valid;
}

export { mulberry32 };
