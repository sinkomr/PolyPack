import type { DimensionId, Family } from "./frontier";

/**
 * The slices of the catalogue the dealer may deal from, beyond the 2D board's own frontier and
 * problem sets (which keep their cards, as before). A slice is a family's kind of problem, or a part
 * of one: it opens with its dimension (`free`) or with the tech-tree card of the same id. A dimension
 * opens for good at a reset (standing.ts dimensionOpenedBy); its cards, like the rest of the tree,
 * are bought again in each cycle.
 *
 * Michael's ladder (2026-10-26): Curved is a late card of the first cycle; 2D on 3D opens at the
 * first reset with folded Polyhedral surfaces, then Sphere, Torus and the Catalan solids without
 * folding as late cards; 3D in 3D opens at the second reset with Archimedean solids in themselves
 * only, then the other solids as cards. Surfaces without folding on Platonic solids, prisms and
 * antiprisms are never dealt: each is a 2D in 2D packing of its faces (docs/spaces/SURFACE.md).
 */
export type SliceId =
  | "curved"
  | "surf-platonic"
  | "surf-prisms"
  | "surf-catalan-a"
  | "surf-catalan-b"
  | "surf-catalan-c"
  | "surf-nofold-catalan"
  | "sphere"
  | "torus"
  | "poly-archimedean"
  | "poly-catalan"
  | "poly-platonic"
  | "poly-prisms"
  | "poly-cube"
  | "poly-elongated"
  | "poly-duals"
  | "balls";

export interface Slice {
  id: SliceId;
  family: Family;
  dimension: DimensionId;
  /** How the shop and the queue name it, in player text. */
  label: string;
  /** Open as soon as its dimension is (no card). */
  free: boolean;
  /** A late-game card: a new kind of problem, priced near the cycle's reset (the others are the dimension's ladder). */
  late: boolean;
}

export const SLICES: readonly Slice[] = [
  { id: "curved", family: "curved", dimension: "2-in-2", label: "Curved geometries", free: false, late: true },
  { id: "surf-platonic", family: "surface", dimension: "2-on-3", label: "Platonic surfaces", free: true, late: false },
  { id: "surf-prisms", family: "surface", dimension: "2-on-3", label: "Prism and antiprism surfaces", free: false, late: false },
  { id: "surf-catalan-a", family: "surface", dimension: "2-on-3", label: "Catalan surfaces, 12 and 24 faces", free: false, late: false },
  { id: "surf-catalan-b", family: "surface", dimension: "2-on-3", label: "Catalan surfaces, 30 to 60 faces", free: false, late: false },
  { id: "surf-catalan-c", family: "surface", dimension: "2-on-3", label: "The 120-faced Catalan surface", free: false, late: false },
  { id: "surf-nofold-catalan", family: "surface", dimension: "2-on-3", label: "Catalan faces without folding", free: false, late: true },
  { id: "sphere", family: "sphere", dimension: "2-on-3", label: "Sphere", free: false, late: true },
  { id: "torus", family: "torus", dimension: "2-on-3", label: "Torus", free: false, late: true },
  { id: "poly-archimedean", family: "polyhedra", dimension: "3-in-3", label: "Archimedean solids", free: true, late: false },
  { id: "poly-catalan", family: "polyhedra", dimension: "3-in-3", label: "Catalan solids", free: false, late: true },
  { id: "poly-platonic", family: "polyhedra", dimension: "3-in-3", label: "Platonic solids", free: false, late: true },
  { id: "poly-prisms", family: "polyhedra", dimension: "3-in-3", label: "Prisms and antiprisms", free: false, late: true },
  { id: "poly-cube", family: "polyhedra", dimension: "3-in-3", label: "Prisms and antiprisms in a cube", free: false, late: true },
  { id: "poly-elongated", family: "polyhedra", dimension: "3-in-3", label: "Elongated prisms", free: false, late: true },
  { id: "poly-duals", family: "polyhedra", dimension: "3-in-3", label: "Bipyramids and trapezohedra", free: false, late: true },
  { id: "balls", family: "balls", dimension: "3-in-3", label: "Balls", free: false, late: true },
];

export const sliceById = (id: SliceId): Slice => SLICES.find((s) => s.id === id)!;
export const isSliceId = (v: unknown): v is SliceId => typeof v === "string" && SLICES.some((s) => s.id === v);
