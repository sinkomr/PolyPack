//! apps/server/src/sqlite-store.ts: the SQLite store.
//!
//! The Rust server opens the database file of the TypeScript server in place, and a rollback to
//! the TypeScript server must stay possible. So the schema below is the source's text byte for
//! byte (SQLite keeps the text of each CREATE statement in the file), every statement is the
//! source's, and every value is bound and read as node:sqlite binds and reads it (see db.rs).
//!
//! The source's methods are `async` only so that the routes could run on a hosted SQL service; on
//! SQLite every one of them is synchronous, and so they are here. The store owns one connection
//! and is `Send`: the HTTP layer keeps it behind a mutex.

use serde_json::Value;

use super::db::{is_integer, Db, JsVal, Param, Row, Tracer};
use super::error::{Result, StoreError};
use super::json;
use super::pieces::{blob_from_json, encode_pieces, read_pieces};
use super::types::*;
use super::units_migration::{
    json_source, migrate_units, set_units_epoch, units_epoch, SpaceIds, UnitsReport, EPOCH_DIAMETER,
};
use super::Clock;
use polypack_js::fmt;

// `pieces` is declared TEXT NOT NULL, as it was created; new rows store a BLOB in it (see
// pieces.rs), which SQLite keeps unchanged in a TEXT column, so the table needs no rebuild.
const SCHEMA: &str = "
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
";

/// Every column that finding leaders, pruning, ranking and listing read, so that those queries are
/// answered from the index alone. In the table, verification and the columns added later come
/// after pieces (up to tens of kilobytes); a query that reads them from the table walks every
/// row's pieces, which turned each listing into gigabytes of disk reads once the database
/// outgrew memory. It replaces the narrower index on (n, m, p, score, id).
const LISTING_INDEX: &str = "
CREATE INDEX IF NOT EXISTS submissions_listing
  ON submissions (n, m, p, score, id, verification, name, found_with, agent_note, created_at);
DROP INDEX IF EXISTS submissions_problem;
";

/// The problems a name has an entry in (see `problems_named`), read in order of (n, m, p) from the
/// index alone. `verification` is its last column so that the filter on listed entries needs no row
/// of the table (see LISTING_INDEX). Building it on a large database takes a while, once, when the
/// server starts.
const NAME_INDEX: &str = "
CREATE INDEX IF NOT EXISTS submissions_name ON submissions (name, n, m, p, verification);
";

// Running count of accepted submissions per problem; the rows themselves are pruned.
const TALLIES: &str = "
CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
  PRIMARY KEY (n, m, p));
INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions WHERE verification != 'rejected' GROUP BY n, m, p;
";

/// Columns added after the first deployment, with their types. A database created before them gets
/// them by ALTER TABLE on open; its existing rows read back NULL ("not recorded").
const ADDED_COLUMNS: [(&str, &str); 6] = [
    ("found_with", "TEXT"),
    ("method", "TEXT"),
    ("method_params", "TEXT"),
    ("seed", "INTEGER"),
    ("budget", "TEXT"),
    ("software", "TEXT"),
];

/// Site entries of the spaces (see the `space_*` methods), in a table of their own that leaves the
/// polygon tables alone; created when missing, so an older database simply gains it. `config` (the
/// configuration as JSON text, up to tens of kilobytes) comes last and the index holds every column
/// that leaders and listings read, so those never walk the configurations.
const SPACES_SCHEMA: &str = "
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
";

/// Small settings of the store itself; for now the progress of the pieces migration.
const META: &str = "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);";
/// Id of the last row the pieces migration has handled.
const CURSOR: &str = "pieces_cursor";
/// 1 once the pieces migration has reached the last row.
const MIGRATED: &str = "pieces_migrated";

/// The most records each name has held at once (see `holder_peaks`); a name that never held one has no row.
const HOLDER_PEAKS: &str = "CREATE TABLE IF NOT EXISTS holder_peaks (name TEXT PRIMARY KEY, peak INTEGER NOT NULL);";

/// `(n, m, p)` before every problem: shape codes are 0 or more and P is 1 or more.
const BEFORE_ALL: ProblemKey = ProblemKey { n: -1.0, m: -1.0, p: -1.0 };

/// `value ? JSON.parse(value) : null` of a stored JSON column.
fn parsed_or_null(v: &JsVal) -> Result<Value> {
    match json_source(v) {
        Some(text) => json::parse(&text),
        None => Ok(Value::Null),
    }
}

/// `value ? JSON.stringify(value) : null` of a JSON value to store.
fn text_or_null(v: &Option<Value>) -> Option<String> {
    v.as_ref().filter(|v| json::truthy(v)).map(json::stringify)
}

/// sqlite-store.ts: toStored.
fn to_stored(r: &Row) -> Result<StoredSubmission> {
    Ok(StoredSubmission {
        id: r.num("id")?,
        n: r.num("n")?,
        m: r.num("m")?,
        p: r.num("p")?,
        score: r.num("score")?,
        name: r.text("name")?,
        agent_note: r.text("agent_note")?,
        pieces: read_pieces(r.get("pieces"))?,
        container_phi: r.num("container_phi")?,
        created_at: r.text("created_at")?,
        verification: r.text("verification")?,
        literature_value: r.num_or_null("literature_value")?,
        strict_check: parsed_or_null(r.get("strict_check"))?,
        found_with: r.text_or_null("found_with")?,
        method: r.text_or_null("method")?,
        method_params: parsed_or_null(r.get("method_params"))?,
        seed: r.num_or_null("seed")?,
        budget: parsed_or_null(r.get("budget"))?,
        software: r.text_or_null("software")?,
    })
}

/// A row of ENTRY_COLUMNS.
fn to_entry(r: &Row) -> Result<LeaderboardEntry> {
    Ok(LeaderboardEntry {
        id: r.num("id")?,
        name: r.text("name")?,
        found_with: r.text_or_null("found_with")?,
        agent_note: r.text("agent_note")?,
        score: r.num("score")?,
        created_at: r.text("created_at")?,
        verification: r.text("verification")?,
    })
}

