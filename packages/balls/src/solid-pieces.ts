/**
 * The search for unit-edge Platonic solids in the smallest ball (PolyPack's own code, adapted from the polyhedra
 * space's polish, packages/polyhedra/src/polish.ts, to a ball container).
 *
 * Polish: the separating-plane penalty method. Every near pair (i, j) gets a plane n . x = t of its own,
 * n = m / |m|, and the variables are the ball's radius s, each piece's centre c and quaternion q (rotation
 * H(q) / |q|^2, so q needs no normalisation) and each plane's (m, t). Minimised, for mu = 1e1, ..., 1e9:
 *
 *   s + mu [ sum_pairs ( sum_{x in A} (n.x - t + g/2)_+^2 + sum_{x in B} (t - n.x + g/2)_+^2 )
 *            + sum_pieces sum_{x} (|x| - s + w)_+^2 ]  + small terms keeping |q| and |m| near 1,
 *
 * by L-BFGS; only vertices near a plane or the sphere enter the sums of a stage, and the pairs and vertex lists
 * are chosen again at each stage. The ball is centred at the origin; the pieces move freely, so its centre needs
 * no variable.
 *
 * Legalization: the pieces are moved apart by scaling their centres about the origin (as the polyhedra space
 * does: if every pair is separated by at least -d along some axis, scaling the centres by 1 + delta adds at least
 * 2 r delta to that axis' gap, r the inradius, since each piece holds the ball of radius r about its centre), until
 * every pair has the clearance g by the separating-axis test; then s = (largest vertex distance + w)(1 + 4 eps).
 *
 * Starts: P balls of the circumradius R placed as a packing of P unit balls in a ball (the ball search, a short
 * run) scaled by R, turned at random: valid as placed, since the pieces' circumscribed balls are disjoint, then
 * polished. Cubes also start from cuts of the cubic lattice (unit cubes face to face, axis-aligned, shifted at
 * random): the P cubes whose farthest vertices are nearest the centre.
 *
 * Hops, from the best: expand by 0.5 to 3 % and move and turn one to three pieces (a jiggle), or turn every piece
 * a little and shake it; then a polish. A smaller result replaces the best.
 */
import { type Pose, StopSearch, getSolid, lbfgs, place, separation, type Solid } from "@polypack/polyhedra";
import { type BallsProblem, ballContainerRadius, ballContainerRadiusSlope, ballContainerScore } from "./catalogue";
import { type Rng, gauss, randomQuaternion } from "./random";
import type { BallsConfig } from "./validate";

export interface SolidPiecesOptions {
  rng: Rng;
  tick: () => void;
  poll: () => void;
  clearance: number;
}

type Fn = (x: Float64Array, g: Float64Array) => number;

interface Pair {
  i: number;
  j: number;
  vi: number[];
  vj: number[];
}

/** Penalty weights of a full polish. */
export const SOLID_MUS = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];

/** Rotation H(q) / |q|^2 of an unnormalised quaternion (row-major), into R; returns |q|^2. */
function rotOf(w: number, x: number, y: number, z: number, R: Float64Array): number {
  const n = w * w + x * x + y * y + z * z;
  R[0] = (w * w + x * x - y * y - z * z) / n;
  R[1] = (2 * (x * y - w * z)) / n;
  R[2] = (2 * (x * z + w * y)) / n;
  R[3] = (2 * (x * y + w * z)) / n;
  R[4] = (w * w - x * x + y * y - z * z) / n;
  R[5] = (2 * (y * z - w * x)) / n;
  R[6] = (2 * (x * z - w * y)) / n;
  R[7] = (2 * (y * z + w * x)) / n;
  R[8] = (w * w - x * x - y * y + z * z) / n;
  return n;
}

