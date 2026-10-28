import { sym } from "../how";
import type { MethodGame, RunProblem, RunView } from "./types";

// harden, from packages/solver/src/methods/harden.ts (its defaults and update rules). The game runs
// one pass of its schedule per run, from your board, with a noise and a shape path set by the problem.

/** Momentum steps of one full pass: the solver's compressSteps + morphSteps + settleSteps. */
export const HARDEN_STEPS = 2_500 + 7_500 + 1_500;
/** The settle phase's steps in a full pass (the solver's settleSteps). */
export const HARDEN_SETTLE = 1_500;
/** Momentum steps per evaluation at the solver's defaults (evaluationInterval), tuning level 0. */
export const HARDEN_INTERVAL = 32;
/** From this many pieces a run uses the low noise. */
export const HARDEN_LARGE_P = 60;
/**
 * The noise multiplier ν below HARDEN_LARGE_P pieces (the solver's default, tuned for packing from
 * scratch), and from it. From a board, ν = 8 cut the side by up to 1.7 % in one pass on 40 pieces,
 * but melted the board on 60 to 150, where ν = 2 cut 1.0 to 1.6 % (harden report M3, 2026-10-22).
 */
export const HARDEN_NOISE_SMALL = 8;
export const HARDEN_NOISE_LARGE = 2;
/** From this many sides a piece keeps its true shape through the run (the solver's rigid path). */
export const HARDEN_RIGID_FROM_N = 21;

/** The noise multiplier ν of a run on P pieces. */
export const hardenNoise = (P: number): number => (P < HARDEN_LARGE_P ? HARDEN_NOISE_SMALL : HARDEN_NOISE_LARGE);

/** The share of a regular N-gon's area its inscribed disc covers: π / (N tan(π / N)). */
export const discCover = (N: number): number => Math.PI / (N * Math.tan(Math.PI / N));
/** discCover(HARDEN_RIGID_FROM_N) in percent, rounded down to a tenth: more than any smaller N-gon's. */
export const RIGID_COVER = Math.floor(1000 * discCover(HARDEN_RIGID_FROM_N)) / 10;

/**
 * The shape path of a run on N-gons: rigid from HARDEN_RIGID_FROM_N sides, else discs that harden
 * into the polygons (circles, N = 0, are rigid on either). The rigid path made evaluations 2.6 to 9
 * times cheaper on 21, 36 and 100 sides, with no loss measured (harden report M3, 2026-10-22).
 */
export const hardenPath = (N: number): "rigid" | "harden" => (N >= HARDEN_RIGID_FROM_N ? "rigid" : "harden");

/** The run's parameters: the player's (its tuning level), with the noise and the path for the problem. */
export function hardenRunParams(
  base: Record<string, unknown>,
  p: Pick<RunProblem, "N" | "P">,
): Record<string, unknown> {
  return { ...base, noise: hardenNoise(p.P), path: hardenPath(p.N) };
}

/** Momentum steps per evaluation I of a run's parameters (the solver's default when not set). */
function interval(params: Record<string, unknown>): number {
  const i = params.evaluationInterval;
  return typeof i === "number" && Number.isFinite(i) && i >= 1 ? Math.floor(i) : HARDEN_INTERVAL;
}

/**
 * One pass and the start's scoring: ⌈HARDEN_STEPS / I⌉ + 1 evaluations (361, 241, 181 and 121 at
 * I = 32, 48, 64 and 96). The solver plans as many passes as fit the budget, floor(E / ⌈11,500 /
 * I⌉) of them, so this budget gives exactly one, of I × ⌈11,500 / I⌉ steps, and the run ends by
 * itself after its last step.
 */
export const hardenRunBudget = (params: Record<string, unknown>): number =>
  Math.ceil(HARDEN_STEPS / interval(params)) + 1;

/** Momentum steps of a run: I × ⌈11,500 / I⌉ (11,520 at every tuning level). */
export const hardenRunSteps = (params: Record<string, unknown>): number =>
  interval(params) * (hardenRunBudget(params) - 1);

