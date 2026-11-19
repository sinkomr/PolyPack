import { StrictResult } from "./config";
import { Container, Pose } from "./shapes";

/** Types shared by the web client, the server and data/records.json. */

export type RecordStatus = "proven" | "proven_unrefereed" | "best_known" | "trivial_tiling";

/** One published value, already converted to the site conventions (polygon side 1, disk diameter 1). */
export interface LiteratureRecord {
  N: number;
  M: number;
  P: number;
  /** Container side (polygon) or diameter (circle) in site conventions. */
  value: number;
  /** The value as it can be quoted from the source after conversion, e.g. "2.44719+". */
  display: string;
  /** Number of decimals of `value` that the source supports. */
  display_precision: number;
  status: RecordStatus;
  source_name: string;
  source_url: string;
  picture_url?: string;
  /** ISO date on which the source was read. */
  accessed: string;
  citation?: string;
  /** How the source value was converted to site conventions. */
  conversion_note: string;
  note?: string;
  /** Where the coordinates come from, when not from the source of the value. */
  coordinates_note?: string;
  /** Coordinates, when available. */
  pieces?: Pose[];
  container_phi?: number;
}

export type Verification = "none" | "pending" | "confirmed" | "rejected";

/**
 * How a submitted packing was found: by hand on the board, by a PolyPack optimizer (unchanged, or
 * edited by hand afterwards), or by the submitter's own software. Entries stored before this was
 * recorded, and legacy submissions that declared `agent: "ai"` without it, have `null`.
 */
export const FOUND_WITH = ["hand", "optimizer", "optimizer_edited", "external"] as const;
export type FoundWith = (typeof FOUND_WITH)[number];

/** Search budget of an optimizer run, as the solver takes it. */
export interface RunBudget {
  evals?: number;
  time_s?: number;
}

/**
 * How a stored entry was found, as GET /api/submissions/{id} returns it. The method fields are
 * set only for found_with "optimizer" and "optimizer_edited"; `software` for those and "external".
 */
export interface Provenance {
  found_with: FoundWith | null;
  /** Registered PolyPack search method. */
  method: string | null;
  /** The method's resolved parameters. */
  method_params: Record<string, unknown> | null;
  seed: number | null;
  budget: RunBudget | null;
  /** Name of the submitter's own tool, or of the program that ran the optimizer (such as the volunteer client). */
  software: string | null;
}

export interface LeaderboardEntry {
  id: number;
  name: string;
  found_with: FoundWith | null;
  agent_note: string;
  score: number;
  created_at: string;
  verification: Verification;
}

export interface ProblemInfo {
  N: number;
  M: number;
  P: number;
  conventions: Record<string, string | number>;
  area_bound: number;
  literature: LiteratureRecord | null;
  /** The leader of the problem; null when there is none or the problem is closed. */
  site_best: LeaderboardEntry | null;
  /** False when the published optimum is proven: see `closedToSubmissions`. */
  accepts_submissions: boolean;
}

export interface SubmitResponse {
  valid: boolean;
  reasons: string[];
  score: number | null;
  /** 1 when this entry is the problem's leader after it was stored, otherwise its position (at least 2). */
  rank: number | null;
  /** True exactly when `rank` is 1. */
  leader: boolean;
  /** Score of the problem's leader after this submission; null when nothing was stored. */
  leader_score: number | null;
  id: number | null;
  container: Container | null;
  pending_verification: boolean;
  strict_check: StrictResult | null;
}

/**
 * One drawing of the records atlas: the best configuration the site can draw for one P.
 * The site's best entry is used when it is at least as good as the published value (or when
 * nothing else can be drawn); otherwise the published coordinates.
 */
export interface AtlasTile {
  P: number;
  /** Where the coordinates come from. */
  source: "site" | "literature";
  /** Size of the drawn packing: the entry's score, or the published value. */
  score: number;
  pieces: Pose[];
  container_phi: number;
  /** Submission id; site entries only. */
  id?: number;
  /** Site entries only. Rejected entries are never listed. */
  verification?: Verification;
  /** Site entries only: how the entry was found (null when not recorded). */
  found_with?: FoundWith | null;
}

/** Answer of GET /api/atlas: the drawable packings of one (N, M) for P in [from, to]. */
export interface AtlasResponse {
  N: number;
  M: number;
  from: number;
  to: number;
  /** First P of the range that was left out to keep the response small; null when complete. */
  next: number | null;
  tiles: AtlasTile[];
}

