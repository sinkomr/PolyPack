/**
 * The contract of the boundary space: equal (d-1)-dimensional pieces packed on the boundary of a
 * convex d-polytope. Under Dimensions it is shown as "3D on 4D" for d = 4 (3D pieces on the
 * boundary of a 4-polytope); "4D on 5D" would follow the same contract.
 *
 * The boundary is a closed (d-1)-dimensional space made of flat cells (the polytope's facets),
 * glued along their own facets (the polytope's ridges: 2-faces for d = 4). All its curvature sits
 * on the (d-3)-faces (the edges for d = 4), where the cells around fall short of a full turn. A
 * piece is placed in one cell (its anchor) and may fold across ridges into neighbouring cells, but
 * no point of the (d-3)-skeleton may lie in its interior.
 *
 * Units: a ball has diameter 1 (radius 1/2, BALL_RADIUS in units.ts), a polytope piece has edge 1; the score s is the
 * container's edge length, smaller is better. Every length below is given at s = 1 and scales
 * with s, except piece sizes, which stay 1.
 *
 * This file names shapes only. The engine (packages/boundary/src) implements them; the viewers
 * (packages/view3d) and the spaces registry (packages/spaces) read them.
 */

/** Containers. The engine is generic over convex polytopes; the catalogue grows one name at a time. */
export type PolytopeName = "tesseract";
export const POLYTOPES: readonly PolytopeName[] = ["tesseract"];

/** Pieces. A ball is the (d-1)-ball of diameter 1; the others are unit-edge regular (d-1)-polytopes. */
export type PieceName = "ball" | "cube";
export const PIECES: readonly PieceName[] = ["ball", "cube"];

/**
 * A problem: P pieces of one kind on one polytope. Its id is written
 * `boundary/<polytope>/<piece>/<P>`, e.g. `boundary/tesseract/ball/9`, in exactly one form.
 */
export interface BoundaryProblem {
  polytope: PolytopeName;
  piece: PieceName;
  P: number;
}

/** A unit quaternion (w, x, y, z): a rotation of 3-space, for d = 4. */
export type Quaternion = [number, number, number, number];

/**
 * One piece of a configuration.
 *  - `cell`: index of the anchor cell (Polytope.cells), the cell that holds the piece's centre.
 *  - `u`: the centre in the anchor cell's local coordinates (d-1 numbers) at the configuration's s,
 *    the cell's centre at the origin. It must lie in the closed cell.
 *  - `q`: rotation of the piece from its standard pose, in the anchor cell's local frame (d = 4).
 *    Absent for balls; absent means no rotation for the other pieces.
 */
export interface BoundaryPiece {
  cell: number;
  u: number[];
  q?: Quaternion;
}

/** A configuration: the container's edge s (the score) and the pieces. */
export interface BoundaryConfig {
  s: number;
  pieces: BoundaryPiece[];
}

/** An affine map of R^n: y = A x + b (A row-major, n x n). */
export interface Affine {
  A: number[][];
  b: number[];
}

/** A closed half-space { y : n . y <= h } of R^n. */
export interface HalfSpace {
  n: number[];
  h: number;
}

/**
 * A facet of a cell (a ridge of the polytope), in the cell's local coordinates at s = 1: the cell
 * lies in `inside`. Across it the cell is glued to `neighbor`.
 *
 * `toNeighbor` is the gluing as the development sees it: for a point y written in this cell's
 * local frame but lying beyond this facet (the neighbour unfolded flat into this cell's
 * hyperplane), `toNeighbor` gives its coordinates in the neighbour's local frame. It is an
 * isometry and fixes the shared ridge pointwise. At edge s its translation scales by s:
 * y' = A y + s b. The neighbour's matching facet holds the inverse map.
 */
export interface CellFacet {
  inside: HalfSpace;
  neighbor: number;
  /** Index of the matching facet in the neighbour's `facets`. */
  neighborFacet: number;
  toNeighbor: Affine;
  /**
   * (Engine addition.) The ridge polygon: indices into the cell's `vertices`, in cyclic order,
   * counter-clockwise seen from outside the cell (around `inside.n`).
   */
  vertices: number[];
}

