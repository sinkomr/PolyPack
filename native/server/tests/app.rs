//! Tests of the HTTP API in process: behaviours that the tests of apps/server/test pin and that
//! the differential harness (native/tools/serverdiff) cannot see from outside, or that it shows
//! only against the TypeScript server's own timing. Each test names the source test it stands for.
//! The harness covers the rest: every route's answers, word for word, against the TypeScript.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::{HeaderMap, HeaderName, HeaderValue};
use futures_util::StreamExt;
use polypack_server::app::{atlas_source, holder_share, parse_event_keys, App, AppOptions, AtlasSource, Holder, LimitOptions, Literature};
use polypack_server::clock::Clock;
use polypack_server::hono::{Req, Res, ResBody};
use polypack_server::load::LoadStats;
use polypack_server::pool::Pool;
use polypack_server::snapshot::{build_snapshot, read_manifest, BuildOptions, SnapshotSource, SourceOptions};
use polypack_server::spaces::{LoadedSpaces, SpacesPort};
use polypack_server::store::{OpenOptions, ProblemLeader, SpaceIds, SqliteStore};
use polypack_server::url;
use serde_json::{json, Value};

const ADMIN: &str = "test-admin-token";

/// The published records of the tests: 4/4/2 proven (closed), 4/4/3 easy to beat, 4/4/5 with a
/// value that a grid reaches.
fn records() -> Vec<Value> {
    let rec = |p: u32, value: f64, status: &str| {
        json!({ "N": 4, "M": 4, "P": p, "value": value, "display": value.to_string(), "display_precision": 2, "status": status,
                "source_name": "test", "source_url": "https://example.invalid/", "accessed": "2026-10-07", "conversion_note": "none" })
    };
    vec![rec(2, 2.0, "proven"), rec(3, 5.0, "best_known"), rec(5, 3.0, "best_known")]
}

/// The spaces as the server loads them from the repository's data, read once for all the tests.
fn the_spaces() -> Arc<dyn SpacesPort> {
    static SPACES: std::sync::OnceLock<Arc<LoadedSpaces>> = std::sync::OnceLock::new();
    SPACES
        .get_or_init(|| {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            Arc::new(LoadedSpaces::load(&root, polypack_spaces::no_log()))
        })
        .clone()
}

struct Server {
    app: Arc<App>,
    clock: Clock,
    log: Arc<Mutex<Vec<String>>>,
    store: Arc<Mutex<SqliteStore>>,
    pool: Pool,
}

struct Setup {
    limits: LimitOptions,
    holders_chunk: Option<f64>,
    holder_chunk: Option<f64>,
    snapshots: Option<std::path::PathBuf>,
    threads: usize,
    measured_delay: bool,
    /// The stack of the pool's workers; None: the server's.
    stack: Option<usize>,
}

impl Default for Setup {
    fn default() -> Self {
        let free = LimitOptions { per_ip: Some(1e9), verify_ms_per_minute: Some(1e12), ..LimitOptions::default() };
        Setup { limits: free, holders_chunk: None, holder_chunk: None, snapshots: None, threads: 2, measured_delay: false, stack: None }
    }
}

fn server(setup: Setup) -> Server {
    let clock = Clock::new();
    let spaces: Arc<dyn SpacesPort> = the_spaces();
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
    let pool = match setup.stack {
        Some(bytes) => Pool::with_stack(setup.threads, clock.clone(), bytes),
        None => Pool::new(setup.threads, clock.clone()),
    };
    let literature = Arc::new(Literature::new(records()).expect("the test's records"));
    let snapshots = setup.snapshots.map(|dir| {
        let l = literature.clone();
        Arc::new(SnapshotSource::new(SourceOptions { dir, store: store.clone(), closed: Arc::new(move |n, m, p| l.closed(n, m, p)), spaces: None, max_concurrent: None }))
    });
    let delay_pool = pool.clone();
    let app = App::new(AppOptions {
        store: store.clone(),
        records: literature,
        admin_token: Some(ADMIN.to_string()),
        submit_key: None,
        client_ip: Some(Box::new(|req: &Req| req.header("x-ip").unwrap_or_else(|| "1.1.1.1".to_string()))),
        log: Some(write),
        limits: setup.limits,
        loop_delay: if setup.measured_delay { Some(Box::new(move || delay_pool.delay_ms())) } else { None },
        stats: Some(stats),
        holders_chunk: setup.holders_chunk,
        holder_chunk: setup.holder_chunk,
        clock: clock.clone(),
        units_gate: None,
        snapshots,
        spaces: Some(spaces),
        pool: pool.clone(),
    })
    .expect("the app");
    Server { app, clock, log, store, pool }
}

struct Answer {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.body))
    }
}

fn request(method: &str, path: &str, headers: &[(&str, &str)], body: Option<String>) -> Req {
    let href = url::href("test", path);
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        map.insert(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
    }
    Req { method: method.to_string(), path: url::get_path(&href), url: href, headers: map, remote: None, body: Mutex::new(body.map(axum::body::Body::from)), deadline: None }
}

async fn finish(res: Res) -> Answer {
    let body = match res.body {
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
    Answer { status: res.status, headers: res.headers.into_iter().collect(), body: String::from_utf8_lossy(&body).into_owned() }
}

impl Server {
    async fn call(&self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<Value>) -> Answer {
        let mut req = request(method, path, headers, body.map(|b| b.to_string()));
        let routed = if method == "HEAD" { "GET" } else { method };
        finish(self.app.fetch(routed, &mut req).await.expect("a path of the API")).await
    }
    async fn get(&self, path: &str) -> Answer {
        self.call("GET", path, &[], None).await
    }
    async fn admin(&self, path: &str, body: Value) -> Answer {
        self.call("POST", path, &[("authorization", &format!("Bearer {ADMIN}"))], Some(body)).await
    }
    /// P unit squares on a grid `cols` wide, `gap` apart, as squares in a square.
    async fn submit_squares(&self, p: usize, cols: usize, gap: f64, name: &str) -> Answer {
        self.call("POST", "/api/submit", &[], Some(squares(p, cols, gap, name))).await
    }
}

fn squares(p: usize, cols: usize, gap: f64, name: &str) -> Value {
    let pieces: Vec<Value> = (0..p).map(|i| json!({ "x": (i % cols) as f64 * gap, "y": (i / cols) as f64 * gap, "theta": std::f64::consts::FRAC_PI_4 })).collect();
    json!({ "N": 4, "M": 4, "P": p, "pieces": pieces, "container_phi": 0, "name": name })
}

/// The holders as the leaders of the store give them: the reference of api.test.ts ("equals the
/// count of all leaders at once"), with the names that lead nothing left out.
fn counted_from_the_store(s: &Server) -> Vec<(String, f64, f64, f64, f64)> {
    let leaders: Vec<ProblemLeader> = s.store.lock().unwrap().leaders().unwrap();
    let mut by_name: HashMap<String, Holder> = HashMap::new();
    for l in &leaders {
        let Some(share) = holder_share(l, s.app.literature().get(l.n, l.m, l.p)) else {
            continue;
        };
        let h = by_name.entry(share.name.clone()).or_insert(Holder { name: share.name.clone(), records: 0.0, beat_published: 0.0, site_bests: 0.0, pending: 0.0, peak: 0.0 });
        h.records += share.records;
        h.beat_published += share.beat_published;
        h.site_bests += share.site_bests;
        h.pending += share.pending;
    }
    let mut rows: Vec<_> = by_name.into_values().map(|h| (h.name, h.records, h.beat_published, h.site_bests, h.pending)).collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows
}

async fn holders_listed(s: &Server) -> Vec<(String, f64, f64, f64, f64)> {
    let body = s.get("/api/holders").await.json();
    let mut rows: Vec<_> = body["holders"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|h| h["site_bests"].as_f64().unwrap() > 0.0)
        .map(|h| (h["name"].as_str().unwrap().to_string(), h["records"].as_f64().unwrap(), h["beat_published"].as_f64().unwrap(), h["site_bests"].as_f64().unwrap(), h["pending"].as_f64().unwrap()))
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows
}

/// A small generator of numbers in [0, 1) (mulberry32, as the harness's scenarios use).
fn rng(seed: u32) -> impl FnMut() -> f64 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b79f5);
        let mut t = a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

// api.test.ts: "accepts a valid packing and stores the server-computed score"; "sends a live event
// when a problem gets a new leader"; the log line of load.test.ts
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_valid_packing_is_stored_with_the_servers_score() {
    let s = server(Setup::default());
    let r = s.submit_squares(11, 4, 1.0, "ann").await;
    assert_eq!(r.status, 200, "{}", r.body);
    let body = r.json();
    assert_eq!(body["valid"], json!(true));
    assert_eq!(body["leader"], json!(true));
    assert_eq!(body["rank"], json!(1));
    assert_eq!(body["id"], json!(1));
    let board = s.get("/api/leaderboard/4/4/11").await.json();
    assert_eq!(board["total"], json!(1));
    assert_eq!(board["entries"][0]["name"], json!("ann"));
    assert_eq!(board["entries"][0]["score"], body["score"]);
    // a worse entry does not lead, is not kept, and counts
    let worse = s.submit_squares(11, 4, 1.5, "bob").await.json();
    assert_eq!((worse["leader"].clone(), worse["rank"].clone(), worse["id"].clone()), (json!(false), json!(2), Value::Null));
    assert_eq!(s.get("/api/leaderboard/4/4/11").await.json()["total"], json!(2));
    let lines = s.log.lock().unwrap().clone();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].starts_with("[submit] 200 4/4/11 ") && lines[0].contains(" ms, verification "), "{}", lines[0]);
}

