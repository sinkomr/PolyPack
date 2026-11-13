//! apps/server/test/sqlite-store.test.ts, case for case.

use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use super::*;

/// The `detail` of each line of EXPLAIN QUERY PLAN; the statement's parameters are left unbound,
/// as node:sqlite leaves them in the source's tests.
fn explain_plan(conn: &Connection, sql: &str) -> Vec<String> {
    let mut st = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).expect("a plan");
    let mut rows = st.raw_query();
    let mut details = Vec::new();
    while let Some(r) = rows.next().unwrap() {
        details.push(r.get::<_, String>(3).unwrap());
    }
    details
}

// ---- describe("SqliteStore query plans") ----------------------------------------------------------

// The pieces of an entry can be tens of kilobytes and sit in the table before verification and
// the later columns, so a query that reads those from the table walks every row's pieces. These
// queries must be answered from the listing index alone.
#[test]
fn finds_leaders_prunes_ranks_and_lists_from_the_covering_index() {
    let store = open(":memory:");
    let plans: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&plans);
    store.db().set_tracer(Some(Box::new(move |conn, event| {
        if let TraceEvent::Prepare(sql) = event {
            let head = sql.trim_start().to_ascii_uppercase();
            if (head.starts_with("WITH") || head.starts_with("SELECT")) && sql.contains("FROM submissions") && !sql.contains("SELECT *") {
                let plan: Vec<String> = explain_plan(conn, sql)
                    .into_iter()
                    .filter(|d| (d.starts_with("SEARCH") || d.starts_with("SCAN")) && !(d.contains("rowid=?") || d.contains("best")))
                    .collect();
                seen.lock().unwrap().push(plan.join("; "));
            }
        }
        Ok(())
    })));
    let add = |score: f64, verification: &str| {
        let mut e = entry(4.0, 4.0, 1.0, score, "a");
        e.verification = verification.to_string();
        store.insert(&e).unwrap()
    };
    add(1.0, "none");
    store.leader(4.0, 4.0, 1.0).unwrap();
    store.prune(4.0, 4.0, 1.0).unwrap();
    store.rank(4.0, 4.0, 1.0, 1.0).unwrap();
    store.best_per_p(4.0, 4.0, false).unwrap();
    store.best_per_p(4.0, 4.0, true).unwrap();
    store.leaders().unwrap();
    store.leaders_after(None, 10.0).unwrap();
    store.leaders_after(Some(ProblemKey { n: 4.0, m: 4.0, p: 1.0 }), 10.0).unwrap();
    store.pairs().unwrap();
    // the prune of a problem led by a pending claim, which keeps the best entry that is not
    // pending, and the prunes after a review and a removal
    let claim = add(0.5, "pending");
    assert_eq!(store.prune(4.0, 4.0, 1.0).unwrap(), Vec::<f64>::new());
    store.review(claim, Decision::Confirmed).unwrap();
    store.remove(claim).unwrap();
    let plans = plans.lock().unwrap();
    assert!(plans.len() >= 5);
    for plan in plans.iter() {
        for step in plan.split("; ") {
            assert!(step.contains("USING COVERING INDEX submissions_listing"), "{step:?} of {plan:?}");
        }
    }
}

#[test]
fn walks_the_table_by_id_for_the_pieces_migration_without_reading_the_pieces_of_rows_it_skips() {
    let store = open(":memory:");
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let out = Arc::clone(&seen);
    store.db().set_tracer(Some(Box::new(move |conn, event| {
        if let TraceEvent::Prepare(sql) = event {
            if sql.contains("WHERE id > ?") {
                let mut out = out.lock().unwrap();
                out.extend(explain_plan(conn, sql));
                // OP_Column with p5 = 0x80 (typeof) or 0xc0 (octet_length) does not load the value
                let mut st = conn.prepare(&format!("EXPLAIN {sql}")).unwrap();
                let mut rows = st.raw_query();
                let mut ops: Vec<(String, i64, i64)> = Vec::new();
                while let Some(r) = rows.next().unwrap() {
                    ops.push((r.get(1).unwrap(), r.get(3).unwrap(), r.get(6).unwrap()));
                }
                out.extend(ops.iter().filter(|(opcode, p2, _)| opcode == "Column" && *p2 == 8).map(|(_, _, p5)| format!("pieces column p5={p5}")));
            }
        }
        Ok(())
    })));
    store.migrate_pieces(10.0).unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(*seen, ["SEARCH submissions USING INTEGER PRIMARY KEY (rowid>?)", "pieces column p5=128", "pieces column p5=192"]);
}

