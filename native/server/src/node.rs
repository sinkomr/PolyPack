//! Port of apps/server/src/node.ts: the entry point. Environment variables, startup, the timers,
//! the built website beside the API, signals.
//!
//! With `POLYPACK_TEST_OPTIONS` (a JSON file) the server also takes the options of the
//! differential harness, reads the test clock and answers `POST /__test/control`
//! (native/tools/serverdiff/README.md, "The contract of a server under test"; its reference is
//! native/tools/serverdiff/ref-server.mts). Without the variable none of that exists.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::Request;
use serde_json::Value;

use crate::app::{App, AppOptions, LimitOptions, Log, StoreHandle};
use crate::clock::Clock;
use crate::hono::{self, Req, Res};
use crate::js;
use crate::limits::{MIN_SUBMIT_KEY_LENGTH, OVERLOAD_DELAY_MS};
use crate::load::LoadStats;
use crate::pool::Pool;
use crate::serve_static::serve_static;
use crate::snapshot::{schedule_snapshots, BuildOptions, ClosedFn, ScheduleOptions, SnapshotSource, SnapshotSpaces, SourceOptions};
use crate::spaces::{SpacesPort, StandInSpaces};
use crate::store::{MigrationOptions, OpenOptions, SpaceIds, SqliteStore, EPOCH_DIAMETER};
use crate::url;

/// The options file of the differential harness; every field is optional.
#[derive(Default)]
struct TestOptions {
    records_file: Option<String>,
    /// The directory under which data/<space>/records.json is read; for the port of the spaces.
    #[allow(dead_code)]
    spaces_root: Option<String>,
    /// None: the default (apps/web/dist when it exists); Some(None): no static site.
    static_dir: Option<Option<String>>,
    limits: LimitOptions,
    holders_chunk: Option<f64>,
    holder_chunk: Option<f64>,
    units_gate: Option<bool>,
    snapshot_start_delay_ms: Option<f64>,
    clock_offset_ms: Option<f64>,
    loop_delay_ms: Option<f64>,
    stats_flush_ms: Option<f64>,
}

impl TestOptions {
    fn read(path: &str) -> Result<TestOptions, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("POLYPACK_TEST_OPTIONS: {path}: {e}"))?;
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("POLYPACK_TEST_OPTIONS: {path}: {e}"))?;
        let number = |v: Option<&Value>| v.filter(|v| v.is_number()).and_then(Value::as_f64);
        let text = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
        let limits = v.get("limits");
        let limit = |key: &str| number(limits.and_then(|l| l.get(key)));
        Ok(TestOptions {
            records_file: text(v.get("recordsFile")),
            spaces_root: text(v.get("spacesRoot")),
            static_dir: match v.get("staticDir") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(other) => Some(text(Some(other))),
            },
            limits: LimitOptions {
                per_ip: limit("perIp"),
                window_ms: limit("windowMs"),
                verify_ms_per_minute: limit("verifyMsPerMinute"),
                per_key: limit("perKey"),
                key_verify_ms_per_minute: limit("keyVerifyMsPerMinute"),
                overload_delay_ms: limit("overloadDelayMs"),
                snapshot_files_per_hour: limit("snapshotFilesPerHour"),
            },
            holders_chunk: number(v.get("holdersChunk")),
            holder_chunk: number(v.get("holderChunk")),
            units_gate: v.get("unitsGate").and_then(Value::as_bool),
            snapshot_start_delay_ms: number(v.get("snapshotStartDelayMs")),
            clock_offset_ms: number(v.get("clockOffsetMs")),
            loop_delay_ms: number(v.get("loopDelayMs")),
            stats_flush_ms: number(v.get("statsFlushMs")),
        })
    }
}

/// `process.env[name]`.
fn env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
}

/// `process.env[name] || undefined`.
fn env_nonempty(name: &str) -> Option<String> {
    env(name).filter(|v| !v.is_empty())
}

/// node.ts: wholeNumber. A non-negative integer setting; the default when it is unset or not such
/// a number.
fn whole_number(name: &str, fallback: f64) -> f64 {
    let Some(text) = env_nonempty(name) else {
        return fallback;
    };
    if (1..=9).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit()) {
        return js::number(&text);
    }
    eprintln!("{name}={text} is not a whole number; using {}", polypack_js::fmt::num(fallback));
    fallback
}