// api.test.ts, "GET /api/holders: the counts kept": "equals the count of all leaders at once after
// every few changes", "builds in steps ...", "counts a change made during the build once", and
// "GET /api/holder": "equal the rows of /api/holders after a random walk of submissions and changes"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_kept_counts_equal_a_count_of_all_leaders_after_any_walk() {
    for (seed, chunk) in [(1u32, 3.0), (2, 250.0), (3, 1.0)] {
        let s = server(Setup { holders_chunk: Some(chunk), holder_chunk: Some(2.0), ..Setup::default() });
        let mut next = rng(seed);
        let names = ["ann", "bob", "cy", "dee"];
        let mut built = false;
        for step in 0..160 {
            let roll = next();
            let name = names[(next() * 4.0) as usize];
            if roll < 0.7 {
                // an entry: sometimes better than the leader, sometimes not; 4/4/3 below 5 is a claim
                let p = 3 + (next() * 9.0) as usize;
                let gap = 1.0 + (next() * 4.0).floor() / 4.0;
                let r = s.submit_squares(p, 4, gap, name).await;
                assert_eq!(r.status, 200, "{}", r.body);
            } else if roll < 0.8 {
                let id = 1.0 + (next() * 40.0).floor();
                s.admin("/api/admin/remove", json!({ "id": id })).await;
            } else if roll < 0.9 {
                let id = 1.0 + (next() * 40.0).floor();
                s.admin("/api/admin/edit", json!({ "id": id, "name": names[(next() * 4.0) as usize] })).await;
            } else {
                let pending = s.call("GET", "/api/admin/pending", &[("authorization", &format!("Bearer {ADMIN}"))], None).await.json();
                if let Some(first) = pending["pending"].as_array().and_then(|l| l.first()) {
                    let decision = if next() < 0.5 { "confirmed" } else { "rejected" };
                    s.admin("/api/admin/review", json!({ "id": first["id"], "decision": decision })).await;
                }
            }
            // the first count is made part way through the walk; from then on every change moves the counts
            if step == 40 || (built && step % 7 == 0) {
                built = true;
                assert_eq!(holders_listed(&s).await, counted_from_the_store(&s), "seed {seed}, step {step}");
            }
        }
        assert_eq!(holders_listed(&s).await, counted_from_the_store(&s), "seed {seed}, at the end");
        // each name's page gives its row of the list
        let list = s.get("/api/holders").await.json();
        for h in list["holders"].as_array().unwrap() {
            let page = s.get(&format!("/api/holder?name={}", h["name"].as_str().unwrap())).await.json();
            for field in ["records", "beat_published", "site_bests", "pending", "peak"] {
                assert_eq!(page[field], h[field], "seed {seed}: {field} of {}", h["name"]);
            }
            let led: f64 = page["pairs"].as_array().unwrap().iter().map(|p| p["P"].as_array().unwrap().len() as f64).sum();
            assert_eq!(Some(led), h["site_bests"].as_f64());
        }
    }
}

// api.test.ts, "the answers that are kept": 15 minutes, forgotten at an administrator's change,
// 32 at most
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_holders_answer_is_kept_for_fifteen_minutes() {
    let s = server(Setup::default());
    s.submit_squares(11, 4, 1.0, "ann").await;
    let first = s.get("/api/holder?name=ann").await.json();
    assert_eq!(first["site_bests"], json!(1));
    // given as it was made, whatever is submitted meanwhile
    s.submit_squares(12, 4, 1.0, "ann").await;
    s.clock.set_offset_ms(14.0 * 60_000.0);
    assert_eq!(s.get("/api/holder?name=ann").await.json(), first);
    // then made again
    s.clock.set_offset_ms(15.0 * 60_000.0 + 1000.0);
    let second = s.get("/api/holder?name=ann").await.json();
    assert_eq!(second["site_bests"], json!(2));
    assert_ne!(second["computed_at"], first["computed_at"]);
    // an administrator's change forgets every answer at once
    s.submit_squares(13, 4, 1.0, "ann").await;
    assert_eq!(s.get("/api/holder?name=ann").await.json()["site_bests"], json!(2));
    assert_eq!(s.admin("/api/admin/edit", json!({ "id": 1, "agent_note": "x" })).await.status, 200);
    assert_eq!(s.get("/api/holder?name=ann").await.json()["site_bests"], json!(3));
    // 32 names at most: the one asked longest ago goes first
    let kept = s.get("/api/holder?name=ann").await.json();
    for k in 0..32 {
        s.get(&format!("/api/holder?name=n{k}")).await;
    }
    s.submit_squares(14, 4, 1.0, "ann").await;
    let again = s.get("/api/holder?name=ann").await.json();
    assert_ne!(again, kept);
    assert_eq!(again["site_bests"], json!(4));
}

// api.test.ts, "GET /api/records/pairs" and "keeps the records listing current although answers
// are cached"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_kept_listings_follow_every_change() {
    let s = server(Setup::default());
    let pairs = |body: Value| -> Vec<(f64, f64, f64, bool)> { body["pairs"].as_array().unwrap().iter().map(|p| (p["N"].as_f64().unwrap(), p["M"].as_f64().unwrap(), p["published"].as_f64().unwrap(), p["site"].as_bool().unwrap())).collect() };
    assert_eq!(pairs(s.get("/api/records/pairs").await.json()), vec![(4.0, 4.0, 3.0, false)]);
    s.submit_squares(11, 4, 1.0, "ann").await;
    s.call("POST", "/api/submit", &[], Some(json!({ "N": 5, "M": 7, "P": 2, "pieces": [{ "x": 0, "y": 0, "theta": 0 }, { "x": 3, "y": 0, "theta": 0 }], "name": "bob" }))).await;
    assert_eq!(pairs(s.get("/api/records/pairs").await.json()), vec![(4.0, 4.0, 3.0, true), (5.0, 7.0, 0.0, true)]);
    let listing = s.get("/api/records?N=4&M=4").await.json();
    assert_eq!(listing["site"].as_array().unwrap().len(), 1);
    assert_eq!(listing["literature"].as_array().unwrap().len(), 3);
    assert_eq!(listing["literature"][0]["has_coordinates"], json!(false));
    // a removal takes the entry out of the listing and the pair out of the pairs
    assert_eq!(s.admin("/api/admin/remove", json!({ "id": 2 })).await.status, 200);
    assert_eq!(pairs(s.get("/api/records/pairs").await.json()), vec![(4.0, 4.0, 3.0, true)]);
    s.submit_squares(12, 4, 1.0, "ann").await;
    assert_eq!(s.get("/api/records?N=4&M=4").await.json()["site"].as_array().unwrap().len(), 2);
}

