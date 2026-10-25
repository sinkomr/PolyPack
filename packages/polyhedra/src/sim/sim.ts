/**
 * Ported from upstream's src/sim.js (alejandrozu/platonic-packing, commit cbf76f2f; MIT, Copyright (c) 2026
 * Yohei Nakajima and Copyright (c) 2026 Alejandro Zarzuelo; see THIRD_PARTY_NOTICES.md). Upstream's header:
 *
 *   Soft->rigid packer for unit copies of any Platonic solid in a container that is a scaled copy of any Platonic
 *   solid (default: the same solid). Generalizes Yohei Nakajima's sim3.js (rounded cubes) to convex polytopes.
 *
 *   Shape at softness r (internal units: the piece's inradius is 1/2):   S_r = (1 - 2r) P  (+)  B(r).
 *     r = 1/2 -> the inscribed ball;   r = 0 -> the solid P;   S_r is contained in P for every r (README, Lemma 1).
 *   Energy: sum_pairs (2r - sd_core)_+^2 + sum_walls (violation)_+^2 + mu * L, where L/2 is the container's inradius.
 *   Orientation = quaternion, analytic gradients (src/geom.js), heavy-ball descent with velocity cap and annealed
 *   noise.
 *
 * Changes in the port:
 *  - every solid is softened as S_r = (1 - 2r) P (+) B(r), with P scaled so that its inradius (the smallest face
 *    distance from the centre) is 1/2. Upstream uses this for solids with an insphere and the r-rounding
 *    (P (-) B(r)) (+) B(r) for the others. The scaled form is also inside P for every solid: its support in a
 *    direction u is (1 - 2r) h_P(u) + r <= h_P(u) because h_P(u) >= 1/2 (P contains the ball of radius 1/2 about its
 *    centre), and it grows as r decreases. [CALC] Its soft phase is less tight for solids without an insphere;
 *  - a step counter and an optional `tick` callback (polled every step) so that runs are budgeted and stoppable;
 *  - no frame recording, symmetric seeding or squeeze (not used here).
 */
import { type Shape, type SimPose, dot, cross, overlaps, pose, prepShape, rotq, sdCores, sdLastAxis, GR } from "./geom";
import { getSolid } from "../solids";

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export interface SimProblem {
  P: Shape;
  C: Shape;
  off: number[];
  rhoC: number;
  sOfL: (L: number) => number;
  LofS: (s: number) => number;
}

/**
 * Problem: piece solid P (inradius 1/2) and container solid C at the same scale; the container of "size" L is
 * { x : N_f . x <= (L/2) off_f } (centred at the origin), and its scale is s = L / (2 rho_C).
 */
export function makeProblem(piece: string, container: string): SimProblem {
  const P = prepShape(getSolid(piece));
  const C = prepShape(getSolid(container), P.edge);
  const rhoC = Math.min(...C.beta);
  return { P, C, off: C.beta.map((b) => b / rhoC), rhoC, sOfL: (L) => L / (2 * rhoC), LofS: (s) => 2 * rhoC * s };
}

export interface SimState {
  pb: SimProblem;
  n: number;
  rng: () => number;
  L: number;
  vL: number;
  r: number;
  step: number;
  C: number[][];
  Q: number[][];
  V: number[][];
  W: number[][];
  hints: Map<number, ReturnType<typeof sdLastAxis>>;
  mask?: number[] | null;
  /** Called once per step; may throw to end the run. */
  tick?: () => void;
}

