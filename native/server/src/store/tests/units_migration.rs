//! apps/server/test/units-migration.test.ts, case for case.

use serde_json::{json, Value};

use super::*;

// awkward doubles: halving and doubling must keep every bit
const A: f64 = 0.1 + 0.2;
const B: f64 = 1.0 / 3.0;

fn pieces_of(xs: &[f64]) -> Vec<u8> {
    encode_pieces(&xs.iter().enumerate().map(|(i, &x)| Pose { x, y: x * B + i as f64, theta: A * i as f64 }).collect::<Vec<_>>())
}

/// A database as it was before the unit change: radius-1 disks and balls, no epoch marker. Returns
/// its path and a second connection to it, as the source's helper does.
fn old_database(dir: &TempDir) -> (String, Db) {
    let path = dir.file("db.sqlite");
    drop(open(&path)); // creates every table (and, being new, marks the epoch)
    let db = Db::open(&path).unwrap();
    db.exec("DELETE FROM meta WHERE key = 'units_epoch'").unwrap();
    {
        let mut sub = db
            .prepare(
                "INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification, literature_value, strict_check)
     VALUES (?, ?, ?, ?, 'ann', '', ?, 0, '2026-10-20T00:00:00Z', ?, ?, ?)",
            )
            .unwrap();
        let mut add = |n: f64, m: f64, p: f64, score: f64, xs: &[f64], v: &str, lit: Option<f64>, strict: Option<&str>| {
            let blob = pieces_of(xs);
            sub.run(&[n.into(), m.into(), p.into(), score.into(), (&blob).into(), v.into(), lit.into(), strict.into()]).unwrap();
        };
        // disks in a circle: score unchanged, pieces halved
        add(0.0, 0.0, 2.0, 3.0 + A, &[0.0, 2.0 + A], "none", None, None);
        // disks in a square: score and pieces halved; a pending entry with its literature value and certificate
        let cert = json::stringify(&json!({ "ok": true, "certifiedSize": 5.25, "eps": 1e-8 }));
        add(0.0, 4.0, 3.0, 5.0 + B, &[0.0, 2.0, 4.0], "pending", Some(5.5), Some(&cert));
        // squares in a circle: pieces unchanged, score doubled
        add(4.0, 0.0, 2.0, 2.0 + A, &[0.0, 1.5], "none", None, None);
        // squares in a square: untouched
        add(4.0, 4.0, 2.0, 2.0 + B, &[0.0, 1.0], "none", None, None);
        // a leader and a worse entry of one problem: the order must survive
        add(0.0, 5.0, 2.0, 7.0, &[0.0, 3.0], "none", None, None);
        add(0.0, 5.0, 2.0, 6.0 + B, &[0.0, 2.9], "none", None, None);
    }
    // an old entry that still has its pieces as JSON text
    db.prepare(
        "INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification)
     VALUES (0, 6, 1, 4, 'jay', '', ?, 0, '2026-10-01T00:00:00Z', 'none')",
    )
    .unwrap()
    .run(&[r#"[{"x":1,"y":2,"theta":0}]"#.into()])
    .unwrap();
    {
        let mut ent = db
            .prepare("INSERT INTO space_entries (space, problem, score, name, agent_note, created_at, config) VALUES (?, ?, ?, 'ann', '', '2026-10-20T00:00:00Z', ?)")
            .unwrap();
        let mut put = |space: &str, problem: &str, score: f64, config: Value| {
            let text = json::stringify(&config);
            ent.run(&[space.into(), problem.into(), score.into(), (&text).into()]).unwrap();
        };
        let poses = json!([[0, 0, 0], [A, B, 1]]);
        put("torus", "torus/sq/0/2", 4.0, json!({ "lattice": { "L": 4 }, "poses": poses }));
        put("torus", "torus/free/0/2", 3.0, json!({ "lattice": { "b1": [3, 0], "b2": [1, 3] }, "poses": poses }));
        put("torus", "torus/sq/4/2", 5.0, json!({ "lattice": { "L": 5 }, "poses": poses }));
        put("sphere", "sphere/0/3", 1.5, json!({ "rho": 1.5, "pieces": [{ "q": [1, 0, 0, 0] }] }));
        put("sphere", "sphere/4/3", 1.25, json!({ "rho": 1.25, "pieces": [{ "q": [1, 0, 0, 0] }] }));
        put("surface", "surface/cube/fold/0/3", 2.0 + A, json!({ "s": 2.0 + A, "pieces": [{ "face": 1, "x": A, "y": B, "theta": 2 }] }));
        put("boundary", "boundary/tesseract/ball/3", 6.0, json!({ "s": 6, "pieces": [{ "cell": 2, "u": [A, B, 1] }] }));
        put("boundary", "boundary/tesseract/cube/3", 7.0, json!({ "s": 7, "pieces": [{ "cell": 2, "u": [A, B, 1], "q": [1, 0, 0, 0] }] }));
        put("balls", "balls/ballinball/3", 5.0, json!({ "s": 5, "pieces": [[A, B, 1]] }));
        put("balls", "balls/ballincub/3", 6.0, json!({ "s": 6, "pieces": [[A, B, 1]] }));
        put("balls", "balls/cubinball/2", 2.8 / 2.0, json!({ "s": 1.4, "pieces": [[0.6, 0, 0, 1, 0, 0, 0]] }));
        put("curved", "curved/0/0/4/2", 5.0, json!({ "size": 5, "pieces": [{ "x": A, "y": B, "theta": 1 }] }));
        put("curved", "curved/0/0/0/2", 3.0, json!({ "size": 3, "pieces": [{ "x": A, "y": B, "theta": 1 }] }));
        put("curved", "curved/-1/3/0/2", 1.25, json!({ "size": 1.25, "pieces": [{ "x": A, "y": B, "theta": 1 }] }));
        put("curved", "curved/1/0/0/2", 2.0, json!({ "size": 2, "pieces": [{ "x": A, "y": B, "theta": 1 }] }));
        put("curved", "curved/-1/0/4/2", 6.0, json!({ "size": 6, "pieces": [{ "x": A, "y": B, "theta": 1 }] }));
        put("curved", "curved/1/3/4/2", 2.0, json!({ "size": 2, "pieces": [{ "x": A, "y": B, "theta": 1 }] }));
    }
    (path, db)
}

/// One row of submissions, as the tests read it.
struct Sub {
    id: f64,
    score: f64,
    literature_value: Option<f64>,
    strict_check: Option<String>,
    pieces: JsVal,
}
impl Sub {
    fn poses(&self) -> Vec<Pose> {
        read_pieces(&self.pieces).unwrap().poses().unwrap()
    }
    fn xs(&self) -> Vec<f64> {
        self.poses().iter().map(|p| p.x).collect()
    }
}

fn sub(db: &Db, n: f64, m: f64, p: f64) -> Vec<Sub> {
    db.prepare("SELECT * FROM submissions WHERE n = ? AND m = ? AND p = ? ORDER BY id")
        .unwrap()
        .all(&[n.into(), m.into(), p.into()])
        .unwrap()
        .iter()
        .map(|r| Sub {
            id: r.num("id").unwrap(),
            score: r.num("score").unwrap(),
            literature_value: r.num_or_null("literature_value").unwrap(),
            strict_check: r.text_or_null("strict_check").unwrap(),
            pieces: r.get("pieces").clone(),
        })
        .collect()
}

/// The score and the parsed config of the entry of a problem; None when it has none.
fn space_entry(db: &Db, problem: &str) -> Option<(f64, Value)> {
    let r = db.prepare("SELECT score, config FROM space_entries WHERE problem = ?").unwrap().get(&[problem.into()]).unwrap()?;
    Some((r.num("score").unwrap(), json::parse(&r.text("config").unwrap()).unwrap()))
}

/// Deep equality of JSON by value, as toEqual compares numbers (3 equals 3.0).
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_json(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w))),
        _ => a == b,
    }
}
#[track_caller]
fn assert_json(got: &Value, want: Value) {
    assert!(same_json(got, &want), "{got} is not {want}");
}