// load.test.ts, "overload": "refuses submissions with 503 and Retry-After while the event loop
// lags", "never refuses with the limit at 0". Here the lag is a verification waiting for a worker.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submissions_are_refused_while_verifications_wait_for_a_worker() {
    let s = server(Setup { threads: 1, measured_delay: true, limits: LimitOptions { per_ip: Some(1e9), verify_ms_per_minute: Some(1e12), overload_delay_ms: Some(50.0), ..LimitOptions::default() }, ..Setup::default() });
    assert_eq!(s.submit_squares(11, 4, 1.0, "ann").await.status, 200);
    // the one worker is held, and another job waits behind it for longer than the limit
    let (held, waiting) = (s.pool.clone(), s.pool.clone());
    let a = tokio::spawn(async move { held.run(|| std::thread::sleep(Duration::from_millis(150))).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let b = tokio::spawn(async move { waiting.run(|| ()).await });
    tokio::time::sleep(Duration::from_millis(80)).await;
    let refused = s.submit_squares(12, 4, 1.0, "ann").await;
    assert_eq!(refused.status, 503, "{}", refused.body);
    assert_eq!(refused.headers.get("retry-after").map(String::as_str), Some("5"));
    assert_eq!(refused.json()["reasons"], json!(["the server is busy; try again in a few seconds"]));
    // other routes are answered meanwhile
    assert_eq!(s.get("/api/health").await.status, 200);
    let _ = (a.await, b.await);
    assert!(s.log.lock().unwrap().iter().any(|l| l.starts_with("[submit] 503 - ")));
    // the wait counts for one to two seconds after it ended, as the event-loop delay does
    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert_eq!(s.submit_squares(12, 4, 1.0, "ann").await.status, 200);

    let never = server(Setup { threads: 1, measured_delay: true, limits: LimitOptions { per_ip: Some(1e9), verify_ms_per_minute: Some(1e12), overload_delay_ms: Some(0.0), ..LimitOptions::default() }, ..Setup::default() });
    let (held, waiting) = (never.pool.clone(), never.pool.clone());
    let a = tokio::spawn(async move { held.run(|| std::thread::sleep(Duration::from_millis(120))).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let b = tokio::spawn(async move { waiting.run(|| ()).await });
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(never.submit_squares(11, 4, 1.0, "ann").await.status, 200);
    let _ = (a.await, b.await);
}

// events.test.ts: "reach only the streams that follow the problem, once each"; "leave nothing
// behind when it goes"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_updates_reach_only_the_streams_that_follow_the_problem() {
    let s = server(Setup::default());
    let open = |query: &str| {
        let mut req = request("GET", &format!("/api/events{query}"), &[], None);
        let app = s.app.clone();
        async move {
            let res = app.fetch("GET", &mut req).await.unwrap();
            assert_eq!(res.header("content-type"), Some("text/event-stream"));
            assert_eq!(res.header("cache-control"), Some("no-cache"));
            match res.body {
                ResBody::Stream(s) => s,
                _ => panic!("not a stream"),
            }
        }
    };
    let mut one = open("?keys=4/4/11").await;
    let mut pair = open("?keys=4/4/*,04/4/011").await;
    let mut other = open("?keys=5/7/2").await;
    let mut all = open("").await;
    let mut none = open("?keys=").await;
    let text = |b: Option<Result<bytes::Bytes, std::io::Error>>| String::from_utf8(b.unwrap().unwrap().to_vec()).unwrap();
    assert_eq!(text(one.next().await), "event: hello\ndata: {\"keys\":[\"4/4/11\"]}\n\n");
    assert_eq!(text(pair.next().await), "event: hello\ndata: {\"keys\":[\"4/4/*\",\"4/4/11\"]}\n\n");
    assert_eq!(text(all.next().await), "event: hello\ndata: {\"all\":true}\n\n");
    assert_eq!(text(none.next().await), "event: hello\ndata: {\"keys\":[]}\n\n");
    text(other.next().await);
    let r = s.submit_squares(11, 4, 1.0, "ann").await.json();
    let event = format!("event: leaderboard\ndata: {{\"N\":4,\"M\":4,\"P\":11,\"id\":1,\"score\":{},\"rank\":1,\"name\":\"ann\"}}\n\n", r["score"]);
    assert_eq!(text(one.next().await), event);
    assert_eq!(text(pair.next().await), event);
    assert_eq!(text(all.next().await), event);
    // a tie changes no leader: nothing is sent; the next leader of another problem goes to its followers only
    s.submit_squares(11, 4, 1.0, "bob").await;
    s.submit_squares(12, 4, 1.0, "bob").await;
    assert!(text(pair.next().await).contains("\"P\":12"));
    assert!(text(all.next().await).contains("\"P\":12"));
    for quiet in [&mut one, &mut other, &mut none] {
        assert!(tokio::time::timeout(Duration::from_millis(100), quiet.next()).await.is_err(), "a stream that follows another problem got an event");
    }
    // the counts of the minute's line: five streams, one following everything, the others four keys
    drop((one, pair, other, none));
    s.submit_squares(13, 4, 1.0, "bob").await;
    assert!(text(all.next().await).contains("\"P\":13"));
    drop(all);
    assert_eq!(parse_event_keys("04/4/011,4/4/11,000/0/3"), Ok(vec!["4/4/11".to_string(), "0/0/3".to_string()]));
}

// events.test.ts: "are N/M/P or N/M/*, written back in one form, at most MAX_EVENT_KEYS"
#[test]
fn the_keys_of_a_stream() {
    assert_eq!(parse_event_keys(""), Ok(vec![]));
    assert_eq!(parse_event_keys("4/4/11,4/4/*,0/0/500"), Ok(vec!["4/4/11".to_string(), "4/4/*".to_string(), "0/0/500".to_string()]));
    for bad in ["x", "4/4", "4/4/0", "4/4/501", "2/4/1", "4/4/1,", ",", "4/4/**", "4/101/1", "-4/4/1", "4/4/1.5", " 4/4/1", "1e1/4/1", "0004/4/1", "4/4/1/"] {
        let e = parse_event_keys(bad).unwrap_err();
        assert!(e.starts_with("keys must be N/M/P or N/M/*, separated by commas, with N and M 0 or 3 to 100 and P 1 to 500; \""), "{bad}: {e}");
    }
    let hundred: Vec<String> = (1..=100).map(|p| format!("4/4/{p}")).collect();
    assert_eq!(parse_event_keys(&hundred.join(",")).map(|k| k.len()), Ok(100));
    assert_eq!(parse_event_keys(&format!("{},4/4/101", hundred.join(","))), Err("at most 100 keys".to_string()));
    assert_eq!(parse_event_keys("a-very-long-key-that-is-cut-at-twenty-characters").unwrap_err().split('"').nth(1), Some("a-very-long-key-that"));
}

// api.test.ts: "gives a leader's share of its name's counts"; "prefers a verified site entry only
// when it is at least as good as the published value"; "draws a pending entry only when nothing
// else can be drawn"
#[test]
fn shares_and_sources() {
    let lit = Literature::new(records()).unwrap();
    let leader = |p: f64, score: f64, verification: &str| ProblemLeader { n: 4.0, m: 4.0, p, id: 1.0, name: "ann".to_string(), score, verification: verification.to_string() };
    let share = |l: &ProblemLeader| holder_share(l, lit.get(l.n, l.m, l.p)).map(|h| (h.records, h.beat_published, h.site_bests, h.pending));
    // no published value: a record; a closed problem: nothing; worse than published: a site best only
    assert_eq!(share(&leader(11.0, 4.0, "none")), Some((1.0, 0.0, 1.0, 0.0)));
    assert_eq!(share(&leader(2.0, 2.0, "none")), None);
    assert_eq!(share(&leader(5.0, 3.5, "none")), Some((0.0, 0.0, 1.0, 0.0)));
    // reaches it; beats it once confirmed; pending counts as pending only
    assert_eq!(share(&leader(5.0, 3.0, "none")), Some((1.0, 0.0, 1.0, 0.0)));
    assert_eq!(share(&leader(5.0, 2.5, "confirmed")), Some((1.0, 1.0, 1.0, 0.0)));
    assert_eq!(share(&leader(5.0, 2.5, "pending")), Some((0.0, 0.0, 1.0, 1.0)));

    let published = lit.get(4.0, 4.0, 5.0);
    assert_eq!(atlas_source(Some(3.0), published, true, false), Some(AtlasSource::Verified));
    assert_eq!(atlas_source(Some(3.0000000000000004), published, true, false), Some(AtlasSource::Verified));
    assert_eq!(atlas_source(Some(3.5), published, true, false), Some(AtlasSource::Literature));
    assert_eq!(atlas_source(Some(3.5), published, false, false), Some(AtlasSource::Verified));
    assert_eq!(atlas_source(None, published, true, true), Some(AtlasSource::Literature));
    assert_eq!(atlas_source(None, published, false, true), Some(AtlasSource::Pending));
    assert_eq!(atlas_source(None, None, false, true), Some(AtlasSource::Pending));
    assert_eq!(atlas_source(Some(9.0), None, false, true), Some(AtlasSource::Verified));
    assert_eq!(atlas_source(None, None, false, false), None);
}

/// A directory of one test under cargo's target directory.
fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::current_exe().unwrap().parent().unwrap().join("polypack-app-tests").join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// snapshot.test.ts: "is a manifest of format 3 ... and nothing else on disk"; "keeps the entry, and
// its as_of, of a pair whose leaders are unchanged"; "deletes the files an older server stored";
// "generates the file from the leaders, line for line"; "answers HEAD without generating anything";
// "shows a leader that changed after the manifest was built"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_snapshot_is_a_manifest_and_files_made_on_request() {
    let dir = temp_dir("snapshot");
    let s = server(Setup { snapshots: Some(dir.clone()), ..Setup::default() });
    assert_eq!(s.get("/api/snapshot").await.status, 404);
    s.submit_squares(11, 4, 1.0, "ann").await;
    s.submit_squares(2, 2, 1.0, "closed").await; // 409: nothing stored
    s.call("POST", "/api/submit", &[], Some(json!({ "N": 5, "M": 7, "P": 2, "pieces": [{ "x": 0, "y": 0, "theta": 0 }, { "x": 3, "y": 0, "theta": 0 }], "name": "bob" }))).await;
    std::fs::write(dir.join("4-4.json.gz"), b"stored by an older server").unwrap();
    std::fs::write(dir.join("notes.txt"), b"kept").unwrap();
    let lit = Arc::new(Literature::new(records()).unwrap());
    let log = s.log.clone();
    let build = BuildOptions { store: s.store.clone(), dir: dir.clone(), closed: Arc::new(move |n, m, p| lit.closed(n, m, p)), spaces: None, log: Arc::new(move |l: &str| log.lock().unwrap().push(l.to_string())), clock: s.clock.clone() };
    let first = build_snapshot(&build).unwrap();
    assert_eq!((first.changed, first.kept, first.dropped, first.cleaned.files), (2.0, 0.0, 0.0, 1.0));
    let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["manifest.json", "notes.txt"]);
    let manifest = s.get("/api/snapshot").await;
    assert_eq!(manifest.headers.get("cache-control").map(String::as_str), Some("no-cache"));
    let m = manifest.json();
    assert_eq!((m["format"].clone(), m["units"].clone(), m["records"].clone(), m["pieces"].clone()), (json!(3), json!("diameter"), json!(2), json!(13)));
    assert_eq!(m["generated_at"], m["completed_at"]);
    assert_eq!(m["files"][0]["file"], json!("4-4.json.gz"));
    assert!(m["files"][0].get("bytes").is_none() && m["files"][0].get("sha256").is_none());

    // a file is generated from the leaders, with its headers
    let head = s.call("HEAD", "/api/snapshot/4-4.json.gz", &[], None).await;
    assert_eq!((head.status, head.body.as_str(), head.headers.get("etag")), (200, "", None));
    let mut req = request("GET", "/api/snapshot/4-4.json.gz", &[], None);
    let res = s.app.fetch("GET", &mut req).await.unwrap();
    assert_eq!(res.header("content-type"), Some("application/gzip"));
    assert_eq!(res.header("content-disposition"), Some("attachment; filename=\"4-4.json.gz\""));
    assert_eq!(res.header("x-snapshot-records"), Some("1"));
    let fingerprint = res.header("x-snapshot-fingerprint").unwrap().to_string();
    assert_eq!(Some(fingerprint.as_str()), m["files"][0]["fingerprint"].as_str());
    assert_eq!(res.header("etag"), Some(format!("W/\"{fingerprint}\"").as_str()));
    let ResBody::Full(gz) = res.body else { panic!("not bytes") };
    let mut text = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&gz[..]), &mut text).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "{\"format\":3,\"N\":4,\"M\":4,\"records\":[");
    assert!(lines[1].starts_with("{\"P\":11,\"score\":") && lines[1].contains("\"name\":\"ann\",\"found_with\":\"hand\",\"verification\":\"none\",\"created_at\":\"") && lines[1].ends_with("]]}"));
    assert_eq!(&lines[2..], ["]}"]);
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["records"][0]["pieces"].as_array().unwrap().len(), 11);
    assert_eq!(s.get("/api/snapshot/9-9.json.gz").await.status, 404);

    // the next build keeps the entry of the pair that did not change and renews the other
    s.clock.set_offset_ms(3_600_000.0);
    s.submit_squares(12, 4, 1.0, "ann").await;
    let second = build_snapshot(&build).unwrap();
    assert_eq!((second.changed, second.kept, second.dropped), (1.0, 1.0, 0.0));
    let m2 = read_manifest(&dir).unwrap();
    let text = |v: &Value| polypack_js::json::stringify(v);
    assert_eq!(text(&m2["files"][1]), text(&m["files"][1]));
    assert_ne!(m2["files"][0]["as_of"], m["files"][0]["as_of"]);
    assert_ne!(m2["files"][0]["fingerprint"], m["files"][0]["fingerprint"]);
    // a pair that lost its entries is dropped
    s.admin("/api/admin/remove", json!({ "id": 2 })).await;
    let third = build_snapshot(&build).unwrap();
    assert_eq!((third.changed, third.kept, third.dropped), (0.0, 1.0, 1.0));
    let _ = std::fs::remove_dir_all(&dir);
}