/**
 * A cell (a facet of the polytope) at s = 1. Local coordinates u map to the ambient space by
 * x = origin + sum_k u_k frame[k] (scaled by s: x = s origin + sum_k u_k frame[k]).
 */
export interface Cell {
  index: number;
  /** Outward unit normal of the cell's hyperplane in R^d. */
  normal: number[];
  /** The cell's centre in R^d, the origin of its local coordinates. */
  origin: number[];
  /** d-1 orthonormal vectors of R^d spanning the cell's hyperplane: the local axes. */
  frame: number[][];
  /** The cell's vertices in local coordinates. */
  vertices: number[][];
  /** The cell's (d-3)-faces (edges for d = 4) as pairs of indices into `vertices`: the singular set. */
  hinges: [number, number][];
  facets: CellFacet[];
  /** (Engine addition.) Index in Polytope.vertices of each entry of `vertices` (ascending). */
  vertexIds: number[];
}

/** A convex d-polytope with unit edge, centred at the origin. */
export interface Polytope {
  name: PolytopeName;
  /** Ambient dimension d (4 for the tesseract); cells and pieces have dimension d - 1. */
  d: number;
  /** Vertices in R^d. */
  vertices: number[][];
  cells: Cell[];
  /** Total angle around each hinge, in radians (the full turn minus the deficit). */
  hingeAngle: number;
  /** (Engine addition.) The polytope's edges (the hinges) as pairs of indices into `vertices`, sorted. */
  edges: [number, number][];
  /**
   * (Engine addition.) Total angle around each edge (aligned with `edges`): the sum of the
   * dihedral angles at that edge of the cells containing it. `hingeAngle` is the smallest.
   */
  edgeAngles: number[];
}

/**
 * The part of a piece that lies in one cell, for drawing and checking. The piece in its standard
 * pose (piece-local coordinates, unit size, centred at the origin) is mapped into the holding
 * cell's local coordinates by `place`, then cut by the cell itself and by `clip` (the window of the
 * chain of ridges crossed from the anchor). Parts of distinct pieces, and two parts of one piece in
 * the same cell, have disjoint interiors in a valid configuration.
 */
export interface PiecePart {
  /** Index into the configuration's pieces. */
  piece: number;
  /** The cell holding this part. */
  cell: number;
  /** Cells crossed from the anchor, anchor first, this cell last (length 1 for the anchor's own part). */
  chain: number[];
  /** Piece-local coordinates -> this cell's local coordinates, at the configuration's s. */
  place: Affine;
  /** Half-spaces in this cell's local coordinates, besides the cell's own, that bound the part. */
  clip: HalfSpace[];
}

/**
 * Where a cell sits in an unfolded net: its local coordinates -> net coordinates (R^{d-1}),
 * at s = 1 (scale translations by s). The tree edges say which ridge joins each cell to its parent.
 */
export interface NetPlacement {
  cell: number;
  place: Affine;
  /** The parent cell in the unfolding tree and the facet of this cell glued to it; null at the root. */
  parent: { cell: number; facet: number } | null;
}

/** Why a configuration is invalid, or that it is valid, by the float rule (tolerance tol). */
export interface BoundaryVerdict {
  ok: boolean;
  /** The configuration's s when it is valid. */
  score: number | null;
  /** Plain sentences, empty when valid. */
  reasons: string[];
}

/**
 * What the engine (packages/boundary/src/index.ts) exports, for the viewers and the registry:
 *
 *   getPolytope(name: PolytopeName): Polytope
 *   parseBoundaryId(id: string): BoundaryProblem | string;  formatBoundaryId(p: BoundaryProblem): string
 *   standardPiece(piece: PieceName, d: number): { kind: "ball" } | { kind: "polytope"; vertices: number[][]; faces: number[][] }
 *   pieceParts(poly: Polytope, piece: PieceName, config: BoundaryConfig): PiecePart[]
 *   defaultNet(poly: Polytope): NetPlacement[]           (the Dali cross for the tesseract)
 *   toAmbient(poly: Polytope, cell: number, u: number[], s: number): number[]
 *   validateBoundary(problem: BoundaryProblem, config: unknown, opts?: { tol?: number }): BoundaryVerdict
 *   searchBoundary(problem, { start?, seed, budget: { evals, time_s? }, shouldStop?, onImprove? }): { config, score, ... }
 */
