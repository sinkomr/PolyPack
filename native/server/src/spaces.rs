//! Port of apps/server/src/spaces.ts: the routes of the spaces (docs/spaces/*.md), their
//! catalogues of research records and the site entries submitted for them.
//!
//! How the source's one thread maps to this server's many (see also app.rs):
//!
//!  - What the source keeps in the closure of `registerSpaceRoutes` (the kept listings and their
//!    version, the addresses with a check in flight, the turn of the heavy checks) is `State`,
//!    behind one lock. Where both are held, the order is `state`, then the store.
//!  - A submission is read by the task that answers its request. Everything after the body is
//!    read runs as one job on a worker (`pool`): the parsing, the refusals in the source's order,
//!    the check, the transaction, the log lines. A heavy check is the exception: its job ends
//!    when the entry has its place in the queue, the request's task waits for the turn, and the
//!    check and what follows run on the one thread kept for heavy checks (`heavy`), so that a
//!    long check never holds a worker of the pool. One heavy check runs at a time, as in the
//!    source, where it shares the one thread with everything else in slices of 20 ms.
//!  - One check at a time per address. In the source a second submission of an address is refused
//!    (429) when it is looked at while the first is being checked, which can only be when that
//!    check has let the event loop in: it waits for its turn as a heavy check, or its work has
//!    outlasted a slice. A check that does neither is over before the next request is read. Here:
//!    a submission that finds a heavy check of its address in flight is refused, and one that
//!    finds a check that is not heavy waits the milliseconds until it is over and is then handled
//!    as the next request would have been. It waits as a task, not on a worker: its job ends
//!    there (`Step::Wait`) and another takes it up when the check is over, so that several
//!    entries sent at once from one address, or under the submit key, hold one worker between
//!    them and not one each.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use polypack_flat::provenance::MAX_SOFTWARE_LENGTH;
use polypack_js::fmt;
use polypack_js::json::stringify;
use polypack_spaces::{
    accepts_submissions, beats_space_record, boundary_check_ms, boundary_is_heavy, entry_config, has_record, improves_space_best, nd_check_ops, nd_is_heavy, parse_space_config, parse_space_id,
    parse_space_id_value, problem_of, space_exhibits, space_info, space_problem_summary, space_record_margin, stored_space_config_async, validate_space_submission_async, NdProblemId, Parsed,
    ParsedSpaceId, SiteBest, SpaceCatalogue, SpaceInfo, SpaceName, SpaceProblemEntry, SpaceProblemHead, SpaceProblemSummary, SpaceRecordsResponse, SpaceSiteOnlyResponse, SpaceSubmitResponse,
    SpaceValidateOptions, SpacesResponse,
};
use serde::Serialize;
use serde_json::Value;

use crate::app::{Log, StoreHandle};
use crate::clock::Clock;
use crate::hono::{self, Handled, Req, Res, ResBody, Thrown};
use crate::js;
use crate::limits::{address_key, sanitize_text, SubmitLimits, Submitter, MAX_BODY_BYTES, MAX_NAME_LENGTH, MAX_NOTE_LENGTH, OVERLOAD_RETRY_S, SUBMIT_KEY_HEADER};
use crate::load::{LoadStats, SubmissionLine};
use crate::pool::Pool;
pub use crate::spaces_port::{LoadedSpaces, SpaceExhibitDoc, SpaceInfoDoc, SpaceProblemRef, SpacesDocs, SpacesPort};
use crate::store::{NewSpaceEntry, SpaceEntryEdit, SpaceIds, SpaceLeader};
use crate::units_gate::{space_affected, units_missing_message};
use crate::url;

/// spaces.ts: SPACE_SITE_ONLY_DEFAULT_LIMIT. Problems one /api/spaces/{space}/site-only page holds
/// without a `limit`.
pub const SPACE_SITE_ONLY_DEFAULT_LIMIT: f64 = 1000.0;
/// spaces.ts: SPACE_SITE_ONLY_MAX_LIMIT. And at most.
pub const SPACE_SITE_ONLY_MAX_LIMIT: f64 = 5000.0;
/// spaces.ts: SPACES_CHECKED_ONLY_IF_KEPT. Spaces whose submissions are answered "not kept"
/// without a check when their stated score cannot be kept: a check of 500 large polyhedra takes
/// about 0.7 s in the source, one of 500 torus pieces on a skewed basis about 0.5 s, and posting a
/// research record or the site's best back would otherwise cost one each time. The other spaces'
/// checks are short, and they keep answering "valid, not kept" for such an entry.
pub const SPACES_CHECKED_ONLY_IF_KEPT: [SpaceName; 3] = [SpaceName::Polyhedra, SpaceName::Torus, SpaceName::Ndim];
/// spaces.ts: SPACE_HEAVY_CHECK_P. nD in nD checks are heavy by their size (nd_is_heavy: more than
/// 2e7 multiply-adds). Polyhedra, surface, curved, sphere and torus checks from this P on are
/// heavy: one runs at a time on the server, and at most SPACE_HEAVY_CHECKS_WAITING wait their
/// turn; another is refused with 503.
pub const SPACE_HEAVY_CHECK_P: f64 = 30.0;
/// spaces.ts: SPACE_HEAVY_CHECKS_WAITING. Heavy checks that may wait their turn; another is
/// refused with 503.
pub const SPACE_HEAVY_CHECKS_WAITING: f64 = 8.0;
/// spaces.ts: SPACE_METHOD_LENGTH. Longest `method` text of a space submission.
pub const SPACE_METHOD_LENGTH: f64 = 80.0;

/// spaces.ts: decimalInteger. A query value that is a plain decimal integer; anything else is NaN.
fn decimal_integer(text: Option<&str>) -> f64 {
    match text {
        Some(t) if (1..=9).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit()) => js::number(t),
        _ => f64::NAN,
    }
}

/// spaces.ts: siteBestOf.
fn site_best_of(l: &SpaceLeader) -> SiteBest {
    SiteBest { id: l.id as i64, score: l.score, name: l.name.clone(), created_at: l.created_at.clone() }
}

/// spaces.ts: acceptsGzip. Whether an Accept-Encoding header accepts gzip (explicitly or by "*",
/// with q > 0).
pub fn accepts_gzip(header: Option<&str>) -> bool {
    let Some(header) = header.filter(|h| !h.is_empty()) else {
        return false;
    };
    let mut gzip: Option<f64> = None;
    let mut any: Option<f64> = None;
    for part in header.split(',') {
        let mut tokens = part.split(';').map(js::trim);
        let name = tokens.next().unwrap_or("");
        // params.find((t) => /^q=/i.test(t))
        let q_param = tokens.find(|t| t.len() >= 2 && t.as_bytes()[0].eq_ignore_ascii_case(&b'q') && t.as_bytes()[1] == b'=');
        let q = match q_param {
            None => 1.0,
            Some(t) => js::number(&t[2..]),
        };
        let n = name.to_lowercase();
        if n == "gzip" || n == "x-gzip" {
            gzip = Some(q);
        } else if n == "*" {
            any = Some(q);
        }
    }
    gzip.or(any).unwrap_or(0.0) > 0.0
}

/// spaces.ts: Packed. An answer kept as its JSON bytes, encoded once and shared by every response
/// (a connection that is slow to read holds a reference, not a copy), with its gzip bytes once a
/// client asked for them.
struct Packed {
    bytes: Bytes,
    gzip: tokio::sync::OnceCell<Bytes>,
}

impl Packed {
    /// spaces.ts: packedOf.
    fn of<T: Serialize + ?Sized>(value: &T) -> Arc<Packed> {
        Arc::new(Packed { bytes: Bytes::from(polypack_js::json::to_vec(value)), gzip: tokio::sync::OnceCell::new() })
    }

    /// spaces.ts: gzipOf. The gzip of a kept answer, made once and off the threads that answer
    /// requests. (The source keeps no gzip that could not be made and sends the plain bytes then;
    /// here the compressor cannot fail.)
    async fn gzip(&self) -> Bytes {
        self.gzip
            .get_or_init(|| async {
                let data = self.bytes.clone();
                if data.len() > 16 * 1024 {
                    tokio::task::spawn_blocking(move || Bytes::from(hono::encode("gzip", &data))).await.expect("the compressor does not panic")
                } else {
                    Bytes::from(hono::encode("gzip", &data))
                }
            })
            .await
            .clone()
    }
}

/// spaces.ts: send. A kept answer, gzip-compressed for clients that accept it and plain for the
/// others: shared bytes either way.
async fn send(req: &Req, packed: &Packed) -> Res {
    // jsonHeaders
    let headers = |res: Res| res.with("content-type", "application/json").with("vary", "Accept-Encoding");
    if !accepts_gzip(req.header("accept-encoding").as_deref()) {
        return headers(Res::new(200, ResBody::Full(packed.bytes.clone())));
    }
    headers(Res::new(200, ResBody::Full(packed.gzip().await))).with("content-encoding", "gzip")
}

