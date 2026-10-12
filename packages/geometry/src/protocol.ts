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

export interface LeaderboardEntry {
  id: number;
  name: string;
  agent: "human" | "ai";
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
  site_best: LeaderboardEntry | null;
}

export interface SubmitResponse {
  valid: boolean;
  reasons: string[];
  score: number | null;
  rank: number | null;
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

/** Sent to all viewers when a submission enters the displayed leaderboard. */
export interface LeaderboardEvent {
  N: number;
  M: number;
  P: number;
  id: number;
  score: number;
  rank: number;
  name: string;
}

/** Number of leaderboard rows shown per problem. */
export const LEADERBOARD_SIZE = 3;

export function isProven(status: RecordStatus): boolean {
  return status !== "best_known";
}

/** True when a score is below the published value by more than the source's display precision. */
export function beatsLiterature(score: number, rec: LiteratureRecord): boolean {
  return score < rec.value - Math.pow(10, -rec.display_precision);
}