// units-gate.test.ts: "before 0.3.0 get 426 from every route but the API page, health and the
// snapshot"; "answers 426 with an explanation to a disk packing without units"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_clients_and_missing_units_are_told_to_update() {
    let s = server(Setup::default());
    let old = [("user-agent", "polypack-volunteer/0.2.9")];
    assert_eq!(s.call("GET", "/api/health", &old, None).await.status, 200);
    assert_eq!(s.call("GET", "/api", &old, None).await.status, 200);
    let refused = s.call("GET", "/api/problems/4/4/11", &old, None).await;
    assert_eq!(refused.status, 426);
    assert_eq!(refused.json()["conventions_version"], json!(2));
    assert_eq!(s.call("HEAD", "/api/health", &old, None).await.status, 426);
    assert_eq!(s.call("GET", "/api/problems/4/4/11", &[("user-agent", "polypack-volunteer/0.3.0")], None).await.status, 200);
    let disks = json!({ "N": 0, "M": 0, "P": 2, "pieces": [{ "x": 0, "y": 0 }, { "x": 1.5, "y": 0 }], "name": "ann" });
    let no_units = s.call("POST", "/api/submit", &[], Some(disks.clone())).await;
    assert_eq!(no_units.status, 426);
    assert!(no_units.json()["reasons"][0].as_str().unwrap().contains("send \"units\": \"diameter\""));
    let mut with = disks;
    with["units"] = json!("diameter");
    let ok = s.call("POST", "/api/submit", &[], Some(with)).await;
    assert_eq!((ok.status, ok.json()["score"].clone()), (200, json!(2.5)));
}

// The fast path of POST /api/submit (src/body.rs) against its definition: for every body, what the
// direct reader gives is what `polypack_js::json::parse` and `parse_config` give, or it gives
// nothing and the defined path is taken.
#[test]
fn the_direct_reader_of_a_body_agrees_with_the_tree() {
    use polypack_flat::config::parse_config;
    use polypack_flat::provenance::parse_provenance;
    use polypack_server::docs::method_names;

    let grid = |p: usize| -> String {
        let pieces: Vec<String> = (0..p).map(|i| format!("{{\"x\":{},\"y\":{},\"theta\":0.7853981633974483}}", (i % 5) as f64 * 1.25, (i / 5) as f64 * 1.25)).collect();
        format!("[{}]", pieces.join(","))
    };
    let board = |pieces: &str, extra: &str| format!("{{\"N\":4,\"M\":4,\"P\":7,\"pieces\":{pieces},\"container_phi\":0,\"name\":\"ann\"{extra}}}");
    let many: String = format!("[{}]", vec!["{\"x\":0,\"y\":0,\"theta\":0}"; 501].join(","));
    let full: String = format!("[{}]", vec!["{\"x\":0,\"y\":0,\"theta\":0}"; 500].join(","));
    // (body, whether the direct reader must take it)
    let mut cases: Vec<(String, bool)> = vec![
        // plain boards, as clients write them
        (board(&grid(7), ""), true),
        (board(&grid(7), ",\"found_with\":\"optimizer\",\"method\":\"polish\",\"method_params\":{\"b\":1,\"10\":[1e21,null],\"a\":{\"x\":-0.0}},\"seed\":7,\"budget\":{\"time_s\":0.5,\"evals\":10},\"software\":\" tool \",\"units\":\"diameter\""), true),
        (board("[{\"x\":0,\"y\":0},{\"y\":1.5,\"x\":-2,\"extra\":[1,{\"x\":\"no\"}]}]", ""), true),
        (board("[{\"x\":-0.0,\"y\":-0,\"theta\":-0e0},{\"x\":1E-7,\"y\":0.1000000000000000055511151231257827,\"theta\":123456789012345678901234567890},{\"x\":1e6,\"y\":-1000000,\"theta\":1e300},{\"x\":5e-324,\"y\":2.2250738585072014e-308,\"theta\":9007199254740993}]", ""), true),
        (board("[]", ""), true),
        (board(&full, ""), true),
        (format!(" \n{}\r\n\t", board(&grid(3), "")), true),
        ("{\"pieces\":[{\"x\":1,\"y\":2}]}".to_string(), true),
        ("{\"N\":2,\"M\":\"4\",\"P\":0,\"pieces\":[{\"x\":1,\"y\":2}],\"container_phi\":\"x\",\"name\":5,\"agent_note\":[],\"found_with\":\"magic\",\"seed\":-1}".to_string(), true),
        ("{\"N\":4,\"M\":4,\"P\":2,\"P\":3,\"name\":\"dup\\u0041 \\ud83d\\ude00\",\"pieces\":[{\"x\":0,\"y\":0},{\"x\":2,\"y\":0},{\"x\":4,\"y\":0}],\"N\":5}".to_string(), true),
        ("{}".to_string(), true),
        ("{\"N\":4,\"M\":4,\"P\":1,\"name\":\"n\"}".to_string(), true),
        // pieces the defined path refuses, or reads in a way of its own
        (board(&many, ""), false),
        (board("[{\"x\":1e6,\"y\":1000000.0000001,\"theta\":0}]", ""), false),
        (board("[{\"x\":0,\"y\":0,\"theta\":null}]", ""), false),
        (board("[{\"x\":\"0\",\"y\":0}]", ""), false),
        (board("[{\"x\":0}]", ""), false),
        (board("[null]", ""), false),
        (board("[[0,0,0]]", ""), false),
        (board("[5]", ""), false),
        (board("{}", ""), false),
        (board("\"x\"", ""), false),
        (board("null", ""), false),
        (board("[{\"x\":0,\"y\":0,\"x\":1}]", ""), false),
        (board("[{\"\\u0078\":0,\"y\":0}]", ""), false),
        (board("[{\"x\":1e400,\"y\":0}]", ""), false),
        (board("[{\"x\":0,\"y\":0}]", ",\"pieces\":[]"), false),
        // not JSON, or not an object
        ("{".to_string(), false),
        ("".to_string(), false),
        ("null".to_string(), false),
        ("[]".to_string(), false),
        ("[{}]".to_string(), false),
        ("5".to_string(), false),
        ("{\"N\":4,}".to_string(), false),
        ("{\"N\":4}{\"N\":5}".to_string(), false),
        ("\u{feff}{}".to_string(), false),
        ("{\"name\":\"\\ud800\"}".to_string(), false),
        ("{\"N\":1e999}".to_string(), false),
    ];
    // and boards with every kind of number a generator can write
    let mut next = rng(7);
    for _ in 0..300 {
        let p = 1 + (next() * 12.0) as usize;
        let number = |r: f64, pick: f64| -> String {
            match (pick * 6.0) as usize {
                0 => format!("{}", (r * 2000.0 - 1000.0).round()),
                1 => format!("{:e}", r * 1e-9),
                2 => format!("{:.17}", r * 100.0 - 50.0),
                3 => format!("-{}", r),
                4 => format!("{}E+2", r),
                _ => polypack_js::fmt::num(r * 1e5),
            }
        };
        let pieces: Vec<String> = (0..p)
            .map(|_| {
                let (x, y, t) = (number(next(), next()), number(next(), next()), number(next(), next()));
                if next() < 0.2 { format!("{{\"y\":{y},\"x\":{x}}}") } else { format!("{{\"x\":{x},\"y\":{y},\"theta\":{t}}}") }
            })
            .collect();
        cases.push((format!("{{\"N\":{},\"M\":0,\"P\":{p},\"pieces\":[{}],\"container_phi\":{},\"name\":\"gen\"}}", 3 + (next() * 5.0) as usize, pieces.join(","), number(next(), next())), true));
    }

    let methods = method_names();
    let mut taken = 0;
    for (body, direct_expected) in &cases {
        let direct = polypack_server::body::read(body.as_bytes());
        assert_eq!(direct.is_some(), *direct_expected, "whether the direct reader takes {body}");
        let Some(direct) = direct else {
            continue;
        };
        taken += 1;
        // the definition
        let tree = polypack_js::json::parse(body.as_bytes()).unwrap_or_else(|e| panic!("the direct reader took what is not JSON ({e}): {body}"));
        let defined = parse_config(&tree);
        // the direct path, as app.rs takes it
        let object = Value::Object(direct.object);
        let read = parse_config(&object).map(|mut c| {
            if let Some(p) = &direct.pieces {
                c.pieces = p.clone();
            }
            c
        });
        match (&defined, &read) {
            (Ok(a), Ok(b)) => {
                assert_eq!((a.n, a.m, a.p, a.container_phi.to_bits(), &a.name, &a.agent_note), (b.n, b.m, b.p, b.container_phi.to_bits(), &b.name, &b.agent_note), "{body}");
                let bits = |c: &polypack_flat::config::PackingConfig| -> Vec<[u64; 3]> { c.pieces.iter().map(|q| [q.x.to_bits(), q.y.to_bits(), q.theta.to_bits()]).collect() };
                assert_eq!(bits(a), bits(b), "the pieces of {body}");
            }
            (Err(a), Err(b)) => assert_eq!(a, b, "{body}"),
            _ => panic!("one path accepts and the other refuses: {body}\n  defined: {defined:?}\n  direct: {read:?}"),
        }
        // everything else of the body is the same tree, but for the pieces
        let (tree, object) = (tree.as_object().unwrap(), object.as_object().unwrap());
        assert_eq!(tree.keys().collect::<Vec<_>>(), object.keys().collect::<Vec<_>>(), "{body}");
        for (key, value) in tree {
            if key != "pieces" {
                assert_eq!(polypack_js::json::stringify(value), polypack_js::json::stringify(&object[key]), "{key} of {body}");
            }
        }
        assert_eq!(parse_provenance(tree, &methods), parse_provenance(object, &methods), "{body}");
    }
    assert!(taken >= 310, "the direct reader took {taken} bodies");
}

