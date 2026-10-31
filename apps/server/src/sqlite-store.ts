import { DatabaseSync } from "node:sqlite";
import { LeaderboardEntry, SCORE_TIE } from "@polypack/geometry";
import { blobFromJson, encodePieces, readPieces } from "./pieces";
import { EPOCH_DIAMETER, UnitsReport, migrateUnits, setUnitsEpoch, unitsEpoch } from "./units-migration";
import {
  EntryEdit,
  GET_MANY_LIMIT,
  KEEP_PER_PROBLEM,
  NewSpaceEntry,
  NewSubmission,
  ProblemLeader,
  SpaceEntryEdit,
  SpaceLeader,
  SpaceStore,
  SpaceSubmitted,
  Store,
  StoredSpaceEntry,
  StoredSubmission,
  Submitted,
} from "./store";

// `pieces` is declared TEXT NOT NULL, as it was created; new rows store a BLOB in it (see
// pieces.ts), which SQLite keeps unchanged in a TEXT column, so the table needs no rebuild.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  n INTEGER NOT NULL,
  m INTEGER NOT NULL,
  p INTEGER NOT NULL,
  score REAL NOT NULL,
  name TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT '',
  agent_note TEXT NOT NULL,
  pieces TEXT NOT NULL,
  container_phi REAL NOT NULL,
  created_at TEXT NOT NULL,
  verification TEXT NOT NULL DEFAULT 'none',
  literature_value REAL,
  strict_check TEXT,
  found_with TEXT,
  method TEXT,
  method_params TEXT,
  seed INTEGER,
  budget TEXT,
  software TEXT
);
CREATE INDEX IF NOT EXISTS submissions_verification ON submissions (verification);
`;

/**
 * Every column that finding leaders, pruning, ranking and listing read, so that those queries are
 * answered from the index alone. In the table, verification and the columns added later come
 * after pieces (up to tens of kilobytes); a query that reads them from the table walks every
 * row's pieces, which turned each listing into gigabytes of disk reads once the database
 * outgrew memory. It replaces the narrower index on (n, m, p, score, id).
 */
const LISTING_INDEX = `
CREATE INDEX IF NOT EXISTS submissions_listing
  ON submissions (n, m, p, score, id, verification, name, found_with, agent_note, created_at);
DROP INDEX IF EXISTS submissions_problem;
`;

// Running count of accepted submissions per problem; the rows themselves are pruned.
const TALLIES = `
CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
  PRIMARY KEY (n, m, p));
INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions WHERE verification != 'rejected' GROUP BY n, m, p;
`;

/**
 * Columns added after the first deployment, with their types. A database created before them gets
 * them by ALTER TABLE on open; its existing rows read back NULL ("not recorded").
 */
const ADDED_COLUMNS: [name: string, type: string][] = [
  ["found_with", "TEXT"],
  ["method", "TEXT"],
  ["method_params", "TEXT"],
  ["seed", "INTEGER"],
  ["budget", "TEXT"],
  ["software", "TEXT"],
];

/**
 * Site entries of the spaces (see SpaceStore), in a table of their own that leaves the polygon
 * tables alone; created when missing, so an older database simply gains it. `config` (the
 * configuration as JSON text, up to tens of kilobytes) comes last and the index holds every column
 * that leaders and listings read, so those never walk the configurations.
 */
const SPACES_SCHEMA = `
CREATE TABLE IF NOT EXISTS space_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space TEXT NOT NULL,
  problem TEXT NOT NULL,
  score REAL NOT NULL,
  name TEXT NOT NULL,
  agent_note TEXT NOT NULL,
  software TEXT,
  method TEXT,
  seed INTEGER,
  created_at TEXT NOT NULL,
  config TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS space_entries_listing ON space_entries (space, problem, score, id, name, created_at);
