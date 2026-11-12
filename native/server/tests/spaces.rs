//! Tests of the spaces' routes in process, against catalogues made for the test: behaviours that
//! apps/server/test/spaces*.test.ts pin with a research record that is worse than the real one
//! (so that an entry can beat it), which the differential harness (native/tools/serverdiff) cannot
//! arrange, since it runs the server on the repository's data. Each test names the source test it
//! stands for. The harness covers the rest, word for word, against the TypeScript server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, HeaderName, HeaderValue};
use futures_util::StreamExt;
use polypack_server::app::{App, AppOptions, LimitOptions, Literature};
use polypack_server::clock::Clock;
use polypack_server::hono::{Req, Res, ResBody};
use polypack_server::load::LoadStats;
use polypack_server::pool::Pool;
use polypack_server::spaces::{LoadedSpaces, SpacesPort};
use polypack_server::store::{OpenOptions, SpaceIds, SqliteStore};
use polypack_server::url;
use polypack_spaces::{build_space_catalogue, space_domain, validate_space_submission, SpaceName, SpaceValidateOptions, SpacesIndex, SPACE_STRICT_REASON};
use serde_json::{json, Value};

const SCORE_TIE: f64 = 1e-9;
const L2: f64 = std::f64::consts::SQRT_2;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// data/<space>/records.json, parsed.
fn records_file(space: &str) -> Value {
    let text = std::fs::read_to_string(root().join("data").join(space).join("records.json")).expect("the space's records");
    serde_json::from_str(&text).expect("JSON")
}

/// The catalogue of a space as the server loads it from the repository.
fn real(space: SpaceName) -> polypack_spaces::SpaceCatalogue {
    build_space_catalogue(space, Some(&records_file(space.as_str())), space_domain(space))
}

fn index_of(catalogues: Vec<polypack_spaces::SpaceCatalogue>) -> SpacesIndex {
    let mut index = SpacesIndex::default();
    for c in catalogues {
        index.set(c);
    }
    index
}

/// spaces.test.ts: twoDisks. Two disks of diameter 1 on the square torus: touching at k = 1, scaled
/// up (valid, worse) for k > 1.
fn two_disks(k: f64) -> Value {
    json!({ "lattice": { "L": L2 * k }, "poses": [[0, 0, 0], [(L2 / 2.0) * k, (L2 / 2.0) * k, 0]] })
}

/// spaces.test.ts: weakTorusIndex. An index whose torus/sq/0/2 research record is far worse than
/// it really is, so that site entries can beat it.
fn weak_torus_index() -> SpacesIndex {
    let file = json!({
        "generated": "test",
        "records": [
            { "problem": "torus/sq/0/2", "family": "sq", "N": 0, "P": 2, "score_cert": 3, "display": "3.000000", "status": "best_known",
              "configuration": two_disks(3.0 / L2), "bound": { "value": L2, "label": "a test bound" } },
            { "problem": "torus/sq/0/1", "family": "sq", "N": 0, "P": 1, "score_cert": 2.000000000002, "display": "2.000001", "status": "best_known",
              "configuration": { "lattice": { "L": 2 }, "poses": [[0, 0, 0]] }, "bound": { "value": 2, "label": "one disk" } },
        ],
    });
    index_of(vec![build_space_catalogue(SpaceName::Torus, Some(&file), None)])
}

/// The certified size of the real sphere/3/6 record, and its pieces.
fn sphere_3_6() -> (f64, Value) {
    let file = records_file("sphere");
    let r = file["records"].as_array().unwrap().iter().find(|r| r["id"] == "sphere/3/6").expect("sphere/3/6").clone();
    (r["score_cert"].as_f64().unwrap(), r["config"]["pieces"].clone())
}

/// spaces.test.ts: weakSphereIndex. An index whose sphere/3/6 research record is three times
/// larger than it really is, so that site entries can beat it. The sphere is a space whose checks
/// are always run: its "valid, not kept" answers are the generic ones.
fn weak_sphere_index() -> SpacesIndex {
    let mut file = records_file("sphere");
    let r = file["records"].as_array_mut().unwrap().iter_mut().find(|r| r["id"] == "sphere/3/6").expect("sphere/3/6");
    let (cert, rho) = (r["score_cert"].as_f64().unwrap(), r["config"]["rho"].as_f64().unwrap());
    r["status"] = json!("best_known");
    r["score_cert"] = json!(cert * 3.0);
    r["display"] = json!("weak");
    r["config"]["rho"] = json!(rho * 3.0);
    index_of(vec![build_space_catalogue(SpaceName::Sphere, Some(&file), space_domain(SpaceName::Sphere))])
}