fn count(db: &Db, table: &str) -> f64 {
    db.prepare(&format!("SELECT COUNT(*) AS c FROM {table}")).unwrap().get(&[]).unwrap().unwrap().num("c").unwrap()
}

fn migrate(db: &Db, reverse: bool) -> Result<UnitsReport> {
    migrate_units(db, reverse, &TestSpaceIds::load(), &SystemClock::new())
}

#[test]
fn has_the_exact_factors_of_each_class() {
    let spaces = TestSpaceIds::load();
    assert_eq!(planar_factors(0.0, 0.0), Some(PlanarFactors { len: 0.5, score: 1.0 }));
    assert_eq!(planar_factors(0.0, 7.0), Some(PlanarFactors { len: 0.5, score: 0.5 }));
    assert_eq!(planar_factors(9.0, 0.0), Some(PlanarFactors { len: 1.0, score: 2.0 }));
    assert_eq!(planar_factors(4.0, 4.0), None);
    let score = |space: &str, id: &str| match space_plan(&spaces, space, id) {
        SpacePlanResult::Plan(plan) => Some(plan.score),
        _ => None,
    };
    assert_eq!(space_plan(&spaces, "polyhedra", "polyhedra/cubincub/8"), SpacePlanResult::Unaffected);
    assert_eq!(space_plan(&spaces, "curved", "curved/1/0/0/2"), SpacePlanResult::Archived);
    assert_eq!(score("curved", "curved/0/0/0/2"), Some(1.0));
    assert_eq!(score("balls", "balls/ballinball/3"), Some(1.0));
    assert_eq!(score("balls", "balls/ballincub/3"), Some(0.5));
    assert_eq!(score("balls", "balls/cubinball/3"), Some(2.0));
}