`;
const SPACE_LEADER_COLUMNS = "id, space, problem, score, name, created_at";

/** Small settings of the store itself; for now the progress of the pieces migration. */
const META = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`;
/** Id of the last row the pieces migration has handled. */
const CURSOR = "pieces_cursor";
/** 1 once the pieces migration has reached the last row. */
const MIGRATED = "pieces_migrated";

const ENTRY_COLUMNS = "id, name, found_with, agent_note, score, created_at, verification";
// Rows are no longer marked rejected (they are deleted); older databases still have such rows
// until the pieces migration or a prune of their problem deletes them.
const LISTED = "verification != 'rejected'";

type Row = Record<string, unknown>;

/** What one step of the pieces migration did. */
export interface MigrationStep {
  /** True when no row was left after the cursor: the migration is complete. */
  done: boolean;
  /** Id of the last row handled so far. */
  cursor: number;
  rows: number;
  /** Rows whose JSON text became a BLOB. */
  converted: number;
  /**
   * Rows deleted because their problem no longer keeps them (see KEEP_PER_PROBLEM), rejected rows
   * included. Rows of the same problem beyond this step count here too.
   */
  deleted: number;
  /** Rows left as JSON text because it is not exactly a list of {x, y, theta}. */
  unreadable: number;
  /** Bytes of pieces of the converted rows, before and after. */
  bytesBefore: number;
  bytesAfter: number;
}

export interface MigrationOptions {
  /** Rows per step; each step is one short transaction. */
  batch: number;
  /** Pause between steps, during which requests are served. */
  pauseMs: number;
  log: (msg: string) => void;
  /** Least time between two progress lines in the log. */
  logEveryMs?: number;
}

function toStored(r: Row): StoredSubmission {
  return {
    id: r.id as number,
    N: r.n as number,
    M: r.m as number,
    P: r.p as number,
    score: r.score as number,
    name: r.name as string,
    agent_note: r.agent_note as string,
    pieces: readPieces(r.pieces),
    container_phi: r.container_phi as number,
    created_at: r.created_at as string,
    verification: r.verification as StoredSubmission["verification"],
    literature_value: r.literature_value as number | null,
    strict_check: r.strict_check ? JSON.parse(r.strict_check as string) : null,
    found_with: (r.found_with ?? null) as StoredSubmission["found_with"],
    method: (r.method ?? null) as string | null,
    method_params: r.method_params ? JSON.parse(r.method_params as string) : null,
    seed: (r.seed ?? null) as number | null,
    budget: r.budget ? JSON.parse(r.budget as string) : null,
    software: (r.software ?? null) as string | null,
  };
}

/** SQLite store on Node's built-in driver. Pass ":memory:" for tests. */
export class SqliteStore implements Store, SpaceStore {
  private db: DatabaseSync;

  /** What the start-up unit conversion did (see units-migration.ts); "none" when the database was already converted. */
  readonly unitsReport: UnitsReport | null = null;

