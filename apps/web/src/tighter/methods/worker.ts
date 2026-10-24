import type { MethodDefinition } from "@polypack/solver";
// The solver's method definitions, registered as packages/solver/src/index.ts registers them. The
// package exports only its finished registry, whose definitions are private, so they are imported
// from its source (see kernel-requests.md: an evaluation hook on run() would make this unneeded).
// Worker side only: the page bundle never imports this file.
import { identityMethod, polishMethod } from "../../../../../packages/solver/src/methods";
import { ascMethod } from "../../../../../packages/solver/src/methods/asc";
import { basinHoppingMethod } from "../../../../../packages/solver/src/methods/basin_hopping";
import { hardenMethod } from "../../../../../packages/solver/src/methods/harden";
import { lsGrowthMethod } from "../../../../../packages/solver/src/methods/ls_growth";
import { mcCompressMethod } from "../../../../../packages/solver/src/methods/mc_compress";
import { morphMethod } from "../../../../../packages/solver/src/methods/morph";
import { seedMethod } from "../../../../../packages/solver/src/methods/seed";
import { penaltyDefinitions } from "./penalty-run";
import { shrinkRepairDefinitions } from "./shrink_repair-run";

/**
 * The definitions an open run registers (open-run.ts): the solver's, except where a method's own
 * worker-side file (`<method>-run.ts`) gives the game's definition. A game definition keeps the
 * solver's name, because the server refuses method names it does not know.
 */
export const METHODS: readonly MethodDefinition[] = [
  identityMethod,
  polishMethod,
  seedMethod,
  ...penaltyDefinitions,
  basinHoppingMethod,
  mcCompressMethod,
  morphMethod,
  ascMethod,
  lsGrowthMethod,
  hardenMethod,
  ...shrinkRepairDefinitions,
];
