/**
 * Seeded global search for curved packings: random starts, penalty compression (L-BFGS on the
 * squared-overlap energy at a fixed container), SLP polish, and basin hopping by re-placing pieces.
 * Deterministic for a given seed and iteration budget (no wall-clock dependence unless a time limit is set).
 */
import { CurvedConfig, Space } from "./problem";
import { allStates, requiredT } from "./evaluate";
import { energy, posesFromVector, vectorFromPoses } from "./model";
import { gaussian, lbfgs, rng } from "./optim";
import { PolishResult, polish } from "./polish";
import { containerArea, sideFromApothem, containerCircumradius, apothemFromSide } from "./shapes";
import { snK } from "./kfun";

export interface SearchOptions {
  seed?: number;
  /** independent random starts */
  restarts?: number;
  /** basin-hopping moves per start */
  hops?: number;
  /** optional warm start */
  start?: CurvedConfig;
  /** optional wall-clock limit in ms (makes results depend on machine speed) */
  timeLimitMs?: number;
  log?: (msg: string) => void;
  /** L-BFGS iterations per energy minimisation */
  lbfgsIter?: number;
  /**
   * Optional external stop (for example a volunteer's Ctrl-C), polled inside every restart and hop:
   * before each L-BFGS iteration, compression step and polish iteration. True ends the search with
   * its best so far. Without it the search is unchanged.
   */
  shouldStop?: () => boolean;
}

export interface SearchResult {
  found: boolean;
  config?: CurvedConfig;
  t?: number;
  polish?: PolishResult;
  /** evaluated local optima: sizes found by each start (for diagnostics) */
  optima: number[];
  seed: number;
  restartsDone: number;
  hopsDone: number;
}

const FEAS = 1e-22;

/** Container variable whose container has area A (bisection), capped below tMax. */
export function tForArea(space: Space, A: number): number {
  const { M, K } = space;
  let lo = 0;
  let hi = Number.isFinite(space.tMax) ? space.tMax : 1;
  const areaOfT = (t: number) => containerArea(M, K, M === 0 ? t : sideFromApothem(M, K, t));
  if (!Number.isFinite(space.tMax)) {
    while (areaOfT(hi) < A && hi < 1e6) hi *= 2;
  } else if (areaOfT(hi * (1 - 1e-12)) < A) return Infinity;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (areaOfT(mid) < A) lo = mid;
    else hi = mid;
  }
  return hi;
}

function minimizeEnergy(
  space: Space,
  z: Float64Array,
  t: number,
  iters: number,
  stop?: () => boolean,
): { z: Float64Array; E: number } {
  const res = lbfgs((x, gr) => energy(space, x, t, gr), z, {
    maxIter: iters,
    stopBelow: FEAS,
    m: 10,
    shouldStop: stop,
  });
  return { z: res.x, E: res.f };
}

/** Random centre inside a disk of radius rMax, uniform in area at curvature K. */
function randomCentre(space: Space, rMax: number, r: () => number): { x: number; y: number } {
  const K = space.K;
  // area within radius s is 2 pi vs_K(s); invert by bisection on vs
  const u = r();
  const target = u * vsOf(K, rMax);
  let lo = 0;
  let hi = rMax;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vsOf(K, mid) < target) lo = mid;
    else hi = mid;
  }
  const a = 2 * Math.PI * r();
  return { x: hi * Math.cos(a), y: hi * Math.sin(a) };
}

function vsOf(K: number, x: number): number {
  // vs_K(x) = x^2 V(K x^2); here via sn: 2 sn(x/2)^2
  const s = snK(K, x / 2);
  return 2 * s * s;
}

function placementRadius(space: Space, t: number): number {
  const { M, K } = space;
  if (M === 0) return Math.max(0, t - space.piece.rho * 0.5);
  // polygon container: centres within the inscribed region plus a little
  const side = sideFromApothem(M, K, t);
  const R = Number.isFinite(side) ? containerCircumradius(M, K, side) : t + 3;
  return Math.min(R, t + 0.5 * space.piece.R);
}

function randomPoses(space: Space, P: number, t: number, r: () => number): Float64Array {
  const z = new Float64Array(3 * P);
  const rMax = placementRadius(space, t);
  for (let i = 0; i < P; i++) {
    const c = randomCentre(space, rMax, r);
    z[3 * i] = c.x;
    z[3 * i + 1] = c.y;
    z[3 * i + 2] = 2 * Math.PI * r();
  }
  return z;
}

function tightT(space: Space, z: Float64Array): number {
  const st = allStates(space, posesFromVector(z));
  let t = -Infinity;
  for (const s of st) t = Math.max(t, requiredT(space, s));
  return t;
}

/**
 * Find a feasible arrangement at container variable t from start z (penalty minimisation).
 */
function repair(
  space: Space,
  z: Float64Array,
  t: number,
  iters: number,
  stop?: () => boolean,
): Float64Array | undefined {
  const res = minimizeEnergy(space, z, t, iters, stop);
  return res.E <= FEAS ? res.z : undefined;
}

