/**
 * The names of the polyhedra space without its geometry: the solids' names, codes and titles and the 86 problems
 * of polyhedrainpolyhedra.wiki (upstream's scripts/engine.py: AB, ARCHIMEDEAN, CATALAN, PRISMS, PROBLEMS; MIT, see
 * THIRD_PARTY_NOTICES.md), then PolyPack's 64 in the same scheme (2026-10-25; not on the wiki): the prisms and
 * antiprisms with 7, 9, 10 and 11 sides in themselves and in a cube, and their prisms of height 1.5, 2 and 3 in a
 * cube; and the bipyramids and trapezohedra (the canonical duals of the unit-edge prisms and antiprisms,
 * docs/spaces/POLYHEDRA.md) in themselves and in a cube. No imports, so that a page can name problems without loading the solids' coordinates; problems.ts builds the
 * same list with the solids attached.
 *
 * Beyond those 150, every ordered pair (piece, container) of the 94 solids is a problem family too (8,836 in all,
 * P = 2 to 500, no research records): problemNameOf reads the code `<piece code>in<container code>` of any pair,
 * with the family "pairs" for the 8,686 that are not among the 150.
 */

export type SolidFamily =
  "platonic" | "archimedean" | "catalan" | "prism" | "antiprism" | "elongated_prism" | "bipyramid" | "trapezohedron";
export type ProblemFamily = "platonic" | "archimedean" | "catalan" | "prisms" | "bipyramids" | "trapezohedra" | "pairs";

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
/** PolyPack's prisms, antiprisms and elongated prisms (not on the wiki). */
const EXTRA_K = [7, 9, 10, 11];
/** PolyPack's duals of the n-prisms (n = 4 is the octahedron) and of the n-antiprisms (n = 3 is the cube). */
const BIPYRAMID_K = [3, 5, 6, 7, 8, 9, 10, 11, 12];
const TRAPEZOHEDRON_K = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const ELONG: [string, string][] = [
  ["l15", "1.5"],
  ["l2", "2"],
  ["l3", "3"],
];

function prismSolids(prisms: number[], antiprisms: number[]): SolidName[] {
  const out: SolidName[] = [];
  for (const k of prisms) out.push({ name: `prism${k}`, code: `pr${k}`, family: "prism", title: `${POLY[k]} prism` });
  for (const k of antiprisms)
    out.push({ name: `antiprism${k}`, code: `ap${k}`, family: "antiprism", title: `${POLY[k]} antiprism` });
  for (const k of prisms)
    for (const [tag, h] of ELONG)
      out.push({
        name: `prism${k}_${tag}`,
        code: `pr${k}${tag}`,
        family: "elongated_prism",
        title: `${POLY[k]} prism of height ${h}`,
      });
  return out;
}

function buildSolids(): SolidName[] {
  const out: SolidName[] = [];
  for (const s of PLATONIC_SOLIDS) out.push({ name: s, code: CODES[s], family: "platonic", title: s });
  for (const s of ARCHIMEDEAN_SOLIDS)
    out.push({ name: s, code: CODES[s], family: "archimedean", title: s.replace(/_/g, " ") });
  for (const s of CATALAN_SOLIDS) out.push({ name: s, code: CODES[s], family: "catalan", title: s.replace(/_/g, " ") });
  out.push(...prismSolids(PRISM_K, ANTIPRISM_K), ...prismSolids(EXTRA_K, EXTRA_K));
  for (const k of BIPYRAMID_K)
    out.push({ name: `bipyramid${k}`, code: `bp${k}`, family: "bipyramid", title: `${POLY[k]} bipyramid` });
  for (const k of TRAPEZOHEDRON_K)
    out.push({ name: `trapezohedron${k}`, code: `tz${k}`, family: "trapezohedron", title: `${POLY[k]} trapezohedron` });
  return out;
}

/** Every solid's name, code and title: upstream's 56 in upstream's order, then PolyPack's 38. */
export const SOLID_NAMES_LIST: readonly SolidName[] = buildSolids();
const SOLID_BY_NAME = new Map(SOLID_NAMES_LIST.map((s) => [s.name, s]));
const SOLID_BY_CODE = new Map(SOLID_NAMES_LIST.map((s) => [s.code, s]));

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
  /** True for the 86 problems that polyhedrainpolyhedra.wiki lists (problems.ts' wikiUrl gives their pages). */
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

function prismProblems(prisms: number[], antiprisms: number[], wiki: boolean): ProblemName[] {
  const out: ProblemName[] = [];
  const solids = prisms.map((k) => `prism${k}`).concat(antiprisms.map((k) => `antiprism${k}`));
  for (const s of solids) for (const c of [s, "cube"]) out.push(problemName(s, c, "prisms", wiki));
  for (const k of prisms) for (const [tag] of ELONG) out.push(problemName(`prism${k}_${tag}`, "cube", "prisms", wiki));
  return out;
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
  out.push(...prismProblems(PRISM_K, ANTIPRISM_K, true), ...prismProblems(EXTRA_K, EXTRA_K, false));
  for (const k of BIPYRAMID_K)
    for (const c of [`bipyramid${k}`, "cube"]) out.push(problemName(`bipyramid${k}`, c, "bipyramids", false));
  for (const k of TRAPEZOHEDRON_K)
    for (const c of [`trapezohedron${k}`, "cube"]) out.push(problemName(`trapezohedron${k}`, c, "trapezohedra", false));
  return out;
}

