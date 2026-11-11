//! The tests of apps/server/test that concern the store, ported case for case:
//!
//! | source                         | module           |
//! |--------------------------------|------------------|
//! | sqlite-store.test.ts           | `sqlite_store`   |
//! | pieces.test.ts                 | `pieces`         |
//! | units-migration.test.ts        | `units_migration`|
//! | storage-diet.review.test.ts    | `storage_diet`   |
//! | leaders.test.ts (store parts)  | `leaders`        |
//!
//! and `fixtures`: answers of the TypeScript, written by `native/tools/store-ref.mts fixtures`.
//!
//! Where a source test wraps `db.prepare` or `db.exec` of the store, the port sets a tracer on the
//! store's connection (see db.rs). Where it uses fast-check, the port draws the same kinds of cases
//! from a seeded generator.

mod fixtures;
mod leaders;
mod pieces;
mod sqlite_store;
mod storage_diet;
mod units_migration;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::Value;

use super::*;

/// A directory for the database files of one test, inside cargo's target directory; removed when
/// the test ends.
pub(super) struct TempDir(PathBuf);

impl TempDir {
    pub fn new(prefix: &str) -> TempDir {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let base = std::env::current_exe().expect("the test binary").parent().expect("its directory").join("polypack-store-tests");
        let dir = base.join(format!("{prefix}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a directory for the test");
        TempDir(dir)
    }
    pub fn file(&self, name: &str) -> String {
        self.0.join(name).to_str().expect("a UTF-8 path").to_string()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// parseSpaceId as the TypeScript answered it for the problem ids of these tests
/// (tests/fixtures/store/spaceids.json). An id it was not asked about fails the test.
pub(super) struct TestSpaceIds {
    names: Vec<String>,
    ids: Vec<(String, Option<SpaceIdFields>)>,
}

impl TestSpaceIds {
    pub fn load() -> TestSpaceIds {
        let v: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/store/spaceids.json")))
            .expect("the fixture");
        let names = v["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect();
        let ids = v["ids"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, fields)| {
                let fields = fields.as_object().map(|o| {
                    SpaceIdFields(
                        o.iter()
                            .map(|(k, f)| {
                                let f = match f {
                                    Value::Number(n) => SpaceIdField::Number(n.as_f64().unwrap()),
                                    Value::String(s) => SpaceIdField::Text(s.clone()),
                                    other => panic!("a field of an id is {other}"),
                                };
                                (k.clone(), f)
                            })
                            .collect(),
                    )
                });
                (key.clone(), fields)
            })
            .collect();
        TestSpaceIds { names, ids }
    }
}

impl SpaceIds for TestSpaceIds {
    fn space_names(&self) -> Vec<String> {
        self.names.clone()
    }
    fn parse_space_id(&self, space: &str, id: &str) -> Option<SpaceIdFields> {
        let key = format!("{space}\n{id}");
        match self.ids.iter().find(|(k, _)| *k == key) {
            Some((_, fields)) => fields.clone(),
            None => panic!("the fixture has no answer of the TypeScript for the id {id:?} of {space:?}"),
        }
    }
}

/// `new SqliteStore(path)`.
pub(super) fn open(path: &str) -> SqliteStore {
    let spaces = TestSpaceIds::load();
    SqliteStore::open(path, OpenOptions::new(&spaces)).expect("the store opens")
}

/// `new SqliteStore(path, { log })`: the store and what it logged.
pub(super) fn open_logged(path: &str) -> (SqliteStore, Vec<String>) {
    let spaces = TestSpaceIds::load();
    let mut logs: Vec<String> = Vec::new();
    let store = {
        let mut log = |m: &str| logs.push(m.to_string());
        let mut opts = OpenOptions::new(&spaces);
        opts.log = Some(&mut log);
        SqliteStore::open(path, opts).expect("the store opens")
    };
    (store, logs)
}

/// The entry every source test builds, with its usual fields; a test changes what it needs.
pub(super) fn entry(n: f64, m: f64, p: f64, score: f64, name: &str) -> NewSubmission {
    NewSubmission {
        n,
        m,
        p,
        score,
        name: name.to_string(),
        agent_note: String::new(),
        pieces: vec![Pose { x: 0.0, y: 0.0, theta: 0.0 }],
        container_phi: 0.0,
        created_at: "2026-10-18T00:00:00Z".to_string(),
        verification: "none".to_string(),
        literature_value: None,
        strict_check: None,
        found_with: Some("hand".to_string()),
        method: None,
        method_params: None,
        seed: None,
        budget: None,
        software: None,
    }
}

/// P poses with full-precision coordinates, different for every seed (the source tests' `poses`).
pub(super) fn poses(p: usize, seed: f64) -> Vec<Pose> {
    (0..p)
        .map(|i| {
            let i = i as f64;
            Pose {
                x: polypack_js::math::sin(seed * 7919.0 + i) * 1000.0,
                y: polypack_js::math::cos(seed * 104729.0 + i) / 3.0,
                theta: (seed + i) * 0.1234567890123,
            }
        })
        .collect()
}

/// `JSON.stringify(poses)`.
pub(super) fn poses_json(list: &[Pose]) -> String {
    polypack_js::json::stringify(&list)
}

/// The poses of a stored entry, which every test here expects to be a list of poses.
pub(super) fn stored_poses(s: &StoredSubmission) -> Vec<Pose> {
    s.pieces.poses().expect("a list of poses")
}

/// Equal bit for bit: tells -0 from 0.
pub(super) fn same_bits(a: &[Pose], b: &[Pose]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(p, q)| {
            p.x.to_bits() == q.x.to_bits() && p.y.to_bits() == q.y.to_bits() && p.theta.to_bits() == q.theta.to_bits()
        })
}

/// A seeded generator for the tests that use fast-check in the source.
pub(super) struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// An integer from lo to hi, both included.
    pub fn int(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
    pub fn pick<T: Clone>(&mut self, list: &[T]) -> T {
        list[self.int(0, list.len() as u64 - 1) as usize].clone()
    }
}

/// `SELECT typeof(pieces)` of every row: (id, "blob" or "json"), read by a connection of its own.
pub(super) fn forms(path: &str) -> Vec<(i64, &'static str)> {
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).expect("the file");
    let mut st = db.prepare("SELECT id, typeof(pieces) AS kind FROM submissions ORDER BY id").unwrap();
    let rows = st
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, if r.get::<_, String>(1)? == "blob" { "blob" } else { "json" })))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    rows
}