#[test]
fn replaces_the_narrower_index_of_an_older_database() {
    let dir = TempDir::new("store");
    let path = dir.file("old.sqlite");
    drop(open(&path));
    let old = Connection::open(&path).unwrap();
    old.execute_batch("DROP INDEX submissions_listing; CREATE INDEX submissions_problem ON submissions (n, m, p, score, id);")
        .unwrap();
    drop(old);
    let store = open(&path);
    let names: Vec<String> = store
        .db()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .unwrap()
        .all(&[])
        .unwrap()
        .iter()
        .map(|r| r.text("name").unwrap())
        .collect();
    assert!(names.iter().any(|n| n == "submissions_listing"));
    assert!(!names.iter().any(|n| n == "submissions_problem"));
}

// ---- describe("pieces as BLOBs, and the migration of older rows") ---------------------------------

/// A database as the server wrote it before pieces became BLOBs: the deployed schema with the
/// added columns, the tallies and the listing index, no meta table, and pieces as JSON text.
fn old_database(dir: &TempDir, rows: &[OldRow]) -> String {
    let path = dir.file("old.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(OLD_SCHEMA).unwrap();
    {
        let mut add = db
            .prepare(
                "INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification,
       found_with, method, seed)
     VALUES (?, ?, ?, ?, ?, '', ?, 0, '2026-10-12T00:00:00Z', ?, 'optimizer', 'asc', 7)",
            )
            .unwrap();
        for (i, r) in rows.iter().enumerate() {
            add.execute(rusqlite::params![r.n, r.m, r.p, r.score, format!("row {}", i + 1), r.pieces, r.verification]).unwrap();
        }
    }
    db.execute_batch("INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions GROUP BY n, m, p").unwrap();
    path
}

fn row(n: f64, m: f64, p: f64, score: f64, verification: &'static str, pieces: String) -> OldRow {
    OldRow { n, m, p, score, verification, pieces }
}

/// The rows of the source's tests; ids follow the order of this list.
fn rows() -> Vec<OldRow> {
    let j = |p: usize, seed: f64| poses_json(&poses(p, seed));
    let mut rows = vec![
        // 1-3: P = 2, three ordinary entries: only the best (2) is kept
        row(4.0, 4.0, 2.0, 2.2, "none", j(2, 1.0)),
        row(4.0, 4.0, 2.0, 2.0, "none", j(2, 2.0)),
        row(4.0, 4.0, 2.0, 2.1, "none", j(2, 3.0)),
        // 4-6: P = 3, a pending claim (5) leads: the best ordinary entry (4) is kept behind it
        row(4.0, 4.0, 3.0, 6.0, "none", j(3, 4.0)),
        row(4.0, 4.0, 3.0, 3.0, "pending", j(3, 5.0)),
        row(4.0, 4.0, 3.0, 6.5, "none", j(3, 6.0)),
        // 7-8: P = 5, a confirmed entry and a rejected one: the rejected one goes
        row(4.0, 4.0, 5.0, 5.0, "confirmed", j(5, 7.0)),
        row(4.0, 4.0, 5.0, 4.0, "rejected", j(5, 8.0)),
        // 9-11: P = 6, near-ties: 9 leads, as the earliest within the tolerance of the smallest
        // score (11's), although it is not first by score
        row(4.0, 4.0, 6.0, 6.0, "none", j(6, 9.0)),
        row(4.0, 4.0, 6.0, 6.0 * (1.0 + 0.3 * SCORE_TIE), "none", j(6, 10.0)),
        row(4.0, 4.0, 6.0, 6.0 * (1.0 - 0.6 * SCORE_TIE), "none", j(6, 11.0)),
        // 12: P = 7, a leader whose text is not a list of poses is left as it is
        row(4.0, 4.0, 7.0, 7.0, "none", "[{\"x\":1,\"y\":2}]".to_string()),
        // 13: P = 8, nothing but a rejected entry
        row(4.0, 4.0, 8.0, 8.0, "rejected", j(8, 13.0)),
    ];
    // 14-16: P = 9, -0 (which JSON wrote as 0) and the coordinate limit
    let mut first = vec![Pose { x: -0.0, y: 1e6, theta: -1e6 }];
    first.extend(poses(8, 14.0));
    rows.push(row(4.0, 4.0, 9.0, 9.0, "none", poses_json(&first)));
    rows.push(row(4.0, 4.0, 9.0, 9.5, "none", j(9, 15.0)));
    rows.push(row(4.0, 4.0, 9.0, 9.7, "none", j(9, 16.0)));
    // 17-46: three circle entries for each P from 10 to 19, so that the walk takes several steps;
    // the first of each (ids 17-26) is the best
    for i in 0..30 {
        rows.push(row(0.0, 0.0, 10.0 + (i % 10) as f64, 20.0 + i as f64, "none", j(4, 17.0 + i as f64)));
    }
    rows
}

/// What the migration leaves of `rows()`: (id, form).
fn kept() -> Vec<(i64, &'static str)> {
    let mut kept = vec![(2, "blob"), (4, "blob"), (5, "blob"), (7, "blob"), (9, "blob"), (12, "json"), (14, "blob")];
    kept.extend((17..=26).map(|id| (id, "blob")));
    kept
}

