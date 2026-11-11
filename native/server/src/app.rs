//! Port of apps/server/src/app.ts: the HTTP API. Host-neutral: everything it needs comes in
//! through the options.
//!
//! How the source's one thread maps to this server's many:
//!
//!  - The store sits behind a lock (`store`). Whatever the source keeps in the closure of
//!    `createApp` (the kept answers of /api/records, the pairs, the holders' counts and peaks, the
//!    answers of /api/holder) sits behind a second lock (`state`). A handler that the source runs
//!    in one go, or "in a turn" (`inTurn`), holds `state` for that stretch and takes `store` inside
//!    it, so that it sees and leaves the same state as on one thread. Where the source lets the
//!    event loop in (between the pages of the holders' count, of a holder's answer), the lock is
//!    released. The order of the two locks is always `state`, then `store`.
//!  - A submission is read by the task that answers its request; everything after the body is
//!    read (parsing, the checks, the verification, the transaction, the events) runs as one job on
//!    a worker thread (`pool`), without a lock while it verifies. The transaction decides who leads,
//!    as in the source, so two entries racing for one problem end as in some order of arrival.
//!  - The limits of submissions have their own lock inside `SubmitLimits`; the live streams have
//!    theirs (`follow`).

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use indexmap::{IndexMap, IndexSet};
use polypack_flat::config::{evaluate, parse_config, strict_verify, EvaluateOptions, STRICT_EPS, TOL};
use polypack_flat::protocol::{beats_literature, closed_to_submissions, reaches_literature, LiteratureRecord, MAX_EVENT_KEYS};
use polypack_flat::provenance::{json_stringify, parse_provenance, MAX_SOFTWARE_LENGTH};
use polypack_flat::shapes::{area_lower_bound, is_shape_code_number, MAX_PIECES, MAX_SIDES};
use polypack_js::fmt;
use polypack_js::json::{stringify, to_vec};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::clock::Clock;
use crate::docs::{docs_page, method_names, DocsLimits};
use crate::hono::{self, Handled, Req, Res, ResBody, Thrown};
use crate::js;
use crate::leaders::leaders_route;
use crate::limits::{
    address_key, constant_time_equal, sanitize_text, RateLimiter, SubmitLimitValues, SubmitLimits, Submitter, KEYED_SUBMISSIONS_PER_MINUTE, KEYED_VERIFY_MS_PER_MINUTE, MAX_BODY_BYTES,
    MAX_NAME_LENGTH, MAX_NOTE_LENGTH, MAX_REPORTED_OVERLAPS, OVERLOAD_DELAY_MS, OVERLOAD_RETRY_S, SNAPSHOT_FILES_PER_HOUR, SUBMISSIONS_PER_MINUTE, SUBMIT_KEY_HEADER, VERIFY_MS_PER_MINUTE,
};
use crate::load::{LoadStats, SubmissionLine};
use crate::pool::Pool;
use crate::snapshot::SnapshotSource;
use crate::spaces::{space_routes, SpaceRoute, SpaceRouteContext, SpaceRoutes, SpacesDocs, SpacesPort};
use crate::store::{
    BestOfP, Decision, EntryEdit, HolderPeak, LeaderboardEntry, NewSubmission, Pose, ProblemKey, ProblemLeader, Provenance, SqliteStore, StoredSubmission, GET_MANY_LIMIT,
};
use crate::units_gate::{is_old_volunteer, old_client_may_read, planar_affected, units_missing_message, upgrade_message, CONVENTIONS_VERSION};

/// Where a line of the log goes (`console.log` in production).
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;
pub type StoreHandle = Arc<Mutex<SqliteStore>>;

/// app.ts: AppOptions.limits.
#[derive(Clone, Copy, Debug, Default)]
pub struct LimitOptions {
    pub per_ip: Option<f64>,
    pub window_ms: Option<f64>,
    pub verify_ms_per_minute: Option<f64>,
    pub per_key: Option<f64>,
    pub key_verify_ms_per_minute: Option<f64>,
    pub overload_delay_ms: Option<f64>,
    pub snapshot_files_per_hour: Option<f64>,
}

/// app.ts: AppOptions.
pub struct AppOptions {
    pub store: StoreHandle,
    /// The published records, as data/records.json lists them.
    pub records: Arc<Literature>,
    /// Admin routes are disabled when this is None or empty.
    pub admin_token: Option<String>,
    /// A submission that carries this key in the X-Submit-Key header counts against the key's
    /// limits (`per_key`, `key_verify_ms_per_minute`) instead of its address's; one that carries
    /// another key, or any key while this is None, is refused (401).
    pub submit_key: Option<String>,
    /// Address used for rate limiting; IPv6 addresses are limited by their /64 (see address_key).
    pub client_ip: Option<Box<dyn Fn(&Req) -> String + Send + Sync>>,
    /// Called for submissions that beat the literature.
    pub log: Option<Log>,
    /// `per_ip` submissions per `window_ms` from one address, and `verify_ms_per_minute`
    /// milliseconds of verification a minute; `per_key` and `key_verify_ms_per_minute` the same
    /// with the submit key; `overload_delay_ms` is the delay above which submissions are refused
    /// (0: never); `snapshot_files_per_hour` snapshot files from one address.
    pub limits: LimitOptions,
    /// The current delay in ms (pool.rs; LoopDelay in the source); without it submissions are
    /// never refused as overload.
    pub loop_delay: Option<Box<dyn Fn() -> f64 + Send + Sync>>,
    /// Receives a line per submission and the counts for a line a minute (see LoadStats).
    pub stats: Option<Arc<Mutex<LoadStats>>>,
    /// Problems per step of the first count of /api/holders; HOLDERS_CHUNK by default (tests use fewer).
    pub holders_chunk: Option<f64>,
    /// Problems per step of an answer of /api/holder; HOLDER_CHUNK by default (tests use fewer).
    pub holder_chunk: Option<f64>,
    /// The clock: `Date.now()`, `performance.now()`.
    pub clock: Clock,
    /// Whether a submission to a problem with disk or ball pieces or a circle or ball container
    /// must carry `"units": "diameter"` (426 without it). On by default; the gate stays until its
    /// sunset date.
    pub units_gate: Option<bool>,
    /// The nightly records snapshot; without it /api/snapshot answers 404.
    pub snapshots: Option<Arc<SnapshotSource>>,
    /// The spaces: their catalogues (the store of their site entries is `store`). Without it the
    /// /api/spaces routes answer 404.
    pub spaces: Option<Arc<dyn SpacesPort>>,
    /// The workers that verify submissions.
    pub pool: Pool,
}

/// app.ts: ATLAS_MAX_SPAN. Most values of P that one /api/atlas request may cover.
pub const ATLAS_MAX_SPAN: f64 = 100.0;
/// app.ts: RECORDS_CACHE_BYTES. Most bytes of /api/records answers the server keeps in memory.
pub const RECORDS_CACHE_BYTES: usize = 64 * 1024 * 1024;
/// app.ts: ATLAS_MAX_PIECES. Most pieces one /api/atlas response carries; the rest of the range is
/// reached through `next`.
pub const ATLAS_MAX_PIECES: f64 = 6000.0;
/// app.ts: HOLDERS_CHUNK. Problems whose leaders one step of the first count of /api/holders
/// reads: under a millisecond of work, and some tens on the throttled CPU of the live server.
/// Other work is let in between steps.
pub const HOLDERS_CHUNK: f64 = 250.0;
/// app.ts: MAX_PEAK_ROWS. Rows one POST /api/admin/holder-peaks takes at most.
pub const MAX_PEAK_ROWS: usize = 10_000;
/// app.ts: HOLDER_CHUNK. Problems one step of GET /api/holder reads: a page of the problems that
/// have an entry of the name and the leaders of those problems, a few milliseconds of work, with
/// other work let in between steps.
pub const HOLDER_CHUNK: f64 = GET_MANY_LIMIT as f64;
/// app.ts: HOLDER_CACHE_NAMES. Names whose answers GET /api/holder keeps; the ones asked least
/// recently go first.
pub const HOLDER_CACHE_NAMES: usize = 32;
/// app.ts: HOLDER_MAX_AGE_MS. How old an answer of GET /api/holder may be and still be given as it
/// is. A submission does not change it before then, so that a name that submits all day has its
/// answer made once in this long, not for every view.
pub const HOLDER_MAX_AGE_MS: f64 = 15.0 * 60_000.0;

/// protocol.ts: Holder. One name of GET /api/holders.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Holder {
    pub name: String,
    pub records: f64,
    pub beat_published: f64,
    pub site_bests: f64,
    pub pending: f64,
    pub peak: f64,
}

impl Holder {
    fn zero(name: &str, peak: f64) -> Holder {
        Holder { name: name.to_string(), records: 0.0, beat_published: 0.0, site_bests: 0.0, pending: 0.0, peak }
    }
}

/// app.ts: holderShare. What the leader `e` of a problem adds to the counts of its name on
/// /api/holders, given the problem's published record (if any); None when the problem is closed,
/// which counts for no one.
pub fn holder_share(e: &ProblemLeader, lit: Option<&LiteratureRecord>) -> Option<Holder> {
    if closed_to_submissions(lit) {
        return None;
    }
    // a share carries no peak (0): peaks belong to the names, not to one lead
    let mut share = Holder { name: e.name.clone(), records: 0.0, beat_published: 0.0, site_bests: 1.0, pending: 0.0, peak: 0.0 };
    // until a claim is reviewed, the published value it claims to beat is still the record
    if e.verification == "pending" {
        share.pending = 1.0;
    } else if lit.is_none_or(|l| reaches_literature(e.score, l)) {
        share.records = 1.0;
        if lit.is_some_and(|l| beats_literature(e.score, l)) {
            share.beat_published = 1.0;
        }
    }
    Some(share)
}

/// What the atlas draws for one P.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AtlasSource {
    Verified,
    Literature,
    Pending,
}

/// app.ts: atlasSource. Which packing the atlas draws for one P.
///  - Verified: the best site entry that is not awaiting review, when it is at least as good as
///    the published value, to the precision the source prints (never finer than 1e-9, so that a
///    re-derived optimum such as 3.0000000000000004 still counts as matching 3);
///  - Literature: otherwise the published coordinates;
///  - Verified again: a verified entry that is worse than a published value without coordinates
///    is still the best packing that can be drawn;
///  - Pending: an entry that claims to beat the published value and has not been reviewed is
///    drawn only when nothing else can be, and the answer marks it as pending.
pub fn atlas_source(verified: Option<f64>, lit: Option<&LiteratureRecord>, lit_has_pieces: bool, pending: bool) -> Option<AtlasSource> {
    if let Some(score) = verified {
        if lit.is_none_or(|l| reaches_literature(score, l)) {
            return Some(AtlasSource::Verified);
        }
    }
    if lit.is_some() && lit_has_pieces {
        return Some(AtlasSource::Literature);
    }
    if verified.is_some() {
        return Some(AtlasSource::Verified);
    }
    pending.then_some(AtlasSource::Pending)
}

