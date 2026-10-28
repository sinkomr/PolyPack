import { sym } from "../how";
import {
  CYCLE_TOLERANCE,
  PENALTY_GAME,
  SETTLE_EVALS,
  SETTLE_PARAMS,
  SQUEEZE,
  SQUEEZE_INTERVAL,
  SQUEEZE_SOLVES,
} from "./penalty-settings";
import type { MethodGame } from "./types";

// penalty, from packages/solver/src/methods/penalty.ts (its defaults and update rules). Its runs use
// the game's definition in penalty-run.ts: a squeeze (the solver's penalty, scoring every 10th
// step), then a settle with mc_compress, in turn. Every number in the texts comes from
// penalty-settings.ts.

const int = (n: number) => n.toLocaleString("en-US");
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
/** The exponent of a power of ten: −6 for 10⁻⁶. */
const exponent = (x: number) => Math.round(Math.log10(x));
const SUPER: Record<string, string> = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};
/** 10⁻⁶ as plain text. */
const TOLERANCE_TEXT = `10${[...String(exponent(CYCLE_TOLERANCE))].map((c) => SUPER[c]).join("")}`;
/** 10<sup>−6</sup> as markup. */
const TOLERANCE_MARKUP = `10<sup>${String(exponent(CYCLE_TOLERANCE)).replace("-", "−")}</sup>`;

/** The tuning bench's checkpoints (see presets below) and its time per evaluation at the top level. */
const TUNE_EARLY = 300;
const TUNE_LATE = 1500;
const TUNED_TIME = "up to 1.5 times as long";

const PENALTY_TEXT =
  "penalty treats the container's side and every piece's position and angle as numbers it can adjust. It looks for a smaller container by adding a cost for overlaps and for pieces that stick out, and then lowering the total cost with a method called L-BFGS.";

const SQUEEZE_DETAIL = `L-BFGS is a quasi-Newton method that estimates the curvature from its last 12 steps. A squeeze is ${SQUEEZE_SOLVES} solves of at most I L-BFGS steps each, from the run's best packing. After every ${ordinal(SQUEEZE_INTERVAL)} step, and at the end of a solve, it moves every centre away from the pieces' mean centre by the smallest common factor that ends all overlaps, fits the container around the pieces and scores that packing, which is one evaluation. Between solves each term's multiplier λ is updated, and the weight w is multiplied by 4 when the largest violation did not at least halve (an augmented Lagrangian).`;

const SETTLE_TEXT = `A run alternates two steps. A squeeze lets the container shrink while pieces overlap a little, and then spreads the pieces out just enough to end every overlap. A settle then runs mc_compress for at most ${int(SETTLE_EVALS)} evaluations, starting from the best packing so far. The run ends when a squeeze and the settle after it make the side smaller by less than ${TOLERANCE_TEXT} (relative).`;
const SETTLE_DETAIL = `The settle uses ${SETTLE_PARAMS.sweepsPerEvaluation} sweeps per evaluation. A squeeze and a settle each score their starting packing first, which is one evaluation.`;

export const penaltyGame: MethodGame = {
  effect: "Adds penalty, which squeezes your board and runs mc_compress between squeezes.",
  how: (select) => ({
    text: [PENALTY_TEXT, SETTLE_TEXT],
    math: [
      `${sym("F")} = ${sym("s")} + Σ<sub>${sym("k")}</sub> (max(0, ${sym("λ", "k")} + 2${sym("w")}${sym("g", "k")})<sup>2</sup> − ${sym("λ", "k")}<sup>2</sup>) / (4${sym("w")})`,
      `${sym("λ", "k")} ← max(0, ${sym("λ", "k")} + 2${sym("w")}${sym("g", "k")})`,
      `evaluations per squeeze ≤ ${sym("I")} + 1`,
      `the run ends when ${sym("s", "after")} ≥ ${sym("s", "before")} × (1 − ${TOLERANCE_MARKUP})`,
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
      [sym("s", "before"), "the side of the run's best packing before a squeeze"],
      [sym("s", "after"), "the side of the run's best packing after that squeeze and its settle"],
    ],
    note: `${SQUEEZE_DETAIL} ${SETTLE_DETAIL} ${select}`,
  }),
  /**
   * Bench (presets.ts protocol, squeeze and settle, one seed for the CPU limit, 2026-10-22, a loaded
   * machine), side change at 300 / 1500 evaluations. 200 inner iterations: −6.27 / −8.80 %, −2.92 /
   * −7.83, −8.62 / −8.79; 300: −7.45 / −8.51, −4.89 / −7.91, −8.77 / −8.91; 400: −8.49 / −8.77,
   * −5.21 / −7.86, −8.81 / −8.81; 600: −8.69 / −8.76, −7.42 / −7.76, −8.88 / −8.96. Each level
   * leads the one below at 300, where the first squeeze decides, and all are within 0.3 points at
   * 1500, where the settles' randomness decides, so the plan's ladder is kept. CPU per evaluation
   * over the 1500: +7 to +43 % at 600. The old bench (every step scored, separate repair, no settle):
   * 200 −6.07 / −1.84 / −8.71 % at 3000, 600 −8.75 / −7.14 / −8.82.
   */
  presets: [
    { ...PENALTY_GAME },
    { ...PENALTY_GAME, innerIterations: 300 },
    { ...PENALTY_GAME, innerIterations: 400 },
    { ...PENALTY_GAME, innerIterations: 600 },
  ],
  tunedDefaults: { innerIterations: 200 },
  tunedMeaning: { innerIterations: `L-BFGS steps at most per solve (a squeeze makes ${SQUEEZE_SOLVES} solves)` },
  tunedTime: TUNED_TIME,
  tuneBase: "the settings on penalty's card",
  tuneEffect: "Each level lets penalty squeeze the board further in every solve.",
  tuneNote: `In tests, each level shrank the side more than the level below in the first ${int(TUNE_EARLY)} evaluations. After ${int(TUNE_LATE)} evaluations the levels were close to each other. An evaluation takes ${TUNED_TIME} at the top level, which matters only when your computer limits auto-eval.`,
  tuneDetail: `In tests from a compacted board, each level shrank the side more than the level below in the first ${int(TUNE_EARLY)} evaluations, on all three test problems (40 21-gons in a 24-gon, 80 36-gons in a 33-gon and 30 heptagons in a heptagon). After ${int(TUNE_LATE)} evaluations the levels were within 0.3 percentage points of each other. An evaluation takes ${TUNED_TIME} at the top level.`,
  runEnds: `A penalty run ends when a squeeze and the mc_compress evaluations after it make the side smaller by less than ${TOLERANCE_TEXT} (relative).`,
  runNote: (v) => {
    const s = v.stage;
    if (s?.method === SQUEEZE) return ` · squeeze ${s.count}`;
    if (s?.method === "mc_compress") return ` · settle ${s.count} with mc_compress`;
    return "";
  },
  endedText: (v, title) =>
    v.stage && v.evaluations < v.budget
      ? `The penalty run on ${title} ended after ${int(v.evaluations)} evaluations, because squeeze ${v.stage.count} and the settle after it shrank the side by less than ${TOLERANCE_TEXT} (relative).`
      : null,
};
