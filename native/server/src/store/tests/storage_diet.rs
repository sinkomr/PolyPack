//! apps/server/test/storage-diet.review.test.ts, case for case: the independent review of the
//! storage diet (pieces as BLOBs, only the leader kept, background migration). A reference model
//! of the keep rule is compared with the store after every operation, including operations
//! interleaved with migration steps on an older database. The source draws its cases with
//! fast-check; here the same kinds of cases come from a seeded generator.

use rusqlite::Connection;

use super::*;

/// One row as the reference model sees it.
#[derive(Clone, Debug, PartialEq)]
struct E {
    id: f64,
    p: u64,
    score: f64,
    v: &'static str,
    pieces: Vec<Pose>,
}

// near-ties around 1 (see SCORE_TIE), and clear gaps
fn scores() -> [f64; 8] {
    [1.0, 1.0 + 0.4 * SCORE_TIE, 1.0 + 0.9 * SCORE_TIE, 1.0 + 1.5 * SCORE_TIE, 1.0 - 0.5 * SCORE_TIE, 2.0, 0.5, 3.0]
}

/// The documented rule: earliest listed entry within SCORE_TIE of the smallest listed score.
fn leader_of(es: &[E]) -> Option<E> {
    let listed: Vec<&E> = es.iter().filter(|e| e.v != "rejected").collect();
    let lo = listed.iter().map(|e| e.score).fold(f64::INFINITY, f64::min);
    listed.into_iter().filter(|e| e.score <= lo * (1.0 + SCORE_TIE)).min_by(|a, b| a.id.total_cmp(&b.id)).cloned()
}

/// What a problem keeps: its leader, and behind a pending leader the leader among the others.
fn keepers(es: &[E]) -> Vec<E> {
    let Some(l) = leader_of(es) else {
        return Vec::new();
    };
    if l.v != "pending" {
        return vec![l];
    }
    let others: Vec<E> = es.iter().filter(|e| e.v != "pending").cloned().collect();
    match leader_of(&others) {
        Some(r) => vec![l, r],
        None => vec![l],
    }
}

fn poses_for(id: f64, p: u64) -> Vec<Pose> {
    poses(p as usize, id)
}

fn new_row(p: u64, score: f64, v: &str, id: f64) -> NewSubmission {
    let mut e = entry(4.0, 4.0, p as f64, score, &format!("e{id}"));
    e.pieces = poses_for(id, p);
    e.verification = v.to_string();
    e
}

/// (id, typeof(pieces)) of every row, by the store's own connection.
fn raw_rows(store: &SqliteStore) -> Vec<(f64, String)> {
    store
        .db()
        .prepare("SELECT id, p, typeof(pieces) AS kind FROM submissions ORDER BY id")
        .unwrap()
        .all(&[])
        .unwrap()
        .iter()
        .map(|r| (r.num("id").unwrap(), r.text("kind").unwrap()))
        .collect()
}

fn sorted(mut ids: Vec<f64>) -> Vec<f64> {
    ids.sort_by(f64::total_cmp);
    ids
}

fn all_rows(model: &[(u64, Vec<E>)]) -> Vec<E> {
    let mut all: Vec<E> = model.iter().flat_map(|(_, es)| es.iter().cloned()).collect();
    all.sort_by(|a, b| a.id.total_cmp(&b.id));
    all
}

fn rows_of(model: &mut Vec<(u64, Vec<E>)>, p: u64) -> &mut Vec<E> {
    if !model.iter().any(|(q, _)| *q == p) {
        model.push((p, Vec::new()));
    }
    &mut model.iter_mut().find(|(q, _)| *q == p).unwrap().1
}

// ---- describe("review: the keep rule on every live path") -----------------------------------------