/// spaces.ts: withRaw. A JSON object's text with raw JSON fields appended (configurations are
/// stored as JSON text).
fn with_raw<T: Serialize + ?Sized>(head: &T, raw: &[(&str, Option<&str>)]) -> String {
    let text = stringify(head);
    let tail: Vec<String> = raw.iter().map(|(k, v)| format!("{}:{}", stringify(k), v.unwrap_or("null"))).collect();
    let tail = tail.join(",");
    if text == "{}" {
        format!("{{{tail}}}")
    } else {
        format!("{},{tail}}}", &text[..text.len() - 1])
    }
}

/// An address with a check in flight.
struct Checking {
    /// The check waits for its turn as a heavy check, or has it.
    heavy: bool,
    /// The submissions of the address that wait for this check to be over; each is told.
    waiting: Vec<tokio::sync::oneshot::Sender<()>>,
}

/// What the source keeps in the closure of `registerSpaceRoutes`.
struct State {
    /// The listing of a space is kept until one of its entries changes, with its gzip bytes, so
    /// that it is compressed once and not per request; by the space's place in SPACE_NAMES.
    records_cache: [Option<Arc<Packed>>; 8],
    /// Keeps an answer computed across a change from being kept.
    version: u64,
    /// The addresses with a check in flight.
    checking: HashMap<String, Checking>,
    /// The heavy checks: one running, the others in turn.
    heavy_running: bool,
    heavy_waiting: VecDeque<tokio::sync::oneshot::Sender<()>>,
}

impl State {
    /// spaces.ts: changed.
    fn changed(&mut self, space: &str) {
        if let Some(name) = SpaceName::parse(space) {
            self.records_cache[name.index()] = None;
        }
        self.version += 1;
    }

    /// spaces.ts: heavyTurn. The turn, when no heavy check runs; otherwise a place in the queue,
    /// and what the turn will be announced on.
    fn heavy_turn(&mut self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        if !self.heavy_running {
            self.heavy_running = true;
            return None;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.heavy_waiting.push_back(tx);
        Some(rx)
    }

    /// spaces.ts: heavyDone. The turn passes to the check that has waited longest. (The source
    /// frees the turn and wakes that check, which takes it in the same turn of the event loop,
    /// before any other request is looked at; here it is handed over.)
    fn heavy_done(&mut self) {
        while let Some(next) = self.heavy_waiting.pop_front() {
            if next.send(()).is_ok() {
                return;
            }
        }
        self.heavy_running = false;
    }
}

/// The routes of the spaces and what they keep between requests: what `registerSpaceRoutes`
/// builds once. Made by `App::new` when it is given `spaces`.
pub struct SpaceRoutes {
    /// `SPACE_NAMES.filter((s) => index[s])`.
    loaded: Vec<SpaceName>,
    /// GET /api/spaces: the same bytes for every request.
    spaces_answer: Arc<Packed>,
    state: Mutex<State>,
    /// One listing of a space is made at a time; a request that arrives meanwhile gets that one.
    listing: [Mutex<()>; 8],
    /// The one thread that runs the heavy checks, beside the workers of the pool.
    heavy: Pool,
}

impl SpaceRoutes {
    /// spaces.ts: registerSpaceRoutes, the part that runs once.
    pub fn new(spaces: &dyn SpacesPort, clock: Clock) -> Arc<SpaceRoutes> {
        let index = spaces.index();
        let loaded = index.loaded();
        let answer = SpacesResponse {
            spaces: loaded
                .iter()
                .map(|s| {
                    let cat = index.get(*s).expect("a loaded space");
                    let info = space_info(*s);
                    SpaceInfo {
                        space: *s,
                        title: info.title.clone(),
                        summary: info.summary.clone(),
                        score: info.score.clone(),
                        problem_id: info.problem_id.clone(),
                        conventions: info.conventions.clone(),
                        viewer: info.viewer.clone(),
                        docs: info.docs.clone(),
                        problems: match cat.domain {
                            Some(domain) => domain.problems(),
                            None => cat.problems.len() as f64,
                        },
                        records: cat.problems.iter().filter(|p| has_record(p)).count(),
                        domain: cat.domain.map(|d| d.info.clone()),
                    }
                })
                .collect(),
            // the curvature sweeps belong with the spaces, so they are shown only when there are any
            exhibits: if loaded.is_empty() { Vec::new() } else { space_exhibits().to_vec() },
        };
        Arc::new(SpaceRoutes {
            loaded,
            spaces_answer: Packed::of(&answer),
            state: Mutex::new(State { records_cache: Default::default(), version: 0, checking: HashMap::new(), heavy_running: false, heavy_waiting: VecDeque::new() }),
            listing: Default::default(),
            heavy: Pool::new(1, clock),
        })
    }

    /// `loaded.join(", ")`.
    fn loaded_list(&self) -> String {
        let names: Vec<&str> = self.loaded.iter().map(|s| s.as_str()).collect();
        names.join(", ")
    }

    /// spaces.ts: unknownSpace.
    fn unknown_space(&self) -> Res {
        let list = self.loaded_list();
        hono::json_error(&format!("no such space; the spaces are {}", if list.is_empty() { "(none loaded)" } else { &list }), 404)
    }
}

/// spaces.ts: SpaceRouteContext. What the spaces routes share with the rest of the API: the limits
/// of /api/submit, the log and the admin check; and what the Rust server adds: the store behind its
/// lock, the workers that verify, and the clock.
pub struct SpaceRouteContext<'a> {
    /// What the routes keep between requests.
    pub routes: &'a Arc<SpaceRoutes>,
    /// `spaces.index`.
    pub spaces: &'a Arc<dyn SpacesPort>,
    /// `spaces.store`: the store, behind its lock. Never hold it while checking a submission.
    pub store: &'a StoreHandle,
    /// Whether submissions to problems of the unit change must carry units (see AppOptions.unitsGate).
    pub units_gate: bool,
    /// The count and verification budget of an address, or of the submit key.
    pub submit_limits: &'a Arc<SubmitLimits>,
    /// True while verifications wait too long for a worker (submissions are then refused with 503).
    pub overloaded: &'a (dyn Fn() -> bool + Send + Sync),
    pub client_ip: &'a (dyn Fn(&Req) -> String + Send + Sync),
    pub log: &'a Log,
    pub stats: Option<&'a Arc<Mutex<LoadStats>>>,
    /// None when the request carries the admin token; otherwise the refusal to send.
    pub admin: &'a (dyn Fn(&Req) -> Option<Res> + Send + Sync),
    /// The workers on which a submission is checked.
    pub pool: &'a Pool,
    pub clock: &'a Clock,
}

/// What `space_routes` did with a request.
pub enum SpaceRoute {
    /// A route of spaces.ts answered.
    Answer(Res),
    /// None did: the routes after them in app.ts answer (/api/leaders, the 404 of the catch-all).
    Pass,
}

/// spaces.ts: registerSpaceRoutes, the routes, as one function: those under /api/spaces and
/// /api/admin/spaces, in the order the source registers them (the first that matches answers).
/// `method` is the method the request is routed by (GET for a HEAD request).
pub async fn space_routes(ctx: &SpaceRouteContext<'_>, method: &str, path: &str, req: &mut Req) -> SpaceRoute {
    let segments: Vec<&str> = path.split('/').collect();
    // `compress()` is given to two of the routes themselves, so it applies to their answers only
    let mut compressed = false;
    let handled: Handled = match (method, &segments[1..]) {
        ("GET", ["api", "spaces"]) => Ok(send(req, &ctx.routes.spaces_answer).await),
        ("GET", ["api", "spaces", "entries", id]) if !id.is_empty() => {
            compressed = true;
            crate::pool::blocking(|| entry(ctx, id)).await
        }
        ("POST", ["api", "spaces", "submit"]) => submit(ctx, req).await,
        ("GET", ["api", "spaces", space, "site-only"]) if !space.is_empty() => crate::pool::blocking(|| site_only(ctx, space, req)).await,
        ("GET", ["api", "spaces", space, "records" | "problems"]) if !space.is_empty() => listing(ctx, space, req).await,
        ("GET", ["api", "spaces", space, "problems", ..]) if !space.is_empty() => {
            compressed = true;
            crate::pool::blocking(|| problem(ctx, space, path)).await
        }
        ("POST", ["api", "admin", "spaces", "remove"]) => admin_remove(ctx, req).await,
        ("POST", ["api", "admin", "spaces", "edit"]) => admin_edit(ctx, req).await,
        _ => return SpaceRoute::Pass,
    };
    let res = handled.unwrap_or_else(hono::on_error);
    SpaceRoute::Answer(if compressed { hono::compress(&req.method, req.header("accept-encoding").as_deref(), res).await } else { res })
}