fn form_of(path: &str, id: i64) -> Option<&'static str> {
    forms(path).into_iter().find(|(i, _)| *i == id).map(|(_, f)| f)
}

#[test]
fn reads_json_text_and_blobs_side_by_side_before_and_during_the_migration() {
    let dir = TempDir::new("pieces");
    let path = old_database(&dir, &rows());
    let store = open(&path);
    assert!(!store.pieces_migrated().unwrap());
    // the older rows read as before
    assert_eq!(stored_poses(&store.get(2.0).unwrap().unwrap()), poses(2, 2.0));
    // a new row is a BLOB in the same column
    let mut fresh = vec![Pose { x: -0.0, y: 0.1, theta: 1e6 }];
    fresh.extend(poses(3, 99.0));
    let mut e = entry(4.0, 4.0, 4.0, 4.0, "new");
    e.pieces = fresh.clone();
    e.verification = "pending".to_string();
    e.literature_value = Some(5.0);
    let id = store.insert(&e).unwrap();
    assert_eq!(form_of(&path, id as i64), Some("blob"));
    assert!(stored_poses(&store.get(id).unwrap().unwrap())[0].x.is_sign_negative());
    let many = store.get_many(&[1.0, 2.0, 5.0, id]).unwrap();
    let mut got: Vec<(f64, Vec<Pose>)> = many.iter().map(|s| (s.id, stored_poses(s))).collect();
    got.sort_by(|a, b| a.0.total_cmp(&b.0));
    assert_eq!(got, vec![(1.0, poses(2, 1.0)), (2.0, poses(2, 2.0)), (5.0, poses(3, 5.0)), (id, fresh.clone())]);
    let pending: Vec<(f64, Vec<Pose>)> = store.pending().unwrap().iter().map(|s| (s.id, stored_poses(s))).collect();
    assert_eq!(pending, vec![(id, fresh), (5.0, poses(3, 5.0))]);
    // half-way through, both forms are still read
    store.migrate_pieces(5.0).unwrap();
    assert_eq!(form_of(&path, 2), Some("blob"));
    assert_eq!(form_of(&path, 7), Some("json"));
    let both: Vec<Vec<Pose>> = store.get_many(&[2.0, 7.0]).unwrap().iter().map(stored_poses).collect();
    assert_eq!(both, vec![poses(2, 2.0), poses(5, 7.0)]);
}

fn leaders_by_p(store: &SqliteStore) -> Vec<(f64, f64)> {
    store.best_per_p(4.0, 4.0, false).unwrap().iter().map(|e| (e.p, e.id)).collect()
}

