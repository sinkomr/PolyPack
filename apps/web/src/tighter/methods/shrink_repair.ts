import { sym } from "../how";
import type { MethodGame, RunView } from "./types";

// shrink_repair, from packages/solver/src/methods/shrink_repair.ts (its defaults and update rules).
// The game runs it with its own setting (SHRINK_BASE, every tuning level) and its own stop rule
// (SHRINK_STALL_*, applied by shrink_repair-run.ts on the worker side).

/**
 * The game's setting of shrink_repair, at every tuning level: small shrink ratios, repairs that give
 * up after one strike, and no restart from random poses (the next run, from the problem's best board
 * with a new seed, is the restart). These are the solver's own parameters, so the site's solver
 * replays every run. At the solver's defaults a run from a board the player has worked spends its
 * first 500 to 1,000 evaluations on repairs at 1 %, 0.5 %, 0.25 % … below the board that fail, and
 * shows nothing (methods-2026-10-22/shrink_repair.md).
 *
 * Bench (2026-10-22, CPU times under load): 1,000 evaluations from boards mc_compress had worked for
 * 8,000 evaluations, seeds 4 to 6, on 40 21-gons in a 24-gon, 60 33-gons in a 27-gon and 80 36-gons
 * in a 30-gon. Side cut, median of the 9 runs: this setting 0.166 % (per problem 0.219 / 0.167 /
 * 0.006), the solver's defaults 0.007 % (0.007 / 0.105 / 0), a new mc_compress run 0.017 % (0.017 /
 * 0.063 / 0.013). First gain after 17 to 188 evaluations, against 434 to 730 or none. On boards
 * after Compact and 200 evaluations (seeds 4, 5) the cut was 3.75 / 1.67 / 4.72 % against 3.67 /
 * 2.78 / 4.54 % at the solver's defaults. An evaluation costs 4 to 13 % more than at the defaults.
 */
export const SHRINK_BASE = {
  shrinkRatio: 0.001,
  maxShrinkRatio: 0.004,
  minShrinkRatio: 0.0001,
  strikes: 1,
  patience: 6,
  explorePatience: 12,
  restartAfter: 0,
} as const;

/** The stop rule: a run ends after this many of its evaluations without progress. */
export const SHRINK_STALL_EVALS = 1000;
/**
 * Progress is a score at or below (1 − this) times the score at the run's last progress (the
 * start's score before any).
 */
export const SHRINK_STALL_TOLERANCE = 1e-5;

/** The solver's defaults the card quotes; a test checks them against the solver's own. */
export const SHRINK_SOLVER = { globalSamples: 48, localSamples: 24, evaluationWork: 4000 } as const;

// Constants of executeShrinkRepair's code that the card quotes: r grows by 1.25 after a smaller
// packing and halves after a failed repair; an exploring repair aims 1 to 4 times the smallest ratio
// below the side; a round counts as progress when it lowers the least overlap by 0.1 %; a repair
// stops after 4 × strikes × patience rounds in all.
const GROWTH = 1.25;
const EXPLORE_MAX = 4;
const ROUND_GAIN = 0.001;
const ROUND_CAP = 4;

const int = (n: number) => n.toLocaleString("en-US");
/** A ratio as a percentage: 0.004 → "0.4 %". */
const pct = (x: number) => `${+(x * 100).toPrecision(6)} %`;
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
/** A power of ten in plain text, 1e-5 → "10⁻⁵". */
function tenText(x: number): string {
  const e = Math.round(Math.log10(x));
  const digits = [...String(Math.abs(e))].map((d) => SUPERSCRIPT[+d]).join("");
  return `10${e < 0 ? "⁻" : ""}${digits}`;
}
/** A power of ten in How markup, 1e-5 → "10<sup>−5</sup>". */
const tenMath = (x: number) => `10<sup>${String(Math.round(Math.log10(x))).replace("-", "−")}</sup>`;

/** How much longer an evaluation takes at the top tuning level (CPU time, from the bench on `presets`). */
const TUNE_TIME = "up to 2.8 times as long";

const B = SHRINK_BASE;
const STALL = int(SHRINK_STALL_EVALS);
const TOL = tenText(SHRINK_STALL_TOLERANCE);

/** The run-end sentence, unless the run used its whole budget. */
function ended(v: RunView, title: string): string | null {
  if (v.evaluations >= v.budget) return null;
  return `The run on ${title} ended after ${int(v.evaluations)} evaluations, because its last ${STALL} did not make its best score ${TOL} (relative) smaller.`;
}

