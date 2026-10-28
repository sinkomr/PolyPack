import { sym } from "../how";
import type { MethodGame, RunProblem, RunView } from "./types";

// morph, from packages/solver/src/methods/morph.ts (its defaults and update rules). The game runs it
// in 2 stages instead of the solver's 7: the disc stage, then the true pieces. It has no tuning
// upgrade.
//
// Why 2 stages (methods report, 2026-10-22, 24-gons in a 27-gon, 40 pieces, a board mc_compress had
// run to its own end): a 7-stage run is 5,042 evaluations and showed its first gain after 2,897 of
// them, at 33 RP per 1,000 evaluations. With 2 stages a run is 1,442, its first gain came after
// about 800 and it paid 113 RP per 1,000, with 75 to 90 % of the 7-stage run's gain. More stages
// pay less per evaluation and shorter solves (innerIterations 30) gained nothing, so there is no
// tuning ladder to sell.

/** The game's setting for every morph run (level 0, its only one): the disc stage, then the true pieces. */
export const MORPH_PRESET: Readonly<{ stages: number }> = { stages: 2 };

/** The solver's defaults that set a stage's length (a test checks them against the solver). */
export const MORPH_SOLVER: Readonly<{ innerIterations: number; outerIterations: number }> = {
  innerIterations: 120,
  outerIterations: 6,
};

/** The scorings of the board before the disc stage: the run's start, then morph's own copy of it (at most). */
export const MORPH_START = 2;

/** The evaluations of one stage at most: one per accepted L-BFGS step, 6 solves of 120 steps. */
export const MORPH_STAGE = MORPH_SOLVER.innerIterations * MORPH_SOLVER.outerIterations;

/** The warm-up: the start's scorings and the disc stage, whose boards rarely beat a packed board. */
export const MORPH_WARMUP = MORPH_START + MORPH_STAGE;

/** A run's evaluations at most with the game's 2 stages. */
export const MORPH_RUN = MORPH_START + MORPH_STAGE * MORPH_PRESET.stages;

/** Stages that a large residual adds at most, each halfway to the next planned one (the solver's adaptive schedule). */
export const MORPH_ADDED = 2;

/** A run's evaluations at most when it adds every stage it may. */
export const MORPH_LONGEST = MORPH_START + MORPH_STAGE * (MORPH_PRESET.stages + MORPH_ADDED);

const int = (n: number) => n.toLocaleString("en-US");

/** A parameter of the run, or its solver default when the shop's texts leave it out. */
const param = (params: Record<string, unknown>, key: keyof typeof MORPH_SOLVER): number => {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : MORPH_SOLVER[key];
};

/**
 * The warm-up of a run with these parameters: its start's scorings and its disc stage. On circle
 * pieces (N = 0) the disc is the piece, and the solver runs the true shape alone, so there is none.
 */
export function morphWarmup(params: Record<string, unknown>, p?: RunProblem): number {
  if (p?.N === 0) return 0;
  return MORPH_START + param(params, "innerIterations") * param(params, "outerIterations");
}

/** Whether a run at `v` is still in its warm-up, before its last evaluation. */
const warming = (v: RunView) => v.warmup > 0 && v.evaluations < v.warmup;

export const morphGame: MethodGame = {
  effect: "Adds morph, which repacks your board as discs and then as the true pieces.",
  how: (select) => ({
    text: [
      `morph repacks your board in ${MORPH_PRESET.stages} stages. In the first, the disc stage, each piece is the disc inscribed in it. In the second stage each piece is its true shape. A run starts from your best board and nudges every piece at random.`,
      "In each stage the game spreads the pieces until they just touch, and then a penalty search squeezes the container around them. After every step of the search, the game spreads the pieces until no true pieces overlap and scores that board, which is one evaluation.",
      "On a board that is already packed tight, the boards of the disc stage are larger than your best, so your board usually changes only in the second stage. The run ends after its last stage.",
    ],
    math: [
      `${sym("S")}(${sym("t")}) = ${sym("t")} × polygon ⊕ (1 − ${sym("t")}) × ${sym("ρ")} × disc`,
      `${sym("t")} = 0 in the disc stage, 1 in the second stage`,
      `${sym("e")} ≤ ${MORPH_START} + ${sym("k")} × ${sym("O")} × ${sym("I")}, which is ${int(MORPH_RUN)} at ${sym("k")} = ${MORPH_PRESET.stages}`,
      `warm-up = ${MORPH_START} + ${sym("O")} × ${sym("I")} = ${int(MORPH_WARMUP)} evaluations`,
    ],
    vars: [
      [`${sym("S")}(${sym("t")})`, "the shape of each piece at t"],
      [sym("t"), "how far along from the disc to the true piece, from 0 to 1"],
      [sym("ρ"), "the radius of the disc inscribed in the piece"],
      [sym("e"), "the evaluations of one run"],
      [
        sym("k"),
        `its stages, ${MORPH_PRESET.stages}, or up to ${MORPH_PRESET.stages + MORPH_ADDED} with the halfway stages`,
      ],
      [sym("O"), `penalty solves at most per stage, ${MORPH_SOLVER.outerIterations}`],
      [sym("I"), `L-BFGS steps at most per solve, ${MORPH_SOLVER.innerIterations}`],
    ],
    note: `A run starts by moving each centre and angle by up to 0.03 at random. Each stage runs at most ${MORPH_SOLVER.outerIterations} penalty solves of at most ${MORPH_SOLVER.innerIterations} L-BFGS steps each, with the objective of the penalty method, and the game scores the board after each accepted step. When a stage ends with an overlap or a protrusion above 0.02 piece sides, the next stage goes only halfway to the true piece, at most twice. The ${MORPH_START} evaluations before the disc stage score your board as it is. The first ${int(MORPH_WARMUP)} evaluations of a run are its warm-up, which covers the disc stage, and they do not count toward Auto-advance's patience. On circle pieces the disc is the piece, so a run has only the second stage and no warm-up. ⊕ adds two shapes point by point (a Minkowski sum). ${select}`,
  }),
  presets: [MORPH_PRESET],
  warmup: morphWarmup,
  warmupRuns: "on polygon pieces",
  runEnds: `A morph run ends after its last stage, within ${int(MORPH_RUN)} evaluations, or ${int(MORPH_LONGEST)} with the halfway stages.`,
  runNote: (v) => (warming(v) ? ` · warm-up until ${int(v.warmup)}` : ""),
  stepNote: (v) =>
    warming(v)
      ? `The disc stage of morph ends by evaluation ${int(v.warmup)} of this run. Its boards rarely beat a board that is already packed tight.`
      : null,
  endedText: (v, title) =>
    `The morph run on ${title} ended after its last stage, at ${int(v.evaluations)} evaluations.`,
};
