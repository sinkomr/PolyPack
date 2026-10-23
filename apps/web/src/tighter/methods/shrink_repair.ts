import { sym } from "../how";
import type { MethodGame, RunView } from "./types";

// shrink_repair, from packages/solver/src/methods/shrink_repair.ts (its defaults and update rules).
// The game ends its runs by its own stop rule (SHRINK_STALL_*, applied by shrink_repair-run.ts on
// the worker side).

/** The stop rule: a run ends after this many of its evaluations without progress. */
export const SHRINK_STALL_EVALS = 1000;
/**
 * Progress is a score at or below (1 − this) times the score at the run's last progress (the
 * start's score before any).
 */
export const SHRINK_STALL_TOLERANCE = 1e-5;

const int = (n: number) => n.toLocaleString("en-US");
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
/** A power of ten in plain text, 1e-5 → "10⁻⁵". */
function tenText(x: number): string {
  const e = Math.round(Math.log10(x));
  const digits = [...String(Math.abs(e))].map((d) => SUPERSCRIPT[+d]).join("");
  return `10${e < 0 ? "⁻" : ""}${digits}`;
}
/** A power of ten in How markup, 1e-5 → "10<sup>−5</sup>". */
const tenMath = (x: number) => `10<sup>${String(Math.round(Math.log10(x))).replace("-", "−")}</sup>`;

const STALL = int(SHRINK_STALL_EVALS);
const TOL = tenText(SHRINK_STALL_TOLERANCE);

/** The run-end sentence, unless the run used its whole budget. */
function ended(v: RunView, title: string): string | null {
  if (v.evaluations >= v.budget) return null;
  return `The run on ${title} ended after ${int(v.evaluations)} evaluations, because its last ${STALL} did not make its best score ${TOL} (relative) smaller.`;
}

export const shrinkRepairGame: MethodGame = {
  effect: "You can run shrink_repair, which shrinks the container and then repairs the overlaps.",
  how: (select) => ({
    text: [
      "shrink_repair shrinks the container's side by the ratio r and scales the centres into it, which makes pieces overlap. It then repairs the overlaps at that fixed size. The repair lowers F below with L-BFGS, moves each piece still in conflict to the best of 72 sampled spots, and raises the weights of pairs that keep overlapping.",
      "When the repaired packing scores smaller, r grows by a quarter, up to 5 %. Otherwise r halves. Once r falls below 0.02 %, it explores instead. It scatters or turns a group of nearby pieces and repairs 1 to 4 times 0.02 % below the current side. After 40 failed explorations it restarts from random positions 2 % larger than the best.",
      `Every repaired packing is scored, and the working packing is also scored after every W × P units of work. Each scoring is one evaluation. A run ends by itself after ${STALL} evaluations without progress. Progress is a score at least ${TOL} (relative) below the score at the run's last progress, or below the start's score before any.`,
    ],
    math: [
      `${sym("s")} ← (1 − ${sym("r")}) × ${sym("s")}`,
      `${sym("F")} = Σ ${sym("w", "ij")} ${sym("d", "ij")}<sup>2</sup> + Σ ${sym("v", "i")} ${sym("p", "ik")}<sup>2</sup>`,
      `${sym("r")} ← min(0.05, 1.25 × ${sym("r")}) after a gain, else ${sym("r")} ← ${sym("r")} / 2`,
      `a scoring every ${sym("W")} × ${sym("P")} units of work, a test of two pieces costing 2${sym("N")} units`,
      `progress when ${sym("x")} ≤ (1 − ${tenMath(SHRINK_STALL_TOLERANCE)}) × ${sym("s", "ref")}, and then ${sym("s", "ref")} ← ${sym("x")} and ${sym("n")} ← 0`,
      `the run ends when ${sym("n")} = ${STALL}`,
    ],
    vars: [
      [sym("s"), "the container's side"],
      [sym("r"), "the shrink ratio, 1 % at first"],
      [sym("F"), "what the repair lowers to 0"],
      [sym("w", "ij"), "the weight of pieces i and j, raised while they keep overlapping"],
      [sym("d", "ij"), "how deep pieces i and j overlap"],
      [sym("v", "i"), "the weight of piece i against the walls"],
      [sym("p", "ik"), "how far piece i sticks out past wall k"],
      [sym("W"), "units of work per piece between two scorings, 4,000 at first (more with shrink_repair tuning)"],
      [sym("P"), "pieces"],
      [sym("N"), "sides of a piece (1 unit per test for circles)"],
      [sym("x"), "the score of an evaluation of the run"],
      [sym("s", "ref"), "the score at the run's last progress, the start's score at first"],
      [sym("n"), "the run's evaluations since its last progress"],
    ],
    note: select,
  }),
  /**
   * Bench (presets.ts), 300 evaluations: work 4000 −8.84 / −7.86 / −8.48 %; 6000: −9.12 / −7.84 /
   * −8.60; 9000: −9.11 / −7.84 / −8.70; 14000: −10.33 / −7.85 / −8.74. Time up to 2.5×.
   */
  presets: [{}, { evaluationWork: 6000 }, { evaluationWork: 9000 }, { evaluationWork: 14000 }],
  tunedDefaults: { evaluationWork: 4000 },
  tunedMeaning: { evaluationWork: "units of work per piece between two scorings of the working packing" },
  tunedTime: "up to 2.5 times as long",
  runEnds: `A shrink_repair run ends once its last ${STALL} evaluations have not made its best score ${TOL} (relative) smaller.`,
  endedText: ended,
};