#[test]
fn converts_and_deletes_in_small_steps_survives_an_interruption_and_resumes_where_it_stopped() {
    let dir = TempDir::new("pieces");
    let rows = rows();
    let path = old_database(&dir, &rows);
    let mut store = open(&path);
    let before: Vec<Vec<Pose>> =
        (1..=rows.len()).map(|id| stored_poses_or_json(&store.get(id as f64).unwrap().unwrap())).collect();
    let leaders = leaders_by_p(&store);
    assert_eq!(leaders, vec![(2.0, 2.0), (3.0, 5.0), (5.0, 7.0), (6.0, 9.0), (7.0, 12.0), (9.0, 14.0)]);

    // rows 1-4: problems 2 and 3 are pruned whole (1, 3 and 6 go), and 2 and 4 are converted
    let first = store.migrate_pieces(4.0).unwrap();
    assert!(!first.done);
    assert_eq!((first.cursor, first.rows, first.converted, first.deleted, first.unreadable), (4.0, 4.0, 2.0, 3.0, 0.0));
    assert_eq!(first.bytes_after, 5.0 * 24.0);
    assert!(first.bytes_before > 2.5 * first.bytes_after);
    assert!(matches!(store.migrate_pieces(0.0), Err(StoreError::Range(_))));

    // A step cut short in the middle (a crash, a restart) changes nothing: its transaction is
    // rolled back, deletions included, the cursor stays, and the next start does it again.
    let writes = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&writes);
    store.db().set_tracer(Some(Box::new(move |_, event| {
        if let TraceEvent::Step(sql, _) = event {
            if sql.starts_with("UPDATE submissions SET pieces = ?") {
                let mut n = counter.lock().unwrap();
                *n += 1;
                if *n == 2 {
                    return Err(StoreError::Other("killed".to_string()));
                }
            }
        }
        Ok(())
    })));
    let snapshot = forms(&path);
    // rows 5, 7, 8, 9: 5 is converted, then 8 deleted with the prune of problem 5, then 7 fails
    let failed = store.migrate_pieces(4.0).unwrap_err();
    assert_eq!(failed.message(), "killed");
    assert_eq!(*writes.lock().unwrap(), 2);
    assert_eq!(forms(&path), snapshot);
    assert_eq!(snapshot.iter().find(|(id, _)| *id == 8).map(|(_, f)| *f), Some("json"));
    assert_eq!(cursor_of(&path), 4);

    // a new process, which stops again after two steps; the cursor was kept with each step
    store = open(&path);
    let mut steps = Vec::new();
    for i in 0..100 {
        let step = store.migrate_pieces(7.0).unwrap();
        steps.push(step);
        if step.done {
            break;
        }
        if i == 1 {
            store = open(&path);
        }
    }
    // rows deleted further on are not visited: after 26, nothing is left
    assert_eq!(steps.iter().map(|s| s.cursor).collect::<Vec<_>>(), vec![12.0, 19.0, 26.0, 26.0]);
    assert!(steps.last().unwrap().done);
    assert_eq!(steps.iter().map(|s| s.unreadable).sum::<f64>(), 1.0);
    assert_eq!(first.deleted + steps.iter().map(|s| s.deleted).sum::<f64>(), (rows.len() - kept().len()) as f64);
    assert!(store.pieces_migrated().unwrap());

    assert_eq!(forms(&path), kept());
    // every kept arrangement reads back exactly as the JSON held it, and the leaders are the same
    for (id, _) in kept() {
        assert_eq!(stored_poses_or_json(&store.get(id as f64).unwrap().unwrap()), before[id as usize - 1], "row {id}");
    }
    assert_eq!(leaders_by_p(&store), leaders);
    // -0 was lost already in the JSON; the coordinate limit is kept
    let p14 = stored_poses(&store.get(14.0).unwrap().unwrap())[0];
    assert_eq!((p14.x.to_bits(), p14.y, p14.theta), (0.0f64.to_bits(), 1e6, -1e6));
    // the counts of submissions received are kept
    assert_eq!(store.count(4.0, 4.0, 2.0).unwrap(), 3.0);

    // complete: another start does nothing and reads nothing again
    let again = open(&path);
    assert!(again.pieces_migrated().unwrap());
    let mut log: Vec<String> = Vec::new();
    let run = again
        .start_pieces_migration(MigrationOptions { batch: 100.0, pause_ms: 0.0, log_every_ms: None }, &mut |m| log.push(m.to_string()))
        .unwrap();
    assert!(run.finished());
    assert_eq!(run.first_delay_ms(), None);
    assert!(log.is_empty());
}

/// The pieces of a row as poses. The one row of these tests whose text is not a list of poses
/// (row 12, `[{"x":1,"y":2}]`) is checked here to read back as that JSON, and stands as one fixed
/// pose in the comparisons of the test.
fn stored_poses_or_json(s: &StoredSubmission) -> Vec<Pose> {
    match &s.pieces {
        Pieces::Json(v) if s.pieces.poses().is_none() => {
            assert_eq!(polypack_js::json::stringify(v), "[{\"x\":1,\"y\":2}]");
            vec![Pose { x: 1.0, y: 2.0, theta: 0.0 }]
        }
        _ => stored_poses(s),
    }
}

/// The timer of the HTTP layer, without the waiting: ticks until the run ends or `max` ticks were made.
fn run_ticks(store: &SqliteStore, run: &mut PiecesMigration, log: &mut Vec<String>, max: usize) -> Vec<f64> {
    let mut delays = Vec::new();
    let mut next = run.first_delay_ms();
    while let Some(delay) = next {
        delays.push(delay);
        if delays.len() > max {
            break;
        }
        next = run.tick(store, &mut |m| log.push(m.to_string()));
    }
    delays
}