/**
/**
 * One name of GET /api/holders: what the leading entries submitted under exactly that name hold,
 * over the problems that are open, in every Dimension. A claim awaiting review counts in `site_bests` and
 * `pending` only, since until it is reviewed the published value still stands.
 */
export interface Holder {
  name: string;
  /**
   * Leading entries that are the record: at least as good as the published value (see reachesLiterature), or without
   * one. In the Dimensions other than the polygon problems of 2D in 2D, a leading entry is the record when it is below
   * the research record or the problem has none, as in GET /api/leaders.
   */
  records: number;
  /** Of `records`, those below the published value (see beatsLiterature) or the research record. */
  beat_published: number;
  /** Leading entries, whatever their value. */
  site_bests: number;
  /** Of `site_bests`, claims awaiting review (only the polygon problems have a review). */
  pending: number;
  /**
   * The most `records` the name has held at once. Peaks are tracked from 2026-11-05, and over every Dimension from the
   * deployment of the Dimensions' counts in November 2026; before that, a name's peak counts the polygon problems of
   * 2D in 2D only. A name that has lost every
   * lead stays listed with zero counts and its peak.
   */
  peak: number;
}

/**
 * A row of GET /api/holders: a name's counts, and its `records` by Dimension (problemDimension's ids: "2-in-2",
 * "2-on-3", ...), only the Dimensions with at least one, in the order of dimensionRank.
 */
export interface HolderRow extends Holder {
  dimensions: Record<string, number>;
}

/** Answer of GET /api/holders, most records first. */
export interface HoldersResponse {
  holders: HolderRow[];
}

/**
 * The Dimension of a problem, by the id the records pages use (apps/web/src/dimension-table.ts): "2-in-2" for
 * polygons or disks in a container (`space` null) and the curved space, "2-on-3" for surfaces, the sphere and the
 * torus, "3-in-3" for polyhedra and balls, "3-on-4" for the boundaries of the 4D polytopes, "<d-1>-on-<d>" for those
 * of the d-polytopes and "<d>-in-<d>" for nD; null for an id it cannot place.
 */
export function problemDimension(space: string | null, problem: string): string | null {
  switch (space) {
    case null:
    case "curved":
      return "2-in-2";
    case "surface":
    case "sphere":
    case "torus":
      return "2-on-3";
    case "polyhedra":
    case "balls":
      return "3-in-3";
    case "boundary": {
      // boundary/<polytope>/<piece>/<P>: the polytopes of 4D by name (tesseract, 5cell, ..., 600cell), the others as
      // <d>simplex, <d>cube, <d>orthoplex or <d>demicube
      const polytope = problem.split("/")[1] ?? "";
      const m = /^(\d+)(?:simplex|cube|orthoplex|demicube)$/.exec(polytope);
      const d = m ? Number(m[1]) : 4;
      return `${d - 1}-on-${d}`;
    }
    case "ndim": {
      // ndim/<d>/<piece>/<container>/<P>
      const d = Number(problem.split("/")[1]);
      return Number.isInteger(d) && d > 0 ? `${d}-in-${d}` : null;
    }
    default:
      return null;
  }
}

/** Where a Dimension id comes in DIMENSION order: by the pieces' dimension, "in" before "on" (2-in-2, 2-on-3, 3-in-3, ...). */
export function dimensionRank(id: string): number {
  const m = /^(\d+)-(in|on)-\d+$/.exec(id);
  return m ? Number(m[1]) * 2 + (m[2] === "on" ? 1 : 0) : Number.MAX_SAFE_INTEGER;
}

/** One pair of shapes in the answer of GET /api/holder: the problems of that pair a name leads. */
export interface HolderPair {
  N: number;
  M: number;
  /** The values of P of the pair that the name leads, ascending. */
  P: number[];
  /** Of those, the leading entries that are the record (see `Holder`). */
  records: number;
  /** Of `records`, those below the published value. */
  beat_published: number;
  /** Of those, claims awaiting review. */
  pending: number;
}

/**
 * Answer of GET /api/holder?name=: what the name leads among the polygon problems of 2D in 2D (all zero for a name that
 * leads none), counted as GET /api/holders counts them, when they were counted, and the problems behind them by pair
 * of shapes, the pair with most problems first. `peak` is the name's in GET /api/holders, over every Dimension.
 */
