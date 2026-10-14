import { LeaderboardEntry, Pose, StrictResult, Verification } from "@polypack/geometry";

/** Most ids one `getMany` call accepts. */
export const GET_MANY_LIMIT = 500;

/**
 * Entries kept per problem: the leader and the next best two, so that removing or rejecting the
 * leader still leaves a drawing. Anything further down is deleted as soon as it is overtaken.
 */
export const KEEP_PER_PROBLEM = 3;

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
 * Rejected entries are excluded from every listing. The leader of a problem is the earliest
 * listed entry whose score is within SCORE_TIE (relative) of the smallest listed score.
 */
export interface Store {
  insert(s: NewSubmission): Promise<number>;
  get(id: number): Promise<StoredSubmission | null>;
  /**
   * Stored submissions for the given ids, in no particular order. Rejected and unknown ids are
   * left out. At most GET_MANY_LIMIT ids; asking for more is a programming error and throws.
   */
  getMany(ids: readonly number[]): Promise<StoredSubmission[]>;
  /** The leader of one problem, or null when it has no listed entry. */
  leader(N: number, M: number, P: number): Promise<LeaderboardEntry | null>;
  /** Number of valid submissions ever accepted for one problem, including those since deleted. */
  count(N: number, M: number, P: number): Promise<number>;
  /**
   * Deletes the listed entries of one problem beyond the leader and the next best
   * KEEP_PER_PROBLEM - 1 (by score, then earliest). Returns the ids deleted.
   */
  prune(N: number, M: number, P: number): Promise<number[]>;
  /**
   * 1 + the number of listed entries ahead of submission `id`: those with a smaller score, or an
   * equal score and a smaller id. Position 1 is not always the leader; see `leader`.
   */
  rank(N: number, M: number, P: number, id: number): Promise<number>;
  /**
   * The leader for every P of one (N, M). With `verifiedOnly`, entries that are pending
   * verification are left out before the leader is chosen, so the result is the leader among the
   * reviewed or unremarkable entries.
   */
  bestPerP(N: number, M: number, verifiedOnly?: boolean): Promise<(LeaderboardEntry & { P: number })[]>;
  pending(): Promise<StoredSubmission[]>;
  review(id: number, decision: "confirmed" | "rejected"): Promise<boolean>;
  /**
   * Takes any entry off the site (an abusive name, a test entry). The row is kept and marked
   * rejected, which hides it from every listing. False when there is no such listed entry.
   */
  remove(id: number): Promise<boolean>;
}