/// app.ts: parseEventKeys. The keys of GET /api/events?keys=...: comma-separated "N/M/P" (one
/// problem) or "N/M/*" (every P of a pair), at most MAX_EVENT_KEYS, written back in one form
/// ("04/4/11" is "4/4/11"); an empty list follows nothing. `Err` is the message when the text is
/// not such a list.
pub fn parse_event_keys(text: &str) -> Result<Vec<String>, String> {
    let mut keys: IndexSet<String> = IndexSet::new();
    let parts: Vec<&str> = if text.is_empty() { Vec::new() } else { text.split(',').collect() };
    for part in parts {
        // /^(\d{1,3})\/(\d{1,3})\/(\d{1,3}|\*)$/
        let digits = |s: &str| (1..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
        let pieces: Vec<&str> = part.split('/').collect();
        let matched = pieces.len() == 3 && digits(pieces[0]) && digits(pieces[1]) && (digits(pieces[2]) || pieces[2] == "*");
        // Number(undefined) is NaN
        let n = if matched { js::number(pieces[0]) } else { f64::NAN };
        let m = if matched { js::number(pieces[1]) } else { f64::NAN };
        let star = matched && pieces[2] == "*";
        let p = if matched && !star { js::number(pieces[2]) } else { f64::NAN };
        if !is_shape_code_number(n) || !is_shape_code_number(m) || (!star && !(p >= 1.0 && p <= MAX_PIECES as f64)) {
            return Err(format!(
                "keys must be N/M/P or N/M/*, separated by commas, with N and M 0 or 3 to {MAX_SIDES} and P 1 to {MAX_PIECES}; \"{}\" is not",
                js::utf16_prefix(part, 20)
            ));
        }
        keys.insert(format!("{}/{}/{}", fmt::num(n), fmt::num(m), if star { "*".to_string() } else { fmt::num(p) }));
    }
    if keys.len() > MAX_EVENT_KEYS {
        return Err(format!("at most {MAX_EVENT_KEYS} keys"));
    }
    Ok(keys.into_iter().collect())
}

/// app.ts: decimalInteger. A query value that is a plain decimal integer; anything else (absent,
/// empty, "0x10", "1e2", "1.5") is NaN.
fn decimal_integer(text: Option<&str>) -> f64 {
    match text {
        Some(t) if (1..=9).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit()) => js::number(t),
        _ => f64::NAN,
    }
}

/// The published records: as the file gives them (what an answer shows) and as the rules read them.
pub struct Literature {
    raw: Vec<Value>,
    typed: Vec<LiteratureRecord>,
    /// "N/M/P" to the record's place in the list; of two records of one problem the later stands.
    by_key: HashMap<String, usize>,
}

impl Literature {
    /// `Err` names the first record that is not a LiteratureRecord.
    pub fn new(raw: Vec<Value>) -> Result<Literature, String> {
        let mut typed = Vec::with_capacity(raw.len());
        let mut by_key = HashMap::new();
        for (i, r) in raw.iter().enumerate() {
            // through its text: the store's reader holds every number as a double, and a record's N is a whole number
            let t: LiteratureRecord = serde_json::from_str(&stringify(r)).map_err(|e| format!("record {i} of the published records is not a record: {e}"))?;
            by_key.insert(format!("{}/{}/{}", t.n, t.m, t.p), i);
            typed.push(t);
        }
        Ok(Literature { raw, typed, by_key })
    }

    pub fn len(&self) -> usize {
        self.raw.len()
    }

    pub fn is_empty(&self) -> bool {
        self.raw.is_empty()
    }

    fn index(&self, n: f64, m: f64, p: f64) -> Option<usize> {
        self.by_key.get(&format!("{}/{}/{}", fmt::num(n), fmt::num(m), fmt::num(p))).copied()
    }

    /// `literature.get("N/M/P")`.
    pub fn get(&self, n: f64, m: f64, p: f64) -> Option<&LiteratureRecord> {
        self.index(n, m, p).map(|i| &self.typed[i])
    }

    fn raw(&self, n: f64, m: f64, p: f64) -> Option<&Value> {
        self.index(n, m, p).map(|i| &self.raw[i])
    }

    /// Closed problems take no submissions and show no site entries: their published optimum
    /// stands. Entries stored before a problem was closed stay in the database and keep their
    /// share links.
    pub fn closed(&self, n: f64, m: f64, p: f64) -> bool {
        closed_to_submissions(self.get(n, m, p))
    }
}

/// The answers of /api/records that are kept, oldest first, and their size in UTF-16 units (the
/// `length` the source adds up).
#[derive(Default)]
struct RecordsCache {
    by_key: HashMap<String, (u64, Bytes, usize)>,
    order: BTreeMap<u64, String>,
    next: u64,
    bytes: usize,
}

impl RecordsCache {
    fn get(&self, key: &str) -> Option<Bytes> {
        self.by_key.get(key).map(|(_, body, _)| body.clone())
    }

    /// app.ts: forgetRecords.
    fn forget(&mut self, key: Option<&str>) {
        match key {
            None => {
                self.by_key.clear();
                self.order.clear();
                self.bytes = 0;
            }
            Some(key) => {
                if let Some((seq, _, length)) = self.by_key.remove(key) {
                    self.bytes -= length;
                    self.order.remove(&seq);
                }
            }
        }
    }

    /// app.ts: keepRecords.
    fn keep(&mut self, key: &str, body: Bytes, length: usize) {
        self.forget(Some(key));
        // the oldest answers go first
        while let Some((_, oldest)) = self.order.iter().next() {
            if self.bytes + length <= RECORDS_CACHE_BYTES {
                break;
            }
            let oldest = oldest.clone();
            self.forget(Some(&oldest));
        }
        if length > RECORDS_CACHE_BYTES {
            return;
        }
        self.next += 1;
        self.order.insert(self.next, key.to_string());
        self.by_key.insert(key.to_string(), (self.next, body, length));
        self.bytes += length;
    }
}

/// app.ts: HolderCounts.
struct HolderCounts {
    by_name: IndexMap<String, Holder>,
    /// The last problem counted, in the order the store lists them; None before the first page.
    up_to: Option<ProblemKey>,
    /// True once the last page is counted.
    done: bool,
}

impl HolderCounts {
    fn none() -> HolderCounts {
        HolderCounts { by_name: IndexMap::new(), up_to: None, done: false }
    }
}

/// app.ts: HolderKept.
struct HolderKept {
    body: Bytes,
    /// When the answer was begun, by the clock.
    at: f64,
}

/// app.ts: HolderRun. An answer of /api/holder that is being made; requests for the same name
/// that arrive meanwhile wait for it.
struct HolderRun {
    /// False once an administrator's change came: the answer is given to those waiting, and not kept.
    keep: AtomicBool,
    done: tokio::sync::watch::Sender<Option<Result<Bytes, String>>>,
}

/// What the source keeps in the closure of `createApp`, apart from the limits and the streams.
struct State {
    // The listing of one (N, M) runs a query over every entry of the pair, and SQLite blocks while
    // it does, so answers are kept until an entry of that pair changes. A new entry clears its own
    // pair; an administrator's change, rare, clears all. The bytes kept are bounded.
    records_cache: RecordsCache,
    /// The "N/M" of every pair with a listed entry; None before the first request and after a
    /// change that may have emptied a pair.
    site_pairs: Option<IndexSet<String>>,
    /// The answer for `site_pairs`, built when asked for and again after the set changes.
    pairs_body: Option<Bytes>,
    counts: HolderCounts,
    /// The most records known for each name that has held one; only ever raised. Valid for the
    /// answer once `counts.done`.
    peaks: IndexMap<String, f64>,
    /// The answer for `counts` once they are done; None after any change of them.
    holders_body: Option<Bytes>,
    /// Peaks raised in memory that the store has not taken yet, by name.
    unsaved: IndexMap<String, f64>,
    /// Least recently asked first.
    holder_kept: IndexMap<String, HolderKept>,
    holder_runs: HashMap<String, Arc<HolderRun>>,
}

type Listener = tokio::sync::mpsc::UnboundedSender<Bytes>;

/// Live updates go to the streams that follow the problem, by "N/M/P" or "N/M/*", and to those
/// that follow every problem, so that each change costs a write per interested stream only.
#[derive(Default)]
struct Follow {
    next: u64,
    follow_all: IndexMap<u64, Listener>,
    followers: HashMap<String, IndexMap<u64, Listener>>,
}

/// The HTTP API: what `createApp` returns.
pub struct App {
    store: StoreHandle,
    literature: Arc<Literature>,
    /// "N/M" to the number of published values of the pair, in the order of the records.
    published: IndexMap<String, f64>,
    admin_token: Option<String>,
    client_ip: Box<dyn Fn(&Req) -> String + Send + Sync>,
    log: Log,
    submit_limits: Arc<SubmitLimits>,
    snapshot_limit: Mutex<RateLimiter>,
    overload_delay_ms: f64,
    loop_delay: Box<dyn Fn() -> f64 + Send + Sync>,
    stats: Option<Arc<Mutex<LoadStats>>>,
    holders_chunk: f64,
    holder_chunk: f64,
    clock: Clock,
    units_gate: bool,
    snapshots: Option<Arc<SnapshotSource>>,
    spaces: Option<Arc<dyn SpacesPort>>,
    /// The routes of the spaces and what they keep between requests; with `spaces`.
    space_routes: Option<Arc<SpaceRoutes>>,
    pool: Pool,
    state: Mutex<State>,
    follow: Mutex<Follow>,
    /// One build of the holders' counts at a time; requests that arrive during it wait for it.
    building: tokio::sync::Mutex<()>,
    /// The API page: the same text for every request.
    docs: Bytes,
}

#[derive(Serialize)]
struct ContainerOut {
    #[serde(rename = "M")]
    m: f64,
    cx: f64,
    cy: f64,
    phi: f64,
    size: f64,
}

/// protocol.ts: SubmitResponse.
#[derive(Serialize)]
struct SubmitResponse<'a> {
    valid: bool,
    reasons: &'a [String],
    score: Option<f64>,
    rank: Option<f64>,
    leader: bool,
    leader_score: Option<f64>,
    id: Option<f64>,
    container: Option<ContainerOut>,
    pending_verification: bool,
    strict_check: &'a Option<Value>,
}

/// What POST /api/submit knows of a request once its body is read.
struct Submission {
    started: f64,
    submitter: Submitter,
}

impl App {
    /// app.ts: createApp.
    pub fn new(opts: AppOptions) -> Result<Arc<App>, String> {
        let literature = opts.records;
        let mut published: IndexMap<String, f64> = IndexMap::new();
        for r in &literature.typed {
            *published.entry(format!("{}/{}", r.n, r.m)).or_insert(0.0) += 1.0;
        }
        let window_ms = opts.limits.window_ms.unwrap_or(60_000.0);
        let submit_limits = Arc::new(SubmitLimits::new(
            opts.submit_key.filter(|k| !k.is_empty()),
            SubmitLimitValues {
                per_ip: opts.limits.per_ip.unwrap_or(SUBMISSIONS_PER_MINUTE),
                window_ms,
                verify_ms_per_minute: opts.limits.verify_ms_per_minute.unwrap_or(VERIFY_MS_PER_MINUTE),
                per_key: opts.limits.per_key.unwrap_or(KEYED_SUBMISSIONS_PER_MINUTE),
                key_verify_ms_per_minute: opts.limits.key_verify_ms_per_minute.unwrap_or(KEYED_VERIFY_MS_PER_MINUTE),
            },
            opts.clock.clone(),
        ));
        let docs = match &opts.spaces {
            Some(s) => docs_page(Self::docs_limits(), s.docs()),
            None => docs_page(Self::docs_limits(), &SpacesDocs::of_the_package()),
        };
        let space_routes = opts.spaces.as_ref().map(|s| SpaceRoutes::new(&**s, opts.clock.clone()));
        Ok(Arc::new(App {
            store: opts.store,
            literature,
            published,
            admin_token: opts.admin_token.filter(|t| !t.is_empty()),
            client_ip: opts.client_ip.unwrap_or_else(|| Box::new(|_| "unknown".to_string())),
            log: opts.log.unwrap_or_else(|| Arc::new(|msg: &str| println!("{msg}"))),
            submit_limits,
            snapshot_limit: Mutex::new(RateLimiter::new(opts.limits.snapshot_files_per_hour.unwrap_or(SNAPSHOT_FILES_PER_HOUR), 3_600_000.0)),
            overload_delay_ms: opts.limits.overload_delay_ms.unwrap_or(OVERLOAD_DELAY_MS),
            loop_delay: opts.loop_delay.unwrap_or_else(|| Box::new(|| 0.0)),
            stats: opts.stats,
            holders_chunk: opts.holders_chunk.unwrap_or(HOLDERS_CHUNK),
            holder_chunk: polypack_js::math::min(opts.holder_chunk.unwrap_or(HOLDER_CHUNK), GET_MANY_LIMIT as f64),
            clock: opts.clock,
            units_gate: opts.units_gate != Some(false),
            snapshots: opts.snapshots,
            spaces: opts.spaces,
            space_routes,
            pool: opts.pool,
            state: Mutex::new(State {
                records_cache: RecordsCache::default(),
                site_pairs: None,
                pairs_body: None,
                counts: HolderCounts::none(),
                peaks: IndexMap::new(),
                holders_body: None,
                unsaved: IndexMap::new(),
                holder_kept: IndexMap::new(),
                holder_runs: HashMap::new(),
            }),
            follow: Mutex::new(Follow::default()),
            building: tokio::sync::Mutex::new(()),
            docs: Bytes::from(docs),
        }))
    }

