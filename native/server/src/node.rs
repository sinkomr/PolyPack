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
use crate::spaces::{LoadedSpaces, SpacesPort};
use crate::store::{MigrationOptions, OpenOptions, SpaceIds, SqliteStore};
use crate::url;

/// The options file of the differential harness; every field is optional.
#[derive(Default)]
struct TestOptions {
    records_file: Option<String>,
    /// The directory under which data/<space>/records.json is read; the repository root by default.
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
        let served = crate::pool::blocking(|| serve_static(&dist, req)).await;
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

/// What Node's `http.Server` allows a connection, by its defaults. They are those of Node 24 and
/// of the Node 26 at hand alike: `new http.Server()` there reports requestTimeout 300000,
/// headersTimeout 60000 and http.maxHeaderSize 16384, and the typings of Node 24
/// (@types/node 24.19, http.d.ts) document the same. `@hono/node-server` makes its server with
/// `createServer({}, listener)`: nothing of these is changed.
#[derive(Clone, Copy, Debug)]
pub struct ConnLimits {
    /// `server.headersTimeout`: a request's head must have arrived this long after the connection
    /// began to wait for it. Node looks every 30 s (`connectionsCheckingInterval`), so there the
    /// time is 60 to 90 s; here it is 60 s.
    pub headers_timeout: Duration,
    /// `server.requestTimeout`: the whole request, body included, must have arrived this long
    /// after it began (Node: 300 to 330 s after its first byte; here 300 s after its head).
    pub request_timeout: Duration,
    /// `--max-http-header-size`: a head is refused when the lengths of its request target and of
    /// its header names and values come to this many bytes or more (measured against Node:
    /// 16383 is read, 16384 refused, whatever the number of headers; the spaces after a name's
    /// colon, the line ends, the method and the version do not count).
    pub max_header_size: usize,
}

impl Default for ConnLimits {
    fn default() -> ConnLimits {
        ConnLimits { headers_timeout: Duration::from_secs(60), request_timeout: Duration::from_secs(300), max_header_size: 16 * 1024 }
    }
}

/// Most headers a request may have: Node reads the first 2,000 (`server.maxHeadersCount`) and
/// drops the rest without a word; hyper refuses a request with more than it was told to read
/// (431), and 100 unless told. Within Node's 16 KiB of head, 2,000 headers are hardly reached.
const MAX_HEADERS: usize = 2000;

/// The most bytes of a head hyper buffers before it answers 431 itself. Node's rule
/// (`ConnLimits::max_header_size`) counts less than every byte, so it is applied to the head once
/// it is read (`Server::handle`); this is the room that takes: 16 KiB of names and values, and
/// the separators of 2,000 headers with space to spare.
const HEAD_BUFFER_BYTES: usize = 64 * 1024;

/// What a connection says last, written as it is when the connection is given up (`hono::cut`).
type LastWords = Arc<Mutex<Option<&'static [u8]>>>;

/// A connection as hyper reads and writes it, with the last words of `Server::handle` when a
/// request ends it: Node writes them to the socket itself and destroys it, and hyper has no such
/// answer (one made through hyper would carry `content-length` and `date`).
struct Wire {
    io: hyper_util::rt::TokioIo<tokio::net::TcpStream>,
    last_words: LastWords,
}

impl hyper::rt::Read for Wire {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: hyper::rt::ReadBufCursor<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl hyper::rt::Write for Wire {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_shutdown(cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_write_vectored(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, bufs: &[std::io::IoSlice<'_>]) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        // the connection is closed as this ends; a few bytes into an empty send buffer do not wait
        if let Some(words) = self.last_words.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = self.io.inner().try_write(words);
        }
    }
}

/// A request that ends its connection: what hyper is told when `Server::handle` gives last words.
#[derive(Debug)]
struct Cut;

impl std::fmt::Display for Cut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the request could not be read to its end")
    }
}

impl std::error::Error for Cut {}

/// A request that may write (a POST), from its arrival until its answer has been handed to the
/// connection whole: what the stop waits for (`Server::stop`).
struct Writing(Arc<std::sync::atomic::AtomicUsize>);

impl Writing {
    fn begin(count: &Arc<std::sync::atomic::AtomicUsize>) -> Writing {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Writing(count.clone())
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The body of an answer to such a request: the same body, counted until hyper has taken all of
/// it or given it up.
struct Counted {
    body: axum::body::Body,
    _writing: Writing,
}

impl hyper::body::Body for Counted {
    type Data = bytes::Bytes;
    type Error = axum::Error;

    fn poll_frame(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Result<hyper::body::Frame<bytes::Bytes>, axum::Error>>> {
        std::pin::Pin::new(&mut self.body).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.body.size_hint()
    }
}

/// The server: the API, the test route when there is one, and the website.
pub struct Server {
    app: Arc<App>,
    test: Option<TestControl>,
    site: Option<StaticSite>,
    stats: Arc<Mutex<LoadStats>>,
    pool: Pool,
    /// HOST, when it is set.
    default_hostname: Option<String>,
    /// The requests that may write and are not answered yet.
    writing: Arc<std::sync::atomic::AtomicUsize>,
    /// Told when the server stops: no further connection is taken.
    stopping: tokio::sync::Notify,
    /// True from then on: no further request is taken either.
    stopped: std::sync::atomic::AtomicBool,
}

impl Server {
    /// The API of `app` and, with `dist`, the website in that directory: the production server
    /// without its settings, for a test that speaks to it over a socket (`serve`).
    pub fn of(app: Arc<App>, dist: Option<String>) -> Arc<Server> {
        let clock = Clock::new();
        Arc::new(Server {
            app,
            test: None,
            site: dist.map(|dist| StaticSite { dist }),
            stats: Arc::new(Mutex::new(LoadStats::new(Box::new(|_| {})))),
            pool: Pool::new(1, clock),
            default_hostname: None,
            writing: Arc::default(),
            stopping: tokio::sync::Notify::new(),
            stopped: false.into(),
        })
    }

    /// The stop of node.ts (`server.close()`, then the process exits): no further connection and
    /// no further request is taken (a request that comes now finds its connection closed, as it
    /// would a process that has gone), and this returns once no request that may write is
    /// unanswered, or after `at_most`.
    ///
    /// Node exits at once, and can: on its one thread a submission's transaction and the writing
    /// of its answer are one uninterrupted step, so the signal comes before both or after both.
    /// Here the transaction is committed on a worker and the answer written by another thread a
    /// moment later; a process that exited in between left an entry stored whose sender never
    /// heard of it (measured: 2 of 22,385 entries stored in 12 stops under load). So the stop
    /// waits for the answers under way, some milliseconds. Open streams are not waited for.
    pub async fn stop(&self, at_most: Duration) {
        use std::sync::atomic::Ordering;
        self.stopped.store(true, Ordering::SeqCst);
        self.stopping.notify_waiters();
        let give_up = tokio::time::Instant::now() + at_most;
        let settle = Duration::from_millis(15);
        loop {
            if self.writing.load(Ordering::SeqCst) == 0 {
                // an answer handed over is written to its socket in the same breath: let that pass
                tokio::time::sleep(settle).await;
                if self.writing.load(Ordering::SeqCst) == 0 {
                    return;
                }
            } else if tokio::time::Instant::now() >= give_up {
                return;
            } else {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }

    /// POST /__test/control: the one test-only route.
    async fn control(&self, test: &TestControl, req: &mut Req) -> Res {
        let bytes = match hono::read_body(req).await {
            Ok(bytes) => bytes,
            Err(cut) => return cut,
        };
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

    /// One request of a connection: its answer, or the last words of the connection when the
    /// request ends it (`hono::cut`).
    async fn handle(self: Arc<Self>, remote: SocketAddr, request: Request, limits: ConnLimits) -> Result<axum::response::Response, &'static [u8]> {
        // every route that changes anything is a POST
        let writing = (request.method() == axum::http::Method::POST).then(|| Writing::begin(&self.writing));
        // counted first, then looked at: a request is either seen by the stop or not begun
        if self.stopped.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(b"");
        }
        let response = self.answer(remote, request, limits).await?;
        Ok(match writing {
            Some(writing) => response.map(|body| axum::body::Body::new(Counted { body, _writing: writing })),
            None => response,
        })
    }

    async fn answer(self: Arc<Self>, remote: SocketAddr, request: Request, limits: ConnLimits) -> Result<axum::response::Response, &'static [u8]> {
        let (parts, body) = request.into_parts();
        // Node's parser counts the request target and every header's name and value as they come,
        // and gives the connection up at `--max-http-header-size`, before the server sees the request
        let target_bytes = if parts.uri.scheme().is_none() { parts.uri.path_and_query().map_or(0, |p| p.as_str().len()) } else { parts.uri.to_string().len() };
        let head_bytes = target_bytes + parts.headers.iter().map(|(name, value)| name.as_str().len() + value.len()).sum::<usize>();
        if head_bytes >= limits.max_header_size {
            return Err(hono::cut::HEADER_FIELDS_TOO_LARGE);
        }
        // @hono/node-server: newRequest. The URL is `http://` + Host + the request target.
        let target = parts.uri.path_and_query().map_or("", |p| p.as_str());
        if !target.starts_with('/') {
            // `OPTIONS *`, or no path at all: `new URL` throws, and node-server answers 400 (handleRequestError)
            return Ok(hono::into_response(Res::new(400, hono::ResBody::Null).with("content-type", "text/plain; charset=UTF-8"), parts.method == axum::http::Method::HEAD));
        }
        let host = parts.uri.authority().map(|a| a.as_str().to_string()).or_else(|| parts.headers.get("host").map(|h| js::latin1(h.as_bytes())));
        // a request of HTTP/1.0 may come without a Host header: the address the server listens on stands in (`hostname` of serve)
        let host = host.filter(|h| !h.is_empty()).or_else(|| if parts.version < axum::http::Version::HTTP_11 { self.default_hostname.clone() } else { None });
        let Some(host) = host else {
            // Node answers a request without a Host header itself
            return Ok(hono::into_response(Res::new(400, hono::ResBody::Null).with("connection", "close"), parts.method == axum::http::Method::HEAD));
        };
        let href = url::href(&host, &js::latin1(target.as_bytes()));
        let has_body = !matches!(parts.method.as_str(), "GET" | "HEAD");
        let req = Req {
            method: parts.method.as_str().to_string(),
            path: url::get_path(&href),
            url: href,
            headers: parts.headers,
            remote: Some(remote),
            body: Mutex::new(has_body.then_some(body)),
            deadline: Some(tokio::time::Instant::now() + limits.request_timeout),
        };
        // Node runs a request to its end whether or not the client is still there; so does this:
        // the work is a task of its own, not a part of the connection that would end with it.
        let server = self.clone();
        match tokio::spawn(async move { server.fetch(req).await }).await {
            Ok((Res { body: hono::ResBody::Cut(words), .. }, _)) => Err(words),
            Ok((res, head)) => Ok(hono::into_response(res, head)),
            Err(e) => {
                eprintln!("{e}");
                Ok(hono::into_response(hono::text("Internal Server Error", 500), false))
            }
        }
    }
}

/// Serves the connections of `listener` for ever: each by hyper, HTTP/1.1 only, as Node's `http`
/// serves it, within `limits`.
///
/// A head that has not arrived in time ends the connection with Node's 408. When the client
/// closes the connection, also only its sending side, what is being answered is given up at once
/// (hyper's default; Node does the same, `socketOnEnd`, except that an answer it has ready at that
/// moment still goes out): that is what ends a live stream whose reader has gone, and frees its
/// listener.
pub async fn serve(listener: tokio::net::TcpListener, server: Arc<Server>, limits: ConnLimits) {
    let stopping = server.stopping.notified();
    tokio::pin!(stopping);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            // `server.close()`: the socket is closed, the connections that are open go on
            _ = &mut stopping => return,
        };
        let (stream, remote) = match accepted {
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
            let last_words: LastWords = Arc::new(Mutex::new(None));
            let service = {
                let last_words = last_words.clone();
                hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    let (server, last_words) = (server.clone(), last_words.clone());
                    async move {
                        match server.handle(remote, request.map(axum::body::Body::new), limits).await {
                            Ok(response) => Ok(response),
                            Err(words) => {
                                // hyper drops the connection for the error, and the Wire says the words as it goes
                                *last_words.lock().unwrap_or_else(|e| e.into_inner()) = Some(words);
                                Err(Cut)
                            }
                        }
                    }
                })
            };
            let mut http = hyper::server::conn::http1::Builder::new();
            http.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(limits.headers_timeout).max_headers(MAX_HEADERS).max_header_size(HEAD_BUFFER_BYTES.max(limits.max_header_size));
            let connection = http.serve_connection(Wire { io: hyper_util::rt::TokioIo::new(stream), last_words: last_words.clone() }, service);
            tokio::pin!(connection);
            if let Err(e) = connection.as_mut().await {
                // hyper closes a connection whose head is late without a word; Node says 408 first
                if e.is_timeout() {
                    last_words.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(hono::cut::REQUEST_TIMEOUT);
                }
            }
            // the connection, and with it the Wire, ends here
        });
    }
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(1)
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
    // The research records of the spaces (data/<space>/records.json), each read once into a compact
    // catalogue; a missing file leaves its space out (or, for a space with a domain, without records).
    let spaces_root = test.spaces_root.as_ref().map_or_else(|| root.clone(), PathBuf::from);
    let spaces: Arc<dyn SpacesPort> = Arc::new(LoadedSpaces::load(&spaces_root, out.clone()));

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
        writing: Arc::default(),
        stopping: tokio::sync::Notify::new(),
        stopped: false.into(),
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

    // The six 4-polytopes of the boundary space are built on first use (the 120-cell and the
    // 600-cell take about 0.3 s each): now, beside the server, so that the first submission on one
    // does not wait for it. A submission that comes before this is done waits for the same build.
    let _ = std::thread::Builder::new().name("warm".to_string()).stack_size(crate::pool::THREAD_STACK_BYTES).spawn(|| {
        for name in polypack_boundary::POLYTOPES {
            let _ = polypack_boundary::get_polytope(name);
        }
    });

    // A host stops the process with a signal at every deploy and restart. Open live-update streams
    // would keep it alive until the host kills it, so exit at once; SQLite has committed every
    // write. "At once" is once the answers under way are out (`Server::stop`): within two seconds
    // whatever happens, and within some milliseconds in practice.
    {
        let server = server.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = signal(SignalKind::terminate()).expect("a signal handler");
            let mut int = signal(SignalKind::interrupt()).expect("a signal handler");
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
            server.stop(Duration::from_secs(2)).await;
            std::process::exit(0);
        });
    }

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
                let next = crate::pool::blocking(|| {
                    let store = store.lock().unwrap();
                    migration.tick(&store, &mut |msg: &str| println!("{msg}"))
                })
                .await;
                match next {
                    Some(delay) => wait = delay,
                    None => break,
                }
            }
        });
    }

    serve(listener, server, ConnLimits::default()).await;
    // the server is stopping (the task above ends the process)
    std::future::pending::<()>().await
}
