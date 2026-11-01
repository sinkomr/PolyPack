/** Test packings of the nD in nD space: a grid of balls or unit hypercubes in a hypercube, a hair apart. */
import { ND_P_RANGE, type NdProblemId } from "../src/catalogue";
import type { NdConfigShape } from "../src/validate";

/** The identity pose of a hypercube centred at t: centre, zero Cayley parameters, no flip. */
export const cubePose = (t: number[]): number[] => [...t, ...new Array((t.length * (t.length - 1)) / 2).fill(0), 0];

/**
 * P balls (or P unit hypercubes) of the 2 x ... x 2 grid in the hypercube of edge s = 2 + 2 gap: every neighbour is gap apart
 * (balls: 2 gap at the walls... the walls are gap from them too). P at most 2^d.
 */
export function gridPacking(
  d: number,
  kind: "ball" | "cube",
  P: number,
  gap = 1e-7,
): { problem: NdProblemId; config: NdConfigShape } {
  const pieces: number[][] = [];
  for (let k = 0; k < P; k++) {
    const t = Array.from({ length: d }, (_, i) => (((k >> i) & 1) - 0.5) * (1 + gap));
    pieces.push(kind === "ball" ? t : cubePose(t));
  }
  return {
    problem: { d, piece: kind === "ball" ? "ball" : "cube", container: "cube", P },
    config: { s: 2 + 2 * gap, pieces },
  };
}

/** The largest P of a dimension that the grid holds. */
export const gridP = (d: number): number => Math.min(2 ** d, ND_P_RANGE[d][1]);
