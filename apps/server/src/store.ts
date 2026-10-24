import { FoundWith, LeaderboardEntry, Pose, Provenance, StrictResult, Verification } from "@polypack/geometry";

/** What `edit` may change; `provenance` replaces all six provenance fields together. */
export interface EntryEdit {
  name?: string;
  agent_note?: string;
  provenance?: Provenance;
}

/** Most ids one `getMany` call accepts. */
export const GET_MANY_LIMIT = 500;

/**
 * Entries kept per problem: the leader alone (decided 2026-10-18, to keep the database small;
 * it was 3). Every other entry is deleted as soon as it is overtaken, row and name included.
 *
 * One exception: while the leader is pending verification (it claims to beat a published value
 * and awaits review), the best entry that is not pending is kept as well, so that rejecting the
 * claim gives the problem back its previous record. Other pending entries are deleted like any
 * other. Once the claim is confirmed, that entry goes; once it is rejected, the claim goes.
 *
 * Removing the leader therefore leaves a problem without a site entry, unless the leader was a
 * pending claim: the published value, if there is one, is then all the site shows.
 */
export const KEEP_PER_PROBLEM = 1;

/**
 * How the entry was found (see Provenance). The legacy `agent` column of older databases is no
 * longer read; new rows store an empty string in it.
 */
export interface NewSubmission extends Provenance {
  N: number;
  M: number;
  P: number;
  score: number;
  name: string;
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

/** The leader of one problem, as `leaders` lists it. */
export interface ProblemLeader {
  N: number;
  M: number;
  P: number;
  /** Submission id of the leading entry. */
  id: number;
  name: string;
  score: number;
  verification: Verification;
  found_with: FoundWith | null;
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
   * Deletes every entry of one problem except those it keeps (see KEEP_PER_PROBLEM): the leader,
   * and while the leader is pending, the leader among the entries that are not. Rejected rows of
   * the problem left by older versions go too. Returns the ids deleted.
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
  /** The leader of every problem that has a listed entry, by N, then M, then P. */
  leaders(): Promise<ProblemLeader[]>;
  pending(): Promise<StoredSubmission[]>;
  /**
   * Decides on an entry that is pending or was confirmed, then prunes its problem. A rejected entry
   * is deleted, so the entry kept behind a pending claim leads again; a confirmed one is kept
   * alone. False when there is no such entry.
   */
  review(id: number, decision: "confirmed" | "rejected"): Promise<boolean>;
  /**
   * Takes any listed entry off the site (an abusive name, a test entry): the row is deleted, and
   * the problem is pruned again. False when there is no such listed entry.
   */
  remove(id: number): Promise<boolean>;
  /**
   * Corrects the name, note or provenance of a listed entry (a renamed bot, a provenance recorded in
   * the note by an older client). Fields left undefined are kept. False when there is no such entry.
   */
  edit(id: number, changes: EntryEdit): Promise<boolean>;
}
