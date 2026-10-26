/**
 * The dimensions of PolyPack's problems and the families filed under each: one table, read by the
 * board's Dimension and Kind menus (dimension-switch.ts) and by the dimensions page.
 *
 * A dimension is named by the pieces' dimension, "in" or "on", and the container's dimension.
 * "in" means inside a container; "on" means on a closed surface or boundary. Polygons in polygons
 * are 2D in 2D; polygons on the surface of a solid are 2D on 3D.
 *
 * Each family names the board mode that shows it: "polygon" (the classic board) or a space of the
 * API (/api/spaces/<space>). The API calls a dimension's families "spaces", and the space names
 * stay as they are, so that links (#space=...) and downloaded volunteer clients keep working.
 *
 * To make a family available, set `available: true`; its space must then be one the board can
 * show (BOARD_SPACES in space-address.ts), which the type below checks. A dimension with no
 * available family is listed, disabled, as "coming soon".
 *
 * No imports at run time, so that the default board can read it without loading the spaces.
 */
import type { BoardSpace } from "./space-address";

/** What a family opens on the board: the classic polygon board, or a space mode. */
export type FamilyTarget = BoardSpace | "polygon";

interface FamilyText {
  /** The name in the Kind menu and on the dimensions page. */
  name: string;
  /** A shorter name, for the records table's picker. */
  short: string;
  /** One plain sentence. */
  summary: string;
}

export type Family =
  | (FamilyText & { space: FamilyTarget; available: true })
  /** Coming soon: `space` is the name the API will use. */
  | (FamilyText & { space: string; available: false });

export interface Dimension {
  /** The value of the Dimension menu, e.g. "2-on-3". */
  id: string;
  /** "2D on 3D". */
  label: string;
  /** One or two plain sentences. */
  summary: string;
  families: readonly Family[];
}

export const DIMENSIONS: readonly Dimension[] = [
  {
    id: "2-in-2",
    label: "2D in 2D",
    summary: "Polygons and disks inside a polygon or disk container, in the flat plane or at constant curvature.",
    families: [
      {
        space: "polygon",
        name: "Flat",
        short: "Flat",
        summary:
          "Unit polygons or disks in the smallest regular polygon or disk in the flat plane: the board's classic problems.",
        available: true,
      },
      {
        space: "curved",
        name: "Curved",
        short: "Curved",
        summary:
          "Pieces in a container at constant curvature K: in the hyperbolic plane for K < 0, on a sphere for K > 0.",
        available: true,
      },
    ],
  },
  {
    id: "2-on-3",
    label: "2D on 3D",
    summary:
      "Polygons and disks on a closed surface, with no container: the surface of a polyhedron (a Platonic or Catalan solid, a prism or an antiprism), a sphere or a flat torus. A flat torus is pictured as a surface in 3D, although it cannot be embedded there both flat and smooth.",
    families: [
      {
        space: "surface",
        name: "Polyhedral surfaces",
        short: "Surfaces",
        summary:
          "Pieces on the surface of a Platonic solid, a Catalan solid, a prism or an antiprism, with or without folding over its edges.",
        available: true,
      },
      {
        space: "sphere",
        name: "Sphere",
        short: "Sphere",
        summary: "Pieces on a whole sphere: the score is the sphere's radius.",
        available: true,
      },
      {
        space: "torus",
        name: "Torus",
        short: "Torus",
        summary: "Pieces on a flat torus, a plane that repeats along a lattice.",
        available: true,
      },
    ],
  },
  {
    id: "3-in-3",
    label: "3D in 3D",
    summary: "Polyhedra packed inside a polyhedron.",
    families: [
      {
        space: "polyhedra",
        name: "Polyhedra",
        short: "Polyhedra",
        summary:
          "Equal polyhedra in the smallest copy of a container polyhedron: Platonic, Archimedean and Catalan solids, prisms and antiprisms, up to 100 pieces.",
        available: true,
      },
    ],
  },
  {
    id: "3-on-4",
    label: "3D on 4D",
    summary:
      "Solids on the boundary of a 4D polytope, with no container. The boundary is a closed 3D space made of solid cells, as the surface of a solid is made of flat faces.",
    families: [
      {
        space: "boundary",
        name: "Polytope boundaries",
        short: "Boundaries",
        summary:
          "Unit balls or cubes on the boundary of a 4D polytope, starting with the tesseract, the 4D cube: its boundary is eight cubes glued face to face.",
        available: true,
      },
    ],
  },
];

/** The families of a dimension that can be shown now. */
export const availableFamilies = (d: Dimension) =>
  d.families.filter((f): f is Extract<Family, { available: true }> => f.available);

/** A dimension can be chosen when at least one of its families is available. */
export const isAvailable = (d: Dimension): boolean => d.families.some((f) => f.available);

/** The dimension and the family that show a board mode, or null when none does. */
export function whereIs(target: string): { dimension: Dimension; family: Family } | null {
  for (const dimension of DIMENSIONS)
    for (const family of dimension.families)
      if (family.available && family.space === target) return { dimension, family };
  return null;
}

/** The dimension and the family of an API space, available or not, or null. */
export function familyOfSpace(space: string): { dimension: Dimension; family: Family } | null {
  for (const dimension of DIMENSIONS)
    for (const family of dimension.families) if (family.space === space) return { dimension, family };
  return null;
}

/** "2D on 3D, Sphere": a family with its dimension, for sentences. */
export function familyTitle(target: string): string {
  const where = familyOfSpace(target);
  return where ? `${where.dimension.label}, ${where.family.name}` : target;
}