/// The website built into `dist`, beside the API (node.ts: the `app.use` lines after createApp).
struct StaticSite {
    dist: String,
}

impl StaticSite {
    async fn answer(&self, req: &Req) -> Res {
        let path = req.path.as_str();
        let under = |prefix: &str| path == prefix || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'));
        // The game's space runs share memory with their worker (SharedArrayBuffer), which a page
        // gets only when it is cross-origin isolated, and an isolated page loads its worker's
        // script, and in Safari every module that worker imports, only when they are served with
        // the same embedder policy. This page alone is isolated: it loads nothing from other
        // origins. The built assets all carry the embedder policy, which changes nothing for the
        // other pages that load them.
        let mut prepared: Vec<(String, String)> = Vec::new();
        if path == "/tighter.html" {
            prepared.push(("cross-origin-opener-policy".to_string(), "same-origin".to_string()));
            prepared.push(("cross-origin-embedder-policy".to_string(), "require-corp".to_string()));
        }
        if under("/assets") {
            prepared.retain(|(k, _)| k != "cross-origin-embedder-policy");
            prepared.push(("cross-origin-embedder-policy".to_string(), "require-corp".to_string()));
        }
        let dist = self.dist.clone();
        let served = tokio::task::block_in_place(|| serve_static(&dist, req));
        let mut res = match served {
            Ok(Some(res)) => res,
            Ok(None) => hono::not_found(),
            Err(mut thrown) => {
                let mut headers = prepared.clone();
                headers.append(&mut thrown.headers);
                thrown.headers = headers;
                hono::on_error(thrown)
            }
        };
        // the headers set with c.header before the file was looked for
        for (name, value) in prepared.into_iter().rev() {
            if res.header(&name).is_none() {
                res.headers.insert(0, (name, value));
            }
        }
        // the spaces' standalone viewers carry their data inline (the sweep viewer is about 4 MB)
        if under("/spaces") {
            res = hono::compress(&req.method, req.header("accept-encoding").as_deref(), res).await;
        }
        res
    }
}

/// What the test contract adds to the server.
struct TestControl {
    clock: Clock,
    /// The delay the overload check reads instead of the measured one; None: the measured one.
    loop_delay_override: Arc<Mutex<Option<f64>>>,
}

/// The server: the API, the test route when there is one, and the website.
struct Server {
    app: Arc<App>,
    test: Option<TestControl>,
    site: Option<StaticSite>,
    stats: Arc<Mutex<LoadStats>>,
    pool: Pool,
    /// HOST, when it is set.
    default_hostname: Option<String>,
}

impl Server {
    /// POST /__test/control: the one test-only route.
    async fn control(&self, test: &TestControl, req: &mut Req) -> Res {
        let bytes = hono::read_body(req).await;
        let body = polypack_js::json::parse(&bytes).ok();
        let Some(Value::Object(body)) = body else {
            return hono::json_error("body must be a JSON object", 400);
        };
        if let Some(offset) = body.get("clockOffsetMs").filter(|v| v.is_number()).and_then(Value::as_f64) {
            test.clock.set_offset_ms(offset);
        }
        match body.get("loopDelayMs") {
            Some(Value::Null) => *test.loop_delay_override.lock().unwrap() = None,
            Some(Value::Number(n)) => *test.loop_delay_override.lock().unwrap() = n.as_f64(),
            _ => {}
        }
        if body.get("flushStats") == Some(&Value::Bool(true)) {
            let peak = self.pool.take_peak();
            self.stats.lock().unwrap().flush(peak);
        }
        hono::json_text("{\"ok\":true}", 200)
    }

