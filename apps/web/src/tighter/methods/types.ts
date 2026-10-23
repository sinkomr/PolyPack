import type { How } from "../how";

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
}
