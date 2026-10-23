// penalty's game settings. No imports: the page (penalty.ts, for the texts and presets) and the
// worker (penalty-run.ts, for the runs) both read them, and the page bundle must not pull in solver
// code.

/** The registered name of the squeeze, the game's copy of the solver's penalty (penalty-run.ts). */
export const SQUEEZE = "penalty_squeeze";

/**
 * A squeeze scores the restored packing after every SQUEEZE_INTERVAL-th accepted L-BFGS step (and
 * at a solve's end), instead of after every step. The trajectory does not depend on the scoring,
 * so the squeeze is the same in a tenth of the evaluations (penalty report §3.3).
 */
export const SQUEEZE_INTERVAL = 10;

/** The solves of a squeeze: the solver's outerIterations, which the game keeps (a test checks it). */
export const SQUEEZE_SOLVES = 10;

/** The evaluations of mc_compress after each squeeze (a settle), its start's scoring included. */
export const SETTLE_EVALS = 1000;

/** mc_compress's parameters in a settle. */
export const SETTLE_PARAMS: Readonly<Record<string, unknown>> = { sweepsPerEvaluation: 10 };

/**
 * A run ends when a squeeze and its settle together shrink the run's best by less than this
 * (relative): s_after ≥ s_before × (1 − CYCLE_TOLERANCE).
 */
export const CYCLE_TOLERANCE = 1e-6;

/**
 * What every penalty run of the game sets over the solver's defaults, at every tuning level: the
 * squeeze's interval, repair by uniform expansion (half the CPU of the pairwise pushes for the same
 * squeeze, report §3.4) and the settle.
 */
export const PENALTY_GAME: Readonly<Record<string, unknown>> = {
  evaluationInterval: SQUEEZE_INTERVAL,
  restoration: "expand",
  settleEvals: SETTLE_EVALS,
};