#[test]
fn matches_the_reference_model_after_every_operation_never_changes_a_leader_by_pruning_and_keeps_the_fallback() {
    let mut rng = Rng::new(300);
    for _run in 0..300 {
        let store = open(":memory:");
        let mut model: Vec<(u64, Vec<E>)> = vec![(1, vec![]), (2, vec![]), (3, vec![])];
        let mut next = 1.0;
        // An operation on problem P = 1..3: a submission (as the app does it: leader, insert, leader,
        // prune), a review or a removal of the k-th row the model holds for that problem.
        for _ in 0..rng.int(0, 40) {
            let p = rng.int(1, 3);
            let rows = rows_of(&mut model, p).clone();
            if rng.int(0, 1) == 0 {
                let (score, v) = (rng.pick(&scores()), rng.pick(&["none", "pending"]));
                let id = store.insert(&new_row(p, score, v, next)).unwrap();
                assert_eq!(id, next);
                let mut all = rows.clone();
                all.push(E { id, p, score, v, pieces: poses_for(id, p) });
                next += 1.0;
                let before = store.leader(4.0, 4.0, p as f64).unwrap();
                assert_eq!(before.as_ref().map(|l| l.id), leader_of(&all).map(|l| l.id));
                let deleted = store.prune(4.0, 4.0, p as f64).unwrap();
                let kept = keepers(&all);
                assert_eq!(sorted(deleted), sorted(all.iter().filter(|e| !kept.contains(e)).map(|e| e.id).collect()));
                // pruning never changes who leads
                assert_eq!(store.leader(4.0, 4.0, p as f64).unwrap().map(|l| l.id), before.map(|l| l.id));
                // a pending leader keeps a fallback whenever an entry that is not pending was there
                if leader_of(&kept).is_some_and(|l| l.v == "pending") && all.iter().any(|e| e.v != "pending") {
                    assert_eq!(kept.len(), 2);
                }
                *rows_of(&mut model, p) = kept;
            } else {
                let kind = rng.pick(&["confirm", "reject", "remove"]);
                let target = rows.get(rng.int(0, 2) as usize).cloned();
                let id = target.as_ref().map_or(999_999.0, |t| t.id);
                let leader_before = leader_of(&rows);
                let ok = match kind {
                    "remove" => store.remove(id).unwrap(),
                    "confirm" => store.review(id, Decision::Confirmed).unwrap(),
                    _ => store.review(id, Decision::Rejected).unwrap(),
                };
                let applies = target.as_ref().is_some_and(|t| kind == "remove" || t.v == "pending" || t.v == "confirmed");
                assert_eq!(ok, applies);
                if applies {
                    let target = target.unwrap();
                    let rest: Vec<E> = if kind == "confirm" {
                        rows.iter().map(|e| if e.id == target.id { E { v: "confirmed", ..e.clone() } } else { e.clone() }).collect()
                    } else {
                        rows.iter().filter(|e| e.id != target.id).cloned().collect()
                    };
                    let kept = keepers(&rest);
                    // the leader only changes when it is the entry taken away
                    if leader_before.as_ref().map(|l| l.id) != Some(target.id) {
                        assert_eq!(leader_of(&kept).map(|l| l.id), leader_before.map(|l| l.id));
                    }
                    *rows_of(&mut model, p) = kept;
                }
            }
            // the store holds exactly what the model holds, pieces included
            let want = all_rows(&model);
            assert_eq!(raw_rows(&store), want.iter().map(|e| (e.id, "blob".to_string())).collect::<Vec<_>>());
            for e in &want {
                assert_eq!(stored_poses(&store.get(e.id).unwrap().unwrap()), e.pieces);
            }
        }
    }
}

