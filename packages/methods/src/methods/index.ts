/**
 * The generic methods, registered in the order the board lists them. Each file exports its
 * SpaceMethodDefinition; registration happens here only, once.
 */
import { registerMethod } from "../framework";
import { asc } from "./asc";
import { basinHopping } from "./basin_hopping";
import { harden } from "./harden";
import { mcCompress } from "./mc_compress";
import { morph } from "./morph";
import { penalty } from "./penalty";
import { seed } from "./seed";
import { shrinkRepair } from "./shrink_repair";

const METHODS: Parameters<typeof registerMethod>[0][] = [
  penalty,
  mcCompress,
  asc,
  basinHopping,
  shrinkRepair,
  harden,
  morph,
  seed,
];

for (const m of METHODS) registerMethod(m);