export const shrinkRepairGame: MethodGame = {
  effect: "You can run shrink_repair, which shrinks the container and then moves the pieces until none overlap.",
  how: (select) => ({
    text: [
      `shrink_repair makes the container's side smaller by the ratio r and scales the centres into it, so that pieces overlap. It then repairs the overlaps at that fixed side. Each round of the repair moves every piece that still overlaps to the best of ${SHRINK_SOLVER.globalSamples + SHRINK_SOLVER.localSamples} sampled spots, lowers F below with L-BFGS, and raises the weights of the pairs that still overlap.`,
      `A repair that ends with no overlap is scored. When the packing got smaller, r grows by a quarter, up to ${pct(B.maxShrinkRatio)}. A repair fails after ${B.patience} rounds in a row that do not lower the overlap by ${pct(ROUND_GAIN)}, or after ${ROUND_CAP * B.strikes * B.patience} rounds in all, and then r halves. Once r is below ${pct(B.minShrinkRatio)}, shrink_repair explores. It scatters or turns a group of nearby pieces and repairs 1 to ${EXPLORE_MAX} times ${pct(B.minShrinkRatio)} below the current side. Such a repair fails the same way after ${B.explorePatience} rounds in a row, or ${ROUND_CAP * B.strikes * B.explorePatience} in all. It explores until it finds a smaller packing, and then it shrinks again.`,
      `The working packing is also scored after every W × P units of work, once its centres are spread until nothing overlaps. Each scoring is one evaluation. A run ends by itself after ${STALL} evaluations without progress. Progress is a score at least ${TOL} (relative) below the reference score. The reference is the start's score at first, and each progress makes its score the reference. The next run starts from the best board with a new random seed.`,
    ],
    math: [
      `${sym("s")}′ = (1 − ${sym("r")}) × ${sym("s")}`,
      `${sym("F")} = Σ ${sym("w", "ij")} ${sym("d", "ij")}<sup>2</sup> + Σ ${sym("v", "i")} ${sym("p", "ik")}<sup>2</sup>`,
      `${sym("r")} ← min(${B.maxShrinkRatio}, ${GROWTH} × ${sym("r")}) after a smaller packing, ${sym("r")} ← ${sym("r")} / 2 after a failed repair`,
      `explore when ${sym("r")} &lt; ${B.minShrinkRatio}, at ${sym("s")}′ = (1 − ${sym("u")} × ${B.minShrinkRatio}) × ${sym("s")}`,
      `a scoring every ${sym("W")} × ${sym("P")} units of work, a test of two pieces costing 2${sym("N")} units`,
      `progress when ${sym("x")} ≤ (1 − ${tenMath(SHRINK_STALL_TOLERANCE)}) × ${sym("s", "ref")}, and then ${sym("s", "ref")} ← ${sym("x")} and ${sym("n")} ← 0`,
      `the run ends when ${sym("n")} = ${STALL}`,
    ],
    vars: [
      [sym("s"), "the side of the current packing"],
      [`${sym("s")}′`, "the side the repair works at"],
      [sym("r"), `the shrink ratio, ${pct(B.shrinkRatio)} at first`],
      [sym("F"), "what the repair lowers to 0"],
      [sym("w", "ij"), "the weight of pieces i and j, raised while they keep overlapping"],
      [sym("d", "ij"), "how deep pieces i and j overlap"],
      [sym("v", "i"), "the weight of piece i against the walls"],
      [sym("p", "ik"), "how far piece i sticks out past wall k"],
      [sym("u"), `a random number from 1 to ${EXPLORE_MAX}`],
      [
        sym("W"),
        `units of work per piece between two scorings, ${int(SHRINK_SOLVER.evaluationWork)} at first (more with shrink_repair tuning)`,
      ],
      [sym("P"), "pieces"],
      [sym("N"), "sides of a piece (1 unit per test for circles)"],
      [sym("x"), "the score of an evaluation of the run"],
      [sym("s", "ref"), "the reference score, the start's at first and then the score at the run's last progress"],
      [sym("n"), "the run's evaluations since its last progress"],
    ],
    note: select,
  }),
  /**
   * Bench (see SHRINK_BASE), worked boards, 1,000 evaluations, side cut in % per problem [seeds 4
   * to 6], then the median and mean of the 9 runs:
   * - work 4000: [0.029 0.745 0.219] [0.167 0.308 0.166] [0.007 0.006 0.002], 0.166, 0.183;
   * - 6000: [0.010 0.977 0.127] [0.214 0.793 0.995] [0.017 0.015 0.125], 0.127, 0.364;
   * - 9000: [1.037 0.269 1.189] [0.264 0.500 0.378] [0.019 0.020 0.109], 0.269, 0.421;
   * - 14000: [0.227 1.616 1.059] [0.974 0.225 0.957] [0.022 0.131 0.026], 0.227, 0.582.
   * Every level is kept: each median is within 0.05 points of the level below's or above it, and
   * the means rise. A single run's cut ranges from 0.01 to 1.6 %, so a median of 3 seeds per problem
   * is noise (6000 lost 0.09 points on the 40 pieces, 9000 lost 0.42 on the 60). CPU per
   * evaluation 1.64 / 2.04 / 2.57 ms at 4000, 2.20 / 2.77 / 3.47 at 6000, 3.06 / 3.83 / 4.89 at
   * 9000 and 4.53 / 5.54 / 7.23 at 14000, up to 2.8 times level 0's.
   */
  presets: [
    { ...SHRINK_BASE },
    { ...SHRINK_BASE, evaluationWork: 6000 },
    { ...SHRINK_BASE, evaluationWork: 9000 },
    { ...SHRINK_BASE, evaluationWork: 14000 },
  ],
  tunedDefaults: { evaluationWork: SHRINK_SOLVER.evaluationWork },
  tunedMeaning: { evaluationWork: "units of work per piece between two scorings of the working packing" },
  tunedTime: TUNE_TIME,
  tuneBase: "the setting on the shrink_repair card",
  tuneNote: `A level was kept only where its median cut of the side over 1,000 evaluations was at least that of the level below (within 0.05 percentage points). The runs started from boards that mc_compress had worked for 8,000 evaluations, 3 runs on each of 40 21-gons in a 24-gon, 60 33-gons in a 27-gon and 80 36-gons in a 30-gon. An evaluation takes ${TUNE_TIME} at the top level, which matters only when your computer limits auto-eval.`,
  runEnds: `A shrink_repair run ends once its last ${STALL} evaluations have not made its best score ${TOL} (relative) smaller.`,
  endedText: ended,
};