/// Watches the statements the store runs: counts those whose text holds `needle`, and fails them
/// while `fail` is set (the port of a source test's store that throws).
fn watch(s: &Server, needle: &'static str) -> (Arc<std::sync::atomic::AtomicUsize>, Arc<std::sync::atomic::AtomicBool>) {
    use polypack_server::store::{StoreError, TraceEvent};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let count = Arc::new(AtomicUsize::new(0));
    let fail = Arc::new(AtomicBool::new(false));
    let (c, f) = (count.clone(), fail.clone());
    s.store.lock().unwrap().db().set_tracer(Some(Box::new(move |_, event| {
        if let TraceEvent::Step(sql, _) = event {
            if sql.contains(needle) {
                c.fetch_add(1, Ordering::SeqCst);
                if f.load(Ordering::SeqCst) {
                    return Err(StoreError::Other("the disk is full".to_string()));
                }
            }
        }
        Ok(())
    })));
    (count, fail)
}

// api.test.ts: "reads no table again once the counts are built, however entries keep changing";
// "keeps the answer until the counts change"; "reads the store once, however many entries arrive
// after" and "reads the store again only where an entry can leave the listing" (/api/records/pairs)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kept_answers_read_no_table_again() {
    use std::sync::atomic::Ordering;
    let s = server(Setup::default());
    s.submit_squares(11, 4, 1.0, "ann").await;
    s.get("/api/holders").await;
    s.get("/api/records/pairs").await;
    // from here on: the leaders of all problems are never listed again, nor the pairs
    let (listings, _) = watch(&s, "FROM submissions");
    let before = listings.load(Ordering::SeqCst);
    for _ in 0..3 {
        assert_eq!(s.get("/api/holders").await.status, 200);
        assert_eq!(s.get("/api/records/pairs").await.status, 200);
    }
    assert_eq!(listings.load(Ordering::SeqCst), before, "a kept answer read the table");
    let (pairs, _) = watch(&s, "SELECT DISTINCT n AS N, m AS M");
    for p in 12..16 {
        s.submit_squares(p, 4, 1.0, "bob").await;
        assert_eq!(s.get("/api/records/pairs").await.status, 200);
        let holders = s.get("/api/holders").await.json();
        assert_eq!(holders["holders"].as_array().unwrap().iter().find(|h| h["name"] == json!("bob")).unwrap()["records"], json!(p - 11));
    }
    assert_eq!(pairs.load(Ordering::SeqCst), 0, "the pairs were read again although no entry left the listing");
    // a removal may empty a pair: the next request reads them once
    s.admin("/api/admin/remove", json!({ "id": 2 })).await;
    s.get("/api/records/pairs").await;
    s.get("/api/records/pairs").await;
    assert_eq!(pairs.load(Ordering::SeqCst), 1);
}

// api.test.ts: "goes on when a peak cannot be stored, and stores it with the next one"; "counts
// again from the start after a change it could not follow"
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_store_loses_no_peak_and_no_count() {
    use std::sync::atomic::Ordering;
    let s = server(Setup::default());
    s.submit_squares(11, 4, 1.0, "ann").await;
    s.get("/api/holders").await;
    // the peak of bob cannot be stored: the entry is accepted all the same, and the peak stands in memory
    let (_, fail) = watch(&s, "INSERT INTO holder_peaks");
    fail.store(true, Ordering::SeqCst);
    assert_eq!(s.submit_squares(12, 4, 1.0, "bob").await.status, 200);
    assert!(s.log.lock().unwrap().iter().any(|l| l == "[holders] could not store 1 peak(s): the disk is full"), "{:?}", s.log.lock().unwrap());
    let row = |list: &Value, name: &str| list["holders"].as_array().unwrap().iter().find(|h| h["name"] == json!(name)).cloned().unwrap_or(Value::Null);
    assert_eq!(row(&s.get("/api/holders").await.json(), "bob")["peak"], json!(1));
    let stored = || -> Vec<(String, f64)> { s.store.lock().unwrap().holder_peaks().unwrap().into_iter().map(|p| (p.name, p.peak)).collect() };
    assert_eq!(stored(), vec![("ann".to_string(), 1.0)]);
    // the next raise writes both
    fail.store(false, Ordering::SeqCst);
    assert_eq!(s.submit_squares(13, 4, 1.0, "cy").await.status, 200);
    let mut now = stored();
    now.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(now, vec![("ann".to_string(), 1.0), ("bob".to_string(), 1.0), ("cy".to_string(), 1.0)]);

    // a change whose reading of the leader fails is answered 500, and the counts are made again
    let (_, fail) = watch(&s, "UPDATE submissions SET");
    fail.store(true, Ordering::SeqCst);
    assert_eq!(s.admin("/api/admin/edit", json!({ "id": 1, "name": "zed" })).await.status, 500);
    fail.store(false, Ordering::SeqCst);
    s.store.lock().unwrap().db().set_tracer(None);
    assert_eq!(s.admin("/api/admin/edit", json!({ "id": 1, "name": "zed" })).await.status, 200);
    assert_eq!(holders_listed(&s).await, counted_from_the_store(&s));
    assert_eq!(row(&s.get("/api/holders").await.json(), "ann")["site_bests"], json!(0));
    assert_eq!(row(&s.get("/api/holders").await.json(), "zed")["site_bests"], json!(1));
}

// api.test.ts: "counts a change made during the build once, where the build has been, is, and has
// yet to go"; "builds in steps ..., and requests that arrive meanwhile share them"
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changes_during_the_first_count_are_counted_once() {
    for round in 0..4 {
        let s = Arc::new(server(Setup { holders_chunk: Some(1.0), ..Setup::default() }));
        for p in 3..40 {
            s.submit_squares(p, 7, 1.0, ["ann", "bob", "cy"][p % 3]).await;
        }
        // the count, a page of one problem at a time, while entries take leads away and names change
        let mut tasks = Vec::new();
        for k in 0..3 {
            let s = s.clone();
            tasks.push(tokio::spawn(async move { s.get("/api/holders").await.status == 200 && k < 3 }));
        }
        for p in (3 + round..40).step_by(5) {
            let s = s.clone();
            tasks.push(tokio::spawn(async move { s.submit_squares(p, 8, 0.999999, "dee").await.status < 500 }));
        }
        for id in [2.0, 9.0, 17.0, 30.0] {
            let s = s.clone();
            tasks.push(tokio::spawn(async move { s.admin("/api/admin/edit", json!({ "id": id + round as f64, "name": "eve" })).await.status < 500 }));
        }
        for t in tasks {
            assert!(t.await.unwrap());
        }
        assert_eq!(holders_listed(&s).await, counted_from_the_store(&s), "round {round}");
    }
}

// ---------------------------------------------------------------------------------------------
// Hardening (2026-11-10): what a request must not be able to do to the server. Each test stands
// for a finding of the robustness review and fails on the server as it was before.
// ---------------------------------------------------------------------------------------------

/// The bytes the test's process holds on its heap, so that a test can say what a request costs.
struct CountingAllocator;

static LIVE_BYTES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

