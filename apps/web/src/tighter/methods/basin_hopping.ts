import { sym } from "../how";
import type { Var } from "../how";
import type { MethodGame, RunView } from "./types";

// basin_hopping, from packages/solver/src/methods/basin_hopping.ts (its defaults and update rules).

/**
 * The solver's defaults that the texts below quote (packages/solver/src/methods/basin_hopping.ts).
 * This file may not import the solver, so a test checks them against the solver's own.
 */
export const BASIN_DEFAULTS = {
  localEvals: 150,
  refinementEvals: 3000,
  kickMagnitude: 0.35,
  kickFraction: 0.4,
  rotationMagnitude: Math.PI / 2,
  restartStrength: 3,
  targetAcceptance: 0.5,
  adaptationRate: 0.15,
  weightFloor: 0.2,
  weights: { kick: 4, swap: 1, cluster: 2, reinsert: 2, restart: 0.3, peel: 2, cleave: 2 },
} as const;
/** The bounds the solver keeps the kick size within (not parameters). */
export const BASIN_KICK_BOUNDS = [0.001, 10] as const;
/** Two sides closer than this are a tie (the solver's IMPROVEMENT_THRESHOLD). */
export const BASIN_TIE = 1e-9;

/**
 * L: the evaluations of a game run, the start's scoring included. Runs this short end by themselves,
 * so each one starts again from the problem's best board with a new seed, ends with the solver's own
 * refinement, and lets Pipelines and Method match move on. Measured from game boards (basin_hopping
 * report, 2026-10-22): short runs in sequence, each from the best, shrank the side about as much as
 * one long run in the same evaluations, or more (runs of 1,000: 5.10 against 4.81 % on 26 squares,
 * 0.27 against 0.28 % on 40 21-gons; runs of 750: 0.67 against 0.54 % on 80 33-gons), and paid 1.5
 * to 3 times its RP under the points of that day.
 */
export const BASIN_RUN_EVALS = 1000;

/**
 * The settings every game run adds to the tuning level's. One evaluation for the lattice slice
 * (the solver's least) instead of 24, which on most game boards scored lattices 0.9 to 8.4 % worse
 * than the board. A temperature of 0, so only a smaller packing is kept: at 0.04 side units, four
 * of six kicks on 60 24-gons in a 90-gon were kept uphill and the packing never came back to its
 * best. No pool of local optima, whose emissions would cost up to 8 evaluations a run for nothing
 * the game uses.
 */
export const BASIN_GAME_PARAMS = { seedEvals: 1, temperature: 0, poolLimit: 0 } as const;

/**
 * R: the evaluations the solver keeps for its final refinement of a run of `evals`, its start's
 * scoring included: min(refinementEvals, ⌊(L − 1) / 6⌋), a sixth of what the method itself may do.
 */
export const refineEvals = (evals: number, refinementEvals: number = BASIN_DEFAULTS.refinementEvals): number =>
  Math.max(0, Math.min(refinementEvals, Math.floor((evals - 1) / 6)));

/** R for a game run: 166. */
export const BASIN_REFINE_EVALS = refineEvals(BASIN_RUN_EVALS);

/**
 * How much longer an evaluation takes than one of mc_compress at 10 sweeps, measured on game boards
 * on a shared machine (9 to 26 ms against 1.2 to 6.3 ms, basin_hopping report, 2026-10-22).
 */
export const BASIN_SLOWER = [2.5, 6] as const;

const int = (n: number) => n.toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
const deg = (rad: number) => `${Math.round((rad * 180) / Math.PI)}°`;
/** 10⁻⁹ as How markup. */
const tenTo = (x: number) => `10<sup>${String(Math.round(Math.log10(x))).replace("-", "−")}</sup>`;

const LABEL = "basin_hopping";
const L = BASIN_RUN_EVALS;
const R = BASIN_REFINE_EVALS;
const D = BASIN_DEFAULTS;

/** The moves as the How names them, in the solver's order. */
const MOVES: Record<keyof typeof BASIN_DEFAULTS.weights, string> = {
  kick: "the kick",
  swap: "the swap",
  cluster: "the cluster move",
  reinsert: "the reinsert",
  restart: "the restart",
  peel: "the peel",
  cleave: "the cleave",
};

const list = (xs: readonly string[]) =>
  xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** w's meaning: the moves grouped by base weight, heaviest first. */
function weightsText(): string {
  const byWeight = new Map<number, string[]>();
  for (const [move, w] of Object.entries(D.weights) as [keyof typeof MOVES, number][])
    byWeight.set(w, [...(byWeight.get(w) ?? []), MOVES[move]]);
  const groups = [...byWeight.entries()].sort((a, b) => b[0] - a[0]).map(([w, ms]) => `${w} for ${list(ms)}`);
  return `a move's base weight, ${list(groups)}`;
}

/**
 * What the run is doing, for the run line: nothing during its first evaluations (the start and the
 * lattice), then the repair of its start (its first penalty solve), then each hop (each later penalty
 * solve, counted from 1), and its final refinement once fewer than R evaluations are left. A
 * reinsert's scorings before its penalty solve still show the hop before it.
 */
