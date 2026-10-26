import { boundingRadius } from "@polypack/geometry";
import { SurfacePose } from "../parts";
import { Solid } from "../solids";
import { PolygonEnergy, canonicalize, diskEnergy, diskEnergyNofold } from "./energy";

/**
 * Local optimisation for the fold search, on the solid of edge s = 1 with pieces scaled by lam
 * (a similarity of the unit-piece problem on the solid of edge 1/lam).
 *
 * relax: L-BFGS on the overlap energy at fixed lam (analytic gradient for disks, central finite
 * differences of each piece's local energy for polygons). Variables are each centre in its anchor
 * face's frame and, for polygons, theta times the piece's circumradius (so that all variables are
 * lengths). A centre that leaves its face is re-anchored in the neighbour (canonicalize); the
 * stored L-BFGS vectors of that piece are rotated into the new chart.
 * relaxSize: the same with lam as a variable, minimising -lam + mu E (penalty continuation).
 * compress (disks): grow lam geometrically while relax reaches zero energy; shrink the growth on
 * failure. compressPenalty (polygons): relaxSize for increasing mu, then back off and bisect
 * (refine) to the largest lam that relaxes to zero energy. Final polish: slp.ts.
 */

export interface RelaxResult {
  energy: number;
  iterations: number;
}

export class Packing {
  readonly solid: Solid;
  readonly N: number;
  /** "fold" (default) or "nofold": every piece kept inside its own face (energy.ts) */
  readonly mode: "fold" | "nofold";
  lam: number;
  poses: SurfacePose[];
  private poly: PolygonEnergy | null;
  /** polygon energy evaluations (piece-local), for budgets */
  evals = 0;

  constructor(solid: Solid, N: number, lam: number, poses: SurfacePose[], mode: "fold" | "nofold" = "fold") {
    this.solid = solid;
    this.N = N;
    this.mode = mode;
    this.lam = lam;
    this.poses = poses.map((p) => canonicalize(solid, 1, p));
    this.poly = N === 0 ? null : new PolygonEnergy(solid, 1, N, lam, this.poses, mode);
  }

  /** The disk energy of the mode at scale lam (and its gradient). */
  private disks(lam: number, grad?: Float64Array): number {
    return this.mode === "nofold"
      ? diskEnergyNofold(this.solid, 1, lam, this.poses, grad)
      : diskEnergy(this.solid, 1, lam, this.poses, grad);
  }

  setScale(lam: number): void {
    this.lam = lam;
    if (this.poly) this.poly.setScale(lam);
  }

  setPoses(poses: SurfacePose[]): void {
    this.poses = poses.map((p) => ({ ...p }));
    if (this.poly) {
      this.poly.poses = this.poses.map((p) => ({ ...p }));
      this.poly.rebuild();
    }
  }

  energy(): number {
    if (this.poly) return this.poly.total();
    return this.disks(this.lam);
  }

  private get dim(): number {
    return this.N === 0 ? 2 : 3;
  }

  private thetaScale(): number {
    return this.N === 0 ? 1 : boundingRadius(this.N) * this.lam;
  }

  /** Gradient in the variables (x, y[, theta * R lam]) at the current poses. */
  private gradient(g: Float64Array): number {
    const P = this.poses.length;
    if (!this.poly) return this.disks(this.lam, g);
    const E = this.poly;
    const h = 1e-7 * this.lam;
    const ts = this.thetaScale();
    for (let i = 0; i < P; i++) {
      const p = this.poses[i];
      const e0 = E.localEnergy(i, p);
      this.evals++;
      for (let c = 0; c < 3; c++) {
        const plus = { ...p };
        const minus = { ...p };
        if (c === 0) {
          plus.x += h;
          minus.x -= h;
        } else if (c === 1) {
          plus.y += h;
          minus.y -= h;
        } else {
          plus.theta += h / ts;
          minus.theta -= h / ts;
        }
        const ep = E.localEnergy(i, canonicalize(this.solid, 1, plus));
        const em = E.localEnergy(i, canonicalize(this.solid, 1, minus));
        // The energy jumps where a chain appears or vanishes around a cone point that lies inside
        // a piece. Across such a jump the one-sided differences disagree; take the smaller one.
        const fwd = (ep - e0) / h;
        const bwd = (e0 - em) / h;
        g[3 * i + c] = Math.abs(fwd - bwd) > 0.5 * (Math.abs(fwd) + Math.abs(bwd)) + 1e-9 ? (Math.abs(fwd) < Math.abs(bwd) ? fwd : bwd) : (ep - em) / (2 * h);
        this.evals += 2;
      }
    }
    return E.total();
  }