    fn docs_limits() -> DocsLimits {
        DocsLimits { atlas_max_span: ATLAS_MAX_SPAN, atlas_max_pieces: ATLAS_MAX_PIECES, holder_cache_names: HOLDER_CACHE_NAMES as f64, holder_max_age_ms: HOLDER_MAX_AGE_MS }
    }

    /// The published records.
    pub fn literature(&self) -> &Literature {
        &self.literature
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    fn store(&self) -> MutexGuard<'_, SqliteStore> {
        self.store.lock().unwrap()
    }

    /// True while submissions are refused as overload.
    fn overloaded(&self) -> bool {
        self.overload_delay_ms > 0.0 && (self.loop_delay)() > self.overload_delay_ms
    }

    /// Answers a request to a path of the API (`/api` and below), as the routes of `createApp` do
    /// in their order; None for any other path, which is not the API's. `method` is the method the
    /// request is routed by: GET for a HEAD request (hono-base.js), while `req.method` stays HEAD.
    pub async fn fetch(self: &Arc<Self>, method: &str, req: &mut Req) -> Option<Res> {
        let path = req.path.clone();
        if !(path == "/api" || path.starts_with("/api/")) {
            return None;
        }
        // Volunteer clients older than VOLUNTEER_MIN_VERSION are told to update (426) before
        // anything else: 0.2.x read the work lists that are gone, and 0.1.x would read new-unit
        // leaders as old ones and send old-unit packings that pass as valid but poor. The API
        // page, the health check and the snapshot stay open.
        if is_old_volunteer(req.header("user-agent").as_deref()) && !old_client_may_read(&req.method, &path) {
            let message = upgrade_message();
            return Some(hono::json(&json!({ "error": message, "reasons": [message], "conventions_version": CONVENTIONS_VERSION }), 426));
        }
        let segments: Vec<&str> = path.split('/').collect();
        // app.use(path, compress()): the routes whose answers are compressed
        let compressed = matches!(path.as_str(), "/api/records/pairs" | "/api/holder" | "/api/atlas" | "/api/leaders");
        let handled: Handled = match (method, &segments[1..]) {
            ("GET", ["api"]) => Ok(hono::html(self.docs.clone())),
            ("GET", ["api", "health"]) => Ok(hono::json_text("{\"ok\":true}", 200)),
            ("GET", ["api", "problems", n, m, p]) if nonempty(&[n, m, p]) => tokio::task::block_in_place(|| self.problem(n, m, p)),
            ("GET", ["api", "leaderboard", n, m, p]) if nonempty(&[n, m, p]) => tokio::task::block_in_place(|| self.leaderboard(n, m, p)),
            ("GET", ["api", "records"]) => tokio::task::block_in_place(|| self.records(req)),
            ("GET", ["api", "records", "pairs"]) => tokio::task::block_in_place(|| self.record_pairs()),
            ("GET", ["api", "holders"]) => self.holders().await,
            ("GET", ["api", "holder"]) => self.holder(req).await,
            ("GET", ["api", "atlas"]) => tokio::task::block_in_place(|| self.atlas(req)),
            ("GET", ["api", "submissions", id]) if !id.is_empty() => tokio::task::block_in_place(|| self.submission(id)),
            ("POST", ["api", "submit"]) => self.submit(req).await,
            ("GET", ["api", "events"]) => Ok(self.events(req)),
            ("GET", ["api", "admin", "pending"]) => tokio::task::block_in_place(|| self.admin_pending(req)),
            ("POST", ["api", "admin", "review"]) => self.admin_review(req).await,
            ("POST", ["api", "admin", "remove"]) => self.admin_remove(req).await,
            ("POST", ["api", "admin", "edit"]) => self.admin_edit(req).await,
            ("POST", ["api", "admin", "holder-peaks"]) => self.admin_holder_peaks(req).await,
            ("GET", ["api", "snapshot"]) => tokio::task::block_in_place(|| self.snapshot_manifest()),
            ("GET", ["api", "snapshot", file]) if !file.is_empty() => self.snapshot_file(file, req).await,
            _ => {
                // The spaces share the submission limits of /api/submit: one count and one
                // verification budget per address (or for the submit key).
                let routed = match (&self.spaces, &self.space_routes) {
                    (Some(spaces), Some(routes)) => {
                        let overloaded = || self.overloaded();
                        let admin = |r: &Req| self.admin(r);
                        let ctx = SpaceRouteContext {
                            routes,
                            spaces,
                            store: &self.store,
                            units_gate: self.units_gate,
                            submit_limits: &self.submit_limits,
                            overloaded: &overloaded,
                            client_ip: &*self.client_ip,
                            log: &self.log,
                            stats: self.stats.as_ref(),
                            admin: &admin,
                            pool: &self.pool,
                            clock: &self.clock,
                        };
                        space_routes(&ctx, method, &path, req).await
                    }
                    _ => SpaceRoute::Pass,
                };
                match routed {
                    SpaceRoute::Answer(res) => return Some(res),
                    SpaceRoute::Pass => {
                        // Who leads, for many problems at once (Tighter's rent checks); after the
                        // spaces, whose catalogues it reads.
                        if method == "GET" && path == "/api/leaders" {
                            let closed = |n: f64, m: f64, p: f64| self.literature.closed(n, m, p);
                            tokio::task::block_in_place(|| leaders_route(req, &self.store, self.spaces.as_ref(), &closed))
                        } else {
                            // app.all("/api/*")
                            Ok(hono::json_error("not found", 404))
                        }
                    }
                }
            }
        };
        let res = handled.unwrap_or_else(hono::on_error);
        Some(if compressed { hono::compress(&req.method, req.header("accept-encoding").as_deref(), res).await } else { res })
    }

    /// app.ts: problemOf. Reads N, M, P from the path; None when out of range.
    fn problem_of(n: &str, m: &str, p: &str) -> Option<ProblemKey> {
        let number = |text: &str| js::number(&js::try_decode_uri_component(text));
        let (n, m, p) = (number(n), number(m), number(p));
        if !is_shape_code_number(n) || !is_shape_code_number(m) || !js::is_integer(p) || p < 1.0 || p > MAX_PIECES as f64 {
            return None;
        }
        Some(ProblemKey { n, m, p })
    }

    /// app.ts: badProblem.
    fn bad_problem() -> Res {
        hono::json_error(&format!("N and M must be 0 or an integer from 3 to {MAX_SIDES}; P an integer from 1 to {MAX_PIECES}"), 400)
    }

    /// app.ts: CONVENTIONS.
    fn conventions() -> Value {
        json!({
            "version": CONVENTIONS_VERSION,
            "units": "polygon pieces have side length 1; disk (circle) pieces have diameter 1 (radius 1/2); angles in radians; a submission to a problem with disk or ball pieces or a circle or ball container carries \"units\": \"diameter\"",
            "piece_pose": "N-gon vertex k = (x, y) + R (cos(theta + pi/2 + 2 pi k / N), sin(theta + pi/2 + 2 pi k / N)), R = 1 / (2 sin(pi / N)); circles ignore theta",
            "container": "regular M-gon vertex k = (cx, cy) + s / (2 sin(pi / M)) (cos(phi - pi/2 + pi/M + 2 pi k / M), sin(...)); circle given by centre and size (its diameter)",
            "score": "container side length s (polygon) or diameter (circle); smaller is better",
            "shapes": format!("N and M are 0 for a circle or an integer from 3 to {MAX_SIDES}; P is from 1 to {MAX_PIECES}"),
            "validity": format!("pieces may touch; two pieces overlap when their separation is below -{}", fmt::num(TOL)),
            "scoring": "the server scores the container at the container_phi sent (0 when it is missing) and does not search for a better orientation: turn the container to its best orientation before submitting",
        })
    }

