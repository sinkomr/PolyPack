/**
 * Seeded search for packings on the boundary of a polytope ("3D on 4D"): P unit balls or unit
 * cubes, minimising the edge s. It runs synchronously (the board's Web Worker, the volunteer
 * client's worker threads) and uses no Node or browser API beyond performance.now.
 *
 * The method is the research prototype's (balls_round2.py, cubes_aligned.py), in four stages:
 *  - relax: L-BFGS on the model's penalty energy (model.ts) at a fixed s, the variables being one
 *    displacement per piece in its anchor's chart (chart.ts: a piece crosses ridges as smoothly as
 *    it moves in a cell); after each run every piece is re-anchored where it ended and the run
 *    starts again, until the energy is below the model's target or stops falling;
 *  - compress: shrink s geometrically (centres scaled about their cells' centres) and relax; a
 *    success grows the step by 1.5 (to at most 5%), a failure halves it, until it is below `stop`.
 *    A start that is infeasible at its s is first grown by 6% (cubes 5%), up to eight times;
 *  - polish: the same compression from a step of 1e-4 (cubes 1e-5) down to 1e-10, with longer
 *    relaxations, for every compression result within twice the coarse stop of the best (its
 *    basin's floor may lie below the best);
 *  - finalize: validity is monotone in a scaling of the configuration (the metric scales, the
 *    pieces do not, so every piece shrinks within itself), so the smallest scale k >= 1 at which
 *    the model's own exact rule holds is found by bisection, then nudged up until the engine's
 *    validator accepts the configuration at tol 0. Only states smaller than the best are
 *    finalized. Every configuration the search reports passed validateBoundary at tol 0, so it
 *    passes the server's rule (tol 1e-9) with margin.
 * Starts: random layouts at the model's start edge, hops from the best (one to three pieces
 * moved; balls on every third start, cubes on every second) and, for cubes, the two-rings layout
 * first. A given start is checked first by the server's rule (validateBoundary at tol 1e-9, not
 * counted against the budget); when valid it is the first candidate, so a run never returns
 * worse than it was given (and onImprove is called only for better configurations). Then it is
 * compressed and polished.
 *
 * Budget: `evals` counts energy evaluations (each one sweep over the near pairs), and each call
 * of the validator counts VALIDATION_EVALS. With an evaluation budget only, the run is
 * reproducible from (problem, start, seed, evals): all choices come from mulberry32(seed), and
 * nothing reads the clock except for time_s. `shouldStop` and the clock are polled at every
 * evaluation (microseconds apart for P <= 16) and before every validation (milliseconds).
 * The pair stages are quadratic in P (fine for the tens of pieces the catalogue lists).
 * Ends: "evals", "time" (time_s), "stopped" (shouldStop), or "bound" when the best reaches the
 * model's floor (balls: the proven bound max(one-ball, volume); aligned cubes: max(1, volume),
 * no aligned cube packing being smaller).
 */
import { getPolytope, isPolytopeName } from "../polytope";
import { isPieceCount, isPieceName } from "../ids";
import type { BoundaryConfig, BoundaryProblem } from "../types";
import { validateBoundary } from "../validate";
import { BallModel, ChainMetric } from "./balls";
import { SiteBallModel } from "./ball-site";
import { chartsOf } from "./chart";
import { AlignedCubeModel } from "./cubes";
import { lbfgs } from "./lbfgs";
import { type PieceModel, type State, scaleState } from "./model";
import { mulberry32 } from "./random";

export interface BoundarySearchOptions {
  /** Configuration to start from (any s; an invalid one is grown until the model finds it feasible). */
  start?: BoundaryConfig;
  /** Integer seed of the run's random choices. */
  seed: number;
  /** `evals`: energy evaluations (validations count VALIDATION_EVALS each); `time_s`: a wall-clock ceiling. */
  budget: { evals: number; time_s?: number };
  /** Polled at every evaluation: true ends the run with the best so far. */
  shouldStop?: () => boolean;
  /** Called with every configuration better than the best so far (valid at tol 0). */
  onImprove?: (best: { config: BoundaryConfig; score: number }) => void;
  /** Seconds, for time_s; default performance.now() / 1000. */
  now?: () => number;
  /**
   * Balls only, for cross-checks: "chains" uses the generic chain metric (any polytope, about 500
   * times slower) instead of the tesseract's lattice words. Default: words on the tesseract.
   */
  ballMetric?: "words" | "chains";
}

export type BoundarySearchEnd = "evals" | "time" | "stopped" | "bound";

/** One improvement of the best: where it came from and when. */
export interface BoundarySearchEvent {
  evals: number;
  seconds: number;
  score: number;
  /** "start": the given start itself; "warm": compressed from it; then random, hop or rings starts. */
  source: "start" | "warm" | "random" | "hop" | "rings";
  stage: "given" | "coarse" | "polish";
}

