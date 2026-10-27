/**
 * The search of the balls space: seeded, budgeted, stoppable and synchronous, for a browser worker or Node.
 *
 *  1. Start. A given configuration (any size; an invalid one is first legalized) is polished, unless it is this
 *     search's own polished result (startPolished). Without one, a new start: for balls random centres or a cut of
 *     a lattice packing (ball-pieces.ts); for solids the circumscribed balls of the pieces placed as a lattice cut
 *     of unit balls, turned at random, or for cubes a cut of the cubic lattice (solid-pieces.ts). It is polished.
 *  2. Hops until the budget ends, from the best so far (ball-pieces.ts, solid-pieces.ts), one in ten a new start
 *     instead; each is polished and legalized, and a smaller result replaces the best.
 * Every configuration kept is legalized with the clearance (default BALLS_CLEARANCE, 1e-10, between pieces and
 * from the container) and checked with the validator at tolerance 0.
 *
 * Budget: `maxEvals` counts objective evaluations of the polish, so a run that ends on its evaluations is
 * reproducible from its seed; `maxSeconds` and `shouldStop` end it earlier. Both are polled at every evaluation
 * and in the work between evaluations (pair lists, legalizations); the run then returns its best so far, a
 * partly polished candidate included when it is valid and better.
 */
import { StopSearch, getSolid } from "@polypack/polyhedra";
import { BALL_MUS, freshStart, hopBalls, latticeCut, legalizeBalls, polishBalls } from "./ball-pieces";
import { BALL_RADIUS, type BallsProblem, ballsProblemOf } from "./catalogue";
import { mulberry32 } from "./random";
import { SOLID_MUS, cubeLatticeCut, hopSolids, legalizeSolids, polishSolids, solidsAt } from "./solid-pieces";
import { type BallsConfig, validateBalls } from "./validate";

/**
 * Clearance of the search's results between pieces and from the container: far above the float error of the
 * validators at these sizes (about 1e-14) and far below the tie tolerance 1e-9, so that removing it is no
 * improvement worth keeping (it costs about 5e-11 of s relative).
 */
export const BALLS_CLEARANCE = 1e-10;

export interface BallsSearchOptions {
  seed: number;
  /** Configuration to start from (any size). */
  start?: BallsConfig;
  /** True when the start is this search's own polished result: it is legalized and taken as it is. */
  startPolished?: boolean;
  /** Most objective evaluations; default 200,000. */
  maxEvals?: number;
  /** Wall-clock ceiling in seconds (makes the result depend on the machine); default none. */
  maxSeconds?: number;
  /** Polled at every evaluation: true ends the run with the best so far. */
  shouldStop?: () => boolean;
  /** Seconds, for maxSeconds; default performance.now() / 1000. */
  now?: () => number;
  /** Called after the start and after every hop. */
  onProgress?: (p: { score: number; evaluations: number; hops: number; improved: boolean }) => void;
  log?: (message: string) => void;
  /** Clearance between pieces and from the container; default BALLS_CLEARANCE. */
  clearance?: number;
  /**
   * The balls' hops: "holes" (default) also moves the loosest balls into the largest holes; "plain", the hops of the
   * first compute sweep of 2026-10-25, only random places and shakes (its rounds are replayed with it).
   */
  hops?: "holes" | "plain";
}

export interface BallsSearchResult {
  /** The best configuration found, valid by validateBalls at tolerance 0, or null. */
  config: BallsConfig | null;
  /** Its s; Infinity when there is none. */
  score: number;
  /** s of the (polished) start, or null without a start. */
  startScore: number | null;
  evaluations: number;
  hops: number;
  stopped: "evals" | "time" | "aborted" | "done";
}

type Partial = StopSearch & { partial?: BallsConfig };