    /// GET /api/problems/:N/:M/:P
    fn problem(&self, n: &str, m: &str, p: &str) -> Handled {
        let Some(k) = Self::problem_of(n, m, p) else {
            return Ok(Self::bad_problem());
        };
        let open = !self.literature.closed(k.n, k.m, k.p);
        #[derive(Serialize)]
        struct ProblemInfo<'a> {
            #[serde(rename = "N")]
            n: f64,
            #[serde(rename = "M")]
            m: f64,
            #[serde(rename = "P")]
            p: f64,
            conventions: Value,
            area_bound: f64,
            literature: Option<&'a Value>,
            site_best: Option<LeaderboardEntry>,
            accepts_submissions: bool,
        }
        let body = ProblemInfo {
            n: k.n,
            m: k.m,
            p: k.p,
            conventions: Self::conventions(),
            area_bound: area_lower_bound(k.n as u32, k.m as u32, k.p as usize),
            literature: self.literature.raw(k.n, k.m, k.p),
            site_best: if open { self.store().leader(k.n, k.m, k.p)? } else { None },
            accepts_submissions: open,
        };
        Ok(hono::json(&body, 200))
    }

    /// GET /api/leaderboard/:N/:M/:P
    fn leaderboard(&self, n: &str, m: &str, p: &str) -> Handled {
        let Some(k) = Self::problem_of(n, m, p) else {
            return Ok(Self::bad_problem());
        };
        let open = !self.literature.closed(k.n, k.m, k.p);
        let (leader, total) = {
            let store = self.store();
            (if open { store.leader(k.n, k.m, k.p)? } else { None }, store.count(k.n, k.m, k.p)?)
        };
        #[derive(Serialize)]
        struct Leaderboard {
            #[serde(rename = "N")]
            n: f64,
            #[serde(rename = "M")]
            m: f64,
            #[serde(rename = "P")]
            p: f64,
            entries: Vec<LeaderboardEntry>,
            total: f64,
            accepts_submissions: bool,
        }
        // `entries` is a list for clients written when several rows were shown; it holds the leader only
        Ok(hono::json(&Leaderboard { n: k.n, m: k.m, p: k.p, entries: leader.into_iter().collect(), total, accepts_submissions: open }, 200))
    }

    /// GET /api/records
    fn records(&self, req: &Req) -> Handled {
        // Number(undefined) is NaN
        let n = req.query("N").map_or(f64::NAN, |t| js::number(&t));
        let m = req.query("M").map_or(f64::NAN, |t| js::number(&t));
        if !is_shape_code_number(n) || !is_shape_code_number(m) {
            return Ok(hono::json_error("query parameters N and M are required", 400));
        }
        let key = format!("{}/{}", fmt::num(n), fmt::num(m));
        let mut state = self.state();
        if let Some(cached) = state.records_cache.get(&key) {
            return Ok(Res::new(200, ResBody::Full(cached)).with("content-type", "application/json"));
        }
        // coordinates are left out of the listing; /api/problems/{N}/{M}/{P} has them
        let mut lit: Vec<(u32, &Value)> = self.literature.typed.iter().zip(&self.literature.raw).filter(|(t, _)| t.n as f64 == n && t.m as f64 == m).map(|(t, raw)| (t.p, raw)).collect();
        lit.sort_by_key(|(p, _)| *p);
        let lit: Vec<Value> = lit
            .into_iter()
            .map(|(_, raw)| {
                let mut rest: Map<String, Value> = raw.as_object().cloned().unwrap_or_default();
                let pieces = rest.shift_remove("pieces");
                rest.insert("has_coordinates".to_string(), Value::Bool(pieces.as_ref().is_some_and(crate::store::json::truthy)));
                Value::Object(rest)
            })
            .collect();
        let store = self.store();
        let site: Vec<BestOfP> = store.best_per_p(n, m, false)?.into_iter().filter(|e| !self.literature.closed(n, m, e.p)).collect();
        // Where the best entry of a P still awaits review, the best reviewed one is listed as well,
        // so that a page never has to present an unverified claim as the smallest known value.
        let awaiting: Vec<f64> = site.iter().filter(|e| e.verification == "pending").map(|e| e.p).collect();
        let site_verified: Vec<BestOfP> = if awaiting.is_empty() { Vec::new() } else { store.best_per_p(n, m, true)?.into_iter().filter(|e| awaiting.contains(&e.p)).collect() };
        drop(store);
        #[derive(Serialize)]
        struct Records {
            #[serde(rename = "N")]
            n: f64,
            #[serde(rename = "M")]
            m: f64,
            literature: Vec<Value>,
            site: Vec<BestOfP>,
            site_verified: Vec<BestOfP>,
        }
        let text = stringify(&Records { n, m, literature: lit, site, site_verified });
        let length = js::utf16_len(&text);
        let body = Bytes::from(text);
        state.records_cache.keep(&key, body.clone(), length);
        Ok(Res::new(200, ResBody::Full(body)).with("content-type", "application/json"))
    }

    /// app.ts: pairsAnswer.
    fn pairs_answer(&self, sites: &IndexSet<String>) -> Bytes {
        let mut keys: IndexSet<&str> = self.published.keys().map(String::as_str).collect();
        keys.extend(sites.iter().map(String::as_str));
        let mut pairs: Vec<(f64, f64)> = keys
            .iter()
            .map(|k| {
                let mut parts = k.split('/').map(js::number);
                (parts.next().unwrap_or(f64::NAN), parts.next().unwrap_or(f64::NAN))
            })
            .collect();
        pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)));
        let list: Vec<Value> = pairs
            .into_iter()
            .map(|(n, m)| {
                let key = format!("{}/{}", fmt::num(n), fmt::num(m));
                json!({ "N": n, "M": m, "published": self.published.get(&key).copied().unwrap_or(0.0), "site": sites.contains(&key) })
            })
            .collect();
        Bytes::from(to_vec(&json!({ "pairs": list })))
    }

    /// GET /api/records/pairs
    ///
    /// Which pairs of shapes have anything to show: a published value or a listed entry. The
    /// records page marks them in its menus and asks on every load, while entries arrive every
    /// second, so reading the pairs from the store for each answer scanned every entry again and
    /// again. The pairs with a listed entry are kept in memory instead. The first request reads
    /// them once with store.pairs(); a new entry adds its pair; only a change that may take the
    /// last entry out of a pair makes the next request read them again.
    ///
    /// The source also keeps count of the changes that overlap a reading (`pairsShrunk`,
    /// `pairsAdded`), for a store that answers asynchronously. Here the reading holds the state for
    /// as long as it takes, so no change can overlap it.
    fn record_pairs(&self) -> Handled {
        let mut state = self.state();
        if state.site_pairs.is_none() {
            let sites: IndexSet<String> = self.store().pairs()?.into_iter().map(|p| format!("{}/{}", fmt::num(p.n), fmt::num(p.m))).collect();
            state.pairs_body = Some(self.pairs_answer(&sites));
            state.site_pairs = Some(sites);
        }
        if state.pairs_body.is_none() {
            state.pairs_body = Some(self.pairs_answer(state.site_pairs.as_ref().expect("read above")));
        }
        let body = state.pairs_body.clone().expect("made above");
        Ok(Res::new(200, ResBody::Full(body)).with("content-type", "application/json"))
    }

    // Who holds how many records: the leader of every open problem, counted by the exact name it
    // was submitted with. Counting every leader held the live server for about 20 s with 290,000
    // problems (its CPU is throttled to a sixteenth of a core), and it was done again after every
    // restart and every 15 minutes. So the counts are kept. The first request builds them,
    // HOLDERS_CHUNK problems at a time with other work let in between, and from then on each change
    // of an entry moves its problem's share (holder_share) from the old leader to the new one. No
    // request reads the table again.
    //
    // The invariant, whenever no page of the build and no change is in progress (each holds the
    // state for its turn): the counts are the sum of holder_share over the leaders of the problems
    // up to the cursor `up_to`, in the order of (N, M, P), and over the leaders of all problems
    // once `done`. So a change to a problem up to the cursor moves its share, the old leader out
    // and the new one in, and a change to a problem beyond it does nothing: the page that gets
    // there reads the problem as it is then. That is why a change during the build is neither lost
    // in the part counted nor counted twice in the part to come.
    //
    // Peaks (Holder.peak) come on top of that. A name that has held a record is never dropped: its
    // row stays at zero when it leads nothing. `peaks` holds the highest `records` known for each
    // name and is never lowered, not even by the reset of an error. They are raised only once the
    // counts are done, in the same turn as the change of the leader that raised them, and stored
    // one upsert per raised name (raise_holder_peaks). The turn that finishes the build loads the
    // stored peaks, lists every name in them, and writes the peaks the counts have raised, so a
    // restart or a rebuild loses no row and no peak.

    /// app.ts: countShare. Adds (`sign` 1) or takes out (-1) one leader's share.
    fn count_share(state: &mut State, share: &Holder, sign: f64) {
        let peak = state.peaks.get(&share.name).copied().unwrap_or(0.0);
        let h = state.counts.by_name.entry(share.name.clone()).or_insert_with(|| Holder::zero(&share.name, peak));
        h.records += sign * share.records;
        h.beat_published += sign * share.beat_published;
        h.site_bests += sign * share.site_bests;
        h.pending += sign * share.pending;
        // a name that leads no open problem is listed only if it has held a record
        if h.site_bests == 0.0 && h.peak == 0.0 {
            state.counts.by_name.shift_remove(&share.name);
        }
    }

    /// app.ts: savePeaks. Persists raised peaks, with any that an earlier failure left unsaved. A
    /// failure is logged and does not fail the change that raised them: the peaks stand in memory,
    /// and the next raise writes them again.
    fn save_peaks(&self, state: &mut State, store: &SqliteStore, rows: &[HolderPeak]) {
        for r in rows {
            let had = state.unsaved.get(&r.name).copied().unwrap_or(0.0);
            state.unsaved.insert(r.name.clone(), polypack_js::math::max(r.peak, had));
        }
        if state.unsaved.is_empty() {
            return;
        }
        let batch: Vec<HolderPeak> = state.unsaved.iter().map(|(name, peak)| HolderPeak { name: name.clone(), peak: *peak }).collect();
        match store.raise_holder_peaks(&batch) {
            Ok(()) => {
                for r in &batch {
                    if state.unsaved.get(&r.name) == Some(&r.peak) {
                        state.unsaved.shift_remove(&r.name);
                    }
                }
            }
            Err(e) => (self.log)(&format!("[holders] could not store {} peak(s): {}", batch.len(), e.message())),
        }
    }

    /// app.ts: raisePeak. Raises the peak of `name` to its records, if they are more; returns the
    /// row to store, or None.
    fn raise_peak(state: &mut State, name: &str) -> Option<HolderPeak> {
        let h = state.counts.by_name.get_mut(name)?;
        if h.records <= h.peak {
            return None;
        }
        h.peak = h.records;
        let records = h.records;
        state.peaks.insert(name.to_string(), records);
        Some(HolderPeak { name: name.to_string(), peak: records })
    }

    /// app.ts: finishPeaks. Called in the turn that counts the last page: lists every name with a
    /// stored (or remembered) peak, at zero if it leads nothing, and sets each peak to the most of
    /// the stored one and the records. Raised ones are stored.
    fn finish_peaks(&self, state: &mut State, store: &SqliteStore) {
        let mut stored: IndexMap<String, f64> = IndexMap::new();
        match store.holder_peaks() {
            Ok(rows) => {
                for r in rows {
                    stored.insert(r.name, r.peak);
                }
            }
            Err(e) => (self.log)(&format!("[holders] could not read the stored peaks: {}", e.message())),
        }
        for (name, peak) in &stored {
            if *peak > state.peaks.get(name).copied().unwrap_or(0.0) {
                state.peaks.insert(name.clone(), *peak);
            }
        }
        for (name, peak) in &state.peaks {
            if !state.counts.by_name.contains_key(name) {
                state.counts.by_name.insert(name.clone(), Holder::zero(name, *peak));
            }
        }
        let mut raised: Vec<HolderPeak> = Vec::new();
        for h in state.counts.by_name.values_mut() {
            h.peak = polypack_js::math::max(polypack_js::math::max(h.peak, state.peaks.get(&h.name).copied().unwrap_or(0.0)), h.records);
            if h.peak > 0.0 {
                state.peaks.insert(h.name.clone(), h.peak);
            }
            if h.peak > stored.get(&h.name).copied().unwrap_or(0.0) {
                raised.push(HolderPeak { name: h.name.clone(), peak: h.peak });
            }
        }
        state.holders_body = None;
        self.save_peaks(state, store, &raised);
    }

    /// app.ts: shareOf.
    fn share_of(&self, e: &ProblemLeader) -> Option<Holder> {
        holder_share(e, self.literature.get(e.n, e.m, e.p))
    }

    /// app.ts: counted. Whether the counts include problem `p` (the build has passed it, or is
    /// done): see the invariant.
    fn counted(state: &State, p: &ProblemKey) -> bool {
        if state.counts.done {
            return true;
        }
        match &state.counts.up_to {
            None => false,
            Some(up_to) => {
                // (p.N - upTo.N || p.M - upTo.M || p.P - upTo.P) <= 0
                let first = [p.n - up_to.n, p.m - up_to.m].into_iter().find(|d| *d != 0.0 && !d.is_nan()).unwrap_or(p.p - up_to.p);
                first <= 0.0
            }
        }
    }

    /// app.ts: leaderMoved. The leader of problem `p` was `old` and is `now` (either may be none):
    /// moves its share, if the counts include the problem, and raises the peak of the name that
    /// gained, stored before it returns. Only in a turn.
    fn leader_moved(&self, state: &mut State, store: &SqliteStore, p: &ProblemKey, old: Option<&ProblemLeader>, now: Option<&ProblemLeader>) {
        if !Self::counted(state, p) {
            return;
        }
        let out = old.and_then(|e| self.share_of(e));
        let into = now.and_then(|e| self.share_of(e));
        if out.is_none() && into.is_none() {
            return;
        }
        // the same share (a better score of the same name, say) leaves the counts and the answer as they are
        if let (Some(o), Some(i)) = (&out, &into) {
            if o.name == i.name && o.records == i.records && o.beat_published == i.beat_published && o.pending == i.pending {
                return;
            }
        }
        if let Some(o) = &out {
            Self::count_share(state, o, -1.0);
        }
        if let Some(i) = &into {
            Self::count_share(state, i, 1.0);
        }
        state.holders_body = None;
        // before the build is done the stored peaks are not yet merged in: finish_peaks sees the records then
        let raised = match &into {
            Some(i) if state.counts.done => Self::raise_peak(state, &i.name),
            _ => None,
        };
        if let Some(r) = raised {
            self.save_peaks(state, store, &[r]);
        }
    }

    /// app.ts: holderClear. An administrator changed an entry: every answer is out of date, and
    /// none that is being made may be kept.
    fn holder_clear(state: &mut State) {
        state.holder_kept.clear();
        for run in state.holder_runs.values() {
            run.keep.store(false, Ordering::Relaxed);
        }
        state.holder_runs.clear();
    }

    /// app.ts: changeEntry. Runs an administrator's `change` to the listed entry `id` in a turn,
    /// and moves the share of the entry's problem from the leader read before the change to the
    /// one read after it. `moves` is false for a change that cannot move a leader or a name (a
    /// note, provenance). Whatever the change, the answers of /api/holder are all forgotten once
    /// it is made, however it ends.
    ///
    /// When the change was made, the kept answers of /api/records are forgotten (app.ts:
    /// entriesChanged), and with `shrinks` the pairs too (pairsMayHaveShrunk: an entry was deleted,
    /// and with it perhaps the last of its pair). The source does that right after the turn, before
    /// any other request can run; here it is done within it, for the same effect.
    fn change_entry(&self, id: f64, moves: bool, shrinks: bool, change: impl FnOnce(&SqliteStore) -> crate::store::Result<bool>) -> Result<bool, Thrown> {
        let mut state = self.state();
        let store = self.store();
        let state = &mut *state;
        let changed = |state: &mut State, ok: bool| {
            if ok {
                state.records_cache.forget(None);
                if shrinks {
                    state.site_pairs = None;
                    state.pairs_body = None;
                }
            }
        };
        // nothing is counted yet, or nothing counted can change
        if !moves || (!state.counts.done && state.counts.up_to.is_none()) {
            let ok = change(&store);
            Self::holder_clear(state);
            let ok = ok?;
            changed(state, ok);
            return Ok(ok);
        }
        let run = |state: &mut State| -> crate::store::Result<bool> {
            let entry = store.get(id)?;
            let p = entry.map(|e| ProblemKey { n: e.n, m: e.m, p: e.p });
            let Some(p) = p.filter(|p| Self::counted(state, p)) else {
                return change(&store);
            };
            let old = store.leaders_of(&[p])?.into_iter().next();
            let ok = change(&store)?;
            if ok {
                let now = store.leaders_of(&[p])?.into_iter().next();
                self.leader_moved(state, &store, &p, old.as_ref(), now.as_ref());
            }
            Ok(ok)
        };
        let result = run(state);
        if result.is_err() {
            // the change may be half done, or a leader unread: count again from the start
            state.counts = HolderCounts::none();
            state.holders_body = None;
        }
        Self::holder_clear(state);
        let ok = result?;
        changed(state, ok);
        Ok(ok)
    }

    /// One page of the first count of /api/holders, in a turn.
    fn count_page(&self) -> Result<(), Thrown> {
        let mut state = self.state();
        let state = &mut *state;
        if state.counts.done {
            return Ok(());
        }
        let store = self.store();
        let page = store.leaders_after(state.counts.up_to, self.holders_chunk)?;
        for e in &page {
            if let Some(share) = self.share_of(e) {
                Self::count_share(state, &share, 1.0);
            }
        }
        match page.last() {
            Some(last) if !((page.len() as f64) < self.holders_chunk) => state.counts.up_to = Some(ProblemKey { n: last.n, m: last.m, p: last.p }),
            _ => {
                state.counts.done = true;
                self.finish_peaks(state, &store);
            }
        }
        Ok(())
    }

    /// app.ts: holdersAnswer.
    fn holders_answer(state: &State) -> Bytes {
        let mut list: Vec<&Holder> = state.counts.by_name.values().collect();
        list.sort_by(|a, b| {
            b.records.partial_cmp(&a.records).unwrap_or(std::cmp::Ordering::Equal).then(b.site_bests.partial_cmp(&a.site_bests).unwrap_or(std::cmp::Ordering::Equal)).then_with(|| js::cmp_utf16(&a.name, &b.name))
        });
        #[derive(Serialize)]
        struct HoldersResponse<'a> {
            holders: Vec<&'a Holder>,
        }
        Bytes::from(to_vec(&HoldersResponse { holders: list }))
    }

    /// GET /api/holders
    async fn holders(self: &Arc<Self>) -> Handled {
        // The first request counts every problem: a page of them in a turn, then other work is
        // let in. Requests that arrive during the build wait for it.
        loop {
            if self.state().counts.done {
                break;
            }
            let _building = self.building.lock().await;
            while !self.state().counts.done {
                let app = self.clone();
                tokio::task::block_in_place(move || app.count_page())?;
                tokio::task::yield_now().await;
            }
        }
        let mut state = self.state();
        if state.holders_body.is_none() {
            state.holders_body = Some(Self::holders_answer(&state));
        }
        let body = state.holders_body.clone().expect("made above");
        Ok(Res::new(200, ResBody::Full(body)).with("content-type", "application/json"))
    }

    // The page of one name: what it leads, by pair of shapes. The problems with an entry of the
    // name are read a page at a time through submissions_name, and the leaders of that page
    // (leaders_of) say which of them the name leads: "has an entry" is not "leads", since a better
    // or an earlier entry of another name may lead, or a near tie. Each page is a turn, like the
    // pages of the first count of /api/holders, and other work is let in between, so that a name
    // with tens of thousands of leads never holds the server for long. A lead is classified by
    // holder_share, as /api/holders does, so the totals are that name's row there.
    //
    // Answers are kept for the HOLDER_CACHE_NAMES names asked most recently, and made at most once
    // at a time per name: a request that arrives while the answer is being made waits for it. A
    // kept answer is given as it is for HOLDER_MAX_AGE_MS, whatever is submitted meanwhile (it
    // says when it was made: `computed_at`), then made again. An administrator's change forgets
    // every answer, those being made included (they are not kept, and no request that comes after
    // the change waits for them), so that a moderation shows at once.

    /// app.ts: holderAnswer.
    async fn holder_answer(self: &Arc<Self>, name: &str, run: &Arc<HolderRun>, began: f64) -> Result<Bytes, Thrown> {
        #[derive(Serialize)]
        struct HolderPair {
            #[serde(rename = "N")]
            n: f64,
            #[serde(rename = "M")]
            m: f64,
            #[serde(rename = "P")]
            p: Vec<f64>,
            records: f64,
            beat_published: f64,
            pending: f64,
        }
        let mut total = Holder::zero(name, 0.0);
        let mut by_pair: IndexMap<String, HolderPair> = IndexMap::new();
        let mut after: Option<ProblemKey> = None;
        let mut done = false;
        while !done {
            // a page, in a turn
            let step = tokio::task::block_in_place(|| -> Result<bool, Thrown> {
                let _state = self.state();
                let store = self.store();
                let page = store.problems_named(name, after, self.holder_chunk)?;
                for e in store.leaders_of(&page)? {
                    let Some(share) = (if e.name == name { self.share_of(&e) } else { None }) else {
                        continue;
                    };
                    let key = format!("{}/{}", fmt::num(e.n), fmt::num(e.m));
                    let pair = by_pair.entry(key).or_insert_with(|| HolderPair { n: e.n, m: e.m, p: Vec::new(), records: 0.0, beat_published: 0.0, pending: 0.0 });
                    // the page is in order of (N, M, P)
                    pair.p.push(e.p);
                    pair.records += share.records;
                    pair.beat_published += share.beat_published;
                    pair.pending += share.pending;
                    total.records += share.records;
                    total.beat_published += share.beat_published;
                    total.pending += share.pending;
                    total.site_bests += share.site_bests;
                }
                match page.last() {
                    Some(last) if !((page.len() as f64) < self.holder_chunk) => {
                        after = Some(*last);
                        Ok(false)
                    }
                    _ => Ok(true),
                }
            })?;
            done = step;
            if !done {
                tokio::task::yield_now().await;
            }
        }
        let mut state = self.state();
        // the peak is the name's in the counts, once they are done (0 while unknown)
        if state.counts.done {
            total.peak = polypack_js::math::max(state.counts.by_name.get(name).map_or(0.0, |h| h.peak), state.peaks.get(name).copied().unwrap_or(0.0));
        }
        let mut pairs: Vec<HolderPair> = by_pair.into_values().collect();
        pairs.sort_by(|a, b| b.p.len().cmp(&a.p.len()).then(a.n.partial_cmp(&b.n).unwrap_or(std::cmp::Ordering::Equal)).then(a.m.partial_cmp(&b.m).unwrap_or(std::cmp::Ordering::Equal)));
        #[derive(Serialize)]
        struct HolderResponse<'a> {
            name: &'a str,
            records: f64,
            beat_published: f64,
            site_bests: f64,
            pending: f64,
            peak: f64,
            computed_at: String,
            pairs: Vec<HolderPair>,
        }
        let body = Bytes::from(to_vec(&HolderResponse {
            name: &total.name,
            records: total.records,
            beat_published: total.beat_published,
            site_bests: total.site_bests,
            pending: total.pending,
            peak: total.peak,
            computed_at: js::to_iso_string(began),
            pairs,
        }));
        if run.keep.load(Ordering::Relaxed) {
            state.holder_kept.shift_remove(name);
            state.holder_kept.insert(name.to_string(), HolderKept { body: body.clone(), at: began });
            while state.holder_kept.len() > HOLDER_CACHE_NAMES {
                state.holder_kept.shift_remove_index(0);
            }
        }
        Ok(body)
    }

    /// app.ts: holderBody.
    async fn holder_body(self: &Arc<Self>, name: &str) -> Result<Bytes, Thrown> {
        let (run, mine, began) = {
            let mut state = self.state();
            let now = self.clock.date_now();
            if let Some(kept) = state.holder_kept.get(name) {
                if now - kept.at < HOLDER_MAX_AGE_MS {
                    // asked just now
                    let kept = state.holder_kept.shift_remove(name).expect("found above");
                    let body = kept.body.clone();
                    state.holder_kept.insert(name.to_string(), kept);
                    return Ok(body);
                }
            }
            match state.holder_runs.get(name) {
                Some(run) => (run.clone(), false, now),
                None => {
                    let run = Arc::new(HolderRun { keep: AtomicBool::new(true), done: tokio::sync::watch::channel(None).0 });
                    state.holder_runs.insert(name.to_string(), run.clone());
                    (run, true, now)
                }
            }
        };
        if !mine {
            let mut rx = run.done.subscribe();
            let seen = rx.wait_for(Option::is_some).await.map_err(|_| Thrown::new("the answer was given up"))?;
            return seen.clone().expect("waited for it").map_err(Thrown::new);
        }
        let result = self.holder_answer(name, &run, began).await;
        {
            let mut state = self.state();
            if state.holder_runs.get(name).is_some_and(|r| Arc::ptr_eq(r, &run)) {
                state.holder_runs.remove(name);
            }
        }
        run.done.send_replace(Some(result.as_ref().map(Bytes::clone).map_err(|e| e.message.clone())));
        result
    }

    /// GET /api/holder
    async fn holder(self: &Arc<Self>, req: &Req) -> Handled {
        // the name is free text: it is a query parameter, not a path segment, since it may contain "/"
        let name = req.query("name").unwrap_or_default();
        if name.is_empty() {
            return Ok(hono::json_error("query parameter name is required", 400));
        }
        if js::utf16_len(&name) > MAX_NAME_LENGTH {
            return Ok(hono::json_error(&format!("a name has at most {MAX_NAME_LENGTH} characters"), 400));
        }
        let body = self.holder_body(&name).await?;
        Ok(Res::new(200, ResBody::Full(body)).with("content-type", "application/json"))
    }

    /// GET /api/atlas
    ///
    /// The drawings of the records page: for each P in [from, to], the one best packing that can
    /// be drawn. Bounded twice: the range by ATLAS_MAX_SPAN and the payload by ATLAS_MAX_PIECES.
    /// Coordinates are long, repetitive numbers, so the answer is compressed for clients that
    /// accept it.
    fn atlas(&self, req: &Req) -> Handled {
        // strict parsing: Number("") is 0, which would silently mean "circle"
        let n = decimal_integer(req.query("N").as_deref());
        let m = decimal_integer(req.query("M").as_deref());
        if !is_shape_code_number(n) || !is_shape_code_number(m) {
            return Ok(hono::json_error("query parameters N and M are required", 400));
        }
        let from_text = req.query("from");
        let to_text = req.query("to");
        let from = if from_text.is_none() { 1.0 } else { decimal_integer(from_text.as_deref()) };
        let to = if to_text.is_none() { polypack_js::math::min(from + ATLAS_MAX_SPAN - 1.0, MAX_PIECES as f64) } else { decimal_integer(to_text.as_deref()) };
        if !js::is_integer(from) || !js::is_integer(to) || from < 1.0 || to > MAX_PIECES as f64 || from > to || to - from >= ATLAS_MAX_SPAN {
            return Ok(hono::json_error(&format!("from and to must be integers with 1 <= from <= to <= {MAX_PIECES}, covering at most {} values of P", fmt::num(ATLAS_MAX_SPAN)), 400));
        }
        let store = self.store();
        // best_per_p lists only entries that are not rejected; the second call also leaves out pending ones
        // entries of closed problems are never drawn: the published packing is
        let in_range = |list: Vec<BestOfP>| -> IndexMap<u64, BestOfP> { list.into_iter().filter(|e| e.p >= from && e.p <= to && !self.literature.closed(n, m, e.p)).map(|e| (e.p.to_bits(), e)).collect() };
        let best = in_range(store.best_per_p(n, m, false)?);
        let awaiting = best.values().any(|e| e.verification == "pending");
        let verified_list = if awaiting { Some(in_range(store.best_per_p(n, m, true)?)) } else { None };
        let verified = verified_list.as_ref().unwrap_or(&best);

        struct Planned<'a> {
            p: f64,
            entry: Option<&'a BestOfP>,
            lit: Option<&'a Value>,
        }
        let mut plan: Vec<Planned> = Vec::new();
        let mut next: Option<f64> = None;
        let mut budget = 0.0;
        let mut p = from;
        while p <= to {
            let lit = self.literature.get(n, m, p);
            let lit_raw = self.literature.raw(n, m, p);
            let lit_pieces = lit_raw.and_then(|r| r.get("pieces")).filter(|v| crate::store::json::truthy(v));
            let top = best.get(&p.to_bits());
            let pending = top.filter(|t| t.verification == "pending");
            let reviewed = verified.get(&p.to_bits());
            if let Some(source) = atlas_source(reviewed.map(|e| e.score), lit, lit_pieces.is_some(), pending.is_some()) {
                let count = if source == AtlasSource::Literature { lit_pieces.and_then(Value::as_array).map_or(f64::NAN, |a| a.len() as f64) } else { p };
                // the first drawing is always sent, so a request always makes progress
                if !plan.is_empty() && budget + count > ATLAS_MAX_PIECES {
                    next = Some(p);
                    break;
                }
                budget += count;
                plan.push(match source {
                    AtlasSource::Literature => Planned { p, entry: None, lit: lit_raw },
                    AtlasSource::Verified => Planned { p, entry: reviewed, lit: lit_raw },
                    AtlasSource::Pending => Planned { p, entry: pending, lit: lit_raw },
                });
            }
            p += 1.0;
        }
        let ids: Vec<f64> = plan.iter().filter_map(|t| t.entry.map(|e| e.id)).collect();
        let mut stored: HashMap<u64, StoredSubmission> = store.get_many(&ids)?.into_iter().map(|s| (s.id.to_bits(), s)).collect();
        drop(store);

        #[derive(Serialize)]
        #[serde(untagged)]
        enum Tile<'a> {
            Site {
                #[serde(rename = "P")]
                p: f64,
                source: &'static str,
                score: f64,
                pieces: crate::store::Pieces,
                container_phi: f64,
                id: f64,
                verification: String,
                found_with: Option<String>,
            },
            Literature {
                #[serde(rename = "P")]
                p: f64,
                source: &'static str,
                score: Option<&'a Value>,
                pieces: &'a Value,
                container_phi: Value,
            },
        }
        let mut tiles: Vec<Tile> = Vec::new();
        for t in &plan {
            let sub = t.entry.and_then(|e| stored.remove(&e.id.to_bits()));
            match sub {
                // a submission rejected or deleted between the two queries is never shown
                Some(sub) if sub.verification != "rejected" && sub.n == n && sub.m == m && sub.p == t.p => {
                    tiles.push(Tile::Site { p: t.p, source: "site", score: sub.score, pieces: sub.pieces, container_phi: sub.container_phi, id: sub.id, verification: sub.verification, found_with: sub.found_with });
                }
                _ => {
                    if let Some(pieces) = t.lit.and_then(|l| l.get("pieces")).filter(|v| crate::store::json::truthy(v)) {
                        let lit = t.lit.expect("it has pieces");
                        tiles.push(Tile::Literature {
                            p: t.p,
                            source: "literature",
                            score: lit.get("value"),
                            pieces,
                            // lit.container_phi ?? 0
                            container_phi: lit.get("container_phi").filter(|v| !v.is_null()).cloned().unwrap_or(json!(0)),
                        });
                    }
                }
            }
        }
        #[derive(Serialize)]
        struct AtlasResponse<'a> {
            #[serde(rename = "N")]
            n: f64,
            #[serde(rename = "M")]
            m: f64,
            from: f64,
            to: f64,
            next: Option<f64>,
            tiles: Vec<Tile<'a>>,
        }
        Ok(hono::json(&AtlasResponse { n, m, from, to, next, tiles }, 200))
    }

    /// GET /api/submissions/:id
    ///
    /// 404 also for an entry deleted when it was overtaken: only the leader of a problem is kept
    /// (see KEEP_PER_PROBLEM).
    fn submission(&self, id: &str) -> Handled {
        let id = js::number(&js::try_decode_uri_component(id));
        let s = if js::is_integer(id) { self.store().get(id)? } else { None };
        let Some(s) = s.filter(|s| s.verification != "rejected") else {
            return Ok(hono::json_error("no such submission", 404));
        };
        // every field but strict_check and literature_value
        #[derive(Serialize)]
        struct Rest<'a> {
            id: f64,
            #[serde(rename = "N")]
            n: f64,
            #[serde(rename = "M")]
            m: f64,
            #[serde(rename = "P")]
            p: f64,
            score: f64,
            name: &'a str,
            agent_note: &'a str,
            pieces: &'a crate::store::Pieces,
            container_phi: f64,
            created_at: &'a str,
            verification: &'a str,
            found_with: &'a Option<String>,
            method: &'a Option<String>,
            method_params: &'a Value,
            seed: Option<f64>,
            budget: &'a Value,
            software: &'a Option<String>,
        }
        Ok(hono::json(
            &Rest {
                id: s.id,
                n: s.n,
                m: s.m,
                p: s.p,
                score: s.score,
                name: &s.name,
                agent_note: &s.agent_note,
                pieces: &s.pieces,
                container_phi: s.container_phi,
                created_at: &s.created_at,
                verification: &s.verification,
                found_with: &s.found_with,
                method: &s.method,
                method_params: &s.method_params,
                seed: s.seed,
                budget: &s.budget,
                software: &s.software,
            },
            200,
        ))
    }

    /// The `answer` of POST /api/submit: the line of the log, and the answer.
    fn answer(&self, sub: &Submission, body: &SubmitResponse<'_>, status: u16, retry_after: Option<f64>, verify_ms: Option<f64>, problem: Option<&str>) -> Res {
        if let Some(stats) = &self.stats {
            stats.lock().unwrap().submission(&SubmissionLine { status, ms: self.clock.performance_now() - sub.started, verify_ms, problem });
        }
        let res = hono::json(body, status);
        match retry_after {
            Some(s) => res.with("retry-after", fmt::num(s)),
            None => res,
        }
    }

    /// The `reject` of POST /api/submit.
    fn reject(&self, sub: &Submission, status: u16, reasons: Vec<String>, retry_after: Option<f64>, verify_ms: Option<f64>, problem: Option<&str>) -> Res {
        let body = SubmitResponse { valid: false, reasons: &reasons, score: None, rank: None, leader: false, leader_score: None, id: None, container: None, pending_verification: false, strict_check: &None };
        self.answer(sub, &body, status, retry_after, verify_ms, problem)
    }

    /// POST /api/submit, up to the body.
    async fn submit(self: &Arc<Self>, req: &mut Req) -> Handled {
        let started = self.clock.performance_now();
        let unknown = Submission { started, submitter: Submitter { key: String::new(), counted: crate::limits::Counted::Address, from: "" } };
        // While verifications wait for a worker, work is queuing: submissions, the costly
        // requests, are refused until the workers catch up.
        if self.overloaded() {
            return Ok(self.reject(&unknown, 503, vec!["the server is busy; try again in a few seconds".to_string()], Some(OVERLOAD_RETRY_S), None, None));
        }
        let address = address_key(&(self.client_ip)(req));
        let Some(submitter) = self.submit_limits.of(&address, req.header(SUBMIT_KEY_HEADER).as_deref()) else {
            return Ok(self.reject(&unknown, 401, vec!["the submit key is not this server's".to_string()], None, None, None));
        };
        let sub = Submission { started, submitter };
        if !self.submit_limits.count_allow(&sub.submitter) {
            return Ok(self.reject(&sub, 429, vec![format!("too many submissions {}; wait a minute", sub.submitter.from)], None, None, None));
        }
        let wait = self.submit_limits.budget_wait(&sub.submitter);
        if wait > 0.0 {
            return Ok(self.reject(&sub, 429, vec![format!("too much verification work {}; wait {} s", sub.submitter.from, fmt::num(wait))], Some(wait), None, None));
        }
        if req.header("content-length").map_or(0.0, |l| js::number(&l)) > MAX_BODY_BYTES as f64 {
            return Ok(self.reject(&sub, 413, vec!["request body too large".to_string()], None, None, None));
        }
        // read no further than the limit: a chunked body has no Content-Length to check first
        let Some(body) = hono::read_body_within(req, MAX_BODY_BYTES).await else {
            return Ok(self.reject(&sub, 413, vec!["request body too large".to_string()], None, None, None));
        };
        // the rest is the work of a core: on a worker
        let app = self.clone();
        match self.pool.run(move || app.submit_body(&sub, &body)).await {
            Ok(handled) => handled,
            Err(message) => Err(Thrown::new(message)),
        }
    }

    /// POST /api/submit, from the body on: on a worker thread.
    fn submit_body(&self, sub: &Submission, body: &[u8]) -> Handled {
        // what the log line says about this submission, filled in as the body is read
        // A body of the plain form is read directly, its pieces without a JSON tree (body.rs); any
        // other body, and every body that will be refused for its pieces, is read as the source reads it.
        let (json, direct_pieces) = match crate::body::read(body) {
            Some(direct) => (Value::Object(direct.object), direct.pieces),
            None => match polypack_js::json::parse(body) {
                Ok(json) => (json, None),
                Err(_) => return Ok(self.reject(sub, 400, vec!["body is not valid JSON".to_string()], None, None, None)),
            },
        };
        let parsed = parse_config(&json).map(|mut config| {
            if let Some(pieces) = direct_pieces {
                config.pieces = pieces;
            }
            config
        });
        // how the packing was found is read from the same body, and its errors are reported alongside
        let methods = method_names();
        let found = json.as_object().map(|o| parse_provenance(o, &methods));
        let (config, provenance, object) = match (parsed, found, json.as_object()) {
            (Ok(config), Some(Ok(provenance)), Some(object)) => (config, provenance, object),
            (parsed, found, _) => {
                let mut reasons = parsed.err().unwrap_or_default();
                if let Some(Err(errors)) = found {
                    reasons.extend(errors);
                }
                return Ok(self.reject(sub, 400, reasons, None, None, None));
            }
        };
        let (n, m, p) = (config.n as f64, config.m as f64, config.p as f64);
        let problem = format!("{}/{}/{}", config.n, config.m, config.p);
        let problem = Some(problem.as_str());
        // Disk pieces and circle containers changed units on 2026-10-27; a body without the
        // confirmation is from a client that may still work in the old ones, which would be scored
        // without error as a valid but poor packing.
        if self.units_gate && planar_affected(n, m) {
            match object.get("units") {
                None => return Ok(self.reject(sub, 426, vec![units_missing_message()], None, None, problem)),
                Some(Value::String(u)) if u == "diameter" => {}
                Some(_) => return Ok(self.reject(sub, 400, vec!["units must be \"diameter\" (the only unit system of this API)".to_string()], None, None, problem)),
            }
        }
        let lit = self.literature.get(n, m, p);
        // decided before the packing is looked at: nothing can improve on a proven optimum
        if let Some(l) = lit.filter(|l| closed_to_submissions(Some(l))) {
            return Ok(self.reject(sub, 409, vec![format!("this problem is closed: its optimum {} is proven ({})", l.display, l.source_name)], None, None, problem));
        }
        let name = sanitize_text(config.name.as_deref().unwrap_or(""), MAX_NAME_LENGTH);
        if name.is_empty() {
            return Ok(self.reject(sub, 400, vec!["name is required".to_string()], None, None, problem));
        }

        // The score is always recomputed here: the smallest container at the container_phi sent (0
        // when none was). The server does not search for a better orientation; clients turn their
        // boards before sending (decided 2026-10-21, see CONVENTIONS.scoring). Any container or
        // score fields in the body were already dropped by parse_config. The time it takes is
        // charged to the address, or to the submit key.
        let verify_start = self.clock.performance_now();
        let result = evaluate(&config, &EvaluateOptions::server(MAX_REPORTED_OVERLAPS));
        let container = if result.valid { result.container } else { None };
        let beats = match (&container, lit) {
            (Some(c), Some(l)) => beats_literature(c.size, l),
            _ => false,
        };
        let strict = match &container {
            Some(c) if beats => Some(strict_verify(config.n, &config.pieces, c, STRICT_EPS)),
            _ => None,
        };
        let verify_ms = self.clock.performance_now() - verify_start;
        self.submit_limits.budget_charge(&sub.submitter, verify_ms);
        let verify_ms = Some(verify_ms);
        let Some(container) = container else {
            return Ok(self.reject(sub, 422, result.reasons, None, verify_ms, problem));
        };
        let score = container.size;
        // the StrictResult as JSON.stringify writes it: { ok, certifiedSize, eps, reason? }
        let strict_value: Option<Value> = strict.as_ref().map(|s| {
            let mut o = Map::new();
            o.insert("ok".to_string(), json!(s.ok));
            o.insert("certifiedSize".to_string(), json!(s.certified_size));
            o.insert("eps".to_string(), json!(s.eps));
            if let Some(reason) = &s.reason {
                o.insert("reason".to_string(), json!(reason));
            }
            Value::Object(o)
        });
        let raw = |key: &str| object.get(key).filter(|v| !v.is_null()).cloned();
        // sanitizeText(software, MAX_SOFTWARE_LENGTH) || null
        let software = provenance.software.as_deref().map(|s| sanitize_text(s, MAX_SOFTWARE_LENGTH)).filter(|s| !s.is_empty());
        let entry = NewSubmission {
            n,
            m,
            p,
            score,
            name: name.clone(),
            agent_note: sanitize_text(config.agent_note.as_deref().unwrap_or(""), MAX_NOTE_LENGTH),
            pieces: config.pieces.iter().map(|q| Pose { x: q.x, y: q.y, theta: q.theta }).collect(),
            container_phi: container.phi,
            created_at: self.clock.iso_now(),
            verification: if beats { "pending" } else { "none" }.to_string(),
            literature_value: if beats { lit.map(|l| l.value) } else { None },
            strict_check: strict_value.clone(),
            // ...provenance: the parsed fields; the two objects as the body gave them
            found_with: provenance.found_with.map(|f| f.as_str().to_string()),
            method: provenance.method.clone(),
            method_params: raw("method_params"),
            seed: provenance.seed,
            budget: raw("budget"),
            software,
        };

        // the insert, the leader and rank it gives, and the prune, in one transaction: a turn
        let problem_key = ProblemKey { n, m, p };
        let mut state_guard = self.state();
        let state = &mut *state_guard;
        let stored = {
            let store = self.store();
            let stored = store.submit(&entry)?;
            // The holders' counts move from the leader before to the leader after, as the
            // transaction read them (a prune does not change the leader). That leader is the
            // entry's, or an earlier one.
            let as_leader = |e: &Option<LeaderboardEntry>| e.as_ref().map(|e| ProblemLeader { n, m, p, id: e.id, name: e.name.clone(), score: e.score, verification: e.verification.clone() });
            self.leader_moved(state, &store, &problem_key, as_leader(&stored.before).as_ref(), as_leader(&stored.leader).as_ref());
            stored
        };
        let (id, leader) = (stored.id, &stored.leader);
        // The leader is the earliest entry among the equally good ones, so an entry that only ties
        // the smallest score is not rank 1 although nothing is strictly ahead of it.
        let leads = leader.as_ref().is_some_and(|l| l.id == id);
        let rank = if leads { 1.0 } else { polypack_js::math::max(2.0, stored.position) };
        // A problem keeps only its leader (and, behind a pending leader, the record it displaced):
        // the entry may already have been deleted (`kept` is false). After the insert and the
        // prune, so that no answer computed in between is kept:
        let pair = format!("{}/{}", config.n, config.m);
        state.records_cache.forget(Some(&pair));
        // the pair has a listed entry now; if the prune deleted this one at once, the leader that stays is in the same pair
        if let Some(sites) = state.site_pairs.as_mut() {
            if sites.insert(pair) {
                state.pairs_body = None;
            }
        }
        if let (true, Some(l), Some(s)) = (beats, lit, &strict) {
            (self.log)(&format!(
                "[review] submission {} by \"{name}\" for N={} M={} P={}: score {} is below the published {} ({}); shrink test {}, certified {}",
                fmt::num(id),
                config.n,
                config.m,
                config.p,
                fmt::num(score),
                fmt::num(l.value),
                l.status.as_str(),
                if s.ok { "passed" } else { "FAILED" },
                fmt::num(s.certified_size)
            ));
        }
        // Viewers hear of a change of leader only. That is nearly always this entry; in a chain of
        // near ties it can be an earlier one that the new smallest score brought within the tolerance.
        if let Some(l) = leader.as_ref().filter(|l| stored.before.as_ref().map(|b| b.id) != Some(l.id)) {
            #[derive(Serialize)]
            struct LeaderboardEvent<'a> {
                #[serde(rename = "N")]
                n: f64,
                #[serde(rename = "M")]
                m: f64,
                #[serde(rename = "P")]
                p: f64,
                id: f64,
                score: f64,
                rank: f64,
                name: &'a str,
            }
            if let Some(stats) = &self.stats {
                stats.lock().unwrap().leader_changed();
            }
            self.announce(n, m, p, &stringify(&LeaderboardEvent { n, m, p, id: l.id, score: l.score, rank: 1.0, name: &l.name }));
        }
        let body = SubmitResponse {
            valid: true,
            reasons: &[],
            score: Some(score),
            rank: Some(rank),
            leader: leads,
            leader_score: leader.as_ref().map(|l| l.score),
            id: if stored.kept { Some(id) } else { None },
            container: Some(ContainerOut { m: container.m as f64, cx: container.cx, cy: container.cy, phi: container.phi, size: container.size }),
            pending_verification: beats,
            strict_check: &strict_value,
        };
        // within the turn, so that the lines of the log are in the order of the entries
        let res = self.answer(sub, &body, 200, None, verify_ms, problem);
        drop(state_guard);
        Ok(res)
    }

    /// app.ts: announce. One write to each stream that follows the problem.
    fn announce(&self, n: f64, m: f64, p: f64, data: &str) {
        // hono/streaming: writeSSE({ event: "leaderboard", data })
        let frame = Bytes::from(format!("event: leaderboard\ndata: {data}\n\n"));
        let follow = self.follow.lock().unwrap();
        for tx in follow.follow_all.values() {
            let _ = tx.send(frame.clone());
        }
        let one = follow.followers.get(&format!("{}/{}/{}", fmt::num(n), fmt::num(m), fmt::num(p)));
        let pair = follow.followers.get(&format!("{}/{}/*", fmt::num(n), fmt::num(m)));
        for tx in one.into_iter().flat_map(IndexMap::values) {
            let _ = tx.send(frame.clone());
        }
        for (id, tx) in pair.into_iter().flatten() {
            if !one.is_some_and(|o| o.contains_key(id)) {
                let _ = tx.send(frame.clone());
            }
        }
    }

    /// GET /api/events
    ///
    /// Live updates: one "leaderboard" event whenever a problem the stream follows gets a new
    /// leader. `keys` lists the problems; without it the stream follows every problem. A client
    /// that follows other problems opens a new stream; an EventSource that reconnects asks for the
    /// same keys.
    fn events(self: &Arc<Self>, req: &Req) -> Res {
        let keys: Option<Vec<String>> = match req.query("keys") {
            None => None,
            Some(text) => match parse_event_keys(&text) {
                Ok(keys) => Some(keys),
                Err(message) => return hono::json_error(&message, 400),
            },
        };
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let own = tx.clone();
        // follow(listener, keys)
        let id = {
            let mut follow = self.follow.lock().unwrap();
            follow.next += 1;
            let id = follow.next;
            match &keys {
                None => {
                    follow.follow_all.insert(id, tx);
                }
                Some(keys) => {
                    for k in keys {
                        follow.followers.entry(k.clone()).or_default().insert(id, tx.clone());
                    }
                }
            }
            id
        };
        if let Some(stats) = &self.stats {
            stats.lock().unwrap().stream(1.0, keys.as_ref().map(Vec::len));
        }
        let hello = match &keys {
            Some(keys) => stringify(&json!({ "keys": keys })),
            None => "{\"all\":true}".to_string(),
        };
        let mut res = Res::new(200, ResBody::Null);
        res.set("transfer-encoding", "chunked");
        res.set("content-type", "text/event-stream");
        res.set("cache-control", "no-cache");
        res.set("connection", "keep-alive");
        if req.method == "HEAD" {
            // The source runs the GET route for a HEAD request and then drops the stream it made
            // without closing it (hono-base.js: `new Response(null, res)`): the route waits for
            // ever to write its greeting, so the stream stays counted and followed until the
            // process ends. The count is kept as the source has it; the events are not queued.
            return res;
        }
        // also when a write fails on a connection that is gone
        let guard = StreamGuard { app: self.clone(), id, keys };
        struct Open {
            rx: tokio::sync::mpsc::UnboundedReceiver<Bytes>,
            /// The stream's own end of its queue: a stream that follows nothing (`?keys=`) stays open too.
            _tx: Listener,
            hello: Option<String>,
            _guard: StreamGuard,
        }
        let stream = futures_util::stream::unfold(Open { rx, _tx: own, hello: Some(hello), _guard: guard }, |mut open| async move {
            if let Some(hello) = open.hello.take() {
                return Some((Ok(Bytes::from(format!("event: hello\ndata: {hello}\n\n"))), open));
            }
            // wake on the next event, or after 20 s to send a keep-alive comment
            match tokio::time::timeout(Duration::from_secs(20), open.rx.recv()).await {
                Ok(Some(frame)) => Some((Ok(frame), open)),
                Ok(None) => None,
                Err(_) => Some((Ok(Bytes::from_static(b"event: ping\ndata: {}\n\n")), open)),
            }
        });
        res.body = ResBody::Stream(Box::pin(stream));
        res
    }

    /// app.ts: admin. None when the request carries the admin token; otherwise the refusal to send.
    fn admin(&self, req: &Req) -> Option<Res> {
        let Some(token) = &self.admin_token else {
            return Some(hono::json_error("admin access is not configured", 503));
        };
        // .replace(/^Bearer\s+/i, "")
        let header = req.header("authorization").unwrap_or_default();
        let given = match header.get(..6) {
            Some(prefix) if prefix.eq_ignore_ascii_case("bearer") && header[6..].starts_with(js::is_whitespace) => header[6..].trim_start_matches(js::is_whitespace),
            _ => header.as_str(),
        };
        if !constant_time_equal(given, token) {
            return Some(hono::json_error("unauthorized", 401));
        }
        None
    }

    /// GET /api/admin/pending
    fn admin_pending(&self, req: &Req) -> Handled {
        if let Some(denied) = self.admin(req) {
            return Ok(denied);
        }
        #[derive(Serialize)]
        struct Pending {
            pending: Vec<StoredSubmission>,
        }
        Ok(hono::json(&Pending { pending: self.store().pending()? }, 200))
    }

    /// `await c.req.json().catch(() => null)`: the body as JSON; None when it is not JSON.
    async fn body_json(req: &mut Req) -> Option<Value> {
        let bytes = hono::read_body(req).await;
        polypack_js::json::parse(&bytes).ok()
    }

    /// `body.id` when `Number.isInteger(body.id)`.
    fn integer_id(body: Option<&Value>) -> Option<f64> {
        match body?.get("id") {
            Some(Value::Number(n)) => n.as_f64().filter(|x| js::is_integer(*x)),
            _ => None,
        }
    }

    /// POST /api/admin/review
    async fn admin_review(self: &Arc<Self>, req: &mut Req) -> Handled {
        if let Some(denied) = self.admin(req) {
            return Ok(denied);
        }
        let body = Self::body_json(req).await;
        let decision = match body.as_ref().and_then(|b| b.get("decision")).and_then(Value::as_str) {
            Some("confirmed") => Some(Decision::Confirmed),
            Some("rejected") => Some(Decision::Rejected),
            _ => None,
        };
        let (Some(id), Some(decision)) = (Self::integer_id(body.as_ref()), decision) else {
            return Ok(hono::json_error("body must be {\"id\": number, \"decision\": \"confirmed\" | \"rejected\"}", 400));
        };
        // a confirmed claim becomes a record and a rejected one is deleted: the problem's leader may change
        // a confirmed entry stays listed; a rejected one is deleted, and its pair may have no entry left
        let ok = tokio::task::block_in_place(|| self.change_entry(id, true, decision == Decision::Rejected, |store| store.review(id, decision)))?;
        if ok {
            (self.log)(&format!("[review] submission {} marked {}", fmt::num(id), if decision == Decision::Confirmed { "confirmed" } else { "rejected" }));
            Ok(hono::json_text("{\"ok\":true}", 200))
        } else {
            Ok(hono::json_error("no such pending submission", 404))
        }
    }

    /// POST /api/admin/remove
    ///
    /// Moderation: unlike a review, this applies to any listed entry, not only to those awaiting one.
    async fn admin_remove(self: &Arc<Self>, req: &mut Req) -> Handled {
        if let Some(denied) = self.admin(req) {
            return Ok(denied);
        }
        let body = Self::body_json(req).await;
        let Some(id) = Self::integer_id(body.as_ref()) else {
            return Ok(hono::json_error("body must be {\"id\": number}", 400));
        };
        let ok = tokio::task::block_in_place(|| self.change_entry(id, true, true, |store| store.remove(id)))?;
        if ok {
            (self.log)(&format!("[review] submission {} removed", fmt::num(id)));
            Ok(hono::json_text("{\"ok\":true}", 200))
        } else {
            Ok(hono::json_error("no such listed submission", 404))
        }
    }

    /// POST /api/admin/edit
    ///
    /// Corrects an entry's name, note or provenance; the packing and its score never change.
    async fn admin_edit(self: &Arc<Self>, req: &mut Req) -> Handled {
        if let Some(denied) = self.admin(req) {
            return Ok(denied);
        }
        let body = Self::body_json(req).await;
        let (Some(id), Some(object)) = (Self::integer_id(body.as_ref()), body.as_ref().and_then(Value::as_object)) else {
            return Ok(hono::json_error("body must be an object with a numeric id", 400));
        };
        let mut errors: Vec<String> = Vec::new();
        let mut changes = EntryEdit::default();
        let mut changed: Vec<&str> = Vec::new();
        if let Some(v) = object.get("name") {
            let name = v.as_str().map_or(String::new(), |s| sanitize_text(s, MAX_NAME_LENGTH));
            if name.is_empty() {
                errors.push("name must be a non-empty string".to_string());
            } else {
                changes.name = Some(name);
                changed.push("name");
            }
        }
        if let Some(v) = object.get("agent_note") {
            match v.as_str() {
                None => errors.push("agent_note must be a string".to_string()),
                Some(s) => {
                    changes.agent_note = Some(sanitize_text(s, MAX_NOTE_LENGTH));
                    changed.push("agent_note");
                }
            }
        }
        let touched = ["found_with", "method", "method_params", "seed", "budget", "software"].iter().any(|k| object.contains_key(*k));
        if touched {
            // all six are replaced together, so found_with must be given rather than default to "hand"
            if !object.contains_key("found_with") {
                errors.push("found_with is required when provenance is changed".to_string());
            } else {
                match parse_provenance(object, &method_names()) {
                    Err(e) => errors.extend(e),
                    Ok(parsed) => {
                        let raw = |key: &str| object.get(key).filter(|v| !v.is_null()).cloned();
                        changes.provenance = Some(Provenance {
                            found_with: parsed.found_with.map(|f| f.as_str().to_string()),
                            method: parsed.method,
                            method_params: raw("method_params"),
                            seed: parsed.seed,
                            budget: raw("budget"),
                            software: parsed.software.and_then(|s| Some(sanitize_text(&s, MAX_SOFTWARE_LENGTH)).filter(|s| !s.is_empty())),
                        });
                        changed.push("provenance");
                    }
                }
            }
        }
        if !errors.is_empty() {
            return Ok(hono::json_error(&errors.join("; "), 400));
        }
        // only a new name can change the holders' counts: the entry stays the problem's leader, or not
        // name, note and provenance only: the entry stays in its pair, so the pairs are not touched
        let ok = tokio::task::block_in_place(|| self.change_entry(id, changes.name.is_some(), false, |store| store.edit(id, &changes)))?;
        if ok {
            (self.log)(&format!("[review] submission {} edited: {}", fmt::num(id), if changed.is_empty() { "nothing".to_string() } else { changed.join(", ") }));
            Ok(hono::json_text("{\"ok\":true}", 200))
        } else {
            Ok(hono::json_error("no such listed submission", 404))
        }
    }

    /// POST /api/admin/holder-peaks
    ///
    /// Peaks known from before they were counted (lists of holders saved earlier): raises each
    /// name's peak, never lowers one, and lists a name that leads nothing at zero. Names are taken
    /// as given, so they must already be in the form a submission stores.
    async fn admin_holder_peaks(self: &Arc<Self>, req: &mut Req) -> Handled {
        if let Some(denied) = self.admin(req) {
            return Ok(denied);
        }
        let body = Self::body_json(req).await;
        let rows = body.as_ref().and_then(|b| b.get("peaks")).and_then(Value::as_array);
        let Some(rows) = rows.filter(|r| !r.is_empty() && r.len() <= MAX_PEAK_ROWS) else {
            return Ok(hono::json_error(&format!("body must be {{\"peaks\": [{{\"name\": string, \"peak\": number}}, ...]}} with 1 to {MAX_PEAK_ROWS} rows"), 400));
        };
        let mut given: IndexMap<String, f64> = IndexMap::new();
        for r in rows {
            let name = r.get("name").and_then(Value::as_str).unwrap_or("");
            let peak = match r.get("peak") {
                Some(Value::Number(n)) => n.as_f64().filter(|x| js::is_integer(*x) && *x >= 1.0),
                _ => None,
            };
            let (false, Some(peak)) = (name.is_empty() || sanitize_text(name, MAX_NAME_LENGTH) != name, peak) else {
                return Ok(hono::json_error(&format!("bad row {}: a name as stored and a positive integer peak", json_stringify(r)), 400));
            };
            let had = given.get(name).copied().unwrap_or(0.0);
            given.insert(name.to_string(), polypack_js::math::max(peak, had));
        }
        let raised = tokio::task::block_in_place(|| -> Result<usize, Thrown> {
            let mut state = self.state();
            let state = &mut *state;
            let up: Vec<HolderPeak> = given.iter().filter(|(name, peak)| **peak > state.peaks.get(*name).copied().unwrap_or(0.0)).map(|(name, peak)| HolderPeak { name: name.clone(), peak: *peak }).collect();
            // stored first: a failure leaves memory as it was, and the request fails
            self.store().raise_holder_peaks(&up)?;
            for r in &up {
                state.peaks.insert(r.name.clone(), r.peak);
                // before the counts are done, finish_peaks lists the name from `peaks`
                if !state.counts.done {
                    continue;
                }
                match state.counts.by_name.get_mut(&r.name) {
                    Some(h) => h.peak = polypack_js::math::max(h.peak, r.peak),
                    None => {
                        state.counts.by_name.insert(r.name.clone(), Holder::zero(&r.name, r.peak));
                    }
                }
            }
            if !up.is_empty() {
                state.holders_body = None;
            }
            Ok(up.len())
        })?;
        (self.log)(&format!("[holders] {raised} of {} peak(s) raised by an administrator", given.len()));
        Ok(hono::json(&json!({ "ok": true, "raised": raised as f64 }), 200))
    }

    /// GET /api/snapshot
    ///
    /// The records snapshot (snapshot.rs): the manifest, built every night, then each file of it,
    /// generated from the database when it is asked for: one gzipped file per shape pair or space.
    fn snapshot_manifest(&self) -> Handled {
        let manifest = match &self.snapshots {
            Some(s) => s.manifest()?,
            None => None,
        };
        let Some(manifest) = manifest else {
            return Ok(hono::json_error(if self.snapshots.is_some() { "no snapshot has been built yet" } else { "this server builds no snapshots" }, 404));
        };
        // c.header("cache-control", "no-cache") comes before the answer's own content type
        let mut res = Res::new(200, ResBody::Full(Bytes::from(crate::store::json::stringify(&manifest))));
        res.set("cache-control", "no-cache");
        res.set("content-type", "application/json");
        Ok(res)
    }

    /// GET /api/snapshot/:file
    async fn snapshot_file(&self, file: &str, req: &Req) -> Handled {
        let name = js::try_decode_uri_component(file);
        let Some(snapshots) = &self.snapshots else {
            return Ok(hono::json_error("no such snapshot file", 404));
        };
        if !snapshots.has(&name)? {
            return Ok(hono::json_error("no such snapshot file", 404));
        }
        let headers = |mut res: Res| {
            res.set("content-type", "application/gzip");
            res.set("content-disposition", format!("attachment; filename=\"{name}\""));
            res.set("cache-control", "public, max-age=300");
            res
        };
        // A HEAD request runs this handler too and drops the body; the file is generated for GET only.
        if req.method == "HEAD" {
            return Ok(headers(Res::new(200, ResBody::Null)));
        }
        let allowed = self.snapshot_limit.lock().unwrap().allow(&address_key(&(self.client_ip)(req)), self.clock.date_now());
        if !allowed {
            let mut res = Res::new(429, ResBody::Full(Bytes::from_static(b"{\"error\":\"too many snapshot files from this address; try again later\"}")));
            res.set("retry-after", "60");
            res.set("content-type", "application/json");
            return Ok(res);
        }
        let Some(generated) = snapshots.generate(&name).await? else {
            return Ok(hono::json_error("no such snapshot file", 404));
        };
        let length = generated.body.len();
        let mut res = headers(Res::new(200, ResBody::Full(generated.body)));
        res.set("content-length", length.to_string());
        // the fingerprint of the leaders written, which can be newer than the manifest's
        res.set("etag", format!("W/\"{}\"", generated.fingerprint));
        res.set("x-snapshot-fingerprint", generated.fingerprint);
        res.set("x-snapshot-records", fmt::num(generated.records));
        Ok(res)
    }
}

fn nonempty(parts: &[&&str]) -> bool {
    parts.iter().all(|p| !p.is_empty())
}

/// What a live stream holds while it is open: closing it (the client went away, or a write
/// failed) takes its listener out and tells the counts, once.
struct StreamGuard {
    app: Arc<App>,
    id: u64,
    keys: Option<Vec<String>>,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        // unfollow(listener, keys)
        {
            let mut follow = self.app.follow.lock().unwrap();
            match &self.keys {
                None => {
                    follow.follow_all.shift_remove(&self.id);
                }
                Some(keys) => {
                    for k in keys {
                        if let Some(set) = follow.followers.get_mut(k) {
                            set.shift_remove(&self.id);
                            if set.is_empty() {
                                follow.followers.remove(k);
                            }
                        }
                    }
                }
            }
        }
        if let Some(stats) = &self.app.stats {
            stats.lock().unwrap().stream(-1.0, self.keys.as_ref().map(Vec::len));
        }
    }
}