export interface BoundarySearchResult {
  /** The best configuration (valid at tol 0, or the given start valid at tol 1e-9), or null. */
  config: BoundaryConfig | null;
  /** Its s, or null. */
  score: number | null;
  /** Evaluations used. */
  evals: number;
  ended: BoundarySearchEnd;
  /** The improvements, in order. */
  trace: BoundarySearchEvent[];
  /** s of the given start when it is valid (tol 1e-9), else null. */
  startScore: number | null;
  /** Starts compressed (the warm start included). */
  starts: number;
  /** Evaluations by stage (validations included in "final"), and the number of validator calls. */
  stats: { coarse: number; polish: number; final: number; validations: number };
}

/**
 * Evaluations one validator call counts for: for P = 4..16 a call costs 400 to 900 energy
 * evaluations (measured), so that the budget stays about proportional to time.
 */
export const VALIDATION_EVALS = 500;

class Stop extends Error {
  constructor(readonly why: BoundarySearchEnd) {
    super(why);
  }
}

interface Shape {
  /** Compression stops once its relative step is below this. */
  stop: number;
  delta0: number;
  rounds: number;
  maxIter: number;
}

interface Plan {
  coarse: Shape;
  polish: Shape;
  /** Growth of an infeasible start. */
  grow: number;
  /** A hop starts at the best's s times this. */
  hopGrow: number;
  /** Every hopEvery-th start (from the second on) is a hop. */
  hopEvery: number;
}

const PLANS: Record<"ball" | "cube", Plan> = {
  // balls_round2.py: coarse compression to 3e-5, polish by bisection to 1e-10
  ball: {
    coarse: { stop: 3e-5, delta0: 0.02, rounds: 3, maxIter: 200 },
    polish: { stop: 1e-10, delta0: 1e-4, rounds: 6, maxIter: 600 },
    grow: 1.06,
    hopGrow: 1.03,
    hopEvery: 3,
  },
  // cubes_aligned.py: compression to 1e-6; the polish is added here
  cube: {
    coarse: { stop: 1e-6, delta0: 0.02, rounds: 4, maxIter: 300 },
    polish: { stop: 1e-10, delta0: 1e-5, rounds: 6, maxIter: 600 },
    grow: 1.05,
    hopGrow: 1.04,
    hopEvery: 2,
  },
};

function cloneConfig(c: BoundaryConfig): BoundaryConfig {
  return { s: c.s, pieces: c.pieces.map((p) => ({ cell: p.cell, u: p.u.slice(), ...(p.q ? { q: [...p.q] as typeof p.q } : {}) })) };
}

/** The search's model of a problem's pieces. */
export function modelOf(problem: BoundaryProblem, ballMetric?: "words" | "chains"): PieceModel {
  const poly = getPolytope(problem.polytope);
  if (problem.piece === "cube") return new AlignedCubeModel(poly, problem.P, chartsOf(poly));
  // balls: the working model (radius 1) behind its site-unit wrapper (ball-site.ts)
  return new SiteBallModel(ballMetric === "chains" ? new BallModel(poly, problem.P, new ChainMetric(poly)) : new BallModel(poly, problem.P));
}

/** Relative steps by which finalizeState nudges a scale up until the validator accepts it. */
const FINAL_BUMPS = [0, 1e-14, 1e-13, 1e-12, 1e-11, 1e-10, 1e-9];

/**
 * The finalize stage (header): the smallest scale k >= 1 of st (at edge s) at which the model's
 * exact rule holds, by bisection, then nudged up until `accept` (the validator at tol 0) takes the
 * configuration at edge k s; null when no k <= 2 satisfies the rule or no nudge is accepted.
 * `onViolation` is called before every evaluation of the rule (the search counts them).
 *
 * `shrink` (the generic kernel's finish, ../kernel.ts): when the rule already holds at k = 1, k
 * may also go below 1, down to the model's floor, so that a state with room is drawn in until its
 * pieces touch. The rule is monotone in k, so the bisection is sound either way.
 */