/// spaces.test.ts: sphereEntry. The sphere/3/6 record's pieces on a sphere k times its radius:
/// valid, with the score rho0 k.
fn sphere_entry(k: f64, name: &str) -> Value {
    let (rho0, pieces) = sphere_3_6();
    json!({ "space": "sphere", "id": "sphere/3/6", "config": { "rho": rho0 * k, "pieces": pieces }, "name": name })
}

/// spaces.test.ts: testIndex. The real torus catalogue, but with torus/sq/0/2 open (its research
/// record is proven optimal, so the real catalogue closes it) and made much worse (size 3,
/// against the optimum sqrt 2), so that site entries can beat it.
fn opened_torus() -> polypack_spaces::SpaceCatalogue {
    let mut file = records_file("torus");
    let r = file["records"].as_array_mut().unwrap().iter_mut().find(|r| r["problem"] == "torus/sq/0/2").expect("torus/sq/0/2");
    r["status"] = json!("best_known");
    r["bound"] = json!({ "value": L2, "label": "a test bound" });
    r["score_float"] = json!(2.82842712474619 / 2.0);
    r["score_cert"] = json!(3);
    r["display"] = json!("3.000000");
    r["configuration"] = two_disks(3.0 / L2);
    build_space_catalogue(SpaceName::Torus, Some(&file), space_domain(SpaceName::Torus))
}

fn torus_entry(k: f64, name: &str) -> Value {
    json!({ "space": "torus", "id": "torus/sq/0/2", "config": two_disks(k), "name": name, "units": "diameter" })
}

struct Server {
    app: Arc<App>,
    clock: Clock,
    log: Arc<Mutex<Vec<String>>>,
    store: Arc<Mutex<SqliteStore>>,
    stats: Arc<Mutex<LoadStats>>,
    pool: Pool,
}

fn server(index: SpacesIndex) -> Server {
    server_with(Some(index))
}

/// `None`: a server that is given no spaces (createApp without `spaces`).
fn server_with(index: Option<SpacesIndex>) -> Server {
    let clock = Clock::new();
    let without = index.is_none();
    let spaces: Arc<dyn SpacesPort> = Arc::new(LoadedSpaces::new(index.unwrap_or_default()));
    let ids: &dyn SpaceIds = &*spaces;
    let store = SqliteStore::open(":memory:", OpenOptions { migrate_units: true, log: None, spaces: ids, clock: Box::new(clock.clone()), tracer: None }).expect("a store in memory");
    let store = Arc::new(Mutex::new(store));
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink = log.clone();
    let write: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_string()));
    let stats = {
        let write = write.clone();
        Arc::new(Mutex::new(LoadStats::new(Box::new(move |line| write(line)))))
    };
    let pool = Pool::new(4, clock.clone());
    let app = App::new(AppOptions {
        store: store.clone(),
        records: Arc::new(Literature::new(Vec::new()).expect("no records")),
        admin_token: Some("secret".to_string()),
        submit_key: None,
        client_ip: Some(Box::new(|req: &Req| req.header("x-ip").unwrap_or_else(|| "1.1.1.1".to_string()))),
        log: Some(write),
        limits: LimitOptions { per_ip: Some(1e9), verify_ms_per_minute: Some(1e12), ..LimitOptions::default() },
        loop_delay: None,
        stats: Some(stats.clone()),
        holders_chunk: None,
        holder_chunk: None,
        clock: clock.clone(),
        units_gate: None,
        snapshots: None,
        spaces: if without { None } else { Some(spaces) },
        pool: pool.clone(),
    })
    .expect("the app");
    Server { app, clock, log, store, stats, pool }
}

struct Answer {
    status: u16,
    headers: HashMap<String, String>,
    bytes: Vec<u8>,
}

impl Answer {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }

    fn gunzipped(&self) -> String {
        use std::io::Read;
        let mut out = String::new();
        flate2::read::GzDecoder::new(&self.bytes[..]).read_to_string(&mut out).expect("gzip");
        out
    }
}

async fn finish(res: Res) -> Answer {
    let bytes = match res.body {
        ResBody::Null => Vec::new(),
        ResBody::Full(b) => b.to_vec(),
        ResBody::Cut(words) => words.to_vec(),
        ResBody::Stream(mut s) | ResBody::Promised { stream: mut s, .. } => {
            let mut all = Vec::new();
            while let Some(Ok(part)) = s.next().await {
                all.extend_from_slice(&part);
            }
            all
        }
    };
    Answer { status: res.status, headers: res.headers.into_iter().collect(), bytes }
}

