/**
 * The engine's fixed policy: the arms it chooses between, how long their jobs last, how a result is
 * rewarded and when a problem is done. search.ts applies it; the numbers are collected here so
 * that the whole policy can be read, and changed, in one place.
 *
 * Evidence for the defaults. [EST] docs/methods/*.md and docs/AUTOMATION.md: `harden` and
 * `shrink_repair` lead on polygons (squares, triangles, hexagons, the square sawtooth), `asc` is
 * fast and stops early, `ls_growth` leads on circles, `basin_hopping` and `morph` refine starts
 * with the right contact topology, `mc_compress` is mostly dominated by `asc`, and `penalty` is
 * the local solver inside `basin_hopping`. [CALC] Local runs on 2026-10-21 (Apple M1 Pro, Node
 * v26.5.0, four processes at once; calibrate.ts repeats them):
 *  - rate: one counted evaluation cost 0.03 to 0.55 ms per piece, median about 0.13 ms, over six
 *    methods and nine problems (N/M/P from 4/4/10 to 4/4/100, 0/0/30, 7/0/40, 0/4/60);
 *    `ls_growth` ended far behind on polygons (16.0 against 10.0 for 100 squares in 6 s) and
 *    level with the best on 30 circles in a circle (6.197745; published 6.197741);
 *  - improve: from an 8 s `harden` result on 3/3/20, 5/5/20, 7/0/40 and 0/4/60, 8 s improver
 *    runs gained `shrink_repair` 3e-4 to 8e-3 relative on all four, `harden` rigid with noise 1
 *    2e-4 to 2e-3 on all four, `asc` 2e-6 to 4e-4, `basin_hopping` and `morph` mostly below 5e-6;
 *  - length: on 17 squares, three `harden` seeds at 4, 8 and 16 s gave best 4.6973, 4.6790 and
 *    4.6777 (published 4.675530): longer runs paid where restarts did not; on 20 triangles the
 *    seed mattered more than the length. Both kinds of growth are needed;
 *  - portfolio: the engine with one lane for 120 s against the batch runner's default (asc and
 *    harden, seeds 1 to 3, 20 s each, the same CPU time) scored 4.677649 against 4.677651 on
 *    4/4/17, 4.863068 against 4.864090 on 3/3/20, 5.034070 against 5.041270 on 5/5/20 and
 *    7.618295 against 7.617542 on 7/0/40. Four problems, one seed: weak evidence.
 */
import type { PackingConfig } from "@polypack/geometry";
import type { Problem } from "../types";

export type StartKind = "fresh" | "warm" | "iterate";

/**
 * One way to spend a job: a method with its parameters on one kind of start. Its budget level is
 * the engine's state, not part of the arm.
 */
export interface Arm {
  /** `${start}:${name}`; also the arm's key in EngineMemory. */
  key: string;
  name: string;
  method: string;
  start: StartKind;
  /** Parameters for one job, given the engine's seeded stream; undefined keeps the defaults. */
  params?: (random: () => number) => Record<string, unknown>;
}

interface Recipe {
  name: string;
  method: string;
  starts: StartKind[];
  params?: (random: () => number) => Record<string, unknown>;
  /** Whether the recipe applies to the problem; every problem when left out. */
  when?: (problem: Problem) => boolean;
}

/**
 * The arms. Constructors run from scratch ("fresh"); improvers start from the best known packing
 * ("warm", input.known) or from the engine's own best ("iterate"), which every improvement
 * replaces. `seed`, `penalty` and `polish` run inside these methods already and are not arms;
 * `mc_compress` is left out as dominated by `asc` in the method pages' tables.
 */
const RECIPES: Recipe[] = [
  { name: "harden", method: "harden", starts: ["fresh"] },
  { name: "shrink_repair", method: "shrink_repair", starts: ["fresh", "warm", "iterate"] },
  // The reference's control path: better than the harden path on triangles (docs/methods/harden.md,
  // 12 triangles), identical to it for circles
  {
    name: "harden-rigid",
    method: "harden",
    starts: ["fresh"],
    params: () => ({ path: "rigid" }),
    when: (p) => p.N !== 0,
  },
  // harden.md: "to refine an existing packing rather than search from it, use the rigid path with
  // a small noise"; it gained on all four problems of the improver calibration above
  { name: "harden-refine", method: "harden", starts: ["warm", "iterate"], params: () => ({ path: "rigid", noise: 1 }) },
  { name: "asc", method: "asc", starts: ["fresh", "warm", "iterate"] },
  { name: "basin_hopping", method: "basin_hopping", starts: ["fresh", "warm", "iterate"] },
  // Neither shape family is better in general (morph.md, "Benchmark conclusions"), so each job
  // draws one
  {
    name: "morph",
    method: "morph",
    starts: ["fresh", "warm", "iterate"],
    params: (random) => ({ family: random() < 0.5 ? "inscribed" : "circumscribed" }),
  },
  { name: "ls_growth", method: "ls_growth", starts: ["fresh"], when: (p) => p.N === 0 },
];

