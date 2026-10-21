import { Bandit, normalizeBandit } from "./bandit";
import type { EvolveMethod } from "./upgrades";

/**
 * How runs are planned (plan §4): method match and auto-tune's bandit, and the player's pipeline.
 * Owned by the runs work. This base holds the state and its defaults.
 */

export interface RunPlanState {
  /** The method is chosen by the game (Method match), not by the select. */
  auto: boolean;
  /** Methods in the order successive seeds run them (Pipelines); empty: the chosen method each time. */
  pipeline: EvolveMethod[];
  /** RP per evaluation by (kind of problem, method and setting). */
  bandit: Bandit;
}

export const newRunPlan = (): RunPlanState => ({ auto: false, pipeline: [], bandit: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizeRunPlan(v: unknown, known: readonly string[]): RunPlanState {
  const d = newRunPlan();
  if (!isObj(v)) return d;
  return {
    auto: typeof v.auto === "boolean" ? v.auto : false,
    pipeline: Array.isArray(v.pipeline)
      ? (v.pipeline.filter((m) => typeof m === "string" && known.includes(m)) as EvolveMethod[]).slice(0, 9)
      : [],
    bandit: normalizeBandit(v.bandit),
  };
}