export function basinRunNote(v: RunView): string {
  const s = v.stage;
  if (!s || s.method !== "penalty") return "";
  const refinement = typeof v.params.refinementEvals === "number" ? v.params.refinementEvals : D.refinementEvals;
  const r = refineEvals(v.budget, refinement);
  if (r > 0 && v.evaluations > v.budget - r) return " · refining the best";
  return s.count === 1 ? " · repairing the start" : ` · hop ${int(s.count - 1)}`;
}

const VARS = (tuned: number | undefined): readonly Var[] => [
  [sym("s"), "the side of the current packing"],
  [`${sym("s")}′`, "the side of the packing after the hop's repair"],
  [
    sym("m"),
    `the kick size in piece sides, ${D.kickMagnitude} at the start of each run${tuned === undefined ? "" : ` (${tuned} with ${LABEL} tuning)`}, kept between ${BASIN_KICK_BOUNDS[0]} and ${BASIN_KICK_BOUNDS[1]}`,
  ],
  [sym("a"), "1 if the hop was kept, else 0"],
  [sym("w"), weightsText()],
  [sym("q"), "how often the move's hops were kept lately, 0 at the start of each run"],
  [sym("R"), "the evaluations left for the final refinement"],
  [sym("L"), `the evaluations of a run, ${int(L)}`],
];

/** Kicks of 0.25 instead of 0.35: the tuning level (see presets below). */
const PRESETS: readonly Record<string, unknown>[] = [{}, { kickMagnitude: 0.25 }];

export const basinHoppingGame: MethodGame = {
  effect: `Adds ${LABEL}, which moves several pieces at once and works best on pieces with few sides.`,
  how: (select) => ({
    text: [
      `A ${LABEL} run lasts ${int(L)} evaluations and starts from the problem's best board. It first repairs that board, and then it makes hops until ${int(R)} evaluations are left. It uses those last evaluations to refine the best packing it found, and then the run ends by itself.`,
      `Each hop changes the packing with one of ${Object.keys(D.weights).length} moves. The main move, the kick, shifts about ${pct(D.kickFraction)} of the pieces and turns them a little. A short repair then removes the overlaps and squeezes the container, and the game keeps the hop only when the packing got smaller. Moves whose hops were kept lately are chosen more often.`,
      `The method works best on pieces with few sides, such as squares. An evaluation takes ${BASIN_SLOWER[0]} to ${BASIN_SLOWER[1]} times as long as one of mc_compress, which matters only when your computer limits auto-eval.`,
    ],
    math: [
      `kept when ${sym("s")}′ &lt; ${sym("s")} − ${tenTo(BASIN_TIE)}`,
      `${sym("m")} ← ${sym("m")} × exp(${D.adaptationRate} × (${sym("a")} − ${D.targetAcceptance}))`,
      `weight = ${sym("w")} × (${D.weightFloor} + ${sym("q")})`,
      `${sym("q")} ← ${Math.round((1 - D.adaptationRate) * 100) / 100} × ${sym("q")} + ${D.adaptationRate} × ${sym("a")}`,
      `${sym("R")} = min(${int(D.refinementEvals)}, ⌊(${sym("L")} − 1) / 6⌋) = ${int(R)}`,
    ],
    vars: VARS(PRESETS[1]?.kickMagnitude as number | undefined),
    note: `The start is scored, and so is one lattice packing. The repair of the start and of each hop is a penalty solve of at most ${int(D.localEvals)} evaluations, and a tighter penalty solve of the last ${int(R)} evaluations does the refinement. The kick turns pieces by up to ${deg(D.rotationMagnitude)} and shifts them by up to m in x and y. The swap exchanges the angles of two pieces. The cluster move turns the pieces near one piece about their centre. The reinsert moves the piece whose removal shrinks the container most to a free spot, and finding that piece scores the packing once without each piece. The peel moves the outer layer of pieces along one wall to free spots further in. The cleave opens a cross-shaped gap at a corner of one piece and moves the piece whose removal shrinks the container most into it. The restart kicks every piece of the start or of the lattice packing ${D.restartStrength} times as far as a kick. After each kick, m grows when the hop was kept and shrinks when it was not. ${select}`,
  }),
  /**
   * Bench (presets.ts), 2500 evaluations (it gains nothing for its first 1000 or so on these
   * boards): kicks of 0.25 instead of 0.35 gave −7.87 / −7.83 / −8.68 % against −7.82 / −7.87 /
   * −8.44 %, the one loss within the tolerance. Not kept: a deeper local search (localEvals 200 and
   * its penalty's innerIterations 200: −8.22 / −7.72 / −8.81, a loss of 0.15 points on the 80
   * pieces), a shorter refinement (refinementEvals 500 to 2000: no change, or a loss), shallower
   * local searches (localEvals 100: −7.58 / −7.85 / −8.39) and a higher temperature (0.08: no gain).
   * One level. This bench ran single runs of 100,000 evaluations, before runs of 1,000.
   */
  presets: PRESETS,
  tunedDefaults: { kickMagnitude: D.kickMagnitude },
  tunedMeaning: { kickMagnitude: "the kick size at the start of a run, in piece sides" },
  runParams: (base) => ({ ...base, ...BASIN_GAME_PARAMS }),
  runBudget: () => BASIN_RUN_EVALS,
  runEnds: `A ${LABEL} run ends after ${int(L)} evaluations.`,
  runNote: basinRunNote,
  endedText: (v, title) =>
    v.evaluations >= v.budget ? `The ${LABEL} run on ${title} ended after its ${int(v.budget)} evaluations.` : null,
};
