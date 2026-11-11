//! Reads data/<space>/records.json into the compact catalogues. Port of
//! packages/spaces/src/load.ts (the source's Node-only entry).
//!
//! A space that keeps its configurations apart (polyhedra: data/polyhedra/configs/<code>.jsonl, one
//! file per problem and one line per P) is loaded without them: each entry keeps the byte offset
//! and length of its line (`config_at`), and the catalogue gets a loader that reads that one line
//! when a configuration is asked for, checks it as the catalogue checks the others, and keeps the
//! last ones read up to CONFIG_CACHE_BYTES. At most CONFIG_READS_AT_ONCE reads run at once, and
//! reads of the same configuration at the same time share one. A failed read is never kept.
//!
//! The source's loader is asynchronous (promises on one thread); this one is called from many
//! threads and blocks the caller while the file is read. What it serves, what it logs and what it
//! keeps are the source's: the cache and its order (least recently used first), the limit on reads
//! at once (waiting callers are served in the order they came), the one read shared by callers
//! that ask for the same entry at the same time, and one log line per problem that is left out.
//!
//! Two texts are not the source's, because they are the JavaScript engine's own: the message of a
//! JSON syntax error (`JSON.parse`), which follows "not JSON: " and "records not loaded: ", is
//! serde_json's; and the message of a file error is written as Node writes the common ones
//! ("ENOENT: no such file or directory, open '<path>'") and as Rust writes any other.

use crate::domain::space_domain;
use crate::ids::parse_space_id;
use crate::records::{build_space_catalogue, config_location, SpaceCatalogue, SpaceProblemEntry, SpacesIndex};
use crate::types::{SpaceName, SPACE_NAMES};
use crate::validate::{parse_space_config, Parsed};
use polypack_js::{fmt, json};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

/// load.ts: `CONFIG_CACHE_BYTES`. Bytes of configurations kept in memory at once, per space (the
/// least recently used goes first).
pub const CONFIG_CACHE_BYTES: usize = 4_000_000;
/// load.ts: `CONFIG_READS_AT_ONCE`. Reads of configurations kept apart that run at once, per
/// space; the others wait their turn.
pub const CONFIG_READS_AT_ONCE: usize = 4;

/// Where the loaders and `load_spaces_index` write their lines (the server's log).
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

/// A log that drops every line (the source's default `() => {}`).
pub fn no_log() -> Log {
    Arc::new(|_| {})
}

/// load.ts: `spaceRecordsPath`. The records file of a space below the repository root.
pub fn space_records_path(root: &Path, space: SpaceName) -> PathBuf {
    root.join("data").join(space.as_str()).join("records.json")
}

/// load.ts: `spaceConfigPath`. The file of a space's configurations kept apart, below the repository root.
pub fn space_config_path(root: &Path, space: SpaceName, file: &str) -> PathBuf {
    root.join("data").join(space.as_str()).join("configs").join(format!("{file}.jsonl"))
}

/// The message of a file error as Node writes it for a failed `open`:
/// "<CODE>: <description>, open '<path>'" for the errors a missing or unreadable file gives, and
/// the system's own text for any other.
fn node_error(e: &std::io::Error, call: &str, path: Option<&Path>) -> String {
    use std::io::ErrorKind;
    let named = match e.kind() {
        ErrorKind::NotFound => Some(("ENOENT", "no such file or directory")),
        ErrorKind::PermissionDenied => Some(("EACCES", "permission denied")),
        ErrorKind::IsADirectory => Some(("EISDIR", "illegal operation on a directory")),
        ErrorKind::NotADirectory => Some(("ENOTDIR", "not a directory")),
        _ => None,
    };
    match (named, path) {
        (Some((code, text)), Some(path)) => format!("{code}: {text}, {call} '{}'", path.display()),
        (Some((code, text)), None) => format!("{code}: {text}, {call}"),
        (None, _) => e.to_string(),
    }
}