export function search(space: Space, P: number, options: SearchOptions = {}): SearchResult {
  const seed = options.seed ?? 1;
  const restarts = options.restarts ?? 8;
  const hops = options.hops ?? 30;
  const iters = options.lbfgsIter ?? 400;
  const r = rng(seed);
  const log = options.log ?? (() => {});
  const deadline = options.timeLimitMs ? Date.now() + options.timeLimitMs : Infinity;
  const stop = options.shouldStop;
  const tArea = tForArea(space, P * space.piece.area);
  const optima: number[] = [];
  let best: { z: Float64Array; t: number; pol: PolishResult } | undefined;
  let restartsDone = 0;
  let hopsDone = 0;
  const tCap = Number.isFinite(space.tMax) ? space.tMax * (1 - 1e-9) : Infinity;
  if (!(tArea < space.tMax)) {
    return { found: false, optima, seed, restartsDone, hopsDone };
  }
  const consider = (z: Float64Array, t: number): PolishResult | undefined => {
    const pol = polish(space, posesFromVector(z), t, { shouldStop: stop });
    if (!(pol.feasibility > -1e-10) || !(pol.t < space.tMax)) return undefined;
    optima.push(pol.size);
    if (!best || pol.t < best.t - 1e-13) {
      best = { z: vectorFromPoses(pol.poses), t: pol.t, pol };
      log(`  new best size ${pol.size} (t=${pol.t})`);
    }
    return pol;
  };
  for (let rs = 0; rs < restarts; rs++) {
    if (Date.now() > deadline || stop?.()) break;
    restartsDone++;
    // starting container: roomy (area density ~0.45) but inside the admissible range
    let t0 = tForArea(space, (P * space.piece.area) / 0.45);
    if (!(t0 < tCap)) t0 = Number.isFinite(tCap) ? tArea + 0.9 * (tCap - tArea) : t0;
    let z: Float64Array | undefined;
    if (rs === 0 && options.start) {
      // warm start (possibly infeasible, e.g. a previous optimum plus one piece): repair, growing t if needed
      const zs = vectorFromPoses(options.start.pieces);
      let tt = Math.min(Math.max(tightT(space, zs), apothemFromSide(space.M, space.K, options.start.size)), tCap);
      z = repair(space, zs, tt, iters, stop);
      for (let g = 0; !z && g < 8; g++) {
        tt = Number.isFinite(tCap) ? tt + 0.3 * (tCap - tt) : tt * 1.15;
        z = repair(space, zs, tt, iters, stop);
      }
      if (!z) {
        log(`restart ${rs}: warm start not repairable`);
        continue;
      }
      t0 = tt;
    } else {
      const z0 = randomPoses(space, P, t0, r);
      z = repair(space, z0, t0, iters, stop);
      // grow toward the admissible limit if the roomy container was not enough
      let tt = t0;
      for (let g = 0; !z && g < 6; g++) {
        tt = Number.isFinite(tCap) ? tt + 0.5 * (tCap - tt) : tt * 1.3;
        z = repair(space, randomPoses(space, P, tt, r), tt, iters, stop);
        t0 = tt;
      }
      if (!z) {
        log(`restart ${rs}: no feasible start`);
        continue;
      }
    }
    // penalty compression: shrink t while repairs succeed
    let tf = Math.min(tightT(space, z), tCap);
    let zf = z;
    let delta = 0.05 * Math.max(tf - tArea, 1e-3);
    for (let k = 0; k < 40 && delta > 1e-5 * Math.max(1, tf); k++) {
      if (stop?.()) break;
      const tt = tf - delta;
      if (tt <= tArea) {
        delta /= 2;
        continue;
      }
      const zr = repair(space, zf, tt, iters, stop);
      if (zr) {
        zf = zr;
        tf = Math.min(tightT(space, zr), tt);
        delta *= 1.2;
      } else delta /= 2;
    }
    let local = consider(zf, tf);
    if (!local) continue;
    let cur = { z: vectorFromPoses(local.poses), t: local.t };
    for (let h = 0; h < hops; h++) {
      if (Date.now() > deadline || stop?.()) break;
      hopsDone++;
      const zz = Float64Array.from(cur.z);
      const kind = r();
      const nMove = 1 + Math.floor(r() * Math.min(3, P));
      if (kind < 0.5) {
        // re-place random pieces anywhere
        const rMax = placementRadius(space, cur.t);
        for (let q = 0; q < nMove; q++) {
          const i = Math.floor(r() * P);
          const c = randomCentre(space, rMax, r);
          zz[3 * i] = c.x;
          zz[3 * i + 1] = c.y;
          zz[3 * i + 2] = 2 * Math.PI * r();
        }
      } else if (kind < 0.8) {
        // jiggle everything
        const s = 0.05 + 0.15 * r();
        for (let j = 0; j < zz.length; j++) zz[j] += s * gaussian(r) * (j % 3 === 2 ? 1 : 0.5);
      } else {
        // rotate a few pieces
        for (let q = 0; q < nMove; q++) zz[3 * Math.floor(r() * P) + 2] += (r() - 0.5) * Math.PI;
      }
      // repair at a slightly smaller container to push for improvement, then at the same size
      const target = cur.t - 1e-3 * Math.max(cur.t - tArea, 1e-3);
      const zr = repair(space, zz, target, iters, stop) ?? repair(space, zz, cur.t, iters, stop);
      if (!zr) continue;
      const pol = consider(zr, Math.min(tightT(space, zr), tCap));
      if (pol && pol.t < cur.t - 1e-12) {
        cur = { z: vectorFromPoses(pol.poses), t: pol.t };
        local = pol;
      }
    }
    log(`restart ${rs}: local best ${local.size}`);
  }
  if (!best) return { found: false, optima, seed, restartsDone, hopsDone };
  const b = best as { z: Float64Array; t: number; pol: PolishResult };
  return {
    found: true,
    config: { size: b.pol.size, pieces: b.pol.poses },
    t: b.t,
    polish: b.pol,
    optima,
    seed,
    restartsDone,
    hopsDone,
  };
}