  /**
   * Apply a step in the variables; returns true when some piece changed face. For such pieces
   * `lastTurn[i]` is the rotation from the old chart to the new one (tangent vectors turn by it).
   */
  lastTurn: number[] = [];
  private step(base: SurfacePose[], d: Float64Array, t: number): boolean {
    const ts = this.thetaScale();
    const dim = this.dim;
    let moved = false;
    this.lastTurn = base.map(() => 0);
    this.poses = base.map((p, i) => {
      const th = dim === 3 ? p.theta + (t * d[dim * i + 2]) / ts : p.theta;
      const q = { ...p, x: p.x + t * d[dim * i], y: p.y + t * d[dim * i + 1], theta: th };
      const c = canonicalize(this.solid, 1, q);
      if (c.face !== p.face) {
        moved = true;
        this.lastTurn[i] = c.theta - q.theta;
      }
      return c;
    });
    if (this.poly) {
      this.poly.poses = this.poses.map((p) => ({ ...p }));
      this.poly.rebuild();
    }
    return moved;
  }

  relax(maxIter = 300, tolE = 1e-26, maxStep = 0.05, shouldStop?: () => boolean): RelaxResult {
    const P = this.poses.length;
    const n = this.dim * P;
    const m = 8;
    const S: Float64Array[] = [];
    const Y: Float64Array[] = [];
    const rho: number[] = [];
    let g = new Float64Array(n);
    let E = this.gradient(g);
    let it = 0;
    const lenScale = maxStep * this.lam;
    for (; it < maxIter && E > tolE; it++) {
      if (shouldStop && shouldStop()) break;
      // two-loop recursion
      const q = Float64Array.from(g, (v) => -v);
      const alpha: number[] = [];
      for (let k = S.length - 1; k >= 0; k--) {
        let a = 0;
        for (let t = 0; t < n; t++) a += S[k][t] * q[t];
        a *= rho[k];
        alpha[k] = a;
        for (let t = 0; t < n; t++) q[t] -= a * Y[k][t];
      }
      if (S.length) {
        const k = S.length - 1;
        let sy = 0;
        let yy = 0;
        for (let t = 0; t < n; t++) {
          sy += S[k][t] * Y[k][t];
          yy += Y[k][t] * Y[k][t];
        }
        const gamma = sy / yy;
        for (let t = 0; t < n; t++) q[t] *= gamma;
      } else {
        // first step: scale so that the largest move is lenScale / 10
        let mx = 0;
        for (let t = 0; t < n; t++) mx = Math.max(mx, Math.abs(q[t]));
        if (mx > 0) for (let t = 0; t < n; t++) q[t] *= lenScale / 10 / mx;
      }
      for (let k = 0; k < S.length; k++) {
        let b = 0;
        for (let t = 0; t < n; t++) b += Y[k][t] * q[t];
        b *= rho[k];
        for (let t = 0; t < n; t++) q[t] += S[k][t] * (alpha[k] - b);
      }
      let gd = 0;
      for (let t = 0; t < n; t++) gd += g[t] * q[t];
      if (!(gd < 0)) {
        // not a descent direction: restart from steepest descent
        S.length = Y.length = rho.length = 0;
        let mx = 0;
        for (let t = 0; t < n; t++) mx = Math.max(mx, Math.abs(g[t]));
        if (mx === 0) break;
        for (let t = 0; t < n; t++) q[t] = (-g[t] * lenScale) / 10 / mx;
        gd = 0;
        for (let t = 0; t < n; t++) gd += g[t] * q[t];
      }
      // cap the largest single move
      let mx = 0;
      for (let t = 0; t < n; t++) mx = Math.max(mx, Math.abs(q[t]));
      let tstep = mx > lenScale ? lenScale / mx : 1;
      const base = this.poses.map((p) => ({ ...p }));
      let accepted = false;
      let moved = false;
      let Enew = E;
      for (let ls = 0; ls < 30; ls++) {
        moved = this.step(base, q, tstep);
        Enew = this.energy();
        if (Enew <= E + 1e-4 * tstep * gd) {
          accepted = true;
          break;
        }
        tstep *= 0.5;
      }
      if (!accepted) {
        this.setPoses(base);
        if (S.length === 0) break;
        S.length = Y.length = rho.length = 0;
        continue;
      }
      const gnew = new Float64Array(n);
      E = this.gradient(gnew);
      {
        if (moved) {
          this.turnMemory(S);
          this.turnMemory(Y);
          this.turnMemory([g, q]);
        }
        const sv = Float64Array.from(q, (v) => v * tstep);
        const yv = Float64Array.from(gnew, (v, t) => v - g[t]);
        let sy = 0;
        for (let t = 0; t < n; t++) sy += sv[t] * yv[t];
        if (sy > 1e-30) {
          S.push(sv);
          Y.push(yv);
          rho.push(1 / sy);
          if (S.length > m) {
            S.shift();
            Y.shift();
            rho.shift();
          }
        }
      }
      g = gnew;
      if (Math.abs(Enew - E) < 1e-30 && tstep * mx < 1e-15) break;
    }
    return { energy: E, iterations: it };
  }

