import { SLICES, SliceId } from "./slices";
import type { StandingState } from "./standing";
import type { Owned } from "./upgrades";

/**
 * The slices the dealer may deal from now: those free in an opened dimension, and those whose card
 * is owned. The economy package adds the cards (upgrades.ts ids equal to the slice ids); until then
 * only the free slices of opened dimensions count.
 */
export function openSlices(o: Owned, st: StandingState): SliceId[] {
  return SLICES.filter((s) => st.dimensions.includes(s.dimension) && (s.free || o.has(s.id as never))).map(
    (s) => s.id,
  );
}