export function makeState(pb: SimProblem, n: number, seed: number, L0: number): SimState {
  const rng = mulberry32(seed * 7919 + 13);
  const st: SimState = { pb, n, rng, L: L0, vL: 0, r: 0.5, step: 0, C: [], Q: [], V: [], W: [], hints: new Map() };
  const Rc = ((L0 / 2) * Math.max(...pb.C.V.map((v) => Math.hypot(...v)))) / pb.rhoC;
  for (let i = 0; i < n; i++) {
    let p: number[];
    for (let tries = 0; ; tries++) {
      // uniform in the container shrunk by 0.7
      p = [(2 * rng() - 1) * Rc, (2 * rng() - 1) * Rc, (2 * rng() - 1) * Rc];
      if (pb.C.N.every((N, f) => dot(N, p) <= (L0 / 2) * pb.off[f] - 0.7)) break;
      if (tries > 100000) throw new Error("cannot place initial centre");
    }
    st.C.push(p);
    const q = [gauss(rng), gauss(rng), gauss(rng), gauss(rng)];
    const m = Math.hypot(...q);
    st.Q.push(q.map((v) => v / m));
    st.V.push([0, 0, 0]);
    st.W.push([0, 0, 0]);
  }
  return st;
}

/** One heavy-ball step at softness r0 with pressure mu and noise; moveL lets the container size move. */
export function dyn(st: SimState, r0: number, mu: number, noise: number, moveL: boolean): void {
  st.tick?.();
  const { pb, n } = st;
  const P = pb.P;
  const k = 1 - 2 * r0;
  const r = r0;
  const beta = 0.85;
  const cap = 0.03;
  const lr = 0.04;
  const poses: SimPose[] = st.C.map((c, i) => pose(P, c, st.Q[i], k));
  const GC = st.C.map(() => [0, 0, 0]);
  const GW = st.C.map(() => [0, 0, 0]);
  const lim = (2 * (k * P.circ + r) + 1e-3) ** 2;
  const H = st.hints;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = st.C[i];
      const b = st.C[j];
      if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 > lim) continue;
      const key = i * n + j;
      const sd = sdCores(poses[i], poses[j], 2 * r, true, H.get(key));
      const ax = sdLastAxis();
      if (ax) H.set(key, ax);
      else H.delete(key);
      const o = 2 * r - sd;
      if (o <= 0) continue;
      const c = -2 * o;
      for (let t = 0; t < 3; t++) {
        GC[i][t] += c * GR[t];
        GW[i][t] += c * GR[3 + t];
        GC[j][t] += c * GR[6 + t];
        GW[j][t] += c * GR[9 + t];
      }
    }
  let gL = mu;
  const Cn = pb.C.N;
  const nv = P.nv;
  for (let i = 0; i < n; i++) {
    const X = poses[i].X;
    const c = st.C[i];
    for (let f = 0; f < Cn.length; f++) {
      const N = Cn[f];
      let m = -Infinity;
      let im = 0;
      for (let v = 0; v < nv; v++) {
        const p = X[3 * v] * N[0] + X[3 * v + 1] * N[1] + X[3 * v + 2] * N[2];
        if (p > m) {
          m = p;
          im = v;
        }
      }
      const q = m + r - (st.L / 2) * pb.off[f];
      if (q <= 0) continue;
      const lev = [X[3 * im] - c[0], X[3 * im + 1] - c[1], X[3 * im + 2] - c[2]];
      const tq = cross(lev, N);
      for (let t = 0; t < 3; t++) {
        GC[i][t] += 2 * q * N[t];
        GW[i][t] += 2 * q * tq[t];
      }
      if (moveL) gL -= 2 * q * pb.off[f];
    }
  }
  const ball = r0 >= 0.4999;
  for (let i = 0; i < n; i++) {
    const V = st.V[i];
    const W = st.W[i];
    for (let t = 0; t < 3; t++) {
      V[t] = beta * V[t] - lr * GC[i][t];
      W[t] = ball ? 0 : beta * W[t] - lr * GW[i][t];
    }
    const vm = Math.hypot(...V);
    if (vm > cap) for (let t = 0; t < 3; t++) V[t] *= cap / vm;
    const wm = Math.hypot(...W);
    if (wm > cap) for (let t = 0; t < 3; t++) W[t] *= cap / wm;
    const nz = st.mask ? noise * st.mask[i] : noise;
    for (let t = 0; t < 3; t++) st.C[i][t] += V[t] + (nz > 0 ? nz * gauss(st.rng) : 0);
    let wx = W[0];
    let wy = W[1];
    let wz = W[2];
    if (nz > 0 && !ball) {
      wx += 1.5 * nz * gauss(st.rng);
      wy += 1.5 * nz * gauss(st.rng);
      wz += 1.5 * nz * gauss(st.rng);
    }
    st.Q[i] = rotq(st.Q[i], wx, wy, wz);
  }
  if (moveL) {
    st.vL = beta * st.vL - 0.02 * gL;
    if (Math.abs(st.vL) > cap) st.vL = Math.sign(st.vL) * cap;
    st.L += st.vL;
  }
  st.r = r0;
  st.step++;
}

