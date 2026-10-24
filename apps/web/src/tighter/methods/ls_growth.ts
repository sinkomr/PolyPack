import type { PackingConfig } from "@polypack/geometry";
import type { ProblemState } from "../game";
import { sym } from "../how";
import type { MethodGame, RunView } from "./types";

// ls_growth, from packages/solver/src/methods/ls_growth.ts (its defaults and update rules).

/** The solver's defaults the How quotes (a test checks them against the solver). */
export const GROWTH_DEFAULTS = {
  /** σ at a run's start is 1 − initialShrink. */
  initialShrink: 0.2,
  growthRate: 0.01,
  jamThreshold: 1e-8,
  jamWindow: 32,
  evaluationInterval: 16,
  stagnationEvaluations: 128,
} as const;

// Measured in the ls_growth report of 2026-10-22 (methods-2026-10-22/ls_growth.md in the Tighter design
// folder), from boards mc_compress had worked, on 21-gons in a 24-gon with 40 pieces and 30-gons in a
// 36-gon with 60, on one shared Apple Silicon machine.

/** Evaluations of a run before its packing can beat the board, its first gain (M1, M3, M4). */
export const GROWTH_SILENT: readonly [number, number] = [85, 220];
/** Evaluations of a whole run of one growth, to its jam (M3, M4). */
export const GROWTH_RUN: readonly [number, number] = [500, 590];
/** Milliseconds an evaluation, early in a run to near its jam (§2.1). */
export const GROWTH_MS: readonly [number, number] = [26, 130];
/** Milliseconds an evaluation of mc_compress at 10 sweeps on the same problems (§2.1). */
export const MC_MS: readonly [number, number] = [2, 7];
/** Evaluations a second one lane ran at level 0, which no auto-eval rate raises (M6). */
export const GROWTH_RATE: readonly [number, number] = [11, 17];
/**
 * The top tuning level on 21-gons in a 24-gon, 40 pieces: a jam as good (2.640 % against 2.625 %) in
 * 185 evaluations against 562, each taking 2.7 times as long (M5).
 */
const TOP_SHARE = "a third";
const TOP_TIME = "about 3 times as long";
const TOP_FACTOR = "about 3 times";
/** The patience the card's note gives as its example (Auto-advance's evaluations without progress). */
const PATIENCE = 2_000;

const int = (n: number) => n.toLocaleString("en-US");
const range = (r: readonly [number, number]) => `${int(r[0])} to ${int(r[1])}`;

// ---------- the series: every run of ls_growth on a problem starts from the same board ----------

/** The most problems whose series board is kept in memory: the oldest stored is dropped beyond it. */
export const GROWTH_BASES = 32;

/** Each problem's series board B, by problem key, oldest stored first. Never saved: a reload starts anew. */
const bases = new Map<string, PackingConfig>();

/**
 * The board an ls_growth run opens from (startFrom): the problem's series board B. A series is the
 * ls_growth runs on a problem since a run of another method last improved its board. While the board
 * is ls_growth's own (`p.run.method`), B stays as it was, so each run is an independent try from the
 * same board and the problem keeps the best of them (applyStep takes only a smaller board). Otherwise
 * the board becomes the new B. A run that finds nothing leaves `p.run` as it was, so the next one
 * still starts from B. A stored board of another shape than the problem's is never used.
 */
export function growthStart(p: ProblemState): PackingConfig {
  const b = bases.get(p.key);
  if (p.run?.method === "ls_growth" && b && b.N === p.N && b.M === p.M && b.P === p.P) return b;
  bases.delete(p.key);
  bases.set(p.key, p.board!);
  while (bases.size > GROWTH_BASES) bases.delete(bases.keys().next().value!);
  return p.board!;
}

// ---------- the countdown: how much larger the growing packing is than the board ----------

/**
 * d = s / b − 1: how much larger the run's latest scored packing (s, RunView.last) is than the
 * problem's best (b). null when either is unknown, when d ≤ 0, or once the run itself has found a
 * packing as small as the board (the board is then the run's own, and the run has nothing to catch up).
 */
export function growthLarger(v: Pick<RunView, "last" | "found" | "problemBest">): number | null {
  const b = v.problemBest;
  if (v.last === null || b === null || !(b > 0)) return null;
  if (v.found !== null && v.found <= b) return null;
  const d = v.last / b - 1;
  return d > 0 ? d : null;
}

/** d as the texts show it: "3.2 %", or "less than 0.1 %". */
export function largerText(d: number): string {
  const pct = d * 100;
  return pct >= 0.1 ? `${pct.toFixed(1)} %` : "less than 0.1 %";
}