    /// hono-base.js: fetch. A HEAD request is answered as the GET request would be, without its
    /// body. Returns the answer and whether its body is left out.
    async fn fetch(&self, mut req: Req) -> (Res, bool) {
        let head = req.method == "HEAD";
        let method = if head { "GET".to_string() } else { req.method.clone() };
        let res = match self.app.fetch(&method, &mut req).await {
            Some(res) => res,
            None => match (&self.test, &self.site) {
                (Some(test), _) if method == "POST" && req.path == "/__test/control" => self.control(test, &mut req).await,
                (_, Some(site)) => site.answer(&req).await,
                _ => hono::not_found(),
            },
        };
        // a body that no route read
        if let Some(body) = req.take_body() {
            hono::drain(body);
        }
        (res, head)
    }

    /// One request of a connection.
    async fn handle(self: Arc<Self>, remote: SocketAddr, request: Request) -> axum::response::Response {
        let (parts, body) = request.into_parts();
        // @hono/node-server: newRequest. The URL is `http://` + Host + the request target.
        let target = parts.uri.path_and_query().map_or("", |p| p.as_str());
        if !target.starts_with('/') {
            // `OPTIONS *`, or no path at all: `new URL` throws, and node-server answers 400 (handleRequestError)
            return hono::into_response(Res::new(400, hono::ResBody::Null).with("content-type", "text/plain; charset=UTF-8"), parts.method == axum::http::Method::HEAD);
        }
        let host = parts.uri.authority().map(|a| a.as_str().to_string()).or_else(|| parts.headers.get("host").map(|h| js::latin1(h.as_bytes())));
        // a request of HTTP/1.0 may come without a Host header: the address the server listens on stands in (`hostname` of serve)
        let host = host.filter(|h| !h.is_empty()).or_else(|| if parts.version < axum::http::Version::HTTP_11 { self.default_hostname.clone() } else { None });
        let Some(host) = host else {
            // Node answers a request without a Host header itself
            return hono::into_response(Res::new(400, hono::ResBody::Null).with("connection", "close"), parts.method == axum::http::Method::HEAD);
        };
        let href = url::href(&host, &js::latin1(target.as_bytes()));
        let has_body = !matches!(parts.method.as_str(), "GET" | "HEAD");
        let req = Req { method: parts.method.as_str().to_string(), path: url::get_path(&href), url: href, headers: parts.headers, remote: Some(remote), body: Mutex::new(has_body.then_some(body)) };
        // Node runs a request to its end whether or not the client is still there; so does this:
        // the work is a task of its own, not a part of the connection that would end with it.
        let server = self.clone();
        match tokio::spawn(async move { server.fetch(req).await }).await {
            Ok((res, head)) => hono::into_response(res, head),
            Err(e) => {
                eprintln!("{e}");
                hono::into_response(hono::text("Internal Server Error", 500), false)
            }
        }
    }
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(1)
}

/// Refuses what the stand-in for the spaces cannot do: converting a database in the old units that
/// holds entries of the spaces (their problems' ids decide the factors).
fn check_convertible(path: &str) {
    if path == ":memory:" || !Path::new(path).exists() {
        return;
    }
    let Ok(db) = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return;
    };
    let one = |sql: &str| db.query_row(sql, [], |r| r.get::<_, f64>(0)).ok();
    let entries = one("SELECT COUNT(*) FROM space_entries").unwrap_or(0.0);
    let has_submissions = one("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'submissions'").unwrap_or(0.0) > 0.0;
    let epoch = one("SELECT value FROM meta WHERE key = 'units_epoch'").unwrap_or(0.0);
    if has_submissions && entries > 0.0 && epoch < EPOCH_DIAMETER {
        fail("this build of the server has no port of the spaces yet, and the database holds entries of the spaces in the units before 2026-10-27: it cannot convert them. Start the TypeScript server on this database once, or a build with the spaces.");
    }
}

