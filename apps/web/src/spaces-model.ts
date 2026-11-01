import { BALLS_CODES, ballsTitle } from "@polypack/balls/catalogue";
import { ND_SHAPE_NAMES } from "@polypack/ndspace/catalogue";
import { JOHNSON_SOLIDS, PROBLEM_ORDER, problemTitle } from "@polypack/polyhedra/catalogue";
import {
  SURFACE_ARCHIMEDEAN,
  SURFACE_CATALAN,
  SURFACE_JOHNSON,
  SURFACE_SOLIDS,
  type SpaceInfo,
  type SpaceName,
  type SpaceProblemStatus,
  type SpaceProblemSummary,
} from "@polypack/spaces";

/**
 * The pure parts of the dimensions page's records table: the filters of each space's table (the
 * API calls a dimension's families spaces), how values are rounded and named, and the page state
 * kept in the address. No DOM in here.
 */

// ---------- names ----------

const PIECES: Record<string, string> = {
  "0": "disk",
  "3": "triangle",
  "4": "square",
  "5": "pentagon",
  "6": "hexagon",
  "7": "heptagon",
  "8": "octagon",
};

/** "disk" for 0, "square" for 4, "12-gon" for a shape without a name. */
export function pieceName(N: string | number): string {
  return PIECES[String(N)] ?? `${N}-gon`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (s: string) => `${s}s`;
/** A minus sign rather than a hyphen in front of a negative number. */
export const minus = (s: string) => s.replace(/^-/, "−");

/**
 * A curvature for reading: integers as they are, |K| below 0.001 in powers of ten (1e-6 is
 * "10⁻⁶"), others to 7 significant digits. The exact value stays in the problem id.
 */
export function formatK(K: string | number): string {
  const k = Number(K);
  if (!Number.isFinite(k)) return String(K);
  if (Number.isInteger(k)) return minus(String(k));
  if (Math.abs(k) < 1e-3) {
    const [mant, exp] = k.toExponential().split("e");
    const sup = exp.replace(/^\+/, "").replace(/[-0-9]/g, (c) => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(c)]);
    return `${mant === "1" ? "" : mant === "-1" ? "−" : `${minus(mant)} × `}10${sup}`;
  }
  return minus(String(Number(k.toPrecision(7))));
}

const STATUS: Record<SpaceProblemStatus, string> = {
  best_known: "best known",
  proven: "proven optimal",
  infeasible: "no packing exists",
  no_record: "no record yet",
};
export const statusLabel = (s: SpaceProblemStatus | null): string => (s ? STATUS[s] : "—");

/**
 * How a kind's research records are proven valid: the 2D kinds' certifiers use interval
 * arithmetic, the 3D on 4D certifier exact rational arithmetic (docs/spaces/BOUNDARY.md 4), and the balls
 * certifier both: exact rationals for balls, intervals for the Platonic solids (docs/spaces/BALLS.md 4).
 */
export const certifiedBy = (space: SpaceName): string =>
  space === "boundary"
    ? "exact rational arithmetic"
    : space === "balls"
      ? "exact rational arithmetic (balls) or interval arithmetic (solids)"
      : "interval arithmetic";

/**
 * A lower bound's label as the page shows it: the research tags that say what kind of claim it is
 * ([CALC], [EST], "CALC from EST theorem:") stay in the API and the notes, and the page keeps what
 * the bound rests on ("area bound; [CALC]" reads "area bound").
 */
