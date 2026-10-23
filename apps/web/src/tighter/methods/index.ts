import type { EvolveMethod } from "../upgrades";
import { ascGame } from "./asc";
import { basinHoppingGame } from "./basin_hopping";
import { hardenGame } from "./harden";
import { lsGrowthGame } from "./ls_growth";
import { mcCompressGame } from "./mc_compress";
import { morphGame } from "./morph";
import { penaltyGame } from "./penalty";
import { seedGame } from "./seed";
import { shrinkRepairGame } from "./shrink_repair";
import type { MethodGame } from "./types";

export type { MethodGame } from "./types";

/**
 * Every solver method the game runs, by its solver name (the name the server records, which a game
 * definition keeps: packages/geometry/src/provenance.ts). Each entry lives in the method's own file.
 */
export const METHOD_GAMES: Readonly<Record<EvolveMethod, MethodGame>> = {
  mc_compress: mcCompressGame,
  basin_hopping: basinHoppingGame,
  shrink_repair: shrinkRepairGame,
  seed: seedGame,
  penalty: penaltyGame,
  harden: hardenGame,
  asc: ascGame,
  morph: morphGame,
  ls_growth: lsGrowthGame,
};

/** How the game uses a method (its file in this folder); a name the game does not know gets every default. */
export const methodGame = (m: EvolveMethod): MethodGame => METHOD_GAMES[m] ?? {};
