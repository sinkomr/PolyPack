import { sym } from "../how";
import type { Var } from "../how";
import type { MethodGame } from "./types";

// mc_compress, from packages/solver/src/methods/mc_compress.ts (its defaults and update rules). It
// is owned from the start, so it has no method card: its explanation is on "10 sweeps per
// evaluation" (upgrades.ts), which quotes the three below.

export const MC_COMPRESS_TEXT: readonly string[] = [
  "mc_compress is a Monte Carlo compression. In each sweep it tries one move for every piece. A move picks a random piece and shifts it a little, or turns it a little. The game keeps a move only when the piece stays inside the container and overlaps nothing.",
  "Every few sweeps it also tries to shrink the container. It pulls all the pieces toward the centre and fits the container around them, and it keeps the result only when nothing overlaps. Now and then it tries a new angle for the container too.",
  "The packing is scored after every few sweeps, and each scoring is one evaluation. A run ends after 500 evaluations without progress. Progress means the score or the container's side fell by more than 10⁻⁹ (relative).",
];
/** The exact rule behind the text above, for the Mechanics page. */
export const MC_COMPRESS_NOTE =
  "A sweep tries P moves. Each move shifts a random piece by up to its step in x and y, or, for half the moves on polygons, turns it by up to its turning step. Every 2 sweeps it pulls every centre toward the container's centre by the fraction f, fits the container tightly around them, and then tries the wall alone at (1 − f) times its side. A change is kept only when nothing overlaps and the side does not grow. Every 10 sweeps it tries a new angle for the container, and every 20 sweeps the steps and f adapt so that about 30 % of tries succeed.";
export const MC_COMPRESS_MATH: readonly string[] = [
  `${sym("c", "i")} ← ${sym("c", "0")} + (1 − ${sym("f")})(${sym("c", "i")} − ${sym("c", "0")})`,
  `${sym("s")} ← (1 − ${sym("f")}) × ${sym("s")}`,
  `1 evaluation per ${sym("n")} sweeps of ${sym("P")} moves`,
];
export const MC_COMPRESS_VARS = (n: string): readonly Var[] => [
  [sym("c", "i"), "the centre of piece i"],
  [sym("c", "0"), "the container's centre"],
  [sym("f"), "the shrink fraction, 1 % at first, adapting up to 5 %"],
  [sym("s"), "the container's side"],
  [sym("n"), `sweeps per evaluation, ${n}`],
  [sym("P"), "pieces"],
];

export const mcCompressGame: MethodGame = {
  /**
   * Bench (presets.ts), 300 evaluations: 10 sweeps −6.79 / −4.04 / −7.30 %; 15: −7.40 / −4.41 /
   * −7.50; 20: −7.46 / −4.55 / −7.62; 30: −7.66 / −4.78 / −7.74. Time per evaluation +0 to +30 %.
   * Level 0 is set by "10 sweeps per evaluation" (see presetParams).
   */
  presets: [
    { sweepsPerEvaluation: 10 },
    { sweepsPerEvaluation: 15 },
    { sweepsPerEvaluation: 20, stagnationEvals: 1000 },
    { sweepsPerEvaluation: 30, stagnationEvals: 2000, maxRestarts: 2 },
  ],
  tunedDefaults: { sweepsPerEvaluation: 10, stagnationEvals: 500, maxRestarts: 0 },
  tunedMeaning: {
    sweepsPerEvaluation: "sweeps of P moves between two evaluations",
    stagnationEvals: "evaluations without progress before the run ends or restarts",
    maxRestarts: "restarts, each from the packing spread 15 % wider, before the run ends",
  },
  tunedTime: "up to 30 % longer",
  /**
   * The solver's own rule ends a run after 500 evaluations without a gain of 10⁻⁹, which a stalled
   * run's tiny gains keep resetting: 1 natural end in 17 runs and 43,000 evaluations (seeds report,
   * 2026-10-22). A new seed at a stall rescues a run stuck in a poor packing (0.053 to 0.076 %), and
   * the end lets Pipelines and Method match move on to another method.
   */
  restartAfter: 500,
};
