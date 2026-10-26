/**
 * The problems of the balls space without their geometry: P unit balls in the smallest ball or cube, and P
 * unit-edge Platonic solids in the smallest ball. No imports, so that a page can name problems without loading
 * any coordinates.
 *
 * A problem is named by a code `<piece>in<container>` in the manner of the polyhedra space ("cubintet"): the
 * piece is `ball` or a Platonic solid's code (tet, cub, oct, dod, ico, as the polyhedra space names them), the
 * container `ball` or `cub`. With P pieces its id is `balls/<code>/<P>`, e.g. "balls/ballinball/13".
 */

export type BallsPiece = "ball" | "tetrahedron" | "cube" | "octahedron" | "dodecahedron" | "icosahedron";
export type BallsContainer = "ball" | "cube";

export interface BallsProblem {
  /** e.g. "ballinball", "ballincub", "tetinball". */
  code: string;
  /** "ball", or the polyhedra space's name of a Platonic solid. */
  piece: BallsPiece;
  container: BallsContainer;
  /** "Balls in a ball", "Tetrahedra in a ball". */
  title: string;
}

export const BALLS_PROBLEMS: readonly BallsProblem[] = [
  { code: "ballinball", piece: "ball", container: "ball", title: "Balls in a ball" },
  { code: "ballincub", piece: "ball", container: "cube", title: "Balls in a cube" },
  { code: "tetinball", piece: "tetrahedron", container: "ball", title: "Tetrahedra in a ball" },
  { code: "cubinball", piece: "cube", container: "ball", title: "Cubes in a ball" },
  { code: "octinball", piece: "octahedron", container: "ball", title: "Octahedra in a ball" },
  { code: "dodinball", piece: "dodecahedron", container: "ball", title: "Dodecahedra in a ball" },
  { code: "icoinball", piece: "icosahedron", container: "ball", title: "Icosahedra in a ball" },
];

/** The codes in catalogue order. */
export const BALLS_CODES: readonly string[] = BALLS_PROBLEMS.map((p) => p.code);

/** Smallest and largest P of the catalogue. */
export const BALLS_MIN_P = 2;
export const BALLS_MAX_P = 100;

const BY_CODE = new Map(BALLS_PROBLEMS.map((p) => [p.code, p]));

/** The problem of a code, or null. */
export function ballsProblemOf(code: string): BallsProblem | null {
  return BY_CODE.get(code) ?? null;
}

/** "Balls in a ball" for a code; the code itself when it names no problem. */
export function ballsTitle(code: string): string {
  return BY_CODE.get(code)?.title ?? code;
}

export interface ParsedBallsId {
  id: string;
  code: string;
  P: number;
  problem: BallsProblem;
}

/**
 * The fields of a problem id `balls/<code>/<P>`, or a message saying what is wrong. An id is accepted only in its
 * one written form (P from 1 without leading zeros or a sign), so that every problem has exactly one id. The
 * catalogue's P range (BALLS_MIN_P to BALLS_MAX_P) is the caller's to apply.
 */
export function parseBallsId(id: unknown): ParsedBallsId | string {
  if (typeof id !== "string") return "id must be a string";
  if (id.length > 100) return "id is too long";
  const m = /^balls\/([a-z]+)\/([1-9]\d{0,3})$/.exec(id);
  if (!m)
    return `"${id}" is not a balls problem id: the form is balls/<code>/<P>, code one of ${BALLS_CODES.join(", ")}`;
  const problem = ballsProblemOf(m[1]);
  if (!problem) return `"${m[1]}" is not a balls problem code (one of ${BALLS_CODES.join(", ")})`;
  return { id, code: m[1], P: Number(m[2]), problem };
}

export function formatBallsId(code: string, P: number): string {
  return `balls/${code}/${P}`;
}
