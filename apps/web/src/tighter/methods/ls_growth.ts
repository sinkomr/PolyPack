import { sym } from "../how";
import type { MethodGame } from "./types";

// ls_growth, from packages/solver/src/methods/ls_growth.ts (its defaults and update rules).

export const lsGrowthGame: MethodGame = {
  effect: "You can run ls_growth, which grows the pieces inside a fixed container until they jam.",
  how: (select) => ({
    text: [
      "ls_growth is Lubachevsky–Stillinger growth. The container stays fixed at the tight fit of the start. The pieces shrink to 0.8 of their size, get random velocities, and then grow at a steady rate while they fly and bounce off each other and the walls, until they jam.",
      "Every I collisions or steps, the pieces are scaled back to their true size and the packing is scored, which is one evaluation. A growth run ends at a jam or after S evaluations without a gain. A run of the method makes 4 growth runs, each from the best packing so far at 0.95 of its size.",
    ],
    math: [
      `${sym("σ")} ← ${sym("σ")} + ${sym("g")} × Δ${sym("t")}`,
      `${sym("u")}′ = 4${sym("g")} − ${sym("u")}`,
      `${sym("s")} ≤ ${sym("L")} / ${sym("σ")}`,
    ],
    vars: [
      [sym("σ"), "the pieces' size as a fraction of their true size"],
      [sym("g"), "the growth rate, 0.01 per unit of time"],
      [`Δ${sym("t")}`, "the time step"],
      [
        sym("u"),
        "two discs' relative speed along the line between them, positive when they part (polygons bounce approximately)",
      ],
      [`${sym("u")}′`, "the same after they collide"],
      [sym("s"), "the side scored"],
      [sym("L"), "the container's fixed side"],
      [sym("I"), "collisions or steps per evaluation, 16 at first (more with ls_growth tuning)"],
      [sym("S"), "evaluations without a gain before a growth run ends, 128 at first (more with ls_growth tuning)"],
    ],
    note: select,
  }),
  /**
   * Bench (presets.ts), 150 evaluations: interval 16 −6.61 / −4.74 / −0.10 %; 24: −8.52 / −6.99 /
   * −1.09; 32: −8.89 / −7.51 / −4.40; 48: −8.96 / −7.78 / −6.70. Time up to 5×: its slowest setting
   * runs 0.3 to 0.7 s an evaluation on 40 to 80 pieces.
   */
  presets: [
    {},
    { evaluationInterval: 24, stagnationEvaluations: 192 },
    { evaluationInterval: 32, stagnationEvaluations: 256 },
    { evaluationInterval: 48, stagnationEvaluations: 384 },
  ],
  tunedDefaults: { evaluationInterval: 16, stagnationEvaluations: 128 },
  tunedMeaning: {
    evaluationInterval: "collisions or steps between two evaluations",
    stagnationEvaluations: "evaluations without a gain before a growth run ends",
  },
  tunedTime: "up to 5 times as long",
};
