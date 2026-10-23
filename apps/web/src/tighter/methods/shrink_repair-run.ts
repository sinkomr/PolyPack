import type { MethodDefinition } from "@polypack/solver";
import { shrinkRepairMethod } from "../../../../../packages/solver/src/methods/shrink_repair";

/**
 * shrink_repair's definitions in an open run (worker side only: it imports the solver). For now the
 * solver's own. A game definition that replaces it must keep the name "shrink_repair", the name the
 * server records (packages/geometry/src/provenance.ts), and the list may add methods its runs call as
 * sub-runs.
 */
export const shrinkRepairDefinitions: readonly MethodDefinition[] = [shrinkRepairMethod];
