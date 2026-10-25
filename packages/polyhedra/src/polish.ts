/**
 * Polish of a packing and its legalization (PolyPack's own code).
 *
 * Polish: the separating-plane penalty method (the quasi-phi-function model of Pankratov, Romanova, Stoyan et
 * al., as used by upstream's tightening and by compute studies of the wiki records). Every near pair (i, j) gets
 * a plane n . x = t of its own, n = m / |m|, and the variables are the container scale s, each piece's centre c
 * and quaternion q (rotation H(q) / |q|^2, so q needs no normalisation) and each plane's (m, t). Minimised:
 *
 *   s + mu [ sum_pairs ( sum_{x in A} (n.x - t + g/2)_+^2 + sum_{x in B} (t - n.x + g/2)_+^2 )
 *            + sum_pieces sum_faces sum_{x} (N_f.x - s b_f + w)_+^2 ]  + small terms keeping |q| and |m| near 1,
 *
 * with L-BFGS for mu = 1e1, 1e2, ..., 1e9 (g: pair clearance, w: wall clearance). Only vertices near a plane or a
 * wall are kept in the sums of a stage; the pairs and the vertex lists are chosen again at each stage.
 *
 * Legalization (legalizeConfig): the penalty leaves overlaps of about 1/mu. The pieces are first moved apart by
 * scaling their centres about the origin: if every pair is separated by at least -d along some axis, scaling the
 * centres by 1 + delta adds at least 2 rho delta to that axis' gap, rho the piece's inradius (each piece contains
 * the ball of radius rho about its centre, so the centres lie at least rho inside the two half-spaces of the
 * axis), so delta = (g + d) / (2 rho) gives every pair the clearance g. Then the container is translated by the
 * best translation (a 4-variable LP) and s is set to the smallest scale with wall clearance w. The result is
 * checked with the separating-axis test, and the scaling is repeated with a larger delta if float rounding left
 * a pair short.
 */
import { type Pose, place, separation } from "./geom";
import { getSolid, type Solid } from "./solids";
import type { PolyhedraProblem } from "./problems";
import type { PolyhedraConfig } from "./validate";

export class StopSearch extends Error {
  constructor(readonly why: "evals" | "time" | "aborted") {
    super(why);
  }
}

export interface PolishOptions {
  /** Pair clearance g kept by the penalty and by the legalization; default 1e-12. */
  pairClearance?: number;
  /** Wall clearance w; default 1e-12. */
  wallClearance?: number;
  /** Penalty weights of the stages; default 1e1, 1e2, ..., 1e9. */
  mus?: number[];
  /** L-BFGS iterations per stage; default 400. */
  iterations?: number;
  /** Called once per function evaluation; may throw StopSearch (the polish then legalizes what it has). */
  tick?: () => void;
}

export interface PolishResult {
  config: PolyhedraConfig;
  /** Function evaluations used. */
  evaluations: number;
  /** True when tick() stopped the polish before its last stage. */
  stopped: StopSearch["why"] | null;
}

// ------------------------------------------------------------------ L-BFGS

type Fn = (x: Float64Array, g: Float64Array) => number;