/**
 * The arms that apply to a problem, in the default exploration order: recipe by recipe, so that
 * the first lanes get different methods.
 */
export function armsFor(problem: Problem): Arm[] {
  const arms: Arm[] = [];
  for (const recipe of RECIPES) {
    if (recipe.when && !recipe.when(problem)) continue;
    for (const start of recipe.starts)
      arms.push({
        key: `${start}:${recipe.name}`,
        name: recipe.name,
        method: recipe.method,
        start,
        params: recipe.params,
      });
  }
  return arms;
}

export const POLICY = {
  /**
   * Prior cost of one counted evaluation, per piece, in seconds, until the problem's own jobs (or
   * the family's memory) give the rate. [CALC] median 0.13 ms, rounded up.
   */
  secondsPerEvaluationPerPiece: 1.5e-4,
  /**
   * The base budget T0 buys this many evaluations at the prior rate: three to four full-length
   * `harden` runs (360 evaluations each), or `basin_hopping`'s seed slice and about nine hops.
   */
  baseEvaluations: 1500,
  /** T0 bounds, seconds: below 4 s the fixed costs of a run (seed slices, polish) dominate. */
  baseMinSeconds: 4,
  baseMaxSeconds: 120,
  /** The exploration round (one T0 job per arm) may take at most this share of all lane time. */
  explorationShare: 0.25,
  /**
   * Largest job: a sixth of maxSeconds, so that a lane still makes six choices at the top level,
   * and at most 15 minutes, beyond the 30,000-evaluation runs of the method pages for P <= 100.
   */
  capShare: 1 / 6,
  capMaxSeconds: 900,
  /**
   * A job's evaluation cap is this share of what its time budget buys at the learned rate, so
   * that most jobs end on evaluations, which makes their packing reproducible from the job (seed,
   * parameters, start, evaluations) whatever the machine; the time budget stays as the hard limit.
   */
  evaluationFill: 0.8,
  minEvaluations: 64,
  /** A pair's level rises after an improvement, or after this many jobs at its level without one. */
  missesPerLevel: 2,
  /**
   * Thompson sampling: each finished job first pulls its arm's posterior back toward the prior by
   * this factor, so the posterior follows the last ten or so jobs; success gets rarer as the best
   * improves, and old successes must not keep an arm in front.
   */
  discount: 0.9,
  /** An arm whose jobs fail (error, crash) this many times in a row is not run again. */
  errorLimit: 3,
  /** A relative improvement of the best above this counts; below it is rounding. */
  minImprovement: 1e-9,
  /**
   * Stagnation: stop when the time since the last progress reaches this share of the elapsed
   * time. With 0.5 the search gets as much time again as it took to make its last progress; if
   * progress arrived like the records of a random sequence, the next doubling of time would hold
   * some with probability 1/2 [SPEC]. Progress is an improvement by more than minImprovement
   * relative of the best, or of the search's own line (search.ts), within approachGap.
   */
  stagnationShare: 0.5,
  /**
   * The fair share of maxSeconds, which is also the stagnation floor: before it the search never
   * stops for stagnation and its own line counts as progress however far behind it is. A quarter,
   * and at least 4 T0 for the exploration round. [CALC] At docs/VOLUNTEER.md's default, 10
   * minutes on all cores but one of 8, a quarter is 17.5 core-minutes, about 1.5 times the 12
   * core-minutes of the batch runner's sawtooth run (2 methods, 3 seeds, 120 s), the kind of short
   * search behind the site's leaders. A search that has spent more than that without coming near
   * the leader is unlikely to beat it [SPEC], and stopping then leaves three quarters of the
   * problem's time to the next problems. At 60 minutes the floor is 15 minutes: proportional to
   * what the volunteer grants a problem rather than capped.
   */
  fairShare: 0.25,
  stagnationFloorBases: 4,
  /**
   * After the fair share, the search's own line counts as progress only while it is within this
   * relative distance of the score to beat. [CALC] calibrate.ts `length`: two doublings of run
   * length gained 0.09% to 0.4%. What is left of maxSeconds after its first quarter is two
   * doublings of elapsed time, so a line more than 1% behind, 2.5 times the largest gain seen,
   * is unlikely to catch up.
   */
  approachGap: 0.01,
  /**
   * Time kept for the final polish: 2% of maxSeconds within [2 s, 60 s], at most a quarter of
   * maxSeconds. [CALC] Polishing a 5 s `asc` result took 0.2 s for 30 squares but 10 to 60 s for
   * 50 to 100 heptagons, hexagons, pentagons or circles; it is best effort past the reserve.
   */
  polishShare: 0.02,
  polishMinSeconds: 2,
  polishMaxSeconds: 60,
  polishEvaluations: 10_000,
  /** Guard against a host whose clock never moves: no problem runs more jobs than this. */
  maxJobs: 100_000,
} as const;