#[test]
fn runs_in_the_background_with_a_pause_between_steps_logs_sparingly_and_can_be_stopped() {
    let dir = TempDir::new("pieces");
    let rows = rows();
    let path = old_database(&dir, &rows);
    let mut log: Vec<String> = Vec::new();
    let store = open(&path);
    // one row per step, stopped after a few
    let mut stopped = store
        .start_pieces_migration(MigrationOptions { batch: 1.0, pause_ms: 5.0, log_every_ms: None }, &mut |m| log.push(m.to_string()))
        .unwrap();
    let delays = run_ticks(&store, &mut stopped, &mut log, 6);
    assert!(delays.iter().all(|d| *d == 5.0));
    stopped.stop();
    assert!(stopped.finished());
    assert_eq!(log, vec![format!("[pieces] migration starting after row 0 of {}: 1 rows every 5 ms", rows.len())]);
    assert!(!store.pieces_migrated().unwrap());
    let cursor = cursor_of(&path);
    assert!(cursor > 0);
    assert!(cursor < 26);
    // a stopped run takes no further step
    assert_eq!(stopped.tick(&store, &mut |m| log.push(m.to_string())), None);
    assert_eq!(cursor_of(&path), cursor);

    log.clear();
    let last = read(&path, "SELECT MAX(id) FROM submissions");
    let other = open(&path);
    let mut run = other
        .start_pieces_migration(MigrationOptions { batch: 3.0, pause_ms: 0.0, log_every_ms: Some(60_000.0) }, &mut |m| log.push(m.to_string()))
        .unwrap();
    run_ticks(&other, &mut run, &mut log, usize::MAX);
    assert!(run.finished());
    assert!(store.pieces_migrated().unwrap());
    assert_eq!(log.len(), 2, "{log:?}");
    assert_eq!(log[0], format!("[pieces] migration starting after row {cursor} of {last}: 3 rows every 0 ms"));
    // /^\[pieces\] migration complete: \d+ converted .*, \d+ deleted, [01] left as text; /
    let rest = log[1].strip_prefix("[pieces] migration complete: ").expect("the complete line");
    let (converted, rest) = rest.split_once(" converted ").expect("converted");
    assert!(!converted.is_empty() && converted.bytes().all(|b| b.is_ascii_digit()));
    let (head, _) = rest.split_once(" left as text; ").expect("left as text");
    let unreadable = head.rsplit(", ").next().unwrap();
    assert!(unreadable == "0" || unreadable == "1");
    let deleted = head.rsplit(", ").nth(1).unwrap().strip_suffix(" deleted").expect("deleted");
    assert!(!deleted.is_empty() && deleted.bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(forms(&path), kept());

    // switched off
    let off_dir = TempDir::new("pieces");
    let off = open(&old_database(&off_dir, &rows));
    log.clear();
    let run = off
        .start_pieces_migration(MigrationOptions { batch: 0.0, pause_ms: 0.0, log_every_ms: None }, &mut |m| log.push(m.to_string()))
        .unwrap();
    assert!(run.finished());
    assert!(!off.pieces_migrated().unwrap());
    assert!(log.is_empty());
}

#[test]
fn keeps_the_leader_alone_and_the_best_reviewed_entry_behind_a_pending_one_until_it_is_reviewed() {
    let store = open(":memory:");
    let add = |p: f64, score: f64, verification: &str, seed: f64| {
        let mut e = entry(4.0, 4.0, p, score, &format!("s{seed}"));
        e.pieces = poses(p as usize, seed);
        e.verification = verification.to_string();
        store.insert(&e).unwrap()
    };
    let leader_of = |p: f64| store.leader(4.0, 4.0, p).unwrap().map(|l| l.id);
    // a pending leader, a second claim, the best reviewed entry and a worse one
    let claim = add(3.0, 1.0, "pending", 1.0);
    let other = add(3.0, 2.0, "pending", 2.0);
    let plain = add(3.0, 3.0, "none", 3.0);
    let worse = add(3.0, 4.0, "none", 4.0);
    assert_eq!(store.prune(4.0, 4.0, 3.0).unwrap(), vec![other, worse]);
    assert!(store.get(other).unwrap().is_none());
    assert_eq!(stored_poses(&store.get(plain).unwrap().unwrap()), poses(3, 3.0));

    // rejected: the claim is deleted, and the entry behind it leads again
    assert!(store.review(claim, Decision::Rejected).unwrap());
    assert!(store.get(claim).unwrap().is_none());
    assert_eq!(leader_of(3.0), Some(plain));
    assert!(!store.review(claim, Decision::Confirmed).unwrap());
    // only pending or confirmed entries are reviewed
    assert!(!store.review(plain, Decision::Confirmed).unwrap());

    // confirmed: the claim stays alone
    let next = add(3.0, 1.5, "pending", 5.0);
    assert_eq!(store.prune(4.0, 4.0, 3.0).unwrap(), Vec::<f64>::new());
    assert!(store.review(next, Decision::Confirmed).unwrap());
    assert!(store.get(plain).unwrap().is_none());
    assert_eq!(leader_of(3.0), Some(next));
    assert_eq!(store.get(next).unwrap().unwrap().verification, "confirmed");
    // a confirmed entry can still be rejected, which leaves the problem without an entry
    assert!(store.review(next, Decision::Rejected).unwrap());
    assert_eq!(leader_of(3.0), None);
    assert_eq!(store.count(4.0, 4.0, 3.0).unwrap(), 5.0);

    // removing a pending leader leaves the entry behind it; removing that one, nothing
    let lone = add(5.0, 5.0, "none", 6.0);
    let claim5 = add(5.0, 4.0, "pending", 7.0);
    assert_eq!(store.prune(4.0, 4.0, 5.0).unwrap(), Vec::<f64>::new());
    assert!(store.remove(claim5).unwrap());
    assert!(store.get(claim5).unwrap().is_none());
    assert_eq!(leader_of(5.0), Some(lone));
    assert!(store.remove(lone).unwrap());
    assert!(!store.remove(lone).unwrap());
    assert_eq!(leader_of(5.0), None);
    assert!(store.best_per_p(4.0, 4.0, false).unwrap().is_empty());
}

#[test]
fn packs_the_triples_and_the_json_text_of_a_database_of_october_2026_and_leaves_what_packing_does_not_shorten() {
    // rows of a lattice with one angle pack well; a few scattered pieces do not
    let lattice = |p: usize, k: f64| -> Vec<Pose> {
        (0..p).map(|i| Pose { x: (i % 9) as f64 * (1.0 + k * 1e-9), y: (i / 9) as f64 / 3.0, theta: 0.0 }).collect()
    };
    let held: Vec<Option<Vec<Pose>>> = vec![
        Some(lattice(60, 1.0)),
        Some(poses(2, 2.0)),
        Some(lattice(200, 3.0)),
        Some(lattice(45, 4.0)),
        None, // row 5: text that is no list of poses
        Some(poses(3, 6.0)),
        Some(lattice(500, 7.0)),
    ];
    let dir = TempDir::new("packs");
    let rows: Vec<OldRow> = held
        .iter()
        .enumerate()
        .map(|(i, pieces)| {
            let text = pieces.as_ref().map(|p| poses_json(p)).unwrap_or_else(|| r#"[{"x":1,"y":2}]"#.to_string());
            row(4.0, 4.0, 101.0 + i as f64, 9.0, "none", text)
        })
        .collect();
    let path = old_database(&dir, &rows);
    // as the server of October 2026 left it: triples (rows 4 and 5 still text), its own migration marked complete
    {
        let old = Connection::open(&path).unwrap();
        for id in [1usize, 2, 3, 6, 7] {
            old.execute(
                "UPDATE submissions SET pieces = ? WHERE id = ?",
                rusqlite::params![encode_pieces(held[id - 1].as_ref().unwrap()), id as i64],
            )
            .unwrap();
        }
        old.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO meta VALUES ('pieces_cursor', 7), ('pieces_migrated', 1)",
        )
        .unwrap();
    }
    // the length of each row's BLOB, or -1 for text
    let lengths = || -> Vec<i64> {
        let db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut st = db.prepare("SELECT typeof(pieces), length(pieces) FROM submissions ORDER BY id").unwrap();
        let rows = st
            .query_map([], |r| Ok(if r.get::<_, String>(0)? == "blob" { r.get::<_, i64>(1)? } else { -1 }))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    };
    assert_eq!(lengths(), vec![1440, 48, 4800, -1, -1, 72, 12000]);

    let store = open(&path);
    assert!(!store.pieces_migrated().unwrap());
    let first = store.migrate_pieces(3.0).unwrap();
    assert_eq!(
        (first.done, first.cursor, first.rows, first.converted, first.deleted, first.unreadable),
        (false, 3.0, 3.0, 2.0, 0.0, 0.0)
    );
    assert_eq!(first.bytes_before, 1440.0 + 4800.0);
    let second = store.migrate_pieces(10.0).unwrap();
    assert_eq!(
        (second.done, second.cursor, second.rows, second.converted, second.deleted, second.unreadable),
        (false, 7.0, 4.0, 2.0, 0.0, 1.0)
    );
    let third = store.migrate_pieces(10.0).unwrap();
    assert!(third.done && third.rows == 0.0);
    assert!(store.pieces_migrated().unwrap());

    let after = lengths();
    // packed: shorter, and never a multiple of 24
    for id in [1usize, 3, 4, 7] {
        let triples = held[id - 1].as_ref().unwrap().len() as i64 * 24;
        assert!(after[id - 1] > 0 && after[id - 1] * 2 < triples, "row {id}: {} of {triples}", after[id - 1]);
        assert_ne!(after[id - 1] % 24, 0, "row {id}");
    }
    assert_eq!(first.bytes_after, (after[0] + after[2]) as f64);
    // left as they were: triples no shorter packed, and text that is no list of poses
    assert_eq!((after[1], after[4], after[5]), (48, -1, 72));
    for (i, pieces) in held.iter().enumerate() {
        if let Some(pieces) = pieces {
            assert!(same_bits(pieces, &stored_poses(&store.get(i as f64 + 1.0).unwrap().unwrap())), "row {}", i + 1);
        }
    }
    // the keys of the first migration are as they were, and a second pass finds nothing to do
    assert_eq!(read(&path, "SELECT value FROM meta WHERE key = 'pieces_cursor'"), 7);
    assert_eq!(cursor_of(&path), 7);
    drop(store);
    assert!(open(&path).pieces_migrated().unwrap());
    assert_eq!(lengths(), after);
}

#[test]
fn marks_a_new_database_as_migrated_since_it_never_held_json_text() {
    assert!(open(":memory:").pieces_migrated().unwrap());
    let dir = TempDir::new("new");
    let path = dir.file("new.sqlite");
    drop(open(&path));
    assert!(open(&path).pieces_migrated().unwrap());
}

// ---- describe("a submission") ---------------------------------------------------------------------

fn submission(score: f64) -> NewSubmission {
    let mut e = entry(4.0, 4.0, 1.0, score, "a");
    e.created_at = "2026-10-21T00:00:00Z".to_string();
    e
}

#[test]
fn is_stored_counted_ranked_and_pruned_in_one_transaction_one_commit() {
    let store = open(":memory:");
    let statements: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&statements);
    store.db().set_tracer(Some(Box::new(move |_, event| {
        if let TraceEvent::Exec(sql) = event {
            seen.lock().unwrap().push(sql.to_string());
        }
        Ok(())
    })));
    let first = store.submit(&submission(2.0)).unwrap();
    assert_eq!((first.before.as_ref(), first.position, first.kept), (None, 1.0, true));
    assert_eq!(first.leader.as_ref().map(|l| l.id), Some(first.id));
    let worse = store.submit(&submission(3.0)).unwrap();
    assert_eq!((worse.position, worse.kept), (2.0, false));
    assert_eq!(worse.before.as_ref().map(|l| l.id), Some(first.id));
    assert_eq!(worse.leader.as_ref().map(|l| l.id), Some(first.id));
    let better = store.submit(&submission(1.0)).unwrap();
    assert_eq!((better.position, better.kept), (1.0, true));
    assert_eq!(better.before.as_ref().map(|l| l.id), Some(first.id));
    assert_eq!(better.leader.as_ref().map(|l| l.id), Some(better.id));
    assert_eq!(*statements.lock().unwrap(), ["BEGIN IMMEDIATE", "COMMIT"].repeat(3));
    assert_eq!(store.count(4.0, 4.0, 1.0).unwrap(), 3.0);
    // the leader it overtook was deleted in the same transaction
    assert!(store.get(first.id).unwrap().is_none());
}

