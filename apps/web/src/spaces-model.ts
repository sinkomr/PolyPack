import { PROBLEM_CODES, problemTitle } from "@polypack/polyhedra/catalogue";
import type { CertifiedStatus, SpaceName, SpaceProblemSummary } from "@polypack/spaces";

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

const STATUS: Record<CertifiedStatus, string> = {
  best_known: "best known",
  proven: "proven optimal",
  infeasible: "no packing exists",
};
export const statusLabel = (s: CertifiedStatus | null): string => (s ? STATUS[s] : "—");

/**
 * How a kind's research records are proven valid: the 2D kinds' certifiers use interval
 * arithmetic, the 3D on 4D certifier exact rational arithmetic (docs/spaces/BOUNDARY.md 4).
 */
export const certifiedBy = (space: SpaceName): string =>
  space === "boundary" ? "exact rational arithmetic" : "interval arithmetic";

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
export type ListedProblem = SpaceProblemSummary & { status?: CertifiedStatus; closed_reason?: string | null };

/**
 * The status of a problem: the one the server gives; else the research value's; else, for a
 * problem without a value that takes no entries, infeasible (proven problems carry their value).
 */
export function problemStatus(
  p: Pick<ListedProblem, "status" | "certified" | "accepts_submissions">,
): CertifiedStatus | null {
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

const SOLIDS = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"] as const;
const TORI: Record<string, string> = { sq: "square", hex: "hexagonal", free: "free lattice" };

export const SPACE_FIELDS: Record<SpaceName, FieldSpec[]> = {
  // surface/<solid>/<mode>/<N>/<P>
  surface: [
    { key: "solid", at: 1, label: "Solid", option: capital, cell: (v) => v, order: SOLIDS, start: "cube" },
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
  // polyhedrainpolyhedra.wiki
  polyhedra: [
    {
      key: "code",
      at: 1,
      label: "Problem",
      option: problemTitle,
      cell: problemTitle,
      order: PROBLEM_CODES,
      start: "cubincub",
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

/** The line above a table: how many problems, of which status, and how many have site entries. */
export function summaryText(rows: readonly ListedProblem[]): string {
  if (!rows.length) return "No problems match these filters.";
  const by = new Map<CertifiedStatus | null, number>();
  for (const p of rows) by.set(problemStatus(p), (by.get(problemStatus(p)) ?? 0) + 1);
  const statuses = [...by.entries()]
    .map(([s, n]) =>
      s === "infeasible" ? `${n} where no packing exists` : s ? `${n} ${STATUS[s]}` : `${n} without a value`,
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
