/**
 * The names of the polyhedra space without its geometry: the solids' names, codes and titles and the problems: the
 * 86 of polyhedrainpolyhedra.wiki (upstream's scripts/engine.py: AB, ARCHIMEDEAN, CATALAN, PRISMS, PROBLEMS; MIT, see
 * THIRD_PARTY_NOTICES.md), then PolyPack's 36: each bipyramid and trapezohedron (the canonical duals of the unit-edge
 * prisms and antiprisms, docs/spaces/POLYHEDRA.md) in itself and in a cube. No imports, so that a page can name
 * problems without loading the solids' coordinates; problems.ts builds the same list with the solids attached.
 */

export type SolidFamily =
  | "platonic"
  | "archimedean"
  | "catalan"
  | "prism"
  | "antiprism"
  | "elongated_prism"
  | "bipyramid"
  | "trapezohedron";
export type ProblemFamily = "platonic" | "archimedean" | "catalan" | "prisms" | "bipyramids" | "trapezohedra";

export interface SolidName {
  /** Upstream's name, e.g. "truncated_tetrahedron", "prism3_l15". */
  name: string;
  /** Upstream's code, e.g. "tte", "pr3l15". */
  code: string;
  family: SolidFamily;
  /** Plain name, e.g. "truncated tetrahedron", "triangular prism of height 1.5". */
  title: string;
}

export const PLATONIC_SOLIDS = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"] as const;
export const ARCHIMEDEAN_SOLIDS = [
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
] as const;
export const CATALAN_SOLIDS = [
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
] as const;

const CODES: Record<string, string> = {
  tetrahedron: "tet",
  cube: "cub",
  octahedron: "oct",
  dodecahedron: "dod",
  icosahedron: "ico",
  truncated_tetrahedron: "tte",
  cuboctahedron: "cbo",
  truncated_cube: "tcu",
  truncated_octahedron: "toc",
  rhombicuboctahedron: "rco",
  truncated_cuboctahedron: "tco",
  snub_cube: "snc",
  icosidodecahedron: "ido",
  truncated_dodecahedron: "tdo",
  truncated_icosahedron: "tic",
  rhombicosidodecahedron: "rid",
  truncated_icosidodecahedron: "tid",
  snub_dodecahedron: "snd",
  triakis_tetrahedron: "ktt",
  rhombic_dodecahedron: "rdo",
  triakis_octahedron: "kto",
  tetrakis_hexahedron: "kth",
  deltoidal_icositetrahedron: "dit",
  disdyakis_dodecahedron: "ddo",
  pentagonal_icositetrahedron: "pit",
  rhombic_triacontahedron: "rtc",
  triakis_icosahedron: "kti",
  pentakis_dodecahedron: "pkd",
  deltoidal_hexecontahedron: "dhc",
  disdyakis_triacontahedron: "dtc",
  pentagonal_hexecontahedron: "phc",
};
const POLY: Record<number, string> = {
  3: "triangular",
  4: "square",
  5: "pentagonal",
  6: "hexagonal",
  7: "heptagonal",
  8: "octagonal",
  9: "enneagonal",
  10: "decagonal",
  11: "hendecagonal",
  12: "dodecagonal",
};
const PRISM_K = [3, 5, 6, 8, 12];
const ANTIPRISM_K = [4, 5, 6, 8, 12];
// PolyPack's: the duals of the n-prisms (n = 4 is the octahedron) and of the n-antiprisms (n = 3 is the cube)
const BIPYRAMID_K = [3, 5, 6, 7, 8, 9, 10, 11, 12];
const TRAPEZOHEDRON_K = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const ELONG: [string, string][] = [
  ["l15", "1.5"],
  ["l2", "2"],
  ["l3", "3"],
];

function buildSolids(): SolidName[] {
  const out: SolidName[] = [];
  for (const s of PLATONIC_SOLIDS) out.push({ name: s, code: CODES[s], family: "platonic", title: s });
  for (const s of ARCHIMEDEAN_SOLIDS)
    out.push({ name: s, code: CODES[s], family: "archimedean", title: s.replace(/_/g, " ") });
  for (const s of CATALAN_SOLIDS) out.push({ name: s, code: CODES[s], family: "catalan", title: s.replace(/_/g, " ") });
  for (const k of PRISM_K) out.push({ name: `prism${k}`, code: `pr${k}`, family: "prism", title: `${POLY[k]} prism` });
  for (const k of ANTIPRISM_K)
    out.push({ name: `antiprism${k}`, code: `ap${k}`, family: "antiprism", title: `${POLY[k]} antiprism` });
  for (const k of PRISM_K)
    for (const [tag, h] of ELONG)
      out.push({
        name: `prism${k}_${tag}`,
        code: `pr${k}${tag}`,
        family: "elongated_prism",
        title: `${POLY[k]} prism of height ${h}`,
      });
  for (const k of BIPYRAMID_K)
    out.push({ name: `bipyramid${k}`, code: `bp${k}`, family: "bipyramid", title: `${POLY[k]} bipyramid` });
  for (const k of TRAPEZOHEDRON_K)
    out.push({ name: `trapezohedron${k}`, code: `tz${k}`, family: "trapezohedron", title: `${POLY[k]} trapezohedron` });
  return out;
}