/**
 * Smallest container (any translation) holding all given world vertices: min z s.t. N_f.(x + t) <= z off_f.
 * Dual of  min z s.t. N_f.t - off_f z <= -S_f :  max sum_f S_f lam_f  s.t. sum_f lam_f N_f = 0, sum_f lam_f off_f = 1,
 * lam >= 0 (4 equality rows). Two-phase tableau simplex with Bland's rule; the optimal multipliers y of the 4 rows
 * give the primal solution t = -y[0..2]. Only used to choose t: the reported size is recomputed exactly at that t.
 */
export function lpTranslation(N: number[][], off: number[], S: number[]): number[] {
  const F = N.length;
  const m = 4;
  const nc = F + m;
  const eps = 1e-12;
  const T = [0, 1, 2, 3].map((i) => {
    const row = new Float64Array(nc + 1);
    for (let f = 0; f < F; f++) row[f] = i < 3 ? N[f][i] : off[f];
    row[F + i] = 1;
    row[nc] = i === 3 ? 1 : 0;
    return row;
  });
  const basis = [F, F + 1, F + 2, F + 3];
  const run = (cost: Float64Array, allowArt: boolean) => {
    const rc = new Float64Array(nc);
    for (let j = 0; j < nc; j++) {
      let v = cost[j];
      for (let i = 0; i < m; i++) v -= cost[basis[i]] * T[i][j];
      rc[j] = v;
    }
    for (let it = 0; it < 500; it++) {
      let e = -1;
      for (let j = 0; j < nc; j++)
        if (rc[j] > eps && (allowArt || j < F)) {
          e = j;
          break;
        }
      if (e < 0) return rc;
      let r = -1;
      let best = Infinity;
      for (let i = 0; i < m; i++)
        if (T[i][e] > eps) {
          const q = T[i][nc] / T[i][e];
          if (q < best - 1e-15 || (Math.abs(q - best) <= 1e-15 && r >= 0 && basis[i] < basis[r])) {
            best = q;
            r = i;
          }
        }
      if (r < 0) return rc;
      const pv = T[r][e];
      for (let j = 0; j <= nc; j++) T[r][j] /= pv;
      for (let i = 0; i < m; i++)
        if (i !== r && T[i][e] !== 0) {
          const f = T[i][e];
          for (let j = 0; j <= nc; j++) T[i][j] -= f * T[r][j];
        }
      const f = rc[e];
      for (let j = 0; j < nc; j++) rc[j] -= f * T[r][j];
      basis[r] = e;
    }
    return rc;
  };
  const c1 = new Float64Array(nc);
  for (let j = F; j < nc; j++) c1[j] = -1;
  run(c1, true);
  const c2 = new Float64Array(nc);
  for (let f = 0; f < F; f++) c2[f] = S[f];
  const rc = run(c2, false);
  return [rc[F], rc[F + 1], rc[F + 2]];
}

