/**
 * The problems of the polyhedra space: P congruent copies of a piece solid in the smallest scaled copy
 * s C of a container solid. The 86 problems of polyhedrainpolyhedra.wiki (upstream's scripts/engine.py,
 * PROBLEMS): the 25 Platonic pairs, the 13 Archimedean and 13 Catalan solids in themselves, the 5
 * prisms and 5 antiprisms in themselves and in a cube, and the 15 elongated prisms in a cube. Then
 * PolyPack's 64 in the same scheme (not on the wiki): the prisms and antiprisms with 7, 9, 10 and 11
 * sides in themselves and in a cube, and their 12 elongated prisms in a cube; and the 9 bipyramids and
 * 9 trapezohedra in themselves and in a cube.
 *
 * A problem is named by upstream's code `<piece code>in<container code>`, e.g. "cubintet" (cubes in a
 * tetrahedron) or "pr3l15incub" (triangular prisms of height 1.5 in a cube), and a problem with P
 * pieces has the PolyPack id `polyhedra/<code>/<P>`, e.g. "polyhedra/cubintet/12". The wiki shows the
 * same case at https://polyhedrainpolyhedra.wiki/#cubintet_n12.
 *
 * Every other ordered pair of the 186 solids is a problem too (2026-10-26; family "pairs", no wiki page, no record):
 * the same code scheme, e.g. "ktt" in "pkd" is "kttinpkd" (triakis tetrahedra in a pentakis dodecahedron).
 */
import { PROBLEM_NAMES, type ProblemFamily, type ProblemName, problemNameOf } from "./catalogue";
import { getSolid } from "./solids";

export type { ProblemFamily };

export type PolyhedraProblem = ProblemName;

/**
 * The 150 problems of the research records: upstream's 86 in upstream's order, then PolyPack's 64 (catalogue.ts names
 * them without loading the solids; python/polyhedra/catalogue.py has the same list). getProblem also knows the other
 * pairs of solids.
 */
export const POLYHEDRA_PROBLEMS: readonly PolyhedraProblem[] = PROBLEM_NAMES;

/** The problem of a code (any ordered pair of the solids), or null. */
export function getProblem(code: string): PolyhedraProblem | null {
  return problemNameOf(code);
}

/** Largest P an id may name (the work bounds of a check are set by the caller, see validate.ts). */
export const POLYHEDRA_ID_MAX_P = 9999;

export interface ParsedPolyhedraId {
  id: string;
  code: string;
  P: number;
  problem: PolyhedraProblem;
}

/**
 * The fields of a problem id `polyhedra/<code>/<P>`, or a message saying what is wrong. An id is
 * accepted only in its one written form (P without leading zeros or a sign), so that every case has
 * exactly one id.
 */
export function parsePolyhedraId(id: unknown): ParsedPolyhedraId | string {
  if (typeof id !== "string") return "id must be a string";
  if (id.length > 100) return "id is too long";
  const m = /^polyhedra\/([a-z0-9]+)\/(0|[1-9]\d{0,3})$/.exec(id);
  if (!m) return `"${id}" is not a polyhedra problem id: the form is polyhedra/<code>/<P>, for example polyhedra/cubintet/12`;
  const problem = getProblem(m[1]);
  if (!problem) return `"${m[1]}" is not a polyhedra problem code (a piece's and a container's solid codes joined by "in", for example cubincub, cubintet, tteintte, pr3l15incub, kttinpkd)`;
  const P = Number(m[2]);
  if (P < 1) return "P must be at least 1";
  return { id, code: m[1], P, problem };
}

export function formatPolyhedraId(code: string, P: number): string {
  return `polyhedra/${code}/${P}`;
}

/** The wiki's page of a case (its hash names the record id, n written with at least two digits); only for problems with `wiki`. */
export function wikiUrl(code: string, P: number): string {
  return `https://polyhedrainpolyhedra.wiki/#${code}_n${String(P).padStart(2, "0")}`;
}

/**
 * The volume bound s >= (P vol(piece) / vol(container))^(1/3): P disjoint pieces of total volume
 * P vol(piece) fit in s C only if vol(s C) = s^3 vol(C) is at least that much. [EST, elementary]
 */
export function volumeBound(problem: PolyhedraProblem, P: number): number {
  return Math.cbrt((P * getSolid(problem.piece).volume) / getSolid(problem.container).volume);
}
