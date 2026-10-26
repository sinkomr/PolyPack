/**
 * A space problem's kernel for the generic search methods (packages/methods,
 * docs/methods/dimensions/README.md), built by the factory of the problem's space package. A
 * problem has generic methods when its factory builds a kernel for it. A factory throws for a
 * problem it cannot model (a piece that does not exist at that curvature, a P above the server's
 * largest); such a problem has none, only Auto, the space's own search (methods.ts), and
 * spaceKernelError says why.
 *
 * Surface problems in the nofold mode on the Platonic solids have no kernel: they are planar
 * problems of one face and run on the polygon solver (nofold.ts). On the other solids the surface
 * kernel serves them in its nofold mode.
 *
 * Kernels are pure (they hold only the problem and its caches), so a built one is kept for its
 * problem and shared by every job on this thread; a few problems are kept at a time.
 */
import { boundaryKernel } from "@polypack/boundary";
import { curvedKernel } from "@polypack/curved";
import type { SpaceKernel } from "@polypack/methods";
import { polyhedraKernel } from "@polypack/polyhedra";
import { sphereKernel } from "@polypack/sphere";
import { surfaceKernel } from "@polypack/surface";
import { torusKernel } from "@polypack/torus";
import { type SearchProblem, nofoldOnPolygonEngine } from "./model";

/** Builds a problem's kernel, or throws when its space cannot. */
export type KernelFactory = (p: SearchProblem) => SpaceKernel;

/** The factories of the space packages. */
const factories: KernelFactory = (p) => {
  switch (p.space) {
    case "curved":
      return curvedKernel({ K: p.K, N: p.N, M: p.M, P: p.P });
    case "surface":
      if (nofoldOnPolygonEngine(p)) throw new Error("nofold problems of the Platonic solids run on the polygon solver");
      return surfaceKernel({ solid: p.solid, N: p.N, P: p.P, mode: p.mode });
    case "sphere":
      return sphereKernel({ N: p.N, P: p.P });
    case "torus":
      return torusKernel({ family: p.family, N: p.N, P: p.P });
    case "polyhedra":
      return polyhedraKernel({ code: p.code, P: p.P });
    case "boundary":
      return boundaryKernel({ polytope: p.polytope, piece: p.piece, P: p.P });
    case "balls":
      // no kernel yet: the balls space offers its own search (Auto) alone
      throw new Error("the balls space has no kernel for the generic methods yet");
  }
};

let make: KernelFactory = factories;
/** Problems whose kernel was asked for, most recent last: the kernel, or null and why there is none. */
const built = new Map<string, { kernel: SpaceKernel | null; why: string | null }>();
const KEPT = 8;

function entry(p: SearchProblem): { kernel: SpaceKernel | null; why: string | null } {
  if (nofoldOnPolygonEngine(p))
    return { kernel: null, why: "nofold problems of the Platonic solids run on the polygon solver" };
  const known = built.get(p.id);
  if (known) {
    // most recent last
    built.delete(p.id);
    built.set(p.id, known);
    return known;
  }
  let e: { kernel: SpaceKernel | null; why: string | null };
  try {
    const k = make(p);
    // a kernel of another problem would search the wrong one
    e = k && k.P === p.P ? { kernel: k, why: null } : { kernel: null, why: "its kernel is of another problem" };
  } catch (error) {
    e = { kernel: null, why: error instanceof Error ? error.message : String(error) };
  }
  built.set(p.id, e);
  if (built.size > KEPT) built.delete(built.keys().next().value!);
  return e;
}

/** The problem's kernel, or null when its space builds none for it. Never throws. */
export const spaceKernel = (p: SearchProblem): SpaceKernel | null => entry(p).kernel;

/** Why the problem has no kernel (its factory's reason), or null when it has one. */
export const spaceKernelError = (p: SearchProblem): string | null => entry(p).why;

/**
 * For tests only: builds kernels with `factory` instead of the space packages' factories (null
 * restores them), and forgets the kernels built so far. A test can stand a kernel in, such as the
 * reference kernel of packages/methods, or have none.
 */
export function setKernelFactoryForTests(factory: KernelFactory | null): void {
  make = factory ?? factories;
  built.clear();
}
