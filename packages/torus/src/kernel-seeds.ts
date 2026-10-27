/**
 * Structured starts of the torus kernel (kernel.ts): lattice placements, after the research
 * search's starts (python/torus/torus_search.py, docs/spaces/TORUS.md section 4). The P pieces
 * sit at the points of a superlattice of index P of the cell's lattice, all at one angle (a
 * translative lattice packing); for odd N and even P, half the time at the points of a
 * superlattice of index P/2 and at those points shifted inside its cell, turned by pi (a double
 * lattice, the best known form for triangles, pentagons and heptagons). The cell is the family's
 * (square or hexagonal at random for free), scaled so that the circumscribed disks of the
 * closest pair touch: every seed is a valid packing, loose for polygons, that the methods tighten.
 */
import { type Pose } from "@polypack/geometry";
import { reachOf } from "./disk";
import { type Lattice, type TorusFamily, familyLattice, latticeImages } from "./lattice";

/**
 * The superlattices of Z^2 of index Q, as (a, b, d) with a d = Q and 0 <= b < d: the lattice
 * spanned by Z^2, (1/a, 0) and (b/Q, 1/d). Every lattice that contains Z^2 with index Q has one
 * such basis (its Hermite normal form), so there are sigma(Q) of them.
 */
export function superlattices(Q: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let a = 1; a <= Q; a++) {
    if (Q % a) continue;
    const d = Q / a;
    for (let b = 0; b < d; b++) out.push([a, b, d]);
  }
  return out;
}

/** The Q points of the superlattice (a, b, d) in [0, 1)^2 modulo Z^2: i (1/a, 0) + j (b/Q, 1/d). */
export function superlatticePoints(a: number, b: number, d: number): [number, number][] {
  const Q = a * d;
  const out: [number, number][] = [];
  for (let j = 0; j < d; j++)
    for (let i = 0; i < a; i++) {
      const x = i / a + (j * b) / Q;
      out.push([x - Math.floor(x), j / d]);
    }
  return out;
}

/** One lattice placement of P pieces (see the header), as a lattice and poses. */
export function latticeSeed(
  family: TorusFamily,
  N: number,
  P: number,
  rng: () => number,
): { lattice: Lattice; poses: Pose[] } {
  const shape: "sq" | "hex" = family === "free" ? (rng() < 0.5 ? "sq" : "hex") : family;
  const unit = familyLattice(shape, 1);
  const double = N % 2 === 1 && P % 2 === 0 && rng() < 0.5;
  const Q = double ? P / 2 : P;
  const choices = superlattices(Q);
  const [a, b, d] = choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))];
  const theta = N === 0 ? 0 : (2 * Math.PI * rng()) / N;
  const pts = superlatticePoints(a, b, d).map((f) => ({ f, theta }));
  if (double) {
    // the second coset: s g1 + t g2 inside the superlattice's cell (never one of its points)
    const s = 0.25 + 0.5 * rng();
    const t = 0.25 + 0.5 * rng();
    const off = [s / a + (t * b) / Q, t / d];
    for (const { f } of pts.slice()) pts.push({ f: [f[0] + off[0], f[1] + off[1]], theta: theta + Math.PI });
  }
  const at = (f: readonly number[]) => [f[0] * unit.b1[0] + f[1] * unit.b2[0], f[0] * unit.b1[1] + f[1] * unit.b2[1]];
  const poses = pts.map(({ f, theta }) => {
    const [x, y] = at(f);
    return { x, y, theta };
  });
  // the closest pair, images included (a lattice vector of the unit cell is at most 1 long)
  let dmin = Infinity;
  for (let i = 0; i < P; i++)
    for (let j = i; j < P; j++)
      for (const im of latticeImages(unit, [poses[j].x - poses[i].x, poses[j].y - poses[i].y], 1.5, i === j))
        dmin = Math.min(dmin, Math.hypot(im.v[0], im.v[1]));
  const k = (2 * reachOf(N)) / dmin;
  return {
    lattice: { b1: [unit.b1[0] * k, unit.b1[1] * k], b2: [unit.b2[0] * k, unit.b2[1] * k] },
    poses: poses.map((p) => ({ x: p.x * k, y: p.y * k, theta: p.theta })),
  };
}
