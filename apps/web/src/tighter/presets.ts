import { methodGame } from "./methods";
import type { EvolveMethod } from "./upgrades";

/**
 * Method tuning (plan §4): each method's parameters at its tuning levels, from the `presets` of its
 * file in methods/. Level 0 is the solver's defaults (mc_compress: 5 sweeps per evaluation, 10 with
 * "10 sweeps per evaluation"). Each level searches more per evaluation, or lets a run go on longer
 * before it ends, so a click (one evaluation) does more; an evaluation also takes longer, which
 * matters only once the CPU is the limit.
 *
 * Kept from a bench of open runs of one-evaluation steps from the same Compact board, on 21-gons in a
 * 24-gon (40 pieces), 36-gons in a 33-gon (80) and heptagons in a heptagon (30), seeds 2 to 4: a level
 * is kept only where its side reduction per evaluation is no worse than the level below on every
 * problem (within 0.05 percentage points) [CALC, 2026-10-20, a loaded machine for the times;
 * scratchpad runs/presets-bench*.mts]. Each method's file gives its side reduction from the Compact
 * board, per problem in that order.
 *
 * Methods without a tuning upgrade (seed, morph) keep their defaults.
 */

/** Most tuning levels a method has. */
export const MAX_TUNING = 3;

/** The tuning levels a method has above its defaults (0 for none). */
export function tuningLevels(method: EvolveMethod): number {
  return Math.min(MAX_TUNING, Math.max(0, (methodGame(method).presets?.length ?? 1) - 1));
}

/** The method's parameters at a tuning level (clamped to its levels); `sweeps10`: "10 sweeps per evaluation" is owned. */
export function presetParams(method: EvolveMethod, level: number, sweeps10 = false): Record<string, unknown> {
  const l = Math.max(0, Math.min(tuningLevels(method), Math.floor(level)));
  if (method === "mc_compress" && l === 0) return { sweepsPerEvaluation: sweeps10 ? 10 : 5 };
  const table = methodGame(method).presets;
  return table ? structuredClone({ ...table[l] }) : {};
}

/** Whether the method has tuning levels (seed and morph do not). */
export const isTunable = (method: EvolveMethod): boolean => tuningLevels(method) > 0;
