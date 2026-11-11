//! Port of apps/server/src/snapshot.ts.
//!
//! The records snapshot: every open problem's leader with its coordinates, as one gzipped JSON file
//! per shape pair (N, M) and one per space, served at /api/snapshot. A GitHub workflow mirrors it
//! into a release (scripts/mirror-snapshot.ts).
//!
//! Since format 3 (2026-11-07) the server stores no file but a small manifest, because the files, a
//! second copy of every record's coordinates, filled the volume. Once a night it reads the leaders
//! of every pair and space (no entry, no pieces) and writes the manifest: for each file its name,
//! counts and fingerprint. A file is generated from the database when it is asked for, from the
//! leaders at that moment, which may be newer than the manifest's; the response says which in
//! `x-snapshot-fingerprint`.
//!
//! A file depends only on its leaders' (P, id, name, found_with, verification) (a space's, on its
//! (problem, P, id, name)): every other field it holds never changes. So the fingerprint of the
//! leaders tells whether a file has changed, which lets the mirror skip it, and the manifest keeps
//! the `as_of` of a file whose fingerprint is unchanged.
//!
//! The source generates a file on its one thread, a few thousand pieces at a time with the event
//! loop let in between, and compresses in zlib's threads. Here a file is generated on a thread of
//! its own; the store is locked for one chunk of entries at a time, so that requests keep being
//! answered in between. At most `max_concurrent` files are generated at once, the others wait.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use indexmap::IndexMap;
use polypack_js::fmt;
use polypack_js::json::{stringify, stringify_pretty};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::clock::Clock;
use crate::hono::Thrown;
use crate::js;
use crate::spaces::SpacesPort;
use crate::store::sha256::Sha256;
use crate::store::{self, BestOfP, Pieces, SqliteStore, StoredSpaceEntry, StoredSubmission};

/// snapshot.ts: SNAPSHOT_FORMAT.
/// Format 3 (2026-11-07): the files are generated on request and the manifest has no `bytes` and
/// `sha256`. Format 2 (2026-10-27, the unit change): disk and ball pieces have diameter 1 and circle
/// and ball containers are scored by their diameter. The format number is part of every fingerprint
/// and a manifest of another format is not read: the first build after a change describes every
/// file again.
pub const SNAPSHOT_FORMAT: f64 = 3.0;
/// snapshot.ts: SNAPSHOT_UNITS. The length units of the snapshot's coordinates and scores (the
/// manifest's `units`).
pub const SNAPSHOT_UNITS: &str = "diameter";
const MANIFEST: &str = "manifest.json";
/// Entries read at once, at most.
const CHUNK: usize = 25;
/// snapshot.ts: CHUNK_PIECES. Pieces read at once, at most: the entries of a chunk are read and
/// written in one step, so that this bounds the step.
pub const CHUNK_PIECES: f64 = 1000.0;
/// snapshot.ts: MAX_CONCURRENT. Files generated at once by default.
pub const MAX_CONCURRENT: usize = 2;

/// A file generated from the database, gzipped.
#[derive(Clone, Debug)]
pub struct GeneratedFile {
    pub body: Bytes,
    /// The fingerprint of the records written, which can differ from the manifest's if they changed since.
    pub fingerprint: String,
    pub records: f64,
    pub pieces: f64,
}

/// snapshot.ts: fileName.
pub fn file_name(n: f64, m: f64) -> String {
    format!("{}-{}.json.gz", fmt::num(n), fmt::num(m))
}
/// snapshot.ts: spaceFileName.
pub fn space_file_name(space: &str) -> String {
    format!("space-{space}.json.gz")
}

/// A failure of the file system with the text Node gives it: "ENOENT: no such file or directory,
/// open '/path'". The source logs `e.message` of such an error.
fn node_fs_error(e: &std::io::Error, syscall: &str, path: &str) -> String {
    use std::io::ErrorKind as K;
    let (code, text) = match e.kind() {
        K::NotFound => ("ENOENT", "no such file or directory"),
        K::AlreadyExists => ("EEXIST", "file already exists"),
        K::PermissionDenied => ("EACCES", "permission denied"),
        K::NotADirectory => ("ENOTDIR", "not a directory"),
        K::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        K::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        K::ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        K::StorageFull => ("ENOSPC", "no space left on device"),
        _ => return format!("{e}, {syscall} '{path}'"),
    };
    format!("{code}: {text}, {syscall} '{path}'")
}