#[test]
fn leaves_nothing_behind_when_it_fails_part_way() {
    let store = open(":memory:");
    store.submit(&submission(2.0)).unwrap();
    // the prune's delete fails after the insert and the count went in
    store.db().exec("CREATE TRIGGER fail BEFORE DELETE ON submissions BEGIN SELECT RAISE(ABORT, 'no'); END").unwrap();
    let failed = store.submit(&submission(1.0)).unwrap_err();
    assert!(failed.message().contains("no"));
    store.db().exec("DROP TRIGGER fail").unwrap();
    assert_eq!(store.count(4.0, 4.0, 1.0).unwrap(), 1.0);
    assert_eq!(store.leader(4.0, 4.0, 1.0).unwrap().map(|l| l.score), Some(2.0));
    // and the store goes on
    assert!(store.submit(&submission(1.0)).unwrap().kept);
}

// ---- describe("the problems of a name") -----------------------------------------------------------

fn named(n: f64, m: f64, p: f64, name: &str, verification: &str) -> NewSubmission {
    let mut e = entry(n, m, p, 1.0 + p, name);
    e.created_at = "2026-10-21T00:00:00Z".to_string();
    e.verification = verification.to_string();
    e
}

fn key(n: f64, m: f64, p: f64) -> ProblemKey {
    ProblemKey { n, m, p }
}