/// `isSpaceName(space) ? index[space] : undefined`, for the `:space` of a path.
fn catalogue_of<'a>(ctx: &'a SpaceRouteContext<'_>, segment: &str) -> Option<(SpaceName, &'a Arc<SpaceCatalogue>)> {
    // c.req.param("space")
    let space = SpaceName::parse(&js::try_decode_uri_component(segment))?;
    ctx.spaces.index().get(space).map(|cat| (space, cat))
}

/// spaces.ts: SpaceEntryResponse without its configuration, with the space as the database has it.
#[derive(Serialize)]
struct EntryHead<'a> {
    id: f64,
    space: &'a str,
    problem: &'a str,
    score: f64,
    name: &'a str,
    agent_note: &'a str,
    software: &'a Option<String>,
    method: &'a Option<String>,
    seed: Option<f64>,
    created_at: &'a str,
}

/// GET /api/spaces/entries/:id
///
/// Share links: a stored entry with its configuration. 404 also once it was overtaken (only the
/// leader of a problem is kept) or removed.
fn entry(ctx: &SpaceRouteContext<'_>, id: &str) -> Handled {
    let id = decimal_integer(Some(&js::try_decode_uri_component(id)));
    let e = if js::is_integer(id) { ctx.store.lock().unwrap().space_get(id)? } else { None };
    let Some(e) = e else {
        return Ok(hono::json_error("no such space entry", 404));
    };
    let head = EntryHead {
        id: e.id,
        space: &e.space,
        problem: &e.problem,
        score: e.score,
        name: &e.name,
        agent_note: &e.agent_note,
        software: &e.software,
        method: &e.method,
        seed: e.seed,
        created_at: &e.created_at,
    };
    Ok(hono::json_text(with_raw(&head, &[("config", Some(&e.config))]), 200))
}

/// GET /api/spaces/:space/records and /problems
///
/// The listing of a space's research records (a space with a domain answers for its other problems
/// one by one, below); /problems is the same answer.
async fn listing(ctx: &SpaceRouteContext<'_>, space: &str, req: &Req) -> Handled {
    let Some((space, cat)) = catalogue_of(ctx, space) else {
        return Ok(ctx.routes.unknown_space());
    };
    let routes = ctx.routes;
    let cached = routes.state.lock().unwrap().records_cache[space.index()].clone();
    if let Some(cached) = cached {
        return Ok(send(req, &cached).await);
    }
    let packed = crate::pool::blocking(|| -> Result<Arc<Packed>, Thrown> {
        // the source makes a listing in one turn; a request that arrives while one is made gets that one
        let _making = routes.listing[space.index()].lock().unwrap();
        let at = {
            let state = routes.state.lock().unwrap();
            if let Some(cached) = &state.records_cache[space.index()] {
                return Ok(cached.clone());
            }
            state.version
        };
        let site: HashMap<String, SiteBest> = ctx.store.lock().unwrap().space_best(space.as_str())?.iter().map(|l| (l.problem.clone(), site_best_of(l))).collect();
        let packed = Packed::of(&SpaceRecordsResponse { space, generated_at: ctx.clock.iso_now(), problems: cat.problems.iter().map(|p| space_problem_summary(p, site.get(&p.id))).collect() });
        let mut state = routes.state.lock().unwrap();
        if at == state.version {
            state.records_cache[space.index()] = Some(packed.clone());
        }
        Ok(packed)
    })
    .await?;
    Ok(send(req, &packed).await)
}

/// GET /api/spaces/:space/site-only
///
/// The problems of a space's domain that have a site entry and no research record: the listing
/// does not hold them. Each as in the listing, by problem id, a page at a time (`after` is the
/// last id of the page before).
fn site_only(ctx: &SpaceRouteContext<'_>, space: &str, req: &Req) -> Handled {
    let Some((space, cat)) = catalogue_of(ctx, space) else {
        return Ok(ctx.routes.unknown_space());
    };
    let mut errors: Vec<String> = Vec::new();
    for (name, values) in url::query_params(&req.url) {
        if name != "limit" && name != "after" {
            errors.push(format!("unknown parameter {name}: the parameters are limit and after"));
        } else if values.len() > 1 {
            errors.push(format!("{name} is given more than once"));
        }
    }
    let limit = match req.query("limit") {
        None => SPACE_SITE_ONLY_DEFAULT_LIMIT,
        Some(text) => decimal_integer(Some(&text)),
    };
    if !(limit >= 1.0 && limit <= SPACE_SITE_ONLY_MAX_LIMIT) {
        errors.push(format!("limit must be an integer from 1 to {}", fmt::num(SPACE_SITE_ONLY_MAX_LIMIT)));
    }
    if !errors.is_empty() {
        return Ok(hono::json_error(&errors.join("; "), 400));
    }
    let after = req.query("after");
    let mut found: Vec<SpaceProblemSummary> = Vec::new();
    let best = ctx.store.lock().unwrap().space_best(space.as_str())?;
    for l in &best {
        if let Some(after) = &after {
            // !(l.problem > after)
            if js::cmp_utf16(&l.problem, after) != std::cmp::Ordering::Greater {
                continue;
            }
        }
        let p = parse_space_id(space, &l.problem).ok().and_then(|parsed| problem_of(cat, &parsed));
        if let Some(p) = p.filter(|p| !has_record(p)) {
            found.push(space_problem_summary(&p, Some(&site_best_of(l))));
        }
    }
    found.sort_by(|a, b| js::cmp_utf16(&a.id, &b.id));
    let more = found.len() as f64 > limit;
    found.truncate(limit as usize);
    let next = if more { found.last().map(|p| p.id.clone()) } else { None };
    Ok(hono::json(&SpaceSiteOnlyResponse { space, generated_at: ctx.clock.iso_now(), problems: found, next }, 200))
}

/// GET /api/spaces/:space/problems/*
///
/// The id holds slashes, so it is the rest of the path: /api/spaces/curved/problems/curved/-1/3/4/7.
fn problem(ctx: &SpaceRouteContext<'_>, space: &str, path: &str) -> Handled {
    let Some((space, cat)) = catalogue_of(ctx, space) else {
        return Ok(ctx.routes.unknown_space());
    };
    let prefix = format!("/api/spaces/{space}/problems/");
    // c.req.path.slice(prefix.length): the prefix is ASCII, and so are the bytes of the path it covers
    let rest = path.get(prefix.len()..).unwrap_or("");
    let Ok(id) = js::decode_uri_component(rest) else {
        return Ok(hono::json_error("the problem id is not a valid path", 400));
    };
    let parsed = match parse_space_id(space, &id) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(hono::json_error(&message, 400)),
    };
    // a record, or a problem of the space's domain without one (answered with its bound)
    let Some(p) = problem_of(cat, &parsed) else {
        return Ok(hono::json_error(&format!("{} is not in the {space} catalogue", parsed.id), 404));
    };
    let (lead, entry) = {
        let store = ctx.store.lock().unwrap();
        let lead = if accepts_submissions(&p) { store.space_leader(space.as_str(), &p.id)? } else { None };
        let entry = match &lead {
            Some(l) => store.space_get(l.id)?,
            None => None,
        };
        (lead, entry)
    };
    // an entry removed between the two reads leaves the problem without a site entry
    let site = match (&lead, &entry) {
        (Some(l), Some(_)) => Some(site_best_of(l)),
        _ => None,
    };
    let head = SpaceProblemHead { summary: space_problem_summary(&p, site.as_ref()), conventions: space_info(space).conventions.clone() };
    // a space that keeps its configurations apart (polyhedra) reads this one now, from a small cache
    let certified = entry_config(cat, &p);
    Ok(hono::json_text(with_raw(&head, &[("certified_config", certified.as_deref()), ("site_config", entry.as_ref().map(|e| e.config.as_str()))]), 200))
}

/// `await c.req.json().catch(() => null)`: the body as JSON; None when it is not JSON. `Err` when
/// the body did not arrive whole (`hono::read_body`): the request ends there, and nothing is changed.
async fn body_json(req: &mut Req) -> Result<Option<Value>, Res> {
    let bytes = hono::read_body(req).await?;
    Ok(polypack_js::json::parse(&bytes).ok())
}

/// `body.id` when `Number.isInteger(body.id)`.
fn integer_id(body: Option<&Value>) -> Option<f64> {
    match body?.get("id") {
        Some(Value::Number(n)) => n.as_f64().filter(|x| js::is_integer(*x)),
        _ => None,
    }
}