impl Server {
    async fn call(&self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<Value>) -> Answer {
        let href = url::href("test", path);
        let mut map = HeaderMap::new();
        for (k, v) in headers {
            map.insert(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        let mut req = Req { method: method.to_string(), path: url::get_path(&href), url: href, headers: map, remote: None, body: Mutex::new(body.map(|b| axum::body::Body::from(b.to_string()))), deadline: None };
        let res = self.app.fetch(method, &mut req).await.expect("a route of the API");
        finish(res).await
    }

    async fn get(&self, path: &str) -> Answer {
        self.call("GET", path, &[], None).await
    }

    async fn submit(&self, body: Value) -> Answer {
        self.call("POST", "/api/spaces/submit", &[], Some(body)).await
    }

    fn leaders(&self) -> Vec<(f64, String, String)> {
        self.store.lock().unwrap().space_leaders().unwrap().into_iter().map(|l| (l.id, l.name, l.problem)).collect()
    }

    fn logged(&self, start: &str) -> Vec<String> {
        self.log.lock().unwrap().iter().filter(|l| l.starts_with(start)).cloned().collect()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.pool.close();
    }
}

// spaces.test.ts: "is compressed once and kept with its gzip bytes, served plain to clients that do
// not accept gzip" and "is kept until an entry of its space changes"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listing_is_kept_with_its_gzip_until_an_entry_of_its_space_changes() {
    let s = server(index_of(vec![opened_torus(), real(SpaceName::Sphere)]));
    let zipped = |path: &'static str| {
        let s = &s;
        async move {
            let a = s.call("GET", path, &[("accept-encoding", "gzip, deflate, br")], None).await;
            assert_eq!(a.headers.get("content-encoding").map(String::as_str), Some("gzip"));
            assert_eq!(a.headers.get("vary").map(String::as_str), Some("Accept-Encoding"));
            assert_eq!(a.headers.get("content-type").map(String::as_str), Some("application/json"));
            (a.gunzipped(), a.bytes)
        }
    };
    let (torus, torus_bytes) = zipped("/api/spaces/torus/records").await;
    let (sphere, _) = zipped("/api/spaces/sphere/records").await;
    // a later request, a minute on by the clock, is answered with the listing made before, and the same compressed bytes
    s.clock.set_offset_ms(60_000.0);
    let (again, again_bytes) = zipped("/api/spaces/torus/records").await;
    assert_eq!(again, torus);
    assert_eq!(again_bytes, torus_bytes);
    for accept in [None, Some("identity"), Some("gzip;q=0")] {
        let headers: Vec<(&str, &str)> = accept.iter().map(|a| ("accept-encoding", *a)).collect();
        let plain = s.call("GET", "/api/spaces/torus/records", &headers, None).await;
        assert_eq!(plain.headers.get("content-encoding"), None);
        assert_eq!(plain.headers.get("vary").map(String::as_str), Some("Accept-Encoding"));
        assert_eq!(plain.text(), torus);
    }
    // /problems is the same answer
    assert_eq!(s.get("/api/spaces/torus/problems").await.text(), torus);
    // a torus entry clears the torus listing only
    let r = s.submit(torus_entry(1.0, "ann")).await.json();
    assert_eq!(r["leader"], json!(true), "{r}");
    assert_eq!(zipped("/api/spaces/sphere/records").await.0, sphere);
    let after: Value = serde_json::from_str(&zipped("/api/spaces/torus/records").await.0).unwrap();
    assert_ne!(after["generated_at"], serde_json::from_str::<Value>(&torus).unwrap()["generated_at"]);
    let p = after["problems"].as_array().unwrap().iter().find(|p| p["id"] == "torus/sq/0/2").expect("the problem");
    assert_eq!(p["site_best"]["id"], r["id"]);
    assert_eq!(p["site_best"]["score"], json!(L2));
    assert_eq!(p["site_best"]["name"], json!("ann"));
    assert_eq!(p["best_score"], json!(L2));
    // an administrator's change clears it too
    let edited = s.call("POST", "/api/admin/spaces/edit", &[("authorization", "Bearer secret")], Some(json!({ "id": r["id"], "name": "bob" }))).await;
    assert_eq!(edited.status, 200, "{}", edited.text());
    let renamed = s.get("/api/spaces/torus/records").await.json();
    let p = renamed["problems"].as_array().unwrap().iter().find(|p| p["id"] == "torus/sq/0/2").expect("the problem");
    assert_eq!(p["site_best"]["name"], json!("bob"));
    assert_eq!(s.logged("[spaces]"), vec![
        format!("[spaces] entry {} by \"ann\" leads torus/sq/0/2: score 1.4142135623730951 is below the certified 3 (best_known) by 52.9%", r["id"]),
        format!("[spaces] entry {} (torus/sq/0/2) edited: name", r["id"]),
    ]);
}