/**
 * How much larger the run's latest packing is than your board: s_last / s − 1. Null until the run
 * has scored a packing of its own (its first evaluation is your board itself).
 */
export function hardenLarger(v: RunView): number | null {
  const board = v.problemBest ?? v.startScore;
  if (v.evaluations <= 1 || v.last === null || board === null || !(board > 0)) return null;
  return v.last / board - 1;
}

const count = (n: number) => n.toLocaleString("en-US");
const evals = (n: number) => `${count(n)} evaluation${n === 1 ? "" : "s"}`;

/** "its latest packing is 3.8 % larger than your board", or as small as it once below 0.005 %. */
function largerText(x: number): string {
  const pct = 100 * x;
  if (pct < 0.005) return "its latest packing is as small as your board";
  return `its latest packing is ${pct.toFixed(pct >= 1 ? 1 : 2)} % larger than your board`;
}

const SETTLE_SHARE = Math.round((100 * HARDEN_SETTLE) / HARDEN_STEPS);
const PATH_SHARE = 100 - SETTLE_SHARE;

/**
 * The tuning levels: momentum steps per evaluation. Bench (presets.ts), 150 evaluations: 32 steps
 * −0.06 / −0.00 / −0.10 %; 48: −5.95 / −0.00 / −3.65; 64: −9.84 / −7.52 / −8.63; 96: −10.67 /
 * −8.43 / −9.38. That bench stopped before level 0's pass ended (at 361 evaluations), so it measured
 * how far each pass had got, not a better search. With one pass a run, every level makes the same
 * 11,520 steps and ends with the same packing for a seed (harden report M6, 2026-10-22: identical
 * bits at I = 32 and 96 on 21-gons in a 24-gon), in 361, 241, 181 or 121 evaluations. A level only
 * scores fewer of the packings on the way, each evaluation taking up to 3 times as long.
 */
const PRESETS: readonly Record<string, unknown>[] = [
  {},
  { evaluationInterval: 48 },
  { evaluationInterval: 64 },
  { evaluationInterval: 96 },
];
/** Steps per evaluation and evaluations per run at each level, level 0 first. */
const INTERVALS = PRESETS.map(interval);
const BUDGETS = PRESETS.map(hardenRunBudget);
const LEVEL0 = BUDGETS[0];
/** How many times longer an evaluation takes at the top level, at most: I steps and one scoring. */
const SLOWER = INTERVALS[INTERVALS.length - 1] / INTERVALS[0];

/** "a, b, c or d" */
const orList = (xs: readonly string[]) =>
  xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;

