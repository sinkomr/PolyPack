/**
 * The problems of the balls space without their geometry: P unit balls in the smallest ball or in the smallest
 * copy of any of the polyhedra space's 186 solids, and P unit-edge solids (any of the 186) in the smallest ball.
 * Names only, so that a page can name problems without loading any coordinates (the polyhedra space's catalogue
 * is as light).
 *
 * A problem is named by a code `<piece>in<container>` in the manner of the polyhedra space ("cubintet"): the
 * piece is `ball` or a solid's code (tet, cub, oct, dod, ico, tte, pr3l15, ... as the polyhedra space names
 * them), the container `ball` or a solid's code. With P pieces its id is `balls/<code>/<P>`, e.g.
 * "balls/ballinball/13", "balls/ballinpkd/20" (balls in a pentakis dodecahedron), "balls/ap5inball/7".
 *
 * Without a piece or container of the other kind there are 1 + 186 + 186 = 373 codes: balls in a ball, balls in
 * each of the 186 solids (the 94 of the first catalogue and the 92 Johnson solids), and each of the 186 solids in a ball. The first 7 (BALLS_ORIGINAL_CODES) are the space's
 * first problems, and their ids are unchanged.
 */
import { SOLID_NAMES_LIST, type SolidName, pluralTitle } from "@polypack/polyhedra/catalogue";

/**
 * The radius of a ball piece, in the units of the space (balls have diameter 1; the polyhedra space's solids have edge 1). Every length
 * of the space that is a ball's size goes through this constant (the validator, the bounds, the search, the
 * kernel, the certifier's python/balls/balls_catalogue.py BALL_RADIUS and the board's drawing).
 */
export const BALL_RADIUS = 0.5;
/**
 * The score of a ball container as a function of its radius, and back. The score s of a ball container is its
 * DIAMETER (2026-10-27, option A of the unit change): radius = s / 2. Every ball-container bound and wall test goes
 * through these functions.
 */
const SCORE_TO_RADIUS = 0.5;
let radiusPerScore = SCORE_TO_RADIUS;
export const ballContainerScore = (radius: number): number => radius / radiusPerScore;
export const ballContainerRadius = (score: number): number => radiusPerScore * score;
/** d(radius) / d(score): the factor of every gradient with respect to the size of a ball container. */
export const ballContainerRadiusSlope = (): number => radiusPerScore;
/** Test hook: a linear conversion radius = k score (2 for a score that is half the radius, 0.5 for the diameter). */
export function setBallContainerConversionForTests(k: number | null): void {
  radiusPerScore = k ?? SCORE_TO_RADIUS;
}
/** The least distance of two ball centres. */
export const BALL_DIAMETER = 2 * BALL_RADIUS;

/** "ball", or the polyhedra space's name of a solid ("cube", "pentakis_dodecahedron", "prism3_l15"). */
export type BallsPiece = string;
export type BallsContainer = string;

export interface BallsProblem {
  /** e.g. "ballinball", "ballincub", "tetinball", "ballinpkd". */
  code: string;
  /** "ball", or the polyhedra space's name of a solid. */
  piece: BallsPiece;
  /** "ball", or the polyhedra space's name of a solid ("cube" for the cube). */
  container: BallsContainer;
  /** "Balls in a ball", "Triakis tetrahedra in a ball", "Balls in a pentakis dodecahedron". */
  title: string;
  /** The group of the problem in the board's menu, e.g. "Balls in a Catalan solid". */
  group: string;
}

const article = (title: string) => (/^[aeiouAEIOU]/.test(title) ? `an ${title}` : `a ${title}`);
const capital = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

const FAMILY_LABEL: Record<SolidName["family"], string> = {
  platonic: "Platonic solid",
  archimedean: "Archimedean solid",
  catalan: "Catalan solid",
  prism: "prism",
  antiprism: "antiprism",
  elongated_prism: "elongated prism",
  bipyramid: "bipyramid",
  trapezohedron: "trapezohedron",
  johnson: "Johnson solid",
};
const FAMILY_ORDER = Object.keys(FAMILY_LABEL) as SolidName["family"][];
const FAMILY_PLURAL: Record<SolidName["family"], string> = {
  platonic: "Platonic solids",
  archimedean: "Archimedean solids",
  catalan: "Catalan solids",
  prism: "Prisms",
  antiprism: "Antiprisms",
  elongated_prism: "Elongated prisms",
  bipyramid: "Bipyramids",
  trapezohedron: "Trapezohedra",
  johnson: "Johnson solids",
};