fn all(store: &SqliteStore, name: &str, limit: f64) -> Vec<ProblemKey> {
    let mut out: Vec<ProblemKey> = Vec::new();
    let mut after: Option<ProblemKey> = None;
    loop {
        let page = store.problems_named(name, after, limit).unwrap();
        out.extend(page.iter().copied());
        if (page.len() as f64) < limit {
            return out;
        }
        after = page.last().copied();
    }
}

#[test]
fn lists_each_problem_with_an_entry_of_exactly_that_name_once_in_order_of_n_m_p() {
    let store = open(":memory:");
    for e in [
        named(5.0, 3.0, 2.0, "ann", "none"),
        named(4.0, 4.0, 9.0, "ann", "none"),
        named(4.0, 4.0, 2.0, "ann", "none"),
        // behind another entry of the same problem, and of the same name: one problem
        named(4.0, 4.0, 2.0, "ann", "none"),
        named(0.0, 4.0, 7.0, "ann", "none"),
        named(4.0, 4.0, 2.0, "bob", "none"),
        // another case, trailing text, other characters
        named(4.0, 4.0, 1.0, "Ann", "none"),
        named(4.0, 4.0, 3.0, "ann ", "none"),
        named(4.0, 5.0, 3.0, "ann/bob", "none"),
        named(4.0, 6.0, 3.0, "ánn", "none"),
    ] {
        store.insert(&e).unwrap();
    }
    assert_eq!(all(&store, "ann", 1000.0), vec![key(0.0, 4.0, 7.0), key(4.0, 4.0, 2.0), key(4.0, 4.0, 9.0), key(5.0, 3.0, 2.0)]);
    assert_eq!(all(&store, "Ann", 1000.0), vec![key(4.0, 4.0, 1.0)]);
    assert_eq!(all(&store, "ann ", 1000.0), vec![key(4.0, 4.0, 3.0)]);
    assert_eq!(all(&store, "ann/bob", 1000.0), vec![key(4.0, 5.0, 3.0)]);
    assert_eq!(all(&store, "ánn", 1000.0), vec![key(4.0, 6.0, 3.0)]);
    assert_eq!(all(&store, "an", 1000.0), vec![]);
    assert_eq!(all(&store, "nobody", 1000.0), vec![]);
    // no wildcards, whatever the characters
    assert_eq!(all(&store, "a%", 1000.0), vec![]);
    assert_eq!(all(&store, "an_", 1000.0), vec![]);
}