/** The tight container size L over translations t of the given world vertex sets, and t. */
export function tightContainer(pb: SimProblem, Xs: Float64Array[]): { L: number; t: number[] } {
  const N = pb.C.N;
  const F = N.length;
  const off = pb.off;
  const S = N.map((u) => {
    let m = -Infinity;
    for (const X of Xs) for (let v = 0; v < X.length; v += 3) m = Math.max(m, X[v] * u[0] + X[v + 1] * u[1] + X[v + 2] * u[2]);
    return m;
  });
  const zAt = (t: number[]) => {
    let z = -Infinity;
    for (let f = 0; f < F; f++) z = Math.max(z, (S[f] + dot(N[f], t)) / off[f]);
    return z;
  };
  if (F > 14) {
    const t = lpTranslation(N, off, S);
    const tn = t.map((x) => -x);
    const z1 = zAt(t);
    const z2 = zAt(tn);
    const z0 = zAt([0, 0, 0]);
    const tb = z1 <= z2 && z1 <= z0 ? t : z2 <= z0 ? tn : [0, 0, 0];
    return { L: 2 * Math.min(z0, z1, z2), t: tb };
  }
  let best: { z: number; t: number[] } | null = null;
  const solve4 = (M: number[][], b: number[]) => {
    const A = M.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 4; c++) {
      let p = c;
      for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < 4; r++)
        if (r !== c) {
          const f = A[r][c] / A[c][c];
          for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k];
        }
    }
    return A.map((row, i) => row[4] / row[i]);
  };
  for (let a = 0; a < F; a++)
    for (let b = a + 1; b < F; b++)
      for (let c = b + 1; c < F; c++)
        for (let d = c + 1; d < F; d++) {
          const idx = [a, b, c, d];
          const sol = solve4(
            idx.map((f) => [N[f][0], N[f][1], N[f][2], -off[f]]),
            idx.map((f) => -S[f]),
          );
          if (!sol) continue;
          const [t0, t1, t2, z] = sol;
          let ok = true;
          for (let f = 0; f < F; f++)
            if (S[f] + N[f][0] * t0 + N[f][1] * t1 + N[f][2] * t2 > z * off[f] + 1e-9 * (1 + Math.abs(z))) {
              ok = false;
              break;
            }
          if (ok && (best === null || z < best.z)) best = { z, t: [t0, t1, t2] };
        }
  const t = best ? best.t : [0, 0, 0];
  return { L: 2 * zAt(t), t };
}

/**
 * Legalization: scale centres apart about their mean until no pair of rigid pieces overlaps (SAT, tol 1e-12),
 * then measure the tight container.
 */
export function legalize(pb: SimProblem, C: number[][], Q: number[][]): { L: number; s: number; k: number; C: number[][]; Q: number[][] } {
  const n = C.length;
  const P = pb.P;
  const cen = [0, 1, 2].map((t) => C.reduce((a, c) => a + c[t], 0) / n);
  const pos = (s: number) => C.map((c) => [cen[0] + s * (c[0] - cen[0]), cen[1] + s * (c[1] - cen[1]), cen[2] + s * (c[2] - cen[2])]);
  const lim = (2 * P.circ) ** 2;
  const ok = (s: number) => {
    const Pp = pos(s);
    const ps = Pp.map((c, i) => pose(P, c, Q[i], 1));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = Pp[i];
        const b = Pp[j];
        if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 > lim) continue;
        if (overlaps(ps[i], ps[j], 1e-12)) return false;
      }
    return true;
  };
  let lo = 1;
  let hi = 1;
  if (!ok(1)) {
    hi = 1.0001;
    while (!ok(hi)) hi = 1 + (hi - 1) * 2;
    for (let it = 0; it < 60; it++) {
      const m = (lo + hi) / 2;
      if (ok(m)) hi = m;
      else lo = m;
    }
  }
  const Pp = pos(hi);
  const tc = tightContainer(
    pb,
    Pp.map((c, i) => pose(P, c, Q[i], 1).X),
  );
  return {
    L: tc.L,
    s: pb.sOfL(tc.L),
    k: hi,
    C: Pp.map((p) => [p[0] + tc.t[0], p[1] + tc.t[1], p[2] + tc.t[2]]),
    Q: Q.map((q) => q.slice()),
  };
}

/** Initial container: balls (diameter 1) at packing fraction about 0.07, centres at least 0.7 inside every wall. */
export function defaultL0(pb: SimProblem, n: number): number {
  const volAtL = (L: number) => pb.C.volume * Math.pow(pb.sOfL(L), 3);
  const vp = Math.PI / 6;
  let L = 2;
  while ((n * vp) / volAtL(L) > 0.07) L *= 1.02;
  return Math.max(L, 2 * (0.7 + 0.35));
}