/** Sort key of a solid within its family: the number of sides, then the height of an elongated prism. */
function solidRank(s: SolidName): [number, number] {
  const m = /^(?:prism|antiprism|bipyramid|trapezohedron)(\d+)(?:_(l15|l2|l3))?$/.exec(s.name);
  return m ? [Number(m[1]), m[2] ? ["l15", "l2", "l3"].indexOf(m[2]) : 0] : [0, 0];
}

/** The 186 solids in the order of the board's menu: by family, then (prisms and the like) by sides and height. */
const SOLIDS: readonly SolidName[] = FAMILY_ORDER.flatMap((f) =>
  SOLID_NAMES_LIST.filter((s) => s.family === f)
    .map((s, i) => ({ s, i, k: solidRank(s) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i)
    .map((e) => e.s),
);

function build(): BallsProblem[] {
  const out: BallsProblem[] = [];
  const ballsIn = (container: string, code: string, title: string, group: string) =>
    out.push({ code: `ballin${code}`, piece: "ball", container, title: `Balls in ${article(title)}`, group });
  // balls in a ball, then in the Platonic solids, ..., trapezohedra
  ballsIn("ball", "ball", "ball", "Balls in a ball or a Platonic solid");
  for (const s of SOLIDS)
    ballsIn(
      s.name,
      s.code,
      s.title,
      s.family === "platonic" ? "Balls in a ball or a Platonic solid" : `Balls in ${article(FAMILY_LABEL[s.family])}`,
    );
  for (const s of SOLIDS)
    out.push({
      code: `${s.code}inball`,
      piece: s.name,
      container: "ball",
      title: `${capital(pluralTitle(s.title))} in a ball`,
      group: `${FAMILY_PLURAL[s.family]} in a ball`,
    });
  return out;
}

export const BALLS_PROBLEMS: readonly BallsProblem[] = build();

/**
 * The codes of the space's first 7 problems, in their first order: balls in a ball and in a cube, and the five
 * Platonic solids in a ball. The volunteers' work list sampled these only (problems.ts ballsDomain.sample) until it was
 * removed on 2026-10-29.
 */
export const BALLS_ORIGINAL_CODES: readonly string[] = [
  "ballinball",
  "ballincub",
  "tetinball",
  "cubinball",
  "octinball",
  "dodinball",
  "icoinball",
];

/**
 * One container and one piece solid from each family, the long and the flat among the prisms: a sample for the
 * tests that cannot run the 373 problems (the kernel's contract, every method, Auto).
 */
export const BALLS_FAMILY_SAMPLE: readonly string[] = [
  "ballintet",
  "ballintte",
  "ballinpkd",
  "ballinpr3",
  "ballinpr12",
  "ballinap5",
  "ballinpr7l3",
  "ballinbp5",
  "ballintz8",
  "tteinball",
  "kttinball",
  "pr3inball",
  "ap4inball",
  "pr3l3inball",
  "bp7inball",
  "tz6inball",
  "phcinball",
];

/** The codes in catalogue order. */
export const BALLS_CODES: readonly string[] = BALLS_PROBLEMS.map((p) => p.code);

/** A few codes for a message ("ballinball, ballincub, ..."), the list being 373 long. */
export const BALLS_CODES_HINT = `${BALLS_CODES.slice(0, 6).join(", ")}, ... (<piece>in<container>, the piece or the container ball or a solid's code of the polyhedra space; GET /api/spaces lists them)`;

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
  const m = /^balls\/([a-z][a-z0-9]*)\/([1-9]\d{0,3})$/.exec(id);
  if (!m)
    return `"${id}" is not a balls problem id: the form is balls/<code>/<P>, code ${BALLS_CODES_HINT}`;
  const problem = ballsProblemOf(m[1]);
  if (!problem) return `"${m[1]}" is not a balls problem code (${BALLS_CODES_HINT})`;
  return { id, code: m[1], P: Number(m[2]), problem };
}

export function formatBallsId(code: string, P: number): string {
  return `balls/${code}/${P}`;
}