#[test]
fn converts_a_database_at_start_up_exactly_in_one_transaction_that_marks_the_epoch() {
    let dir = TempDir::new("units");
    let (path, db) = old_database(&dir);
    let before = units_digest(&db).unwrap();
    assert_eq!(units_epoch(&db).unwrap(), 0.0);
    let (store, logs) = open_logged(&path);
    let report = store.units_report.as_ref().expect("a report");
    assert_eq!(report.action, "forward");
    assert_json(&Value::Object(report.submissions.clone()), json!({ "n=0 m=0": 1, "n=0 m=>=3": 4, "n=>=3 m=0": 1 }));
    assert_eq!((report.archived, report.unreadable), (2.0, 0.0));
    assert!(logs[0].starts_with("units: converted to diameter units"));
    assert_eq!(units_epoch(&db).unwrap(), 2.0);
    assert_ne!(units_digest(&db).unwrap(), before);

    // 2D: disks in a circle keep their score, their pieces halve; theta is untouched
    let circle = &sub(&db, 0.0, 0.0, 2.0)[0];
    assert_eq!(circle.score, 3.0 + A);
    assert_eq!(
        circle.poses(),
        vec![Pose { x: 0.0, y: 0.0, theta: 0.0 }, Pose { x: (2.0 + A) / 2.0, y: ((2.0 + A) * B + 1.0) / 2.0, theta: A }]
    );
    // disks in a square: everything halves, the pending entry's literature value and certificate with it
    let square = &sub(&db, 0.0, 4.0, 3.0)[0];
    assert_eq!(square.score, (5.0 + B) / 2.0);
    assert_eq!(square.literature_value, Some(2.75));
    assert_json(&json::parse(square.strict_check.as_ref().unwrap()).unwrap(), json!({ "ok": true, "certifiedSize": 2.625, "eps": 1e-8 }));
    assert_eq!(square.xs(), vec![0.0, 1.0, 2.0]);
    // polygons in a circle: the score doubles, the pieces stay
    let polygon = &sub(&db, 4.0, 0.0, 2.0)[0];
    assert_eq!(polygon.score, 2.0 * (2.0 + A));
    assert_eq!(polygon.xs(), vec![0.0, 1.5]);
    // polygons in a polygon: not touched
    assert_eq!(sub(&db, 4.0, 4.0, 2.0)[0].score, 2.0 + B);
    // the JSON-text entry came out as a BLOB, halved
    let text = &sub(&db, 0.0, 6.0, 1.0)[0];
    assert!(matches!(text.pieces, JsVal::Blob(_)));
    assert_eq!(text.poses(), vec![Pose { x: 0.5, y: 1.0, theta: 0.0 }]);
    // leader order of a problem survives, and the store reads it
    let pair = sub(&db, 0.0, 5.0, 2.0);
    let (lead, worse) = (&pair[0], &pair[1]);
    assert!(worse.score < lead.score);
    assert_eq!(lead.xs(), vec![0.0, 1.5]);

    // the spaces
    let entry = |problem: &str| space_entry(&db, problem);
    let (score, config) = entry("torus/sq/0/2").unwrap();
    assert_eq!(score, 2.0);
    assert_json(&config, json!({ "lattice": { "L": 2 }, "poses": [[0, 0, 0], [A / 2.0, B / 2.0, 1]] }));
    assert_json(&entry("torus/free/0/2").unwrap().1["lattice"], json!({ "b1": [1.5, 0], "b2": [0.5, 1.5] }));
    let (score, config) = entry("torus/sq/4/2").unwrap();
    assert_eq!(score, 5.0);
    assert_json(&config, json!({ "lattice": { "L": 5 }, "poses": [[0, 0, 0], [A, B, 1]] }));
    let (score, config) = entry("sphere/0/3").unwrap();
    assert_eq!((score, config["rho"].as_f64()), (0.75, Some(0.75)));
    assert_eq!(entry("sphere/4/3").unwrap().0, 1.25);
    assert_json(&entry("surface/cube/fold/0/3").unwrap().1, json!({ "s": (2.0 + A) / 2.0, "pieces": [{ "face": 1, "x": A / 2.0, "y": B / 2.0, "theta": 2 }] }));
    let (score, config) = entry("boundary/tesseract/ball/3").unwrap();
    assert_eq!(score, 3.0);
    assert_json(&config, json!({ "s": 3, "pieces": [{ "cell": 2, "u": [A / 2.0, B / 2.0, 0.5] }] }));
    assert_eq!(entry("boundary/tesseract/cube/3").unwrap().0, 7.0);
    // balls in a ball: the diameter is the old radius; in a cube: halves; cubes in a ball: the diameter doubles
    let (score, config) = entry("balls/ballinball/3").unwrap();
    assert_eq!(score, 5.0);
    assert_json(&config, json!({ "s": 5, "pieces": [[A / 2.0, B / 2.0, 0.5]] }));
    let (score, config) = entry("balls/ballincub/3").unwrap();
    assert_eq!(score, 3.0);
    assert_json(&config, json!({ "s": 3, "pieces": [[A / 2.0, B / 2.0, 0.5]] }));
    let (score, config) = entry("balls/cubinball/2").unwrap();
    assert_eq!(score, 2.8);
    assert_json(&config, json!({ "s": 2.8, "pieces": [[0.6, 0, 0, 1, 0, 0, 0]] }));
    // curved: flat disks convert, polygons in a circle double at any K, polygons elsewhere stay
    assert_json(&entry("curved/0/0/4/2").unwrap().1, json!({ "size": 2.5, "pieces": [{ "x": A / 2.0, "y": B / 2.0, "theta": 1 }] }));
    let (score, config) = entry("curved/0/0/0/2").unwrap();
    assert_eq!((score, config["size"].as_f64()), (3.0, Some(3.0)));
    let (score, config) = entry("curved/-1/3/0/2").unwrap();
    assert_eq!(score, 2.5);
    assert_json(&config, json!({ "size": 2.5, "pieces": [{ "x": A, "y": B, "theta": 1 }] }));
    assert_eq!(entry("curved/1/3/4/2").unwrap().0, 2.0);
    // and the disks at K = +-1, which have no equivalent at the same K, are set aside rather than served
    assert!(entry("curved/1/0/0/2").is_none());
    assert!(entry("curved/-1/0/4/2").is_none());
    assert_eq!(count(&db, "space_entries_units_archive"), 2.0);
    assert_eq!(count(&db, "space_entries"), 15.0);
}

