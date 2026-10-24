import type { MethodDefinition } from "@polypack/solver";
import { executeShrinkRepair, shrinkRepairMethod } from "../../../../../packages/solver/src/methods/shrink_repair";
import { SHRINK_STALL_EVALS, SHRINK_STALL_TOLERANCE } from "./shrink_repair";

/**
 * The stop rule's count. Progress is a score at or below (1 − tolerance) times the score at the
 * last progress; the first reference is the start's score, or the first valid score when the start
 * had none. Smaller gains do not move the reference, so a run that only nibbles still ends.
 */
export class StallCounter {
  private ref: number | null;
  private since = 0;

  constructor(
    start: number | null,
    readonly limit = SHRINK_STALL_EVALS,
    readonly tolerance = SHRINK_STALL_TOLERANCE,
  ) {
    this.ref = start !== null && Number.isFinite(start) ? start : null;
  }

  /** Evaluations since the last progress. */
  get count(): number {
    return this.since;
  }

  /** One evaluation's score (null when it was not valid): true once `limit` in a row made no progress. */
  see(score: number | null): boolean {
    if (score !== null && Number.isFinite(score) && (this.ref === null || score <= this.ref * (1 - this.tolerance))) {
      this.ref = score;
      this.since = 0;
      return false;
    }
    this.since++;
    return this.since >= this.limit;
  }
}

/**
 * The game's shrink_repair: the solver's own definition and search, which the game ends after
 * SHRINK_STALL_EVALS evaluations without progress (StallCounter). Once the rule fires, the wrapper
 * answers `shouldStop` and `checkpoint` as the framework does when an evaluation budget is used up.
 * It adds no parameter, draws no random number and makes no evaluation, so a run it ended is exactly
 * the site's run of the same method, parameters, seed and start with an evaluation budget of the
 * evaluations done, which is what the run's record says it had. No solver method runs shrink_repair
 * as a sub-run, so the rule applies to the game's own runs only.
 */
export const shrinkRepairRun: MethodDefinition = {
  ...shrinkRepairMethod,
  execute: (ctx) => {
    const start = ctx.initialEvaluation;
    const stall = new StallCounter(start?.valid && start.score !== null ? start.score : null);
    let stop = false;
    return executeShrinkRepair({
      ...ctx,
      shouldStop: () => stop || ctx.shouldStop(),
      // as a used-up budget answers, so a paused run does not wait for another click to end
      checkpoint: () => (stop ? Promise.resolve(false) : ctx.checkpoint()),
      evaluate: async (config, options) => {
        const r = await ctx.evaluate(config, options);
        // undefined: the framework refused (the run is ending), not an evaluation
        if (r && stall.see(r.valid ? r.score : null)) stop = true;
        return r;
      },
    });
  },
};

/**
 * shrink_repair's definitions in an open run (worker side only: it imports the solver). The game's
 * definition keeps the name "shrink_repair", the name the server records
 * (packages/geometry/src/provenance.ts).
 */
export const shrinkRepairDefinitions: readonly MethodDefinition[] = [shrinkRepairRun];