// spaces.test.ts: "stores a free torus in a reduced, right-handed basis: the same lattice, poses
// and score" and "stores the configuration with its known fields only"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_free_torus_is_stored_in_a_reduced_right_handed_basis() {
    let file = json!({
        "generated": "test",
        "records": [
            { "problem": "torus/free/0/2", "family": "free", "N": 0, "P": 2, "score_cert": 3, "display": "3.000000", "status": "best_known",
              "configuration": { "lattice": { "b1": [3, 0], "b2": [0, 3] }, "poses": [[0, 0, 0], [1.5, 1.5, 0]] }, "bound": { "value": 1.25, "label": "a test bound" } },
            { "problem": "torus/sq/0/2", "family": "sq", "N": 0, "P": 2, "score_cert": 3, "display": "3.000000", "status": "best_known",
              "configuration": two_disks(3.0 / L2), "bound": { "value": L2, "label": "a test bound" } },
        ],
    });
    let s = server(index_of(vec![build_space_catalogue(SpaceName::Torus, Some(&file), None)]));
    let poses = json!([[0, 0, 0], [L2 / 2.0, L2 / 2.0, 0]]);
    // the square lattice of side sqrt 2, written as b2 + 100 b1 and left-handed
    let sent = json!({ "lattice": { "b1": [L2, 0], "b2": [-100.0 * L2, -L2] }, "poses": poses });
    let r = s.submit(json!({ "space": "torus", "id": "torus/free/0/2", "config": sent, "name": "ann", "units": "diameter" })).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let r = r.json();
    assert_eq!(r["leader"], json!(true));
    let score = r["score"].as_f64().unwrap();
    assert!((score - L2).abs() < 1e-12);
    let e = s.get(&format!("/api/spaces/entries/{}", r["id"])).await.json();
    let pair = |v: &Value| (v[0].as_f64().unwrap(), v[1].as_f64().unwrap());
    let (b1, b2) = (pair(&e["config"]["lattice"]["b1"]), pair(&e["config"]["lattice"]["b2"]));
    assert!(b1.0 * b2.1 - b1.1 * b2.0 > 0.0);
    assert!((b1.0.hypot(b1.1) - L2).abs() < 1e-12);
    assert!((b2.0.hypot(b2.1) - L2).abs() < 1e-12);
    assert_eq!(e["config"]["poses"], poses);
    assert_eq!(e["score"].as_f64(), Some(score));
    let p = s.get("/api/spaces/torus/problems/torus/free/0/2").await.json();
    assert_eq!(p["site_config"], e["config"]);
    let v = validate_space_submission(SpaceName::Torus, "torus/free/0/2", &e["config"], &SpaceValidateOptions { bound: Some(1.25), certified: Some(3.0), ..Default::default() });
    assert!(v.valid);
    assert!((v.score.unwrap() - score).abs() <= 1e-12 * L2);

    // the configuration is stored with its known fields only
    let mut config = two_disks(1.0);
    config["extra"] = json!("x".repeat(100));
    config["score"] = json!(0.1);
    let mut body = torus_entry(1.0, "ann");
    body["config"] = config;
    body["container"] = json!({ "size": 0.1 });
    let r = s.submit(body).await.json();
    assert_eq!(r["score"], json!(L2));
    assert_eq!(s.get(&format!("/api/spaces/entries/{}", r["id"])).await.json()["config"], two_disks(1.0));
}

