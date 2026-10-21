import { Bandit, normalizeBandit } from "./bandit";

/**
 * The dealer's own state (plan §3): offers waiting for the player's pick, filters, what the learning
 * dealer has learned, and records lost that wait for a retake. Owned by the dealer work. This base
 * holds the state and its defaults.
 */

export interface PicksState {
  /** Candidates offered (Your pick), as the dealer's own records; their shape is the dealer work's. */
  offers: unknown[];
  /** The player's filters (Dealer filters); null: none. */
  filters: Record<string, unknown> | null;
  /** The learning dealer's arms: RP per evaluation by kind of problem. */
  bandit: Bandit;
  /** Keys of problems whose record the player lost, waiting to be offered again (Retake). */
  retake: string[];
}

export const newPicks = (): PicksState => ({ offers: [], filters: null, bandit: {}, retake: [] });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizePicks(v: unknown): PicksState {
  const d = newPicks();
  if (!isObj(v)) return d;
  return {
    offers: Array.isArray(v.offers) ? v.offers.filter(isObj).slice(0, 8) : [],
    filters: isObj(v.filters) ? v.filters : null,
    bandit: normalizeBandit(v.bandit),
    retake: Array.isArray(v.retake)
      ? [...new Set(v.retake.filter((k): k is string => typeof k === "string" && /^\d+\/\d+\/\d+$/.test(k)))].slice(
          -200,
        )
      : [],
  };
}
