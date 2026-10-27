/**
 * A deterministic start for any torus problem, valid at every P up to TORUS_MAX_P: the P pieces at
 * the points of the best superlattice of index P of a square or hexagonal cell, all at angle 0,
 * the cell scaled so that the circumscribed disks of the closest pair touch (plus a relative
 * 1e-9, so that the packing is also valid at the server's strict tolerance). No search and no
 * random numbers: kernel-seeds.ts draws such lattices at random for the search's fresh starts,
 * this one picks the lattice whose shortest vector is longest, so the cell is as small as these
 * lattice placements allow.
 */
import { type Pose, boundingRadius } from "@polypack/geometry";
import { superlatticePoints, superlattices } from "./kernel-seeds";
import { type Lattice, TORUS_DISK_RADIUS, TORUS_MAX_P, type TorusFamily, cellArea, familyLattice, gaussReduce } from "./lattice";
import type { TorusPacking } from "./validate";

/** Relative dilation of the start beyond touching circumscribed disks. */
const START_MARGIN = 1e-9;

/** Length of the shortest nonzero vector of the superlattice (a, b, d) of the unit cell `unit`. */
function shortest(unit: Lattice, a: number, b: number, d: number): number {
  const Q = a * d;
  const at = (f: readonly [number, number]): [number, number] => [
    f[0] * unit.b1[0] + f[1] * unit.b2[0],
    f[0] * unit.b1[1] + f[1] * unit.b2[1],
  ];
  const { lattice } = gaussReduce({ b1: at([1 / a, 0]), b2: at([b / Q, 1 / d]) });
  return Math.hypot(lattice.b1[0], lattice.b1[1]);
}

export function torusLatticeStart(problem: { family: TorusFamily; N: number; P: number }): TorusPacking {
  const { family, N, P } = problem;
  if (!Number.isInteger(P) || P < 1 || P > TORUS_MAX_P) throw new RangeError(`P must be an integer from 1 to ${TORUS_MAX_P}`);
  const R = N === 0 ? TORUS_DISK_RADIUS : boundingRadius(N);
  const shapes: ("sq" | "hex")[] = family === "free" ? ["sq", "hex"] : [family];
  let best: { shape: "sq" | "hex"; abd: [number, number, number]; k: number; score: number } | null = null;
  for (const shape of shapes) {
    const unit = familyLattice(shape, 1);
    for (const abd of superlattices(P)) {
      const k = (2 * R) / shortest(unit, ...abd);
      const score = family === "free" ? k * Math.sqrt(cellArea(unit)) : k;
      if (!best || score < best.score * (1 - 1e-12)) best = { shape, abd, k, score };
    }
  }
  const { shape, abd, k } = best!;
  const unit = familyLattice(shape, 1);
  const s = k * (1 + START_MARGIN);
  const poses: Pose[] = superlatticePoints(...abd).map(([u, v]) => ({
    x: s * (u * unit.b1[0] + v * unit.b2[0]),
    y: s * (u * unit.b1[1] + v * unit.b2[1]),
    theta: 0,
  }));
  const lattice: Lattice = { b1: [unit.b1[0] * s, unit.b1[1] * s], b2: [unit.b2[0] * s, unit.b2[1] * s] };
    return { family, N, lattice, poses };
}