/// POST /api/admin/spaces/remove
///
/// Moderation of space entries, as /api/admin/remove and /api/admin/edit for polygon entries.
async fn admin_remove(ctx: &SpaceRouteContext<'_>, req: &mut Req) -> Handled {
    if let Some(denied) = (ctx.admin)(req) {
        return Ok(denied);
    }
    let body = match body_json(req).await {
        Ok(body) => body,
        Err(cut) => return Ok(cut),
    };
    let Some(id) = integer_id(body.as_ref()) else {
        return Ok(hono::json_error("body must be {\"id\": number}", 400));
    };
    crate::pool::blocking(|| {
        // the change and the forgetting of the kept listing as one step, as in the source's one turn
        let mut state = ctx.routes.state.lock().unwrap();
        let Some(r) = ctx.store.lock().unwrap().space_remove(id)? else {
            return Ok(hono::json_error("no such space entry", 404));
        };
        state.changed(&r.space);
        (ctx.log)(&format!("[spaces] entry {} ({}) removed", fmt::num(id), r.problem));
        Ok(hono::json_text("{\"ok\":true}", 200))
    })
    .await
}

/// POST /api/admin/spaces/edit
async fn admin_edit(ctx: &SpaceRouteContext<'_>, req: &mut Req) -> Handled {
    if let Some(denied) = (ctx.admin)(req) {
        return Ok(denied);
    }
    let body = match body_json(req).await {
        Ok(body) => body,
        Err(cut) => return Ok(cut),
    };
    // !body || typeof body !== "object" || !Number.isInteger(body.id)
    let Some(id) = integer_id(body.as_ref()) else {
        return Ok(hono::json_error("body must be an object with a numeric id", 400));
    };
    let body = body.as_ref().expect("a body with an id");
    let mut errors: Vec<String> = Vec::new();
    let mut changes = SpaceEntryEdit::default();
    let mut changed: Vec<&str> = Vec::new();
    if let Some(v) = body.get("name") {
        let name = v.as_str().map_or(String::new(), |s| sanitize_text(s, MAX_NAME_LENGTH));
        if name.is_empty() {
            errors.push("name must be a non-empty string".to_string());
        } else {
            changes.name = Some(name);
            changed.push("name");
        }
    }
    if let Some(v) = body.get("agent_note") {
        match v.as_str() {
            None => errors.push("agent_note must be a string".to_string()),
            Some(s) => {
                changes.agent_note = Some(sanitize_text(s, MAX_NOTE_LENGTH));
                changed.push("agent_note");
            }
        }
    }
    if !errors.is_empty() {
        return Ok(hono::json_error(&errors.join("; "), 400));
    }
    crate::pool::blocking(|| {
        let mut state = ctx.routes.state.lock().unwrap();
        let Some(r) = ctx.store.lock().unwrap().space_edit(id, &changes)? else {
            return Ok(hono::json_error("no such space entry", 404));
        };
        state.changed(&r.space);
        (ctx.log)(&format!("[spaces] entry {} ({}) edited: {}", fmt::num(id), r.problem, if changed.is_empty() { "nothing".to_string() } else { changed.join(", ") }));
        Ok(hono::json_text("{\"ok\":true}", 200))
    })
    .await
}

/// What a submission needs of the server once its body is read, owned: its work goes to a worker.
struct Env {
    routes: Arc<SpaceRoutes>,
    spaces: Arc<dyn SpacesPort>,
    store: StoreHandle,
    units_gate: bool,
    limits: Arc<SubmitLimits>,
    log: Log,
    stats: Option<Arc<Mutex<LoadStats>>>,
    clock: Clock,
}

/// An address's check in flight: its place among `checking`, and the turn of the heavy checks when
/// it has it. Both are given back when the check is over, however it ends (the source's two
/// `finally`).
struct InFlight {
    routes: Arc<SpaceRoutes>,
    address: String,
    /// The check has the turn of the heavy checks.
    turn: bool,
    over: bool,
}

impl InFlight {
    fn release(&mut self) {
        if self.over {
            return;
        }
        self.over = true;
        let mut state = self.routes.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.turn {
            state.heavy_done();
        }
        // the submissions that waited for this check are looked at again
        if let Some(check) = state.checking.remove(&self.address) {
            for waiting in check.waiting {
                let _ = waiting.send(());
            }
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.release();
    }
}

/// A submission whose configuration is of its problem's form and that has its place: what the
/// check and the storing need.
struct Admitted {
    space: SpaceName,
    cat: Arc<SpaceCatalogue>,
    p: Arc<SpaceProblemEntry>,
    /// `body.config`.
    config: Value,
    name: String,
    agent_note: String,
    software: Option<String>,
    method: Option<String>,
    seed: Option<f64>,
    /// `p.certified?.score ?? null`.
    cert: Option<f64>,
    /// `current?.score`: the site's leader when the submission was looked at.
    current: Option<f64>,
    /// The smaller of the two; None when there is neither.
    best: Option<f64>,
    /// The milliseconds reserved from the budget before the check.
    estimate: f64,
    in_flight: InFlight,
}

/// A submission read as far as its place among the checks: what is left of its body once every
/// refusal that the body alone decides has been passed (`Submission::first`), and what `admit`
/// goes on with.
struct Read {
    submission: Submission,
    space: SpaceName,
    cat: Arc<SpaceCatalogue>,
    p: Arc<SpaceProblemEntry>,
    /// `body.config`.
    config: Value,
    /// `parseSpaceConfig(parsedId, body.config)`.
    shape: Parsed,
    name: String,
    agent_note: String,
    software: Option<String>,
    method: Option<String>,
    seed: Option<f64>,
    /// `p.certified?.score ?? null`.
    cert: Option<f64>,
    heavy: bool,
    estimate: f64,
}

/// What a job of a submission ends with.
enum Step {
    Answer(Res),
    /// A heavy check has its place: it runs when `turn` says so (None: at once).
    Heavy { submission: Box<Submission>, admitted: Box<Admitted>, turn: Option<tokio::sync::oneshot::Receiver<()>> },
    /// A check of the same address that is not heavy is in flight: the submission is looked at
    /// again (`Read::admit`) when `released` says that it is over.
    Wait { read: Box<Read>, released: tokio::sync::oneshot::Receiver<()> },
}

/// One POST /api/spaces/submit, from its first line on.
struct Submission {
    env: Env,
    started: f64,
    submitter: Submitter,
    /// What the log line says about this submission, filled in as the body is read.
    problem: Option<String>,
    verify_ms: Option<f64>,
}

/// The `answer` of POST /api/spaces/submit: the line of the log, and the answer.
#[allow(clippy::too_many_arguments)]
fn answer(stats: Option<&Arc<Mutex<LoadStats>>>, clock: &Clock, started: f64, verify_ms: Option<f64>, problem: Option<&str>, body: &SpaceSubmitResponse, status: u16, retry_after: Option<f64>) -> Res {
    if let Some(stats) = stats {
        stats.lock().unwrap().submission(&SubmissionLine { status, ms: clock.performance_now() - started, verify_ms, problem });
    }
    let res = hono::json(body, status);
    match retry_after {
        Some(s) => res.with("retry-after", fmt::num(s)),
        None => res,
    }
}

/// The body of `reject`.
fn rejection(reasons: Vec<String>) -> SpaceSubmitResponse {
    SpaceSubmitResponse { valid: false, reasons, score: None, leader: false, best_score: None, id: None, beats_certified: false, checked: None }
}

impl Submission {
    fn answer(&self, body: &SpaceSubmitResponse, status: u16, retry_after: Option<f64>) -> Res {
        answer(self.env.stats.as_ref(), &self.env.clock, self.started, self.verify_ms, self.problem.as_deref(), body, status, retry_after)
    }

    fn reject(&self, status: u16, reasons: Vec<String>, retry_after: Option<f64>) -> Res {
        self.answer(&rejection(reasons), status, retry_after)
    }