// spaces.test.ts: "keeps the earliest of equally good entries and only the leader", and the sphere
// part of "keeps an entry only when it beats the problem's best value by more than the tie tolerance"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_earliest_of_equally_good_entries_is_kept_and_only_the_leader() {
    let (rho0, _) = sphere_3_6();
    // an entry that only ties the research record is valid and not kept (on a space whose entries are always checked)
    let s = server(index_of(vec![real(SpaceName::Sphere)]));
    let tie = s.submit(sphere_entry(1.0, "ann")).await;
    assert_eq!(tie.text(), format!("{{\"valid\":true,\"reasons\":[],\"score\":{0},\"leader\":false,\"best_score\":{0},\"id\":null,\"beats_certified\":false}}", polypack_js::fmt::num(rho0)));
    // a poor entry is valid and not kept, whatever its name
    let mut poor = sphere_entry(1.0, "Spam Corp");
    poor["config"]["rho"] = json!(999999);
    let poor = s.submit(poor).await.json();
    assert_eq!((poor["valid"].clone(), poor["leader"].clone(), poor["id"].clone(), poor["best_score"].as_f64()), (json!(true), json!(false), Value::Null, Some(rho0)));
    assert!(s.leaders().is_empty());

    let s = server(weak_sphere_index());
    let a = s.submit(sphere_entry(1.001, "ann")).await.json();
    assert_eq!(a["leader"], json!(true), "{a}");
    // equal, and better only within the tie tolerance: not kept
    let b = s.submit(sphere_entry(1.001, "bob")).await.json();
    assert_eq!((b["valid"].clone(), b["leader"].clone(), b["id"].clone()), (json!(true), json!(false), Value::Null));
    let c = s.submit(sphere_entry(1.001 * (1.0 - SCORE_TIE / 2.0), "cy")).await.json();
    assert_eq!((c["valid"].clone(), c["leader"].clone(), c["id"].clone()), (json!(true), json!(false), Value::Null));
    assert_eq!(c["best_score"].as_f64(), Some(rho0 * 1.001));
    assert_eq!(s.get(&format!("/api/spaces/entries/{}", a["id"])).await.status, 200);
    // better by more than the tolerance: the new leader; the old one is deleted
    let d = s.submit(sphere_entry(1.0001, "dee")).await.json();
    assert_eq!(d["leader"], json!(true));
    assert_eq!(d["best_score"].as_f64(), Some(rho0 * 1.0001));
    assert_eq!(s.get(&format!("/api/spaces/entries/{}", a["id"])).await.status, 404);
    assert_eq!(s.leaders(), vec![(d["id"].as_f64().unwrap(), "dee".to_string(), "sphere/3/6".to_string())]);
    // worse: valid, not kept
    let e = s.submit(sphere_entry(1.01, "eve")).await.json();
    assert_eq!((e["valid"].clone(), e["leader"].clone(), e["id"].clone(), e["best_score"].as_f64()), (json!(true), json!(false), Value::Null, Some(rho0 * 1.0001)));
    let listing = s.get("/api/spaces/sphere/records").await.json();
    let p = listing["problems"].as_array().unwrap().iter().find(|p| p["id"] == "sphere/3/6").expect("the problem");
    assert_eq!(p["site_best"]["name"], json!("dee"));
}

// spaces.test.ts: "answers a torus entry that is no better than the best without checking it, and
// keeps the earliest" and "checks a torus entry that beats the best in full, and refuses an invalid one"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_torus_entry_that_cannot_be_kept_is_not_checked() {
    let s = server(index_of(vec![opened_torus()]));
    let a = s.submit(torus_entry(1.001, "ann")).await.json();
    assert_eq!(a["leader"], json!(true), "{a}");
    // equal, better only within the tie tolerance, and worse
    for (k, name) in [(1.001, "bob"), (1.001 * (1.0 - SCORE_TIE / 2.0), "cy"), (1.01, "eve")] {
        let r = s.submit(torus_entry(k, name)).await;
        assert_eq!(r.status, 200);
        let r = r.json();
        assert_eq!(
            r,
            json!({ "valid": false, "reasons": [format!("not checked: a size of {} cannot be kept, since it is not below the research record by more than a relative 1e-9 and below the site's best by more than a relative 1e-9", polypack_js::fmt::num(L2 * k))],
                    "score": L2 * k, "leader": false, "best_score": L2 * 1.001, "id": null, "beats_certified": false, "checked": false })
        );
    }
    assert_eq!(s.get(&format!("/api/spaces/entries/{}", a["id"])).await.status, 200);
    // better by more than the tolerance: checked and kept, and the old leader is deleted
    let d = s.submit(torus_entry(1.0001, "dee")).await.json();
    assert_eq!((d["valid"].clone(), d["leader"].clone(), d["best_score"].as_f64()), (json!(true), json!(true), Some(L2 * 1.0001)));
    assert!(d.get("checked").is_none());
    assert_eq!(s.get(&format!("/api/spaces/entries/{}", a["id"])).await.status, 404);
    assert_eq!(s.leaders(), vec![(d["id"].as_f64().unwrap(), "dee".to_string(), "torus/sq/0/2".to_string())]);
    // beats the best but overlaps: two disks of diameter 1 less than 1 apart on the torus of side sqrt 2
    let mut bad = torus_entry(1.0, "bob");
    bad["config"] = json!({ "lattice": { "L": L2 }, "poses": [[0, 0, 0], [1, 1, 0]] });
    let bad = s.submit(bad).await;
    assert_eq!(bad.status, 422);
    let bad = bad.json();
    assert!(bad.get("checked").is_none());
    assert!(bad["reasons"][0].as_str().unwrap().contains("overlap"), "{bad}");
    // the submissions' lines: the problem, and a verification time only where there was a check
    let lines = s.logged("[submit]");
    assert_eq!(lines.len(), 6);
    assert!(lines[0].starts_with("[submit] 200 torus/sq/0/2 ") && lines[0].contains(", verification "), "{}", lines[0]);
    assert!(lines[1].starts_with("[submit] 200 torus/sq/0/2 ") && !lines[1].contains("verification"), "{}", lines[1]);
    assert!(lines[5].starts_with("[submit] 422 torus/sq/0/2 ") && lines[5].contains(", verification "), "{}", lines[5]);
}

