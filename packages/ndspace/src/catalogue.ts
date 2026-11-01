/**
 * The problems of the nD in nD space (docs/spaces/NDIM.md §10): P equal pieces in the smallest scaled container, both a
 * polytope of the dimension's catalogue (packages/ndim) or a ball, in dimension d = 4 to 10.
 *
 * Names only, so that a page can name problems without loading any coordinates (the facts about the polytopes, their
 * volumes and radii, are the ndim package's `info` module, also free of coordinates). One space holds every dimension:
 * a problem is `ndim/<d>/<piece>/<container>/<P>`, e.g. "ndim/4/hypercube/ball/12" is written "ndim/4/cube/ball/12":
 * the shape names are the catalogue's ("simplex", "cube", "ortho", "demi", "24cell", "120cell", "600cell", "221", "122",
 * "321", "421") and "ball". Every ordered pair of the dimension's shapes is a problem, balls included (balls in each
 * polytope, each polytope in a ball, balls in a ball), and P runs over the dimension's range (ND_P_RANGE).
 */
import { INFO } from "@polypack/ndim/info";

export const ND_MIN_D = 4;
export const ND_MAX_D = 10;
export const ND_BALL = "ball";

/** The polytopes of each dimension's catalogue, by catalogue name, in the catalogue's order (the ndim package's tests check this list). */
export const ND_POLYTOPES: Readonly<Record<number, readonly string[]>> = {
  4: ["simplex", "cube", "ortho", "24cell", "120cell", "600cell"],
  5: ["simplex", "cube", "ortho", "demi"],
  6: ["simplex", "cube", "ortho", "demi", "221", "122"],
  7: ["simplex", "cube", "ortho", "demi", "321"],
  8: ["simplex", "cube", "ortho", "demi", "421"],
  9: ["simplex", "cube", "ortho", "demi"],
  10: ["simplex", "cube", "ortho", "demi"],
};

/**
 * Smallest and largest P of each dimension: upstream's ranges for the first three (alejandrozu/platonic-packing, 4D to 40,
 * 5D to 32, 6D to 24) and 2 to 20 above.
 */
export const ND_P_RANGE: Readonly<Record<number, readonly [number, number]>> = {
  4: [2, 40],
  5: [2, 32],
  6: [2, 24],
  7: [2, 20],
  8: [2, 20],
  9: [2, 20],
  10: [2, 20],
};
export const ND_MAX_P = 40;
export const ND_DIMENSIONS: readonly number[] = [4, 5, 6, 7, 8, 9, 10];

/** The shape names of a dimension: its polytopes, then "ball". */
export function ndShapes(d: number): readonly string[] {
  const list = ND_POLYTOPES[d];
  return list ? [...list, ND_BALL] : [];
}

/** All shape names that occur, in the order of first appearance (the menus' values). */
export const ND_SHAPE_NAMES: readonly string[] = [
  ...new Set([...ND_DIMENSIONS.flatMap((d) => ND_POLYTOPES[d]), ND_BALL]),
];

/** The catalogue code of a shape ("4:cube"), or "ball". */
export const ndCode = (d: number, shape: string): string => (shape === ND_BALL ? ND_BALL : `${d}:${shape}`);

/** Number of problems of a dimension: its ordered pairs of shapes times its P range. */
export function ndProblemCount(d: number): number {
  const range = ND_P_RANGE[d];
  const n = ndShapes(d).length;
  return range ? n * n * (range[1] - range[0] + 1) : 0;
}
export const ND_PROBLEM_COUNT = ND_DIMENSIONS.reduce((s, d) => s + ndProblemCount(d), 0);

const SHAPE_TITLES: Record<string, { one: string; many: string }> = {
  simplex: { one: "simplex", many: "simplices" },
  cube: { one: "hypercube", many: "hypercubes" },
  ortho: { one: "orthoplex", many: "orthoplexes" },
  demi: { one: "demicube", many: "demicubes" },
  "24cell": { one: "24-cell", many: "24-cells" },
  "120cell": { one: "120-cell", many: "120-cells" },
  "600cell": { one: "600-cell", many: "600-cells" },
  "221": { one: "2_21 polytope", many: "2_21 polytopes" },
  "122": { one: "1_22 polytope", many: "1_22 polytopes" },
  "321": { one: "3_21 polytope", many: "3_21 polytopes" },
  "421": { one: "4_21 polytope", many: "4_21 polytopes" },
  ball: { one: "ball", many: "balls" },
};
const article = (t: string) => (/^[aeiou]/i.test(t) ? `an ${t}` : `a ${t}`);
const capital = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

/** "Hypercubes in an orthoplex" (without the dimension; ndTitle adds it). */
export function ndPairTitle(piece: string, container: string): string {
  return `${capital(SHAPE_TITLES[piece]?.many ?? piece)} in ${article(SHAPE_TITLES[container]?.one ?? container)}`;
}
/** "4D: Hypercubes in an orthoplex". */
export const ndTitle = (d: number, piece: string, container: string): string =>
  `${d}D: ${ndPairTitle(piece, container)}`;

/** Title of a shape in the menus of a dimension: "Hypercube", "Ball". */
export const ndShapeTitle = (shape: string): string => capital(SHAPE_TITLES[shape]?.one ?? shape);

export interface NdProblemId {
  d: number;
  piece: string;
  container: string;
  P: number;
}

export interface ParsedNdId extends NdProblemId {
  id: string;
}

export const ND_ID_FORM =
  "ndim/<d>/<piece>/<container>/<P>, d from 4 to 10, piece and container a polytope of the dimension (simplex, cube, ortho, demi, 24cell, 120cell, 600cell, 221, 122, 321, 421) or ball";

const INT = /^[1-9]\d{0,3}$/;

/**
 * The fields of an id `ndim/<d>/<piece>/<container>/<P>`, or a message saying what is wrong. Ids are accepted only in
 * their one written form. The dimension's P range is the caller's to apply (ndInRange).
 */
export function parseNdId(id: unknown): ParsedNdId | string {
  if (typeof id !== "string") return "id must be a string";
  if (id.length > 100) return "id is too long";
  const parts = id.split("/");
  const bad = `"${id}" is not an ndim problem id: the form is ${ND_ID_FORM}`;
  if (parts.length !== 5 || parts[0] !== "ndim") return bad;
  const [, dt, piece, container, pt] = parts;
  if (!INT.test(dt) || !INT.test(pt)) return bad;
  const d = Number(dt);
  const shapes = ndShapes(d);
  if (!shapes.includes(piece) || !shapes.includes(container)) return bad;
  return { id, d, piece, container, P: Number(pt) };
}

export const formatNdId = (d: number, piece: string, container: string, P: number): string =>
  `ndim/${d}/${piece}/${container}/${P}`;

/** True when P is in the dimension's range. */
export function ndInRange(d: number, P: number): boolean {
  const r = ND_P_RANGE[d];
  return !!r && Number.isInteger(P) && P >= r[0] && P <= r[1];
}

/** The polytopes' facts by catalogue code, for the titles and counts (no coordinates). */
export const ND_INFO = new Map(INFO.map((i) => [i.code, i]));