/// snapshot.ts: readManifest. The manifest of `dir` as JSON, when it is one of this format.
pub fn read_manifest(dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
    let m = store::json::parse(&text).ok()?;
    // a value that is not an object has none of the fields (and `null.format` throws: caught)
    let o = m.as_object()?;
    let ok = o.get("format").and_then(Value::as_f64) == Some(SNAPSHOT_FORMAT)
        && o.get("format").is_some_and(Value::is_number)
        && o.get("units").and_then(Value::as_str) == Some(SNAPSHOT_UNITS)
        && o.get("files").is_some_and(Value::is_array)
        && o.get("spaces").is_none_or(Value::is_array);
    ok.then_some(m)
}

/// snapshot.ts: isComplete. Whether the manifest describes a finished build, rather than one that
/// is under way or was cut short. (`!!m?.completed_at && m.completed_at === m.generated_at`.)
pub fn is_complete(m: Option<&Value>) -> bool {
    let Some(m) = m else {
        return false;
    };
    let completed = m.get("completed_at");
    let truthy = match completed {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(_) => true,
    };
    // strict equality: two strings, numbers or booleans of the same value (an object is never equal to another)
    truthy && matches!(completed, Some(Value::String(_) | Value::Number(_) | Value::Bool(_))) && completed == m.get("generated_at")
}

/// snapshot.ts: writeManifest.
fn write_manifest(dir: &Path, m: &Value) -> Result<(), String> {
    let tmp = dir.join(format!(".{MANIFEST}.tmp"));
    let path = dir.join(MANIFEST);
    std::fs::write(&tmp, stringify_pretty(m, 1) + "\n").map_err(|e| node_fs_error(&e, "open", &tmp.to_string_lossy()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{} -> '{}'", node_fs_error(&e, "rename", &tmp.to_string_lossy()), path.to_string_lossy()))
}

/// `[p.x, p.y, p.theta]` of each piece of a stored entry. A row written since 2026-10-18 holds
/// poses. An older row can hold any JSON (see `Pieces`): the source then reads `x`, `y`, `theta` of
/// whatever each element is, and throws where there is nothing to read them of.
fn piece_triples(pieces: &Pieces) -> Result<Value, Thrown> {
    match pieces {
        Pieces::Poses(list) => Ok(Value::Array(list.iter().map(|p| json!([p.x, p.y, p.theta])).collect())),
        Pieces::Json(Value::Array(list)) => {
            let mut out = Vec::with_capacity(list.len());
            for p in list {
                let field = |k: &str| match p {
                    Value::Object(o) => o.get(k).cloned().unwrap_or(Value::Null),
                    _ => Value::Null,
                };
                if p.is_null() {
                    return Err(Thrown::new("TypeError: Cannot read properties of null (reading 'x')"));
                }
                out.push(Value::Array(vec![field("x"), field("y"), field("theta")]));
            }
            Ok(Value::Array(out))
        }
        Pieces::Json(_) => Err(Thrown::new("TypeError: s.pieces.map is not a function")),
    }
}

/// snapshot.ts: recordLine. The line of one record in a pair's file: pieces as [x, y, theta],
/// every number at full precision.
fn record_line(s: &StoredSubmission) -> Result<String, Thrown> {
    #[derive(Serialize)]
    struct Line<'a> {
        #[serde(rename = "P")]
        p: f64,
        score: f64,
        id: f64,
        name: &'a str,
        found_with: &'a Option<String>,
        verification: &'a str,
        created_at: &'a str,
        container_phi: f64,
        pieces: Value,
    }
    Ok(stringify(&Line {
        p: s.p,
        score: s.score,
        id: s.id,
        name: &s.name,
        found_with: &s.found_with,
        verification: &s.verification,
        created_at: &s.created_at,
        container_phi: s.container_phi,
        pieces: piece_triples(&s.pieces)?,
    }))
}

/// snapshot.ts: fingerprint. Hash of the fields of a pair's records that can change; the others
/// never do. Each record is (P, id, name, found_with, verification).
fn fingerprint<'a>(records: impl Iterator<Item = (f64, f64, &'a str, &'a Option<String>, &'a str)>) -> String {
    let mut h = Sha256::new();
    h.update(format!("format {}\n", fmt::num(SNAPSHOT_FORMAT)).as_bytes());
    for (p, id, name, found_with, verification) in records {
        h.update(stringify(&json!([p, id, name, found_with, verification])).as_bytes());
        h.update(b"\n");
    }
    h.hex()
}