// SAFETY: every call goes to the system's allocator unchanged; only the sizes are added up.
unsafe impl std::alloc::GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        LIVE_BYTES.fetch_add(layout.size(), std::sync::atomic::Ordering::Relaxed);
        unsafe { std::alloc::System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
        LIVE_BYTES.fetch_sub(layout.size(), std::sync::atomic::Ordering::Relaxed);
        unsafe { std::alloc::System.dealloc(ptr, layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        LIVE_BYTES.fetch_add(layout.size(), std::sync::atomic::Ordering::Relaxed);
        unsafe { std::alloc::System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, new_size: usize) -> *mut u8 {
        LIVE_BYTES.fetch_add(new_size, std::sync::atomic::Ordering::Relaxed);
        LIVE_BYTES.fetch_sub(layout.size(), std::sync::atomic::Ordering::Relaxed);
        unsafe { std::alloc::System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn live_bytes() -> usize {
    LIVE_BYTES.load(std::sync::atomic::Ordering::Relaxed)
}

/// The threads of this process.
fn thread_count() -> usize {
    if let Ok(tasks) = std::fs::read_dir("/proc/self/task") {
        return tasks.count();
    }
    // macOS: one line per thread, after a header
    let out = std::process::Command::new("ps").args(["-M", "-p", &std::process::id().to_string()]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).lines().count().saturating_sub(1)
}

/// The server on a socket of its own, as production serves it (`node::serve`), within `limits`.
async fn listening(s: &Server, dist: Option<&std::path::Path>, limits: polypack_server::node::ConnLimits) -> std::net::SocketAddr {
    listening_server(s, dist, limits).await.0
}

async fn listening_server(s: &Server, dist: Option<&std::path::Path>, limits: polypack_server::node::ConnLimits) -> (std::net::SocketAddr, Arc<polypack_server::node::Server>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = polypack_server::node::Server::of(s.app.clone(), dist.map(|d| d.to_string_lossy().into_owned()));
    tokio::spawn(polypack_server::node::serve(listener, server.clone(), limits));
    (address, server)
}

/// Sends `request` as it is and reads until the server closes the connection, or for `wait` at most.
/// Returns what came, and whether the server closed.
async fn raw(address: std::net::SocketAddr, request: &[u8], close_sending_side: bool, wait: Duration) -> (String, bool) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    // (a server that has heard enough closes while the rest is still being sent)
    let _ = stream.write_all(request).await;
    if close_sending_side {
        let _ = stream.shutdown().await;
    }
    let mut got = Vec::new();
    let closed = tokio::time::timeout(wait, stream.read_to_end(&mut got)).await.is_ok();
    (String::from_utf8_lossy(&got).into_owned(), closed)
}

fn post(path: &str, more_headers: &str, body: &str) -> Vec<u8> {
    format!("POST {path} HTTP/1.1\r\nHost: test\r\n{more_headers}Content-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
}

fn chunked(path: &str, more_headers: &str, body: &str, after: &str) -> Vec<u8> {
    format!("POST {path} HTTP/1.1\r\nHost: test\r\n{more_headers}Transfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n{after}", body.len()).into_bytes()
}

fn rows(s: &Server) -> (f64, usize) {
    let store = s.store.lock().unwrap();
    (store.count(4.0, 4.0, 11.0).unwrap(), store.leaders().unwrap().len())
}

const BAD_REQUEST: &str = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
const REQUEST_TIMEOUT: &str = "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n";
const TOO_LARGE: &str = "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n";

// Finding 3: a body whose reading ends in an error was taken for a body that had ended. A chunked
// upload with a whole valid submission in its first chunk and a chunk size that is none after it
// was verified and stored; so was one cut short of its Content-Length. Node ends such a request
// with 400 and `Connection: close`, written to the socket as they are, and does nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_that_does_not_arrive_whole_is_not_acted_on() {
    let s = server(Setup::default());
    let address = listening(&s, None, polypack_server::node::ConnLimits::default()).await;
    let wait = Duration::from_secs(5);
    let entry = squares(11, 4, 1.0, "ann").to_string();
    let space_entry = json!({ "space": "sphere", "id": "sphere/3/2", "name": "ann", "config": { "rho": 100, "pieces": [{ "q": [1, 0, 0, 0] }, { "q": [0, 1, 0, 0] }] } }).to_string();
    let auth = format!("Authorization: Bearer {ADMIN}\r\n");

    // the framing is right: stored, and an administrator can remove it
    let (answer, _) = raw(address, &chunked("/api/submit", "Connection: close\r\n", &entry, "0\r\n\r\n"), false, wait).await;
    assert!(answer.starts_with("HTTP/1.1 200 OK\r\n") && answer.contains("\"id\":1"), "{answer}");
    assert_eq!(rows(&s), (1.0, 1));
    let lines = s.log.lock().unwrap().len();

    // a chunk size that is none, after a whole submission: the same entry again would count
    for (path, headers, body) in [("/api/submit", "", &entry), ("/api/spaces/submit", "", &space_entry), ("/api/admin/remove", auth.as_str(), &"{\"id\":1}".to_string()), ("/api/admin/edit", auth.as_str(), &"{\"id\":1,\"name\":\"eve\"}".to_string())] {
        let (answer, closed) = raw(address, &chunked(path, headers, body, "zz\r\n"), false, wait).await;
        assert_eq!((answer.as_str(), closed), (BAD_REQUEST, true), "{path}");
    }
    // a body shorter than its Content-Length, and a chunked one without its last chunk, the sending side closed
    for path in ["/api/submit", "/api/spaces/submit"] {
        let body = if path == "/api/submit" { &entry } else { &space_entry };
        let mut short = post(path, "", body);
        short.truncate(short.len() - 1);
        let whole_json_short_length = format!("POST {path} HTTP/1.1\r\nHost: test\r\nContent-Length: {}\r\n\r\n{body}", body.len() + 10).into_bytes();
        for request in [short, whole_json_short_length, chunked(path, "", body, "")] {
            let (answer, closed) = raw(address, &request, true, wait).await;
            assert_eq!((answer.as_str(), closed), (BAD_REQUEST, true), "{path}");
        }
    }
    let (answer, closed) = raw(address, &format!("POST /api/admin/remove HTTP/1.1\r\nHost: test\r\n{auth}Content-Length: 20\r\n\r\n{{\"id\":1}}").into_bytes(), true, wait).await;
    assert_eq!((answer.as_str(), closed), (BAD_REQUEST, true));

    // nothing was stored, counted, removed, renamed or logged
    assert_eq!(rows(&s), (1.0, 1));
    assert_eq!(s.store.lock().unwrap().space_best("sphere").unwrap().len(), 0);
    assert_eq!(s.get("/api/leaderboard/4/4/11").await.json()["entries"][0]["name"], json!("ann"));
    assert_eq!(s.log.lock().unwrap().len(), lines);
}

// Finding 2: only a request's head had a time limit; a client could send half a body and hold the
// connection, and the buffer of it, for ever. And a head could be 408 KiB where Node reads 16.
// Node's limits (ConnLimits::default) with Node's answers: 408 or 431 and `Connection: close`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_must_arrive_whole_in_time_and_with_a_head_of_nodes_size() {
    let node = polypack_server::node::ConnLimits::default();
    assert_eq!((node.headers_timeout, node.request_timeout, node.max_header_size), (Duration::from_secs(60), Duration::from_secs(300), 16384));

    let s = server(Setup::default());
    let limits = polypack_server::node::ConnLimits { headers_timeout: Duration::from_millis(400), request_timeout: Duration::from_millis(900), ..node };
    let address = listening(&s, None, limits).await;
    let wait = Duration::from_secs(10);
    let entry = squares(11, 4, 1.0, "ann").to_string();

    // nothing sent, and half a head: 408 when the head is late
    for request in ["", "POST /api/submit HTTP/1.1\r\nHost: test\r\nX-A: 1\r\n"] {
        let began = std::time::Instant::now();
        let (answer, closed) = raw(address, request.as_bytes(), false, wait).await;
        assert_eq!((answer.as_str(), closed), (REQUEST_TIMEOUT, true), "{request:?}");
        assert!(began.elapsed() >= Duration::from_millis(390) && began.elapsed() < Duration::from_secs(5), "{:?}", began.elapsed());
    }
    // a head and a body that stops short, by its length and chunked, on the routes that read a body
    let auth = format!("Authorization: Bearer {ADMIN}\r\n");
    let short = |path: &str, headers: &str, body: &str| format!("POST {path} HTTP/1.1\r\nHost: test\r\n{headers}Content-Length: {}\r\n\r\n{body}", body.len() + 10).into_bytes();
    for request in [short("/api/submit", "", &entry), chunked("/api/submit", "", &entry, ""), short("/api/spaces/submit", "", &entry), short("/api/admin/remove", &auth, "{\"id\":1}"), short("/api/admin/holder-peaks", &auth, "{\"peaks\":[{\"name\":\"ann\",\"peak\":3}]}")] {
        let began = std::time::Instant::now();
        let (answer, closed) = raw(address, &request, false, wait).await;
        assert_eq!((answer.as_str(), closed), (REQUEST_TIMEOUT, true));
        assert!(began.elapsed() >= Duration::from_millis(890) && began.elapsed() < Duration::from_secs(5), "{:?}", began.elapsed());
    }
    assert_eq!(rows(&s), (0.0, 0));
    assert!(s.log.lock().unwrap().is_empty());
    // a body that comes slowly, yet within the time, is read
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let request = post("/api/submit", "Connection: close\r\n", &entry);
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        for part in request.chunks(request.len() / 4 + 1) {
            stream.write_all(part).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut got = String::new();
        stream.read_to_string(&mut got).await.unwrap();
        assert!(got.starts_with("HTTP/1.1 200 OK\r\n"), "{got}");
    }

    // the head: Node counts the request target and each header's name and value, and refuses at 16384
    let head = |filler: usize| format!("GET /api/health HTTP/1.1\r\nHost: test\r\nConnection: close\r\nX-Big: {}\r\n\r\n", "a".repeat(filler));
    let counted = "/api/health".len() + "Host".len() + "test".len() + "Connection".len() + "close".len() + "X-Big".len();
    let (answer, _) = raw(address, head(16383 - counted).as_bytes(), false, wait).await;
    assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
    for filler in [16384 - counted, 20_000, 60_000] {
        let (answer, closed) = raw(address, head(filler).as_bytes(), false, wait).await;
        assert_eq!((answer.as_str(), closed), (TOO_LARGE, true), "{filler}");
    }
    // beyond what is buffered of a head, the HTTP library's own 431 (which a client that is still
    // sending may lose: the connection is reset under it, as Node's is)
    let (answer, closed) = raw(address, head(500_000).as_bytes(), false, wait).await;
    assert!(closed && (answer.is_empty() || answer.starts_with("HTTP/1.1 431 Request Header Fields Too Large\r\n")), "{}", &answer[..answer.len().min(200)]);
    // many headers are no reason to refuse (Node reads 2,000)
    let many: String = (0..1500).map(|i| format!("x{i}: 1\r\n")).collect();
    let (answer, _) = raw(address, format!("GET /api/health HTTP/1.1\r\nHost: test\r\nConnection: close\r\n{many}\r\n").as_bytes(), false, wait).await;
    assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{}", &answer[..answer.len().min(200)]);
}

// Finding 1: a static file was read whole into memory for each answer, so every client that asked
// for a large file and stopped reading held the file's size. The file is now read as it is sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_download_holds_a_chunk_of_the_file_not_the_file() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const FILE_BYTES: usize = 24 << 20;
    const DOWNLOADS: usize = 16;
    let dir = temp_dir("static");
    std::fs::create_dir_all(dir.join("spaces")).unwrap();
    // bytes that do not repeat, so that a wrong offset would show; and a page that compresses
    let mut next = rng(7);
    let data: Vec<u8> = (0..FILE_BYTES).map(|_| (next() * 256.0) as u8).collect();
    std::fs::write(dir.join("big.bin"), &data).unwrap();
    let page: Vec<u8> = (0..FILE_BYTES / 8).flat_map(|i| format!("<p>{i}</p>\n").into_bytes()).collect();
    std::fs::write(dir.join("spaces").join("viewer.html"), &page).unwrap();
    std::fs::write(dir.join("empty.txt"), b"").unwrap();

    let s = server(Setup::default());
    let address = listening(&s, Some(&dir), polypack_server::node::ConnLimits::default()).await;
    let get = |path: &str, headers: &str| format!("GET {path} HTTP/1.1\r\nHost: test\r\n{headers}\r\n").into_bytes();

    // clients that ask for the file, read its first bytes and then stop
    let before = live_bytes();
    let mut stalled = Vec::new();
    for k in 0..DOWNLOADS {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let path = if k % 2 == 0 { get("/big.bin", "") } else { get("/spaces/viewer.html", "Accept-Encoding: gzip\r\n") };
        stream.write_all(&path).await.unwrap();
        let mut first = [0u8; 512];
        stream.read_exact(&mut first).await.unwrap();
        assert!(first.starts_with(b"HTTP/1.1 200 OK\r\n"));
        stalled.push(stream);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let held = live_bytes().saturating_sub(before);
    // (as it was: sixteen times the file, 384 MiB; other tests of this binary run meanwhile, hence the room)
    assert!(held < 48 << 20, "{DOWNLOADS} stalled downloads of a file of {} MiB hold {} MiB", FILE_BYTES >> 20, held >> 20);
    drop(stalled);

    // and the answers are what they were
    let wait = Duration::from_secs(60);
    let split = |answer: &[u8]| -> (String, Vec<u8>) {
        let at = answer.windows(4).position(|w| w == b"\r\n\r\n").expect("a head");
        (String::from_utf8_lossy(&answer[..at]).to_lowercase(), answer[at + 4..].to_vec())
    };
    let fetch = |request: Vec<u8>| async move {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream.write_all(&request).await.unwrap();
        let mut got = Vec::new();
        tokio::time::timeout(wait, stream.read_to_end(&mut got)).await.expect("the answer ends").unwrap();
        got
    };
    let (head, body) = split(&fetch(get("/big.bin", "Connection: close\r\n")).await);
    assert!(head.starts_with("http/1.1 200 ok") && head.contains(&format!("content-length: {FILE_BYTES}")) && head.contains("content-type: application/octet-stream"), "{head}");
    assert!(body == data, "the file as it is on disk");
    // a range, as the source reads one
    let (head, body) = split(&fetch(get("/big.bin", "Connection: close\r\nRange: bytes=1000000-1299999\r\n")).await);
    assert!(head.starts_with("http/1.1 206") && head.contains("content-length: 300000") && head.contains(&format!("content-range: bytes 1000000-1299999/{FILE_BYTES}")), "{head}");
    assert!(body == data[1_000_000..1_300_000]);
    // HEAD: the length and no body; an empty file
    let (head, body) = split(&fetch(format!("HEAD /big.bin HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n").into_bytes()).await);
    assert!(head.contains(&format!("content-length: {FILE_BYTES}")) && body.is_empty(), "{head}");
    let (head, body) = split(&fetch(get("/empty.txt", "Connection: close\r\n")).await);
    assert!(head.starts_with("http/1.1 200 ok") && head.contains("content-length: 0") && body.is_empty(), "{head}");
    // under /spaces the answer is compressed as it is read: chunked, and the page when unpacked
    let (head, body) = split(&fetch(get("/spaces/viewer.html", "Connection: close\r\nAccept-Encoding: gzip\r\n")).await);
    assert!(head.contains("content-encoding: gzip") && head.contains("transfer-encoding: chunked") && head.contains("vary: accept-encoding") && !head.contains("content-length"), "{head}");
    let mut packed = Vec::new();
    let mut rest = &body[..];
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n").expect("a chunk size");
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..line_end]).unwrap(), 16).unwrap();
        if size == 0 {
            break;
        }
        packed.extend_from_slice(&rest[line_end + 2..line_end + 2 + size]);
        rest = &rest[line_end + 2 + size + 2..];
    }
    let mut unpacked = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&packed[..]), &mut unpacked).unwrap();
    assert!(unpacked == page, "the page, unpacked");
    assert!(packed.len() < page.len() / 2);
    // without Accept-Encoding it comes as it is, with its length
    let (head, body) = split(&fetch(get("/spaces/viewer.html", "Connection: close\r\n")).await);
    assert!(head.contains(&format!("content-length: {}", page.len())) && head.contains("vary: accept-encoding") && body == page, "{head}");
    let _ = std::fs::remove_dir_all(&dir);
}

