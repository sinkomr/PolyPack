import { sym } from "../how";
import type { MethodGame } from "./types";

// penalty, from packages/solver/src/methods/penalty.ts (its defaults and update rules). Its runs use
// the solver's definition through penalty-run.ts.

const PENALTY_TEXT =
  "penalty treats the container's side and every piece's position and angle as variables. It minimises the side plus a penalty for overlaps and for pieces that stick out of the container, with L-BFGS, a quasi-Newton method that estimates the curvature from its last 12 steps.";

export const penaltyGame: MethodGame = {
  effect: "You can run penalty, which squeezes the container with a smooth overlap penalty and L-BFGS.",
  how: (select) => ({
    text: [
      PENALTY_TEXT,
      "After each accepted L-BFGS step it pushes the pieces apart until nothing overlaps and scores that packing, which is one evaluation. Each solve takes at most I steps. Between solves each term's multiplier λ is updated, and the weight w is multiplied by 4 when the largest violation did not at least halve (an augmented Lagrangian). The run ends after 10 solves.",
    ],
    math: [
      `${sym("F")} = ${sym("s")} + Σ<sub>${sym("k")}</sub> (max(0, ${sym("λ", "k")} + 2${sym("w")}${sym("g", "k")})<sup>2</sup> − ${sym("λ", "k")}<sup>2</sup>) / (4${sym("w")})`,
      `${sym("λ", "k")} ← max(0, ${sym("λ", "k")} + 2${sym("w")}${sym("g", "k")})`,
      `evaluations per run ≈ 10 × (${sym("I")} + 1)`,
    ],
    vars: [
      [sym("F"), "what L-BFGS minimises"],
      [sym("s"), "the container's side"],
      [sym("k"), "one term, for a pair of pieces or for a piece and a wall"],
      [
        sym("g", "k"),
        "its violation, which is how deep the two pieces overlap or how far the piece sticks out (negative when clear)",
      ],
      [sym("λ", "k"), "its multiplier, 0 at first"],
      [sym("w"), "the penalty weight, 10 at first"],
      [sym("I"), "L-BFGS steps at most per solve, 200 at first (more with penalty tuning)"],
    ],
    note: select,
  }),
  /**
   * Bench (presets.ts), 3000 evaluations (the default run ends at 2011): 200 inner iterations
   * −6.07 / −1.84 / −8.71 %; 300: −7.54 / −4.84 / −8.72; 400: −8.40 / −5.42 / −8.80; 600: −8.75 /
   * −7.14 / −8.82. Time up to 3×.
   */
  presets: [{}, { innerIterations: 300 }, { innerIterations: 400 }, { innerIterations: 600 }],
  tunedDefaults: { innerIterations: 200 },
  tunedMeaning: { innerIterations: "L-BFGS steps at most per solve (a run makes 10 solves)" },
  tunedTime: "up to 3 times as long",
};