/// snapshot.ts: SPACE_RECORD_FIELDS. The fields of a record in a space's file, in their order.
/// They are part of the files' fingerprint, so that a change of them describes every space's file
/// anew.
pub const SPACE_RECORD_FIELDS: [&str; 9] = ["problem", "P", "score", "id", "name", "software", "method", "created_at", "config"];

/// snapshot.ts: spaceRecordLine. The line of one record in a space's file. The configuration is
/// the server's own JSON text (the submission format of its space, as JSON.stringify wrote it),
/// spliced in as stored, as GET /api/spaces/entries/{id} does: every number at full precision,
/// without parsing it again.
fn space_record_line(e: &StoredSpaceEntry, p: f64) -> String {
    #[derive(Serialize)]
    struct Head<'a> {
        problem: &'a str,
        #[serde(rename = "P")]
        p: f64,
        score: f64,
        id: f64,
        name: &'a str,
        software: &'a Option<String>,
        method: &'a Option<String>,
        created_at: &'a str,
    }
    let head = stringify(&Head { problem: &e.problem, p, score: e.score, id: e.id, name: &e.name, software: &e.software, method: &e.method, created_at: &e.created_at });
    format!("{},\"config\":{}}}", &head[..head.len() - 1], e.config)
}

/// snapshot.ts: SpaceSnapshotLeader. A space problem's leader, with its piece count and its place
/// in the space's catalogue.
#[derive(Clone, Debug)]
struct SpaceSnapshotLeader {
    id: f64,
    problem: String,
    name: String,
    p: f64,
    order: f64,
}

/// snapshot.ts: spaceFingerprint. Hash of the fields of a space's records that can change (the
/// name); the others never do.
fn space_fingerprint(records: &[SpaceSnapshotLeader]) -> String {
    let mut h = Sha256::new();
    h.update(format!("space format {} {}\n", fmt::num(SNAPSHOT_FORMAT), SPACE_RECORD_FIELDS.join(",")).as_bytes());
    for r in records {
        h.update(stringify(&json!([r.problem, r.p, r.id, r.name])).as_bytes());
        h.update(b"\n");
    }
    h.hex()
}

/// snapshot.ts: SnapshotSpaces, as snapshotSpaces(index, store) makes it. The spaces' entries by
/// their catalogues and domains: open problems only, as the listings show them, in catalogue order
/// (domain problems without a record after the records, by P).
#[derive(Clone)]
pub struct SnapshotSpaces {
    port: Arc<dyn SpacesPort>,
}

impl SnapshotSpaces {
    /// snapshot.ts: snapshotSpaces.
    pub fn new(port: Arc<dyn SpacesPort>) -> SnapshotSpaces {
        SnapshotSpaces { port }
    }

    /// The spaces, in the order the manifest lists them: `SPACE_NAMES.filter((s) => index[s])`.
    pub fn names(&self) -> Vec<String> {
        self.port.space_names().into_iter().filter(|s| self.port.has_catalogue(s)).collect()
    }

    /// An open problem's piece count and place in its space's catalogue; None for a closed or
    /// unlisted one, whose entry is left out.
    fn place(&self, space: &str, problem: &str) -> Option<(f64, f64)> {
        if !self.port.is_space_name(space) || !self.port.has_catalogue(space) {
            return None;
        }
        if let Some((at, listed)) = self.port.listed(space, problem) {
            return listed.accepts_submissions.then_some((listed.p, at as f64));
        }
        // a problem of the space's domain without a record: after the records, by its piece count
        let p = self.port.problem_of(space, problem)?;
        p.accepts_submissions.then_some((p.p, self.port.catalogue_len(space) as f64 + p.p))
    }
}

/// Problems whose published optimum is proven: their site entries are left out, as on the records page.
pub type ClosedFn = Arc<dyn Fn(f64, f64, f64) -> bool + Send + Sync>;
pub type StoreHandle = Arc<Mutex<SqliteStore>>;