function makeObjective(
  Pc: Solid,
  n: number,
  pairs: Pair[],
  walls: number[][],
  mu: number,
  g: number,
  w: number,
  tick: () => void,
): Fn {
  const nv = Pc.nv;
  const V = Pc.V;
  const X = new Float64Array(3 * nv * n);
  const G = new Float64Array(3 * nv * n);
  const R = new Float64Array(9 * n);
  const Q2 = new Float64Array(n);
  const touched = new Uint8Array(nv * n);
  const reg = 1e-3;
  const base = 1 + 7 * n;
  return (z, grad) => {
    tick();
    grad.fill(0);
    const s = z[0];
    for (let i = 0; i < n; i++) {
      const o = 1 + 7 * i;
      const Ri = R.subarray(9 * i, 9 * i + 9);
      Q2[i] = rotOf(z[o + 3], z[o + 4], z[o + 5], z[o + 6], Ri);
      for (let v = 0; v < nv; v++) {
        const a = V[3 * v];
        const b = V[3 * v + 1];
        const c = V[3 * v + 2];
        const k = 3 * (i * nv + v);
        X[k] = z[o] + Ri[0] * a + Ri[1] * b + Ri[2] * c;
        X[k + 1] = z[o + 1] + Ri[3] * a + Ri[4] * b + Ri[5] * c;
        X[k + 2] = z[o + 2] + Ri[6] * a + Ri[7] * b + Ri[8] * c;
      }
    }
    G.fill(0);
    touched.fill(0);
    let pen = 0;
    // the sphere: vertices beyond s - w
    const lim = ballContainerRadius(s) - w;
    for (let i = 0; i < n; i++)
      for (const v of walls[i]) {
        const k = 3 * (i * nv + v);
        const r = Math.hypot(X[k], X[k + 1], X[k + 2]);
        const viol = r - lim;
        if (viol <= 0 || r === 0) continue;
        pen += viol * viol;
        const c2 = (2 * mu * viol) / r;
        G[k] += c2 * X[k];
        G[k + 1] += c2 * X[k + 1];
        G[k + 2] += c2 * X[k + 2];
        touched[i * nv + v] = 1;
        grad[0] -= 2 * mu * viol * ballContainerRadiusSlope();
      }
    // pairs
    for (let p = 0; p < pairs.length; p++) {
      const { i, j, vi, vj } = pairs[p];
      const o = base + 4 * p;
      const mx = z[o];
      const my = z[o + 1];
      const mz = z[o + 2];
      const t = z[o + 3];
      const ml = Math.hypot(mx, my, mz);
      const ux = mx / ml;
      const uy = my / ml;
      const uz = mz / ml;
      let gnx = 0;
      let gny = 0;
      let gnz = 0;
      let gt = 0;
      for (const v of vi) {
        const k = 3 * (i * nv + v);
        const viol = ux * X[k] + uy * X[k + 1] + uz * X[k + 2] - t + g / 2;
        if (viol <= 0) continue;
        pen += viol * viol;
        const c2 = 2 * mu * viol;
        G[k] += c2 * ux;
        G[k + 1] += c2 * uy;
        G[k + 2] += c2 * uz;
        touched[i * nv + v] = 1;
        gnx += c2 * X[k];
        gny += c2 * X[k + 1];
        gnz += c2 * X[k + 2];
        gt -= c2;
      }
      for (const v of vj) {
        const k = 3 * (j * nv + v);
        const viol = t - (ux * X[k] + uy * X[k + 1] + uz * X[k + 2]) + g / 2;
        if (viol <= 0) continue;
        pen += viol * viol;
        const c2 = 2 * mu * viol;
        G[k] -= c2 * ux;
        G[k + 1] -= c2 * uy;
        G[k + 2] -= c2 * uz;
        touched[j * nv + v] = 1;
        gnx -= c2 * X[k];
        gny -= c2 * X[k + 1];
        gnz -= c2 * X[k + 2];
        gt += c2;
      }
      // d/dm of a function of n = m/|m|: (gn - (gn.n) n) / |m|
      const gu = gnx * ux + gny * uy + gnz * uz;
      const e = ml * ml - 1;
      grad[o] = (gnx - gu * ux) / ml + 4 * reg * e * mx;
      grad[o + 1] = (gny - gu * uy) / ml + 4 * reg * e * my;
      grad[o + 2] = (gnz - gu * uz) / ml + 4 * reg * e * mz;
      grad[o + 3] = gt;
    }
    // chain rule to the pieces: x = c + H(q) v / |q|^2
    let regSum = 0;
    for (let i = 0; i < n; i++) {
      const o = 1 + 7 * i;
      const qw = z[o + 3];
      const qx = z[o + 4];
      const qy = z[o + 5];
      const qz = z[o + 6];
      const q2 = Q2[i];
      let gcx = 0;
      let gcy = 0;
      let gcz = 0;
      let gw = 0;
      let gx = 0;
      let gy = 0;
      let gz = 0;
      let aRv = 0;
      for (let v = 0; v < nv; v++) {
        if (!touched[i * nv + v]) continue;
        const k = 3 * (i * nv + v);
        const ax = G[k];
        const ay = G[k + 1];
        const az = G[k + 2];
        gcx += ax;
        gcy += ay;
        gcz += az;
        const vx = V[3 * v];
        const vy = V[3 * v + 1];
        const vz = V[3 * v + 2];
        const av = ax * vx + ay * vy + az * vz;
        const ua = qx * ax + qy * ay + qz * az;
        const uv = qx * vx + qy * vy + qz * vz;
        const auv = ax * (qy * vz - qz * vy) + ay * (qz * vx - qx * vz) + az * (qx * vy - qy * vx);
        const vax = vy * az - vz * ay;
        const vay = vz * ax - vx * az;
        const vaz = vx * ay - vy * ax;
        gw += 2 * qw * av + 2 * auv;
        gx += -2 * av * qx + 2 * ua * vx + 2 * uv * ax + 2 * qw * vax;
        gy += -2 * av * qy + 2 * ua * vy + 2 * uv * ay + 2 * qw * vay;
        gz += -2 * av * qz + 2 * ua * vz + 2 * uv * az + 2 * qw * vaz;
        aRv += ax * (X[k] - z[o]) + ay * (X[k + 1] - z[o + 1]) + az * (X[k + 2] - z[o + 2]);
      }
      grad[o] = gcx;
      grad[o + 1] = gcy;
      grad[o + 2] = gcz;
      const e = q2 - 1;
      regSum += e * e;
      const c2 = (2 * aRv) / q2;
      grad[o + 3] = gw / q2 - c2 * qw + 4 * reg * e * qw;
      grad[o + 4] = gx / q2 - c2 * qx + 4 * reg * e * qx;
      grad[o + 5] = gy / q2 - c2 * qy + 4 * reg * e * qy;
      grad[o + 6] = gz / q2 - c2 * qz + 4 * reg * e * qz;
    }
    for (let p = 0; p < pairs.length; p++) {
      const o = base + 4 * p;
      const e = z[o] * z[o] + z[o + 1] * z[o + 1] + z[o + 2] * z[o + 2] - 1;
      regSum += e * e;
    }
    grad[0] += 1;
    return s + mu * pen + reg * regSum;
  };
}

