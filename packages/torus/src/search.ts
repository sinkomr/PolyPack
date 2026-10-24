/**
 * Seeded local search for packings on flat tori torus/<family>/N/P, in TypeScript (the research
 * search is python/torus/torus_search.py; this one serves the volunteer client).
 *
 * The size variable is a scale k applied to the lattice and to the centres together (pieces keep
 * side 1 or radius 1): the score is k times the score of the base lattice. Three parts:
 *
 *  - Penalty relaxation. Variables: each centre (x, y) in the base frame, each angle theta (times
 *    the circumradius, so that all variables are lengths), k and, for the free family, a shear
 *    F = [[e^t1, t2], [0, e^-t1]] of unit determinant applied to the lattice and the centres
 *    (the cell shape; sq and hex keep theirs). Minimise k + mu E for mu = 1e2 ... 1e8 with
 *    L-BFGS, where E sums max(0, -sep)^2 over the image pairs (i, j, lambda) within reach, sep
 *    being the separating-axis value of the shared kernel (pieceSeparation: the exact penetration
 *    depth when negative). Gradients are central differences of each piece's local energy, and of
 *    the total energy for k, t1, t2. The image pairs are listed again at the start of every round.
 *  - Tight scale. Scaling a packing up about the origin keeps it valid (the shrink argument of
 *    docs/spaces/TORUS.md section 3), so validity is monotone in k and the smallest valid k is
 *    found by bisection with the float validator (validateTorusPacking), to 1e-13 relative,
 *    keeping every separation >= 0. sq and hex lattices are rebuilt from L as the records store
 *    them, so the returned packing is exactly the one its configuration describes.
 *  - Basin hopping from the current packing: jiggle every piece, re-place one to three pieces,
 *    turn a quarter of the polygons by up to pi/N, or (free) shear the cell; then relax and take
 *    the tight scale. Acceptance as in the sphere search (T = 1e-3, back to the best after ten
 *    hops without a gain).
 *
 * Budget and seeding as in the sphere search: `maxEvals` counts objective and gradient
 * evaluations, `maxSeconds` is a wall-clock ceiling, `shouldStop` an external stop; all random
 * choices come from mulberry32(seed).
 */
import { type Pose, boundingRadius, pieceArea, pieceSeparation } from "@polypack/geometry";
import {
  type Lattice,
  type TorusFamily,
  cellArea,
  familyLattice,
  gaussReduce,
  latticeImages,
  torusScore,
} from "./lattice";
import { type TorusPacking, validateTorusPacking } from "./validate";

export interface TorusProblem {
  family: TorusFamily;
  N: number;
  P: number;
}

export interface TorusSearchOptions {
  seed: number;
  /** Packing to start from (any scale; an invalid one is first enlarged until it is valid). */
  start?: TorusPacking;
  /** Most objective and gradient evaluations; default 20,000. */
  maxEvals?: number;
  /** Wall-clock ceiling in seconds; default none. */
  maxSeconds?: number;
  shouldStop?: () => boolean;
  /** Seconds, for maxSeconds; default performance.now() / 1000. */
  now?: () => number;
  log?: (message: string) => void;
}

export interface TorusSearchResult {
  /** The best packing found, valid by validateTorusPacking with every separation >= 0, or null. */
  packing: TorusPacking | null;
  /** Its score (L, or sqrt of the cell area for free); Infinity when there is none. */
  score: number;
  /** Score of the start after the tight-scale bisection, or null without a start. */
  startScore: number | null;
  evaluations: number;
  hops: number;
  stopped: "evals" | "time" | "aborted";
}

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

class Stop extends Error {
  constructor(readonly why: "evals" | "time" | "aborted") {
    super(why);
  }
}

