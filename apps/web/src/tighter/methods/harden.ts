import { sym } from "../how";
import type { MethodGame, RunView } from "./types";

// harden, from packages/solver/src/methods/harden.ts (its defaults and update rules).

/**
 * How much larger the run's latest packing is than your board: s_last / s − 1. Null until the run
 * has scored a packing of its own (its first evaluation is your board itself).
 */
export function hardenLarger(v: RunView): number | null {
  const board = v.problemBest ?? v.startScore;
  if (v.evaluations <= 1 || v.last === null || board === null || !(board > 0)) return null;
  return v.last / board - 1;
}

const count = (n: number) => n.toLocaleString("en-US");
const evals = (n: number) => `${count(n)} evaluation${n === 1 ? "" : "s"}`;

/** "its latest packing is 3.8 % larger than your board", or as small as it once below 0.005 %. */
function largerText(x: number): string {
  const pct = 100 * x;
  if (pct < 0.005) return "its latest packing is as small as your board";
  return `its latest packing is ${pct.toFixed(pct >= 1 ? 1 : 2)} % larger than your board`;
}

export const hardenGame: MethodGame = {
  effect: "You can run harden, which packs discs and hardens them into the true pieces.",
  how: (select) => ({
    text: [
      "harden is Nakajima's soft-to-rigid method. Each piece starts as the disc inscribed in it and turns into its true polygon over the run, while momentum descent pushes the container in. A schedule has three phases. Compress squeezes the discs under 3 times the pressure μ, morph turns the discs into polygons, and settle relaxes the true shapes without noise as the pressure falls.",
      "Every I momentum steps, the pieces are moved apart from their mean centre until nothing overlaps, and that packing is scored, which is one evaluation. A full schedule takes about 11,500 steps, and a run of 100,000 evaluations repeats it many times.",
    ],
    math: [
      `${sym("E")} = Σ ${sym("d")}<sup>2</sup> + Σ ${sym("p")}<sup>2</sup> + ${sym("μ")} × ${sym("L")}`,
      `${sym("v")} ← 0.85 × ${sym("v")} − 0.04 × ∇${sym("E")}, then each pose moves by ${sym("v")} plus noise`,
      `evaluations per schedule = ⌈11,500 / ${sym("I")}⌉`,
    ],
    vars: [
      [sym("E"), "the energy the descent lowers"],
      [sym("d"), "how deep two soft pieces overlap"],
      [sym("p"), "how far a corner of a piece sticks out past a wall"],
      [sym("μ"), "the pressure, 0.16"],
      [sym("L"), "the container's size (its side, or its apothem for 7 or more sides)"],
      [sym("v"), "the velocity of a piece (or of L)"],
      [sym("I"), "momentum steps per evaluation, 32 at first (more with harden tuning)"],
    ],
    note: select,
  }),
  /**
   * Bench (presets.ts), 150 evaluations: 32 steps −0.06 / −0.00 / −0.10 % (its first schedule ends
   * after about 360 evaluations); 48: −5.95 / −0.00 / −3.65; 64: −9.84 / −7.52 / −8.63; 96: −10.67 /
   * −8.43 / −9.38. Time up to 4×.
   */
  presets: [{}, { evaluationInterval: 48 }, { evaluationInterval: 64 }, { evaluationInterval: 96 }],
  tunedDefaults: { evaluationInterval: 32 },
  tunedMeaning: { evaluationInterval: "momentum steps between two evaluations" },
  tunedTime: "up to 4 times as long",
  runNote: (v) => {
    const x = hardenLarger(v);
    return x === null ? "" : ` · ${largerText(x)}`;
  },
  stepNote: (v) => {
    const x = hardenLarger(v);
    const at = `The run is at ${count(v.evaluations)} of ${evals(v.budget)}`;
    return x === null ? `${at}.` : `${at}, and ${largerText(x)}.`;
  },
};
