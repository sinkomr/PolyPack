import type { EvolveMethod } from "./upgrades";

/**
 * Method tuning (plan §4): each method's parameters at its tuning levels. Level 0 is the solver's
 * defaults (mc_compress: 5 sweeps per evaluation, 10 with "10 sweeps per evaluation"). Each level
 * searches more per evaluation, or lets a run go on longer before it ends, so a click (one
 * evaluation) does more; an evaluation also takes longer, which matters only once the CPU is the
 * limit.
 *
 * Kept from a bench of open runs of one-evaluation steps from the same Compact board, on 21-gons in a
 * 24-gon (40 pieces), 36-gons in a 33-gon (80) and heptagons in a heptagon (30), seeds 2 to 4: a level
 * is kept only where its side reduction per evaluation is no worse than the level below on every
 * problem (within 0.05 percentage points) [CALC, 2026-10-20, a loaded machine for the times;
 * scratchpad runs/presets-bench*.mts]. Side reduction from the Compact board, per problem in that
 * order:
 *
 * - mc_compress, 300 evaluations: 10 sweeps −6.79 / −4.04 / −7.30 %; 15: −7.40 / −4.41 / −7.50;
 *   20: −7.46 / −4.55 / −7.62; 30: −7.66 / −4.78 / −7.74. Time per evaluation +0 to +30 %.
 * - asc, 150 evaluations: 10 sweeps −6.85 / −4.92 / −6.82 %; 15: −7.87 / −5.60 / −7.02;
 *   20: −7.97 / −5.72 / −7.18; 30: −8.24 / −6.03 / −7.32. Time +10 to +30 %.
 * - shrink_repair, 300 evaluations: work 4000 −8.84 / −7.86 / −8.48 %; 6000: −9.12 / −7.84 / −8.60;
 *   9000: −9.11 / −7.84 / −8.70; 14000: −10.33 / −7.85 / −8.74. Time up to 2.5×.
 * - harden, 150 evaluations: 32 steps −0.06 / −0.00 / −0.10 % (its first schedule ends after about
 *   360 evaluations); 48: −5.95 / −0.00 / −3.65; 64: −9.84 / −7.52 / −8.63; 96: −10.67 / −8.43 /
 *   −9.38. Time up to 4×.
 * - ls_growth, 150 evaluations: interval 16 −6.61 / −4.74 / −0.10 %; 24: −8.52 / −6.99 / −1.09;
 *   32: −8.89 / −7.51 / −4.40; 48: −8.96 / −7.78 / −6.70. Time up to 5×: its slowest setting runs
 *   0.3 to 0.7 s an evaluation on 40 to 80 pieces.
 * - penalty, 3000 evaluations (the default run ends at 2011): 200 inner iterations −6.07 / −1.84 /
 *   −8.71 %; 300: −7.54 / −4.84 / −8.72; 400: −8.40 / −5.42 / −8.80; 600: −8.75 / −7.14 / −8.82.
 *   Time up to 3×.
 * - basin_hopping: one level, smaller kicks (see BASIN below).
 *
 * Methods without a tuning upgrade (seed, morph) keep their defaults.
 */

/** Most tuning levels a method has. */
export const MAX_TUNING = 3;

/**
 * basin_hopping, 2500 evaluations (it gains nothing for its first 1000 or so on these boards): kicks
 * of 0.25 instead of 0.35 gave −7.87 / −7.83 / −8.68 % against −7.82 / −7.87 / −8.44 %, the one loss
 * within the tolerance. Not kept: a deeper local search (localEvals 200 and its penalty's
 * innerIterations 200: −8.22 / −7.72 / −8.81, a loss of 0.15 points on the 80 pieces), a shorter
 * refinement (refinementEvals 500 to 2000: no change, or a loss), shallower local searches
 * (localEvals 100: −7.58 / −7.85 / −8.39) and a higher temperature (0.08: no gain). One level.
 */
const BASIN: readonly Record<string, unknown>[] = [{}, { kickMagnitude: 0.25 }];

const PRESETS: Partial<Record<EvolveMethod, readonly Record<string, unknown>[]>> = {
  // level 0 is set by "10 sweeps per evaluation" (see presetParams)
  mc_compress: [
    { sweepsPerEvaluation: 10 },
    { sweepsPerEvaluation: 15 },
    { sweepsPerEvaluation: 20, stagnationEvals: 1000 },
    { sweepsPerEvaluation: 30, stagnationEvals: 2000, maxRestarts: 2 },
  ],
  asc: [
    {},
    { sweepsPerEvaluation: 15 },
    { sweepsPerEvaluation: 20 },
    { sweepsPerEvaluation: 30, stagnationSweeps: 4000 },
  ],
  shrink_repair: [{}, { evaluationWork: 6000 }, { evaluationWork: 9000 }, { evaluationWork: 14000 }],
  harden: [{}, { evaluationInterval: 48 }, { evaluationInterval: 64 }, { evaluationInterval: 96 }],
  ls_growth: [
    {},
    { evaluationInterval: 24, stagnationEvaluations: 192 },
    { evaluationInterval: 32, stagnationEvaluations: 256 },
    { evaluationInterval: 48, stagnationEvaluations: 384 },
  ],
  penalty: [{}, { innerIterations: 300 }, { innerIterations: 400 }, { innerIterations: 600 }],
  basin_hopping: BASIN,
};

/** The tuning levels a method has above its defaults (0 for none). */
export function tuningLevels(method: EvolveMethod): number {
  return Math.min(MAX_TUNING, Math.max(0, (PRESETS[method]?.length ?? 1) - 1));
}

/** The method's parameters at a tuning level (clamped to its levels); `sweeps10`: "10 sweeps per evaluation" is owned. */
export function presetParams(method: EvolveMethod, level: number, sweeps10 = false): Record<string, unknown> {
  const l = Math.max(0, Math.min(tuningLevels(method), Math.floor(level)));
  if (method === "mc_compress" && l === 0) return { sweepsPerEvaluation: sweeps10 ? 10 : 5 };
  const table = PRESETS[method];
  return table ? structuredClone({ ...table[l] }) : {};
}

/** Whether the method has tuning levels (seed and morph do not). */
export const isTunable = (method: EvolveMethod): boolean => tuningLevels(method) > 0;