// spaces.test.ts: "keeps an entry that beats the research record, says so and logs it" and
// "counts a change of leader in the minute's load line"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_entry_that_beats_the_research_record_is_kept_and_logged() {
    let (rho0, _) = sphere_3_6();
    let weak = rho0 * 3.0;
    let s = server(weak_sphere_index());
    let r = s.submit(sphere_entry(1.01, "ann")).await.json();
    assert_eq!((r["valid"].clone(), r["leader"].clone(), r["beats_certified"].clone(), r["best_score"].as_f64()), (json!(true), json!(true), json!(true), Some(rho0 * 1.01)));
    let score = rho0 * 1.01;
    assert_eq!(
        s.logged("[spaces]"),
        vec![format!(
            "[spaces] entry {} by \"ann\" leads sphere/3/6: score {} is below the certified {} (best_known) by {}%",
            r["id"],
            polypack_js::fmt::num(score),
            polypack_js::fmt::num(weak),
            polypack_js::fmt::precision(((weak - score) / weak) * 100.0, 3)
        )]
    );
    // a worse entry does not lead; best_score stays the site leader's
    let worse = s.submit(sphere_entry(1.02, "bob")).await.json();
    assert_eq!((worse["leader"].clone(), worse["beats_certified"].clone(), worse["best_score"].as_f64()), (json!(false), json!(true), Some(rho0 * 1.01)));
    assert_eq!(s.logged("[spaces]").len(), 1);
    // a better one leads: two changes of leader in the minute's line
    let better = s.submit(sphere_entry(1.001, "cy")).await.json();
    assert_eq!(better["leader"], json!(true));
    s.stats.lock().unwrap().flush(0.0);
    let load = s.logged("[load]");
    assert!(load[0].starts_with("[load] last minute: 3 submissions (200: 3); verification p50 ") && load[0].contains(" in all over 3 boards; 2 leader changes; "), "{}", load[0]);
    // within the tie tolerance of the record it does not beat it, and is not kept
    let s2 = server(weak_sphere_index());
    let tie = s2.submit(sphere_entry(3.0 * (1.0 - SCORE_TIE / 2.0), "ann")).await.json();
    assert_eq!((tie["valid"].clone(), tie["leader"].clone(), tie["id"].clone(), tie["beats_certified"].clone(), tie["best_score"].as_f64()), (json!(true), json!(false), Value::Null, json!(false), Some(weak)));
    assert!(tie["score"].as_f64().unwrap() < weak);
    assert!(s2.logged("[spaces]").is_empty());
    // the torus answers such entries without a check, and keeps one that beats the record
    let s3 = server(weak_torus_index());
    let kept = s3.submit(torus_entry(1.01, "ann")).await.json();
    assert_eq!((kept["valid"].clone(), kept["leader"].clone(), kept["beats_certified"].clone(), kept["best_score"].as_f64()), (json!(true), json!(true), json!(true), Some(L2 * 1.01)));
    let torus_worse = s3.submit(torus_entry(1.02, "bob")).await.json();
    assert_eq!((torus_worse["valid"].clone(), torus_worse["id"].clone(), torus_worse["best_score"].as_f64(), torus_worse["checked"].clone()), (json!(false), Value::Null, Some(L2 * 1.01), json!(false)));
    let s4 = server(weak_torus_index());
    let torus_tie = s4.submit(torus_entry((3.0 / L2) * (1.0 - SCORE_TIE / 2.0), "ann")).await.json();
    assert_eq!((torus_tie["valid"].clone(), torus_tie["beats_certified"].clone(), torus_tie["best_score"].as_f64(), torus_tie["checked"].clone()), (json!(false), json!(false), Some(3.0), json!(false)));
    assert!(torus_tie["score"].as_f64().unwrap() < 3.0);
}