/// snapshot.ts: pairLeaders. The current leaders of a pair's open problems, by P (closed problems
/// left out).
fn pair_leaders(store: &SqliteStore, n: f64, m: f64, closed: &ClosedFn) -> Result<Vec<BestOfP>, Thrown> {
    Ok(store.best_per_p(n, m, false)?.into_iter().filter(|e| !closed(n, m, e.p)).collect())
}

/// snapshot.ts: spaceLeaders. The current leaders of a space's open problems with an entry, in
/// catalogue order.
fn space_leaders(store: &SqliteStore, spaces: &SnapshotSpaces, space: &str) -> Result<Vec<SpaceSnapshotLeader>, Thrown> {
    let mut list: Vec<SpaceSnapshotLeader> = store
        .space_best(space)?
        .into_iter()
        .filter_map(|l| {
            let (p, order) = spaces.place(space, &l.problem)?;
            Some(SpaceSnapshotLeader { id: l.id, problem: l.problem, name: l.name, p, order })
        })
        .collect();
    // .sort((a, b) => a.order - b.order): stable
    list.sort_by(|a, b| a.order.partial_cmp(&b.order).unwrap_or(std::cmp::Ordering::Equal));
    Ok(list)
}

/// snapshot.ts: chunked. The leaders in runs of at most CHUNK entries and about CHUNK_PIECES
/// pieces, each read and written in one step.
fn chunked<T>(leaders: &[T], p_of: impl Fn(&T) -> f64) -> Vec<&[T]> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < leaders.len() {
        let mut j = i;
        let mut pieces = 0.0;
        while j < leaders.len() && j - i < CHUNK && pieces < CHUNK_PIECES {
            pieces += p_of(&leaders[j]);
            j += 1;
        }
        out.push(&leaders[i..j]);
        i = j;
    }
    out
}

/// snapshot.ts: gzipText, as a writer: zlib's gzip at level 6, in memory, so that the answer can
/// say what it holds before its body.
struct Gzip(flate2::write::GzEncoder<Vec<u8>>);

impl Gzip {
    fn new() -> Gzip {
        Gzip(crate::hono::gzip_writer(Vec::new(), flate2::Compression::new(6)))
    }
    fn write(&mut self, text: &str) {
        self.0.write_all(text.as_bytes()).expect("writing to memory");
    }
    fn finish(self) -> Bytes {
        Bytes::from(self.0.finish().expect("writing to memory"))
    }
}

/// snapshot.ts: generatePair. The file of a pair as the database holds its records now. The
/// leaders are read first and their entries a chunk at a time, with other work let in after each;
/// the fingerprint is of what is written, which may differ from the leaders read if entries
/// changed meanwhile.
pub fn generate_pair(store: &StoreHandle, n: f64, m: f64, closed: &ClosedFn) -> Result<GeneratedFile, Thrown> {
    let leaders = pair_leaders(&store.lock().unwrap(), n, m, closed)?;
    let mut written: Vec<StoredSubmission> = Vec::new();
    let mut gz = Gzip::new();
    gz.write(&format!("{{\"format\":{},\"N\":{},\"M\":{},\"records\":[", fmt::num(SNAPSHOT_FORMAT), fmt::num(n), fmt::num(m)));
    for part in chunked(&leaders, |l| l.p) {
        let mut lines = String::new();
        {
            let store = store.lock().unwrap();
            let ids: Vec<f64> = part.iter().map(|l| l.id).collect();
            let mut by_id: HashMap<u64, StoredSubmission> = store.get_many(&ids)?.into_iter().map(|s| (s.id.to_bits(), s)).collect();
            for l in part {
                // an entry overtaken since the leaders were read has been deleted: its problem's new leader is taken instead
                let mut s = by_id.remove(&l.id.to_bits());
                if s.is_none() {
                    if let Some(current) = store.leader(n, m, l.p)? {
                        s = store.get(current.id)?;
                    }
                }
                let Some(s) = s else {
                    continue;
                };
                lines.push_str(if written.is_empty() { "\n" } else { ",\n" });
                lines.push_str(&record_line(&s)?);
                written.push(s);
            }
        }
        if !lines.is_empty() {
            gz.write(&lines);
        }
    }
    gz.write("\n]}\n");
    Ok(GeneratedFile {
        body: gz.finish(),
        fingerprint: fingerprint(written.iter().map(|s| (s.p, s.id, s.name.as_str(), &s.found_with, s.verification.as_str()))),
        records: written.len() as f64,
        pieces: written.iter().map(|s| s.p).sum(),
    })
}

