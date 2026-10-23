import type { PackingConfig } from "@polypack/geometry";
import type { ProblemState } from "../game";
import type { How } from "../how";

/** Evaluations a run may do in all, by default, before it ends by itself and the next run takes over. */
export const RUN_BUDGET = 100_000;

/** A sub-run a method started (basin_hopping's penalty solves, for one), as an open run reports it. */
export interface RunStage {
  /** The sub-run's method. */
  method: string;
  /** How many sub-runs of that method the run's own method has started, this one included. */
  count: number;
  /** The run's evaluations when this one began, the start's scoring included. */
  at: number;
}

/** An open run as a method's texts see it: after a step, or live during a long one. */
export interface RunView {
  /** The run's evaluations so far, its start's scoring included. */
  evaluations: number;
  /** The evaluations it may do in all (runBudget). */
  budget: number;
  /** Its parameters as the solver resolved them (the defaults, then those asked). */
  params: Record<string, unknown>;
  /** Its warm-up (the method's warmup for these parameters and the run's problem), 0 without one. */
  warmup: number;
  /** The score of its latest valid evaluation (RunState.last), null before any. */
  last: number | null;
  /** Its best score, its start's included (RunState.score). */
  runBest: number | null;
  /** The best score its method evaluated itself, its start's scoring excluded (RunState.found). */
  found: number | null;
  /** The latest sub-run its method started (RunState.stage). */
  stage?: RunStage;
  /** The problem's best when the run opened. */
  startScore: number | null;
  /** The problem's best now. */
  problemBest: number | null;
}

/** The problem a run opens on, as runParams sees it. */
export interface RunProblem {
  N: number;
  M: number;
  P: number;
  /** The problem's best now (the board's score). */
  score: number | null;
}

/**
 * How the game uses one solver method: its card's texts, its tuning levels and the settings of its
 * runs. Each method has one file in this folder exporting one MethodGame, and index.ts gathers them
 * into a table that upgrades.ts, presets.ts and main.ts read. A method's file is pure: no DOM, and
 * no solver import (the page bundle imports it), so only type imports from the rest of the game.
 *
 * Every field is optional. A field left out keeps the behaviour every method had before it.
 */
export interface MethodGame {
  /**
   * How player text names the method: the Method list, the run line, the Lanes panel, the messages
   * and the cards. Default: its solver name. The server always gets the solver name.
   */
  label?: string;
  /** The method card's name. Default: "Method: <label>". */
  name?: string;
  /**
   * The method card's effect: what the player gets, in one short sentence. mc_compress, owned from
   * the start, has no card.
   */
  effect?: string;
  /**
   * The method card's "How it works". `select` is the shared sentence on choosing a method in the
   * Method list, for the How's note.
   */
  how?: (select: string) => How;
  /**
   * The tuning levels' parameters, level 0 first, each merged over the solver's defaults. A method
   * with one row (or none) has no tuning levels. mc_compress's level 0 is set by "10 sweeps per
   * evaluation" instead (presets.ts).
   */
  presets?: readonly Record<string, unknown>[];
  /** The tuned parameters at the solver's defaults, for the tuning card (a test checks them against the solver). */
  tunedDefaults?: Record<string, number>;
  /** What each tuned parameter sets, by parameter name, for the tuning card. */
  tunedMeaning?: Record<string, string>;
  /** How much longer an evaluation takes at the top tuning level, as the tuning card says it ("up to 30 % longer"). */
  tunedTime?: string;
  /**
   * The tuning card's second paragraph, in place of the shared one about the bench (which quotes
   * `tunedTime`). For a method whose levels do something else than search more per evaluation.
   */
  tuneNote?: string;
  /** What the tuning card calls level 0. Default: "the solver's defaults". */
  tuneBase?: string;
  /**
   * false: the method is left out of the Method list, Method match's choices and the pipeline editor
   * (upgrades.ts methods). It stays a method for saves and run records, and a saved choice of it
   * falls back to mc_compress, a saved pipeline stage of it is dropped (save.ts). Default: true.
   */
  selectable?: boolean;
  /**
   * The parameters a run opens with, from the player's (`base`: the tuning level's preset, what
   * methodParams gives) and the problem. A run is reopened only when `base` changes, so the result
   * may depend on the problem as it was when the run opened. Default: `base`.
   */
  runParams?: (base: Record<string, unknown>, p: RunProblem) => Record<string, unknown>;
  /** The evaluations a run may do in all, from the parameters it opens with. Default: RUN_BUDGET. */
  runBudget?: (params: Record<string, unknown>) => number;
  /**
   * R: the game ends the problem's run once the run has done R evaluations (its start's scoring
   * included) and the problem has gone R evaluations without progress (ProblemState.sinceGain). The
   * run counts as ended by itself: the pipeline moves on, Method match learns from it, and the next
   * run opens from the problem's best board with a new seed. Default: null, only the method's own
   * rule or the budget ends a run.
   */
  restartAfter?: number | null;
  /**
   * One plain sentence on when a run of this method ends by itself, for the help on runs and on
   * pipelines, after the rule every run has: "A harden run ends after its last step." Default: none.
   */
  runEnds?: string;
  /**
   * The run's warm-up: its first evaluations, which the method spends before its boards can beat
   * the problem's (morph's disc stage, for one). They do not add to the problem's evaluations since
   * progress (Auto-advance's patience, and restartAfter's count), and a run closed within them
   * teaches Method match nothing. `params` are the run's as the solver resolved them; the shop's
   * texts call it with the level-0 preset alone, so read a missing parameter as its solver default.
   * `p` is the run's problem, absent in the shop's texts. Default: 0.
   */
  warmup?: (params: Record<string, unknown>, p?: RunProblem) => number;
  /**
   * Which of the method's runs have the warm-up, as Auto-advance's How says it after "every morph
   * run": "on polygon pieces". Default: every run.
   */
  warmupRuns?: string;
  /**
   * The board a run opens from. It may keep a memory of its own (ls_growth's series). Default: the
   * problem's best board, `p.board`.
   */
  startFrom?: (p: ProblemState) => PackingConfig;
  /**
   * Appended to the run line in the toolbar and to the run's line in the Lanes panel, after "run at
   * 300 evaluations": a clause starting " · ", or "" for nothing.
   */
  runNote?: (v: RunView) => string;
  /**
   * Appended to a click's message when it found no improvement, after "No improvement on 6.123456.":
   * one or two plain sentences, or null for nothing.
   */
  stepNote?: (v: RunView) => string | null;
  /**
   * The first sentence of the event when the run ends by itself, in place of "The run on <title>
   * stopped improving after 2,011 evaluations.", or null for that one. `title` is the problem's.
   */
  endedText?: (v: RunView, title: string) => string | null;
}