    /// POST /api/spaces/submit, from the body on, up to the check; and the check and the rest too
    /// when it is not a heavy one and nothing of its address is in the way. On a worker.
    fn first(mut self, body: &[u8]) -> Result<Step, Thrown> {
        let refuse = |s: &Submission, status: u16, reasons: Vec<String>| Ok(Step::Answer(s.reject(status, reasons, None)));
        let Ok(json) = polypack_js::json::parse(body) else {
            return refuse(&self, 400, vec!["body is not valid JSON".to_string()]);
        };
        let Value::Object(mut body) = json else {
            return refuse(&self, 400, vec!["body must be an object {\"space\", \"id\", \"config\", \"name\", ...}".to_string()]);
        };
        let routes = self.env.routes.clone();
        let spaces = self.env.spaces.clone();
        // const cat = typeof space === "string" ? catalogue(space) : undefined
        let named = body.get("space").and_then(Value::as_str).and_then(SpaceName::parse);
        let Some((space, cat)) = named.and_then(|s| spaces.index().get(s).map(|cat| (s, cat.clone()))) else {
            let list = routes.loaded_list();
            return refuse(&self, 400, vec![format!("space must be one of {}", if list.is_empty() { "(no spaces are loaded)" } else { &list })]);
        };
        let parsed_id = match parse_space_id_value(space, body.get("id")) {
            Ok(parsed) => parsed,
            Err(message) => return refuse(&self, 400, vec![message]),
        };
        let Some(p) = problem_of(&cat, &parsed_id) else {
            return refuse(&self, 400, vec![format!("{} is not in the {space} catalogue: submissions are accepted for its problems only", parsed_id.id)]);
        };
        self.problem = Some(p.id.clone());
        // the same confirmation as /api/submit, for the problems the unit change touched (disks, balls, ball and circle containers)
        let ids: &dyn SpaceIds = &*spaces;
        if self.env.units_gate && space_affected(ids, space.as_str(), &p.id) {
            match body.get("units") {
                None => return refuse(&self, 426, vec![units_missing_message()]),
                Some(Value::String(u)) if u == "diameter" => {}
                Some(_) => return refuse(&self, 400, vec!["units must be \"diameter\" (the only unit system of this API)".to_string()]),
            }
        }
        // decided before the packing is looked at
        if !accepts_submissions(&p) {
            return refuse(&self, 409, vec![format!("this problem is closed: {}", p.closed_reason.as_deref().unwrap_or("null"))]);
        }

        let mut errors: Vec<String> = Vec::new();
        let name = body.get("name").and_then(Value::as_str).map_or(String::new(), |s| sanitize_text(s, MAX_NAME_LENGTH));
        if name.is_empty() {
            errors.push("name is required".to_string());
        }
        let mut optional_text = |key: &str, max: usize, truncate: bool| -> Option<String> {
            let v = match body.get(key) {
                None | Some(Value::Null) => return None,
                Some(Value::String(v)) => v,
                Some(_) => {
                    errors.push(format!("{key} must be a string"));
                    return None;
                }
            };
            if !truncate && js::utf16_len(v) > max {
                errors.push(format!("{key} must be at most {max} characters"));
            }
            Some(sanitize_text(v, max)).filter(|s| !s.is_empty())
        };
        let agent_note = optional_text("agent_note", MAX_NOTE_LENGTH, true).unwrap_or_default();
        let software = optional_text("software", MAX_SOFTWARE_LENGTH, false);
        let method = optional_text("method", SPACE_METHOD_LENGTH as usize, false);
        let mut seed: Option<f64> = None;
        match body.get("seed") {
            None | Some(Value::Null) => {}
            // !Number.isSafeInteger(body.seed) || body.seed < 0
            Some(v) => match v.as_f64().filter(|_| v.is_number()).filter(|x| js::is_integer(*x) && x.abs() <= 9007199254740991.0 && !(*x < 0.0)) {
                Some(x) => seed = Some(x),
                None => errors.push("seed must be a non-negative integer".to_string()),
            },
        }
        if !body.contains_key("config") {
            errors.push("config is required".to_string());
        }
        if !errors.is_empty() {
            return refuse(&self, 400, errors);
        }
        let config = body.shift_remove("config").expect("the body has a config");

        let cert = p.certified.as_ref().map(|c| c.score);
        // parseSpaceConfig(parsedId, body.config): the source makes this call for `stated` and again
        // for `shape`; it reads the body only, so it is made once
        let shape = parse_space_config(&parsed_id, Some(&config));
        let heavy = is_heavy(space, &parsed_id);
        let estimate = estimate_ms(space, &parsed_id);
        Read { submission: self, space, cat, p, config, shape, name, agent_note, software, method, seed, cert, heavy, estimate }.admit()
    }

