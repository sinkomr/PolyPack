import { sym } from "../how";
import type { MethodGame, RunProblem } from "./types";

// asc, from packages/solver/src/methods/asc.ts (its defaults and update rules).
//
// The game runs asc warm, one cooling cycle a run. With the solver's default temperature of 0, asc
// keeps only moves that do not grow the side, so on a board other methods have already worked it
// moves loose pieces alone (−0.0004 % in 1,200 evaluations, 40 21-gons in a 24-gon), and its run
// never stops by itself: every tiny wall shrink resets its stagnation count. Opened at T₀ = 0.0008
// × the side, the packing loosens for about 400 evaluations and then settles lower as T cools
// (−0.17 % in 1,800 evaluations on the same board, 12 times a fresh mc_compress run). One run is
// one cycle of 20,000 sweeps, by which time T is 4.5 × 10⁻⁵ of T₀, so the next run heats again.

/** The start temperature as a fraction of the side of the board a run opens from: T₀ = ASC_HEAT × s₀. */
export const ASC_HEAT = 8e-4;
/** Sweeps in one asc run, one cooling cycle: a run's budget is this over its sweeps per evaluation. */
export const ASC_CYCLE_SWEEPS = 20_000;
/** The fewest evaluations an asc run has, whatever its sweeps per evaluation. */
export const ASC_MIN_BUDGET = 100;
/** The solver's factor on the temperature after each sweep (its default coolingRate; a test checks it). */
export const ASC_COOLING = 0.9995;
/** The solver's default sweeps per evaluation (tunedDefaults; a test checks it). */
const SWEEPS = 10;
/** The solver's bound on the temperature (its schema). */
const MAX_TEMPERATURE = 100;

/**
 * The tuning levels. Bench (presets.ts), 150 evaluations at temperature 0 from Compact boards: 10
 * sweeps −6.85 / −4.92 / −6.82 %; 15: −7.87 / −5.60 / −7.02; 20: −7.97 / −5.72 / −7.18; 30: −8.24
 * / −6.03 / −7.32. Time +10 to +30 % then. Warm, a level also shortens the cycle in evaluations
 * (ascRunBudget); the levels were not benched again warm.
 */
const PRESETS: readonly Record<string, unknown>[] = [
  {},
  { sweepsPerEvaluation: 15 },
  { sweepsPerEvaluation: 20 },
  { sweepsPerEvaluation: 30, stagnationSweeps: 4000 },
];
const STAGNATION = 2000;

const int = (n: number) => n.toLocaleString("en-US");
const sweepsOf = (params: Record<string, unknown>): number => {
  const n = Number(params.sweepsPerEvaluation ?? SWEEPS);
  return Number.isFinite(n) && n > 0 ? n : SWEEPS;
};

/**
 * A run's parameters: the player's, warm. The temperature is ASC_HEAT times the side of the board
 * the run opens from, unrounded, so the run is exactly the solver's with that parameter. Without a
 * score (no board scored yet) the run opens cold, as the solver's default.
 */
export function ascRunParams(base: Record<string, unknown>, p: Pick<RunProblem, "score">): Record<string, unknown> {
  const s = p.score;
  if (s === null || !Number.isFinite(s) || s <= 0) return base;
  return { ...base, temperature: Math.min(MAX_TEMPERATURE, ASC_HEAT * s) };
}

/** A run's evaluations, one cooling cycle: B = max(100, round(20,000 / n)) for n sweeps per evaluation. */
export const ascRunBudget = (params: Record<string, unknown>): number =>
  Math.max(ASC_MIN_BUDGET, Math.round(ASC_CYCLE_SWEEPS / sweepsOf(params)));

/** The cooling per sweep in percent, as the texts say it: 0.05. */
const COOLING_PCT = Number(((1 - ASC_COOLING) * 100).toPrecision(4));
/** Each level's sweeps per evaluation and run budget, level 0 first. */
const LEVEL_SWEEPS = PRESETS.map(sweepsOf);
const LEVEL_BUDGETS = PRESETS.map(ascRunBudget);
const TOP_STAGNATION = Number(PRESETS.at(-1)!.stagnationSweeps ?? STAGNATION);
const later = (xs: number[]) => {
  const rest = xs.slice(1).map(int);
  return rest.length < 2 ? rest.join("") : `${rest.slice(0, -1).join(", ")} and ${rest.at(-1)}`;
};

