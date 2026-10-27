/**
 * The container of a balls problem, as the validator, the search and the kernel read it.
 *
 *  - "ball": the ball of DIAMETER s about the origin (radius s / 2, catalogue.ts ballContainerRadius);
 *  - "cube": the cube [-s/2, s/2]^3 (an axis-aligned special case with its own, simpler code in every file, kept as
 *    it was before the other solids were containers);
 *  - "polyhedron": s times a canonical solid of the polyhedra space (centred at its vertex centroid, which is the
 *    origin), the intersection of the half-spaces N_f . x <= s b_f, N_f the unit outward normal of face f and b_f
 *    its offset. The cube is one too: the same formulas hold for it.
 *
 * A ball piece of radius r lies in the closed container s C exactly when its centre c satisfies, for every face,
 *   N_f . c <= s b_f - r
 * [EST, elementary: the ball lies in the half-space N_f . x <= s b_f iff its centre is at least r inside the plane;
 * a convex polyhedron is the intersection of its face half-spaces]. So the centres lie in a polyhedron with the same
 * face normals and offsets s b_f - r, the container "shrunk inward by r"; for the tangential solids (all b_f equal
 * to the inradius rho) it is the container itself scaled to s - r / rho.
 *
 * Two facts about all 94 solids, used by the bounds [EST, and checked on the data to 4e-16 by a linear programme and
 * a minimisation]: the vertex centroid is the centre of the largest inscribed ball (so the inradius, the least
 * offset, is the Chebyshev radius) and of the smallest enclosing ball (so the circumradius, the largest vertex
 * distance, is the radius of the smallest ball holding the solid). Both because each is unique or averages to a
 * point fixed by the solid's symmetries, and the only point fixed by the symmetry group of each of the 94 solids
 * (the Platonic, Archimedean and Catalan point groups, and the dihedral groups D_nh and D_nd of the prisms,
 * antiprisms, elongated prisms, bipyramids and trapezohedra, n >= 3) is the centroid.
 */
import { type Solid, getSolid } from "@polypack/polyhedra";
import type { BallsProblem } from "./catalogue";

export type ContainerKind = "ball" | "cube" | "polyhedron";

export function containerKind(problem: Pick<BallsProblem, "container">): ContainerKind {
  return problem.container === "ball" ? "ball" : problem.container === "cube" ? "cube" : "polyhedron";
}

export interface Container {
  solid: Solid;
  /** Number of faces, the unit outward normals (flat) and the offsets of the canonical solid. */
  F: number;
  N: Float64Array;
  b: Float64Array;
  /** Least offset: the radius of the largest ball in the canonical solid (about the origin). */
  inradius: number;
  /** Largest vertex distance from the origin. */
  circumradius: number;
  /** Largest distance of two vertices (the canonical solid's diameter). */
  diameter: number;
  volume: number;
  /** True when every offset equals the inradius. */
  tangential: boolean;
  /** Bounding box of the canonical solid. */
  lo: [number, number, number];
  hi: [number, number, number];
}

const CACHE = new Map<string, Container>();

/** The geometry of a solid as a container (cached); any solid, the cube included. */
export function containerOf(name: string): Container {
  let c = CACHE.get(name);
  if (c) return c;
  const solid = getSolid(name);
  let diameter = 0;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < solid.nv; i++) {
    for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d], solid.V[3 * i + d]);
      hi[d] = Math.max(hi[d], solid.V[3 * i + d]);
    }
    for (let j = i + 1; j < solid.nv; j++)
      diameter = Math.max(
        diameter,
        Math.hypot(solid.V[3 * i] - solid.V[3 * j], solid.V[3 * i + 1] - solid.V[3 * j + 1], solid.V[3 * i + 2] - solid.V[3 * j + 2]),
      );
  }
  c = {
    solid,
    F: solid.offsets.length,
    N: solid.N,
    b: solid.offsets,
    inradius: solid.inradius,
    circumradius: solid.circumradius,
    diameter,
    volume: solid.volume,
    tangential: solid.tangential,
    lo,
    hi,
  };
  CACHE.set(name, c);
  return c;
}

/** The geometry of a problem's container; null for a ball container. */
export function containerOfProblem(problem: Pick<BallsProblem, "container">): Container | null {
  return problem.container === "ball" ? null : containerOf(problem.container);
}

/**
 * The gap of a ball of radius r centred at (x, y, z) to the nearest face of s times the container: the least over
 * faces of s b_f - r - N_f . c (negative: the ball sticks out). This one expression is the validator's, the
 * kernel's and the search's, so that all of them round alike.
 */
export function wallGap(C: Container, s: number, r: number, x: number, y: number, z: number): number {
  let gap = Infinity;
  const N = C.N;
  for (let f = 0; f < C.F; f++) {
    const g = s * C.b[f] - r - (N[3 * f] * x + N[3 * f + 1] * y + N[3 * f + 2] * z);
    if (g < gap) gap = g;
  }
  return gap;
}

/**
 * The smallest size s at which a ball of radius r + w centred at (x, y, z) lies in s times the container: the
 * largest over faces of (N_f . c + r + w) / b_f.
 */
export function sizeFor(C: Container, r: number, x: number, y: number, z: number): number {
  let s = 0;
  const N = C.N;
  for (let f = 0; f < C.F; f++) s = Math.max(s, (N[3 * f] * x + N[3 * f + 1] * y + N[3 * f + 2] * z + r) / C.b[f]);
  return s;
}
