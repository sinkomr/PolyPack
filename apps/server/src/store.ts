import { LeaderboardEntry, Pose, StrictResult, Verification } from "@polypack/geometry";

/** Most ids one `getMany` call accepts. */
export const GET_MANY_LIMIT = 500;

export interface NewSubmission {
  N: number;
  M: number;
  P: number;
  score: number;
  name: string;
  agent: "human" | "ai";
  agent_note: string;
  pieces: Pose[];
  /** Orientation the score was computed at (the better of submitted and auto-oriented). */
  container_phi: number;
  created_at: string;
  verification: Verification;
  /** Published value that the submission beat, when it did. */
  literature_value: number | null;
  strict_check: StrictResult | null;
}

export interface StoredSubmission extends NewSubmission {
  id: number;
}

/**
 * Persistence used by the API. Async so that the same routes can run on a hosted SQL service
 * (for example Cloudflare D1) as well as on local SQLite.
 * Leaderboard order is score ascending, then earliest first. Rejected entries are excluded.
 */
export interface Store {
  insert(s: NewSubmission): Promise<number>;
  get(id: number): Promise<StoredSubmission | null>;
  /**
   * Stored submissions for the given ids, in no particular order. Rejected and unknown ids are
   * left out. At most GET_MANY_LIMIT ids; asking for more is a programming error and throws.
   */
  getMany(ids: readonly number[]): Promise<StoredSubmission[]>;
  top(N: number, M: number, P: number, limit: number): Promise<LeaderboardEntry[]>;
  count(N: number, M: number, P: number): Promise<number>;
  /** 1 + the number of entries ranked ahead of submission `id`. */
  rank(N: number, M: number, P: number, id: number): Promise<number>;
  /**
   * Best entry for every P of one (N, M). With `verifiedOnly`, entries that are pending
   * verification are left out as well, so the result is the best reviewed or unremarkable entry.
   */
  bestPerP(N: number, M: number, verifiedOnly?: boolean): Promise<(LeaderboardEntry & { P: number })[]>;
  pending(): Promise<StoredSubmission[]>;
  review(id: number, decision: "confirmed" | "rejected"): Promise<boolean>;
}