/// snapshot.ts: generateSpace. The file of a space as the database holds its entries now, by the
/// same rules as generatePair.
pub fn generate_space(store: &StoreHandle, spaces: &SnapshotSpaces, space: &str) -> Result<GeneratedFile, Thrown> {
    let leaders = space_leaders(&store.lock().unwrap(), spaces, space)?;
    let mut written: Vec<SpaceSnapshotLeader> = Vec::new();
    let mut gz = Gzip::new();
    gz.write(&format!("{{\"format\":{},\"space\":{},\"records\":[", fmt::num(SNAPSHOT_FORMAT), stringify(space)));
    for part in chunked(&leaders, |l| l.p) {
        let mut lines = String::new();
        {
            let store = store.lock().unwrap();
            for l in part {
                let mut e = store.space_get(l.id)?;
                if e.is_none() {
                    if let Some(current) = store.space_leader(space, &l.problem)? {
                        e = store.space_get(current.id)?;
                    }
                }
                let Some(e) = e else {
                    continue;
                };
                lines.push_str(if written.is_empty() { "\n" } else { ",\n" });
                lines.push_str(&space_record_line(&e, l.p));
                written.push(SpaceSnapshotLeader { id: e.id, name: e.name, ..l.clone() });
            }
        }
        if !lines.is_empty() {
            gz.write(&lines);
        }
    }
    gz.write("\n]}\n");
    Ok(GeneratedFile { body: gz.finish(), fingerprint: space_fingerprint(&written), records: written.len() as f64, pieces: written.iter().map(|l| l.p).sum() })
}

/// snapshot.ts: SourceOptions.
pub struct SourceOptions {
    /// Where the build writes the manifest.
    pub dir: PathBuf,
    pub store: StoreHandle,
    pub closed: ClosedFn,
    /// The spaces' site entries; without them the space files of the manifest are not served.
    pub spaces: Option<SnapshotSpaces>,
    /// Files generated at once, the others waiting in order of arrival; MAX_CONCURRENT by default.
    pub max_concurrent: Option<usize>,
}

struct Cached {
    key: String,
    manifest: Option<Value>,
    by_name: HashMap<String, Value>,
}

/// snapshot.ts: SnapshotSource, as snapshotSource(opts) makes it. Serves the manifest in `dir`,
/// and generates the files it lists from the database.
pub struct SnapshotSource {
    dir: PathBuf,
    store: StoreHandle,
    closed: ClosedFn,
    spaces: Option<SnapshotSpaces>,
    /// limits.ts: Gate. At most this many files are generated at once; the others wait and start
    /// in order of arrival.
    gate: Arc<tokio::sync::Semaphore>,
    // The manifest is read again only when its file was replaced: it can list thousands of files.
    cache: Mutex<Option<Arc<Cached>>>,
}

impl SnapshotSource {
    /// snapshot.ts: snapshotSource.
    pub fn new(opts: SourceOptions) -> SnapshotSource {
        SnapshotSource {
            dir: opts.dir,
            store: opts.store,
            closed: opts.closed,
            spaces: opts.spaces,
            gate: Arc::new(tokio::sync::Semaphore::new(opts.max_concurrent.unwrap_or(MAX_CONCURRENT))),
            cache: Mutex::new(None),
        }
    }