export function finalizeState(
  model: PieceModel,
  st: State,
  s: number,
  accept: (config: BoundaryConfig) => boolean,
  opts: { shrink?: boolean; onViolation?: () => void } = {},
): { config: BoundaryConfig; score: number } | null {
  const viol = (k: number) => {
    opts.onViolation?.();
    return model.violation(scaleState(st, k), s * k);
  };
  const bisect = (lo: number, hi: number): number => {
    // viol(lo) > 0 >= viol(hi)
    while (hi - lo > 1e-15 * hi) {
      const mid = 0.5 * (lo + hi);
      if (viol(mid) > 0) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  let k = 1;
  if (viol(1) > 0) {
    let lo = 1;
    let step = 1e-13;
    let hi = 1 + step;
    while (viol(hi) > 0) {
      lo = hi;
      step *= 4;
      if (step > 1) return null;
      hi = 1 + step;
    }
    k = bisect(lo, hi);
  } else if (opts.shrink) {
    // steps down from 1, growing fourfold, until the rule fails or the floor is reached
    const kMin = model.floor / s;
    let hi = 1;
    let step = 1e-13;
    for (;;) {
      const lo = Math.max(1 - step, kMin);
      if (!(lo < hi)) break;
      if (viol(lo) > 0) {
        hi = bisect(lo, hi);
        break;
      }
      hi = lo;
      if (lo === kMin) break;
      step *= 4;
    }
    k = hi;
  }
  // the validator at tol 0 judges: touching contacts may need a hair more room than the model's exact rule
  const nudge = (k0: number) => {
    for (const bump of FINAL_BUMPS) {
      const kk = k0 * (1 + bump);
      const sk = s * kk;
      const config: BoundaryConfig = { s: sk, pieces: model.pieces(scaleState(st, kk), sk) };
      if (accept(config)) return { config, score: sk };
    }
    return null;
  };
  // a shrunk scale the validator refuses falls back to k = 1, where the rule held
  return nudge(k) ?? (k < 1 ? nudge(1) : null);
}

export function searchBoundary(problem: BoundaryProblem, opts: BoundarySearchOptions): BoundarySearchResult {
  if (!problem || !isPolytopeName(problem.polytope) || !isPieceName(problem.piece) || !isPieceCount(problem.P)) throw new Error("searchBoundary: invalid problem");
  const poly = getPolytope(problem.polytope);
  const charts = chartsOf(poly);
  const model = modelOf(problem, opts.ballMetric);
  const plan = PLANS[problem.piece];
  const P = problem.P;
  const rand = mulberry32(opts.seed);
  const clock = opts.now ?? (() => performance.now() / 1000);
  const t0 = clock();
  const maxEvals = Number.isFinite(opts.budget?.evals) ? Math.max(0, Math.floor(opts.budget.evals)) : 0;
  const maxSeconds = opts.budget?.time_s;
  let evals = 0;
  const stats = { coarse: 0, polish: 0, final: 0, validations: 0 };
  let stage: "coarse" | "polish" | "final" = "coarse";
  const tick = (cost = 1) => {
    if (evals + cost > maxEvals) throw new Stop("evals");
    evals += cost;
    stats[stage] += cost;
    if (opts.shouldStop?.()) throw new Stop("stopped");
    if (maxSeconds !== undefined && clock() - t0 > maxSeconds) throw new Stop("time");
  };

  // ------------------------------------------------------------ relax
  const P3 = 3 * P;
  const gU = new Float64Array(P3);
  const Ms = new Float64Array(9 * P);
  const moved: State = { cells: new Int32Array(P), U: new Float64Array(P3) };
  /** Moves every piece of `base` by its displacement in x; false when a path meets a hinge. */
  const place = (base: State, x: Float64Array, s: number, out: State): boolean => {
    for (let q = 0; q < P; q++) {
      const c = charts.move(base.cells[q], base.U, 3 * q, x[3 * q], x[3 * q + 1], x[3 * q + 2], s, out.U, 3 * q, Ms, 9 * q);
      if (c < 0) return false;
      out.cells[q] = c;
    }
    return true;
  };
  const relax = (st: State, s: number, rounds: number, maxIter: number): { st: State; E: number } => {
    let cur = st;
    let E = Infinity;
    for (let r = 0; r < rounds; r++) {
      const base = cur;
      const f = (x: Float64Array, g: Float64Array): number => {
        tick();
        if (!place(base, x, s, moved)) {
          g.fill(0);
          return Infinity;
        }
        const e = model.energy(moved, s, gU);
        // gradient in the anchor's chart: M^T times the gradient at the end point
        for (let q = 0; q < P; q++) {
          const m = 9 * q;
          const a = gU[3 * q];
          const b = gU[3 * q + 1];
          const c = gU[3 * q + 2];
          g[3 * q] = Ms[m] * a + Ms[m + 3] * b + Ms[m + 6] * c;
          g[3 * q + 1] = Ms[m + 1] * a + Ms[m + 4] * b + Ms[m + 7] * c;
          g[3 * q + 2] = Ms[m + 2] * a + Ms[m + 5] * b + Ms[m + 8] * c;
        }
        return e;
      };
      const res = lbfgs(f, new Float64Array(P3), { maxIter, target: model.target, maxStep: model.maxStep });
      const next: State = { cells: new Int32Array(P), U: new Float64Array(P3) };
      if (!(res.f < Infinity) || !place(base, res.x, s, next)) break;
      const prev = E;
      cur = next;
      E = res.f;
      if (E < model.target || !(E < prev * (1 - 1e-3))) break;
    }
    return { st: cur, E };
  };

  // ------------------------------------------------------------ compress
  const compress = (st0: State, s0: number, sh: Shape, grow: boolean): { st: State; s: number } | null => {
    let s = s0;
    let r = relax(st0, s, sh.rounds, sh.maxIter);
    for (let k = 0; grow && k < 8 && !(r.E < model.target); k++) {
      const s2 = s * plan.grow;
      r = relax(scaleState(r.st, s2 / s), s2, sh.rounds, sh.maxIter);
      s = s2;
    }
    if (!(r.E < model.target)) return null;
    let best = { st: r.st, s };
    let delta = sh.delta0;
    while (delta > sh.stop) {
      const s2 = Math.max(best.s * (1 - delta), model.floor);
      if (!(s2 < best.s)) break;
      const q = relax(scaleState(best.st, s2 / best.s), s2, sh.rounds, sh.maxIter);
      if (q.E < model.target) {
        best = { st: q.st, s: s2 };
        delta = Math.min(delta * 1.5, 0.05);
      } else delta *= 0.5;
    }
    return best;
  };

  // ------------------------------------------------------------ finalize
  const finalize = (st: State, s: number): { config: BoundaryConfig; score: number } | null =>
    finalizeState(
      model,
      st,
      s,
      (config) => {
        tick(VALIDATION_EVALS);
        stats.validations++;
        return validateBoundary(problem, config, { tol: 0 }).ok;
      },
      { onViolation: () => tick() },
    );

  // ------------------------------------------------------------ the run
  const trace: BoundarySearchEvent[] = [];
  let best: { config: BoundaryConfig; score: number } | null = null;
  let hopFrom: { st: State; s: number } | null = null;
  let startScore: number | null = null;
  let starts = 0;
  let ended: BoundarySearchEnd = "evals";
  const atFloor = () => best !== null && best.score <= model.floor * (1 + 1e-9);
  const offer = (f: { config: BoundaryConfig; score: number } | null, source: BoundarySearchEvent["source"], stage: BoundarySearchEvent["stage"], st: State, s: number) => {
    if (!f || (best && !(f.score < best.score))) return;
    best = f;
    hopFrom = { st, s };
    trace.push({ evals, seconds: clock() - t0, score: f.score, source, stage });
    opts.onImprove?.({ config: cloneConfig(f.config), score: f.score });
    if (atFloor()) throw new Stop("bound");
  };
  const window = 2 * plan.coarse.stop;
  const consider = (r: { st: State; s: number } | null, source: BoundarySearchEvent["source"]) => {
    if (!r) return;
    if (best && r.s > best.score * (1 + window)) return;
    // finalizing only scales up, so a state no smaller than the best cannot beat it
    const better = (s: number) => !best || s < best.score;
    stage = "final";
    if (better(r.s)) offer(finalize(r.st, r.s), source, "coarse", r.st, r.s);
    stage = "polish";
    const p = compress(r.st, r.s, plan.polish, false);
    stage = "final";
    if (p && p.s < r.s && better(p.s)) offer(finalize(p.st, p.s), source, "polish", p.st, p.s);
    stage = "coarse";
  };

  try {
    const start = opts.start;
    if (start) {
      // the given start, by the server's rule (not counted against the budget: it is always checked)
      const v = validateBoundary(problem, start, { tol: 1e-9 });
      const st = model.stateOf(start);
      if (v.ok) {
        best = { config: cloneConfig(start), score: start.s };
        startScore = start.s;
        if (st) hopFrom = { st, s: start.s };
        trace.push({ evals, seconds: clock() - t0, score: start.s, source: "start", stage: "given" });
        if (atFloor()) throw new Stop("bound");
      }
      if (st && Number.isFinite(start.s) && start.s > 0) {
        starts++;
        consider(compress(st, start.s, plan.coarse, true), "warm");
      }
    }
    for (let n = 0; ; n++) {
      let st: State;
      let s: number;
      let source: BoundarySearchEvent["source"];
      const built = n === 0 ? model.constructedStart(rand) : null;
      const from = hopFrom as { st: State; s: number } | null;
      if (built) {
        ({ st, s } = built);
        source = "rings";
      } else if (from && n % plan.hopEvery === plan.hopEvery - 1) {
        s = from.s * plan.hopGrow;
        st = model.hop(scaleState(from.st, plan.hopGrow), s, rand);
        source = "hop";
      } else {
        s = model.startEdge();
        st = model.randomState(s, rand);
        source = "random";
      }
      starts++;
      consider(compress(st, s, plan.coarse, true), source);
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    ended = e.why;
  }
  const b = best as { config: BoundaryConfig; score: number } | null;
  return { config: b ? b.config : null, score: b ? b.score : null, evals, ended, trace, startScore, starts, stats };
}