export interface RunConfig {
  seed: number;
  n: number;
  piece: string;
  container: string;
  L0?: number;
  compact?: number;
  morph?: number;
  settle?: number;
  mu?: number;
  anneal?: boolean;
  tick?: () => void;
}

/** A run from random balls: compress, morph balls into solids, settle rigid, legalize (sim.js run, mode "improved"). */
export function run(cfg: RunConfig) {
  const c = { compact: 5000, morph: 45000, settle: 3000, mu: 0.02, anneal: true, ...cfg };
  const pb = makeProblem(c.piece, c.container);
  const L0 = c.L0 || defaultL0(pb, c.n);
  const st = makeState(pb, c.n, c.seed, L0);
  st.tick = c.tick;
  const r0 = 0.5;
  for (let k = 0; k < c.compact; k++) {
    const u = k / c.compact;
    dyn(st, r0, c.mu * 3, (c.anneal ? 0.015 : 0.008) * (1 - u), true);
  }
  for (let k = 0; k < c.morph; k++) {
    const u = k / c.morph;
    dyn(st, r0 * (1 - u), c.mu, c.anneal ? 0.004 * (1 - u) : 0, true);
  }
  for (let k = 0; k < c.settle; k++) dyn(st, 0, c.mu * Math.pow(1e-4, k / c.settle), 0, true);
  const leg = legalize(pb, st.C, st.Q);
  return { s: leg.s, L: leg.L, final: leg, edge: pb.P.edge, steps: st.step };
}

/**
 * Relative-arrangement change between two states of the same pieces: RMS change of the centre distances of all
 * pairs that were neighbours (distance < 2 x circumradius) in either state, in units of the piece edge.
 */
export function arrangementChange(pb: SimProblem, C0: number[][], C1: number[][], scale1: number, focus: boolean[] | null): number {
  const n = C0.length;
  const R2 = (2 * pb.P.circ) ** 2;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (focus && !focus[i] && !focus[j]) continue;
      const d0 = (C0[i][0] - C0[j][0]) ** 2 + (C0[i][1] - C0[j][1]) ** 2 + (C0[i][2] - C0[j][2]) ** 2;
      const d1 = ((C1[i][0] - C1[j][0]) ** 2 + (C1[i][1] - C1[j][1]) ** 2 + (C1[i][2] - C1[j][2]) ** 2) * scale1 * scale1;
      if (d0 > R2 && d1 > R2) continue;
      sum += (Math.sqrt(d1) - Math.sqrt(d0)) ** 2;
      cnt++;
    }
  return cnt ? Math.sqrt(sum / cnt) / pb.P.edge : 0;
}

