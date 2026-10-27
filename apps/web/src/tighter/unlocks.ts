import { SLICES, SliceId } from "./slices";
import type { StandingState } from "./standing";
import type { Owned, UpgradeId } from "./upgrades";

/**
 * The slices the dealer may deal from now: those free in an opened dimension, and those whose card
 * is owned (the cards are upgrades.ts', whose ids equal the slice ids, bought again in each cycle).
 */
export function openSlices(o: Owned, st: StandingState): SliceId[] {
  return SLICES.filter((s) => st.dimensions.includes(s.dimension) && (s.free || o.has(s.id as UpgradeId))).map(
    (s) => s.id,
  );
}