    fn current(&self) -> Result<Option<Arc<Cached>>, Thrown> {
        let mut cache = self.cache.lock().unwrap();
        let key = match std::fs::metadata(self.dir.join(MANIFEST)) {
            Ok(st) => {
                use std::os::unix::fs::MetadataExt;
                format!("{}:{}:{}.{}", st.ino(), st.size(), st.mtime(), st.mtime_nsec())
            }
            Err(_) => {
                *cache = None;
                return Ok(None);
            }
        };
        if let Some(c) = cache.as_ref() {
            if c.key == key {
                return Ok(Some(c.clone()));
            }
        }
        let manifest = read_manifest(&self.dir);
        let mut by_name: HashMap<String, Value> = HashMap::new();
        if let Some(m) = &manifest {
            let lists = [m.get("files"), m.get("spaces")];
            for f in lists.into_iter().flatten().filter_map(Value::as_array).flatten() {
                // [f.file, f]: only a name that is a string can be asked for
                if f.is_null() {
                    *cache = None;
                    return Err(Thrown::new("TypeError: Cannot read properties of null (reading 'file')"));
                }
                if let Some(name) = f.get("file").and_then(Value::as_str) {
                    by_name.insert(name.to_string(), f.clone());
                }
            }
        }
        let fresh = Arc::new(Cached { key, manifest, by_name });
        *cache = Some(fresh.clone());
        Ok(Some(fresh))
    }

    /// The manifest, or None when there is none of this format.
    pub fn manifest(&self) -> Result<Option<Value>, Thrown> {
        Ok(self.current()?.and_then(|c| c.manifest.clone()))
    }

    /// Whether the current manifest lists the file.
    pub fn has(&self, name: &str) -> Result<bool, Thrown> {
        Ok(self.current()?.is_some_and(|c| c.by_name.contains_key(name)))
    }

    /// The file as the database holds its records now; None for a name the manifest does not list.
    pub async fn generate(&self, name: &str) -> Result<Option<GeneratedFile>, Thrown> {
        let Some(entry) = self.current()?.and_then(|c| c.by_name.get(name).cloned()) else {
            return Ok(None);
        };
        let store = self.store.clone();
        // "space" in entry (an entry that is not an object has no name to be found by, but is an
        // error here in the source too)
        let job: Box<dyn FnOnce() -> Result<GeneratedFile, Thrown> + Send> = match &entry {
            Value::Object(o) if o.contains_key("space") => {
                let Some(spaces) = self.spaces.clone() else {
                    return Ok(None);
                };
                // a space that is not a text names no entries
                let space = match o.get("space") {
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => store::json::stringify(other),
                    None => String::new(),
                };
                Box::new(move || generate_space(&store, &spaces, &space))
            }
            Value::Object(o) => {
                let (Some(n), Some(m)) = (o.get("N").and_then(Value::as_f64), o.get("M").and_then(Value::as_f64)) else {
                    return Err(Thrown::new("the manifest's entry has no N and M"));
                };
                let closed = self.closed.clone();
                Box::new(move || generate_pair(&store, n, m, &closed))
            }
            _ => return Err(Thrown::new("TypeError: Cannot use 'in' operator to search for 'space'")),
        };
        let _turn = self.gate.acquire().await.expect("the gate is never closed");
        tokio::task::spawn_blocking(job).await.map_err(|e| Thrown::new(format!("generating {name} failed: {e}")))?.map(Some)
    }
}

/// snapshot.ts: CleanResult.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CleanResult {
    pub files: f64,
    pub bytes: f64,
}

/// snapshot.ts: cleanSnapshotDir. Deletes every data file in `dir` (`*.json.gz` and `*.tmp`),
/// keeping the manifest: since format 3 the server stores no file but that.
pub fn clean_snapshot_dir(dir: &Path, log: &dyn Fn(&str)) -> CleanResult {
    let mut done = CleanResult::default();
    // no directory yet: nothing to clean
    let names: Vec<std::ffi::OsString> = std::fs::read_dir(dir)
        .map(|entries| entries.filter_map(|e| e.ok().map(|e| e.file_name())).filter(|n| n.to_string_lossy().ends_with(".json.gz") || n.to_string_lossy().ends_with(".tmp")).collect())
        .unwrap_or_default();
    for name in names {
        let path = dir.join(&name);
        // gone already, or not removable: the next clean-up tries again
        let Ok(st) = std::fs::metadata(&path) else {
            continue;
        };
        if !st.is_file() {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            // rm(path, { force: true }): a file that is gone is no failure
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        done.files += 1.0;
        done.bytes += st.len() as f64;
    }
    log(&format!("[snapshot] {} stored file(s) removed, {} bytes freed", fmt::num(done.files), fmt::num(done.bytes)));
    done
}

/// snapshot.ts: BuildOptions.
#[derive(Clone)]
pub struct BuildOptions {
    pub store: StoreHandle,
    pub dir: PathBuf,
    pub closed: ClosedFn,
    /// The spaces' site entries, one file per space after the pairs; without it the snapshot holds the pairs only.
    pub spaces: Option<SnapshotSpaces>,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    /// `now`: the clock whose time the manifest states.
    pub clock: Clock,
}

/// snapshot.ts: BuildResult.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BuildResult {
    /// Files new or whose fingerprint changed (their `as_of` is now).
    pub changed: f64,
    /// Files whose fingerprint is unchanged: their entry, `as_of` included, is kept.
    pub kept: f64,
    /// Files of the previous manifest that have no leaders any more.
    pub dropped: f64,
    /// The stored files deleted at the end.
    pub cleaned: CleanResult,
}