/// spaces.test.ts: shrunk. A record's configuration shrunk by the factor f about the origin, sizes
/// included (sphere: rho only).
fn shrunk(space: &str, c: &Value, f: f64) -> Value {
    let times = |v: &Value| json!(v.as_f64().unwrap() * f);
    let mut out = c.clone();
    match space {
        "surface" | "curved" => {
            let size = if space == "surface" { "s" } else { "size" };
            out[size] = times(&c[size]);
            for q in out["pieces"].as_array_mut().unwrap() {
                q["x"] = times(&q["x"].clone());
                q["y"] = times(&q["y"].clone());
            }
        }
        "sphere" => out["rho"] = times(&c["rho"]),
        "torus" => {
            if c["lattice"].get("L").is_some() {
                out["lattice"]["L"] = times(&c["lattice"]["L"]);
            } else {
                for b in ["b1", "b2"] {
                    out["lattice"][b] = json!([times(&c["lattice"][b][0]), times(&c["lattice"][b][1])]);
                }
            }
            for p in out["poses"].as_array_mut().unwrap() {
                *p = json!([times(&p[0]), times(&p[1]), p[2]]);
            }
        }
        "boundary" => {
            out["s"] = times(&c["s"]);
            for q in out["pieces"].as_array_mut().unwrap() {
                let u: Vec<Value> = q["u"].as_array().unwrap().iter().map(times).collect();
                q["u"] = json!(u);
            }
        }
        other => panic!("no shrinking of {other}"),
    }
    out
}

// spaces.test.ts: "does not let a record be beaten by the float tolerance alone (strict check at 1e-11)"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_is_not_beaten_by_the_float_tolerance_alone() {
    let s = server(index_of(vec![real(SpaceName::Torus), real(SpaceName::Sphere), real(SpaceName::Curved), real(SpaceName::Surface), real(SpaceName::Boundary)]));
    // the research record's own configuration shrunk by 1.05e-9: valid at the touching tolerance,
    // and smaller than the record by more than the tie tolerance, but its pieces overlap
    for id in ["torus/sq/3/2", "sphere/3/5", "curved/-1/3/0/2", "surface/tetrahedron/fold/3/5", "boundary/tesseract/cube/4"] {
        let space = id.split('/').next().unwrap();
        let name = SpaceName::parse(space).unwrap();
        let p = s.get(&format!("/api/spaces/{space}/problems/{id}")).await.json();
        let copy = shrunk(space, &p["certified_config"], 1.0 - 1.05e-9);
        assert!(validate_space_submission(name, id, &copy, &SpaceValidateOptions { bound: p["bound"]["value"].as_f64(), ..Default::default() }).valid, "{id}");
        let r = s.submit(json!({ "space": space, "id": id, "config": copy, "name": "copycat", "units": "diameter" })).await;
        assert_eq!(r.status, 422, "{id}: {}", r.text());
        let r = r.json();
        assert_eq!(r["reasons"][0], json!(SPACE_STRICT_REASON), "{id}");
        assert_eq!((r["valid"].clone(), r["beats_certified"].clone(), r["id"].clone()), (json!(false), json!(false), Value::Null));
        let after = s.get(&format!("/api/spaces/{space}/problems/{id}")).await.json();
        assert_eq!(after["best_score"], p["certified"]["score"]);
        assert_eq!(after["site_best"], Value::Null);
    }
    assert!(s.logged("[spaces]").is_empty());
    // a record with real slack (about 1e-8 here) can be beaten by a hair, legitimately
    let p = s.get("/api/spaces/torus/problems/torus/sq/8/16").await.json();
    let better = s.submit(json!({ "space": "torus", "id": p["id"], "config": shrunk("torus", &p["certified_config"], 1.0 - 1.05e-9), "name": "polisher" })).await.json();
    assert_eq!((better["valid"].clone(), better["leader"].clone(), better["beats_certified"].clone()), (json!(true), json!(true), json!(true)), "{better}");
}