  /** dE/dlam (analytic for disks, central difference for polygons). */
  private energyScaleDerivative(): number {
    const lam = this.lam;
    const h = 1e-7 * lam;
    if (!this.poly) {
      const up = this.disks(lam + h);
      const dn = this.disks(lam - h);
      return (up - dn) / (2 * h);
    }
    this.poly.setScale(lam + h);
    const up = this.poly.total();
    this.poly.setScale(lam - h);
    const dn = this.poly.total();
    this.poly.setScale(lam);
    return (up - dn) / (2 * h);
  }

  /**
   * Penalty relaxation with the piece scale as a variable: minimise f = -lam + mu * E(poses, lam).
   * The scale variable is lam / lamRef so that its steps are comparable to centre moves.
   */
  relaxSize(mu: number, maxIter = 200, shouldStop?: () => boolean): { f: number; energy: number; iterations: number } {
    const P = this.poses.length;
    const dim = this.dim;
    const n = dim * P + 1;
    const m = 8;
    const S: Float64Array[] = [];
    const Y: Float64Array[] = [];
    const rho: number[] = [];
    const lamRef = this.lam;
    const evalGrad = (g: Float64Array): number => {
      const gp = new Float64Array(n - 1);
      const E = this.gradient(gp);
      for (let t = 0; t < n - 1; t++) g[t] = mu * gp[t];
      g[n - 1] = (-1 + mu * this.energyScaleDerivative()) * lamRef;
      return -this.lam + mu * E;
    };
    let g = new Float64Array(n);
    let f = evalGrad(g);
    let it = 0;
    for (; it < maxIter; it++) {
      if (shouldStop && shouldStop()) break;
      const q = Float64Array.from(g, (v) => -v);
      const alpha: number[] = [];
      for (let k = S.length - 1; k >= 0; k--) {
        let a = 0;
        for (let t = 0; t < n; t++) a += S[k][t] * q[t];
        a *= rho[k];
        alpha[k] = a;
        for (let t = 0; t < n; t++) q[t] -= a * Y[k][t];
      }
      if (S.length) {
        const k = S.length - 1;
        let sy = 0;
        let yy = 0;
        for (let t = 0; t < n; t++) {
          sy += S[k][t] * Y[k][t];
          yy += Y[k][t] * Y[k][t];
        }
        for (let t = 0; t < n; t++) q[t] *= sy / yy;
      } else {
        let mx = 0;
        for (let t = 0; t < n; t++) mx = Math.max(mx, Math.abs(q[t]));
        if (mx > 0) for (let t = 0; t < n; t++) q[t] *= (0.002 * this.lam) / mx;
      }
      for (let k = 0; k < S.length; k++) {
        let b = 0;
        for (let t = 0; t < n; t++) b += Y[k][t] * q[t];
        b *= rho[k];
        for (let t = 0; t < n; t++) q[t] += S[k][t] * (alpha[k] - b);
      }
      let gd = 0;
      for (let t = 0; t < n; t++) gd += g[t] * q[t];
      if (!(gd < 0)) {
        S.length = Y.length = rho.length = 0;
        let mx = 0;
        for (let t = 0; t < n; t++) mx = Math.max(mx, Math.abs(g[t]));
        if (mx === 0) break;
        for (let t = 0; t < n; t++) q[t] = (-g[t] * 0.002 * this.lam) / mx;
        gd = 0;
        for (let t = 0; t < n; t++) gd += g[t] * q[t];
      }
      let mx = 0;
      for (let t = 0; t < n; t++) mx = Math.max(mx, Math.abs(q[t]));
      const cap = 0.02 * this.lam;
      let tstep = mx > cap ? cap / mx : 1;
      const base = this.poses.map((p) => ({ ...p }));
      const lamBase = this.lam;
      let accepted = false;
      let moved = false;
      let fnew = f;
      for (let ls = 0; ls < 30; ls++) {
        this.setScaleQuiet(lamBase + tstep * q[n - 1] * lamRef);
        moved = this.step(base, q, tstep);
        fnew = -this.lam + mu * this.energy();
        if (fnew <= f + 1e-4 * tstep * gd) {
          accepted = true;
          break;
        }
        tstep *= 0.5;
      }
      if (!accepted) {
        this.setScaleQuiet(lamBase);
        this.setPoses(base);
        if (S.length === 0) break;
        S.length = Y.length = rho.length = 0;
        continue;
      }
      const gnew = new Float64Array(n);
      fnew = evalGrad(gnew);
      if (moved) {
        this.turnMemory(S);
        this.turnMemory(Y);
        this.turnMemory([g, q]);
      }
      {
        const sv = Float64Array.from(q, (v) => v * tstep);
        const yv = Float64Array.from(gnew, (v, t) => v - g[t]);
        let sy = 0;
        for (let t = 0; t < n; t++) sy += sv[t] * yv[t];
        if (sy > 1e-30) {
          S.push(sv);
          Y.push(yv);
          rho.push(1 / sy);
          if (S.length > m) {
            S.shift();
            Y.shift();
            rho.shift();
          }
        }
      }
      const df = f - fnew;
      f = fnew;
      g = gnew;
      if (df >= 0 && df < 1e-15 * Math.abs(f) && tstep * mx < 1e-13) break;
    }
    return { f, energy: (f + this.lam) / mu, iterations: it };
  }