/// `readFileSync(path)`: the bytes of a file, or Node's message (a failed `open` names the path, a
/// failed `read` does not).
fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| node_error(&e, "open", Some(path)))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| node_error(&e, "read", None))?;
    Ok(bytes)
}

/// `JSON.parse(text)` of a file's text: the value, or the message of the syntax error (serde_json's
/// words, not V8's). A byte order mark is not white space to `JSON.parse`, so a text that starts
/// with one is refused.
fn parse_json(text: &str) -> Result<Value, String> {
    if text.starts_with('\u{feff}') {
        return Err("Unexpected token '\u{feff}' at the start of the text".to_string());
    }
    json::parse(text.as_bytes())
}

/// load.ts: `readLine`. A configuration's line as read from its file, checked: the line is
/// {"P", "config"} with the entry's P, the configuration passes `parse_space_config` against the
/// entry's id, and its size is the entry's certified score (so that a file and an index that drift
/// apart serve nothing). The checked configuration as JSON text, or why not.
fn read_line(space: SpaceName, entry: &SpaceProblemEntry, text: &str) -> Result<String, String> {
    let row = parse_json(text).map_err(|message| format!("not JSON: {message}"))?;
    // `typeof r !== "object" || r === null || r.P !== entry.P || r.config === undefined`: an array
    // has no P either
    let r = row.as_object();
    let p = r.and_then(|r| r.get("P")).and_then(Value::as_f64);
    let config = r.and_then(|r| r.get("config"));
    if p != Some(entry.p as f64) || config.is_none() {
        return Err(format!("the line at config_at is not the configuration of P = {}", entry.p));
    }
    let id = parse_space_id(space, &entry.id)?;
    let (config, score) = match parse_space_config(&id, config) {
        Parsed::Ok { config, score } => (config, score),
        Parsed::Failed { errors, .. } => return Err(errors.join("; ")),
    };
    if let Some(certified) = &entry.certified {
        if score != certified.score {
            return Err(format!("its size {} is not the certified {} of the index", fmt::num(score), fmt::num(certified.score)));
        }
    }
    Ok(json::stringify(&config))
}

/// What a loader has done so far: reads of files, the most at once, the bytes kept now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoaderStats {
    pub reads: usize,
    pub peak_at_once: usize,
    pub bytes: usize,
}

/// A read in flight, which the callers that ask for the same entry share.
#[derive(Default)]
struct Pending {
    /// None while the read runs; then its result.
    done: Mutex<Option<Option<String>>>,
    ready: Condvar,
}

#[derive(Default)]
struct LoaderState {
    /// In insertion order: the first is the least recently used (the source's Map).
    cache: Vec<(String, String)>,
    bytes: usize,
    pending: HashMap<String, Arc<Pending>>,
    /// a problem is logged once, however often it is asked for
    told: HashSet<String>,
    reads: usize,
    running: usize,
    peak_at_once: usize,
    /// The turn of the next caller that may take a slot, and the next turn to hand out: callers
    /// that wait for a slot take it in the order they came.
    serving: u64,
    next_turn: u64,
}

/// load.ts: `ConfigLoader` (what `configLoader` returns). The on-demand reader of a catalogue's
/// configurations kept apart.
pub struct ConfigLoader {
    root: PathBuf,
    space: SpaceName,
    log: Log,
    limit_bytes: usize,
    at_once: usize,
    state: Mutex<LoaderState>,
    /// Told when a slot is free.
    slot: Condvar,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// load.ts: `configLoader`, with the source's defaults for the cache and the reads at once.
pub fn config_loader(root: &Path, space: SpaceName, log: Log) -> ConfigLoader {
    config_loader_with(root, space, log, CONFIG_CACHE_BYTES, CONFIG_READS_AT_ONCE)
}

/// load.ts: `configLoader(root, catalogue, log, limitBytes, atOnce)`. (The source takes the
/// catalogue for its space.)
pub fn config_loader_with(root: &Path, space: SpaceName, log: Log, limit_bytes: usize, at_once: usize) -> ConfigLoader {
    ConfigLoader { root: root.to_path_buf(), space, log, limit_bytes, at_once, state: Mutex::new(LoaderState::default()), slot: Condvar::new() }
}

impl ConfigLoader {
    /// The source's `slot`: waits until fewer than `at_once` reads run, then takes a place.
    fn take_slot(&self) {
        let mut st = lock(&self.state);
        let turn = st.next_turn;
        st.next_turn += 1;
        while st.running >= self.at_once || st.serving != turn {
            st = self.slot.wait(st).unwrap_or_else(|e| e.into_inner());
        }
        st.serving += 1;
        st.running += 1;
        st.peak_at_once = st.peak_at_once.max(st.running);
        st.reads += 1;
        drop(st);
        // the caller after this one may take the next free slot
        self.slot.notify_all();
    }

