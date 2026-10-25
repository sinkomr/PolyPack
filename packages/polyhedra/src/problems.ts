/**
 * The problems of the polyhedra space: P congruent copies of a piece solid in the smallest scaled copy
 * s C of a container solid, as listed by polyhedrainpolyhedra.wiki (upstream's scripts/engine.py,
 * PROBLEMS): the 25 Platonic pairs, the 13 Archimedean and 13 Catalan solids in themselves, the 5
 * prisms and 5 antiprisms in themselves and in a cube, and the 15 elongated prisms in a cube.
 *
 * A problem is named by upstream's code `<piece code>in<container code>`, e.g. "cubintet" (cubes in a
 * tetrahedron) or "pr3l15incub" (triangular prisms of height 1.5 in a cube), and a problem with P
 * pieces has the PolyPack id `polyhedra/<code>/<P>`, e.g. "polyhedra/cubintet/12". The wiki shows the
 * same case at https://polyhedrainpolyhedra.wiki/#cubintet_n12.
 */
import { PROBLEM_NAMES, type ProblemFamily, type ProblemName } from "./catalogue";
import { getSolid } from "./solids";

export type { ProblemFamily };

export type PolyhedraProblem = ProblemName;

/** The 86 problems, in upstream's order (catalogue.ts names them without loading the solids). */
export const POLYHEDRA_PROBLEMS: readonly PolyhedraProblem[] = PROBLEM_NAMES;

const BY_CODE = new Map(POLYHEDRA_PROBLEMS.map((p) => [p.code, p]));

/** The problem of a code, or null. */
export function getProblem(code: string): PolyhedraProblem | null {
  return BY_CODE.get(code) ?? null;
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
  if (!problem) return `"${m[1]}" is not a polyhedra problem code (for example cubincub, cubintet, tteintte, pr3l15incub)`;
  const P = Number(m[2]);
  if (P < 1) return "P must be at least 1";
  return { id, code: m[1], P, problem };
}

export function formatPolyhedraId(code: string, P: number): string {
  return `polyhedra/${code}/${P}`;
}

/** The wiki's page of a case (its hash names the record id, n written with at least two digits). */
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