/// `files.reduce((n, f) => n + f[key], 0)` over entries that are JSON.
fn sum_of(files: &[Value], key: &str) -> Value {
    let total: f64 = files.iter().map(|f| f.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)).sum();
    serde_json::Number::from_f64(total).map_or(Value::Null, Value::Number)
}

/// snapshot.ts: buildSnapshot. Builds or refreshes the manifest in `dir`: for each pair and space
/// with open leaders, its counts and the fingerprint of its leaders, read from the leaders alone
/// (no entry, no pieces). The manifest is marked complete at the end, when its `generated_at` is
/// made equal to `completed_at`; until then it carries the previous `completed_at`, so that the
/// mirror waits. Stored files are deleted afterwards. `Err` holds the message of what the source
/// throws.
pub fn build_snapshot(opts: &BuildOptions) -> Result<BuildResult, String> {
    let dir = &opts.dir;
    let now = || opts.clock.iso_now();
    std::fs::create_dir_all(dir).map_err(|e| node_fs_error(&e, "mkdir", &dir.to_string_lossy()))?;

    let before = read_manifest(dir);
    // from here until the end the manifest says that a build is under way
    if let Some(Value::Object(b)) = &before {
        let mut under_way: Map<String, Value> = b.clone();
        under_way.insert("generated_at".to_string(), Value::String(now()));
        write_manifest(dir, &Value::Object(under_way))?;
    }
    // new Map([...files, ...spaces].map((f) => [f.file, f])): by name; an entry whose name is not
    // a text can be found by none, and counts once among the dropped
    let mut previous: IndexMap<String, Value> = IndexMap::new();
    let mut unnamed: Vec<String> = Vec::new();
    if let Some(b) = &before {
        for f in [b.get("files"), b.get("spaces")].into_iter().flatten().filter_map(Value::as_array).flatten() {
            if f.is_null() {
                return Err("Cannot read properties of null (reading 'file')".to_string());
            }
            match f.get("file") {
                Some(Value::String(name)) => {
                    previous.insert(name.clone(), f.clone());
                }
                other => {
                    let key = other.map_or("undefined".to_string(), store::json::stringify);
                    if !unnamed.contains(&key) {
                        unnamed.push(key);
                    }
                }
            }
        }
    }

    let thrown = |t: Thrown| t.message;
    let mut files: Vec<Value> = Vec::new();
    let mut space_files: Vec<Value> = Vec::new();
    let mut listed: Vec<String> = Vec::new();
    let mut changed = 0.0;
    let mut kept = 0.0;
    let pairs = opts.store.lock().unwrap().pairs().map_err(|e| thrown(e.into()))?;
    for pair in pairs {
        let (n, m) = (pair.n, pair.m);
        // the store is free between two pairs, as the event loop is let in between them in the source
        let leaders = pair_leaders(&opts.store.lock().unwrap(), n, m, &opts.closed).map_err(thrown)?;
        if leaders.is_empty() {
            continue;
        }
        let file = file_name(n, m);
        listed.push(file.clone());
        let print = fingerprint(leaders.iter().map(|l| (l.p, l.id, l.name.as_str(), &l.found_with, l.verification.as_str())));
        match previous.get(&file) {
            Some(old) if old.get("fingerprint").and_then(Value::as_str) == Some(print.as_str()) => {
                files.push(old.clone());
                kept += 1.0;
            }
            _ => {
                files.push(json!({ "N": n, "M": m, "file": file, "records": leaders.len() as f64, "pieces": leaders.iter().map(|l| l.p).sum::<f64>(), "as_of": now(), "fingerprint": print }));
                changed += 1.0;
            }
        }
    }
    let names = opts.spaces.as_ref().map(SnapshotSpaces::names).unwrap_or_default();
    for space in names {
        let spaces = opts.spaces.as_ref().expect("names come from the spaces");
        let leaders = space_leaders(&opts.store.lock().unwrap(), spaces, &space).map_err(thrown)?;
        if leaders.is_empty() {
            continue;
        }
        let file = space_file_name(&space);
        listed.push(file.clone());
        let print = space_fingerprint(&leaders);
        match previous.get(&file) {
            Some(old) if old.get("fingerprint").and_then(Value::as_str) == Some(print.as_str()) => {
                space_files.push(old.clone());
                kept += 1.0;
            }
            _ => {
                space_files.push(json!({ "space": space, "file": file, "records": leaders.len() as f64, "pieces": leaders.iter().map(|l| l.p).sum::<f64>(), "as_of": now(), "fingerprint": print }));
                changed += 1.0;
            }
        }
    }

    let at = now();
    let manifest = json!({
        "format": SNAPSHOT_FORMAT,
        "units": SNAPSHOT_UNITS,
        "generated_at": at,
        "completed_at": at,
        "records": sum_of(&files, "records"),
        "pieces": sum_of(&files, "pieces"),
        "files": files,
        "spaces": space_files,
    });
    write_manifest(dir, &manifest)?;
    let dropped = previous.keys().filter(|f| !listed.contains(f)).count() as f64 + unnamed.len() as f64;
    let cleaned = clean_snapshot_dir(dir, &*opts.log);
    (opts.log)(&format!("[snapshot] {} file(s) changed, {} unchanged, {} dropped", fmt::num(changed), fmt::num(kept), fmt::num(dropped)));
    Ok(BuildResult { changed, kept, dropped, cleaned })
}