// Finding 6: every request that waited for the store's lock held a thread of its own (the runtime
// starts one whenever a thread blocks and none is idle): 600 requests for a leaderboard at once,
// 530 threads. They now wait for a turn as tasks, and the runtime's threads are bounded.
#[test]
fn requests_that_wait_for_the_store_do_not_each_hold_a_thread() {
    const REQUESTS: usize = 400;
    let runtime = polypack_server::pool::runtime();
    runtime.block_on(async {
        let s = Arc::new(server(Setup::default()));
        assert_eq!(s.submit_squares(11, 4, 1.0, "ann").await.status, 200);
        let before = thread_count();
        // one statement is slow: the store is held, and every request for a leaderboard waits for it
        let held = s.store.clone();
        let (locked, is_locked) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _store = held.lock().unwrap();
            locked.send(()).unwrap();
            let _ = released.recv();
        });
        is_locked.recv().unwrap();
        let mut waiting = Vec::new();
        let order = Arc::new(Mutex::new(Vec::new()));
        for k in 0..REQUESTS {
            let (s, order) = (s.clone(), order.clone());
            waiting.push(tokio::spawn(async move {
                let answer = s.get("/api/leaderboard/4/4/11").await;
                order.lock().unwrap().push(k);
                answer.status
            }));
        }
        // while they wait, the threads are counted
        let mut most = before;
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            most = most.max(thread_count());
        }
        // and the server still answers what needs no store
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), s.get("/api/health")).await.expect("an answer while the store is held").status, 200);
        release.send(()).unwrap();
        holder.join().unwrap();
        for task in waiting {
            assert_eq!(task.await.unwrap(), 200);
        }
        assert_eq!(order.lock().unwrap().len(), REQUESTS);
        // (as it was: a thread for each of the 400. Other tests of this binary start threads meanwhile, hence the room.)
        assert!(most < before + 150, "{REQUESTS} requests waiting for the store: {before} threads before, {most} at most");
    });
}

