import { sym } from "../how";
import type { MethodGame } from "./types";

// asc, from packages/solver/src/methods/asc.ts (its defaults and update rules).

const ASC_TEXT =
  "asc (adaptive shrinking container) is a Monte Carlo search with the container as a variable. A sweep tries P moves of single pieces, moves of the container (shift, turn, shrink), and strains that move all centres at once. A strain squeezes the centres along a random axis (and may stretch them across it, keeping the area), squeezes them within a sector, or pulls them all inward while the container shrinks. The pieces never change shape.";

export const ascGame: MethodGame = {
  effect: "You can run asc, a Monte Carlo search that also strains and shrinks the whole packing.",
  how: (select) => ({
    text: [
      ASC_TEXT,
      "A move is kept only when no piece overlaps another or leaves the container and the side does not grow. The packing is scored once every n sweeps, which is one evaluation. A run ends after 2,000 sweeps without a gain.",
    ],
    math: [
      `${sym("x")} ← (1 − ${sym("a")}) × ${sym("x")}, ${sym("y")} ← ${sym("y")} / (1 − ${sym("a")})`,
      `${sym("s")} ← (1 − ${sym("a")}) × ${sym("s")}`,
      `1 evaluation per ${sym("n")} sweeps`,
    ],
    vars: [
      [sym("x"), "a centre's coordinate along the random axis, from the container's centre"],
      [sym("y"), "its coordinate across the axis"],
      [sym("a"), "the move's size, which adapts"],
      [sym("s"), "the container's side"],
      [sym("n"), "sweeps per evaluation, 10 at first (more with asc tuning)"],
    ],
    note: select,
  }),
  /**
   * Bench (presets.ts), 150 evaluations: 10 sweeps −6.85 / −4.92 / −6.82 %; 15: −7.87 / −5.60 /
   * −7.02; 20: −7.97 / −5.72 / −7.18; 30: −8.24 / −6.03 / −7.32. Time +10 to +30 %.
   */
  presets: [
    {},
    { sweepsPerEvaluation: 15 },
    { sweepsPerEvaluation: 20 },
    { sweepsPerEvaluation: 30, stagnationSweeps: 4000 },
  ],
  tunedDefaults: { sweepsPerEvaluation: 10, stagnationSweeps: 2000 },
  tunedMeaning: {
    sweepsPerEvaluation: "sweeps between two evaluations",
    stagnationSweeps: "sweeps without a gain before the run ends",
  },
  tunedTime: "10 to 30 % longer",
};