/** Minimises f from x (in place) by L-BFGS with an Armijo backtracking line search; returns f(x). */
export function lbfgs(f: Fn, x: Float64Array, maxIter: number, m = 8, gtol = 1e-12): number {
  const n = x.length;
  const g = new Float64Array(n);
  let fx = f(x, g);
  const S: Float64Array[] = [];
  const Y: Float64Array[] = [];
  const rho: number[] = [];
  const d = new Float64Array(n);
  const xn = new Float64Array(n);
  const gn = new Float64Array(n);
  const alpha = new Array(m).fill(0);
  let stall = 0;
  for (let it = 0; it < maxIter; it++) {
    let gmax = 0;
    for (let i = 0; i < n; i++) gmax = Math.max(gmax, Math.abs(g[i]));
    if (gmax < gtol) break;
    // two-loop recursion: d = -H g
    for (let i = 0; i < n; i++) d[i] = -g[i];
    const k = S.length;
    for (let j = k - 1; j >= 0; j--) {
      let a = 0;
      for (let i = 0; i < n; i++) a += S[j][i] * d[i];
      a *= rho[j];
      alpha[j] = a;
      for (let i = 0; i < n; i++) d[i] -= a * Y[j][i];
    }
    if (k > 0) {
      let sy = 0;
      let yy = 0;
      for (let i = 0; i < n; i++) {
        sy += S[k - 1][i] * Y[k - 1][i];
        yy += Y[k - 1][i] * Y[k - 1][i];
      }
      const gamma = sy / yy;
      for (let i = 0; i < n; i++) d[i] *= gamma;
    } else {
      // first step: at most 1e-3 in any variable
      let dm = 0;
      for (let i = 0; i < n; i++) dm = Math.max(dm, Math.abs(d[i]));
      const sc = dm > 0 ? Math.min(1, 1e-3 / dm) : 1;
      for (let i = 0; i < n; i++) d[i] *= sc;
    }
    for (let j = 0; j < k; j++) {
      let b = 0;
      for (let i = 0; i < n; i++) b += Y[j][i] * d[i];
      b *= rho[j];
      for (let i = 0; i < n; i++) d[i] += S[j][i] * (alpha[j] - b);
    }
    let dg = 0;
    for (let i = 0; i < n; i++) dg += d[i] * g[i];
    if (!(dg < 0)) {
      // not a descent direction: restart from steepest descent
      S.length = 0;
      Y.length = 0;
      rho.length = 0;
      let dm = 0;
      for (let i = 0; i < n; i++) dm = Math.max(dm, Math.abs(g[i]));
      const sc = dm > 0 ? 1e-3 / dm : 0;
      dg = 0;
      for (let i = 0; i < n; i++) {
        d[i] = -g[i] * sc;
        dg += d[i] * g[i];
      }
      if (!(dg < 0)) break;
    }
    let step = 1;
    let fn = 0;
    let ok = false;
    for (let ls = 0; ls < 40; ls++) {
      for (let i = 0; i < n; i++) xn[i] = x[i] + step * d[i];
      fn = f(xn, gn);
      if (fn <= fx + 1e-4 * step * dg) {
        ok = true;
        break;
      }
      step *= 0.5;
    }
    if (!ok) break;
    const s = new Float64Array(n);
    const y = new Float64Array(n);
    let sy = 0;
    for (let i = 0; i < n; i++) {
      s[i] = xn[i] - x[i];
      y[i] = gn[i] - g[i];
      sy += s[i] * y[i];
    }
    const df = fx - fn;
    x.set(xn);
    g.set(gn);
    fx = fn;
    if (sy > 1e-300) {
      S.push(s);
      Y.push(y);
      rho.push(1 / sy);
      if (S.length > m) {
        S.shift();
        Y.shift();
        rho.shift();
      }
    }
    stall = df <= 1e-15 * Math.max(1, Math.abs(fx)) ? stall + 1 : 0;
    if (stall >= 5) break;
  }
  return fx;
}

// ------------------------------------------------------------------ the penalty

interface Pair {
  i: number;
  j: number;
  /** active vertices of i and j */
  vi: number[];
  vj: number[];
}

/** Rotation H(q) / |q|^2 of an unnormalised quaternion (row-major), into R. */
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