const normalised = (p: ArrayLike<number>): Pose => {
  const m = Math.hypot(p[3], p[4], p[5], p[6]);
  return [p[0], p[1], p[2], p[3] / m, p[4] / m, p[5] / m, p[6] / m];
};

/** Pairs whose circumscribed balls (widened by pad) meet, with a plane each from the separating-axis test. */
function nearPairs(Pc: Solid, poses: Pose[], pad: number, poll: () => void) {
  const n = poses.length;
  const placed = poses.map((p) => place(Pc, p));
  const reach = 2 * Pc.circumradius + pad;
  const out: { i: number; j: number; axis: [number, number, number]; t: number }[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = placed[i].c;
      const b = placed[j].c;
      if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 > reach * reach) continue;
      poll();
      const r = separation(placed[i], placed[j], 0);
      const [ux, uy, uz] = r.axis;
      let hiA = -Infinity;
      let loB = Infinity;
      const XA = placed[i].X;
      const XB = placed[j].X;
      for (let k = 0; k < XA.length; k += 3) hiA = Math.max(hiA, ux * XA[k] + uy * XA[k + 1] + uz * XA[k + 2]);
      for (let k = 0; k < XB.length; k += 3) loB = Math.min(loB, ux * XB[k] + uy * XB[k + 1] + uz * XB[k + 2]);
      out.push({ i, j, axis: r.axis, t: (hiA + loB) / 2 });
    }
  return { placed, out };
}