/// A row of SPACE_LEADER_COLUMNS.
fn to_space_leader(r: &Row) -> Result<SpaceLeader> {
    Ok(SpaceLeader {
        id: r.num("id")?,
        space: r.text("space")?,
        problem: r.text("problem")?,
        score: r.num("score")?,
        name: r.text("name")?,
        created_at: r.text("created_at")?,
    })
}

/// How the store is opened: the `opts` of the source's constructor.
pub struct OpenOptions<'a> {
    /// `opts.units`: true ("migrate", the default) converts a database in the old units (radius-1
    /// disks and balls) to diameter units in one transaction before `open` returns, and records it
    /// in meta.units_epoch so that it runs once; false ("leave") opens it as it is (the dry-run and
    /// rollback tools).
    pub migrate_units: bool,
    /// `opts.log`.
    pub log: Option<&'a mut dyn FnMut(&str)>,
    /// What the unit conversion reads of the spaces' problem ids (packages/spaces).
    pub spaces: &'a dyn SpaceIds,
    /// `performance.now()` and `Date.now()`; the system's unless a test fixes them.
    pub clock: Box<dyn Clock>,
    /// Watches every statement, those of opening included (see db.rs); None in the server.
    pub tracer: Option<Tracer>,
}

impl<'a> OpenOptions<'a> {
    /// The defaults of the source: convert the units, no log, the system's clock.
    pub fn new(spaces: &'a dyn SpaceIds) -> Self {
        OpenOptions { migrate_units: true, log: None, spaces, clock: Box::new(super::SystemClock::new()), tracer: None }
    }
}

/// SQLite store on rusqlite's bundled SQLite. Pass ":memory:" for tests.
pub struct SqliteStore {
    pub(crate) db: Db,
    /// What the start-up unit conversion did (see units_migration.rs); None when the database was
    /// already converted.
    pub units_report: Option<UnitsReport>,
    pub(crate) clock: Box<dyn Clock>,
}

