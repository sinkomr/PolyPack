import { DatabaseSync } from "node:sqlite";
import { LeaderboardEntry } from "@polypack/geometry";
import { GET_MANY_LIMIT, NewSubmission, Store, StoredSubmission } from "./store";

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
    return Number(r.lastInsertRowid);
  }

  async get(id: number): Promise<StoredSubmission | null> {
    const r = this.db.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as Row | undefined;
    return r ? toStored(r) : null;
  }

  async getMany(ids: readonly number[]): Promise<StoredSubmission[]> {
    if (!ids.length) return [];
    if (ids.length > GET_MANY_LIMIT) throw new RangeError(`getMany accepts at most ${GET_MANY_LIMIT} ids, got ${ids.length}`);
    const marks = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM submissions WHERE id IN (${marks}) AND ${LISTED}`).all(...ids);
    return (rows as Row[]).map(toStored);
  }

  async top(N: number, M: number, P: number, limit: number): Promise<LeaderboardEntry[]> {
    return this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM submissions WHERE n = ? AND m = ? AND p = ? AND ${LISTED}
         ORDER BY score ASC, id ASC LIMIT ?`,
      )
      .all(N, M, P, limit) as unknown as LeaderboardEntry[];
  }

  async count(N: number, M: number, P: number): Promise<number> {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS c FROM submissions WHERE n = ? AND m = ? AND p = ? AND ${LISTED}`)
      .get(N, M, P) as Row;
    return r.c as number;
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
    // the first row of each P in leaderboard order
    const listed = verifiedOnly ? `${LISTED} AND verification != 'pending'` : LISTED;
    const inner = verifiedOnly ? `t.${LISTED} AND t.verification != 'pending'` : `t.${LISTED}`;
    return this.db
      .prepare(
        `SELECT p AS P, ${ENTRY_COLUMNS} FROM submissions s WHERE n = ? AND m = ? AND ${listed}
           AND id = (SELECT id FROM submissions t WHERE t.n = s.n AND t.m = s.m AND t.p = s.p AND ${inner}
                     ORDER BY score ASC, id ASC LIMIT 1)
         ORDER BY p ASC`,
      )
      .all(N, M) as unknown as (LeaderboardEntry & { P: number })[];
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
}