/** Smallest separation over pairs whose circumscribed balls meet (each pair stops at `enough`). */
function minSeparation(Pc: Solid, poses: Pose[], enough: number, poll: () => void): number {
  const placed = poses.map((p) => place(Pc, p));
  const reach = 2 * Pc.circumradius + Math.max(enough, 0) + 1e-9;
  let m = Infinity;
  for (let i = 0; i < poses.length; i++)
    for (let j = i + 1; j < poses.length; j++) {
      const a = placed[i].c;
      const b = placed[j].c;
      if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 > reach * reach) continue;
      poll();
      m = Math.min(m, separation(placed[i], placed[j], enough).sep);
    }
  return m;
}

/** A valid configuration near the given poses (file comment); orientations are kept. */
export function legalizeSolids(problem: BallsProblem, poses0: ArrayLike<number>[], g: number, w: number, poll: () => void): BallsConfig {
  const Pc = getSolid(problem.piece);
  let poses = poses0.map(normalised);
  const close = (a: Pose, b: Pose) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9 * (1 + Math.hypot(a[0], a[1], a[2]));
  poses = poses.map((p, i): Pose => {
    if (!poses.some((q, j) => j < i && close(p, q))) return p;
    const t = i + 1;
    const r = 2.2 * Pc.circumradius * Math.cbrt(t);
    const phi = Math.acos(1 - 2 * ((t * 0.6180339887498949) % 1));
    const th = 2.399963229728653 * t;
    return [p[0] + r * Math.sin(phi) * Math.cos(th), p[1] + r * Math.sin(phi) * Math.sin(th), p[2] + r * Math.cos(phi), p[3], p[4], p[5], p[6]];
  });
  let extra = 0;
  for (let round = 0; round < 60; round++) {
    const sep = minSeparation(Pc, poses, g, poll);
    if (sep >= g) break;
    const delta = (g - sep) / (2 * Pc.inradius) + extra + 1e-15;
    poses = poses.map((p): Pose => [p[0] * (1 + delta), p[1] * (1 + delta), p[2] * (1 + delta), p[3], p[4], p[5], p[6]]);
    extra = extra ? 2 * extra : 1e-14;
  }
  let far = 0;
  for (const p of poses) {
    const X = place(Pc, p).X;
    for (let k = 0; k < X.length; k += 3) far = Math.max(far, Math.hypot(X[k], X[k + 1], X[k + 2]));
  }
  return { s: ballContainerScore((far + w) * (1 + 4 * Number.EPSILON)), pieces: poses };
}

/**
 * Penalty polish (file comment), then legalization. On a stop the thrown StopSearch carries `partial`, the last
 * iterate legalized; a stop before the first stage has minimised carries none, the start being the only iterate.
 */
export function polishSolids(
  problem: BallsProblem,
  config: BallsConfig,
  o: SolidPiecesOptions,
  mus: readonly number[] = SOLID_MUS,
): BallsConfig {
  const Pc = getSolid(problem.piece);
  const g = o.clearance;
  const w = o.clearance;
  const n = config.pieces.length;
  let poses = config.pieces.map(normalised);
  let s = config.s;
  const iters = 400;
  // true once a stage has minimised: its iterate is near legal, and a stop from then on hands it over, legalized
  let moved = false;
  for (const mu of mus) {
    const delta = 0.25 * Pc.circumradius + 0.05;
    let near: ReturnType<typeof nearPairs>;
    try {
      near = nearPairs(Pc, poses, 0.1 * Pc.circumradius + 0.05, o.poll);
    } catch (e) {
      // a stop between stages: the last iterate, legalized without polls since it is near legal (before the first
      // stage there is none, and the caller has the start)
      if (e instanceof StopSearch && moved)
        throw Object.assign(e, { partial: legalizeSolids(problem, poses, g, w, () => {}) });
      throw e;
    }
    const { placed, out } = near;
    const pairs: Pair[] = out.map(({ i, j, axis, t }) => {
      const vi: number[] = [];
      const vj: number[] = [];
      const XA = placed[i].X;
      const XB = placed[j].X;
      for (let v = 0; v < Pc.nv; v++) {
        if (axis[0] * XA[3 * v] + axis[1] * XA[3 * v + 1] + axis[2] * XA[3 * v + 2] >= t - delta) vi.push(v);
        if (axis[0] * XB[3 * v] + axis[1] * XB[3 * v + 1] + axis[2] * XB[3 * v + 2] <= t + delta) vj.push(v);
      }
      return { i, j, vi, vj };
    });
    const walls = placed.map((pl) => {
      const v: number[] = [];
      for (let k = 0; k < Pc.nv; k++) if (Math.hypot(pl.X[3 * k], pl.X[3 * k + 1], pl.X[3 * k + 2]) >= s - delta) v.push(k);
      return v;
    });
    const z = new Float64Array(1 + 7 * n + 4 * pairs.length);
    z[0] = s;
    poses.forEach((p, i) => z.set(p, 1 + 7 * i));
    out.forEach(({ axis, t }, p) => {
      z.set(axis, 1 + 7 * n + 4 * p);
      z[1 + 7 * n + 4 * p + 3] = t;
    });
    let stopped: StopSearch | null = null;
    try {
      lbfgs(makeObjective(Pc, n, pairs, walls, mu, g, w, o.tick), z, iters);
    } catch (e) {
      if (!(e instanceof StopSearch)) throw e;
      stopped = e;
    }
    if (z.every(Number.isFinite)) {
      s = z[0];
      poses = poses.map((_, i) => normalised(z.subarray(1 + 7 * i, 8 + 7 * i)));
      moved = true;
    }
    if (stopped) {
      // the last iterate, legalized without polls, so that a stop already seen cannot leave it without a result
      const partial = legalizeSolids(problem, poses, g, w, () => {});
      throw Object.assign(stopped, { partial });
    }
  }
  // not polled: the polished iterate is near legal, so this is a sweep or two over the pairs, and a stop that came
  // during it would otherwise leave the polish without a result
  return legalizeSolids(problem, poses, g, w, () => {});
}