/// node.ts, from its first line to the last. Never returns: the process ends on SIGINT or SIGTERM.
pub async fn main() {
    let options_path = env_nonempty("POLYPACK_TEST_OPTIONS");
    let test = match &options_path {
        Some(path) => TestOptions::read(path).unwrap_or_else(|e| fail(&e)),
        None => TestOptions::default(),
    };
    let clock = Clock::new();
    // before anything reads the time
    if let Some(offset) = test.clock_offset_ms {
        clock.set_offset_ms(offset);
    }
    let loop_delay_override = Arc::new(Mutex::new(test.loop_delay_ms));
    let out: Log = Arc::new(|msg: &str| println!("{msg}"));

    // The source finds the repository from its own file; a binary has no such place, so it is the
    // working directory (the harness and the container both start the server there).
    let root: PathBuf = std::env::current_dir().unwrap_or_else(|e| fail(&format!("no working directory: {e}")));
    let resolve = |rel: &str| root.join(rel).to_string_lossy().into_owned();
    let port_text = env("PORT");
    let port = port_text.as_deref().map_or(8787.0, js::number);
    let database_path = env("DATABASE_PATH").unwrap_or_else(|| resolve("polypack.sqlite"));
    // HOST=127.0.0.1 keeps the server off the network when a tunnel or proxy on the same machine fronts it.
    let hostname = env_nonempty("HOST");
    let trust_proxy = env("TRUST_PROXY").as_deref() == Some("1");
    // A header that the proxy in front sets itself to the visitor's address and that a visitor
    // cannot forge: "fly-client-ip" on Fly.io, "cf-connecting-ip" behind Cloudflare. Preferred over
    // TRUST_PROXY, because proxies append to x-forwarded-for and so leave its first entry in the
    // visitor's hands.
    let client_ip_header = env_nonempty("CLIENT_IP_HEADER").map(|h| h.to_lowercase());
    // The placeholder from .env.example must never work as a real token: without one, admin routes answer 503.
    let admin_env = env("ADMIN_TOKEN");
    let admin_token = if admin_env.as_deref() == Some("change-me") { None } else { admin_env.clone().filter(|t| !t.is_empty()) };
    if admin_env.as_deref() == Some("change-me") {
        eprintln!("ADMIN_TOKEN is still the placeholder; admin access is disabled");
    }
    // The submit key (see SUBMIT_KEY_HEADER): a short one is not used, since a guess could find it.
    let submit_key_text = env("SUBMIT_KEY").map(|k| js::trim(&k).to_string()).filter(|k| !k.is_empty());
    let submit_key = submit_key_text.clone().filter(|k| js::utf16_len(k) >= MIN_SUBMIT_KEY_LENGTH);
    if submit_key_text.is_some() && submit_key.is_none() {
        eprintln!("SUBMIT_KEY has fewer than {MIN_SUBMIT_KEY_LENGTH} characters; submissions with a key are refused");
    }

    let records_path = test.records_file.clone().unwrap_or_else(|| resolve("data/records.json"));
    let records: Vec<Value> = std::fs::read_to_string(&records_path)
        .map_err(|e| e.to_string())
        .and_then(|text| crate::store::json::parse(&text).map_err(|e| e.message()))
        .ok()
        .and_then(|mut v| v.get_mut("records").map(Value::take))
        .and_then(|r| match r {
            Value::Array(list) => Some(list),
            _ => None,
        })
        .unwrap_or_else(|| fail(&format!("the published records could not be read from {records_path}")));
    // The research records of the spaces (data/<space>/records.json). Their port is to come: until
    // then the server knows the spaces' names and the texts of the API page, and no problem.
    let spaces: Arc<dyn SpacesPort> = Arc::new(StandInSpaces::new());

    if !spaces.complete() {
        check_convertible(&database_path);
    }
    let store = {
        let mut log = |msg: &str| println!("{msg}");
        let ids: &dyn SpaceIds = &*spaces;
        let opened = SqliteStore::open(&database_path, OpenOptions { migrate_units: true, log: Some(&mut log), spaces: ids, clock: Box::new(clock.clone()), tracer: None });
        opened.unwrap_or_else(|e| fail(&format!("{}: {}", e.name(), e.message())))
    };
    // Rewrites the pieces of older rows in small steps while the site runs (see
    // docs/DEPLOY_FLY.md). Each step is one short transaction, so requests wait at most for one
    // step. PIECES_MIGRATION_BATCH=0 switches it off.
    let migration = {
        let mut log = |msg: &str| println!("{msg}");
        let options = MigrationOptions { batch: whole_number("PIECES_MIGRATION_BATCH", 100.0), pause_ms: whole_number("PIECES_MIGRATION_PAUSE_MS", 1000.0), log_every_ms: None };
        store.start_pieces_migration(options, &mut log).unwrap_or_else(|e| fail(&format!("{}: {}", e.name(), e.message())))
    };
    let store: StoreHandle = Arc::new(Mutex::new(store));

    let pool = Pool::new(0, clock.clone());
    // One log line per submission and one a minute with the counts and verification times, so
    // that the load in production can be read from the log.
    let stats = {
        let out = out.clone();
        Arc::new(Mutex::new(LoadStats::new(Box::new(move |line| out(line)))))
    };

    // The records snapshot (snapshot.rs): a manifest built into SNAPSHOT_DIR at SNAPSHOT_HOUR (UTC,
    // 11 by default: after the nightly trim-down job) and served at /api/snapshot; each file of it
    // is generated from the database when it is asked for, and none is stored (files an older
    // server stored in SNAPSHOT_DIR are deleted at startup). Off without SNAPSHOT_DIR.
    let snapshot_dir = env_nonempty("SNAPSHOT_DIR");
    let snapshot_hour = whole_number("SNAPSHOT_HOUR", 11.0);
    let overload_delay_ms = whole_number("OVERLOAD_DELAY_MS", OVERLOAD_DELAY_MS);

    let trust = trust_proxy;
    let header = client_ip_header.clone();
    // Behind a proxy the socket address is the proxy's, so a header set by the proxy is used
    // instead. Only set CLIENT_IP_HEADER or TRUST_PROXY when a proxy that sets the header is
    // really in front.
    let client_ip = move |req: &Req| -> String {
        if let Some(name) = &header {
            if let Some(v) = req.header(name).map(|v| js::trim(&v).to_string()).filter(|v| !v.is_empty()) {
                return v;
            }
        }
        if trust {
            if let Some(v) = req.header("x-forwarded-for").map(|v| js::trim(v.split(',').next().unwrap_or("")).to_string()).filter(|v| !v.is_empty()) {
                return v;
            }
        }
        req.remote.map(|a| a.ip().to_string()).filter(|a| !a.is_empty()).unwrap_or_else(|| "unknown".to_string())
    };
    let delay = {
        let pool = pool.clone();
        let forced = loop_delay_override.clone();
        move || forced.lock().unwrap().unwrap_or_else(|| pool.delay_ms())
    };

    let literature = Arc::new(crate::app::Literature::new(records).unwrap_or_else(|e| fail(&e)));
    let closed: ClosedFn = {
        let literature = literature.clone();
        Arc::new(move |n, m, p| literature.closed(n, m, p))
    };
    // the spaces' site entries, one file per space, for their open problems
    let snapshot_spaces = SnapshotSpaces::new(spaces.clone());
    let snapshots = snapshot_dir.as_ref().map(|dir| {
        Arc::new(SnapshotSource::new(SourceOptions { dir: PathBuf::from(dir), store: store.clone(), closed: closed.clone(), spaces: Some(snapshot_spaces.clone()), max_concurrent: None }))
    });

    let app = App::new(AppOptions {
        store: store.clone(),
        records: literature,
        admin_token,
        submit_key,
        client_ip: Some(Box::new(client_ip)),
        log: Some(out.clone()),
        // 0 never refuses submissions as overload; the end-to-end tests set it, since a test
        // machine under load is slow without the server being overloaded
        limits: LimitOptions { overload_delay_ms: test.limits.overload_delay_ms.or(Some(overload_delay_ms)), ..test.limits },
        loop_delay: Some(Box::new(delay)),
        stats: Some(stats.clone()),
        holders_chunk: test.holders_chunk,
        holder_chunk: test.holder_chunk,
        clock: clock.clone(),
        units_gate: test.units_gate,
        snapshots,
        spaces: Some(spaces.clone()),
        pool: pool.clone(),
    })
    .unwrap_or_else(|e| fail(&e));

    // In production the built web app is served by the same process.
    let dist = match &test.static_dir {
        None => Some(resolve("apps/web/dist")),
        Some(dir) => dir.clone(),
    };
    let site = dist.filter(|d| Path::new(d).exists()).map(|dist| StaticSite { dist });

    let records_count = app.literature().len();
    let server = Arc::new(Server {
        app,
        test: options_path.as_ref().map(|_| TestControl { clock: clock.clone(), loop_delay_override }),
        site,
        stats: stats.clone(),
        pool: pool.clone(),
        default_hostname: hostname.clone(),
    });

    // server.listen(port, hostname)
    if !(js::is_integer(port) && (0.0..65536.0).contains(&port)) {
        fail(&format!("RangeError [ERR_SOCKET_BAD_PORT]: options.port should be >= 0 and < 65536. Received type number ({}).", polypack_js::fmt::num(port)));
    }
    let port_number = port as u16;
    let listener = match &hostname {
        Some(host) => tokio::net::TcpListener::bind((host.as_str(), port_number)).await,
        // every address, IPv6 and IPv4 alike, as Node listens without a host
        None => match tokio::net::TcpListener::bind(("::", port_number)).await {
            Ok(l) => Ok(l),
            Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", port_number)).await,
        },
    }
    .unwrap_or_else(|e| fail(&format!("listen: {e}")));
    out(&format!("PolyPack server on http://localhost:{} (database {database_path}, {records_count} literature records)", polypack_js::fmt::num(port)));

    // A host stops the process with a signal at every deploy and restart. Open live-update streams
    // would keep it alive until the host kills it, so exit at once; SQLite has committed every write.
    tokio::spawn(async {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("a signal handler");
        let mut int = signal(SignalKind::interrupt()).expect("a signal handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        std::process::exit(0);
    });

    // the timers of the source, each a task
    if let Some(dir) = snapshot_dir {
        schedule_snapshots(ScheduleOptions {
            build: BuildOptions { store: store.clone(), dir: PathBuf::from(dir), closed, spaces: Some(snapshot_spaces), log: out.clone(), clock: clock.clone() },
            hour_utc: if snapshot_hour < 24.0 { snapshot_hour } else { 11.0 },
            // test option; node.ts leaves the default of 5 minutes
            start_delay_ms: test.snapshot_start_delay_ms,
        });
    }
    // test option: how often the load line is written (node.ts: every minute); 0 writes it on request only
    let stats_flush_ms = test.stats_flush_ms.unwrap_or(60_000.0);
    if stats_flush_ms > 0.0 {
        let (stats, pool) = (stats.clone(), pool.clone());
        tokio::spawn(async move {
            let period = Duration::from_secs_f64(stats_flush_ms / 1000.0);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                ticks.tick().await;
                let peak = pool.take_peak();
                stats.lock().unwrap().flush(peak);
            }
        });
    }
    if let Some(first) = migration.first_delay_ms() {
        let store = store.clone();
        tokio::spawn(async move {
            let mut migration = migration;
            let mut wait = first;
            loop {
                tokio::time::sleep(Duration::from_secs_f64(wait.max(0.0) / 1000.0)).await;
                let next = tokio::task::block_in_place(|| {
                    let store = store.lock().unwrap();
                    migration.tick(&store, &mut |msg: &str| println!("{msg}"))
                });
                match next {
                    Some(delay) => wait = delay,
                    None => break,
                }
            }
        });
    }

    // Each connection is served by hyper, HTTP/1.1 only, as Node's `http` serves it. A request's
    // head must arrive within 60 s (Node: `headersTimeout`). When the client closes the connection,
    // also only its sending side, what is being answered is given up at once (hyper's default; Node
    // does the same, `socketOnEnd`, except that an answer it has ready at that moment still goes
    // out): that is what ends a live stream whose reader has gone, and frees its listener.
    loop {
        let (stream, remote) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(_) => {
                // out of file descriptors, or the connection was gone already: go on with the next
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        // Node's sockets send at once (no Nagle delay)
        let _ = stream.set_nodelay(true);
        let server = server.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                let server = server.clone();
                async move { Ok::<_, std::convert::Infallible>(server.handle(remote, request.map(axum::body::Body::new)).await) }
            });
            let mut http = hyper::server::conn::http1::Builder::new();
            http.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(60));
            let _ = http.serve_connection(hyper_util::rt::TokioIo::new(stream), service).await;
        });
    }
}