    /// POST /api/spaces/submit, from the check on.
    fn check(mut self, mut a: Admitted) -> Handled {
        let (space, p) = (a.space, a.p.clone());
        let opts = SpaceValidateOptions {
            bound: p.bound.as_ref().map(|b| b.value),
            max_p: Some(a.cat.max_p),
            certified: a.cert,
            // without a research record, every entry must pass the strict check (validate.rs)
            no_record: !has_record(&p),
        };
        let checked = validate_space_submission_async(space, &p.id, &a.config, &opts);
        let (mut verdict, mut work_ms) = (checked.verdict, checked.work_ms);
        // normalised whenever the entry could be kept against the research record, not only when it
        // beats the leader read above: the leader can change while this entry is checked, and then
        // this entry may be stored as the leader with its basis as sent
        if let (true, Some(score), Some(config)) = (verdict.valid, verdict.score, &verdict.config) {
            if a.best.is_none() || improves_space_best(space, score, a.cert, None) {
                let stored = stored_space_config_async(space, &p.id, config, &opts, Some(score));
                verdict.config = Some(stored.config);
                work_ms += stored.work_ms;
            }
        }
        a.in_flight.release();
        self.verify_ms = Some(work_ms);
        self.env.limits.budget_charge(&self.submitter, work_ms - a.estimate);
        let (true, Some(score), Some(config)) = (verdict.valid, verdict.score, &verdict.config) else {
            return Ok(self.reject(if verdict.malformed { 400 } else { 422 }, verdict.reasons, None));
        };
        let beats = a.cert.is_some() && beats_space_record(space, score, a.cert);

        // Kept only when it beats the site leader by more than the tie tolerance and the research
        // record by more than the space's record margin (the tie tolerance too, except for
        // polyhedra, whose records keep a clearance); otherwise it is valid and not kept.
        if a.best.is_some() && !improves_space_best(space, score, a.cert, a.current) {
            let body = SpaceSubmitResponse { valid: true, reasons: Vec::new(), score: Some(score), leader: false, best_score: a.best, id: None, beats_certified: beats, checked: None };
            return Ok(self.answer(&body, 200, None));
        }

        // the transaction, the forgetting of the kept listing and the lines of the log as one step,
        // so that the lines are in the order of the entries
        let env = &self.env;
        let mut state = env.routes.state.lock().unwrap();
        let stored = env.store.lock().unwrap().space_submit(&NewSpaceEntry {
            space: space.as_str().to_string(),
            problem: p.id.clone(),
            score,
            name: a.name.clone(),
            agent_note: a.agent_note,
            software: a.software,
            method: a.method,
            seed: a.seed,
            config: config.to_json(),
            created_at: env.clock.iso_now(),
        })?;
        let (id, leader) = (stored.id, &stored.leader);
        let moved = leader.as_ref().map(|l| l.id) != stored.before.as_ref().map(|l| l.id);
        if stored.kept || moved {
            state.changed(space.as_str());
        }
        if moved {
            if let Some(stats) = &env.stats {
                stats.lock().unwrap().leader_changed();
            }
        }
        let leads = leader.as_ref().is_some_and(|l| l.id == id);
        if let (true, true, Some(cert)) = (beats, leads, a.cert) {
            (env.log)(&format!(
                "[spaces] entry {} by \"{}\" leads {}: score {} is below the certified {} ({}) by {}%",
                fmt::num(id),
                a.name,
                p.id,
                fmt::num(score),
                fmt::num(cert),
                p.status.as_str(),
                fmt::precision(((cert - score) / cert) * 100.0, 3)
            ));
        }
        let values: Vec<f64> = [a.cert, leader.as_ref().map(|l| l.score)].into_iter().flatten().collect();
        let body = SpaceSubmitResponse {
            valid: true,
            reasons: Vec::new(),
            score: Some(score),
            leader: leads,
            best_score: if values.is_empty() { None } else { Some(polypack_js::math::min_of(&values)) },
            id: if stored.kept { Some(id as i64) } else { None },
            beats_certified: beats,
            checked: None,
        };
        let res = self.answer(&body, 200, None);
        drop(state);
        Ok(res)
    }
}

impl Read {
    /// POST /api/spaces/submit, from the reading of the site's leader on: the submission is
    /// refused, or has its place among the checks (and is checked, when the check is not a heavy
    /// one), or waits for another of its address. On a worker; again after each wait.
    fn admit(self) -> Result<Step, Thrown> {
        let Read { submission, space, cat, p, config, shape, name, agent_note, software, method, seed, cert, heavy, estimate } = self;
        let refuse = |s: &Submission, status: u16, reasons: Vec<String>| Ok(Step::Answer(s.reject(status, reasons, None)));
        let routes = submission.env.routes.clone();
        let address = submission.submitter.key.clone();
        let current = submission.env.store.lock().unwrap().space_leader(space.as_str(), &p.id)?.map(|l| l.score);
        let best_before: Vec<f64> = [cert, current].into_iter().flatten().collect();
        let best = if best_before.is_empty() { None } else { Some(polypack_js::math::min_of(&best_before)) };
        if SPACES_CHECKED_ONLY_IF_KEPT.contains(&space) {
            // the stated score is known before any geometry: one that cannot be kept is not checked
            if let Parsed::Ok { score: stated, .. } = &shape {
                if !improves_space_best(space, *stated, cert, current) {
                    let body = SpaceSubmitResponse {
                        valid: false,
                        reasons: vec![format!(
                            "not checked: a size of {} cannot be kept, since it is not below the research record by more than a relative {} and below the site's best by more than a relative 1e-9",
                            fmt::num(*stated),
                            fmt::exponential(space_record_margin(space), None)
                        )],
                        score: Some(*stated),
                        leader: false,
                        best_score: best,
                        id: None,
                        beats_certified: false,
                        checked: Some(false),
                    };
                    return Ok(Step::Answer(submission.answer(&body, 200, None)));
                }
            }
        }

        // The time the check takes is charged to the address, as for /api/submit. A configuration
        // that beats the research record must also be valid at the strict tolerance. An address
        // has one check at a time, an estimate of its cost is reserved from the budget before it
        // starts, and the heavy checks run one at a time server-wide, a few waiting their turn.
        let mut state = routes.state.lock().unwrap();
        if let Some(in_flight) = state.checking.get_mut(&address) {
            if in_flight.heavy {
                drop(state);
                let reasons = vec![format!("an entry {} is still being checked; send the next one when it is answered", submission.submitter.from)];
                return Ok(Step::Answer(submission.reject(429, reasons, Some(1.0))));
            }
            // A check that is over in one go: this submission is looked at again when it is (see
            // the top of the file). The wait is the request's task's, not this worker's: several
            // entries of one address would otherwise each hold a worker while they wait.
            let (tx, released) = tokio::sync::oneshot::channel();
            in_flight.waiting.push(tx);
            drop(state);
            let read = Read { submission, space, cat, p, config, shape, name, agent_note, software, method, seed, cert, heavy, estimate };
            return Ok(Step::Wait { read: Box::new(read), released });
        }
        // A body that is not a configuration of this problem (types, ids, sizes, finite numbers,
        // piece count) is refused here, before it takes a place in the heavy queue or any of the budget.
        if let Parsed::Failed { malformed, errors } = &shape {
            drop(state);
            return refuse(&submission, if *malformed { 400 } else { 422 }, errors.iter().take(20).cloned().collect());
        }
        if heavy && state.heavy_running && state.heavy_waiting.len() as f64 >= SPACE_HEAVY_CHECKS_WAITING {
            drop(state);
            return Ok(Step::Answer(submission.reject(503, vec!["the server is busy checking other entries; try again in a few seconds".to_string()], Some(OVERLOAD_RETRY_S))));
        }
        state.checking.insert(address.clone(), Checking { heavy, waiting: Vec::new() });
        let turn = if heavy { state.heavy_turn() } else { None };
        drop(state);
        let in_flight = InFlight { routes: routes.clone(), address, turn: heavy && turn.is_none(), over: false };
        submission.env.limits.budget_charge(&submission.submitter, estimate);
        let admitted = Admitted { space, cat, p, config, name, agent_note, software, method, seed, cert, current, best, estimate, in_flight };
        if heavy {
            return Ok(Step::Heavy { submission: Box::new(submission), admitted: Box::new(admitted), turn });
        }
        submission.check(admitted).map(Step::Answer)
    }
}

/// The nD problem of a parsed id (spaces.ts: ndProblem).
fn nd_problem(id: &ParsedSpaceId) -> NdProblemId {
    NdProblemId { d: id.fields.number("d") as u32, piece: id.fields.text("piece").to_string(), container: id.fields.text("container").to_string(), p: id.p }
}

/// Whether the check of a problem is a heavy one (spaces.ts: `heavy`).
fn is_heavy(space: SpaceName, id: &ParsedSpaceId) -> bool {
    let p = id.p as f64;
    (matches!(space, SpaceName::Polyhedra | SpaceName::Surface | SpaceName::Curved | SpaceName::Sphere | SpaceName::Torus) && p >= SPACE_HEAVY_CHECK_P)
        || (space == SpaceName::Sphere && id.fields.get("N").map_or(f64::NAN, |n| n.js_number()) >= 20.0)
        // nD in nD: by the size of the check (vertices of the pieces times facets of the container, pairs), not by P alone
        || (space == SpaceName::Ndim && nd_is_heavy(&nd_problem(id)))
        // 3D on 4D: balls on the 120-cell (600 vertices, 120 cells) from P = 5 and on the 24-cell from P = 22, and the Platonic solids from P = 10 to 17 by container (boundaryIsHeavy)
        || (space == SpaceName::Boundary && boundary_is_heavy(id.fields.text("polytope"), id.fields.text("piece"), p))
}

/// The milliseconds reserved from the budget before a check (spaces.ts: `estimate`); a many-sided
/// sphere also queues at small P.
fn estimate_ms(space: SpaceName, id: &ParsedSpaceId) -> f64 {
    use polypack_js::math::{max, min};
    let p = id.p as f64;
    // Math.max(8, Number(parsedId.fields.N) || 0)
    let n = id.fields.get("N").map_or(f64::NAN, |n| n.js_number());
    let sides = max(8.0, if n.is_nan() { 0.0 } else { n });
    match space {
        // [CALC] Reserve up to 1.6 s for two polyhedra passes at P = 500 (about 0.7 s each in the source).
        SpaceName::Polyhedra => min(1600.0, 0.04 * p * p),
        SpaceName::Surface => min(100.0, 5.0 + 1e-5 * p * p * sides),
        // [CALC] A torus entry of 500 disks on a basis at the limit of TORUS_MAX_TRANSLATES candidates
        // per pair, the worst case, took 0.5 s of work in the source (the check, its strict pass and
        // the reduced basis' check; the sent configuration is not checked again), and 0.06 s on a
        // reduced basis. Reserve 0.002 P^2 ms: 0.5 s at P = 500 (at least the earlier many-sided estimate).
        SpaceName::Torus => min(800.0, max(5.0 + 0.002 * p * p, 5.0 + 1e-5 * p * p * sides * sides)),
        SpaceName::Curved | SpaceName::Sphere => min(400.0, 5.0 + 1e-5 * p * p * sides * sides),
        // [CALC] the check's estimated milliseconds (bounds.ts BOUNDARY_BALL_MS), at least the default 5
        SpaceName::Boundary => max(5.0, boundary_check_ms(id.fields.text("polytope"), id.fields.text("piece"), p)),
        // [CALC] about 3 ns per multiply-add of a check without the validator's facet skipping, the
        // worst case (docs/spaces/NDIM.md section 10); the charge is corrected by the work measured
        SpaceName::Ndim => min(8000.0, 5.0 + 3e-6 * nd_check_ops(&nd_problem(id))),
        SpaceName::Balls => 5.0,
    }
}

/// POST /api/spaces/submit, up to the body.
async fn submit(ctx: &SpaceRouteContext<'_>, req: &mut Req) -> Handled {
    let started = ctx.clock.performance_now();
    let refuse = |status: u16, reason: String, retry_after: Option<f64>| Ok(answer(ctx.stats, ctx.clock, started, None, None, &rejection(vec![reason]), status, retry_after));
    // the same limits, counted together, as /api/submit
    if (ctx.overloaded)() {
        return refuse(503, "the server is busy; try again in a few seconds".to_string(), Some(OVERLOAD_RETRY_S));
    }
    let address = address_key(&(ctx.client_ip)(req));
    let Some(submitter) = ctx.submit_limits.of(&address, req.header(SUBMIT_KEY_HEADER).as_deref()) else {
        return refuse(401, "the submit key is not this server's".to_string(), None);
    };
    // `submitter.key` is what the count, the budget and the one check at a time are kept under:
    // the address, or the submit key
    if !ctx.submit_limits.count_allow(&submitter) {
        return refuse(429, format!("too many submissions {}; wait a minute", submitter.from), None);
    }
    let wait = ctx.submit_limits.budget_wait(&submitter);
    if wait > 0.0 {
        return refuse(429, format!("too much verification work {}; wait {} s", submitter.from, fmt::num(wait)), Some(wait));
    }
    // read no further than the limit, also for a chunked body without a Content-Length
    let body = match hono::read_body_within(req, MAX_BODY_BYTES).await {
        Ok(Some(body)) => body,
        Ok(None) => return refuse(413, "request body too large".to_string(), None),
        // the body did not arrive whole: nothing is checked or stored (see app.rs: submit)
        Err(cut) => {
            eprintln!("Error: aborted");
            return Ok(cut);
        }
    };
    let submission = Submission {
        env: Env {
            routes: ctx.routes.clone(),
            spaces: ctx.spaces.clone(),
            store: ctx.store.clone(),
            units_gate: ctx.units_gate,
            limits: ctx.submit_limits.clone(),
            log: ctx.log.clone(),
            stats: ctx.stats.cloned(),
            clock: ctx.clock.clone(),
        },
        started,
        submitter,
        problem: None,
        verify_ms: None,
    };
    // the rest is the work of a core: on a worker
    let mut step = ctx.pool.run(move || submission.first(&body)).await;
    loop {
        match step {
            Err(message) => return Err(Thrown::new(message)),
            Ok(Err(thrown)) => return Err(thrown),
            Ok(Ok(Step::Answer(res))) => return Ok(res),
            Ok(Ok(Step::Wait { read, released })) => {
                // the check in the way is over (or gone): on a worker again, as the next request would be
                let _ = released.await;
                step = ctx.pool.run(move || read.admit()).await;
            }
            Ok(Ok(Step::Heavy { submission, mut admitted, turn })) => {
                // if (heavy) await heavyTurn()
                if let Some(turn) = turn {
                    let _ = turn.await;
                    admitted.in_flight.turn = true;
                }
                let heavy = ctx.routes.heavy.clone();
                return match heavy.run(move || submission.check(*admitted)).await {
                    Ok(handled) => handled,
                    Err(message) => Err(Thrown::new(message)),
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accept_encoding() {
        for h in ["gzip", "gzip, deflate, br", "GZIP", "x-gzip", "*", "deflate, *;q=0.1", "gzip;q=0.5", " gzip ; Q=1", "identity, gzip;q=0.001", "gzip;q=0, gzip", "br;q=1, *"] {
            assert!(accepts_gzip(Some(h)), "{h}");
        }
        for h in ["", "deflate", "br", "gzip;q=0", "gzip;q=0, *", "*;q=0", "gzip;q=", "gzip;q=x", "gzip, gzip;q=0", "gzipped", "gzip;q=-1"] {
            assert!(!accepts_gzip(Some(h)), "{h}");
        }
        assert!(!accepts_gzip(None));
    }

    #[test]
    fn raw_fields() {
        assert_eq!(with_raw(&json!({ "a": 1 }), &[("config", Some("{\"s\":2}")), ("other", None)]), "{\"a\":1,\"config\":{\"s\":2},\"other\":null}");
        assert_eq!(with_raw(&json!({}), &[("config", Some("[1]"))]), "{\"config\":[1]}");
    }

    /// The routes on a store in memory, with the sphere's domain as the one catalogue.
    struct Rig {
        routes: Arc<SpaceRoutes>,
        spaces: Arc<dyn SpacesPort>,
        store: StoreHandle,
        limits: Arc<SubmitLimits>,
        log: Log,
        lines: Arc<Mutex<Vec<String>>>,
        stats: Arc<Mutex<LoadStats>>,
        pool: Pool,
        clock: Clock,
    }

    impl Rig {
        fn new() -> Rig {
            let clock = Clock::new();
            let mut index = polypack_spaces::SpacesIndex::default();
            index.set(polypack_spaces::build_space_catalogue(SpaceName::Sphere, None, polypack_spaces::space_domain(SpaceName::Sphere)));
            let spaces: Arc<dyn SpacesPort> = Arc::new(LoadedSpaces::new(index));
            let ids: &dyn SpaceIds = &*spaces;
            let store = crate::store::SqliteStore::open(":memory:", crate::store::OpenOptions { migrate_units: true, log: None, spaces: ids, clock: Box::new(clock.clone()), tracer: None }).expect("a store in memory");
            let lines = Arc::new(Mutex::new(Vec::new()));
            let sink = lines.clone();
            let log: Log = Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_string()));
            let stats = {
                let log = log.clone();
                Arc::new(Mutex::new(LoadStats::new(Box::new(move |line| log(line)))))
            };
            let values = crate::limits::SubmitLimitValues { per_ip: 1e9, window_ms: 60_000.0, verify_ms_per_minute: 1e12, per_key: 1e9, key_verify_ms_per_minute: 1e12 };
            Rig {
                routes: SpaceRoutes::new(&*spaces, clock.clone()),
                spaces,
                store: Arc::new(Mutex::new(store)),
                limits: Arc::new(SubmitLimits::new(None, values, clock.clone())),
                log,
                lines,
                stats,
                pool: Pool::new(2, clock.clone()),
                clock,
            }
        }

        /// POST /api/spaces/submit from `ip`: the status, the Retry-After header and the body.
        async fn submit(&self, ip: &str, body: Value) -> (u16, Option<String>, Value) {
            let href = url::href("test", "/api/spaces/submit");
            let mut headers = axum::http::HeaderMap::new();
            headers.insert("x-ip", axum::http::HeaderValue::from_str(ip).unwrap());
            let mut req = Req { method: "POST".to_string(), path: url::get_path(&href), url: href, headers, remote: None, body: Mutex::new(Some(axum::body::Body::from(body.to_string()))), deadline: None };
            let ctx = SpaceRouteContext {
                routes: &self.routes,
                spaces: &self.spaces,
                store: &self.store,
                units_gate: true,
                submit_limits: &self.limits,
                overloaded: &|| false,
                client_ip: &|req: &Req| req.header("x-ip").unwrap_or_default(),
                log: &self.log,
                stats: Some(&self.stats),
                admin: &|_: &Req| None,
                pool: &self.pool,
                clock: &self.clock,
            };
            let SpaceRoute::Answer(res) = space_routes(&ctx, "POST", "/api/spaces/submit", &mut req).await else {
                panic!("the route did not answer");
            };
            let retry = res.header("retry-after").map(str::to_string);
            let ResBody::Full(bytes) = res.body else {
                panic!("an answer with a body");
            };
            (res.status, retry, serde_json::from_slice(&bytes).expect("JSON"))
        }

        fn waiting(&self) -> usize {
            self.routes.state.lock().unwrap().heavy_waiting.len()
        }
    }

    /// P regular 100-gons on the sphere, all in one place: of the problem's form, and overlapping.
    /// A sphere problem of 20 sides or more is a heavy check at any P.
    fn many_sided(p: usize) -> Value {
        json!({ "space": "sphere", "id": format!("sphere/100/{p}"), "name": "overlap", "config": { "rho": 100, "pieces": vec![json!({ "q": [1, 0, 0, 0] }); p] } })
    }

    /// Two triangles in one place: a check that is not heavy.
    fn light() -> Value {
        json!({ "space": "sphere", "id": "sphere/3/2", "name": "overlap", "config": { "rho": 100, "pieces": [{ "q": [1, 0, 0, 0] }, { "q": [1, 0, 0, 0] }] } })
    }

    // apps/server/test/spaces.test.ts: "checks one entry at a time per address, and the heavy checks
    // one at a time", "refuses a malformed heavy body before the heavy queue and the address's one
    // check", "shares the heavy queue across all three spaces, including many-sided sphere pairs at
    // small P". There the queue fills because a check of 500 polyhedra outlasts the requests behind
    // it; here the turn is held by the test, so that nothing depends on how long a check takes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_heavy_checks_wait_their_turn_and_the_ninth_is_refused() {
        let rig = Arc::new(Rig::new());
        // without anything in the way, a heavy check is answered: the packing overlaps
        let (status, _, body) = rig.submit("10.0.1.1", many_sided(2)).await;
        assert_eq!(status, 422, "{body}");
        // a heavy check is running (the test stands in for it)
        assert!(rig.routes.state.lock().unwrap().heavy_turn().is_none());
        // eight more take their places, one after the other
        let mut queued = Vec::new();
        for k in 0..SPACE_HEAVY_CHECKS_WAITING as usize {
            let r = rig.clone();
            queued.push(tokio::spawn(async move { r.submit(&format!("10.0.0.{k}"), many_sided(2 + k)).await }));
            for _ in 0..2000 {
                if rig.waiting() == k + 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
            assert_eq!(rig.waiting(), k + 1);
        }
        // the ninth is refused, whatever its address
        let (status, retry, body) = rig.submit("10.0.0.8", many_sided(2)).await;
        assert_eq!((status, retry.as_deref()), (503, Some("5")));
        assert_eq!(body, json!({ "valid": false, "reasons": ["the server is busy checking other entries; try again in a few seconds"], "score": null, "leader": false, "best_score": null, "id": null, "beats_certified": false }));
        // an address whose entry waits is told so, for a heavy entry and for one that is not
        for entry in [many_sided(3), light()] {
            let (status, retry, body) = rig.submit("10.0.0.3", entry).await;
            assert_eq!((status, retry.as_deref()), (429, Some("1")));
            assert_eq!(body["reasons"], json!(["an entry from this address is still being checked; send the next one when it is answered"]));
        }
        // a body that is not a configuration of the problem is refused before the queue and before
        // the address's one check: 400 or 422, never 503
        let mut wrong_type = many_sided(2);
        wrong_type["config"]["rho"] = json!("big");
        let mut wrong_count = many_sided(2);
        wrong_count["config"]["pieces"] = json!([{ "q": [1, 0, 0, 0] }]);
        let mut no_config = many_sided(2);
        no_config["config"] = json!("nope");
        for (entry, expected) in [(wrong_type, 400), (wrong_count, 422), (no_config, 400)] {
            let (status, retry, body) = rig.submit("10.0.0.9", entry).await;
            assert_eq!((status, retry), (expected, None), "{body}");
        }
        // but from an address whose entry waits, the wait is said first
        let mut wrong = many_sided(2);
        wrong["config"]["rho"] = json!("big");
        assert_eq!(rig.submit("10.0.0.3", wrong).await.0, 429);
        // a check that is not heavy does not wait
        let (status, _, body) = rig.submit("10.0.0.9", light()).await;
        assert_eq!(status, 422, "{body}");
        assert_eq!(rig.waiting(), 8);
        // the turn is given up: the eight are checked in the order they came
        let before = rig.lines.lock().unwrap().len();
        rig.routes.state.lock().unwrap().heavy_done();
        for task in queued {
            let (status, _, body) = task.await.unwrap();
            assert_eq!(status, 422, "{body}");
        }
        let lines: Vec<String> = rig.lines.lock().unwrap()[before..].iter().map(|l| l.split(' ').take(3).collect::<Vec<_>>().join(" ")).collect();
        let expected: Vec<String> = (0..8).map(|k| format!("[submit] 422 sphere/100/{}", 2 + k)).collect();
        assert_eq!(lines, expected);
        let state = rig.routes.state.lock().unwrap();
        assert!(!state.heavy_running && state.heavy_waiting.is_empty() && state.checking.is_empty());
    }

    // A submission that finds a check of its address in flight that is not heavy waits for it.
    // It once waited on its worker of the pool: as many entries of one address (or under the
    // submit key) as there are workers, sent at once, and no worker was left for anyone else.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_submission_that_waits_for_another_of_its_address_holds_no_worker() {
        let rig = Arc::new(Rig::new());
        assert_eq!(rig.pool.threads(), 2);
        // a check of 10.0.0.1 that is not heavy is in flight (the test stands in for it)
        rig.routes.state.lock().unwrap().checking.insert("10.0.0.1".to_string(), Checking { heavy: false, waiting: Vec::new() });
        let in_flight = InFlight { routes: rig.routes.clone(), address: "10.0.0.1".to_string(), turn: false, over: false };
        // six more entries of the address arrive: three times the workers
        let mut waiting = Vec::new();
        for _ in 0..6 {
            let r = rig.clone();
            waiting.push(tokio::spawn(async move { r.submit("10.0.0.1", light()).await }));
        }
        for _ in 0..2000 {
            if rig.routes.state.lock().unwrap().checking["10.0.0.1"].waiting.len() == 6 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        assert_eq!(rig.routes.state.lock().unwrap().checking["10.0.0.1"].waiting.len(), 6);
        assert!(waiting.iter().all(|task| !task.is_finished()));
        // the workers are free meanwhile: entries of other addresses are checked and answered
        for k in 0..4 {
            let answered = tokio::time::timeout(std::time::Duration::from_secs(10), rig.submit(&format!("10.0.1.{k}"), light())).await;
            let (status, _, body) = answered.expect("an answer while the six wait");
            assert_eq!(status, 422, "{body}");
        }
        let before = rig.lines.lock().unwrap().len();
        // the check is over: the six are looked at, one after the other, each as the next request would be
        drop(in_flight);
        for task in waiting {
            let (status, retry, body) = tokio::time::timeout(std::time::Duration::from_secs(10), task).await.expect("an answer once the check is over").unwrap();
            assert_eq!((status, retry), (422, None), "{body}");
        }
        assert_eq!(rig.lines.lock().unwrap().len() - before, 6);
        let state = rig.routes.state.lock().unwrap();
        assert!(state.checking.is_empty() && !state.heavy_running);
    }

    // spaces.ts: `heavy`, and the estimate reserved from the budget.
    #[test]
    fn which_checks_are_heavy() {
        let id = |space: SpaceName, text: &str| parse_space_id(space, text).unwrap_or_else(|e| panic!("{text}: {e}"));
        let heavy = |space: SpaceName, text: &str| is_heavy(space, &id(space, text));
        assert!(heavy(SpaceName::Polyhedra, "polyhedra/tidintid/30") && !heavy(SpaceName::Polyhedra, "polyhedra/tidintid/29"));
        assert!(heavy(SpaceName::Surface, "surface/cube/fold/4/30") && !heavy(SpaceName::Surface, "surface/cube/fold/100/29"));
        assert!(heavy(SpaceName::Curved, "curved/-1/3/0/30") && !heavy(SpaceName::Curved, "curved/-1/3/0/29"));
        assert!(heavy(SpaceName::Torus, "torus/sq/0/30") && !heavy(SpaceName::Torus, "torus/sq/100/29"));
        assert!(heavy(SpaceName::Sphere, "sphere/3/30") && !heavy(SpaceName::Sphere, "sphere/19/29"));
        // a many-sided sphere also queues at small P
        assert!(heavy(SpaceName::Sphere, "sphere/20/2"));
        // balls never; 3D on 4D and nD in nD by the size of the check
        assert!(!heavy(SpaceName::Balls, "balls/ap12inball/100"));
        assert!(heavy(SpaceName::Boundary, "boundary/120cell/ball/5") && !heavy(SpaceName::Boundary, "boundary/120cell/ball/4"));
        assert!(heavy(SpaceName::Boundary, "boundary/24cell/ball/22") && !heavy(SpaceName::Boundary, "boundary/24cell/ball/21"));
        assert!(!heavy(SpaceName::Ndim, "ndim/10/ball/ball/2"));
        let estimate = |space: SpaceName, text: &str| estimate_ms(space, &id(space, text));
        assert_eq!(estimate(SpaceName::Polyhedra, "polyhedra/tidintid/500"), 1600.0);
        assert_eq!(estimate(SpaceName::Polyhedra, "polyhedra/tidintid/100"), 400.0);
        assert_eq!(estimate(SpaceName::Surface, "surface/cube/fold/4/10"), 5.0 + 1e-5 * 100.0 * 8.0);
        assert_eq!(estimate(SpaceName::Surface, "surface/cube/fold/100/100"), 5.0 + 1e-5 * 10000.0 * 100.0);
        assert_eq!(estimate(SpaceName::Torus, "torus/sq/0/500"), 5.0 + 0.002 * 250000.0);
        assert_eq!(estimate(SpaceName::Sphere, "sphere/100/100"), 400.0);
        assert_eq!(estimate(SpaceName::Balls, "balls/ap12inball/100"), 5.0);
        assert_eq!(estimate(SpaceName::Ndim, "ndim/10/ball/ball/2"), 5.0 + 3e-6 * nd_check_ops(&nd_problem(&id(SpaceName::Ndim, "ndim/10/ball/ball/2"))));
    }

    // spaces.test.ts: "reads Accept-Encoding as clients write it"
    #[test]
    fn accept_encoding_as_clients_write_it() {
        for h in ["gzip", "GZIP", "deflate, gzip;q=0.5", "*", "br;q=1, *;q=0.1", "x-gzip"] {
            assert!(accepts_gzip(Some(h)), "{h}");
        }
        for h in [None, Some(""), Some("identity"), Some("deflate"), Some("gzip;q=0"), Some("*;q=0"), Some("br, gzip;q=0")] {
            assert!(!accepts_gzip(h), "{h:?}");
        }
    }

    #[test]
    fn decimal_integers() {
        assert_eq!(decimal_integer(Some("0012")), 12.0);
        assert_eq!(decimal_integer(Some("123456789")), 123456789.0);
        for t in ["", "1234567890", "1e2", "0x10", "1.5", "-1", " 1", "+1"] {
            assert!(decimal_integer(Some(t)).is_nan(), "{t}");
        }
        assert!(decimal_integer(None).is_nan());
    }
}