/// The first value of the first row of a statement, by a connection of its own; 0 when there is none.
pub(super) fn read(path: &str, sql: &str) -> i64 {
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).expect("the file");
    let mut st = db.prepare(sql).unwrap();
    let mut rows = st.query([]).unwrap();
    match rows.next().unwrap() {
        Some(r) => r.get::<_, Option<i64>>(0).unwrap().unwrap_or(0),
        None => 0,
    }
}

pub(super) fn cursor_of(path: &str) -> i64 {
    read(path, "SELECT value FROM meta WHERE key = 'pieces_cursor'")
}

/// One row of a database written before pieces became BLOBs.
pub(super) struct OldRow {
    pub n: f64,
    pub m: f64,
    pub p: f64,
    pub score: f64,
    pub verification: &'static str,
    /// The text of the pieces column.
    pub pieces: String,
}

/// The schema of a database as the server wrote it before pieces became BLOBs: the deployed schema
/// with the added columns, the tallies and the listing index, no meta table.
pub(super) const OLD_SCHEMA: &str = "PRAGMA journal_mode = WAL;
    CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL,
      p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '',
      agent_note TEXT NOT NULL, pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT, found_with TEXT,
      method TEXT, method_params TEXT, seed INTEGER, budget TEXT, software TEXT);
    CREATE INDEX submissions_verification ON submissions (verification);
    CREATE INDEX submissions_listing
      ON submissions (n, m, p, score, id, verification, name, found_with, agent_note, created_at);
    CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
      PRIMARY KEY (n, m, p));";