  /** Express stored L-BFGS vectors in the new charts of pieces that changed face. */
  private turnMemory(vecs: Float64Array[]): void {
    const dim = this.dim;
    this.lastTurn.forEach((a, i) => {
      if (a === 0) return;
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (const v of vecs) {
        const x = v[dim * i];
        const y = v[dim * i + 1];
        v[dim * i] = c * x - s * y;
        v[dim * i + 1] = s * x + c * y;
      }
    });
  }

  /** Set the scale without rebuilding polygon caches (step() rebuilds them). */
  private setScaleQuiet(lam: number): void {
    this.lam = lam;
    if (this.poly) this.poly.lam = lam;
  }
}

export interface CompressOptions {
  feasTol?: number;
  maxIter?: number;
  growth0?: number;
  minGrowth?: number;
  shouldStop?: () => boolean;
}

/**
 * Grow lam while the packing can be relaxed to (near) zero energy. Starts at lam0 (shrinking
 * first if lam0 is infeasible). Returns the largest feasible lam reached, with its poses.
 */
/**
 * Penalty continuation with the scale as a variable, then the largest lam at which the poses
 * relax to (near) zero energy at fixed scale.
 */
export function compressPenalty(pk: Packing, lam0: number, opts: CompressOptions & { mus?: number[] } = {}): { lam: number; poses: SurfacePose[] } | null {
  const feasTol = opts.feasTol ?? 1e-18;
  pk.setScale(lam0);
  const r0 = pk.relax(200, feasTol, 0.05, opts.shouldStop);
  // a feasible start (a warm start may already be optimal and rigid) is never lost
  const start = r0.energy <= feasTol ? { lam: lam0, poses: pk.poses.map((p) => ({ ...p })) } : null;
  const keep = (r: { lam: number; poses: SurfacePose[] } | null) => {
    if (start && (!r || r.lam < start.lam)) {
      pk.setScale(start.lam);
      pk.setPoses(start.poses);
      return start;
    }
    return r;
  };
  for (const mu of opts.mus ?? [1e2, 1e3, 1e4, 1e5, 1e6, 1e8]) {
    if (opts.shouldStop && opts.shouldStop()) break;
    pk.relaxSize(mu, opts.maxIter ?? 150, opts.shouldStop);
  }
  // back off until a fixed-scale relaxation reaches zero energy, then bisect
  const top = pk.lam;
  const poses = pk.poses.map((p) => ({ ...p }));
  let hi = top;
  for (let k = 0; k < 30; k++) {
    const lam = top * (1 - 1e-7 * 2 ** k);
    pk.setScale(lam);
    pk.setPoses(poses);
    const r = pk.relax(300, feasTol, 0.01, opts.shouldStop);
    if (r.energy <= feasTol) return keep(refine(pk, lam, pk.poses.map((p) => ({ ...p })), hi, feasTol, opts.shouldStop));
    hi = lam;
  }
  return keep(null);
}

