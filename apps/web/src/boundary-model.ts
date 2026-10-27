/**
 * The pure parts of the 3D on 4D pages (the board's boundary drawing, the viewer at
 * /spaces/boundary.html and the dimensions page): the nofold comparison every boundary record
 * carries, the words for the pieces, a configuration read from the server (untrusted input) and
 * the viewer's address. No DOM and no three.js in here, so that it is tested in Node.
 *
 * The space and its numbers are defined in docs/spaces/BOUNDARY.md: P balls of diameter 1 or
 * unit cubes (edge 1) on the boundary of a tesseract of edge s; the score is s. "nofold" is the
 * best s when every piece must stay inside one cell (section 6).
 */
import type { BoundaryConfig, BoundaryPiece, Quaternion } from "@polypack/boundary";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;

// ---------- the pieces ----------

const PIECE_WORDS: Record<string, [string, string]> = {
  ball: ["ball", "balls"],
  cube: ["cube", "cubes"],
};

/** The piece's name, singular and plural: ["ball", "balls"]. */
export function pieceNames(piece: string): [string, string] {
  return PIECE_WORDS[piece] ?? [piece, `${piece}s`];
}

/** "9 balls", "1 cube". */
export function piecesText(piece: string, P: number): string {
  const [one, many] = pieceNames(piece);
  return `${P.toLocaleString("en-US")} ${P === 1 ? one : many}`;
}

// ---------- the nofold comparison ----------

/** What a boundary problem's listing carries besides its score and bound (SpaceProblemExtra). */
export interface FoldExtra {
  /** The best edge with every piece inside one cell, and what it rests on. */
  nofold: { value: number; label: string } | null;
  /** The research record's gain over nofold, from the server (1 - score_float / nofold). */
  fold_gain: number | null;
}

/**
 * The `extra` of a problem as the server sends it, checked (it is untrusted input), or null when
 * there is none. A malformed part is left out; the rest is kept.
 */
export function readFoldExtra(v: unknown): FoldExtra | null {
  if (!isObject(v)) return null;
  const n = v.nofold;
  const nofold =
    isObject(n) && positive(n.value)
      ? { value: n.value, label: typeof n.label === "string" ? n.label.slice(0, 600) : "" }
      : null;
  const fold_gain = finite(v.fold_gain) && v.fold_gain > -1 && v.fold_gain < 1 ? v.fold_gain : null;
  return nofold || fold_gain !== null ? { nofold, fold_gain } : null;
}

/**
 * How much shorter the best edge is than the nofold edge: 1 - best / nofold (0.25 for 25%), or
 * null when either is missing. The pages show the gain of the problem's best packing, so that it
 * follows a site entry that beats the research record; for the record itself it is the server's
 * fold_gain (which uses the search value before certification, about 1e-12 smaller).
 */
export function foldGain(best: number | null | undefined, nofold: number | null | undefined): number | null {
  if (!positive(best) || !positive(nofold)) return null;
  return 1 - best / nofold;
}

/** A gain as the pages show it, to one decimal: "25.0%"; "—" when there is none. */
export function gainText(gain: number | null): string {
  if (gain === null || !Number.isFinite(gain)) return "—";
  // -0.0% reads oddly: a gain that rounds to zero is 0.0%
  const pct = Math.round(gain * 1000) / 10;
  return `${(Object.is(pct, -0) ? 0 : pct).toFixed(1).replace(/^-/, "−")}%`;
}

/**
 * What a nofold value rests on, in the page's words: the research tags ([CALC], [EST]) and the
 * reference to the notes' section stay in the API and the notes.
 */