const ASC_TEXT =
  "asc (adaptive shrinking container) is a Monte Carlo search with the container as a variable. A sweep tries P moves of single pieces, moves of the container (shift, turn, shrink), and strains that move all centres at once. A strain squeezes the centres along a random axis (and may stretch them across it, keeping the area), squeezes them within a sector, or pulls them all inward while the container shrinks. The pieces never change shape.";

export const ascGame: MethodGame = {
  effect: "You can run asc, a search that loosens the packing and squeezes it again, so tight boards can still shrink.",
  how: (select) => ({
    text: [
      ASC_TEXT,
      `A move is kept only when no piece overlaps another or leaves the container. A move that makes the side larger may still be kept, with the probability below, so early in a run the packing loosens. On a board that is already tight, the side usually stays above your best for the first few hundred evaluations. The temperature T falls by ${COOLING_PCT} % each sweep, so the packing then settles again, and the side can end below where it started.`,
      `The packing is scored every n sweeps, and after each move that takes the container's side below the best so far. Each scoring is one evaluation, and a packing already scored is not scored again. A run is one cooling cycle of about ${int(ASC_CYCLE_SWEEPS)} sweeps, after which T is close to 0. It ends after B evaluations, or earlier after ${int(STAGNATION)} sweeps without a gain (${int(TOP_STAGNATION)} at the top level of asc tuning). The next run starts from your best board.`,
    ],
    math: [
      `keep a move when ${sym("s")}′ ≤ ${sym("s")}, otherwise with probability exp(−(${sym("s")}′ − ${sym("s")}) / ${sym("T")})`,
      `${sym("T")} = ${ASC_HEAT} × ${sym("s", "0")} × ${ASC_COOLING}<sup>${sym("k")}</sup>`,
      `${sym("B")} = round(${int(ASC_CYCLE_SWEEPS)} / ${sym("n")})`,
      `${sym("x")} ← (1 − ${sym("a")}) × ${sym("x")}, ${sym("y")} ← ${sym("y")} / (1 − ${sym("a")})`,
      `${sym("s")} ← (1 − ${sym("a")}) × ${sym("s")}`,
    ],
    vars: [
      [sym("s"), "the container's side before a move"],
      [`${sym("s")}′`, "the side after it"],
      [sym("T"), "the temperature, in units of the side"],
      [sym("s", "0"), "the side of the board the run starts from"],
      [sym("k"), "the sweeps since the run started"],
      [
        sym("B"),
        `the evaluations in one run, ${int(LEVEL_BUDGETS[0])} at first (${later(LEVEL_BUDGETS)} with asc tuning)`,
      ],
      [sym("n"), `sweeps per evaluation, ${int(LEVEL_SWEEPS[0])} at first (${later(LEVEL_SWEEPS)} with asc tuning)`],
      [sym("x"), "a centre's coordinate along the random axis, from the container's centre"],
      [sym("y"), "its coordinate across the axis"],
      [sym("a"), "the move's size, which adapts"],
    ],
    note: select,
  }),
  presets: PRESETS,
  tunedDefaults: { sweepsPerEvaluation: SWEEPS, stagnationSweeps: STAGNATION },
  tunedMeaning: {
    sweepsPerEvaluation: "sweeps between two evaluations",
    stagnationSweeps: "sweeps without a gain before the run ends",
  },
  tunedTime: "up to twice as long",
  runParams: ascRunParams,
  runBudget: ascRunBudget,
  runEnds: `An asc run ends after one cooling cycle of about ${int(ASC_CYCLE_SWEEPS)} sweeps, which is ${int(LEVEL_BUDGETS[0])} evaluations at first and fewer with asc tuning.`,
  endedText: (v, title) =>
    v.evaluations >= v.budget
      ? `The asc run on ${title} finished its cooling cycle of ${int(v.budget)} evaluations.`
      : null,
};