/// A database as the deployed (older) server wrote it: JSON pieces, no meta table.
fn old_database(dir: &TempDir, rows: &[(u64, f64, &'static str, Vec<Pose>)]) -> String {
    let path = dir.file("old.sqlite");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{path}-wal"));
    let _ = std::fs::remove_file(format!("{path}-shm"));
    let db = Connection::open(&path).unwrap();
    db.execute_batch(OLD_SCHEMA).unwrap();
    {
        let mut add = db
            .prepare(
                "INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification)
     VALUES (4, 4, ?, ?, 'old', '', ?, 0, '2026-10-12T00:00:00Z', ?)",
            )
            .unwrap();
        for (p, score, v, pieces) in rows {
            add.execute(rusqlite::params![*p as f64, score, poses_json(pieces), v]).unwrap();
        }
    }
    db.execute_batch("INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions GROUP BY n, m, p").unwrap();
    path
}

// ---- describe("review: the migration interleaved with live operations") ---------------------------

#[test]
fn ends_with_every_row_a_blob_equal_to_its_old_json_and_every_problem_kept_by_the_rule() {
    let mut rng = Rng::new(200);
    let dir = TempDir::new("review");
    for _run in 0..200 {
        // up to three rows per problem, as the old code kept them, with every verification state
        let mut per_p = [0u32; 7];
        let mut rows: Vec<(u64, f64, &'static str)> = Vec::new();
        for _ in 0..rng.int(0, 18) {
            let (p, score, v) = (rng.int(1, 6), rng.pick(&scores()), rng.pick(&["none", "none", "pending", "confirmed", "rejected"]));
            per_p[p as usize] += 1;
            if per_p[p as usize] <= 3 {
                rows.push((p, score, v));
            }
        }
        let with_pieces: Vec<(u64, f64, &'static str, Vec<Pose>)> =
            rows.iter().enumerate().map(|(i, (p, score, v))| (*p, *score, *v, poses_for(i as f64 + 1.0, *p))).collect();
        let path = old_database(&dir, &with_pieces);
        // the model: every physical row per problem, rejected ones included until a prune
        let mut model: Vec<(u64, Vec<E>)> = Vec::new();
        for (i, (p, score, v, pieces)) in with_pieces.iter().enumerate() {
            rows_of(&mut model, *p).push(E { id: i as f64 + 1.0, p: *p, score: *score, v, pieces: pieces.clone() });
        }
        let prune = |model: &mut Vec<(u64, Vec<E>)>, p: u64| {
            let kept = keepers(rows_of(model, p));
            *rows_of(model, p) = kept;
        };
        let store = open(&path);
        let mut cursor = 0.0;
        let mut next = rows.len() as f64 + 1.0;
        let check = |model: &Vec<(u64, Vec<E>)>, cursor: f64| {
            let want = all_rows(model);
            let stored = raw_rows(&store);
            assert_eq!(stored.iter().map(|r| r.0).collect::<Vec<_>>(), want.iter().map(|e| e.id).collect::<Vec<_>>());
            // rows the cursor has passed are BLOBs
            for (id, kind) in &stored {
                if *id <= cursor {
                    assert_eq!(kind, "blob", "row {id}");
                }
            }
            for e in &want {
                assert_eq!(stored_poses(&store.get(e.id).unwrap().unwrap()), e.pieces);
            }
        };
        #[derive(Clone, Copy)]
        enum Act {
            Step(u64),
            Submit(u64, f64, &'static str),
            Change(&'static str, u64, u64),
        }
        let mut acts: Vec<Act> = (0..rng.int(0, 30))
            .map(|_| match rng.int(0, 2) {
                0 => Act::Step(rng.int(1, 4)),
                1 => Act::Submit(rng.int(1, 6), rng.pick(&scores()), rng.pick(&["none", "pending"])),
                _ => Act::Change(rng.pick(&["confirm", "reject", "remove"]), rng.int(1, 6), rng.int(0, 2)),
            })
            .collect();
        acts.extend(std::iter::repeat(Act::Step(3)).take(40));
        for a in acts {
            match a {
                Act::Step(batch) => {
                    let step = store.migrate_pieces(batch as f64).unwrap();
                    // the model's walk: the next `batch` rows by id after the cursor, each problem pruned once
                    let ahead: Vec<f64> =
                        all_rows(&model).iter().map(|e| e.id).filter(|id| *id > cursor).take(batch as usize).collect();
                    assert_eq!(step.done, ahead.is_empty());
                    let mut seen: Vec<u64> = Vec::new();
                    for id in ahead {
                        let e = all_rows(&model).into_iter().find(|x| x.id == id);
                        if let Some(e) = e {
                            if !seen.contains(&e.p) {
                                seen.push(e.p);
                                prune(&mut model, e.p);
                            }
                        }
                        cursor = id;
                    }
                    assert_eq!(step.cursor, cursor);
                }
                Act::Submit(p, score, v) => {
                    let id = store.insert(&new_row(p, score, v, next)).unwrap();
                    assert_eq!(id, next);
                    rows_of(&mut model, p).push(E { id, p, score, v, pieces: poses_for(id, p) });
                    next += 1.0;
                    store.prune(4.0, 4.0, p as f64).unwrap();
                    prune(&mut model, p);
                }
                Act::Change(kind, p, k) => {
                    let listed: Vec<E> = rows_of(&mut model, p).iter().filter(|e| e.v != "rejected").cloned().collect();
                    let target = listed.get(k as usize).cloned();
                    let id = target.as_ref().map_or(999_999.0, |t| t.id);
                    let ok = match kind {
                        "remove" => store.remove(id).unwrap(),
                        "confirm" => store.review(id, Decision::Confirmed).unwrap(),
                        _ => store.review(id, Decision::Rejected).unwrap(),
                    };
                    let applies = target.as_ref().is_some_and(|t| kind == "remove" || t.v == "pending" || t.v == "confirmed");
                    assert_eq!(ok, applies);
                    if applies {
                        let target = target.unwrap();
                        let rest: Vec<E> = rows_of(&mut model, p)
                            .iter()
                            .map(|e| if kind == "confirm" && e.id == target.id { E { v: "confirmed", ..e.clone() } } else { e.clone() })
                            .filter(|e| kind == "confirm" || e.id != target.id)
                            .collect();
                        *rows_of(&mut model, p) = rest;
                        prune(&mut model, p);
                    }
                }
            }
            check(&model, cursor);
        }
        assert!(store.pieces_migrated().unwrap());
        for (_, kind) in raw_rows(&store) {
            assert_eq!(kind, "blob");
        }
    }
}

// ---- describe("review: pruning a database written by the old code") -------------------------------

// The old code kept three rows per problem regardless of who led. Here: R (not pending), then a
// claim L just below the published value, then a better claim X within the tolerance of L.
// L leads (earliest within SCORE_TIE of X). R is kept behind it, X is deleted, and then R is
// within the tolerance of the new smallest score (L's) and earlier: R leads, and the next prune
// deletes the claim L, unreviewed.
fn two_claims(dir: &TempDir) -> String {
    let rows = [(3, 1.0 + 1.5 * SCORE_TIE, "none"), (3, 1.0 + 0.9 * SCORE_TIE, "pending"), (3, 1.0, "pending")];
    let with_pieces: Vec<(u64, f64, &'static str, Vec<Pose>)> =
        rows.iter().enumerate().map(|(i, (p, score, v))| (*p, *score, *v, poses_for(i as f64 + 1.0, 3))).collect();
    old_database(dir, &with_pieces)
}

// Known limitation, accepted on 2026-10-19: only a database written by the old code can hold two
// pending claims of one problem, and the live database had none when the migration was deployed.
// New code never keeps a second claim. The source marks these two tests `it.fails`: their bodies
// state what should hold and does not. Here each asserts what the store does instead, so that the
// port has the same limitation and a change of it is noticed.
#[test]
fn it_fails_does_not_change_the_leader_when_the_migration_prunes_the_problem() {
    let dir = TempDir::new("review");
    let store = open(&two_claims(&dir));
    let before = store.leader(4.0, 4.0, 3.0).unwrap().map(|l| l.id);
    assert_eq!(before, Some(2.0));
    store.migrate_pieces(100.0).unwrap();
    // the source's failing expectation: the leader is still `before`
    assert_eq!(store.leader(4.0, 4.0, 3.0).unwrap().map(|l| l.id), Some(1.0));
}

#[test]
fn it_fails_keeps_the_pending_claim_that_led_before_the_migration() {
    let dir = TempDir::new("review");
    let store = open(&two_claims(&dir));
    store.migrate_pieces(100.0).unwrap();
    // any later prune of the problem (a submission, a review elsewhere in it)
    store.prune(4.0, 4.0, 3.0).unwrap();
    // the source's failing expectation: entry 2 is still there
    assert!(store.get(2.0).unwrap().is_none());
}

// ---- describe("review: stored pieces that cannot be decoded") -------------------------------------

/// The source asks the app for the entry and gets status 500, and 500 for any atlas range that
/// includes it: the store's `get` and `getMany` throw. The statuses are the HTTP layer's; the
/// throws are checked here.
#[test]
fn answers_a_malformed_blob_with_an_error_rather_than_a_crash_of_the_process() {
    let store = open(":memory:");
    let id = store.insert(&new_row(2, 2.0, "none", 1.0)).unwrap();
    let bytes = [0u8; 23];
    store.db().prepare("UPDATE submissions SET pieces = ? WHERE id = ?").unwrap().run(&[(&bytes[..]).into(), id.into()]).unwrap();
    let e = store.get(id).unwrap_err();
    assert!(matches!(e, StoreError::Range(_)));
    assert_eq!(e.message(), "stored pieces have 23 bytes, not a multiple of 24");
    assert!(matches!(store.get_many(&[id]), Err(StoreError::Range(_))));
    // the listing of the pair reads no pieces, so the atlas fails only when it fetches the entry
    assert_eq!(store.best_per_p(4.0, 4.0, false).unwrap().len(), 1);
}
