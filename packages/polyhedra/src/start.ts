import type { Pose } from "./geom";
import { POLYHEDRA_MAX_P } from "./info";
import { latticeSeed } from "./kernel-seeds";
import type { PolyhedraProblem } from "./problems";
import { getSolid } from "./solids";
import type { PolyhedraConfig } from "./validate";

/**
 * Deterministic box-lattice patch in the canonical orientation. No search or stored packing:
 * bounding boxes separate the pieces and face supports size the container. A tiny dilation
 * keeps positive clearance despite rounding, including at the server's strict tolerance.
 */
export function latticeStart(problem: PolyhedraProblem, P: number): PolyhedraConfig {
  if (!Number.isInteger(P) || P < 1 || P > POLYHEDRA_MAX_P)
    throw new RangeError(`P must be an integer from 1 to ${POLYHEDRA_MAX_P}`);
  const seed = latticeSeed(getSolid(problem.piece), getSolid(problem.container), P, [1, 0, 0, 0], false, () => 0);
  const expand = 1 + 1e-10;
  return {
    s: seed.size * expand,
    pieces: Array.from({ length: P }, (_, i): Pose => [
      seed.centres[3 * i] * expand, seed.centres[3 * i + 1] * expand, seed.centres[3 * i + 2] * expand, 1, 0, 0, 0,
    ]),
  };
}
