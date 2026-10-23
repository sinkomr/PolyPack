import type { PackingConfig } from "@polypack/geometry";
import type { ProblemState } from "../game";
import { sym } from "../how";
import type { MethodGame, RunView } from "./types";

// ls_growth, from packages/solver/src/methods/ls_growth.ts (its defaults and update rules).

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
  tunedDefaults: { evaluationInterval: 16, stagnationEvaluations: 128 },
  tunedMeaning: {
    evaluationInterval: "collisions or steps between two evaluations",
    stagnationEvaluations: "evaluations without a gain before a growth run ends",
  },
  tunedTime: "up to 5 times as long",
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
