import { SOLID_NAMES_LIST, type SolidFamily } from "@polypack/polyhedra/catalogue";
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
 * folding as late cards (Johnson surfaces, added 2026-10-30, follow the Archimedean ones and Johnson solids sit between the elongated prisms and the duals); 3D in 3D opens at the second reset with Archimedean solids in themselves
 * only, then each card opens a family of solids: a pair of solids (piece, container) is dealt when both
 * families are open, and a balls problem when the Balls card is owned and the solid's family (if any) is open. Surfaces without folding on Platonic, Archimedean and Johnson solids, prisms and
 * antiprisms are never dealt: each is a 2D in 2D packing of its faces (docs/spaces/SURFACE.md).
 */
export type SliceId =
  | "curved"
  | "surf-platonic"
  | "surf-prisms"
  | "surf-archimedean"
  | "surf-johnson"
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
  | "poly-antiprisms"
  | "poly-elongated"
  | "poly-johnson"
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
  {
    id: "surf-prisms",
    family: "surface",
    dimension: "2-on-3",
    label: "Prism and antiprism surfaces",
    free: false,
    late: false,
  },
  {
    id: "surf-archimedean",
    family: "surface",
    dimension: "2-on-3",
    label: "Archimedean surfaces",
    free: false,
    late: false,
  },
  {
    id: "surf-johnson",
    family: "surface",
    dimension: "2-on-3",
    label: "Johnson surfaces",
    free: false,
    late: false,
  },
  {
    id: "surf-catalan-a",
    family: "surface",
    dimension: "2-on-3",
    label: "Catalan surfaces, 12 and 24 faces",
    free: false,
    late: false,
  },
  {
    id: "surf-catalan-b",
    family: "surface",
    dimension: "2-on-3",
    label: "Catalan surfaces, 30 to 60 faces",
    free: false,
    late: false,
  },
  {
    id: "surf-catalan-c",
    family: "surface",
    dimension: "2-on-3",
    label: "The 120-faced Catalan surface",
    free: false,
    late: false,
  },
  {
    id: "surf-nofold-catalan",
    family: "surface",
    dimension: "2-on-3",
    label: "Catalan faces without folding",
    free: false,
    late: true,
  },
  { id: "sphere", family: "sphere", dimension: "2-on-3", label: "Sphere", free: false, late: true },
  { id: "torus", family: "torus", dimension: "2-on-3", label: "Torus", free: false, late: true },
  {
    id: "poly-archimedean",
    family: "polyhedra",
    dimension: "3-in-3",
    label: "Archimedean solids",
    free: true,
    late: false,
  },
  { id: "poly-catalan", family: "polyhedra", dimension: "3-in-3", label: "Catalan solids", free: false, late: true },
  { id: "poly-platonic", family: "polyhedra", dimension: "3-in-3", label: "Platonic solids", free: false, late: true },
  { id: "poly-prisms", family: "polyhedra", dimension: "3-in-3", label: "Prisms", free: false, late: true },
  { id: "poly-antiprisms", family: "polyhedra", dimension: "3-in-3", label: "Antiprisms", free: false, late: true },
  {
    id: "poly-elongated",
    family: "polyhedra",
    dimension: "3-in-3",
    label: "Elongated prisms",
    free: false,
    late: true,
  },
  { id: "poly-johnson", family: "polyhedra", dimension: "3-in-3", label: "Johnson solids", free: false, late: true },
  {
    id: "poly-duals",
    family: "polyhedra",
    dimension: "3-in-3",
    label: "Bipyramids and trapezohedra",
    free: false,
    late: true,
  },
  { id: "balls", family: "balls", dimension: "3-in-3", label: "Balls", free: false, late: true },
];

export const sliceById = (id: SliceId): Slice => SLICES.find((s) => s.id === id)!;
export const isSliceId = (v: unknown): v is SliceId => typeof v === "string" && SLICES.some((s) => s.id === v);

/** The slice (card) that opens each family of solids; the order of SLICES is the order the cards are opened and priced in. */
export const SOLID_FAMILY_SLICE: Readonly<Partial<Record<SolidFamily, SliceId>>> = {
  archimedean: "poly-archimedean",
  catalan: "poly-catalan",
  platonic: "poly-platonic",
  prism: "poly-prisms",
  antiprism: "poly-antiprisms",
  elongated_prism: "poly-elongated",
  bipyramid: "poly-duals",
  trapezohedron: "poly-duals",
  johnson: "poly-johnson",
};

/** The number of solids a family slice opens, counted from the polyhedra catalogue (0 for a slice that is no family). */
export const solidsOfSlice = (slice: SliceId): number =>
  SOLID_NAMES_LIST.filter((s) => SOLID_FAMILY_SLICE[s.family] === slice).length;

/** The solids some slice opens (every solid of the catalogue, while each family has a slice). */
const GAME_SOLIDS = SOLID_NAMES_LIST.filter((s) => SOLID_FAMILY_SLICE[s.family] !== undefined).length;
/** The kinds of polyhedra problem the game deals with every family open (pairs of its solids), and of balls problem. */
export const GAME_PAIR_COUNT = GAME_SOLIDS * GAME_SOLIDS;
export const GAME_BALLS_COUNT = 1 + 2 * GAME_SOLIDS;

/** The later opened (dearer) of two slices. */
export const laterSlice = (a: SliceId, b: SliceId): SliceId =>
  SLICES.findIndex((s) => s.id === a) >= SLICES.findIndex((s) => s.id === b) ? a : b;
