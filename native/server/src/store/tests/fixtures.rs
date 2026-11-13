//! Answers of the TypeScript, written by `node --import tsx native/tools/store-ref.mts fixtures
//! native/server/tests/fixtures/store`, so that `cargo test` checks the port without Node.

use serde_json::Value;

use super::*;

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).expect("the fixture")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `JSON.stringify(JSON.parse(text))`, or a refusal, for texts of every kind: numbers of every size
/// and form, escapes, keys that are array indices, and what JSON.parse refuses.
#[test]
fn json_reads_and_writes_as_javascript() {
    let cases = fixture(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/store/json-roundtrip.json")));
    let cases = cases.as_array().unwrap();
    assert!(cases.len() > 300);
    let (mut read, mut refused) = (0, 0);
    for c in cases {
        let text = c["text"].as_str().unwrap();
        match (json::parse(text), c["out"].as_str()) {
            (Ok(v), Some(out)) => {
                assert_eq!(json::stringify(&v), out, "{text:?}");
                read += 1;
            }
            (Err(StoreError::Syntax(_)), None) => refused += 1,
            (got, want) => panic!("{text:?}: {got:?}, the TypeScript gives {want:?}"),
        }
    }
    assert!(read > 300 && refused > 25, "{read} read, {refused} refused");
}

#[test]
fn blob_from_json_as_the_typescript() {
    let cases = fixture(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/store/blob-from-json.json")));
    for c in cases.as_array().unwrap() {
        let text = c["text"].as_str().unwrap();
        assert_eq!(blob_from_json(text).map(|b| hex(&b)), c["blob"].as_str().map(str::to_string), "{text:?}");
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex")).collect()
}

/// packPieces of triples of several kinds (nothing, a few scattered pieces, lattices, mixtures, and
/// the padded form) gives the bytes the TypeScript stores, and unpackPieces reads or refuses hand-made
/// values as it does, with its message.
#[test]
fn packs_and_unpacks_pieces_as_the_typescript() {
    let f = fixture(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/store/pieces-packed.json")));
    let (mut packed, mut kept, mut padded) = (0, 0, 0);
    for c in f["packed"].as_array().unwrap() {
        let triples = unhex(c["triples"].as_str().unwrap());
        let stored = pack_pieces(triples.clone()).unwrap();
        assert_eq!(hex(&stored), c["stored"].as_str().unwrap(), "{} bytes of triples", triples.len());
        assert_eq!(unpack_pieces(&stored).unwrap().as_ref(), &triples[..]);
        assert_eq!(decode_pieces(&stored).unwrap(), decode_pieces(&triples).unwrap());
        match (stored.len() % PIECE_BYTES == 0, stored.first()) {
            (true, _) => kept += 1,
            (false, Some(2)) => padded += 1,
            (false, _) => packed += 1,
        }
    }
    assert!(packed >= 7 && kept >= 4 && padded >= 6, "{packed} packed, {kept} kept as triples, {padded} padded");
    let (mut read, mut refused) = (0, 0);
    for c in f["unpacked"].as_array().unwrap() {
        let value = unhex(c["value"].as_str().unwrap());
        match (unpack_pieces(&value), c["triples"].as_str(), c["error"].as_str()) {
            (Ok(triples), Some(want), None) => {
                assert_eq!(hex(&triples), want);
                read += 1;
            }
            (Err(e), None, Some(want)) => {
                assert_eq!(format!("{}: {}", e.name(), e.message()), want);
                refused += 1;
            }
            (got, _, want) => panic!("{} bytes: {:?}, the TypeScript gives {want:?}", value.len(), got.map(|t| t.len())),
        }
    }
    assert!(read >= 3 && refused >= 14, "{read} read, {refused} refused");
}

#[test]
fn encodes_awkward_doubles_to_the_same_bytes() {
    let f = fixture(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/store/pieces-awkward.json")));
    let awkward = vec![
        Pose { x: -0.0, y: 0.0, theta: -0.0 },
        Pose { x: 1e6, y: -1e6, theta: std::f64::consts::PI },
        Pose { x: 5e-324, y: -5e-324, theta: 5e-324 },
        Pose { x: 0.1 + 0.2, y: 1.0 / 3.0, theta: -std::f64::consts::PI / 4.0 },
        Pose { x: f64::MAX, y: -f64::MAX, theta: 1e308 },
        Pose { x: 999999.9999999999, y: -2.2250738585072014e-308, theta: 123456.789 },
    ];
    assert_eq!(hex(&encode_pieces(&awkward)), f["hex"].as_str().unwrap());
    // and a list of poses is written to JSON as JavaScript writes it
    assert_eq!(poses_json(&awkward), f["json"].as_str().unwrap());
    assert_eq!(polypack_js::json::stringify(&Pieces::Poses(awkward)), f["json"].as_str().unwrap());
}

/// spacePlan for every kind of problem id, by what its `apply` does to two probe configurations,
/// and planarFactors.
#[test]
fn plans_of_the_unit_change_as_the_typescript() {
    let spaces = TestSpaceIds::load();
    let f = fixture(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/store/units-plans.json")));
    let probe = || {
        json::parse(r#"{"s":8,"size":8,"rho":8,"lattice":{"L":8,"b1":[8,8],"b2":[8,8]},"poses":[[8,8,8]],"pieces":[{"x":8,"y":8,"theta":8,"u":[8,8,8]}]}"#)
            .unwrap()
    };
    let probe_list = || json::parse(r#"{"s":8,"pieces":[[8,8,8,8]]}"#).unwrap();
    let mut kinds = [0, 0, 0];
    for c in f["plans"].as_array().unwrap() {
        let (space, id) = (c["space"].as_str().unwrap(), c["id"].as_str().unwrap());
        match (space_plan(&spaces, space, id), &c["plan"]) {
            (SpacePlanResult::Unaffected, Value::Null) => kinds[0] += 1,
            (SpacePlanResult::Archived, Value::String(s)) if s == "archive" => kinds[1] += 1,
            (SpacePlanResult::Plan(plan), Value::Object(want)) => {
                kinds[2] += 1;
                assert_eq!(Some(plan.score), want["score"].as_f64(), "{id}");
                assert_eq!(Some(plan.label), want["label"].as_str(), "{id}");
                let (mut a, mut b) = (probe(), probe_list());
                plan.apply(a.as_object_mut().unwrap());
                plan.apply(b.as_object_mut().unwrap());
                assert_eq!(json::stringify(&a), json::stringify(&want["probe"]), "{id}");
                assert_eq!(json::stringify(&b), json::stringify(&want["probeList"]), "{id}");
            }
            (got, want) => panic!("{id}: {got:?}, the TypeScript gives {want}"),
        }
    }
    assert!(kinds[0] >= 5 && kinds[1] >= 2 && kinds[2] >= 12, "{kinds:?}");
    for c in f["planar"].as_array().unwrap() {
        let got = planar_factors(c["N"].as_f64().unwrap(), c["M"].as_f64().unwrap());
        let want = c["factors"].as_object().map(|o| PlanarFactors { len: o["len"].as_f64().unwrap(), score: o["score"].as_f64().unwrap() });
        assert_eq!(got, want, "{c}");
    }
}

/// What a new database holds. (The schema text itself, which SQLite stores in the file, is compared
/// byte for byte with the TypeScript's by `store-compare.mjs db`.)
#[test]
fn a_new_database_has_every_table_and_index_and_both_markers() {
    let store = open(":memory:");
    let names: Vec<(String, String)> = store
        .db()
        .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .unwrap()
        .all(&[])
        .unwrap()
        .iter()
        .map(|r| (r.text("type").unwrap(), r.text("name").unwrap()))
        .collect();
    let names: Vec<(&str, &str)> = names.iter().map(|(t, n)| (t.as_str(), n.as_str())).collect();
    assert_eq!(
        names,
        [
            ("index", "space_entries_listing"),
            ("index", "submissions_listing"),
            ("index", "submissions_name"),
            ("index", "submissions_verification"),
            ("table", "holder_peaks"),
            ("table", "meta"),
            ("table", "space_entries"),
            ("table", "submissions"),
            ("table", "tallies"),
        ]
    );
    assert!(store.pieces_migrated().unwrap());
    assert_eq!(store.units_epoch().unwrap(), 2.0);
    assert!(store.units_report.is_none());
}

/// While another connection holds the write lock, a write is refused at once ("database is locked":
/// node:sqlite sets no busy timeout, and neither does `Db::open`), a read is served, and the store
/// goes on when the lock is released. The outcomes below are those of the TypeScript store, made to
/// do the same (2026-11-10, Node 26.5).
#[test]
fn refuses_a_write_at_once_while_another_connection_holds_the_lock() {
    let dir = TempDir::new("lock");
    let path = dir.file("lock.sqlite");
    let store = open(&path);
    let other = rusqlite::Connection::open(&path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let e = entry(4.0, 4.0, 1.0, 2.0, "a");
    let space = NewSpaceEntry {
        space: "s".into(),
        problem: "p".into(),
        score: 1.0,
        name: "n".into(),
        agent_note: String::new(),
        software: None,
        method: None,
        seed: None,
        config: "{}".into(),
        created_at: "t".into(),
    };
    let started = std::time::Instant::now();
    let locked = |r: Result<()>| {
        let e = r.unwrap_err();
        assert_eq!((e.name(), e.message().as_str()), ("Error", "database is locked"));
    };
    locked(store.submit(&e).map(|_| ()));
    locked(store.insert(&e).map(|_| ()));
    assert_eq!(store.leader(4.0, 4.0, 1.0).unwrap(), None);
    locked(store.raise_holder_peaks(&[HolderPeak { name: "a".into(), peak: 1.0 }]));
    locked(store.remove(1.0).map(|_| ()));
    locked(store.migrate_pieces(5.0).map(|_| ()));
    locked(store.space_submit(&space).map(|_| ()));
    assert!(started.elapsed().as_millis() < 500, "a refusal waited {:?}", started.elapsed());
    other.execute_batch("COMMIT").unwrap();
    let after = store.submit(&e).unwrap();
    assert_eq!((after.id, after.position, after.kept), (1.0, 1.0, true));
}

/// The settings of the connection, as node:sqlite's `new DatabaseSync(path)` has them after the
/// store's `PRAGMA journal_mode = WAL` (read from the TypeScript store's connection, 2026-11-10).
#[test]
fn the_connection_has_the_settings_of_the_typescript_store() {
    let dir = TempDir::new("settings");
    let store = open(&dir.file("settings.sqlite"));
    let pragma = |name: &str| store.db().prepare(&format!("PRAGMA {name}")).unwrap().get(&[]).unwrap().unwrap().values()[0].clone();
    assert_eq!(pragma("synchronous"), JsVal::Num(2.0));
    assert_eq!(pragma("foreign_keys"), JsVal::Num(1.0));
    assert_eq!(pragma("busy_timeout"), JsVal::Num(0.0));
    assert_eq!(pragma("wal_autocheckpoint"), JsVal::Num(1000.0));
    assert_eq!(pragma("cache_size"), JsVal::Num(-2000.0));
    assert_eq!(pragma("journal_mode"), JsVal::Text("wal".into()));
    assert_eq!(pragma("locking_mode"), JsVal::Text("normal".into()));
    assert_eq!(pragma("temp_store"), JsVal::Num(0.0));
    assert_eq!(pragma("secure_delete"), JsVal::Num(0.0));
}

/// node:sqlite refuses to read an INTEGER beyond 2^53 - 1 as a number ("RangeError: Value is too
/// large to be represented as a JavaScript number: N"), for any column of a row it returns. Only a
/// hand-made row can hold one: the server binds every number as a double.
#[test]
fn refuses_to_read_an_integer_that_a_javascript_number_cannot_hold() {
    let store = open(":memory:");
    let ok = store.insert(&entry(4.0, 4.0, 1.0, 1.0, "a")).unwrap();
    let big = store.insert(&entry(4.0, 4.0, 2.0, 1.0, "b")).unwrap();
    store.db().exec("UPDATE submissions SET seed = -9007199254740991 WHERE id = 1; UPDATE submissions SET seed = 9007199254740992 WHERE id = 2").unwrap();
    assert_eq!(store.get(ok).unwrap().unwrap().seed, Some(-9007199254740991.0));
    let e = store.get(big).unwrap_err();
    assert_eq!((e.name(), e.message().as_str()), ("RangeError", "Value is too large to be represented as a JavaScript number: 9007199254740992"));
    // the listings read no seed, and go on
    assert_eq!(store.leaders().unwrap().len(), 2);
    // a seed the server can store: the largest safe integer, bound as a double and kept as an INTEGER
    let mut e = entry(4.0, 4.0, 3.0, 1.0, "c");
    e.seed = Some(9007199254740991.0);
    let id = store.insert(&e).unwrap();
    assert_eq!(store.get(id).unwrap().unwrap().seed, Some(9007199254740991.0));
    let kind = store.db().prepare("SELECT typeof(seed) AS t, typeof(n) AS n, typeof(score) AS s FROM submissions WHERE id = ?").unwrap().get(&[id.into()]).unwrap().unwrap();
    assert_eq!((kind.text("t").unwrap().as_str(), kind.text("n").unwrap().as_str(), kind.text("s").unwrap().as_str()), ("integer", "integer", "real"));
}