export interface HolderResponse extends Holder {
  /** When the answer was made, as an ISO 8601 time (UTC). The server keeps an answer for a few minutes. */
  computed_at: string;
  pairs: HolderPair[];
}

/** Sent to all viewers when a problem gets a new leader; `id`, `score` and `name` are the leader's. */
export interface LeaderboardEvent {
  N: number;
  M: number;
  P: number;
  id: number;
  score: number;
  /** Always 1; kept for clients written when several rows were shown. */
  rank: number;
  name: string;
}

/**
 * Most keys one live-update stream may follow (GET /api/events?keys=...). A key is "N/M/P" for one
 * problem or "N/M/*" for every P of one pair of shapes.
 */
export const MAX_EVENT_KEYS = 100;

/**
 * The keys of a live-update stream that follows `problems`, given in order of importance: one
 * "N/M/P" each while they fit in `max`. Beyond that the pairs with the most problems are followed
 * whole ("N/M/*", which follows more than asked but nothing less), and if that is still too many,
 * the least important problems are left out.
 */
export function eventKeys(problems: readonly { N: number; M: number; P: number }[], max = MAX_EVENT_KEYS): string[] {
  const keys = [...new Set(problems.map((p) => `${p.N}/${p.M}/${p.P}`))];
  const pairOf = (key: string) => key.slice(0, key.lastIndexOf("/"));
  const count = new Map<string, number>();
  for (const k of keys) count.set(pairOf(k), (count.get(pairOf(k)) ?? 0) + 1);
  const whole = new Set<string>();
  let size = keys.length;
  for (const [pair, n] of [...count].sort((a, b) => b[1] - a[1])) {
    if (size <= max || n < 2) break;
    whole.add(pair);
    size -= n - 1;
  }
  // a pair followed whole takes the place of its most important problem
  const out = new Set<string>();
  for (const k of keys) out.add(whole.has(pairOf(k)) ? `${pairOf(k)}/*` : k);
  return [...out].slice(0, max);
}

/** Number of leaderboard rows shown per problem: only the leader. */
export const LEADERBOARD_SIZE = 1;

/**
 * Relative score difference below which two entries count as equally good. It has the magnitude
 * of the validity tolerance TOL: a smaller improvement cannot be told apart from the slack that
 * validity already allows, so it must not take the lead from an earlier entry.
 *
 * The leader of a problem is the earliest listed entry whose score is within this tolerance of
 * the smallest listed score, i.e. score <= min * (1 + SCORE_TIE).
 */
export const SCORE_TIE = 1e-9;

/** True when `score` is better than `leaderScore` by more than the tie tolerance. */
export function improvesOn(score: number, leaderScore: number): boolean {
  return score < leaderScore * (1 - SCORE_TIE);
}

/**
 * True when a problem no longer takes submissions: its published optimum is proven in the
 * refereed literature or is a zero-waste tiling. An unrefereed proof leaves the problem open, so
 * that a counterexample can still be entered.
 */
export function closedToSubmissions(rec: LiteratureRecord | null | undefined): boolean {
  return !!rec && (rec.status === "proven" || rec.status === "trivial_tiling");
}

export function isProven(status: RecordStatus): boolean {
  return status !== "best_known";
}

/**
 * The uncertainty of a published value, 10^-display_precision in the source's own unit, in the unit of the value. A
 * polygon-in-circle value is the container diameter, twice the radius the source printed, so its tolerance is doubled
 * (the same rule as sourceTolerance in scripts/units.ts).
 */
export function literatureTolerance(rec: Pick<LiteratureRecord, "N" | "M" | "display_precision">): number {
  return Math.pow(10, -rec.display_precision) * (rec.N > 0 && rec.M === 0 ? 2 : 1);
}

/** True when a score is below the published value by more than the source's display precision (see literatureTolerance). */
export function beatsLiterature(score: number, rec: LiteratureRecord): boolean {
  return score < rec.value - literatureTolerance(rec);
}

/**
 * True when a score is at least as good as the published value, to the precision the source
 * prints. Never finer than 1e-9, so that a re-derived optimum such as 3.0000000000000004 still
 * reaches 3.
 */
export function reachesLiterature(score: number, rec: LiteratureRecord): boolean {
  return score <= rec.value + Math.max(literatureTolerance(rec), 1e-9);
}