#[test]
fn runs_once_a_second_start_and_a_second_call_change_nothing() {
    let dir = TempDir::new("units");
    let (path, db) = old_database(&dir);
    drop(open(&path));
    let once = units_digest(&db).unwrap();
    let again = open(&path);
    assert!(again.units_report.is_none());
    assert_eq!(migrate(&db, false).unwrap().action, "none");
    assert_eq!(units_digest(&db).unwrap(), once);
    assert_eq!(units_epoch(&db).unwrap(), 2.0);
}

#[test]
fn reverses_exactly_every_row_bit_for_bit_and_the_archived_entries_come_back() {
    let dir = TempDir::new("units");
    let (path, db) = old_database(&dir);
    let original = units_digest(&db).unwrap();
    drop(open(&path));
    let report = migrate(&db, true).unwrap();
    assert_eq!((report.action.as_str(), report.restored), ("reverse", 2.0));
    assert_eq!(units_epoch(&db).unwrap(), 1.0);
    // the row that held JSON text came back as a BLOB: compare it by value, the rest by digest
    let text = &sub(&db, 0.0, 6.0, 1.0)[0];
    assert_eq!(text.poses(), vec![Pose { x: 1.0, y: 2.0, theta: 0.0 }]);
    db.prepare("UPDATE submissions SET pieces = ? WHERE id = ?")
        .unwrap()
        .run(&[r#"[{"x":1,"y":2,"theta":0}]"#.into(), text.id.into()])
        .unwrap();
    assert_eq!(units_digest(&db).unwrap(), original);
    assert_eq!(space_entry(&db, "curved/1/0/0/2").unwrap().0, 2.0);
    // and forward again
    assert_eq!(migrate(&db, false).unwrap().action, "forward");
    assert_eq!(units_epoch(&db).unwrap(), 2.0);
    assert_eq!(migrate(&db, true).unwrap().action, "reverse");
    assert_eq!(migrate(&db, true).unwrap().action, "none");
}

#[test]
fn rolls_back_whole_when_the_conversion_fails_midway_leaving_the_old_units_and_no_marker() {
    let dir = TempDir::new("units");
    let (_path, db) = old_database(&dir);
    db.exec("INSERT INTO space_entries (space, problem, score, name, agent_note, created_at, config) VALUES ('torus', 'torus/sq/0/3', 1, 'x', '', 'now', '{\"lattice\":{\"L\":1},\"poses\":[]}')").unwrap();
    let before = units_digest(&db).unwrap();
    db.exec("CREATE TRIGGER boom BEFORE UPDATE ON space_entries BEGIN SELECT RAISE(ABORT, 'boom'); END").unwrap();
    let failed = migrate(&db, false).unwrap_err();
    assert!(failed.message().contains("boom"));
    assert_eq!(units_epoch(&db).unwrap(), 0.0);
    assert_eq!(units_digest(&db).unwrap(), before);
    // still not converted: it tries again
    assert!(apply_units(&db, false, &TestSpaceIds::load(), &SystemClock::new()).is_err());
}

#[test]
fn marks_a_new_database_as_converted_and_leaves_it_alone() {
    let dir = TempDir::new("units");
    let path = dir.file("db.sqlite");
    let store = open(&path);
    assert!(store.units_report.is_none());
    assert_eq!(units_epoch(&Db::open(&path).unwrap()).unwrap(), 2.0);
}