// spaces.test.ts: "does not keep an entry 1e-12 below a boundary record, and keeps one 2e-9 below"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_boundary_record_is_beaten_by_the_tie_tolerance() {
    let id = "boundary/tesseract/cube/4";
    let file = records_file("boundary");
    let rec = file["records"].as_array().unwrap().iter().find(|r| r["id"] == id).expect("the record").clone();
    // the real catalogue, with the record certified at its configuration's s times `f`
    let with = |f: f64| {
        let cert = rec["config"]["s"].as_f64().unwrap() * f;
        let mut r = rec.clone();
        r["score_cert"] = json!(cert);
        r["score_float"] = json!(cert);
        r["display"] = json!(polypack_js::fmt::fixed(cert, 6));
        let mut f = file.clone();
        f["records"] = json!([r]);
        index_of(vec![build_space_catalogue(SpaceName::Boundary, Some(&f), space_domain(SpaceName::Boundary))])
    };
    let entry = json!({ "space": "boundary", "id": id, "config": rec["config"], "name": "ann" });
    // the record's own configuration, 1e-12 below the record: a tie
    let tie = server(with(1.0 + 1e-12)).submit(entry.clone()).await;
    assert_eq!(tie.status, 200, "{}", tie.text());
    let tie = tie.json();
    assert_eq!((tie["valid"].clone(), tie["leader"].clone(), tie["id"].clone(), tie["beats_certified"].clone()), (json!(true), json!(false), Value::Null, json!(false)));
    // 2e-9 below: kept, after the strict check
    let kept = server(with(1.0 / (1.0 - 2e-9))).submit(entry).await.json();
    assert_eq!((kept["valid"].clone(), kept["leader"].clone(), kept["beats_certified"].clone()), (json!(true), json!(true), json!(true)), "{kept}");
    assert!(kept["id"].is_number());
}

// The Rust server's own: submissions of one address whose checks are not heavy never refuse each
// other (the source takes them one after the other; here the later one waits for the earlier).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn checks_that_are_not_heavy_never_refuse_each_other() {
    let s = Arc::new(server(weak_sphere_index()));
    let mut tasks = Vec::new();
    for k in 0..40 {
        let s = s.clone();
        tasks.push(tokio::spawn(async move { s.submit(sphere_entry(1.5 - 0.01 * k as f64, &format!("n{k}"))).await }));
    }
    let mut kept = 0;
    for t in tasks {
        let a = t.await.unwrap();
        assert_eq!(a.status, 200, "{}", a.text());
        if a.json()["leader"] == json!(true) {
            kept += 1;
        }
    }
    assert!(kept >= 1);
    // whatever the order they were taken in, the best of them leads
    assert_eq!(s.leaders().into_iter().map(|l| l.1).collect::<Vec<_>>(), vec!["n39".to_string()]);
}

// spaces.test.ts: "shows the curvature sweeps only when a space is loaded" and "is absent from a
// server without spaces, and every other route is unchanged"; leaders.test.ts: "lists space keys as
// unknown on a server without spaces"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_with_no_space_loaded_and_one_without_spaces() {
    // the routes are there, and no space is
    let s = server(SpacesIndex::default());
    assert_eq!(s.get("/api/spaces").await.text(), "{\"spaces\":[],\"exhibits\":[]}");
    let r = s.get("/api/spaces/torus/records").await;
    assert_eq!((r.status, r.text()), (404, "{\"error\":\"no such space; the spaces are (none loaded)\"}".to_string()));
    let r = s.submit(torus_entry(1.0, "ann")).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json()["reasons"], json!(["space must be one of (no spaces are loaded)"]));
    assert_eq!(s.get("/api/leaders?keys=torus/sq/0/2,4/4/1").await.json(), json!({ "leaders": { "4/4/1": null }, "unknown": ["torus/sq/0/2"] }));
    // one space: the sweeps are shown with it
    let one = server(weak_torus_index()).get("/api/spaces").await.json();
    assert_eq!(one["spaces"].as_array().map(Vec::len), Some(1));
    assert_eq!(one["spaces"][0]["space"], json!("torus"));
    assert_eq!((one["spaces"][0]["problems"].clone(), one["spaces"][0]["records"].clone()), (json!(2), json!(2)));
    assert!(one["spaces"][0].get("domain").is_none());
    assert!(!one["exhibits"].as_array().unwrap().is_empty());

    // no spaces at all: their paths are any other unknown path of the API
    let s = server_with(None);
    for (method, path) in [("GET", "/api/spaces"), ("GET", "/api/spaces/torus/records"), ("POST", "/api/spaces/submit"), ("POST", "/api/admin/spaces/remove")] {
        let r = s.call(method, path, &[], None).await;
        assert_eq!((r.status, r.text()), (404, "{\"error\":\"not found\"}".to_string()), "{method} {path}");
    }
    assert_eq!(s.get("/api/health").await.status, 200);
    assert_eq!(s.get("/api/leaders?keys=torus/sq/0/2,4/4/1").await.json(), json!({ "leaders": { "4/4/1": null }, "unknown": ["torus/sq/0/2"] }));
}