#[test]
fn reads_a_page_at_a_time_after_the_problem_given() {
    let store = open(":memory:");
    let mut problems = Vec::new();
    for m in 4..=6 {
        for p in 1..=4 {
            store.insert(&named(4.0, m as f64, p as f64, "ann", "none")).unwrap();
            store.insert(&named(4.0, m as f64, p as f64, "bob", "none")).unwrap();
            problems.push(key(4.0, m as f64, p as f64));
        }
    }
    assert_eq!(store.problems_named("ann", None, 5.0).unwrap(), problems[0..5]);
    assert_eq!(store.problems_named("ann", Some(problems[4]), 5.0).unwrap(), problems[5..10]);
    assert_eq!(store.problems_named("ann", Some(problems[9]), 5.0).unwrap(), problems[10..]);
    assert_eq!(store.problems_named("ann", Some(problems[11]), 5.0).unwrap(), vec![]);
    for limit in [1.0, 3.0, 5.0, 12.0, 13.0] {
        assert_eq!(all(&store, "bob", limit), problems);
    }
    assert!(matches!(store.problems_named("ann", None, 0.0), Err(StoreError::Range(_))));
    assert!(matches!(store.problems_named("ann", None, 1.5), Err(StoreError::Range(_))));
}

#[test]
fn leaves_out_rejected_entries_which_older_databases_still_hold() {
    let store = open(":memory:");
    let gone = store.insert(&named(4.0, 4.0, 1.0, "ann", "none")).unwrap();
    store.insert(&named(4.0, 4.0, 2.0, "ann", "pending")).unwrap();
    store.insert(&named(4.0, 4.0, 3.0, "ann", "none")).unwrap();
    store.db().prepare("UPDATE submissions SET verification = 'rejected' WHERE id = ?").unwrap().run(&[gone.into()]).unwrap();
    assert_eq!(all(&store, "ann", 1000.0), vec![key(4.0, 4.0, 2.0), key(4.0, 4.0, 3.0)]);
}

#[test]
fn is_answered_from_the_index_of_names_alone_which_a_database_without_it_gains_on_opening() {
    let dir = TempDir::new("names");
    let path = dir.file("names.sqlite");
    let first = open(&path);
    first.insert(&named(4.0, 4.0, 1.0, "ann", "none")).unwrap();
    drop(first);
    let old = Connection::open(&path).unwrap();
    old.execute_batch("DROP INDEX submissions_name").unwrap();
    drop(old);
    let store = open(&path);
    let columns: Vec<String> = store
        .db()
        .prepare("PRAGMA index_info(submissions_name)")
        .unwrap()
        .all(&[])
        .unwrap()
        .iter()
        .map(|c| c.text("name").unwrap())
        .collect();
    // the name first, then the order of the pages; verification so that the listed-entries filter needs no row
    assert_eq!(columns, ["name", "n", "m", "p", "verification"]);
    assert_eq!(all(&store, "ann", 1000.0), vec![key(4.0, 4.0, 1.0)]);
    let plan = explain_plan(
        store.db().connection(),
        "SELECT n, m, p FROM submissions WHERE name = ? AND (n, m, p) > (?, ?, ?)
             AND verification != 'rejected' GROUP BY n, m, p ORDER BY n, m, p LIMIT ?",
    );
    assert_eq!(plan.len(), 1, "{plan:?}");
    assert!(plan[0].starts_with("SEARCH submissions USING COVERING INDEX submissions_name (name=?"), "{plan:?}");
    // the statement the store runs is that one: it prepares nothing else for a page
    let prepared: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&prepared);
    store.db().set_tracer(Some(Box::new(move |_, event| {
        if let TraceEvent::Prepare(sql) = event {
            seen.lock().unwrap().push(sql.to_string());
        }
        Ok(())
    })));
    store.problems_named("ann", None, 10.0).unwrap();
    let prepared = prepared.lock().unwrap();
    assert_eq!(prepared.len(), 1);
    assert!(prepared[0].contains("WHERE name = ? AND (n, m, p) > (?, ?, ?) AND verification != 'rejected'"));
}
