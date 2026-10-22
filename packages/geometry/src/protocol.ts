import { StrictResult } from "./config";
import { Container, Pose } from "./shapes";

/** Types shared by the web client, the server and data/records.json. */

export type RecordStatus = "proven" | "proven_unrefereed" | "best_known" | "trivial_tiling";

/** One published value, already converted to the site conventions (piece side or radius 1). */
export interface LiteratureRecord {
  N: number;
  M: number;
  P: number;
  /** Container side (polygon) or radius (circle) in site conventions. */
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
 * set only for found_with "optimizer" and "optimizer_edited", `software` only for "external".
 */
export interface Provenance {
  found_with: FoundWith | null;
  /** Registered PolyPack search method. */
  method: string | null;
  /** The method's resolved parameters. */
  method_params: Record<string, unknown> | null;
  seed: number | null;
  budget: RunBudget | null;
  /** Name of the submitter's own tool. */
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
  conventions: Record<string, string>;
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
 * One name of GET /api/holders: what the leading entries submitted under exactly that name hold,
 * over the problems that are open. A claim awaiting review counts in `site_bests` and `pending`
 * only, since until it is reviewed the published value still stands.
 */
export interface Holder {
  name: string;
  /** Leading entries that are the record: at least as good as the published value (see reachesLiterature), or without one. */
  records: number;
  /** Of `records`, those below the published value (see beatsLiterature). */
  beat_published: number;
  /** Leading entries, whatever their value. */
  site_bests: number;
  /** Of `site_bests`, claims awaiting review. */
  pending: number;
}

/** Answer of GET /api/holders, most records first. */
export interface HoldersResponse {
  holders: Holder[];
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

/** True when a score is below the published value by more than the source's display precision. */
export function beatsLiterature(score: number, rec: LiteratureRecord): boolean {
  return score < rec.value - Math.pow(10, -rec.display_precision);
}

/**
 * True when a score is at least as good as the published value, to the precision the source
 * prints. Never finer than 1e-9, so that a re-derived optimum such as 3.0000000000000004 still
 * reaches 3.
 */
export function reachesLiterature(score: number, rec: LiteratureRecord): boolean {
  return score <= rec.value + Math.max(Math.pow(10, -rec.display_precision), 1e-9);
}