/** Best hole: among random points of the container (kept 0.5 inside every wall), the one farthest from all centres. */
export function bestHole(pb: SimProblem, C: number[][], L: number, rng: () => number, tries: number): number[] {
  const Rc = ((L / 2) * Math.max(...pb.C.V.map((v) => Math.hypot(...v)))) / pb.rhoC;
  let best: number[] | null = null;
  let bd = -1;
  for (let t = 0; t < tries; t++) {
    const p = [(2 * rng() - 1) * Rc, (2 * rng() - 1) * Rc, (2 * rng() - 1) * Rc];
    if (!pb.C.N.every((N, f) => dot(N, p) <= (L / 2) * pb.off[f] - 0.5)) continue;
    let m = Infinity;
    for (const c of C) m = Math.min(m, (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2);
    if (m > bd) {
      bd = m;
      best = p;
    }
  }
  return best || [0, 0, 0];
}

export interface HopConfig {
  piece: string;
  container: string;
  /** Rigid packing in internal units, container centred at the origin, of size L. */
  C: number[][];
  Q: number[][];
  L: number;
  seed: number;
  expand?: number;
  rh?: number;
  noise?: number;
  shake?: number;
  morph?: number;
  settle?: number;
  mu?: number;
  minDiff?: number;
  maxEsc?: number;
  add?: number;
  remove?: number[];
  focus?: number;
  tick?: () => void;
}

/**
 * One hop from a rigid packing (C, Q, L), in internal units with the container centred at the origin:
 *  1. remove the pieces listed in `remove`, scale everything by (1 + expand) (and by ((n+add)/n)^(1/3) when
 *     adding), put `add` new pieces into the largest holes;
 *  2. soften the pieces to S_rh and shake them at fixed container size with noise until the relative arrangement
 *     has changed by at least minDiff piece edges (escalating the noise and the softness each block), or maxEsc
 *     blocks;
 *  3. re-sharpen under pressure (r: rh -> 0 over `morph` steps), settle rigid pieces, legalize.
 */
export function hop(cfg: HopConfig) {
  const c = {
    expand: 0.03,
    rh: 0.12,
    noise: 0.004,
    shake: 400,
    morph: 6000,
    settle: 1500,
    mu: 0.02,
    minDiff: 0.15,
    maxEsc: 8,
    add: 0,
    remove: [] as number[],
    focus: 0,
    ...cfg,
  };
  const pb = makeProblem(c.piece, c.container);
  const rng = mulberry32((c.seed * 7919 + 17) | 0);
  const keep = c.C.map((_, i) => i).filter((i) => !c.remove.includes(i));
  let C = keep.map((i) => c.C[i].slice());
  const Q = keep.map((i) => c.Q[i].slice());
  const n0 = C.length;
  const add = c.add | 0;
  const f = (1 + c.expand) * (add ? Math.cbrt((n0 + add) / n0) : 1);
  C = C.map((p) => p.map((x) => x * f));
  const L = c.L * f;
  const ref = C.map((p) => p.slice());
  for (let a = 0; a < add; a++) {
    C.push(bestHole(pb, C, L, rng, 4000));
    const q = [gauss(rng), gauss(rng), gauss(rng), gauss(rng)];
    const m = Math.hypot(...q);
    Q.push(q.map((v) => v / m));
  }
  const n = C.length;
  const st: SimState = {
    pb,
    n,
    rng,
    L,
    vL: 0,
    r: c.rh,
    step: 0,
    C,
    Q,
    V: C.map(() => [0, 0, 0]),
    W: C.map(() => [0, 0, 0]),
    hints: new Map(),
    tick: c.tick,
  };
  let focusSet: boolean[] | null = null;
  if (c.focus && c.focus < ref.length) {
    const i0 = Math.floor(rng() * ref.length);
    const order = ref
      .map((p, i) => [(p[0] - ref[i0][0]) ** 2 + (p[1] - ref[i0][1]) ** 2 + (p[2] - ref[i0][2]) ** 2, i])
      .sort((a, b) => a[0] - b[0]);
    focusSet = new Array(n).fill(false);
    for (let t = 0; t < c.focus; t++) focusSet[order[t][1]] = true;
    for (let i = ref.length; i < n; i++) focusSet[i] = true;
    st.mask = focusSet.map((x) => (x ? 1 : 0.15));
  }
  let noise = c.noise;
  let rh = c.rh;
  let esc = 0;
  let diff = 0;
  const structural = add > 0 || c.remove.length > 0;
  for (;;) {
    for (let k = 0; k < c.shake; k++) dyn(st, rh, 0, noise, false);
    diff = arrangementChange(pb, ref, st.C.slice(0, ref.length), 1, focusSet);
    if (structural || diff >= c.minDiff || esc >= c.maxEsc) break;
    esc++;
    noise *= 1.5;
    rh = Math.min(0.4, rh * 1.3);
  }
  const noise0 = noise * 0.25;
  for (let k = 0; k < c.morph; k++) {
    const u = k / c.morph;
    dyn(st, rh * (1 - u), c.mu, noise0 * (1 - u), true);
  }
  for (let k = 0; k < c.settle; k++) dyn(st, 0, c.mu * Math.pow(1e-4, k / c.settle), 0, true);
  const leg = legalize(pb, st.C, st.Q);
  st.mask = null;
  return { n, s: leg.s, L: leg.L, C: leg.C, Q: leg.Q, diff, esc, rh, noise, steps: st.step, edge: pb.P.edge };
}