/** The penalty objective of one stage, as a function of the packed variables, with its gradient. */
function makeObjective(
  Pc: Solid,
  Cc: Solid,
  n: number,
  pairs: Pair[],
  walls: { f: number; v: number[] }[][],
  mu: number,
  g: number,
  w: number,
  tick?: () => void,
): { f: Fn; evals: () => number } {
  const nv = Pc.nv;
  const V = Pc.V;
  const X = new Float64Array(3 * nv * n);
  const G = new Float64Array(3 * nv * n);
  const R = new Float64Array(9 * n);
  const Q2 = new Float64Array(n);
  const touched = new Uint8Array(nv * n);
  const reg = 1e-3;
  let count = 0;
  const base = 1 + 7 * n;
  const f: Fn = (z, grad) => {
    tick?.();
    count++;
    grad.fill(0);
    const s = z[0];
    for (let i = 0; i < n; i++) {
      const o = 1 + 7 * i;
      const Ri = R.subarray(9 * i, 9 * i + 9);
      Q2[i] = rotOf(z[o + 3], z[o + 4], z[o + 5], z[o + 6], Ri);
      const cx = z[o];
      const cy = z[o + 1];
      const cz = z[o + 2];
      for (let v = 0; v < nv; v++) {
        const a = V[3 * v];
        const b = V[3 * v + 1];
        const c = V[3 * v + 2];
        const k = 3 * (i * nv + v);
        X[k] = cx + Ri[0] * a + Ri[1] * b + Ri[2] * c;
        X[k + 1] = cy + Ri[3] * a + Ri[4] * b + Ri[5] * c;
        X[k + 2] = cz + Ri[6] * a + Ri[7] * b + Ri[8] * c;
      }
    }
    G.fill(0);
    touched.fill(0);
    let pen = 0;
    // walls
    const CN = Cc.N;
    const Cb = Cc.offsets;
    for (let i = 0; i < n; i++)
      for (const { f: face, v: list } of walls[i]) {
        const nx = CN[3 * face];
        const ny = CN[3 * face + 1];
        const nz = CN[3 * face + 2];
        const lim = s * Cb[face] - w;
        for (const v of list) {
          const k = 3 * (i * nv + v);
          const viol = X[k] * nx + X[k + 1] * ny + X[k + 2] * nz - lim;
          if (viol <= 0) continue;
          pen += viol * viol;
          const c2 = 2 * mu * viol;
          G[k] += c2 * nx;
          G[k + 1] += c2 * ny;
          G[k + 2] += c2 * nz;
          touched[i * nv + v] = 1;
          grad[0] -= c2 * Cb[face];
        }
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
      pen += 0; // the regulariser is added below
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
        // a . (u x v)
        const auv = ax * (qy * vz - qz * vy) + ay * (qz * vx - qx * vz) + az * (qx * vy - qy * vx);
        // v x a
        const vax = vy * az - vz * ay;
        const vay = vz * ax - vx * az;
        const vaz = vx * ay - vy * ax;
        gw += 2 * qw * av + 2 * auv;
        gx += -2 * av * qx + 2 * ua * vx + 2 * uv * ax + 2 * qw * vax;
        gy += -2 * av * qy + 2 * ua * vy + 2 * uv * ay + 2 * qw * vay;
        gz += -2 * av * qz + 2 * ua * vz + 2 * uv * az + 2 * qw * vaz;
        // a . (R v) = a . (x - c)
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
  return { f, evals: () => count };
}

/** Pairs whose circumscribed balls (widened by `pad`) meet, with planes from the separating-axis test. */
function nearPairs(Pc: Solid, poses: Pose[], pad: number) {
  const n = poses.length;
  const placed = poses.map((p) => place(Pc, p));
  const reach = 2 * Pc.circumradius + pad;
  const out: { i: number; j: number; axis: [number, number, number]; t: number }[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = placed[i].c;
      const b = placed[j].c;
      if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 > reach * reach) continue;
      const r = separation(placed[i], placed[j]);
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

const normalised = (p: Pose): Pose => {
  const m = Math.hypot(p[3], p[4], p[5], p[6]);
  return [p[0], p[1], p[2], p[3] / m, p[4] / m, p[5] / m, p[6] / m];
};

/** Penalty polish of a configuration (see the file comment), followed by legalizeConfig. */
export function polishConfig(problem: PolyhedraProblem, config: PolyhedraConfig, opts: PolishOptions = {}): PolishResult {
  const Pc = getSolid(problem.piece);
  const Cc = getSolid(problem.container);
  const g = opts.pairClearance ?? 1e-12;
  const w = opts.wallClearance ?? 1e-12;
  const mus = opts.mus ?? [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
  const iters = opts.iterations ?? 400;
  const n = config.pieces.length;
  let poses = config.pieces.map(normalised);
  let s = config.s;
  let evaluations = 0;
  let stopped: StopSearch["why"] | null = null;
  for (const mu of mus) {
    // vertex lists: within delta of the stage's planes and walls
    const delta = 0.25 * Pc.circumradius + 0.05;
    const { placed, out } = nearPairs(Pc, poses, 0.1 * Pc.circumradius + 0.05);
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
      const list: { f: number; v: number[] }[] = [];
      for (let f = 0; f < Cc.offsets.length; f++) {
        const nx = Cc.N[3 * f];
        const ny = Cc.N[3 * f + 1];
        const nz = Cc.N[3 * f + 2];
        const lim = s * Cc.offsets[f] - delta;
        const v: number[] = [];
        for (let k = 0; k < Pc.nv; k++)
          if (nx * pl.X[3 * k] + ny * pl.X[3 * k + 1] + nz * pl.X[3 * k + 2] >= lim) v.push(k);
        if (v.length) list.push({ f, v });
      }
      return list;
    });
    const z = new Float64Array(1 + 7 * n + 4 * pairs.length);
    z[0] = s;
    poses.forEach((p, i) => z.set(p, 1 + 7 * i));
    out.forEach(({ axis, t }, p) => {
      z.set(axis, 1 + 7 * n + 4 * p);
      z[1 + 7 * n + 4 * p + 3] = t;
    });
    const obj = makeObjective(Pc, Cc, n, pairs, walls, mu, g, w, opts.tick);
    // the best iterate seen, for a stop in the middle of a line search
    try {
      lbfgs(obj.f, z, iters);
    } catch (e) {
      if (!(e instanceof StopSearch)) throw e;
      stopped = e.why;
    }
    evaluations += obj.evals();
    if (z.every(Number.isFinite)) {
      s = z[0];
      poses = poses.map((_, i) => normalised(Array.from(z.subarray(1 + 7 * i, 8 + 7 * i)) as Pose));
    }
    if (stopped) break;
  }
  const config2 = legalizeConfig(problem, { s, pieces: poses }, g, w);
  return { config: config2, evaluations, stopped };
}

/**
 * The best translation t of the pieces in the container: min z with N_f . (x + t) <= z b_f for all vertices x;
 * the size is then z. Enumerates 4-subsets of faces for containers with at most 14 faces, else uses the simplex
 * of sim.ts. Returns t (the caller recomputes the scale exactly).
 */
function bestTranslation(Cc: Solid, S: number[]): [number, number, number] {
  const F = S.length;
  const N = (f: number) => [Cc.N[3 * f], Cc.N[3 * f + 1], Cc.N[3 * f + 2]];
  const b = Cc.offsets;
  const zAt = (t: number[]) => {
    let z = -Infinity;
    for (let f = 0; f < F; f++) {
      const nf = N(f);
      z = Math.max(z, (S[f] + nf[0] * t[0] + nf[1] * t[1] + nf[2] * t[2]) / b[f]);
    }
    return z;
  };
  let best: [number, number, number] = [0, 0, 0];
  let bz = zAt(best);
  if (F <= 14) {
    for (let a = 0; a < F; a++)
      for (let c = a + 1; c < F; c++)
        for (let d = c + 1; d < F; d++)
          for (let e = d + 1; e < F; e++) {
            const idx = [a, c, d, e];
            const A = idx.map((f) => [...N(f), -b[f], -S[f]]);
            let ok = true;
            for (let col = 0; col < 4 && ok; col++) {
              let p = col;
              for (let r = col + 1; r < 4; r++) if (Math.abs(A[r][col]) > Math.abs(A[p][col])) p = r;
              if (Math.abs(A[p][col]) < 1e-12) ok = false;
              else {
                [A[col], A[p]] = [A[p], A[col]];
                for (let r = 0; r < 4; r++)
                  if (r !== col) {
                    const fct = A[r][col] / A[col][col];
                    for (let k = col; k < 5; k++) A[r][k] -= fct * A[col][k];
                  }
              }
            }
            if (!ok) continue;
            const t: [number, number, number] = [A[0][4] / A[0][0], A[1][4] / A[1][1], A[2][4] / A[2][2]];
            const z = zAt(t);
            if (z < bz) {
              bz = z;
              best = t;
            }
          }
    return best;
  }
  // larger containers: projected subgradient descent on z(t), a convex piecewise-linear function
  let t = [0, 0, 0];
  let step = 0.05 * Math.max(...S.map((x, f) => Math.abs(x) / b[f]));
  for (let it = 0; it < 400 && step > 1e-15; it++) {
    let fm = 0;
    let zm = -Infinity;
    for (let f = 0; f < F; f++) {
      const nf = N(f);
      const z = (S[f] + nf[0] * t[0] + nf[1] * t[1] + nf[2] * t[2]) / b[f];
      if (z > zm) {
        zm = z;
        fm = f;
      }
    }
    const nf = N(fm);
    const cand = [t[0] - (step * nf[0]) / b[fm], t[1] - (step * nf[1]) / b[fm], t[2] - (step * nf[2]) / b[fm]];
    if (zAt(cand) < zm) t = cand;
    else step *= 0.7;
  }
  return zAt(t) < bz ? (t as [number, number, number]) : best;
}

/** Smallest separation over pairs whose circumscribed balls meet (stops each pair at `enough`). */
function minSeparation(Pc: Solid, poses: Pose[], enough: number): number {
  const placed = poses.map((p) => place(Pc, p));
  const reach = 2 * Pc.circumradius + Math.max(enough, 0) + 1e-9;
  let m = Infinity;
  for (let i = 0; i < poses.length; i++)
    for (let j = i + 1; j < poses.length; j++) {
      const a = placed[i].c;
      const b = placed[j].c;
      if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 > reach * reach) continue;
      m = Math.min(m, separation(placed[i], placed[j], enough).sep);
    }
  return m;
}

/**
 * A valid configuration near the given one: pairs separated by at least g, walls at least w, container
 * translated to its best position (see the file comment). The pieces' orientations are kept.
 */
export function legalizeConfig(problem: PolyhedraProblem, config: PolyhedraConfig, g = 1e-12, w = 1e-12): PolyhedraConfig {
  const Pc = getSolid(problem.piece);
  const Cc = getSolid(problem.container);
  let poses = config.pieces.map(normalised);
  // scaling about the origin cannot separate pieces whose centres coincide: move every such duplicate away
  // first, deterministically, by a little more than twice a piece's circumradius (along a spiral)
  const close = (a: Pose, b: Pose) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9 * (1 + Math.hypot(a[0], a[1], a[2]));
  poses = poses.map((p, i) => {
    if (!poses.some((q, j) => j < i && close(p, q))) return p;
    const t = i + 1;
    const r = 2.2 * Pc.circumradius * Math.cbrt(t);
    const phi = Math.acos(1 - 2 * ((t * 0.6180339887498949) % 1));
    const th = 2.399963229728653 * t;
    return [p[0] + r * Math.sin(phi) * Math.cos(th), p[1] + r * Math.sin(phi) * Math.sin(th), p[2] + r * Math.cos(phi), p[3], p[4], p[5], p[6]];
  });
  // move apart until every pair has its clearance (float rounding may leave a pair a hair short)
  let extra = 0;
  for (let round = 0; round < 60; round++) {
    const sep = minSeparation(Pc, poses, g);
    if (sep >= g) break;
    const delta = (g - sep) / (2 * Pc.inradius) + extra + 1e-15;
    poses = poses.map((p) => [p[0] * (1 + delta), p[1] * (1 + delta), p[2] * (1 + delta), p[3], p[4], p[5], p[6]]);
    extra = extra ? 2 * extra : 1e-14;
  }
  // translate to the best position and take the smallest scale with wall clearance w
  const F = Cc.offsets.length;
  const S = new Array(F).fill(-Infinity);
  const placed = poses.map((p) => place(Pc, p));
  for (const pl of placed)
    for (let f = 0; f < F; f++) {
      const nx = Cc.N[3 * f];
      const ny = Cc.N[3 * f + 1];
      const nz = Cc.N[3 * f + 2];
      for (let k = 0; k < pl.X.length; k += 3) S[f] = Math.max(S[f], nx * pl.X[k] + ny * pl.X[k + 1] + nz * pl.X[k + 2]);
    }
  const t = bestTranslation(Cc, S);
  poses = poses.map((p) => [p[0] + t[0], p[1] + t[1], p[2] + t[2], p[3], p[4], p[5], p[6]]);
  let s = 0;
  for (const p of poses) {
    const X = place(Pc, p).X;
    for (let f = 0; f < F; f++) {
      const nx = Cc.N[3 * f];
      const ny = Cc.N[3 * f + 1];
      const nz = Cc.N[3 * f + 2];
      for (let k = 0; k < X.length; k += 3) s = Math.max(s, (nx * X[k] + ny * X[k + 1] + nz * X[k + 2] + w) / Cc.offsets[f]);
    }
  }
  // one ulp-scale margin against the rounding of s * b_f in a check
  s *= 1 + 4 * Number.EPSILON;
  return { s, pieces: poses };
}