export const hardenGame: MethodGame = {
  effect: `Adds harden, which squeezes your board slowly, in runs of ${count(LEVEL0)} evaluations.`,
  how: (select) => ({
    text: [
      "harden is Nakajima's soft-to-rigid method. The pieces push each other apart where they overlap, while the container presses inward. In every step the pieces and the container move a little, and the game adds some random noise.",
      `A run starts from your board. For the first ${PATH_SHARE} % of its steps the noise fades away. For the last ${SETTLE_SHARE} % there is no noise and the pressure drops, so the pieces settle. Every few steps the game spreads the pieces until they just touch and scores that packing, which is one evaluation.`,
      "These packings start larger than your board and shrink as the run goes on, so the gains come near the end. The run line beside Evolve shows how much larger the latest packing is than your board. The run ends after its last step, and the next run starts from your board with a new random seed.",
    ],
    math: [
      `${sym("E")} = Σ ${sym("d")}<sup>2</sup> + Σ ${sym("p")}<sup>2</sup> + ${sym("μ")} × ${sym("L")}`,
      `${sym("v")} ← 0.85 × ${sym("v")} − 0.04 × ∇${sym("E")}, then each piece moves by ${sym("v")} plus random noise of size ${sym("σ")}`,
      `${sym("σ")} = 0.004 × ${sym("ν")} × ${sym("D")} × (1 − ${sym("u")})`,
      `${sym("ν")} = ${HARDEN_NOISE_SMALL} when ${sym("P")} &lt; ${HARDEN_LARGE_P}, and ${sym("ν")} = ${HARDEN_NOISE_LARGE} when ${sym("P")} ≥ ${HARDEN_LARGE_P}`,
      `${sym("μ")} = 0.16 × ${sym("D")}`,
      `${sym("S")} = ${sym("I")} × ⌈${count(HARDEN_STEPS)} / ${sym("I")}⌉ = ${count(hardenRunSteps({}))}`,
      `evaluations per run = ${sym("S")} / ${sym("I")} + 1`,
      `the run's line shows ${sym("s", "last")} / ${sym("s")} − 1, as a percentage`,
    ],
    vars: [
      [sym("E"), "the energy the steps lower"],
      [sym("d"), "how deep two pieces overlap"],
      [sym("p"), "how far a corner of a piece sticks out past a wall"],
      [sym("μ"), "the pressure"],
      [sym("L"), "the container's size (its side, its apothem for 7 or more sides, or its radius for a circle)"],
      [sym("v"), "the velocity of a piece, or of L, which uses 0.02 in place of 0.04"],
      [
        sym("σ"),
        "the standard deviation of a step's noise in each coordinate (a piece's angle gets 1.5 × σ / D radians)",
      ],
      [sym("ν"), "the noise level"],
      [sym("D"), "the diameter of the disc inscribed in a piece"],
      [sym("u"), `how far the run is through its first ${PATH_SHARE} % of steps, from 0 to 1`],
      [sym("P"), "pieces"],
      [sym("S"), "momentum steps per run"],
      [sym("I"), `momentum steps per evaluation, ${HARDEN_INTERVAL} at first (more with harden tuning)`],
      [sym("s", "last"), "the side of the run's latest packing, or its diameter for a circle container"],
      [sym("s"), "your board's side, or its diameter for a circle container"],
    ],
    note: `Polygons with up to ${HARDEN_RIGID_FROM_N - 1} sides start as the disc inscribed in them and turn into their true shape over the first ${PATH_SHARE} % of the steps. Polygons with ${HARDEN_RIGID_FROM_N} or more sides keep their true shape from the start, which makes their steps several times faster. Their inscribed disc already covers more than ${RIGID_COVER} % of their area, so turning it into the polygon would change little. In the settle phase the pressure falls to μ / 10,000. Every I steps the run scales the centres about their mean. The 1 in the evaluations per run is the scoring of your board when the run starts. ${select}`,
  }),
  presets: PRESETS,
  tunedDefaults: { evaluationInterval: HARDEN_INTERVAL },
  tunedMeaning: { evaluationInterval: "momentum steps between two evaluations" },
  // an evaluation is I steps and one scoring, so 96 steps take less than 3 times as long as 32
  tunedTime: `up to ${SLOWER} times as long`,
  tuneNote: `Every level makes the same ${count(hardenRunSteps({}))} steps in a run. A level only changes how often the packing is scored, so a run takes ${orList(BUDGETS.map(count))} evaluations and ends with the same packing. Each evaluation takes up to ${SLOWER} times as long at the top level, which matters only when your computer limits auto-eval.`,
  tuneDetail: `The packing is scored every ${orList(INTERVALS.map(count))} steps. A level changes only how often the packing is scored, not the moves.`,
  runParams: hardenRunParams,
  runBudget: hardenRunBudget,
  runEnds: `A harden run ends after its ${count(hardenRunSteps({}))} momentum steps, ${evals(LEVEL0)} without harden tuning.`,
  runNote: (v) => {
    const x = hardenLarger(v);
    return x === null ? "" : ` · ${largerText(x)}`;
  },
  stepNote: (v) => {
    const x = hardenLarger(v);
    const at = `The run is at ${count(v.evaluations)} of ${evals(v.budget)}`;
    return x === null ? `${at}.` : `${at}, and ${largerText(x)}.`;
  },
  endedText: (v, title) => `The harden run on ${title} ended after its last step, at ${evals(v.evaluations)}.`,
};