/// snapshot.ts: ScheduleOptions.
#[derive(Clone)]
pub struct ScheduleOptions {
    pub build: BuildOptions,
    /// Hour of the day (UTC) at which the nightly build starts.
    pub hour_utc: f64,
    /// Delay of the build at startup, when the snapshot is missing, unfinished (a restart cut the
    /// last build short), more than a day old, or without the spaces' files that `spaces` asks for;
    /// 5 minutes by default.
    pub start_delay_ms: Option<f64>,
}

/// snapshot.ts: scheduleSnapshots. Deletes the stored files at once, then builds once a day at
/// `hour_utc`, and soon after startup when the snapshot needs it. The task runs until the process
/// ends; a wait is in real time, for as long as the server's clock is short of the hour.
pub fn schedule_snapshots(opts: ScheduleOptions) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let clock = opts.build.clock.clone();
        // frees the volume now; a build waits for it, so that it does not meet files being deleted
        {
            let o = opts.build.clone();
            let _ = tokio::task::spawn_blocking(move || clean_snapshot_dir(&o.dir, &*o.log)).await;
        }
        // the time until the next `hour_utc`, by the server's clock
        let until_hour = || -> f64 {
            let t = clock.date_now();
            let f = js::date_fields(t);
            let mut at = js::date_utc(f.year, f.month, f.day, 0) + opts.hour_utc * 3_600_000.0;
            if at <= t {
                at += 86_400_000.0;
            }
            at - t
        };
        let m = read_manifest(&opts.build.dir);
        let completed = m.as_ref().and_then(|m| m.get("completed_at")).and_then(Value::as_str).map_or(f64::NAN, js::date_parse);
        let fresh = is_complete(m.as_ref()) && clock.date_now() - completed < 25.0 * 3_600_000.0;
        let mut wait = if fresh { until_hour() } else { opts.start_delay_ms.unwrap_or(5.0 * 60_000.0) };
        loop {
            tokio::time::sleep(Duration::from_secs_f64(wait.max(0.0) / 1000.0)).await;
            let o = opts.build.clone();
            let built = tokio::task::spawn_blocking(move || build_snapshot(&o)).await;
            match built {
                Ok(Ok(_)) => {}
                Ok(Err(message)) => (opts.build.log)(&format!("[snapshot] build failed: {message}")),
                Err(e) => (opts.build.log)(&format!("[snapshot] build failed: {e}")),
            }
            wait = until_hour();
        }
    })
}
