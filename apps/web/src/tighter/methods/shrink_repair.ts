import { sym } from "../how";
import type { MethodGame } from "./types";

// shrink_repair, from packages/solver/src/methods/shrink_repair.ts (its defaults and update rules).
// Its runs use the solver's definition through shrink_repair-run.ts.

export const shrinkRepairGame: MethodGame = {
  effect: "You can run shrink_repair, which shrinks the container and then repairs the overlaps.",
  how: (select) => ({
    text: [
      "shrink_repair shrinks the container's side by the ratio r and scales the centres into it, which makes pieces overlap. It then repairs the overlaps at that fixed size. The repair lowers F below with L-BFGS, moves each piece still in conflict to the best of 72 sampled spots, and raises the weights of pairs that keep overlapping.",
      "When the repaired packing scores smaller, r grows by a quarter, up to 5 %. Otherwise r halves. Once r falls below 0.02 %, it explores instead. It scatters or turns a group of nearby pieces and repairs 1 to 4 times 0.02 % below the current side. After 40 failed explorations it restarts from random positions 2 % larger than the best.",
      "Every repaired packing is scored, and the working packing is also scored after every W × P units of work. Each scoring is one evaluation. It has no rule to stop early, so a run uses its whole budget of 100,000 evaluations.",
    ],
    math: [
      `${sym("s")} ← (1 − ${sym("r")}) × ${sym("s")}`,
      `${sym("F")} = Σ ${sym("w", "ij")} ${sym("d", "ij")}<sup>2</sup> + Σ ${sym("v", "i")} ${sym("p", "ik")}<sup>2</sup>`,
      `${sym("r")} ← min(0.05, 1.25 × ${sym("r")}) after a gain, else ${sym("r")} ← ${sym("r")} / 2`,
      `a scoring every ${sym("W")} × ${sym("P")} units of work, a test of two pieces costing 2${sym("N")} units`,
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
};