/** Minimal L-BFGS with a backtracking line search (the same as the sphere search's). */
function lbfgs(
  f: (x: Float64Array, g: Float64Array) => number,
  x0: Float64Array,
  maxIter: number,
  tick: () => void,
  firstStep: number,
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
      const scale = firstStep / Math.sqrt(gg);
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

/** A packing as the search keeps it: for sq/hex the lattice is always familyLattice(L). */
interface State {
  lattice: Lattice;
  poses: Pose[];
  score: number;
}

/** Lattice for a family at scale k of `l` (sq/hex rebuilt from L, exactly as stored). */
function scaledLattice(family: TorusFamily, l: Lattice, k: number): Lattice {
  if (family !== "free") return familyLattice(family, Math.hypot(l.b1[0], l.b1[1]) * k);
  return { b1: [l.b1[0] * k, l.b1[1] * k], b2: [l.b2[0] * k, l.b2[1] * k] };
}

export function searchTorus(problem: TorusProblem, o: TorusSearchOptions): TorusSearchResult {
  const { family, N, P } = problem;
  if (!["sq", "hex", "free"].includes(family) || !(N === 0 || (N >= 3 && N <= 100)) || !Number.isInteger(P) || P < 1)
    throw new Error("bad torus problem");
  const rand = mulberry32(o.seed);
  const maxEvals = o.maxEvals ?? 20_000;
  const clock = o.now ?? (() => performance.now() / 1000);
  const t0 = clock();
  const log = o.log ?? (() => {});
  const R = boundingRadius(N);
  const thetaScale = N === 0 ? 1 : R;
  let evaluations = 0;
  const tick = () => {
    evaluations++;
    if (evaluations > maxEvals) throw new Stop("evals");
    if (o.shouldStop?.()) throw new Stop("aborted");
    if (o.maxSeconds !== undefined && clock() - t0 > o.maxSeconds) throw new Stop("time");
  };

  const packingAt = (s: { lattice: Lattice; poses: Pose[] }, k: number): TorusPacking => ({
    family,
    N,
    lattice: scaledLattice(family, s.lattice, k),
    poses: s.poses.map((p) => ({ x: p.x * k, y: p.y * k, theta: p.theta })),
  });

  const validAt = (s: { lattice: Lattice; poses: Pose[] }, k: number): boolean => {
    tick();
    try {
      const v = validateTorusPacking(packingAt(s, k), { tol: 0 });
      return v.errors.length === 0 && v.valid && v.minSep >= 0;
    } catch {
      return false;
    }
  };

  /** The smallest valid scale of a packing, as a State, or null when none is near. */
  const tight = (s: { lattice: Lattice; poses: Pose[] }): State | null => {
    const bisect = (lo: number, hi: number): number => {
      while (hi - lo > 1e-13 * hi) {
        const mid = 0.5 * (lo + hi);
        if (validAt(s, mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    let k: number;
    let step = 1e-3;
    if (!validAt(s, 1)) {
      let lo = 1;
      let hi = 1;
      for (;;) {
        if (step > 4) return null;
        hi = lo * (1 + step);
        if (validAt(s, hi)) break;
        lo = hi;
        step *= 2;
      }
      k = bisect(lo, hi);
    } else {
      let hi = 1;
      let lo = 0;
      for (;;) {
        const next = hi * (1 - step);
        if (!validAt(s, next)) {
          lo = next;
          break;
        }
        hi = next;
        step = Math.min(0.5, step * 2);
      }
      k = bisect(lo, hi);
    }
    const p = packingAt(s, k);
    return { lattice: p.lattice, poses: p.poses.map((q) => ({ ...q })), score: torusScore(family, p.lattice) };
  };

  /** Penalty continuation from a packing (lattice, poses) scaled by k0. */
  const relax = (
    s: { lattice: Lattice; poses: Pose[] },
    k0: number,
    mus: number[],
  ): { lattice: Lattice; poses: Pose[] } => {
    let cur = {
      lattice: scaledLattice(family, s.lattice, k0),
      poses: s.poses.map((p) => ({ x: p.x * k0, y: p.y * k0, theta: p.theta })),
    };
    const free = family === "free";
    const nv = 3 * P + (free ? 3 : 1);
    const iK = 3 * P;
    const h = 1e-7;
    for (const mu of mus) {
      for (let round = 0; round < 3; round++) {
        let base = cur.lattice;
        if (free) base = gaussReduce(base).lattice;
        const u = cur.poses.map((p) => ({ ...p }));
        // image pairs within reach of the base packing
        const reach = 2 * R * 1.3 + 0.1;
        const pairs: { i: number; j: number; m: number; n: number }[] = [];
        try {
          for (let i = 0; i < P; i++)
            for (let j = i; j < P; j++)
              for (const im of latticeImages(base, [u[j].x - u[i].x, u[j].y - u[i].y], reach, i === j))
                pairs.push({ i, j, m: im.m, n: im.n });
        } catch {
          return cur;
        }
        const touching: number[][] = Array.from({ length: P }, () => []);
        pairs.forEach((p, idx) => {
          touching[p.i].push(idx);
          if (p.j !== p.i) touching[p.j].push(idx);
        });
        const lat = { b1: [0, 0], b2: [0, 0] };
        const centres = new Float64Array(2 * P);
        const thetas = new Float64Array(P);
        /** The packing for variables z: F k applied to the base frame. */
        const setup = (z: Float64Array) => {
          const k = z[iK];
          const e = free ? Math.exp(z[iK + 1]) : 1;
          const t2 = free ? z[iK + 2] : 0;
          const f11 = k * e;
          const f12 = k * t2;
          const f22 = k / e;
          lat.b1 = [f11 * base.b1[0] + f12 * base.b1[1], f22 * base.b1[1]];
          lat.b2 = [f11 * base.b2[0] + f12 * base.b2[1], f22 * base.b2[1]];
          for (let i = 0; i < P; i++) {
            const x = u[i].x + z[3 * i];
            const y = u[i].y + z[3 * i + 1];
            centres[2 * i] = f11 * x + f12 * y;
            centres[2 * i + 1] = f22 * y;
            thetas[i] = u[i].theta + z[3 * i + 2] / thetaScale;
          }
        };
        const pairEnergy = (
          idx: number,
          xi: number,
          yi: number,
          ti: number,
          xj: number,
          yj: number,
          tj: number,
        ): number => {
          const p = pairs[idx];
          const vx = xj + p.m * lat.b1[0] + p.n * lat.b2[0];
          const vy = yj + p.m * lat.b1[1] + p.n * lat.b2[1];
          const sep = pieceSeparation(N, { x: xi, y: yi, theta: ti }, { x: vx, y: vy, theta: tj }).sep;
          return sep < 0 ? sep * sep : 0;
        };
        const totalEnergy = (): number => {
          let E = 0;
          for (let idx = 0; idx < pairs.length; idx++) {
            const p = pairs[idx];
            E += pairEnergy(
              idx,
              centres[2 * p.i],
              centres[2 * p.i + 1],
              thetas[p.i],
              centres[2 * p.j],
              centres[2 * p.j + 1],
              thetas[p.j],
            );
          }
          return E;
        };
        /** Energy of piece i's image pairs with piece i at (x, y, theta) in world coordinates. */
        const localEnergy = (i: number, x: number, y: number, t: number): number => {
          let E = 0;
          for (const idx of touching[i]) {
            const p = pairs[idx];
            if (p.i === p.j) E += pairEnergy(idx, x, y, t, x, y, t);
            else if (p.i === i) E += pairEnergy(idx, x, y, t, centres[2 * p.j], centres[2 * p.j + 1], thetas[p.j]);
            else E += pairEnergy(idx, centres[2 * p.i], centres[2 * p.i + 1], thetas[p.i], x, y, t);
          }
          return E;
        };
        const f = (z: Float64Array, g: Float64Array): number => {
          if (!(z[iK] > 0) || (free && !(Math.abs(z[iK + 1]) < 2))) {
            g.fill(0);
            return Infinity;
          }
          setup(z);
          const E = totalEnergy();
          const k = z[iK];
          const e = free ? Math.exp(z[iK + 1]) : 1;
          const t2 = free ? z[iK + 2] : 0;
          for (let i = 0; i < P; i++) {
            const cx = centres[2 * i];
            const cy = centres[2 * i + 1];
            const ti = thetas[i];
            // d(centre)/d(variable): the map F k (columns (k e, 0) and (k t2, k / e))
            const ex = [k * e, 0];
            const ey = [k * t2, k / e];
            const gx =
              localEnergy(i, cx + h * ex[0], cy + h * ex[1], ti) - localEnergy(i, cx - h * ex[0], cy - h * ex[1], ti);
            const gy =
              localEnergy(i, cx + h * ey[0], cy + h * ey[1], ti) - localEnergy(i, cx - h * ey[0], cy - h * ey[1], ti);
            g[3 * i] = (mu * gx) / (2 * h);
            g[3 * i + 1] = (mu * gy) / (2 * h);
            if (N === 0) g[3 * i + 2] = 0;
            else {
              const gt = localEnergy(i, cx, cy, ti + h / thetaScale) - localEnergy(i, cx, cy, ti - h / thetaScale);
              g[3 * i + 2] = (mu * gt) / (2 * h);
            }
          }
          const zz = Float64Array.from(z);
          for (let c = iK; c < nv; c++) {
            const hc = c === iK ? 1e-9 * z[iK] : 1e-8;
            zz[c] = z[c] + hc;
            setup(zz);
            const Ep = totalEnergy();
            zz[c] = z[c] - hc;
            setup(zz);
            const Em = totalEnergy();
            zz[c] = z[c];
            g[c] = (mu * (Ep - Em)) / (2 * hc) + (c === iK ? 1 : 0);
          }
          setup(z);
          return z[iK] + mu * E;
        };
        const x0 = new Float64Array(nv);
        x0[iK] = 1;
        const z = lbfgs(f, x0, 150, tick, 1e-3);
        setup(z);
        const poses: Pose[] = Array.from({ length: P }, (_, i) => ({
          x: centres[2 * i],
          y: centres[2 * i + 1],
          theta: thetas[i],
        }));
        const lattice: Lattice = free
          ? { b1: [lat.b1[0], lat.b1[1]], b2: [lat.b2[0], lat.b2[1]] }
          : familyLattice(family, Math.hypot(lat.b1[0], lat.b1[1]));
        cur = { lattice, poses };
      }
    }
    return cur;
  };

  const local = (s: { lattice: Lattice; poses: Pose[] }, k0: number, mus: number[]): State | null =>
    tight(relax(s, k0, mus));

  /** Cell of area P A / density in the family's shape (free: square or hexagonal at random). */
  const freshLattice = (density: number): Lattice => {
    const area = (P * pieceArea(N)) / density;
    const shape: "sq" | "hex" = family === "free" ? (rand() < 0.5 ? "sq" : "hex") : family;
    return familyLattice(shape, shape === "sq" ? Math.sqrt(area) : Math.sqrt(area / (Math.sqrt(3) / 2)));
  };
  const randomPoint = (l: Lattice) => {
    const a = rand();
    const b = rand();
    return { x: a * l.b1[0] + b * l.b2[0], y: a * l.b1[1] + b * l.b2[1] };
  };
  const randomStart = (): State | null => {
    const lattice = freshLattice(0.45);
    const poses = Array.from({ length: P }, () => ({ ...randomPoint(lattice), theta: 2 * Math.PI * rand() }));
    return local({ lattice, poses }, 1, [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8]);
  };

  const perturb = (s: State): { lattice: Lattice; poses: Pose[] } => {
    let lattice = s.lattice;
    const poses = s.poses.map((p) => ({ ...p }));
    const kind = rand();
    if (kind < 0.35) {
      const sigma = (0.05 + 0.15 * rand()) * R;
      for (const p of poses) {
        p.x += sigma * gauss(rand);
        p.y += sigma * gauss(rand);
        if (N !== 0) p.theta += (sigma / R) * gauss(rand);
      }
    } else if (kind < 0.65 || N === 0) {
      const k = 1 + Math.floor(rand() * Math.min(3, Math.max(1, Math.floor(P / 3))));
      for (let t = 0; t < k; t++)
        poses[Math.floor(rand() * P)] = { ...randomPoint(lattice), theta: 2 * Math.PI * rand() };
    } else if (kind < 0.85 || family !== "free") {
      const k = Math.max(1, Math.floor(P / 4));
      for (let t = 0; t < k; t++) poses[Math.floor(rand() * P)].theta += (rand() - 0.5) * ((2 * Math.PI) / N);
    } else {
      // shear the free cell, carrying the centres along
      const e = Math.exp((rand() - 0.5) * 0.1);
      const t2 = (rand() - 0.5) * 0.2;
      const F = (x: number, y: number): [number, number] => [e * x + t2 * y, y / e];
      lattice = { b1: F(lattice.b1[0], lattice.b1[1]), b2: F(lattice.b2[0], lattice.b2[1]) };
      for (const p of poses) [p.x, p.y] = F(p.x, p.y);
    }
    return { lattice, poses };
  };

  let best: State | null = null;
  let startScore: number | null = null;
  let hops = 0;
  let stopped: TorusSearchResult["stopped"] = "evals";
  try {
    const st = o.start;
    if (st && st.poses.length === P && st.N === N && st.family === family && cellArea(st.lattice) > 0) {
      const s0 = { lattice: st.lattice, poses: st.poses.map((p) => ({ ...p })) };
      const t = tight(s0);
      if (t) {
        best = t;
        startScore = t.score;
        log(`start: score ${t.score}`);
      }
      const r = local(best ?? s0, 1, [1e4, 1e5, 1e6, 1e7, 1e8]);
      if (r && (!best || r.score < best.score)) best = r;
    }
    while (!best) best = randomStart();
    let cur: State = best;
    let misses = 0;
    for (;;) {
      hops++;
      const r = local(perturb(cur), 1.01, [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8]);
      if (!r) continue;
      if (r.score < best.score * (1 - 1e-13)) {
        best = r;
        log(`hop ${hops}: score ${r.score}`);
      }
      if (r.score < cur.score * (1 - 1e-13) || rand() < Math.exp(-(r.score / cur.score - 1) / 1e-3)) {
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
  const b = best as State | null;
  return {
    packing: b ? { family, N, lattice: b.lattice, poses: b.poses } : null,
    score: b ? b.score : Infinity,
    startScore,
    evaluations: Math.min(evaluations, maxEvals),
    hops,
    stopped,
  };
}
