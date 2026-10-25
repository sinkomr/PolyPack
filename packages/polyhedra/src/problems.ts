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
import { getSolid, type Solid } from "./solids";

export type ProblemFamily = "platonic" | "archimedean" | "catalan" | "prisms";

export interface PolyhedraProblem {
  /** Upstream's problem code, e.g. "cubintet". */
  code: string;
  /** Piece and container solid names. */
  piece: string;
  container: string;
  family: ProblemFamily;
  /** e.g. "Cubes in a tetrahedron". */
  title: string;
}

const PLATONIC = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];
const ARCHIMEDEAN = [
  "truncated_tetrahedron",
  "cuboctahedron",
  "truncated_cube",
  "truncated_octahedron",
  "rhombicuboctahedron",
  "truncated_cuboctahedron",
  "snub_cube",
  "icosidodecahedron",
  "truncated_dodecahedron",
  "truncated_icosahedron",
  "rhombicosidodecahedron",
  "truncated_icosidodecahedron",
  "snub_dodecahedron",
];
const CATALAN = [
  "triakis_tetrahedron",
  "rhombic_dodecahedron",
  "triakis_octahedron",
  "tetrakis_hexahedron",
  "deltoidal_icositetrahedron",
  "disdyakis_dodecahedron",
  "pentagonal_icositetrahedron",
  "rhombic_triacontahedron",
  "triakis_icosahedron",
  "pentakis_dodecahedron",
  "deltoidal_hexecontahedron",
  "disdyakis_triacontahedron",
  "pentagonal_hexecontahedron",
];
const PRISMS = [3, 5, 6, 8, 12].map((k) => `prism${k}`).concat([4, 5, 6, 8, 12].map((k) => `antiprism${k}`));
const ELONGATED = [3, 5, 6, 8, 12].flatMap((k) => ["l15", "l2", "l3"].map((t) => `prism${k}_${t}`));

function plural(s: Solid): string {
  const t = s.title;
  if (t.startsWith("triangular prism of") || / prism of height/.test(t)) return t.replace(" prism of", " prisms of");
  if (t.endsWith("hedron")) return t.slice(0, -2) + "a";
  return t + "s";
}

function article(s: Solid): string {
  return /^[aeiou]/.test(s.title) ? `an ${s.title}` : `a ${s.title}`;
}

function problemOf(piece: string, container: string, family: ProblemFamily): PolyhedraProblem {
  const P = getSolid(piece);
  const C = getSolid(container);
  const what = plural(P);
  return {
    code: `${P.code}in${C.code}`,
    piece,
    container,
    family,
    title: `${what[0].toUpperCase()}${what.slice(1)} in ${article(C)}`,
  };
}

function build(): PolyhedraProblem[] {
  // upstream's order: the self-packings and the cube/octahedron and dodecahedron/icosahedron duals
  // first, then the other Platonic pairs piece by piece, then the families
  const first: [string, string][] = [
    ["tetrahedron", "tetrahedron"],
    ["octahedron", "octahedron"],
    ["icosahedron", "icosahedron"],
    ["dodecahedron", "dodecahedron"],
    ["cube", "cube"],
    ["cube", "octahedron"],
    ["octahedron", "cube"],
    ["dodecahedron", "icosahedron"],
    ["icosahedron", "dodecahedron"],
  ];
  const pairs = [...first];
  for (const p of PLATONIC)
    for (const c of PLATONIC) if (!pairs.some(([a, b]) => a === p && b === c)) pairs.push([p, c]);
  const out = pairs.map(([p, c]) => problemOf(p, c, "platonic"));
  for (const s of ARCHIMEDEAN) out.push(problemOf(s, s, "archimedean"));
  for (const s of CATALAN) out.push(problemOf(s, s, "catalan"));
  for (const s of PRISMS) for (const c of [s, "cube"]) out.push(problemOf(s, c, "prisms"));
  for (const s of ELONGATED) out.push(problemOf(s, "cube", "prisms"));
  return out;
}

/** The 86 problems, in upstream's order. */
export const POLYHEDRA_PROBLEMS: readonly PolyhedraProblem[] = build();

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