/** The per-problem numbers derived from POLICY; exported for the host's log and the tests. */
export interface Plan {
  /** Base budget T0, seconds. */
  base: number;
  /** Largest job budget, seconds. */
  cap: number;
  /** Highest level: budgets are base * 2^level, up to cap. */
  maxLevel: number;
  /** Seconds kept for the final polish. */
  polishReserve: number;
  /** Shortest stagnation span, and the fair share of maxSeconds, seconds. */
  stagnationFloor: number;
  /** No job shorter than this is started. */
  minJob: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * @param evaluationsPerSecond prior rate for the problem (from memory, or the per-piece prior)
 */
export function makePlan(maxSeconds: number, lanes: number, arms: number, evaluationsPerSecond: number): Plan {
  const T = Math.max(0, maxSeconds);
  const polishReserve = Math.min(
    clamp(POLICY.polishShare * T, POLICY.polishMinSeconds, POLICY.polishMaxSeconds),
    T / 4,
  );
  const bySize = clamp(POLICY.baseEvaluations / evaluationsPerSecond, POLICY.baseMinSeconds, POLICY.baseMaxSeconds);
  const byShare = (POLICY.explorationShare * T * lanes) / Math.max(1, arms);
  const base = Math.max(0.5, Math.min(bySize, byShare));
  const cap = Math.max(base, Math.min(POLICY.capShare * T, POLICY.capMaxSeconds));
  const maxLevel = Math.max(0, Math.floor(Math.log2(cap / base) + 1e-9));
  const floor = Math.max(POLICY.stagnationFloorBases * base, POLICY.fairShare * T);
  return { base, cap, maxLevel, polishReserve, stagnationFloor: Math.min(T, floor), minJob: base / 2 };
}

/** Budget in seconds of a job at a level, before clipping to the remaining time. */
export function levelSeconds(plan: Plan, level: number): number {
  return Math.min(plan.cap, plan.base * 2 ** level);
}

/**
 * Reward of a job: 0 unless it improved the best (or the known packing) by more than
 * minImprovement relative; otherwise a log scale from 0.1 (about 1e-9) through 0.5 (1e-6) to 1
 * (1e-3 and more). Late improvements are small but can be the ones that beat a leader, so they
 * count; larger ones count more.
 */
export function reward(before: number, after: number): number {
  if (!Number.isFinite(before) || !(before > 0) || !(after < before)) return 0;
  const gain = (before - after) / before;
  if (gain <= POLICY.minImprovement) return 0;
  return clamp((Math.log10(gain) + 9) / 6, 0.1, 1);
}

/**
 * The family a problem's memory is kept under: piece and container shape (circles "c", 3 to 8
 * sides exactly, nearly round shapes of 9 or more sides together) and a P bucket.
 */
export function familyKey(problem: Problem): string {
  const shape = (s: number) => (s === 0 ? "c" : s <= 8 ? String(s) : "9+");
  const P = problem.P;
  const bucket = P < 10 ? 1 : P < 20 ? 10 : P < 50 ? 20 : P < 100 ? 50 : P < 200 ? 100 : P < 500 ? 200 : 500;
  return `${shape(problem.N)}/${shape(problem.M)}/${bucket}`;
}

/** Whether a configuration is one of this problem's (the solver checks the geometry). */
export function fitsProblem(config: PackingConfig | undefined, problem: Problem): config is PackingConfig {
  return (
    typeof config === "object" &&
    config !== null &&
    config.N === problem.N &&
    config.M === problem.M &&
    config.P === problem.P &&
    Array.isArray(config.pieces) &&
    config.pieces.length === problem.P
  );
}