/** Every solid's name, code and title: upstream's in upstream's order, then PolyPack's bipyramids and trapezohedra. */
export const SOLID_NAMES_LIST: readonly SolidName[] = buildSolids();
const SOLID_BY_NAME = new Map(SOLID_NAMES_LIST.map((s) => [s.name, s]));

/** "Cubes" for a cube, "tetrahedra", "triangular prisms of height 1.5". */
export function pluralTitle(title: string): string {
  if (/ prism of height/.test(title)) return title.replace(" prism of", " prisms of");
  if (title.endsWith("hedron")) return `${title.slice(0, -2)}a`;
  return `${title}s`;
}

const article = (title: string) => (/^[aeiou]/.test(title) ? `an ${title}` : `a ${title}`);

export interface ProblemName {
  /** Upstream's code `<piece code>in<container code>`, e.g. "cubintet". */
  code: string;
  piece: string;
  container: string;
  family: ProblemFamily;
  /** e.g. "Cubes in a tetrahedron". */
  title: string;
  /** True for the 86 problems of polyhedrainpolyhedra.wiki, false for PolyPack's own. */
  wiki: boolean;
}

function problemName(piece: string, container: string, family: ProblemFamily, wiki = true): ProblemName {
  const P = SOLID_BY_NAME.get(piece)!;
  const C = SOLID_BY_NAME.get(container)!;
  const what = pluralTitle(P.title);
  return {
    code: `${P.code}in${C.code}`,
    piece,
    container,
    family,
    title: `${what.charAt(0).toUpperCase()}${what.slice(1)} in ${article(C.title)}`,
    wiki,
  };
}

function buildProblems(): ProblemName[] {
  // upstream's order: the self-packings and the cube/octahedron and dodecahedron/icosahedron duals
  // first, then the other Platonic pairs piece by piece, then the families
  const pairs: [string, string][] = [
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
  for (const p of PLATONIC_SOLIDS)
    for (const c of PLATONIC_SOLIDS) if (!pairs.some(([a, b]) => a === p && b === c)) pairs.push([p, c]);
  const out = pairs.map(([p, c]) => problemName(p, c, "platonic"));
  for (const s of ARCHIMEDEAN_SOLIDS) out.push(problemName(s, s, "archimedean"));
  for (const s of CATALAN_SOLIDS) out.push(problemName(s, s, "catalan"));
  const prisms = PRISM_K.map((k) => `prism${k}`).concat(ANTIPRISM_K.map((k) => `antiprism${k}`));
  for (const s of prisms) for (const c of [s, "cube"]) out.push(problemName(s, c, "prisms"));
  for (const k of PRISM_K) for (const [tag] of ELONG) out.push(problemName(`prism${k}_${tag}`, "cube", "prisms"));
  // PolyPack's problems, after upstream's
  for (const k of BIPYRAMID_K)
    for (const c of [`bipyramid${k}`, "cube"]) out.push(problemName(`bipyramid${k}`, c, "bipyramids", false));
  for (const k of TRAPEZOHEDRON_K)
    for (const c of [`trapezohedron${k}`, "cube"]) out.push(problemName(`trapezohedron${k}`, c, "trapezohedra", false));
  return out;
}

/** The 122 problems: the wiki's 86 in upstream's order, then PolyPack's 36 (`wiki` false). */
export const PROBLEM_NAMES: readonly ProblemName[] = buildProblems();
const PROBLEM_BY_CODE = new Map(PROBLEM_NAMES.map((p) => [p.code, p]));

/** The problem of a code, or null. */
export function problemNameOf(code: string): ProblemName | null {
  return PROBLEM_BY_CODE.get(code) ?? null;
}

/** The problem's title ("Cubes in a tetrahedron"), or the code itself when it is not a problem. */
export function problemTitle(code: string): string {
  return PROBLEM_BY_CODE.get(code)?.title ?? code;
}

/** The problem codes in the order of PROBLEM_NAMES. */
export const PROBLEM_CODES: readonly string[] = PROBLEM_NAMES.map((p) => p.code);