    /// The source's `release`.
    fn release(&self) {
        lock(&self.state).running -= 1;
        self.slot.notify_all();
    }

    /// The bytes of the entry's line, as text (invalid UTF-8 as U+FFFD, as `toString("utf8")`).
    fn read_file(&self, entry: &SpaceProblemEntry) -> Result<String, String> {
        let place = config_location(entry);
        let path = space_config_path(&self.root, self.space, &place.file);
        let mut file = File::open(&path).map_err(|e| node_error(&e, "open", Some(&path)))?;
        let bytes = read_at(&mut file, place.offset, place.length).map_err(|e| node_error(&e, "read", None))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// The source's `read`: one read of an entry's line, checked and kept.
    fn read(&self, entry: &SpaceProblemEntry) -> Option<String> {
        self.take_slot();
        let text = self.read_file(entry);
        self.release();
        let text = match text {
            Ok(text) => text,
            Err(message) => {
                // not "told": a read that failed may succeed next time
                (self.log)(&format!("[spaces] {}: configuration not read: {message}", entry.id));
                return None;
            }
        };
        let checked = match read_line(self.space, entry, &text) {
            Ok(checked) => checked,
            Err(error) => {
                let first = lock(&self.state).told.insert(entry.id.clone());
                if first {
                    (self.log)(&format!("[spaces] {}: configuration left out: {error}", entry.id));
                }
                return None;
            }
        };
        let mut st = lock(&self.state);
        // `cache.set(id, checked)`: a key that is there keeps its place
        match st.cache.iter_mut().find(|(id, _)| *id == entry.id) {
            Some(slot) => slot.1 = checked.clone(),
            None => st.cache.push((entry.id.clone(), checked.clone())),
        }
        // `checked.length`: the text is ASCII (numbers and the names of the fields)
        st.bytes += checked.encode_utf16().count();
        while st.bytes > self.limit_bytes && st.cache.len() > 1 {
            let (_, value) = st.cache.remove(0);
            st.bytes -= value.encode_utf16().count();
        }
        Some(checked)
    }

    /// load.ts: `ConfigLoader.load`. The entry's configuration as JSON text; None when it cannot be
    /// read (then nothing is kept). Blocks while the file is read.
    pub fn load(&self, entry: &SpaceProblemEntry) -> Option<String> {
        if !entry.config_apart {
            return entry.config.clone();
        }
        let (pending, mine) = {
            let mut st = lock(&self.state);
            if let Some(k) = st.cache.iter().position(|(id, _)| *id == entry.id) {
                // the most recently used goes last
                let hit = st.cache.remove(k);
                let text = hit.1.clone();
                st.cache.push(hit);
                return Some(text);
            }
            match st.pending.get(&entry.id) {
                Some(p) => (p.clone(), false),
                None => {
                    let p = Arc::new(Pending::default());
                    st.pending.insert(entry.id.clone(), p.clone());
                    (p, true)
                }
            }
        };
        if !mine {
            // the read that another caller started is this one's too
            let mut done = lock(&pending.done);
            while done.is_none() {
                done = pending.ready.wait(done).unwrap_or_else(|e| e.into_inner());
            }
            return done.clone().flatten();
        }
        let result = self.read(entry);
        // `.finally(() => pending.delete(entry.id))`: after the result is kept
        lock(&self.state).pending.remove(&entry.id);
        *lock(&pending.done) = Some(result.clone());
        pending.ready.notify_all();
        result
    }

    /// load.ts: `ConfigLoader.cached`. Ids of the configurations kept, least recently used first.
    pub fn cached(&self) -> Vec<String> {
        lock(&self.state).cache.iter().map(|(id, _)| id.clone()).collect()
    }

    /// load.ts: `ConfigLoader.stats`.
    pub fn stats(&self) -> LoaderStats {
        let st = lock(&self.state);
        LoaderStats { reads: st.reads, peak_at_once: st.peak_at_once, bytes: st.bytes }
    }
}

/// `length` bytes of a file from `offset`, or as many as it has.
fn read_at(file: &mut File, offset: u64, length: u64) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut buf)?;
    Ok(buf)
}