export function plainBoundLabel(label: string): string {
  return label
    .replace(/\[(?:CALC|EST|SPEC)\]/g, "")
    .replace(/^\s*(?:CALC|EST)(?: from (?:CALC|EST) theorem)?:\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(/^\s*;\s*/, "")
    .trim();
}

/**
 * A listed problem with two fields the server sends beside the contract's summary: the problem's
 * status (the only status of an infeasible problem, whose certified value is null) and why a
 * closed problem takes no entries.
 */
export type ListedProblem = SpaceProblemSummary & { status?: SpaceProblemStatus; closed_reason?: string | null };

/**
 * The status of a problem: the one the server gives; else the research value's; else, for a
 * problem without a value that takes no entries, infeasible (proven problems carry their value).
 */
export function problemStatus(
  p: Pick<ListedProblem, "status" | "certified" | "accepts_submissions">,
): SpaceProblemStatus | null {
  if (p.status) return p.status;
  if (p.certified) return p.certified.status;
  return p.accepts_submissions ? null : "infeasible";
}

/** The Entries column: open or closed, and why a closed problem takes none when the server says. */
export function entriesText(p: Pick<ListedProblem, "accepts_submissions" | "closed_reason">): {
  text: string;
  why: string | null;
} {
  if (p.accepts_submissions) return { text: "open", why: null };
  const why = p.closed_reason?.trim();
  // the server words the reason to follow "closed: ", so it may start in lower case
  return { text: "closed", why: why ? why.charAt(0).toUpperCase() + why.slice(1) : null };
}

// ---------- rounding ----------

/**
 * Six decimals, rounded to the nearest, as the rest of the site shows scores and bounds. The full
 * values (score_cert, the site score, the bound) are in the API; an exact 2 shows as 2.000000.
 */
export function round6(v: number): string {
  return v.toFixed(6);
}

// ---------- filters ----------

/** One filter of a space's table: a field of the problem id. */
export interface FieldSpec {
  key: string;
  /** Position of the field in the id "<space>/a/b/c/P". */
  at: number;
  /** Label of the filter and header of its column. */
  label: string;
  /** Option text in the filter. */
  option(value: string): string;
  /** Text in the field's column. */
  cell(value: string): string;
  /** Order of the values; numeric order where absent. */
  order?: readonly string[];
  /** The group of a value in the filter (an option group), where the values come in groups. */
  group?(value: string): string;
  /** The value the table starts with ("all" for every value). */
  start: string;
}

const pieceField = (start: string, at: number): FieldSpec => ({
  key: "N",
  at,
  label: "Pieces",
  option: (v) => `${capital(plural(pieceName(v)))} (N = ${v})`,
  cell: (v) => pieceName(v),
  start,
});

/** Polygon names of the prisms' and antiprisms' bases. */
const BASES: Record<string, string> = {
  "3": "triangular",
  "4": "square",
  "5": "pentagonal",
  "6": "hexagonal",
  "7": "heptagonal",
  "8": "octagonal",
  "9": "enneagonal",
  "10": "decagonal",
  "11": "hendecagonal",
  "12": "dodecagonal",
};

/** The Johnson solids by name: the surface space and the polyhedra space name them alike (J1 square pyramid). */
const JOHNSON_TITLE = new Map(JOHNSON_SOLIDS.map((s) => [s.name, s.title]));

/** A surface solid in words: "cube", "rhombic dodecahedron", "pentagonal prism", "square antiprism", "J1 square pyramid". */
export function solidTitle(name: string): string {
  const j = JOHNSON_TITLE.get(name);
  if (j) return j;
  const m = /^(anti)?prism(\d+)$/.exec(name);
  if (m) return `${BASES[m[2]] ?? `${m[2]}-gonal`} ${m[1] ? "antiprism" : "prism"}`;
  return name.replace(/_/g, " ");
}

/** The family of a surface solid, for grouping the solids in a filter. */
export function solidGroup(name: string): string {
  const i = (SURFACE_SOLIDS as readonly string[]).indexOf(name);
  if (i >= 0 && i < 5) return "Platonic solids";
  if (SURFACE_ARCHIMEDEAN.includes(name)) return "Archimedean solids";
  if (SURFACE_CATALAN.includes(name)) return "Catalan solids";
  if (SURFACE_JOHNSON.includes(name)) return "Johnson solids";
  if (name.startsWith("prism")) return "Prisms";
  if (name.startsWith("antiprism")) return "Antiprisms";
  return "Catalan solids";
}

const TORI: Record<string, string> = { sq: "square", hex: "hexagonal", free: "free lattice" };

export const SPACE_FIELDS: Record<SpaceName, FieldSpec[]> = {
  // surface/<solid>/<mode>/<N>/<P>
  surface: [
    {
      key: "solid",
      at: 1,
      label: "Solid",
      option: (v) => capital(solidTitle(v)),
      cell: solidTitle,
      order: SURFACE_SOLIDS,
      group: solidGroup,
      start: "cube",
    },
    {
      key: "mode",
      at: 2,
      label: "Folding",
      option: (v) => (v === "fold" ? "Fold over edges" : v === "nofold" ? "No fold" : v),
      cell: (v) => (v === "nofold" ? "no fold" : v),
      order: ["fold", "nofold"],
      start: "fold",
    },
    pieceField("4", 3),
  ],
  // curved/<K>/<N>/<M>/<P>
  curved: [
    { key: "K", at: 1, label: "Curvature", option: (v) => `K = ${formatK(v)}`, cell: formatK, start: "-1" },
    pieceField("0", 2),
    {
      key: "M",
      at: 3,
      label: "Container",
      option: (v) => `${capital(pieceName(v))} (M = ${v})`,
      cell: (v) => pieceName(v),
      start: "all",
    },
  ],
  // sphere/<N>/<P>
  sphere: [pieceField("0", 1)],
  // torus/<family>/<N>/<P>
  torus: [
    {
      key: "family",
      at: 1,
      label: "Torus",
      option: (v) => `${capital(TORI[v] ?? v)} (${v})`,
      cell: (v) => TORI[v] ?? v,
      order: ["sq", "hex", "free"],
      start: "sq",
    },
    pieceField("0", 2),
  ],
  // boundary/<polytope>/<piece>/<P>
  boundary: [
    {
      key: "polytope",
      at: 1,
      label: "Polytope",
      option: capital,
      cell: (v) => v,
      order: ["tesseract"],
      start: "tesseract",
    },
    {
      key: "piece",
      at: 2,
      label: "Piece",
      option: (v) => capital(plural(v)),
      cell: (v) => v,
      order: ["ball", "cube"],
      start: "ball",
    },
  ],
  // polyhedra/<code>/<P>: one problem per pair of piece and container solid, in the order of
  // polyhedrainpolyhedra.wiki, PolyPack's prisms and antiprisms among the wiki's by their number of sides
  polyhedra: [
    {
      key: "code",
      at: 1,
      label: "Problem",
      option: problemTitle,
      cell: problemTitle,
      order: PROBLEM_ORDER,
      start: "cubincub",
    },
  ],
  // balls/<code>/<P>: balls in a ball and in each of the 186 solids, then each solid in a ball
  balls: [
    {
      key: "code",
      at: 1,
      label: "Problem",
      option: ballsTitle,
      cell: ballsTitle,
      order: BALLS_CODES,
      start: "ballinball",
    },
  ],
  // ndim/<d>/<piece>/<container>/<P>: the nD spaces are listed by the generic table until the nD plan's phase E gives them a board
  ndim: [
    {
      key: "d",
      at: 1,
      label: "Dimension",
      option: (v) => `${v}D`,
      cell: (v) => `${v}D`,
      order: ["4", "5", "6", "7", "8", "9", "10"],
      start: "4",
    },
    { key: "piece", at: 2, label: "Piece", option: (v) => v, cell: (v) => v, order: ND_SHAPE_NAMES, start: "all" },
    {
      key: "container",
      at: 3,
      label: "Container",
      option: (v) => v,
      cell: (v) => v,
      order: ND_SHAPE_NAMES,
      start: "all",
    },
  ],
};

/** Every value of a filter. */
export const ALL = "all";

export type Filters = Record<string, string>;

/** A field of a problem, read from its id (the contract fixes the id format of each space). */
export function fieldOf(p: Pick<SpaceProblemSummary, "id">, f: FieldSpec): string {
  return p.id.split("/")[f.at] ?? "";
}

function compareValues(f: FieldSpec, a: string, b: string): number {
  if (f.order) {
    const rank = (v: string) => {
      const i = f.order!.indexOf(v);
      return i < 0 ? f.order!.length : i;
    };
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
  }
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The values of a field that occur among the problems, in the field's order. */
export function fieldValues(problems: readonly Pick<SpaceProblemSummary, "id">[], f: FieldSpec): string[] {
  return [...new Set(problems.map((p) => fieldOf(p, f)))].sort((a, b) => compareValues(f, a, b));
}

/**
 * The filters a table shows: the wished value of each field where the problems have it, else the
 * field's starting value where they have that, else every value.
 */
export function settleFilters(
  space: SpaceName,
  problems: readonly SpaceProblemSummary[],
  wished: Filters = {},
): Filters {
  const out: Filters = {};
  for (const f of SPACE_FIELDS[space]) {
    const values = fieldValues(problems, f);
    const ok = (v: string | undefined): v is string => v !== undefined && (v === ALL || values.includes(v));
    out[f.key] = ok(wished[f.key]) ? wished[f.key] : ok(f.start) ? f.start : ALL;
  }
  return out;
}

/** The problems that pass the filters, sorted by the id's fields and then by P. */
export function filterProblems(
  space: SpaceName,
  problems: readonly SpaceProblemSummary[],
  filters: Filters,
): SpaceProblemSummary[] {
  const fields = SPACE_FIELDS[space];
  return problems
    .filter((p) => fields.every((f) => (filters[f.key] ?? ALL) === ALL || fieldOf(p, f) === filters[f.key]))
    .sort((a, b) => {
      for (const f of fields) {
        const c = compareValues(f, fieldOf(a, f), fieldOf(b, f));
        if (c) return c;
      }
      return a.P - b.P;
    });
}

/** The fields that get a column: those a filter does not fix to one value. */
export const shownFields = (space: SpaceName, filters: Filters): FieldSpec[] =>
  SPACE_FIELDS[space].filter((f) => (filters[f.key] ?? ALL) === ALL);

// ---------- rows ----------

/** True when the site's best entry is below the certified value. */
export const siteBelowCertified = (p: SpaceProblemSummary): boolean =>
  !!p.site_best && !!p.certified && p.site_best.score < p.certified.score;

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "693, none with a record yet" or "8,514": the problems, and how many have no research record yet. */
export function problemsText(s: Pick<SpaceInfo, "problems"> & { records?: number }): string {
  const n = s.problems.toLocaleString("en-US");
  if (typeof s.records !== "number" || s.records >= s.problems) return n;
  const without = s.problems - s.records;
  return s.records === 0
    ? `${n}, none with a record yet`
    : `${n}, ${without.toLocaleString("en-US")} without a record yet`;
}

/**
 * The line above the records table of a kind whose problems are given by a domain and that has no records yet:
 * how many problems there are, and where to work on them.
 */
export function domainNote(s: Pick<SpaceInfo, "problems"> & { records?: number }): string {
  return `No records yet. All ${s.problems.toLocaleString("en-US")} problems of this kind are open: choose one on the board, or let the volunteer client search them.`;
}

/** The line above a table: how many problems, of which status, and how many have site entries. */
export function summaryText(rows: readonly ListedProblem[]): string {
  if (!rows.length) return "No problems match these filters.";
  const by = new Map<SpaceProblemStatus | null, number>();
  for (const p of rows) by.set(problemStatus(p), (by.get(problemStatus(p)) ?? 0) + 1);
  const statuses = [...by.entries()]
    .map(([s, n]) =>
      s === "infeasible"
        ? `${n} where no packing exists`
        : s === "no_record"
          ? `${n} without a record yet`
          : s
            ? `${n} ${STATUS[s]}`
            : `${n} without a value`,
    )
    .join(", ");
  const site = rows.filter((p) => p.site_best).length;
  const below = rows.filter(siteBelowCertified).length;
  const entries = site
    ? `${count(site, "has a site entry", "have site entries")}${below ? `, ${below} below the certified value` : ""}.`
    : "No site entries yet.";
  return `${count(rows.length, "problem", "problems")}: ${statuses}. ${entries}`;
}

/** GET address of one problem with its configurations; the id keeps its slashes. */
export const configUrl = (space: SpaceName, id: string): string =>
  `/api/spaces/${space}/problems/${id.split("/").map(encodeURIComponent).join("/")}`;

/** File name for a downloaded configuration: "torus_hex_0_7.json". */
export const downloadName = (id: string): string => `${id.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;

/** A sentence from the server, ended with a full stop when it has none. */
export const sentence = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** "2026-10-24" from a timestamp, or the text itself when it is not one. */
export const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

// ---------- surface nofold problems are 2D in 2D problems ----------

export { SOLID_FACES, nofoldFaceProblem, nofoldNote, faceProblemText, faceProblemName } from "@polypack/surface/nofold";
export type { FaceProblem } from "@polypack/surface/nofold";

// ---------- address ----------

export interface PageState {
  space: SpaceName;
  filters: Filters;
}

/**
 * The state is in the hash, "#space=torus&family=hex&N=0". A hash naming a space the page does
 * not list falls back to the first one; filters are settled against the data when it arrives.
 */
export function parseHash(hash: string, spaces: readonly SpaceName[]): PageState | null {
  if (!spaces.length) return null;
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const wanted = q.get("space");
  const space = spaces.find((s) => s === wanted) ?? spaces[0];
  const filters: Filters = {};
  for (const f of SPACE_FIELDS[space]) {
    const v = q.get(f.key);
    if (v !== null) filters[f.key] = v;
  }
  return { space, filters };
}

export function stateHash(state: PageState): string {
  const q = new URLSearchParams({ space: state.space });
  for (const f of SPACE_FIELDS[state.space]) if (state.filters[f.key] !== undefined) q.set(f.key, state.filters[f.key]);
  return `#${q.toString()}`;
}