/** Poses of solids at given centres, turned at random. */
export function solidsAt(centres: number[][], rng: Rng): Pose[] {
  return centres.map((c): Pose => [c[0], c[1], c[2], ...randomQuaternion(rng)]);
}

/** P axis-aligned unit cubes of the cubic lattice, shifted at random, whose farthest vertices are nearest the origin. */
export function cubeLatticeCut(P: number, rng: Rng): Pose[] {
  const t = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
  const m = Math.ceil(Math.cbrt(P)) + 3;
  const cells: { c: number[]; far: number }[] = [];
  for (let i = -m; i <= m; i++)
    for (let j = -m; j <= m; j++)
      for (let k = -m; k <= m; k++) {
        const c = [i + t[0], j + t[1], k + t[2]];
        const far = Math.hypot(Math.abs(c[0]) + 0.5, Math.abs(c[1]) + 0.5, Math.abs(c[2]) + 0.5);
        cells.push({ c, far: far + 1e-9 * rng() });
      }
  cells.sort((a, b) => a.far - b.far);
  return cells.slice(0, P).map(({ c }): Pose => [c[0], c[1], c[2], 1, 0, 0, 0]);
}

/** A jiggle or a shake of the best configuration (file comment). */
export function hopSolids(problem: BallsProblem, b: BallsConfig, rng: Rng): BallsConfig {
  const Pc = getSolid(problem.piece);
  const P = b.pieces.length;
  const e = 1 + 0.005 + 0.025 * rng();
  const pieces = b.pieces.map((p): number[] => [p[0] * e, p[1] * e, p[2] * e, p[3], p[4], p[5], p[6]]);
  if (rng() < 0.6) {
    const k = 1 + Math.floor(rng() * Math.min(3, P));
    for (let t = 0; t < k; t++) {
      const i = Math.floor(rng() * P);
      const p = pieces[i];
      const a = 0.3 * rng();
      const step = Pc.inradius * 0.5;
      pieces[i] = [
        p[0] + step * gauss(rng),
        p[1] + step * gauss(rng),
        p[2] + step * gauss(rng),
        p[3] + a * gauss(rng),
        p[4] + a * gauss(rng),
        p[5] + a * gauss(rng),
        p[6] + a * gauss(rng),
      ];
    }
  } else {
    const a = 0.02 + 0.1 * rng();
    const step = Pc.inradius * (0.02 + 0.1 * rng());
    for (const p of pieces) {
      for (let k = 0; k < 3; k++) p[k] += step * gauss(rng);
      for (let k = 3; k < 7; k++) p[k] += a * gauss(rng);
    }
  }
  return { s: b.s * e, pieces };
}