impl SqliteStore {
    /// The source's constructor: opens (or creates) the database and brings an older one up to the
    /// current schema in place.
    pub fn open(path: &str, opts: OpenOptions<'_>) -> Result<SqliteStore> {
        let db = Db::open(path)?;
        db.set_tracer(opts.tracer);
        let mut store = SqliteStore { db, units_report: None, clock: opts.clock };
        let db = &store.db;
        db.exec("PRAGMA journal_mode = WAL;")?;
        let fresh =
            db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submissions'")?.get(&[])?.is_none();
        db.exec(SCHEMA)?;
        db.exec(META)?;
        db.exec(HOLDER_PEAKS)?;
        // a new database never holds pieces in the older format, so there is nothing to migrate
        if fresh {
            store.set_meta(MIGRATED, 1.0)?;
        }
        // A database from before a column existed: add it. The legacy `agent` column stays as it was
        // (SQLite cannot drop its NOT NULL), and new rows store an empty string in it.
        let present: Vec<String> = db
            .prepare("PRAGMA table_info(submissions)")?
            .all(&[])?
            .iter()
            .map(|c| c.text("name"))
            .collect::<Result<_>>()?;
        for (name, kind) in ADDED_COLUMNS {
            if !present.iter().any(|c| c == name) {
                db.exec(&format!("ALTER TABLE submissions ADD COLUMN {name} {kind}"))?;
            }
        }
        // after the added columns, which it covers; building it on a large database takes a while, once
        db.exec(LISTING_INDEX)?;
        db.exec(NAME_INDEX)?;
        // A database from before pruning: start the tallies from what it holds, then prune it.
        if db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tallies'")?.get(&[])?.is_none() {
            db.exec(TALLIES)?;
            let crowded = db
                .prepare("SELECT n, m, p FROM submissions WHERE verification != 'rejected' GROUP BY n, m, p HAVING COUNT(*) > ?")?
                .all(&[KEEP_PER_PROBLEM.into()])?;
            for r in &crowded {
                store.prune_sync(r.num("n")?, r.num("m")?, r.num("p")?)?;
            }
        }
        db.exec(SPACES_SCHEMA)?;
        // a new database holds nothing in the old units
        if fresh {
            set_units_epoch(db, EPOCH_DIAMETER)?;
        } else if opts.migrate_units && units_epoch(db)? < EPOCH_DIAMETER {
            let report = migrate_units(db, false, opts.spaces, store.clock.as_ref())?;
            if let Some(log) = opts.log {
                log(&format!(
                    "units: converted to diameter units in {} ms: {}",
                    fmt::fixed(report.ms, 0),
                    polypack_js::json::stringify(&report)
                ));
            }
            store.units_report = Some(report);
        }
        Ok(store)
    }

    /// The connection, as the source's tests and tools reach `store.db`.
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// units-migration.ts: migrateUnits on the store's connection, timed by the store's clock: the
    /// conversion (`reverse` false) or its exact reverse, in one transaction.
    pub fn migrate_units(&self, reverse: bool, spaces: &dyn SpaceIds) -> Result<UnitsReport> {
        migrate_units(&self.db, reverse, spaces, self.clock.as_ref())
    }

    /// units-migration.ts: unitsEpoch of the store's database.
    pub fn units_epoch(&self) -> Result<f64> {
        units_epoch(&self.db)
    }

    /// Store.submit. A new entry, as one transaction: reads the leader, inserts the entry and
    /// counts it, reads the leader and the entry's rank again, and prunes the problem (see `prune`).
    pub fn submit(&self, s: &NewSubmission) -> Result<Submitted> {
        // One transaction, so one commit (one sync of the log) per submission instead of three.
        self.db.exec("BEGIN IMMEDIATE")?;
        let run = || -> Result<Submitted> {
            let before = self.leader_sync(s.n, s.m, s.p, false)?;
            let id = self.insert_sync(s)?;
            let leader = self.leader_sync(s.n, s.m, s.p, false)?;
            let position = self.rank_sync(s.n, s.m, s.p, id)?;
            let kept = !self.prune_sync(s.n, s.m, s.p)?.contains(&id);
            self.db.exec("COMMIT")?;
            Ok(Submitted { id, before, leader, position, kept })
        };
        match run() {
            Ok(done) => Ok(done),
            Err(e) => {
                self.db.exec("ROLLBACK")?;
                Err(e)
            }
        }
    }

    /// Store.insert.
    pub fn insert(&self, s: &NewSubmission) -> Result<f64> {
        self.insert_sync(s)
    }

    fn insert_sync(&self, s: &NewSubmission) -> Result<f64> {
        // a BLOB of Float64s keeps every double exactly, -0 included, in a third of the JSON
        let pieces = encode_pieces(&s.pieces);
        let strict_check = text_or_null(&s.strict_check);
        let method_params = text_or_null(&s.method_params);
        let budget = text_or_null(&s.budget);
        let r = self
            .db
            .prepare(
                "INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at,
           verification, literature_value, strict_check, found_with, method, method_params, seed, budget, software)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )?
            .run(&[
                s.n.into(),
                s.m.into(),
                s.p.into(),
                s.score.into(),
                (&s.name).into(),
                (&s.agent_note).into(),
                (&pieces).into(),
                s.container_phi.into(),
                (&s.created_at).into(),
                (&s.verification).into(),
                s.literature_value.into(),
                (&strict_check).into(),
                (&s.found_with).into(),
                (&s.method).into(),
                (&method_params).into(),
                s.seed.into(),
                (&budget).into(),
                (&s.software).into(),
            ])?;
        self.db
            .prepare(
                "INSERT INTO tallies (n, m, p, accepted) VALUES (?, ?, ?, 1)
         ON CONFLICT (n, m, p) DO UPDATE SET accepted = accepted + 1",
            )?
            .run(&[s.n.into(), s.m.into(), s.p.into()])?;
        Ok(r.last_insert_rowid)
    }

    /// Store.get.
    pub fn get(&self, id: f64) -> Result<Option<StoredSubmission>> {
        let r = self.db.prepare("SELECT * FROM submissions WHERE id = ?")?.get(&[id.into()])?;
        r.as_ref().map(to_stored).transpose()
    }

    /// Store.getMany. Stored submissions for the given ids, in no particular order. Rejected and
    /// unknown ids are left out. At most GET_MANY_LIMIT ids; asking for more is a programming error.
    pub fn get_many(&self, ids: &[f64]) -> Result<Vec<StoredSubmission>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        if ids.len() > GET_MANY_LIMIT {
            return Err(StoreError::Range(format!(
                "getMany accepts at most {GET_MANY_LIMIT} ids, got {}",
                ids.len()
            )));
        }
        let marks = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!("SELECT * FROM submissions WHERE id IN ({marks}) AND verification != 'rejected'");
        let rows = self.db.prepare(&sql)?.all(&ids.iter().map(|&id| Param::Num(id)).collect::<Vec<_>>())?;
        rows.iter().map(to_stored).collect()
    }

    /// Store.leader. The leader of one problem, or None when it has no listed entry.
    pub fn leader(&self, n: f64, m: f64, p: f64) -> Result<Option<LeaderboardEntry>> {
        self.leader_sync(n, m, p, false)
    }

    /// The leader of one problem; with `reviewed_only`, the leader among the entries that are not
    /// pending (as `best_per_p` with `verified_only`).
    fn leader_sync(&self, n: f64, m: f64, p: f64, reviewed_only: bool) -> Result<Option<LeaderboardEntry>> {
        // earliest entry within the tie tolerance of the smallest score, not simply the smallest
        let sql = if reviewed_only {
            "SELECT id, name, found_with, agent_note, score, created_at, verification FROM submissions WHERE n = ? AND m = ? AND p = ? AND verification != 'rejected' AND verification != 'pending'
           AND score <= (SELECT MIN(score) FROM submissions WHERE n = ? AND m = ? AND p = ? AND verification != 'rejected' AND verification != 'pending') * (1 + ?)
         ORDER BY id ASC LIMIT 1"
        } else {
            "SELECT id, name, found_with, agent_note, score, created_at, verification FROM submissions WHERE n = ? AND m = ? AND p = ? AND verification != 'rejected'
           AND score <= (SELECT MIN(score) FROM submissions WHERE n = ? AND m = ? AND p = ? AND verification != 'rejected') * (1 + ?)
         ORDER BY id ASC LIMIT 1"
        };
        let r = self.db.prepare(sql)?.get(&[n.into(), m.into(), p.into(), n.into(), m.into(), p.into(), SCORE_TIE.into()])?;
        r.as_ref().map(to_entry).transpose()
    }

    /// The entries one problem keeps (see KEEP_PER_PROBLEM): its leader, and while the leader is
    /// pending, the leader among the entries that are not, which is the record the site shows
    /// again if the claim is rejected. Empty when the problem has no listed entry.
    fn keepers_sync(&self, n: f64, m: f64, p: f64) -> Result<Vec<f64>> {
        let mut keep = Vec::new();
        let Some(leader) = self.leader_sync(n, m, p, false)? else {
            return Ok(keep);
        };
        keep.push(leader.id);
        if leader.verification == "pending" {
            if let Some(previous) = self.leader_sync(n, m, p, true)? {
                keep.push(previous.id);
            }
        }
        Ok(keep)
    }

    /// Store.count. Number of valid submissions ever accepted for one problem, including those
    /// since deleted.
    pub fn count(&self, n: f64, m: f64, p: f64) -> Result<f64> {
        let r = self
            .db
            .prepare("SELECT accepted FROM tallies WHERE n = ? AND m = ? AND p = ?")?
            .get(&[n.into(), m.into(), p.into()])?;
        match r {
            Some(r) => Ok(r.num_or_null("accepted")?.unwrap_or(0.0)),
            None => Ok(0.0),
        }
    }

    /// Store.prune. Deletes every entry of one problem except those it keeps (see
    /// KEEP_PER_PROBLEM): the leader, and while the leader is pending, the leader among the entries
    /// that are not. Rejected rows of the problem left by older versions go too. Returns the ids
    /// deleted.
    pub fn prune(&self, n: f64, m: f64, p: f64) -> Result<Vec<f64>> {
        self.prune_sync(n, m, p)
    }

    fn prune_sync(&self, n: f64, m: f64, p: f64) -> Result<Vec<f64>> {
        // The leader is not always first by score (see `leader`), so the kept entries are chosen
        // explicitly. All of the problem's other rows go, rejected ones of older versions included:
        // nothing reads those any more. Deleting them all at once keeps the leader from changing
        // because of the order in which they go.
        let keep = self.keepers_sync(n, m, p)?;
        let rows = self
            .db
            .prepare("SELECT id FROM submissions WHERE n = ? AND m = ? AND p = ? ORDER BY score, id")?
            .all(&[n.into(), m.into(), p.into()])?;
        let mut doomed = Vec::new();
        for r in &rows {
            let id = r.num("id")?;
            if !keep.contains(&id) {
                doomed.push(id);
            }
        }
        let mut drop = self.db.prepare("DELETE FROM submissions WHERE id = ?")?;
        for &id in &doomed {
            drop.run(&[id.into()])?;
        }
        Ok(doomed)
    }

    /// Store.rank. 1 + the number of listed entries ahead of submission `id`: those with a smaller
    /// score, or an equal score and a smaller id. Position 1 is not always the leader; see `leader`.
    pub fn rank(&self, n: f64, m: f64, p: f64, id: f64) -> Result<f64> {
        self.rank_sync(n, m, p, id)
    }

    fn rank_sync(&self, n: f64, m: f64, p: f64, id: f64) -> Result<f64> {
        let r = self
            .db
            .prepare(
                "SELECT COUNT(*) AS c FROM submissions s, (SELECT score, id FROM submissions WHERE id = ?) me
         WHERE s.n = ? AND s.m = ? AND s.p = ? AND s.verification != 'rejected'
           AND (s.score < me.score OR (s.score = me.score AND s.id < me.id))",
            )?
            .get(&[id.into(), n.into(), m.into(), p.into()])?
            .expect("COUNT(*) gives one row");
        Ok(r.num("c")? + 1.0)
    }

    /// Store.bestPerP. The leader for every P of one (N, M). With `verified_only`, entries that are
    /// pending verification are left out before the leader is chosen, so the result is the leader
    /// among the reviewed or unremarkable entries.
    pub fn best_per_p(&self, n: f64, m: f64, verified_only: bool) -> Result<Vec<BestOfP>> {
        // the same rule as `leader`, for every P at once: the smallest score per P, then the earliest
        // entry within the tie tolerance of it
        let sql = if verified_only {
            "WITH best AS (SELECT u.p AS bp, MIN(u.score) AS lo FROM submissions u
                       WHERE u.n = ? AND u.m = ? AND u.verification != 'rejected' AND u.verification != 'pending' GROUP BY u.p)
         SELECT s.p AS P, id, name, found_with, agent_note, score, created_at, verification FROM submissions s JOIN best ON best.bp = s.p
         WHERE s.n = ? AND s.m = ?
           AND s.id = (SELECT MIN(t.id) FROM submissions t
                       WHERE t.n = s.n AND t.m = s.m AND t.p = s.p AND t.verification != 'rejected' AND t.verification != 'pending' AND t.score <= best.lo * (1 + ?))
         ORDER BY s.p ASC"
        } else {
            "WITH best AS (SELECT u.p AS bp, MIN(u.score) AS lo FROM submissions u
                       WHERE u.n = ? AND u.m = ? AND u.verification != 'rejected' GROUP BY u.p)
         SELECT s.p AS P, id, name, found_with, agent_note, score, created_at, verification FROM submissions s JOIN best ON best.bp = s.p
         WHERE s.n = ? AND s.m = ?
           AND s.id = (SELECT MIN(t.id) FROM submissions t
                       WHERE t.n = s.n AND t.m = s.m AND t.p = s.p AND t.verification != 'rejected' AND t.score <= best.lo * (1 + ?))
         ORDER BY s.p ASC"
        };
        let rows = self.db.prepare(sql)?.all(&[n.into(), m.into(), n.into(), m.into(), SCORE_TIE.into()])?;
        rows.iter()
            .map(|r| {
                Ok(BestOfP {
                    p: r.num("P")?,
                    id: r.num("id")?,
                    name: r.text("name")?,
                    found_with: r.text_or_null("found_with")?,
                    agent_note: r.text("agent_note")?,
                    score: r.num("score")?,
                    created_at: r.text("created_at")?,
                    verification: r.text("verification")?,
                })
            })
            .collect()
    }

    /// Store.pairs. Every pair of shapes with a listed entry, by N then M.
    pub fn pairs(&self) -> Result<Vec<Pair>> {
        let rows = self
            .db
            .prepare("SELECT DISTINCT n AS N, m AS M FROM submissions WHERE verification != 'rejected' ORDER BY n, m")?
            .all(&[])?;
        rows.iter().map(|r| Ok(Pair { n: r.num("N")?, m: r.num("M")? })).collect()
    }

    /// Store.leaders. The leader of every problem that has a listed entry, by N, then M, then P, in
    /// one read that holds the process for as long as the table is large. The server no longer
    /// calls it (see `leaders_after`); the tests count with it.
    pub fn leaders(&self) -> Result<Vec<ProblemLeader>> {
        // The same rule again, for every problem: one pass over the listing index in its own order,
        // so SQLite sorts nothing, and the rule applied here.
        let rows = self
            .db
            .prepare(
                "SELECT n, m, p, id, name, score, verification FROM submissions WHERE verification != 'rejected'
         ORDER BY n, m, p, score, id",
            )?
            .all(&[])?;
        Self::leaders_from_rows(&rows)
    }

    /// Store.leadersAfter. The leaders (the rule of `leader`) of the next `limit` problems that
    /// have a listed entry after the problem `after` (None: from the first), by N, then M, then P;
    /// fewer than `limit` when the listing ends. Indexed reads whose size is `limit`, not that of
    /// the table, so that a caller can walk every leader in pages and let other work in between.
    pub fn leaders_after(&self, after: Option<ProblemKey>, limit: f64) -> Result<Vec<ProblemLeader>> {
        if !is_integer(limit) || limit < 1.0 {
            return Err(StoreError::Range(format!("limit must be a positive integer, got {}", fmt::num(limit))));
        }
        let from = after.unwrap_or(BEFORE_ALL);
        // the keys of the next `limit` problems, then their rows, so that no problem is cut in the middle;
        // both are ranges of the listing index, which hands them over in the order asked
        let keys = self
            .db
            .prepare(
                "SELECT n, m, p FROM submissions WHERE (n, m, p) > (?, ?, ?) AND verification != 'rejected'
         GROUP BY n, m, p ORDER BY n, m, p LIMIT ?",
            )?
            .all(&[from.n.into(), from.m.into(), from.p.into(), limit.into()])?;
        let Some(last) = keys.last() else {
            return Ok(Vec::new());
        };
        let rows = self
            .db
            .prepare(
                "SELECT n, m, p, id, name, score, verification FROM submissions
         WHERE (n, m, p) > (?, ?, ?) AND (n, m, p) <= (?, ?, ?) AND verification != 'rejected'
         ORDER BY n, m, p, score, id",
            )?
            .all(&[
                from.n.into(),
                from.m.into(),
                from.p.into(),
                last.num("n")?.into(),
                last.num("m")?.into(),
                last.num("p")?.into(),
            ])?;
        Self::leaders_from_rows(&rows)
    }

    /// Store.problemsNamed. The next `limit` problems, after the problem `after` (None: from the
    /// first), by N, then M, then P, in which a listed entry has exactly this name (byte for byte,
    /// so case counts). Not the problems the name leads: an entry may sit behind a better one, so a
    /// caller asks `leaders_of` who leads them. An indexed read whose size is `limit`.
    pub fn problems_named(&self, name: &str, after: Option<ProblemKey>, limit: f64) -> Result<Vec<ProblemKey>> {
        if !is_integer(limit) || limit < 1.0 {
            return Err(StoreError::Range(format!("limit must be a positive integer, got {}", fmt::num(limit))));
        }
        let from = after.unwrap_or(BEFORE_ALL);
        // a range of submissions_name for this name, which hands the problems over in the order asked
        let rows = self
            .db
            .prepare(
                "SELECT n, m, p FROM submissions WHERE name = ? AND (n, m, p) > (?, ?, ?) AND verification != 'rejected'
         GROUP BY n, m, p ORDER BY n, m, p LIMIT ?",
            )?
            .all(&[name.into(), from.n.into(), from.m.into(), from.p.into(), limit.into()])?;
        rows.iter().map(|r| Ok(ProblemKey { n: r.num("n")?, m: r.num("m")?, p: r.num("p")? })).collect()
    }

    /// Store.leadersOf. The leader (the rule of `leader`) of each of the given problems that has a
    /// listed entry, in one indexed read; at most GET_MANY_LIMIT problems. Problems without an
    /// entry are left out.
    pub fn leaders_of(&self, problems: &[ProblemKey]) -> Result<Vec<ProblemLeader>> {
        if problems.is_empty() {
            return Ok(Vec::new());
        }
        if problems.len() > GET_MANY_LIMIT {
            return Err(StoreError::Range(format!("at most {GET_MANY_LIMIT} problems per call")));
        }
        // row values against the listing index: one lookup per problem, which keeps one row (two while a claim is pending)
        let sql = format!(
            "SELECT n, m, p, id, name, score, verification FROM submissions
         WHERE (n, m, p) IN (VALUES {}) AND verification != 'rejected'
         ORDER BY n, m, p, score, id",
            problems.iter().map(|_| "(?, ?, ?)").collect::<Vec<_>>().join(", ")
        );
        let params: Vec<Param<'_>> =
            problems.iter().flat_map(|q| [Param::Num(q.n), Param::Num(q.m), Param::Num(q.p)]).collect();
        let rows = self.db.prepare(&sql)?.all(&params)?;
        Self::leaders_from_rows(&rows)
    }

    /// The leaders of rows read in (n, m, p, score, id) order. The first row of a problem has its
    /// smallest score; the leader is the earliest of the rows within the tie tolerance of it.
    fn leaders_from_rows(rows: &[Row]) -> Result<Vec<ProblemLeader>> {
        struct R<'a> {
            n: f64,
            m: f64,
            p: f64,
            id: f64,
            score: f64,
            row: &'a Row,
        }
        let mut leaders = Vec::new();
        let mut first: Option<R<'_>> = None;
        let mut leader: Option<R<'_>> = None;
        let keep = |leader: &Option<R<'_>>, leaders: &mut Vec<ProblemLeader>| -> Result<()> {
            if let Some(l) = leader {
                leaders.push(ProblemLeader {
                    n: l.n,
                    m: l.m,
                    p: l.p,
                    id: l.id,
                    name: l.row.text("name")?,
                    score: l.score,
                    verification: l.row.text("verification")?,
                });
            }
            Ok(())
        };
        for row in rows {
            let r = || -> Result<R<'_>> {
                Ok(R { n: row.num("n")?, m: row.num("m")?, p: row.num("p")?, id: row.num("id")?, score: row.num("score")?, row })
            };
            let r = r()?;
            match &first {
                Some(f) if r.n == f.n && r.m == f.m && r.p == f.p => {
                    if r.score <= f.score * (1.0 + SCORE_TIE) && r.id < leader.as_ref().expect("a leader").id {
                        leader = Some(r);
                    }
                }
                _ => {
                    keep(&leader, &mut leaders)?;
                    first = Some(R { n: r.n, m: r.m, p: r.p, id: r.id, score: r.score, row });
                    leader = Some(r);
                }
            }
        }
        keep(&leader, &mut leaders)?;
        Ok(leaders)
    }

    /// Store.pending.
    pub fn pending(&self) -> Result<Vec<StoredSubmission>> {
        let rows =
            self.db.prepare("SELECT * FROM submissions WHERE verification = 'pending' ORDER BY id DESC")?.all(&[])?;
        rows.iter().map(to_stored).collect()
    }

    /// Store.review. Decides on an entry that is pending or was confirmed, then prunes its problem.
    /// A rejected entry is deleted, so the entry kept behind a pending claim leads again; a
    /// confirmed one is kept alone. False when there is no such entry.
    pub fn review(&self, id: f64, decision: Decision) -> Result<bool> {
        // A rejected entry is deleted (nothing reads it, and it is never listed again). A confirmed
        // leader is no longer pending, so the prune that follows deletes the entry kept behind it.
        let sql = match decision {
            Decision::Rejected => {
                "DELETE FROM submissions WHERE id = ? AND verification IN ('pending', 'confirmed') RETURNING n, m, p"
            }
            Decision::Confirmed => {
                "UPDATE submissions SET verification = 'confirmed' WHERE id = ? AND verification IN ('pending', 'confirmed') RETURNING n, m, p"
            }
        };
        let r = self.db.prepare(sql)?.get(&[id.into()])?;
        if let Some(r) = &r {
            self.prune_sync(r.num("n")?, r.num("m")?, r.num("p")?)?;
        }
        Ok(r.is_some())
    }

    /// Store.edit. Corrects the name, note or provenance of a listed entry (a renamed bot, a
    /// provenance recorded in the note by an older client). Fields left None are kept. False when
    /// there is no such entry.
    pub fn edit(&self, id: f64, changes: &EntryEdit) -> Result<bool> {
        let mut sets: Vec<&str> = Vec::new();
        let mut values: Vec<Param<'_>> = Vec::new();
        if let Some(name) = &changes.name {
            sets.push("name = ?");
            values.push(name.into());
        }
        if let Some(note) = &changes.agent_note {
            sets.push("agent_note = ?");
            values.push(note.into());
        }
        let (method_params, budget);
        if let Some(p) = &changes.provenance {
            method_params = text_or_null(&p.method_params);
            budget = text_or_null(&p.budget);
            sets.push("found_with = ?");
            values.push((&p.found_with).into());
            sets.push("method = ?");
            values.push((&p.method).into());
            sets.push("method_params = ?");
            values.push((&method_params).into());
            sets.push("seed = ?");
            values.push(p.seed.into());
            sets.push("budget = ?");
            values.push((&budget).into());
            sets.push("software = ?");
            values.push((&p.software).into());
        }
        if sets.is_empty() {
            let s = self.get(id)?;
            return Ok(s.is_some_and(|s| s.verification != "rejected"));
        }
        values.push(id.into());
        let sql = format!("UPDATE submissions SET {} WHERE id = ? AND verification != 'rejected'", sets.join(", "));
        let r = self.db.prepare(&sql)?.run(&values)?;
        Ok(r.changes > 0.0)
    }

    /// Store.remove. Takes any listed entry off the site (an abusive name, a test entry): the row
    /// is deleted, and the problem is pruned again. False when there is no such listed entry.
    pub fn remove(&self, id: f64) -> Result<bool> {
        let r = self
            .db
            .prepare("DELETE FROM submissions WHERE id = ? AND verification != 'rejected' RETURNING n, m, p")?
            .get(&[id.into()])?;
        // Without a pending leader, the problem now has no entry. Removing a pending leader leaves the
        // entry kept behind it as the leader; the prune applies the rule to what remains.
        if let Some(r) = &r {
            self.prune_sync(r.num("n")?, r.num("m")?, r.num("p")?)?;
        }
        Ok(r.is_some())
    }

    /// SpaceStore.spaceSubmit. A new entry, as one transaction: reads the leader, inserts, reads
    /// the leader again and prunes the problem to it.
    pub fn space_submit(&self, e: &NewSpaceEntry) -> Result<SpaceSubmitted> {
        // one transaction, as `submit`
        self.db.exec("BEGIN IMMEDIATE")?;
        let run = || -> Result<SpaceSubmitted> {
            let before = self.space_leader_sync(&e.space, &e.problem)?;
            let r = self
                .db
                .prepare(
                    "INSERT INTO space_entries (space, problem, score, name, agent_note, software, method, seed, created_at, config)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )?
                .run(&[
                    (&e.space).into(),
                    (&e.problem).into(),
                    e.score.into(),
                    (&e.name).into(),
                    (&e.agent_note).into(),
                    (&e.software).into(),
                    (&e.method).into(),
                    e.seed.into(),
                    (&e.created_at).into(),
                    (&e.config).into(),
                ])?;
            let id = r.last_insert_rowid;
            let leader = self.space_leader_sync(&e.space, &e.problem)?;
            let kept = !self.space_prune_sync(&e.space, &e.problem)?.contains(&id);
            self.db.exec("COMMIT")?;
            Ok(SpaceSubmitted { id, before, leader, kept })
        };
        match run() {
            Ok(done) => Ok(done),
            Err(err) => {
                self.db.exec("ROLLBACK")?;
                Err(err)
            }
        }
    }

    /// SpaceStore.spaceGet.
    pub fn space_get(&self, id: f64) -> Result<Option<StoredSpaceEntry>> {
        let Some(r) = self.db.prepare("SELECT * FROM space_entries WHERE id = ?")?.get(&[id.into()])? else {
            return Ok(None);
        };
        Ok(Some(StoredSpaceEntry {
            id: r.num("id")?,
            space: r.text("space")?,
            problem: r.text("problem")?,
            score: r.num("score")?,
            name: r.text("name")?,
            agent_note: r.text("agent_note")?,
            software: r.text_or_null("software")?,
            method: r.text_or_null("method")?,
            seed: r.num_or_null("seed")?,
            config: r.text("config")?,
            created_at: r.text("created_at")?,
        }))
    }

    /// SpaceStore.spaceLeader. The leader of one problem, or None when it has no entry.
    pub fn space_leader(&self, space: &str, problem: &str) -> Result<Option<SpaceLeader>> {
        self.space_leader_sync(space, problem)
    }

    /// The earliest entry within the tie tolerance of the problem's smallest score (the rule of `leader`).
    fn space_leader_sync(&self, space: &str, problem: &str) -> Result<Option<SpaceLeader>> {
        let r = self
            .db
            .prepare(
                "SELECT id, space, problem, score, name, created_at FROM space_entries WHERE space = ? AND problem = ?
           AND score <= (SELECT MIN(score) FROM space_entries WHERE space = ? AND problem = ?) * (1 + ?)
         ORDER BY id ASC LIMIT 1",
            )?
            .get(&[space.into(), problem.into(), space.into(), problem.into(), SCORE_TIE.into()])?;
        r.as_ref().map(to_space_leader).transpose()
    }

    /// Deletes every entry of a problem but its leader; returns the ids deleted.
    fn space_prune_sync(&self, space: &str, problem: &str) -> Result<Vec<f64>> {
        let leader = self.space_leader_sync(space, problem)?;
        let rows = self
            .db
            .prepare("SELECT id FROM space_entries WHERE space = ? AND problem = ? ORDER BY score, id")?
            .all(&[space.into(), problem.into()])?;
        let mut doomed = Vec::new();
        for r in &rows {
            let id = r.num("id")?;
            if !matches!(&leader, Some(l) if l.id == id) {
                doomed.push(id);
            }
        }
        let mut drop = self.db.prepare("DELETE FROM space_entries WHERE id = ?")?;
        for &id in &doomed {
            drop.run(&[id.into()])?;
        }
        Ok(doomed)
    }

    /// The leaders of the rows read in (space, problem, score, id) order: per problem the earliest
    /// within the tie tolerance of its first.
    fn space_leaders_from_rows(rows: &[Row]) -> Result<Vec<SpaceLeader>> {
        let mut out = Vec::new();
        let mut first: Option<SpaceLeader> = None;
        let mut leader: Option<SpaceLeader> = None;
        for row in rows {
            let r = to_space_leader(row)?;
            match &first {
                Some(f) if r.space == f.space && r.problem == f.problem => {
                    if r.score <= f.score * (1.0 + SCORE_TIE) && r.id < leader.as_ref().expect("a leader").id {
                        leader = Some(r);
                    }
                }
                _ => {
                    out.extend(leader.take());
                    first = Some(r.clone());
                    leader = Some(r);
                }
            }
        }
        out.extend(leader);
        Ok(out)
    }

    /// SpaceStore.spaceBest. The leader of every problem of one space that has an entry, by problem id.
    pub fn space_best(&self, space: &str) -> Result<Vec<SpaceLeader>> {
        let rows = self
            .db
            .prepare("SELECT id, space, problem, score, name, created_at FROM space_entries WHERE space = ? ORDER BY space, problem, score, id")?
            .all(&[space.into()])?;
        Self::space_leaders_from_rows(&rows)
    }

    /// SpaceStore.spaceLeadersOf. The leader of each of the given space problems that has an entry,
    /// in one indexed read; at most GET_MANY_LIMIT problems. Problems without an entry are left out.
    pub fn space_leaders_of(&self, problems: &[SpaceProblem]) -> Result<Vec<SpaceLeader>> {
        if problems.is_empty() {
            return Ok(Vec::new());
        }
        if problems.len() > GET_MANY_LIMIT {
            return Err(StoreError::Range(format!("at most {GET_MANY_LIMIT} problems per call")));
        }
        // row values against the listing index: one lookup per problem, which keeps one row (two at most)
        let sql = format!(
            "SELECT id, space, problem, score, name, created_at FROM space_entries
         WHERE (space, problem) IN (VALUES {})
         ORDER BY space, problem, score, id",
            problems.iter().map(|_| "(?, ?)").collect::<Vec<_>>().join(", ")
        );
        let params: Vec<Param<'_>> =
            problems.iter().flat_map(|p| [Param::Text(&p.space), Param::Text(&p.problem)]).collect();
        let rows = self.db.prepare(&sql)?.all(&params)?;
        Self::space_leaders_from_rows(&rows)
    }

    /// SpaceStore.spaceLeaders. The leader of every space problem that has an entry, by space and problem id.
    pub fn space_leaders(&self) -> Result<Vec<SpaceLeader>> {
        let rows = self
            .db
            .prepare("SELECT id, space, problem, score, name, created_at FROM space_entries ORDER BY space, problem, score, id")?
            .all(&[])?;
        Self::space_leaders_from_rows(&rows)
    }

    /// SpaceStore.spaceRemove. Deletes an entry and prunes its problem; its space and problem, or
    /// None when there is no such entry.
    pub fn space_remove(&self, id: f64) -> Result<Option<SpaceProblem>> {
        let Some(r) =
            self.db.prepare("DELETE FROM space_entries WHERE id = ? RETURNING space, problem")?.get(&[id.into()])?
        else {
            return Ok(None);
        };
        // only the leader is ever kept, so the problem is normally left without an entry; the prune
        // applies the rule to whatever remains
        let found = SpaceProblem { space: r.text("space")?, problem: r.text("problem")? };
        self.space_prune_sync(&found.space, &found.problem)?;
        Ok(Some(found))
    }

    /// SpaceStore.spaceEdit. Corrects an entry's name or note; its space and problem, or None when
    /// there is no such entry.
    pub fn space_edit(&self, id: f64, changes: &SpaceEntryEdit) -> Result<Option<SpaceProblem>> {
        let mut sets: Vec<&str> = Vec::new();
        let mut values: Vec<Param<'_>> = Vec::new();
        if let Some(name) = &changes.name {
            sets.push("name = ?");
            values.push(name.into());
        }
        if let Some(note) = &changes.agent_note {
            sets.push("agent_note = ?");
            values.push(note.into());
        }
        let r = if sets.is_empty() {
            self.db.prepare("SELECT space, problem FROM space_entries WHERE id = ?")?.get(&[id.into()])?
        } else {
            values.push(id.into());
            let sql = format!("UPDATE space_entries SET {} WHERE id = ? RETURNING space, problem", sets.join(", "));
            let found = self.db.prepare(&sql)?.get(&values)?;
            found
        };
        r.map(|r| Ok(SpaceProblem { space: r.text("space")?, problem: r.text("problem")? })).transpose()
    }

    /// Store.holderPeaks. The most records each name has held at once, as /api/holders keeps them
    /// (`Holder.peak`): one row per name that has held at least one.
    pub fn holder_peaks(&self) -> Result<Vec<HolderPeak>> {
        let rows = self.db.prepare("SELECT name, peak FROM holder_peaks")?.all(&[])?;
        rows.iter().map(|r| Ok(HolderPeak { name: r.text("name")?, peak: r.num("peak")? })).collect()
    }

    /// Store.raiseHolderPeaks. Raises the stored peak of each name to `peak`, or stores it for a new
    /// name; a peak already stored that is higher stays (an upsert with MAX), so a peak never
    /// falls. All rows in one transaction.
    pub fn raise_holder_peaks(&self, rows: &[HolderPeak]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut up = self.db.prepare(
            "INSERT INTO holder_peaks (name, peak) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET peak = MAX(peak, excluded.peak)",
        )?;
        self.db.exec("BEGIN IMMEDIATE")?;
        let mut run = || -> Result<()> {
            for r in rows {
                up.run(&[(&r.name).into(), r.peak.into()])?;
            }
            self.db.exec("COMMIT")
        };
        match run() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.db.exec("ROLLBACK")?;
                Err(e)
            }
        }
    }

    pub(crate) fn get_meta(&self, key: &str) -> Result<Option<f64>> {
        let r = self.db.prepare("SELECT value FROM meta WHERE key = ?")?.get(&[key.into()])?;
        r.map(|r| r.num("value")).transpose()
    }

    fn set_meta(&self, key: &str, value: f64) -> Result<()> {
        self.db
            .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")?
            .run(&[key.into(), value.into()])?;
        Ok(())
    }

    /// The stored cursor of the pieces migration: the id of the last row it has handled (0 before
    /// its first step).
    pub(crate) fn pieces_cursor(&self) -> Result<f64> {
        Ok(self.get_meta(CURSOR)?.unwrap_or(0.0))
    }

    /// sqlite-store.ts: piecesMigrated. Whether every row has been through the pieces migration
    /// (always true for a new database).
    pub fn pieces_migrated(&self) -> Result<bool> {
        Ok(self.get_meta(MIGRATED)? == Some(1.0))
    }

    /// sqlite-store.ts: migratePieces. One step of the pieces migration, in one transaction: the
    /// next `batch` rows by id after the stored cursor. The problem of each row is pruned as a whole
    /// (see KEEP_PER_PROBLEM), which deletes the rows it no longer keeps, rejected rows included,
    /// also those further on; the JSON text of each kept row in the step becomes a BLOB. The cursor
    /// is saved with the changes, so a step cut short by a restart is simply done again, and nothing
    /// before the cursor is read again. Rows written after the cursor passed are BLOBs already, and
    /// `prune`, `review` and `remove` keep their problems to the rule.
    pub fn migrate_pieces(&self, batch: f64) -> Result<MigrationStep> {
        // an empty step would look like the end of the table
        if !is_integer(batch) || batch < 1.0 {
            return Err(StoreError::Range(format!("a migration step needs at least one row, not {}", fmt::num(batch))));
        }
        let mut step = MigrationStep {
            done: false,
            cursor: self.pieces_cursor()?,
            rows: 0.0,
            converted: 0.0,
            deleted: 0.0,
            unreadable: 0.0,
            bytes_before: 0.0,
            bytes_after: 0.0,
        };
        // n, m and p come before pieces in the row, and typeof() and octet_length() are answered from
        // its header, so this reads no pieces (and no overflow pages)
        let rows = self
            .db
            .prepare(
                "SELECT id, n, m, p, typeof(pieces) AS kind, octet_length(pieces) AS bytes FROM submissions
         WHERE id > ? ORDER BY id LIMIT ?",
            )?
            .all(&[step.cursor.into(), batch.into()])?;
        if rows.is_empty() {
            self.set_meta(MIGRATED, 1.0)?;
            step.done = true;
            return Ok(step);
        }
        let mut read = self.db.prepare("SELECT pieces FROM submissions WHERE id = ?")?;
        let mut write = self.db.prepare("UPDATE submissions SET pieces = ? WHERE id = ?")?;
        // the problems pruned in this step, by the text `${n}/${m}/${p}` the source keys them with
        let mut pruned: Vec<String> = Vec::new();
        let mut gone: Vec<f64> = Vec::new();
        self.db.exec("BEGIN IMMEDIATE")?;
        let mut run = || -> Result<()> {
            for r in &rows {
                let id = r.num("id")?;
                step.rows += 1.0;
                step.cursor = id;
                let problem =
                    format!("{}/{}/{}", r.get("n").to_js_string(), r.get("m").to_js_string(), r.get("p").to_js_string());
                if !pruned.contains(&problem) {
                    pruned.push(problem);
                    for d in self.prune_sync(r.num("n")?, r.num("m")?, r.num("p")?)? {
                        if !gone.contains(&d) {
                            gone.push(d);
                        }
                    }
                }
                // deleted, or a BLOB already
                if gone.contains(&id) || *r.get("kind") != JsVal::Text("text".into()) {
                    continue;
                }
                // a row another process deleted since the rows were listed: the source reads a property of
                // undefined there, and the step fails as a whole
                let stored = read.get(&[id.into()])?.ok_or_else(|| {
                    StoreError::Type("Cannot read properties of undefined (reading 'pieces')".to_string())
                })?;
                let Some(blob) = blob_from_json(&stored.text("pieces")?) else {
                    step.unreadable += 1.0;
                    continue;
                };
                write.run(&[(&blob).into(), id.into()])?;
                step.converted += 1.0;
                step.bytes_before += r.num("bytes")?;
                step.bytes_after += blob.len() as f64;
            }
            step.deleted = gone.len() as f64;
            self.set_meta(CURSOR, step.cursor)?;
            self.db.exec("COMMIT")
        };
        match run() {
            Ok(()) => Ok(step),
            Err(e) => {
                self.db.exec("ROLLBACK")?;
                Err(e)
            }
        }
    }

    /// `(SELECT MAX(id) FROM submissions) ?? 0`, for the migration's log.
    pub(crate) fn last_id(&self) -> Result<f64> {
        let r = self.db.prepare("SELECT MAX(id) AS id FROM submissions")?.get(&[])?.expect("MAX gives one row");
        Ok(r.num_or_null("id")?.unwrap_or(0.0))
    }

    /// `PRAGMA name`, its one value.
    pub(crate) fn pragma(&self, name: &str) -> Result<f64> {
        let sql = format!("PRAGMA {name}");
        let r = self.db.prepare(&sql)?.get(&[])?;
        match r.as_ref().and_then(|r| r.values().first()) {
            Some(v) => v.num(name),
            None => Err(StoreError::Type(format!("PRAGMA {name} gave no value"))),
        }
    }
}

// The HTTP layer keeps the store behind a mutex and uses it from its worker threads.
const _: fn() = || {
    fn is_send<T: Send>() {}
    is_send::<SqliteStore>();
};