/**
 * Bisection between a feasible scale lo (with its poses) and a scale hi not reached, relaxing
 * from the last feasible poses each time, until hi / lo - 1 < 1e-11.
 */
export function refine(pk: Packing, lo: number, posesLo: SurfacePose[], hi: number, feasTol = 1e-18, shouldStop?: () => boolean): { lam: number; poses: SurfacePose[] } {
  let best = { lam: lo, poses: posesLo };
  for (let k = 0; k < 40 && hi / best.lam - 1 > 1e-11; k++) {
    if (shouldStop && shouldStop()) break;
    const mid = Math.sqrt(best.lam * hi);
    pk.setScale(mid);
    pk.setPoses(best.poses);
    const r = pk.relax(150, feasTol, 0.002, shouldStop);
    if (r.energy <= feasTol) best = { lam: mid, poses: pk.poses.map((p) => ({ ...p })) };
    else hi = mid;
  }
  pk.setScale(best.lam);
  pk.setPoses(best.poses);
  return best;
}

export function compress(pk: Packing, lam0: number, opts: CompressOptions = {}): { lam: number; poses: SurfacePose[] } | null {
  const feasTol = opts.feasTol ?? 1e-18;
  const maxIter = opts.maxIter ?? 200;
  let lam = lam0;
  pk.setScale(lam);
  let r = pk.relax(maxIter * 2, feasTol, 0.05, opts.shouldStop);
  let tries = 0;
  while (r.energy > feasTol && tries < 25) {
    lam *= 0.96;
    pk.setScale(lam);
    r = pk.relax(maxIter, feasTol, 0.05, opts.shouldStop);
    tries++;
  }
  if (r.energy > feasTol) return null;
  let best = { lam, poses: pk.poses.map((p) => ({ ...p })) };
  let growth = opts.growth0 ?? 0.02;
  const minGrowth = opts.minGrowth ?? 1e-11;
  while (growth > minGrowth) {
    if (opts.shouldStop && opts.shouldStop()) break;
    const trial = best.lam * (1 + growth);
    pk.setScale(trial);
    r = pk.relax(maxIter, feasTol, 0.02, opts.shouldStop);
    if (r.energy <= feasTol) {
      best = { lam: trial, poses: pk.poses.map((p) => ({ ...p })) };
      growth = Math.min(growth * 1.6, 0.03);
    } else {
      pk.setPoses(best.poses);
      growth *= 0.35;
    }
  }
  pk.setScale(best.lam);
  pk.setPoses(best.poses);
  return best;
}

/** Final tightening: relax hard at slightly smaller lam until the energy is ~0. */
export function finalize(pk: Packing, lam: number, poses: SurfacePose[]): { lam: number; poses: SurfacePose[]; energy: number } {
  let l = lam * (1 - 1e-10);
  for (let k = 0; k < 12; k++) {
    pk.setScale(l);
    pk.setPoses(poses);
    const r = pk.relax(3000, 1e-28, 0.002);
    if (r.energy <= 1e-26) return { lam: l, poses: pk.poses.map((p) => ({ ...p })), energy: r.energy };
    l *= 1 - 3e-10 * 3 ** k;
  }
  pk.setScale(l);
  return { lam: l, poses: pk.poses.map((p) => ({ ...p })), energy: pk.energy() };
}