/** The 150 problems of the records: upstream's 86 in upstream's order, then PolyPack's 64 (wiki: false). */
export const PROBLEM_NAMES: readonly ProblemName[] = buildProblems();
const PROBLEM_BY_CODE = new Map(PROBLEM_NAMES.map((p) => [p.code, p]));

/** Problems of the other pairs, named when first asked for (at most one per ordered pair of solids). */
const PAIR_CACHE = new Map<string, ProblemName | null>();

/**
 * The pair of solids a code names: the splits of the code at an "in" with a solid code on each side. [CALC] No code
 * of two solids has a second reading (catalogue test).
 */
function pairOfCode(code: string): [SolidName, SolidName] | null {
  for (let i = code.indexOf("in", 1); i !== -1; i = code.indexOf("in", i + 1)) {
    const piece = SOLID_BY_CODE.get(code.slice(0, i));
    const container = SOLID_BY_CODE.get(code.slice(i + 2));
    if (piece && container) return [piece, container];
  }
  return null;
}

/** The problem of a code (one of the 150 or any other pair of solids), or null. */
export function problemNameOf(code: string): ProblemName | null {
  const known = PROBLEM_BY_CODE.get(code);
  if (known) return known;
  if (code.length > 24) return null;
  let p = PAIR_CACHE.get(code);
  if (p === undefined) {
    const pair = pairOfCode(code);
    p = pair ? problemName(pair[0].name, pair[1].name, "pairs", false) : null;
    PAIR_CACHE.set(code, p);
  }
  return p;
}

/** The code of the problem of two solids, given by name ("cube", "tetrahedron" -> "cubintet"), or null. */
export function pairCode(piece: string, container: string): string | null {
  const p = SOLID_BY_NAME.get(piece);
  const c = SOLID_BY_NAME.get(container);
  return p && c ? `${p.code}in${c.code}` : null;
}

/** The number of problem families: every ordered pair of solids (the 150 of PROBLEM_NAMES among them). */
export const PAIR_COUNT = SOLID_NAMES_LIST.length * SOLID_NAMES_LIST.length;

/** Title of a solid's group in a menu, and the order of the groups. */
export const SOLID_GROUPS: Record<SolidFamily, string> = {
  platonic: "Platonic solids",
  archimedean: "Archimedean solids",
  catalan: "Catalan solids",
  prism: "Prisms",
  antiprism: "Antiprisms",
  elongated_prism: "Prisms of height 1.5, 2 and 3",
  bipyramid: "Bipyramids",
  trapezohedron: "Trapezohedra",
};

/** Rank of a solid in a menu: by group, then (prisms, antiprisms, elongated prisms) by sides and height. */
function solidRank(s: SolidName): [number, number, number, number] {
  const group = Object.keys(SOLID_GROUPS).indexOf(s.family);
  const m = /^(?:pr|ap|bp|tz)(\d+)(l15|l2|l3)?$/.exec(s.code);
  const place = SOLID_NAMES_LIST.indexOf(s);
  return m ? [group, Number(m[1]), ["", "l15", "l2", "l3"].indexOf(m[2] ?? ""), place] : [group, 0, 0, place];
}

/** The solids in the order of a menu of pieces or containers: grouped by family, prisms by their number of sides. */
export const SOLIDS_BY_GROUP: readonly SolidName[] = [...SOLID_NAMES_LIST].sort((a, b) => {
  const x = solidRank(a);
  const y = solidRank(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3];
});

/** The problem's title ("Cubes in a tetrahedron"), or the code itself when it is not a problem. */
export function problemTitle(code: string): string {
  return problemNameOf(code)?.title ?? code;
}

/** The problem codes in that order. */
export const PROBLEM_CODES: readonly string[] = PROBLEM_NAMES.map((p) => p.code);

/** Rank of a prism-family problem: prisms (in themselves, in a cube), antiprisms, then elongated prisms, by sides. */
function prismRank(p: ProblemName): [number, number, number] | null {
  const m = /^(pr|ap)(\d+)(l15|l2|l3)?in/.exec(p.code);
  if (p.family !== "prisms" || !m) return null;
  const n = Number(m[2]);
  if (m[3]) return [2, n, ["l15", "l2", "l3"].indexOf(m[3])];
  return [m[1] === "pr" ? 0 : 1, n, p.container === "cube" ? 1 : 0];
}

/**
 * The problem codes in the order of a listing or a picker: the wiki's order, with PolyPack's prisms and antiprisms
 * among the wiki's by their number of sides (heptagonal prisms after the hexagonal ones, and so on), then the
 * bipyramids and trapezohedra. The wiki's own problems keep their order.
 */
export const PROBLEM_ORDER: readonly string[] = (() => {
  const prisms = PROBLEM_NAMES.filter((p) => prismRank(p) !== null);
  prisms.sort((a, b) => {
    const x = prismRank(a)!;
    const y = prismRank(b)!;
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const duals = (p: ProblemName) => p.family === "bipyramids" || p.family === "trapezohedra";
  return [
    ...PROBLEM_NAMES.filter((p) => prismRank(p) === null && !duals(p)).map((p) => p.code),
    ...prisms.map((p) => p.code),
    ...PROBLEM_NAMES.filter(duals).map((p) => p.code),
  ];
})();