  /**
   * `opts.units`: "migrate" (the default) converts a database in the old units (radius-1 disks and balls) to
   * diameter units in one transaction before the constructor returns, and records it in meta.units_epoch so that it
   * runs once; "leave" opens it as it is (the dry-run and rollback tools).
   */
  constructor(path: string, opts: { units?: "migrate" | "leave"; log?: (msg: string) => void } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    const fresh = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submissions'").get();
    this.db.exec(SCHEMA);
    this.db.exec(META);
    // a new database never holds pieces in the older format, so there is nothing to migrate
    if (fresh) this.setMeta(MIGRATED, 1);
    // A database from before a column existed: add it. The legacy `agent` column stays as it was
    // (SQLite cannot drop its NOT NULL), and new rows store an empty string in it.
    const present = new Set(
      (this.db.prepare("PRAGMA table_info(submissions)").all() as Row[]).map((c) => c.name as string),
    );
    for (const [name, type] of ADDED_COLUMNS)
      if (!present.has(name)) this.db.exec(`ALTER TABLE submissions ADD COLUMN ${name} ${type}`);
    // after the added columns, which it covers; building it on a large database takes a while, once
    this.db.exec(LISTING_INDEX);
    // A database from before pruning: start the tallies from what it holds, then prune it.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tallies'").get()) {
      this.db.exec(TALLIES);
      const crowded = this.db
        .prepare(`SELECT n, m, p FROM submissions WHERE ${LISTED} GROUP BY n, m, p HAVING COUNT(*) > ?`)
        .all(KEEP_PER_PROBLEM) as Row[];
      for (const r of crowded) this.pruneSync(r.n as number, r.m as number, r.p as number);
    }
    this.db.exec(SPACES_SCHEMA);
    // a new database holds nothing in the old units
    if (fresh) setUnitsEpoch(this.db, EPOCH_DIAMETER);
    else if ((opts.units ?? "migrate") === "migrate" && unitsEpoch(this.db) < EPOCH_DIAMETER) {
      const report = migrateUnits(this.db);
      this.unitsReport = report;
      opts.log?.(`units: converted to diameter units in ${report.ms.toFixed(0)} ms: ${JSON.stringify(report)}`);
    }
  }

  async submit(s: NewSubmission): Promise<Submitted> {
    // One transaction, so one commit (one sync of the log) per submission instead of three. Every
    // call in it is synchronous, so no other request runs in between.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.leaderSync(s.N, s.M, s.P);
      const id = this.insertSync(s);
      const leader = this.leaderSync(s.N, s.M, s.P);
      const position = this.rankSync(s.N, s.M, s.P, id);
      const kept = !this.pruneSync(s.N, s.M, s.P).includes(id);
      this.db.exec("COMMIT");
      return { id, before, leader, position, kept };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async insert(s: NewSubmission): Promise<number> {
    return this.insertSync(s);
  }

  private insertSync(s: NewSubmission): number {
    const r = this.db
      .prepare(
        `INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at,
           verification, literature_value, strict_check, found_with, method, method_params, seed, budget, software)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.N,
        s.M,
        s.P,
        s.score,
        s.name,
        s.agent_note,
        // a BLOB of Float64s keeps every double exactly, -0 included, in a third of the JSON
        encodePieces(s.pieces),
        s.container_phi,
        s.created_at,
        s.verification,
        s.literature_value,
        s.strict_check ? JSON.stringify(s.strict_check) : null,
        s.found_with,
        s.method,
        s.method_params ? JSON.stringify(s.method_params) : null,
        s.seed,
        s.budget ? JSON.stringify(s.budget) : null,
        s.software,
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

  /**
   * The leader of one problem; with `reviewedOnly`, the leader among the entries that are not
   * pending (as `bestPerP` with `verifiedOnly`).
   */
  private leaderSync(N: number, M: number, P: number, reviewedOnly = false): LeaderboardEntry | null {
    const among = reviewedOnly ? `${LISTED} AND verification != 'pending'` : LISTED;
    // earliest entry within the tie tolerance of the smallest score, not simply the smallest
    const r = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM submissions WHERE n = ? AND m = ? AND p = ? AND ${among}
           AND score <= (SELECT MIN(score) FROM submissions WHERE n = ? AND m = ? AND p = ? AND ${among}) * (1 + ?)
         ORDER BY id ASC LIMIT 1`,
      )
      .get(N, M, P, N, M, P, SCORE_TIE);
    return (r as unknown as LeaderboardEntry | undefined) ?? null;
  }

  /**
   * The entries one problem keeps (see KEEP_PER_PROBLEM): its leader, and while the leader is
   * pending, the leader among the entries that are not, which is the record the site shows
   * again if the claim is rejected. Empty when the problem has no listed entry.
   */
  private keepersSync(N: number, M: number, P: number): Set<number> {
    const keep = new Set<number>();
    const leader = this.leaderSync(N, M, P);
    if (!leader) return keep;
    keep.add(leader.id);
    if (leader.verification === "pending") {
      const previous = this.leaderSync(N, M, P, true);
      if (previous) keep.add(previous.id);
    }
    return keep;
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
    // The leader is not always first by score (see `leader`), so the kept entries are chosen
    // explicitly. All of the problem's other rows go, rejected ones of older versions included:
    // nothing reads those any more. Deleting them all at once keeps the leader from changing
    // because of the order in which they go.
    const keep = this.keepersSync(N, M, P);
    const rows = this.db
      .prepare("SELECT id FROM submissions WHERE n = ? AND m = ? AND p = ? ORDER BY score, id")
      .all(N, M, P) as Row[];
    const doomed = rows.map((r) => r.id as number).filter((id) => !keep.has(id));
    const drop = this.db.prepare("DELETE FROM submissions WHERE id = ?");
    for (const id of doomed) drop.run(id);
    return doomed;
  }

  async rank(N: number, M: number, P: number, id: number): Promise<number> {
    return this.rankSync(N, M, P, id);
  }

  private rankSync(N: number, M: number, P: number, id: number): number {
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

  async pairs(): Promise<{ N: number; M: number }[]> {
    return this.db
      .prepare(`SELECT DISTINCT n AS N, m AS M FROM submissions WHERE ${LISTED} ORDER BY n, m`)
      .all() as unknown as { N: number; M: number }[];
  }

  async leaders(): Promise<ProblemLeader[]> {
    // The same rule again, for every problem: one pass over the listing index in its own order,
    // so SQLite sorts nothing, and the rule applied here (about 150 ms for 100,000 problems, half
    // the time that window functions took).
    const rows = this.db
      .prepare(
        `SELECT n, m, p, id, name, score, verification FROM submissions WHERE ${LISTED}
         ORDER BY n, m, p, score, id`,
      )
      .all() as Row[];
    return this.leadersFromRows(rows);
  }

  async leadersAfter(after: { N: number; M: number; P: number } | null, limit: number): Promise<ProblemLeader[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
    // shape codes are 0 or more and P is 1 or more, so (-1, -1, -1) is before every problem
    const from = after ?? { N: -1, M: -1, P: -1 };
    // the keys of the next `limit` problems, then their rows, so that no problem is cut in the middle;
    // both are ranges of the listing index, which hands them over in the order asked
    const keys = this.db
      .prepare(
        `SELECT n, m, p FROM submissions WHERE (n, m, p) > (?, ?, ?) AND ${LISTED}
         GROUP BY n, m, p ORDER BY n, m, p LIMIT ?`,
      )
      .all(from.N, from.M, from.P, limit) as Row[];
    if (!keys.length) return [];
    const last = keys[keys.length - 1]!;
    const rows = this.db
      .prepare(
        `SELECT n, m, p, id, name, score, verification FROM submissions
         WHERE (n, m, p) > (?, ?, ?) AND (n, m, p) <= (?, ?, ?) AND ${LISTED}
         ORDER BY n, m, p, score, id`,
      )
      .all(from.N, from.M, from.P, last.n as number, last.m as number, last.p as number) as Row[];
    return this.leadersFromRows(rows);
  }

  async leadersOf(problems: readonly { N: number; M: number; P: number }[]): Promise<ProblemLeader[]> {
    if (!problems.length) return [];
    if (problems.length > GET_MANY_LIMIT) throw new RangeError(`at most ${GET_MANY_LIMIT} problems per call`);
    // row values against the listing index: one lookup per problem, which keeps one row (two while a claim is pending)
    const rows = this.db
      .prepare(
        `SELECT n, m, p, id, name, score, verification FROM submissions
         WHERE (n, m, p) IN (VALUES ${problems.map(() => "(?, ?, ?)").join(", ")}) AND ${LISTED}
         ORDER BY n, m, p, score, id`,
      )
      .all(...problems.flatMap((q) => [q.N, q.M, q.P])) as Row[];
    return this.leadersFromRows(rows);
  }

  /**
   * The leaders of rows read in (n, m, p, score, id) order. The first row of a problem has its
   * smallest score; the leader is the earliest of the rows within the tie tolerance of it.
   */
  private leadersFromRows(rows: Row[]): ProblemLeader[] {
    const leaders: ProblemLeader[] = [];
    let first: Row | null = null;
    let leader: Row | null = null;
    const keep = () => {
      if (leader)
        leaders.push({
          N: leader.n as number,
          M: leader.m as number,
          P: leader.p as number,
          id: leader.id as number,
          name: leader.name as string,
          score: leader.score as number,
          verification: leader.verification as ProblemLeader["verification"],
        });
    };
    for (const r of rows) {
      if (!first || r.n !== first.n || r.m !== first.m || r.p !== first.p) {
        keep();
        first = leader = r;
      } else if (
        (r.score as number) <= (first.score as number) * (1 + SCORE_TIE) &&
        (r.id as number) < (leader!.id as number)
      )
        leader = r;
    }
    keep();
    return leaders;
  }

  async pending(): Promise<StoredSubmission[]> {
    const rows = this.db.prepare("SELECT * FROM submissions WHERE verification = 'pending' ORDER BY id DESC").all();
    return (rows as Row[]).map(toStored);
  }

  async review(id: number, decision: "confirmed" | "rejected"): Promise<boolean> {
    // A rejected entry is deleted (nothing reads it, and it is never listed again). A confirmed
    // leader is no longer pending, so the prune that follows deletes the entry kept behind it.
    const change =
      decision === "rejected" ? "DELETE FROM submissions" : "UPDATE submissions SET verification = 'confirmed'";
    const r = this.db
      .prepare(`${change} WHERE id = ? AND verification IN ('pending', 'confirmed') RETURNING n, m, p`)
      .get(id) as Row | undefined;
    if (r) this.pruneSync(r.n as number, r.m as number, r.p as number);
    return !!r;
  }

  async edit(id: number, changes: EntryEdit): Promise<boolean> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (changes.name !== undefined) set("name", changes.name);
    if (changes.agent_note !== undefined) set("agent_note", changes.agent_note);
    const p = changes.provenance;
    if (p) {
      set("found_with", p.found_with);
      set("method", p.method);
      set("method_params", p.method_params ? JSON.stringify(p.method_params) : null);
      set("seed", p.seed);
      set("budget", p.budget ? JSON.stringify(p.budget) : null);
      set("software", p.software);
    }
    if (!sets.length) {
      const s = await this.get(id);
      return !!s && s.verification !== "rejected";
    }
    const r = this.db
      .prepare(`UPDATE submissions SET ${sets.join(", ")} WHERE id = ? AND ${LISTED}`)
      .run(...values, id);
    return Number(r.changes) > 0;
  }

  async remove(id: number): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM submissions WHERE id = ? AND ${LISTED} RETURNING n, m, p`).get(id) as
      Row | undefined;
    // Without a pending leader, the problem now has no entry. Removing a pending leader leaves the
    // entry kept behind it as the leader; the prune applies the rule to what remains.
    if (r) this.pruneSync(r.n as number, r.m as number, r.p as number);
    return !!r;
  }

  async spaceSubmit(e: NewSpaceEntry): Promise<SpaceSubmitted> {
    // one transaction, as `submit`; every call in it is synchronous
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.spaceLeaderSync(e.space, e.problem);
      const r = this.db
        .prepare(
          `INSERT INTO space_entries (space, problem, score, name, agent_note, software, method, seed, created_at, config)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(e.space, e.problem, e.score, e.name, e.agent_note, e.software, e.method, e.seed, e.created_at, e.config);
      const id = Number(r.lastInsertRowid);
      const leader = this.spaceLeaderSync(e.space, e.problem);
      const kept = !this.spacePruneSync(e.space, e.problem).includes(id);
      this.db.exec("COMMIT");
      return { id, before, leader, kept };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async spaceGet(id: number): Promise<StoredSpaceEntry | null> {
    const r = this.db.prepare("SELECT * FROM space_entries WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: r.id as number,
      space: r.space as string,
      problem: r.problem as string,
      score: r.score as number,
      name: r.name as string,
      agent_note: r.agent_note as string,
      software: (r.software ?? null) as string | null,
      method: (r.method ?? null) as string | null,
      seed: (r.seed ?? null) as number | null,
      config: r.config as string,
      created_at: r.created_at as string,
    };
  }

  async spaceLeader(space: string, problem: string): Promise<SpaceLeader | null> {
    return this.spaceLeaderSync(space, problem);
  }

  /** The earliest entry within the tie tolerance of the problem's smallest score (the rule of `leader`). */
  private spaceLeaderSync(space: string, problem: string): SpaceLeader | null {
    const r = this.db
      .prepare(
        `SELECT ${SPACE_LEADER_COLUMNS} FROM space_entries WHERE space = ? AND problem = ?
           AND score <= (SELECT MIN(score) FROM space_entries WHERE space = ? AND problem = ?) * (1 + ?)
         ORDER BY id ASC LIMIT 1`,
      )
      .get(space, problem, space, problem, SCORE_TIE);
    return (r as unknown as SpaceLeader | undefined) ?? null;
  }

  /** Deletes every entry of a problem but its leader; returns the ids deleted. */
  private spacePruneSync(space: string, problem: string): number[] {
    const leader = this.spaceLeaderSync(space, problem);
    const rows = this.db
      .prepare("SELECT id FROM space_entries WHERE space = ? AND problem = ? ORDER BY score, id")
      .all(space, problem) as Row[];
    const doomed = rows.map((r) => r.id as number).filter((id) => id !== leader?.id);
    const drop = this.db.prepare("DELETE FROM space_entries WHERE id = ?");
    for (const id of doomed) drop.run(id);
    return doomed;
  }

  /** The leaders of the rows read in (space, problem, score, id) order: per problem the earliest within the tie tolerance of its first. */
  private spaceLeadersFromRows(rows: Row[]): SpaceLeader[] {
    const out: SpaceLeader[] = [];
    let first: Row | null = null;
    let leader: Row | null = null;
    const keep = () => {
      if (leader)
        out.push({
          id: leader.id as number,
          space: leader.space as string,
          problem: leader.problem as string,
          score: leader.score as number,
          name: leader.name as string,
          created_at: leader.created_at as string,
        });
    };
    for (const r of rows) {
      if (!first || r.space !== first.space || r.problem !== first.problem) {
        keep();
        first = leader = r;
      } else if (
        (r.score as number) <= (first.score as number) * (1 + SCORE_TIE) &&
        (r.id as number) < (leader!.id as number)
      )
        leader = r;
    }
    keep();
    return out;
  }

  async spaceBest(space: string): Promise<SpaceLeader[]> {
    const rows = this.db
      .prepare(`SELECT ${SPACE_LEADER_COLUMNS} FROM space_entries WHERE space = ? ORDER BY space, problem, score, id`)
      .all(space) as Row[];
    return this.spaceLeadersFromRows(rows);
  }

  async spaceLeadersOf(problems: readonly { space: string; problem: string }[]): Promise<SpaceLeader[]> {
    if (!problems.length) return [];
    if (problems.length > GET_MANY_LIMIT) throw new RangeError(`at most ${GET_MANY_LIMIT} problems per call`);
    // row values against the listing index: one lookup per problem, which keeps one row (two at most)
    const rows = this.db
      .prepare(
        `SELECT ${SPACE_LEADER_COLUMNS} FROM space_entries
         WHERE (space, problem) IN (VALUES ${problems.map(() => "(?, ?)").join(", ")})
         ORDER BY space, problem, score, id`,
      )
      .all(...problems.flatMap((p) => [p.space, p.problem])) as Row[];
    return this.spaceLeadersFromRows(rows);
  }

  async spaceLeaders(): Promise<SpaceLeader[]> {
    const rows = this.db
      .prepare(`SELECT ${SPACE_LEADER_COLUMNS} FROM space_entries ORDER BY space, problem, score, id`)
      .all() as Row[];
    return this.spaceLeadersFromRows(rows);
  }

  async spaceRemove(id: number): Promise<{ space: string; problem: string } | null> {
    const r = this.db.prepare("DELETE FROM space_entries WHERE id = ? RETURNING space, problem").get(id) as
      Row | undefined;
    if (!r) return null;
    // only the leader is ever kept, so the problem is normally left without an entry; the prune
    // applies the rule to whatever remains
    this.spacePruneSync(r.space as string, r.problem as string);
    return { space: r.space as string, problem: r.problem as string };
  }

  async spaceEdit(id: number, changes: SpaceEntryEdit): Promise<{ space: string; problem: string } | null> {
    const sets: string[] = [];
    const values: string[] = [];
    if (changes.name !== undefined) {
      sets.push("name = ?");
      values.push(changes.name);
    }
    if (changes.agent_note !== undefined) {
      sets.push("agent_note = ?");
      values.push(changes.agent_note);
    }
    const r = sets.length
      ? (this.db
          .prepare(`UPDATE space_entries SET ${sets.join(", ")} WHERE id = ? RETURNING space, problem`)
          .get(...values, id) as Row | undefined)
      : (this.db.prepare("SELECT space, problem FROM space_entries WHERE id = ?").get(id) as Row | undefined);
    return r ? { space: r.space as string, problem: r.problem as string } : null;
  }

  private getMeta(key: string): number | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return r ? (r.value as number) : null;
  }

  private setMeta(key: string, value: number): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Whether every row has been through the pieces migration (always true for a new database). */
  piecesMigrated(): boolean {
    return this.getMeta(MIGRATED) === 1;
  }

  /**
   * One step of the pieces migration, in one transaction: the next `batch` rows by id after the
   * stored cursor. The problem of each row is pruned as a whole (see KEEP_PER_PROBLEM), which
   * deletes the rows it no longer keeps, rejected rows included, also those further on; the JSON
   * text of each kept row in the step becomes a BLOB. The cursor is saved with the changes, so a
   * step cut short by a restart is simply done again, and nothing before the cursor is read again.
   * Rows written after the cursor passed are BLOBs already, and `prune`, `review` and `remove`
   * keep their problems to the rule.
   */
  migratePieces(batch: number): MigrationStep {
    // an empty step would look like the end of the table
    if (!Number.isInteger(batch) || batch < 1)
      throw new RangeError(`a migration step needs at least one row, not ${batch}`);
    const step: MigrationStep = {
      done: false,
      cursor: this.getMeta(CURSOR) ?? 0,
      rows: 0,
      converted: 0,
      deleted: 0,
      unreadable: 0,
      bytesBefore: 0,
      bytesAfter: 0,
    };
    // n, m and p come before pieces in the row, and typeof() and octet_length() are answered from
    // its header, so this reads no pieces (and no overflow pages)
    const rows = this.db
      .prepare(
        `SELECT id, n, m, p, typeof(pieces) AS kind, octet_length(pieces) AS bytes FROM submissions
         WHERE id > ? ORDER BY id LIMIT ?`,
      )
      .all(step.cursor, batch) as Row[];
    if (!rows.length) {
      this.setMeta(MIGRATED, 1);
      return { ...step, done: true };
    }
    const read = this.db.prepare("SELECT pieces FROM submissions WHERE id = ?");
    const write = this.db.prepare("UPDATE submissions SET pieces = ? WHERE id = ?");
    const pruned = new Set<string>();
    const gone = new Set<number>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) {
        const id = r.id as number;
        step.rows++;
        step.cursor = id;
        const problem = `${r.n}/${r.m}/${r.p}`;
        if (!pruned.has(problem)) {
          pruned.add(problem);
          for (const d of this.pruneSync(r.n as number, r.m as number, r.p as number)) gone.add(d);
        }
        if (gone.has(id) || r.kind !== "text") continue; // deleted, or a BLOB already
        const blob = blobFromJson((read.get(id) as Row).pieces as string);
        if (!blob) {
          step.unreadable++;
          continue;
        }
        write.run(blob, id);
        step.converted++;
        step.bytesBefore += r.bytes as number;
        step.bytesAfter += blob.length;
      }
      step.deleted = gone.size;
      this.setMeta(CURSOR, step.cursor);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return step;
  }

  /**
   * Runs the pieces migration in the background, one step of `batch` rows every `pauseMs`, until
   * it is complete. Each step blocks the process for its own few milliseconds only. A step that
   * fails (for example while an operator holds the database) is tried again after a minute; after
   * five failures in a row the migration stops until the next start. Does nothing when the
   * migration is complete or `batch` is 0.
   */
  startPiecesMigration(opts: MigrationOptions): { stop: () => void; finished: Promise<void> } {
    const { batch, pauseMs, log } = opts;
    const logEveryMs = opts.logEveryMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => (resolveFinished = resolve));
    if (batch <= 0 || this.piecesMigrated()) {
      resolveFinished();
      return { stop: () => {}, finished };
    }
    const lastId = () => ((this.db.prepare("SELECT MAX(id) AS id FROM submissions").get() as Row).id as number) ?? 0;
    const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
    const total = { rows: 0, converted: 0, deleted: 0, unreadable: 0, bytesBefore: 0, bytesAfter: 0, ms: 0 };
    let failures = 0;
    let lastLog = Date.now();
    log(
      `[pieces] migration starting after row ${this.getMeta(CURSOR) ?? 0} of ${lastId()}: ` +
        `${batch} rows every ${pauseMs} ms`,
    );
    const summary = () =>
      `${total.converted} converted (${mb(total.bytesBefore)} of JSON to ${mb(total.bytesAfter)}), ` +
      `${total.deleted} deleted, ${total.unreadable} left as text; ${total.rows} rows in ${(total.ms / 1000).toFixed(1)} s of work`;
    const finish = () => {
      stopped = true;
      resolveFinished();
    };
    const tick = () => {
      timer = undefined;
      if (stopped) return;
      let step: MigrationStep;
      const started = performance.now();
      try {
        step = this.migratePieces(batch);
        failures = 0;
      } catch (e) {
        failures++;
        log(`[pieces] migration step failed (${failures} in a row): ${e instanceof Error ? e.message : String(e)}`);
        if (failures >= 5) {
          log("[pieces] migration stopped; it resumes at the next start");
          return finish();
        }
        timer = setTimeout(tick, Math.max(pauseMs, 60_000));
        timer.unref?.();
        return;
      }
      total.ms += performance.now() - started;
      for (const k of ["rows", "converted", "deleted", "unreadable", "bytesBefore", "bytesAfter"] as const)
        total[k] += step[k];
      if (step.done) {
        const pragma = (name: string) => Object.values(this.db.prepare(`PRAGMA ${name}`).get() as Row)[0] as number;
        const free = pragma("freelist_count") * pragma("page_size");
        log(
          `[pieces] migration complete: ${summary()}. ${mb(free)} of the file is free for reuse; ` +
            "docs/DEPLOY_FLY.md says how to give it back to the disk",
        );
        return finish();
      }
      if (Date.now() - lastLog >= logEveryMs) {
        lastLog = Date.now();
        log(`[pieces] migration at row ${step.cursor} of ${lastId()}: ${summary()}`);
      }
      timer = setTimeout(tick, pauseMs);
      timer.unref?.();
    };
    timer = setTimeout(tick, pauseMs);
    timer.unref?.();
    return {
      stop: () => {
        if (timer) clearTimeout(timer);
        finish();
      },
      finished,
    };
  }
}
