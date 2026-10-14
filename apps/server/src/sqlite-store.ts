import { DatabaseSync } from "node:sqlite";
import { LeaderboardEntry, SCORE_TIE } from "@polypack/geometry";
import { GET_MANY_LIMIT, KEEP_PER_PROBLEM, NewSubmission, Store, StoredSubmission } from "./store";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  n INTEGER NOT NULL,
  m INTEGER NOT NULL,
  p INTEGER NOT NULL,
  score REAL NOT NULL,
  name TEXT NOT NULL,
  agent TEXT NOT NULL,
  agent_note TEXT NOT NULL,
  pieces TEXT NOT NULL,
  container_phi REAL NOT NULL,
  created_at TEXT NOT NULL,
  verification TEXT NOT NULL DEFAULT 'none',
  literature_value REAL,
  strict_check TEXT
);
CREATE INDEX IF NOT EXISTS submissions_problem ON submissions (n, m, p, score, id);
CREATE INDEX IF NOT EXISTS submissions_verification ON submissions (verification);
`;

// Running count of accepted submissions per problem; the rows themselves are pruned.
const TALLIES = `
CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
  PRIMARY KEY (n, m, p));
INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions WHERE verification != 'rejected' GROUP BY n, m, p;
`;

const ENTRY_COLUMNS = "id, name, agent, agent_note, score, created_at, verification";
const LISTED = "verification != 'rejected'";

type Row = Record<string, unknown>;

function toStored(r: Row): StoredSubmission {
  return {
    id: r.id as number,
    N: r.n as number,
    M: r.m as number,
    P: r.p as number,
    score: r.score as number,
    name: r.name as string,
    agent: r.agent as "human" | "ai",
    agent_note: r.agent_note as string,
    pieces: JSON.parse(r.pieces as string),
    container_phi: r.container_phi as number,
    created_at: r.created_at as string,
    verification: r.verification as StoredSubmission["verification"],
    literature_value: r.literature_value as number | null,
    strict_check: r.strict_check ? JSON.parse(r.strict_check as string) : null,
  };
}

/** SQLite store on Node's built-in driver. Pass ":memory:" for tests. */
export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // A database from before pruning: start the tallies from what it holds, then prune it.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tallies'").get()) {
      this.db.exec(TALLIES);
      const crowded = this.db
        .prepare(`SELECT n, m, p FROM submissions WHERE ${LISTED} GROUP BY n, m, p HAVING COUNT(*) > ?`)
        .all(KEEP_PER_PROBLEM) as Row[];
      for (const r of crowded) this.pruneSync(r.n as number, r.m as number, r.p as number);
    }
  }

  async insert(s: NewSubmission): Promise<number> {
    const r = this.db
      .prepare(
        `INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at,
           verification, literature_value, strict_check)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.N,
        s.M,
        s.P,
        s.score,
        s.name,
        s.agent,
        s.agent_note,
        // JSON keeps every double exactly
        JSON.stringify(s.pieces),
        s.container_phi,
        s.created_at,
        s.verification,
        s.literature_value,
        s.strict_check ? JSON.stringify(s.strict_check) : null,
      );
    this.db
      .prepare(
        `INSERT INTO tallies (n, m, p, accepted) VALUES (?, ?, ?, 1)
         ON CONFLICT (n, m, p) DO UPDATE SET accepted = accepted + 1`,
      )
      .run(s.N, s.M, s.P);
    return Number(r.lastInsertRowid);
  }

  async get(id: number): Promise<StoredSubmission | null> {
    const r = this.db.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as Row | undefined;
    return r ? toStored(r) : null;
  }

  async getMany(ids: readonly number[]): Promise<StoredSubmission[]> {
    if (!ids.length) return [];
    if (ids.length > GET_MANY_LIMIT)
      throw new RangeError(`getMany accepts at most ${GET_MANY_LIMIT} ids, got ${ids.length}`);
    const marks = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM submissions WHERE id IN (${marks}) AND ${LISTED}`).all(...ids);
    return (rows as Row[]).map(toStored);
  }

  async leader(N: number, M: number, P: number): Promise<LeaderboardEntry | null> {
    return this.leaderSync(N, M, P);
  }

  private leaderSync(N: number, M: number, P: number): LeaderboardEntry | null {
    // earliest entry within the tie tolerance of the smallest score, not simply the smallest
    const r = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM submissions WHERE n = ? AND m = ? AND p = ? AND ${LISTED}
           AND score <= (SELECT MIN(score) FROM submissions WHERE n = ? AND m = ? AND p = ? AND ${LISTED}) * (1 + ?)
         ORDER BY id ASC LIMIT 1`,
      )
      .get(N, M, P, N, M, P, SCORE_TIE);
    return (r as unknown as LeaderboardEntry | undefined) ?? null;
  }

  async count(N: number, M: number, P: number): Promise<number> {
    const r = this.db.prepare("SELECT accepted FROM tallies WHERE n = ? AND m = ? AND p = ?").get(N, M, P) as
      Row | undefined;
    return (r?.accepted as number | undefined) ?? 0;
  }

  async prune(N: number, M: number, P: number): Promise<number[]> {
    return this.pruneSync(N, M, P);
  }

  private pruneSync(N: number, M: number, P: number): number[] {
    const leader = this.leaderSync(N, M, P);
    if (!leader) return [];
    // the leader is not always first by score (see `leader`), so it is kept explicitly
    const others = this.db
      .prepare(
        `SELECT id FROM submissions WHERE n = ? AND m = ? AND p = ? AND ${LISTED} AND id != ? ORDER BY score, id`,
      )
      .all(N, M, P, leader.id) as Row[];
    const doomed = others.slice(KEEP_PER_PROBLEM - 1).map((r) => r.id as number);
    const drop = this.db.prepare("DELETE FROM submissions WHERE id = ?");
    for (const id of doomed) drop.run(id);
    return doomed;
  }

  async rank(N: number, M: number, P: number, id: number): Promise<number> {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM submissions s, (SELECT score, id FROM submissions WHERE id = ?) me
         WHERE s.n = ? AND s.m = ? AND s.p = ? AND s.${LISTED}
           AND (s.score < me.score OR (s.score = me.score AND s.id < me.id))`,
      )
      .get(id, N, M, P) as Row;
    return (r.c as number) + 1;
  }

  async bestPerP(N: number, M: number, verifiedOnly = false): Promise<(LeaderboardEntry & { P: number })[]> {
    // the same rule as `leader`, for every P at once: the smallest score per P, then the earliest
    // entry within the tie tolerance of it
    const listed = (t: string) =>
      verifiedOnly ? `${t}.${LISTED} AND ${t}.verification != 'pending'` : `${t}.${LISTED}`;
    return this.db
      .prepare(
        `WITH best AS (SELECT u.p AS bp, MIN(u.score) AS lo FROM submissions u
                       WHERE u.n = ? AND u.m = ? AND ${listed("u")} GROUP BY u.p)
         SELECT s.p AS P, ${ENTRY_COLUMNS} FROM submissions s JOIN best ON best.bp = s.p
         WHERE s.n = ? AND s.m = ?
           AND s.id = (SELECT MIN(t.id) FROM submissions t
                       WHERE t.n = s.n AND t.m = s.m AND t.p = s.p AND ${listed("t")} AND t.score <= best.lo * (1 + ?))
         ORDER BY s.p ASC`,
      )
      .all(N, M, N, M, SCORE_TIE) as unknown as (LeaderboardEntry & { P: number })[];
  }

  async pending(): Promise<StoredSubmission[]> {
    const rows = this.db.prepare("SELECT * FROM submissions WHERE verification = 'pending' ORDER BY id DESC").all();
    return (rows as Row[]).map(toStored);
  }

  async review(id: number, decision: "confirmed" | "rejected"): Promise<boolean> {
    const r = this.db
      .prepare("UPDATE submissions SET verification = ? WHERE id = ? AND verification != 'none'")
      .run(decision, id);
    return Number(r.changes) > 0;
  }

  async remove(id: number): Promise<boolean> {
    const r = this.db
      .prepare("UPDATE submissions SET verification = 'rejected' WHERE id = ? AND verification != 'rejected'")
      .run(id);
    return Number(r.changes) > 0;
  }
}