/// load.ts: `readEntryConfigSync`. A configuration kept apart, read at once (tests and tools; the
/// server uses the cached loader).
pub fn read_entry_config_sync(root: &Path, catalogue: &SpaceCatalogue, entry: &SpaceProblemEntry) -> Option<String> {
    if !entry.config_apart {
        return entry.config.clone();
    }
    let place = config_location(entry);
    let mut file = File::open(space_config_path(root, catalogue.space, &place.file)).ok()?;
    let bytes = read_at(&mut file, place.offset, place.length).ok()?;
    read_line(catalogue.space, entry, &String::from_utf8_lossy(&bytes)).ok()
}

/// load.ts: `catalogueOf`. `file` is the parsed records file, None for a space with a domain and
/// no records file (the source's `null`).
fn catalogue_of(root: &Path, space: SpaceName, file: Option<&Value>, log: &Log) -> SpaceCatalogue {
    let mut catalogue = build_space_catalogue(space, file, space_domain(space));
    for s in &catalogue.skipped {
        log(&format!("[spaces] {space} record left out: {s}"));
    }
    let apart = catalogue.problems.iter().filter(|p| p.config_apart).count();
    if apart > 0 {
        catalogue.load_config = Some(Arc::new(config_loader(root, space, log.clone())));
    }
    let count = catalogue.problems.len();
    let head = match catalogue.domain {
        Some(domain) => format!("a domain of {} problems, {count} with a record (", fmt::num(domain.problems())),
        None => format!("{count} problems ("),
    };
    let records = match file {
        None => "no records file".to_string(),
        Some(_) => format!("records of {}", catalogue.generated.as_deref().unwrap_or("unknown date")),
    };
    let tail = if apart > 0 { format!(", {apart} configurations read on demand") } else { String::new() };
    log(&format!("[spaces] {space}: {head}{records}){tail}"));
    catalogue
}

/// load.ts: `loadSpacesIndex`. The catalogues of every space whose records file exists below
/// `root`, or that has a domain, read in this thread. Each file is parsed once and only the
/// compact catalogue is kept; `log` receives one line per space and one per record left out.
pub fn load_spaces_index(root: &Path, log: Log) -> SpacesIndex {
    let mut index = SpacesIndex::default();
    for space in SPACE_NAMES {
        let path = space_records_path(root, space);
        if !path.exists() {
            if space_domain(space).is_some() {
                // a space with a domain and no records yet
                index.set(catalogue_of(root, space, None, &log));
                continue;
            }
            log(&format!("[spaces] no {space} records ({} is missing)", Path::new("data").join(space.as_str()).join("records.json").display()));
            continue;
        }
        // `JSON.parse(readFileSync(path, "utf8"))`: bytes that are not UTF-8 read as U+FFFD
        let file = read_file(&path).and_then(|bytes| parse_json(&String::from_utf8_lossy(&bytes)));
        match file {
            Ok(file) => index.set(catalogue_of(root, space, Some(&file), &log)),
            Err(message) => log(&format!("[spaces] {space} records not loaded: {message}")),
        }
    }
    index
}