// Finding 4: the deepest nesting. A `method_params` at its limit of 4,096 bytes nests 2,046
// levels deep; the TypeScript server stores it, and serde_json alone reads 127. A body within the
// limit of polypack_js::json::MAX_DEPTH goes through every step, here on a quarter of the stack
// the server's threads have, since a stack that overflows ends the process: this test passing
// means none did.
#[test]
fn the_deepest_json_is_read_stored_and_written_on_a_quarter_of_the_stack() {
    use polypack_js::json::MAX_DEPTH;
    let quarter = polypack_server::pool::THREAD_STACK_BYTES / 4;
    let runtime = polypack_server::pool::runtime_with_stack(quarter);
    // everything runs on the runtime's threads and the pool's: this thread only waits
    let work = runtime.spawn(async move {
        let dir = temp_dir("deep");
        let s = server(Setup { snapshots: Some(dir.clone()), stack: Some(quarter), ..Setup::default() });
        let parse = |text: &str| polypack_js::json::parse(text.as_bytes()).unwrap_or_else(|e| panic!("not JSON ({e})"));
        let submit = |s: &Server, text: String| {
            let mut req = request("POST", "/api/submit", &[], Some(text));
            let app = s.app.clone();
            async move { finish(app.fetch("POST", &mut req).await.expect("a path of the API")).await }
        };
        let method = polypack_server::docs::method_names()[0];
        let pieces = serde_json::to_string(&squares(12, 4, 1.0, "x")["pieces"]).unwrap();
        // `{"a":[[ ... ]]}` of exactly 4,096 bytes: 2,046 levels
        let params = |levels: usize| format!("{{\"a\":{}{}}}", "[".repeat(levels - 1), "]".repeat(levels - 1));
        let deepest = params(2046);
        assert_eq!(deepest.len(), 4096);
        let body = |p: usize, params: &str, more: &str| format!("{{\"N\":4,\"M\":4,\"P\":{p},\"name\":\"deep\",\"found_with\":\"optimizer\",\"method\":\"{method}\",\"method_params\":{params},\"pieces\":{pieces}{more}}}");

        // accepted, stored as it was sent, read back and written out
        let stored = submit(&s, body(12, &deepest, "")).await;
        assert_eq!(stored.status, 200, "{}", stored.body);
        let id = parse(&stored.body)["id"].as_f64().expect("kept");
        let back = s.get(&format!("/api/submissions/{id}")).await;
        assert_eq!(back.status, 200);
        assert!(back.body.contains(&format!("\"method_params\":{deepest},")), "the entry as it is read back");
        // the administrator's views of it, and a change of it
        let pending = s.call("GET", "/api/admin/pending", &[("authorization", &format!("Bearer {ADMIN}"))], None).await;
        assert_eq!(pending.status, 200);
        let edit = format!("{{\"id\":{id},\"found_with\":\"optimizer\",\"method\":\"{method}\",\"method_params\":{}}}", params(2000));
        let mut req = request("POST", "/api/admin/edit", &[("authorization", &format!("Bearer {ADMIN}"))], Some(edit));
        assert_eq!(finish(s.app.fetch("POST", &mut req).await.unwrap()).await.body, "{\"ok\":true}");
        assert!(s.get(&format!("/api/submissions/{id}")).await.body.contains(&format!("\"method_params\":{},", params(2000))));
        // the snapshot's file of the pair holds the entry
        let lit = Arc::new(Literature::new(records()).unwrap());
        let build = BuildOptions { store: s.store.clone(), dir: dir.clone(), closed: Arc::new(move |n, m, p| lit.closed(n, m, p)), spaces: None, log: Arc::new(|_: &str| {}), clock: s.clock.clone() };
        tokio::task::spawn_blocking(move || build_snapshot(&build).unwrap()).await.unwrap();
        let mut req = request("GET", "/api/snapshot/4-4.json.gz", &[], None);
        let res = s.app.fetch("GET", &mut req).await.unwrap();
        assert_eq!(res.status, 200);
        let ResBody::Full(gz) = res.body else { panic!("not bytes") };
        let mut text = String::new();
        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&gz[..]), &mut text).unwrap();
        assert!(text.contains("\"name\":\"deep\""), "{}", &text[..text.len().min(300)]);

        // one level more than 4,096 bytes hold: refused for its size, as the source refuses it
        for levels in [2047, 3000, MAX_DEPTH - 1] {
            let refused = submit(&s, body(12, &params(levels), "")).await;
            assert_eq!(refused.status, 400);
            assert_eq!(parse(&refused.body)["reasons"], json!(["method_params must be at most 4096 bytes as JSON"]), "{levels} levels");
        }
        // a field the server does not read may nest to the limit; beyond it the body is not JSON here
        let ignored = |levels: usize| format!(",\"extra\":{}{}", "[".repeat(levels), "]".repeat(levels));
        let accepted = submit(&s, body(12, "{}", &ignored(MAX_DEPTH - 1))).await;
        assert_eq!(accepted.status, 200, "{}", accepted.body);
        for levels in [MAX_DEPTH, 100_000] {
            let refused = submit(&s, body(12, "{}", &ignored(levels))).await;
            assert_eq!((refused.status, parse(&refused.body)["reasons"].clone()), (400, json!(["body is not valid JSON"])), "{levels} levels");
        }
        // every field that is read, nested to the limit where a number or a text belongs: refused in words, not by a crash
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH - 1), "]".repeat(MAX_DEPTH - 1));
        let deep_object = format!("{}1{}", "{\"a\":".repeat(MAX_DEPTH - 1), "}".repeat(MAX_DEPTH - 1));
        for field in ["N", "M", "P", "pieces", "container_phi", "name", "agent_note", "units", "found_with", "method", "seed", "budget", "software", "agent"] {
            for value in [&deep, &deep_object] {
                let text = format!("{{\"N\":4,\"M\":4,\"P\":12,\"name\":\"deep\",\"pieces\":{pieces},\"{field}\":{value}}}");
                let answer = submit(&s, text).await;
                assert!(answer.status == 400 || (field == "agent" && answer.status == 200) || (field == "units" && answer.status == 200), "{field}: {} {}", answer.status, &answer.body[..answer.body.len().min(200)]);
            }
        }
        // the spaces: a configuration, an id and every other field nested to the limit
        let space_ids = ["polyhedra/tidintid/30", "surface/cube/fold/4/30", "curved/-1/3/0/30", "torus/sq/0/30", "sphere/3/30", "sphere/3/2", "balls/ap12inball/100", "boundary/120cell/ball/5", "ndim/10/ball/ball/2"];
        for id in space_ids {
            let space = id.split('/').next().unwrap();
            let shallow = MAX_DEPTH - 3;
            let nest = |levels: usize| format!("{}{}", "[".repeat(levels), "]".repeat(levels));
            let configs = [
                nest(shallow),
                format!("{{\"pieces\":{}}}", nest(shallow)),
                format!("{{\"s\":1,\"rho\":1,\"size\":1,\"pieces\":[{}],\"poses\":[{}]}}", nest(shallow - 1), nest(shallow - 1)),
                format!("{{\"s\":1,\"rho\":100,\"pieces\":[{{\"q\":[1,0,0,0]}},{{\"q\":[0,1,0,0]}}],\"extra\":{}}}", nest(shallow)),
                format!("{}1{}", "{\"pieces\":".repeat(shallow), "}".repeat(shallow)),
            ];
            for config in &configs {
                let text = format!("{{\"space\":\"{space}\",\"id\":\"{id}\",\"name\":\"deep\",\"units\":\"diameter\",\"config\":{config}}}");
                let mut req = request("POST", "/api/spaces/submit", &[], Some(text));
                let answer = finish(s.app.fetch("POST", &mut req).await.unwrap()).await;
                assert!([200, 400, 409, 422].contains(&answer.status), "{id}: {} {}", answer.status, &answer.body[..answer.body.len().min(200)]);
            }
            for field in ["id", "name", "agent_note", "software", "method", "seed", "units", "space"] {
                let text = format!("{{\"space\":\"{space}\",\"id\":\"{id}\",\"name\":\"deep\",\"config\":{{}},\"{field}\":{deep}}}");
                let mut req = request("POST", "/api/spaces/submit", &[], Some(text));
                let answer = finish(s.app.fetch("POST", &mut req).await.unwrap()).await;
                assert!([400, 409, 426].contains(&answer.status), "{id} {field}: {} {}", answer.status, &answer.body[..answer.body.len().min(200)]);
            }
        }
        // the administrator's routes: a row that is none is written back in the refusal
        let row = format!("{}1{}", "{\"a\":".repeat(MAX_DEPTH - 2), "}".repeat(MAX_DEPTH - 2));
        let peaks = format!("{{\"peaks\":[{row}]}}");
        let mut req = request("POST", "/api/admin/holder-peaks", &[("authorization", &format!("Bearer {ADMIN}"))], Some(peaks));
        let answer = finish(s.app.fetch("POST", &mut req).await.unwrap()).await;
        assert!(answer.status == 400 && answer.body.contains("bad row") && answer.body.len() > row.len(), "{} {}", answer.status, &answer.body[..answer.body.len().min(200)]);
        for path in ["/api/admin/review", "/api/admin/remove", "/api/admin/edit", "/api/admin/spaces/remove", "/api/admin/spaces/edit"] {
            for text in [deep.clone(), format!("{{\"id\":{deep}}}"), format!("{{\"id\":{},\"decision\":{deep},\"name\":{deep},\"agent_note\":{deep},\"found_with\":{deep},\"method_params\":{deep_object},\"budget\":{deep_object}}}", if path.ends_with("/edit") { id } else { 999.0 })] {
                let mut req = request("POST", path, &[("authorization", &format!("Bearer {ADMIN}"))], Some(text));
                let answer = finish(s.app.fetch("POST", &mut req).await.unwrap()).await;
                assert!(answer.status == 400 || answer.status == 404, "{path}: {} {}", answer.status, answer.body);
            }
        }
        // the first entry is still what it was made by the edit
        assert!(s.get(&format!("/api/submissions/{id}")).await.body.contains(&format!("\"method_params\":{},", params(2000))));
        let _ = std::fs::remove_dir_all(&dir);
    });
    runtime.block_on(work).expect("no step failed");
}

// Finding 5, as a client sees it: a backslash before a character of several bytes is not JSON
// (400), where the reading once panicked (500).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_that_is_almost_json_is_refused_in_words() {
    let s = server(Setup::default());
    for text in ["{\"x\":\"\\\u{e9}\"}", "{\"N\":4,\"name\":\"\\\u{1f600}\"}", "[1e999,\"\\\u{20ac}\"]", "{\"x\":\"\\"] {
        for path in ["/api/submit", "/api/spaces/submit"] {
            let mut req = request("POST", path, &[], Some(text.to_string()));
            let answer = finish(s.app.fetch("POST", &mut req).await.unwrap()).await;
            assert_eq!((answer.status, answer.json()["reasons"].clone()), (400, json!(["body is not valid JSON"])), "{text:?}");
        }
    }
}

// The stop (SIGTERM): the process once exited the moment the signal came, also between the
// transaction that stored an entry and the writing of its answer (2 of 22,385 entries in 12 stops
// under load had no answer). The stop now waits for the answers under way, takes no new request,
// and gives up waiting after a set time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_stop_waits_for_the_answers_under_way_and_takes_nothing_new() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let s = server(Setup::default());
    let (address, listening) = listening_server(&s, None, polypack_server::node::ConnLimits::default()).await;
    let entry = squares(11, 4, 1.0, "ann").to_string();
    // a connection that is open and idle, and an entry whose storing is held up: the store is busy
    let mut idle = tokio::net::TcpStream::connect(address).await.unwrap();
    idle.write_all(b"GET /api/health HTTP/1.1\r\nHost: test\r\n\r\n").await.unwrap();
    let mut first = [0u8; 17];
    idle.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"HTTP/1.1 200 OK\r\n");
    let held = s.store.clone();
    let (locked, is_locked) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let _store = held.lock().unwrap();
        locked.send(()).unwrap();
        let _ = released.recv();
    });
    is_locked.recv().unwrap();
    let under_way = tokio::spawn(async move { raw(address, &post("/api/submit", "Connection: close\r\n", &entry), false, Duration::from_secs(20)).await });
    tokio::time::sleep(Duration::from_millis(200)).await;

    // the stop does not return while the entry is unanswered
    let began = std::time::Instant::now();
    let stop = {
        let listening = listening.clone();
        tokio::spawn(async move { listening.stop(Duration::from_secs(20)).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!stop.is_finished());
    // nothing new is taken meanwhile: not on a connection that was open, and no new connection
    idle.write_all(&post("/api/submit", "", &squares(12, 4, 1.0, "late").to_string())).await.unwrap();
    let mut rest = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), idle.read_to_end(&mut rest)).await.expect("the connection is closed");
    assert!(!String::from_utf8_lossy(&rest).contains("HTTP/1.1 200"), "{}", String::from_utf8_lossy(&rest));
    let refused = match tokio::net::TcpStream::connect(address).await {
        Err(_) => true,
        Ok(mut late) => {
            let _ = late.write_all(b"GET /api/health HTTP/1.1\r\nHost: test\r\n\r\n").await;
            let mut got = Vec::new();
            let _ = tokio::time::timeout(Duration::from_secs(1), late.read_to_end(&mut got)).await;
            got.is_empty()
        }
    };
    assert!(refused, "a connection after the stop is not served");
    // the store is free again: the entry is stored and answered, and only then is the stop over
    release.send(()).unwrap();
    holder.join().unwrap();
    let (answer, _) = under_way.await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 OK\r\n") && answer.contains("\"id\":1"), "{answer}");
    tokio::time::timeout(Duration::from_secs(5), stop).await.expect("the stop ends once the answer is out").unwrap();
    assert!(began.elapsed() >= Duration::from_millis(300));
    assert_eq!(rows(&s), (1.0, 1));

    // and a request that never ends does not hold the stop for longer than it is told to wait
    let s = server(Setup::default());
    let (address, listening) = listening_server(&s, None, polypack_server::node::ConnLimits::default()).await;
    let mut slow = tokio::net::TcpStream::connect(address).await.unwrap();
    slow.write_all(b"POST /api/submit HTTP/1.1\r\nHost: test\r\nContent-Length: 100\r\n\r\n{").await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let began = std::time::Instant::now();
    listening.stop(Duration::from_millis(300)).await;
    assert!(began.elapsed() >= Duration::from_millis(290) && began.elapsed() < Duration::from_secs(3), "{:?}", began.elapsed());
}