export function searchBalls(problem: BallsProblem, P: number, o: BallsSearchOptions): BallsSearchResult {
  if (!Number.isInteger(P) || P < 1) throw new Error("P must be a positive integer");
  const maxEvals = o.maxEvals ?? 200_000;
  const clock = o.now ?? (() => performance.now() / 1000);
  const t0 = clock();
  const log = o.log ?? (() => {});
  const clearance = o.clearance ?? BALLS_CLEARANCE;
  // a 32-bit multiply, so that every uint32 seed (mixSeed's job seeds) gives its own generator state; a float product
  // would round the low bits of large seeds away
  const rng = mulberry32(Math.imul(o.seed | 0, 2654435761));
  const balls = problem.piece === "ball";
  let evaluations = 0;
  let stopped: BallsSearchResult["stopped"] = "done";
  const poll = () => {
    if (o.shouldStop?.()) throw new StopSearch("aborted");
    if (o.maxSeconds !== undefined && clock() - t0 > o.maxSeconds) throw new StopSearch("time");
  };
  const tick = () => {
    evaluations++;
    if (evaluations > maxEvals) throw new StopSearch("evals");
    poll();
  };
  const env = { rng, tick, poll, clearance };
  let best: BallsConfig | null = null;
  let hops = 0;
  const accept = (c: BallsConfig | null | undefined, what: string): boolean => {
    if (!c) return false;
    if (best && !(c.s < best.s)) return false;
    const v = validateBalls(problem, c, { tol: 0 });
    if (!v.valid) {
      log(`${what}: not valid after legalization (${v.errors[0]})`);
      return false;
    }
    best = c;
    log(`${what}: s = ${c.s}`);
    return true;
  };
  const legalize = (c: BallsConfig): BallsConfig =>
    balls
      ? legalizeBalls(problem, c.pieces as [number, number, number][], clearance, clearance)
      : legalizeSolids(problem, c.pieces, clearance, clearance, poll);
  const polish = (c: BallsConfig, from = 0): BallsConfig =>
    balls ? polishBalls(problem, c, env, BALL_MUS.slice(from)) : polishSolids(problem, c, env, SOLID_MUS.slice(from));
  /** A polish whose partial result, on a stop, is still considered. */
  const tryPolish = (c: BallsConfig, what: string, from = 0): boolean => {
    try {
      return accept(polish(c, from), what);
    } catch (e) {
      if (e instanceof StopSearch && (e as Partial).partial) accept((e as Partial).partial!, `partly polished ${what}`);
      throw e;
    }
  };
  const fresh = (): BallsConfig => {
    if (balls) return freshStart(problem, P, rng, clearance);
    const S = getSolid(problem.piece);
    if (problem.piece === "cube" && rng() < 0.4) return legalizeSolids(problem, cubeLatticeCut(P, rng), clearance, clearance, poll);
    // unit balls of a lattice cut, scaled to the circumradius: the pieces' circumscribed balls are then disjoint
    const kind = rng() < 0.5 ? "fcc" : "hcp";
    const centres = latticeCut(ballsProblemOf("ballinball")!, P, rng, kind, true);
    // (the lattice has balls of radius BALL_RADIUS, so the scale is the circumradius over that)
    const R = (S.circumradius / BALL_RADIUS) * (1 + 1e-9);
    return legalizeSolids(problem, solidsAt(centres.map((c) => [c[0] * R, c[1] * R, c[2] * R]), rng), clearance, clearance, poll);
  };
  let startScore: number | null = null;
  try {
    if (o.start) {
      if (o.start.pieces.length !== P) throw new Error(`the start has ${o.start.pieces.length} pieces, not ${P}`);
      accept(legalize(o.start), "start");
      if (!o.startPolished) tryPolish(o.start, "polished start", 3);
      startScore = best ? (best as BallsConfig).s : null;
    } else {
      const f = fresh();
      accept(f, "fresh start");
      tryPolish(f, "polished fresh start");
    }
    o.onProgress?.({ score: best ? (best as BallsConfig).s : Infinity, evaluations, hops, improved: true });
    for (;;) {
      if (!best) {
        // nothing valid yet (a start that could not be legalized): build one
        const f = fresh();
        accept(f, "fresh start");
        tryPolish(f, "polished fresh start");
        continue;
      }
      const b: BallsConfig = best;
      hops++;
      const restart = P > 1 && rng() < 0.1;
      const cand = restart ? fresh() : balls ? hopBalls(problem, b, rng, o.hops ?? "holes") : hopSolids(problem, b, rng);
      const improved = tryPolish(cand, restart ? "new start" : "hop");
      o.onProgress?.({ score: (best as BallsConfig).s, evaluations, hops, improved });
    }
  } catch (e) {
    if (!(e instanceof StopSearch)) throw e;
    stopped = e.why;
  }
  const out = best as BallsConfig | null;
  return { config: out, score: out ? out.s : Infinity, startScore, evaluations: Math.min(evaluations, maxEvals), hops, stopped };
}
