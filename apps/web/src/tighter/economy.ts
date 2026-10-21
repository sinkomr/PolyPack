/**
 * Records as an economy (plan §5): rent for records held, and collections. Owned by the economy
 * work. This base holds the state and its defaults.
 */

export interface EconomyState {
  /** Keys of every problem where the server confirmed a record of the player's (collections count these). */
  recorded: string[];
  /** Rent paid in all. */
  rentPaid: number;
}

export const newEconomy = (): EconomyState => ({ recorded: [], rentPaid: 0 });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Most problems remembered as recorded. */
export const RECORDED_LIMIT = 20000;

export function normalizeEconomy(v: unknown): EconomyState {
  const d = newEconomy();
  if (!isObj(v)) return d;
  return {
    recorded: Array.isArray(v.recorded)
      ? [...new Set(v.recorded.filter((k): k is string => typeof k === "string" && /^\d+\/\d+\/\d+$/.test(k)))].slice(
          -RECORDED_LIMIT,
        )
      : [],
    rentPaid: typeof v.rentPaid === "number" && Number.isFinite(v.rentPaid) && v.rentPaid >= 0 ? v.rentPaid : 0,
  };
}
