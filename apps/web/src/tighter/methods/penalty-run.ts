import type { MethodDefinition } from "@polypack/solver";
import { penaltyMethod } from "../../../../../packages/solver/src/methods/penalty";

/**
 * penalty's definitions in an open run (worker side only: it imports the solver). For now the
 * solver's own. A game definition that replaces it must keep the name "penalty", the name the server
 * records (packages/geometry/src/provenance.ts), and the list may add methods its runs call as
 * sub-runs. basin_hopping's penalty sub-runs use the definition registered here.
 */
export const penaltyDefinitions: readonly MethodDefinition[] = [penaltyMethod];