export function plainNofoldLabel(label: string): string {
  return label
    .replace(/\[(?:CALC|EST|SPEC)\]\s*/g, "")
    .replace(/\s*\(BOUNDARY\.md[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/([^.])$/, "$1.");
}

// ---------- a configuration from the server ----------

/** Cells of the tesseract (packages/boundary: cell 2 i + (sigma > 0) is x_i = sigma s / 2). */
export const TESSERACT_CELLS = 8;

/**
 * A clean copy of a boundary configuration {s, pieces: [{cell, u, q?}]} with P pieces, or null
 * when it is malformed. Only its form is checked here; whether the pieces fit is the server's
 * rule (and the drawing says so when a piece cannot be laid out).
 */
export function readBoundaryConfig(v: unknown, P: number, cells = TESSERACT_CELLS): BoundaryConfig | null {
  if (!isObject(v) || !positive(v.s) || !Array.isArray(v.pieces) || v.pieces.length !== P) return null;
  const pieces: BoundaryPiece[] = [];
  for (const p of v.pieces) {
    if (!isObject(p) || !Number.isInteger(p.cell) || (p.cell as number) < 0 || (p.cell as number) >= cells) return null;
    if (!Array.isArray(p.u) || p.u.length !== 3 || !p.u.every(finite)) return null;
    const piece: BoundaryPiece = { cell: p.cell as number, u: [p.u[0], p.u[1], p.u[2]] };
    if (p.q !== undefined) {
      if (!Array.isArray(p.q) || p.q.length !== 4 || !p.q.every(finite)) return null;
      piece.q = [p.q[0], p.q[1], p.q[2], p.q[3]] as Quaternion;
    }
    pieces.push(piece);
  }
  return { s: v.s, pieces };
}

// ---------- the viewer's address ----------

/** Where the viewer lives (SPACE_INFO.boundary.viewer). */
export const VIEWER_PATH = "/spaces/boundary.html";

/**
 * The problem id a viewer address names: "?id=boundary/tesseract/ball/9" or
 * "#id=boundary/tesseract/ball/9" (the hash wins, so that a link's hash can change the problem
 * of a page opened with a query). The id is not checked here; null when none is named.
 */
export function viewerId(search: string, hash: string): string | null {
  const read = (s: string) => {
    try {
      const v = new URLSearchParams(s.replace(/^[?#]/, "")).get("id");
      return v ? v.trim() || null : null;
    } catch {
      return null;
    }
  };
  return read(hash) ?? read(search);
}

/** The viewer's address of a problem: "/spaces/boundary.html#id=boundary/tesseract/ball/9". */
export const viewerHref = (id: string): string => `${VIEWER_PATH}#id=${id}`;

// ---------- a problem for the viewer ----------

type Status = "best_known" | "proven" | "infeasible";
const STATUSES: readonly Status[] = ["best_known", "proven", "infeasible"];
const text = (v: unknown, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * A boundary problem as GET /api/spaces/boundary/problems/<id> sends it, checked, with both of
 * its packings: the viewer shows either (the board shows the better one). It has the fields the
 * values are read from (space/facts.ts FactSource).
 */
export interface ViewerProblem {
  space: "boundary";
  id: string;
  polytope: string;
  piece: string;
  P: number;
  certified: { score: number; display: string; status: Status } | null;
  status: Status | null;
  bound: { value: number; label: string } | null;
  site_best: { id: number; score: number; name: string; created_at: string } | null;
  best_score: number | null;
  accepts_submissions: boolean;
  closed_reason: string | null;
  extra: FoldExtra | null;
  /** The research record's packing and the site leader's; null when absent or malformed. */
  configs: { certified: BoundaryConfig | null; site: BoundaryConfig | null };
}

/** The fields of a boundary problem id, or null: boundary/<polytope>/<piece>/<P>, P from 1 to 9999. */
export function boundaryFields(id: string): { polytope: string; piece: string; P: number } | null {
  const m = /^boundary\/([a-z]+)\/([a-z]+)\/([1-9]\d{0,3})$/.exec(id);
  return m ? { polytope: m[1], piece: m[2], P: Number(m[3]) } : null;
}

/** The problem in the server's answer, or a sentence saying why it cannot be shown. */
export function readViewerProblem(id: string, body: unknown): ViewerProblem | string {
  const f = boundaryFields(id);
  if (!f) return `${id} is not a 3D on 4D problem.`;
  if (!isObject(body) || body.space !== "boundary" || body.id !== id) return "The server's answer is not this problem.";
  if (typeof body.accepts_submissions !== "boolean") return "The server's answer is malformed.";
  let certified: ViewerProblem["certified"] = null;
  if (body.certified != null) {
    const c = body.certified;
    if (!isObject(c) || !positive(c.score) || !STATUSES.includes(c.status as Status))
      return "The server's answer has a malformed certified value.";
    certified = { score: c.score, display: text(c.display, 40) || c.score.toFixed(6), status: c.status as Status };
  }
  let site: ViewerProblem["site_best"] = null;
  if (body.site_best != null) {
    const b = body.site_best;
    if (!isObject(b) || !Number.isSafeInteger(b.id) || !positive(b.score))
      return "The server's answer has a malformed site best.";
    site = { id: b.id as number, score: b.score, name: text(b.name, 80), created_at: text(b.created_at, 40) };
  }
  const values = [certified?.score, site?.score].filter((v): v is number => typeof v === "number");
  const config = (v: unknown) => (v == null ? null : readBoundaryConfig(v, f.P));
  return {
    space: "boundary",
    id,
    ...f,
    certified,
    status: STATUSES.includes(body.status as Status) ? (body.status as Status) : null,
    bound:
      isObject(body.bound) && positive(body.bound.value)
        ? { value: body.bound.value, label: text(body.bound.label) }
        : null,
    site_best: site,
    best_score: values.length ? Math.min(...values) : null,
    accepts_submissions: body.accepts_submissions,
    closed_reason:
      typeof body.closed_reason === "string" && body.closed_reason.trim() ? text(body.closed_reason) : null,
    extra: readFoldExtra(body.extra),
    // a configuration is shown only with its value: one without the other is not this problem's
    configs: {
      certified: certified ? config(body.certified_config) : null,
      site: site ? config(body.site_config) : null,
    },
  };
}

/** Which packing the viewer shows: the one asked for when the problem has it, else the better one. */
export function viewerPacking(p: ViewerProblem, wanted: "certified" | "site" | null): "certified" | "site" | null {
  const has = (k: "certified" | "site") => p.configs[k] !== null;
  if (wanted && has(wanted)) return wanted;
  // the better of the two, the research record on a tie (as the board chooses)
  if (has("site") && (!has("certified") || p.site_best!.score < p.certified!.score)) return "site";
  return has("certified") ? "certified" : null;
}