export const lsGrowthGame: MethodGame = {
  effect:
    "You can run ls_growth, which regrows the pieces in your container and often jams them denser than mc_compress does.",
  how: (select) => ({
    text: [
      `ls_growth is Lubachevsky–Stillinger growth. The container stays fixed at the tight fit of the run's start. The pieces shrink to ${1 - GROWTH_DEFAULTS.initialShrink} of their size, get random velocities, and grow at a steady rate while they fly and bounce off each other and the walls. The run ends when they jam, which is when ${GROWTH_DEFAULTS.jamWindow} collisions in a row each let them grow by less than 10⁻⁸ of their size. It also ends after S evaluations in a row without a gain.`,
      `Every I steps the pieces are scaled back to their true size and the packing is scored, which is one evaluation. The side scored is at most L / σ, so your board can improve only once L / σ is below b. In tests on 40 and 60 pieces that took ${range(GROWTH_SILENT)} evaluations, and a whole run took ${range(GROWTH_RUN)}. Until the run beats your board, the run line and the message after each click say how much larger its latest packing is.`,
      "Each run grows the pieces once, with a new random seed. Every ls_growth run on a problem starts from the same board B, so each run is a new try and your board keeps the best of them. When a run of another method improves your board, the next ls_growth run takes that board as its B. After the page reloads, the next run takes your board as its B.",
      `An evaluation of ls_growth does far more work than one of mc_compress. In tests on 40 and 60 pieces it took ${range(GROWTH_MS)} ms, where mc_compress took ${range(MC_MS)} ms. Your computer may then run auto-eval more slowly than its rate.`,
    ],
    math: [
      `${sym("σ")} ← ${sym("σ")} + ${sym("g")} × Δ${sym("t")}`,
      `${sym("u")}′ = 4${sym("g")} − ${sym("u")}`,
      `${sym("s")} ≤ ${sym("L")} / ${sym("σ")}`,
      `your board improves when ${sym("s")} &lt; ${sym("b")}`,
      `${sym("d")} = ${sym("s")} / ${sym("b")} − 1`,
      `${sym("B")} ← your board as a run opens, unless ls_growth found your board`,
    ],
    vars: [
      [
        sym("σ"),
        `the pieces' size as a fraction of their true size, ${1 - GROWTH_DEFAULTS.initialShrink} at the start of a run`,
      ],
      [sym("g"), `the growth rate, ${GROWTH_DEFAULTS.growthRate} per unit of time`],
      [`Δ${sym("t")}`, "the time step"],
      [
        sym("u"),
        "two pieces' relative speed along the line between them, positive when they part (polygons bounce approximately)",
      ],
      [`${sym("u")}′`, "the same after they collide"],
      [sym("s"), "the side of the latest packing scored"],
      [sym("L"), "the container's side, fixed at the tight fit of the run's start"],
      [sym("b"), "your board's side"],
      [sym("d"), "how much larger the latest packing is than your board, shown until the run beats your board"],
      [sym("B"), "the board each ls_growth run on this problem starts from"],
      [sym("I"), `steps per evaluation, ${GROWTH_DEFAULTS.evaluationInterval} at first (more with ls_growth tuning)`],
      [
        sym("S"),
        `evaluations without a gain before a run ends, ${GROWTH_DEFAULTS.stagnationEvaluations} at first (more with ls_growth tuning)`,
      ],
    ],
    note: `${select} It pays most on a problem where mc_compress has stopped improving, and mc_compress can then tighten the jammed packing further. Auto-advance counts these evaluations toward its patience, so a patience of ${int(PATIENCE)} lets about ${Math.round(PATIENCE / ((GROWTH_RUN[0] + GROWTH_RUN[1]) / 2))} runs in a row try to beat your board.`,
  }),
  /**
   * One growth per run (`runs: 1`, the solver's default is 4): in the report's M1 the 3 restarts from
   * the run's best took 69 % of a run's evaluations and added 0.054 %. The tuning bench (presets.ts)
   * stopped at 150 evaluations, before any jam (500 to 590 evaluations at level 0): interval 16
   * −6.61 / −4.74 / −0.10 %; 24: −8.52 / −6.99 / −1.09; 32: −8.89 / −7.51 / −4.40; 48: −8.96 / −7.78 /
   * −6.70. The levels reach as good a jam in fewer evaluations and the same time (M5).
   */
  presets: [
    { runs: 1 },
    { runs: 1, evaluationInterval: 24, stagnationEvaluations: 192 },
    { runs: 1, evaluationInterval: 32, stagnationEvaluations: 256 },
    { runs: 1, evaluationInterval: 48, stagnationEvaluations: 384 },
  ],
  tunedDefaults: {
    evaluationInterval: GROWTH_DEFAULTS.evaluationInterval,
    stagnationEvaluations: GROWTH_DEFAULTS.stagnationEvaluations,
  },
  tunedMeaning: {
    evaluationInterval: "steps between two evaluations",
    stagnationEvaluations: "evaluations without a gain before a run ends",
  },
  tunedTime: TOP_TIME,
  tuneNote: `Each level runs more steps in each evaluation. In tests on 40 21-gons in a 24-gon, the top level reached as good a jam in ${TOP_SHARE} of the evaluations, each taking ${TOP_TIME}, so a click goes ${TOP_FACTOR} as far. A second of compute does the same work at every level, so once your computer limits auto-eval the levels give it nothing. In tests one lane ran ${range(GROWTH_RATE)} evaluations of ls_growth a second at level 0 on 40 and 60 pieces.`,
  tuneBase: "the solver's defaults, with one growth a run",
  runEnds:
    "An ls_growth run ends when its pieces jam. Each run of a series starts from the board the series began on, not from the problem's best.",
  startFrom: growthStart,
  runNote: (v) => {
    const d = growthLarger(v);
    return d === null ? "" : ` · ${largerText(d)} larger than your board`;
  },
  stepNote: (v) => {
    const d = growthLarger(v);
    return d === null ? null : `The growing packing is ${largerText(d)} larger than your board.`;
  },
};
