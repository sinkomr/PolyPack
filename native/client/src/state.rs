//! The state directory (default ~/.polypack-native), in the JavaScript client's formats:
//!
//!   lock            the running copy's pid, host, start time and token; a second copy refuses
//!   state.json      {"state_version": 2, "units": "diameter"}
//!   memory.json     the engine's memory, rewritten atomically after each problem
//!   history.jsonl   one line per problem searched, kept to the last 20,000
//!   best/N-M-P.json the best strict packing this machine found for a problem, with provenance
//!
//! Every whole-file write goes to a temporary file that is then renamed over the target.

use crate::platform::{hostname, pid_alive};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const HISTORY_LIMIT: usize = 20_000;

/// Writes `data` to `path` through a temporary file in the same directory and a rename.
pub fn write_atomic(path: &Path, data: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("{}-{:08x}.tmp", std::process::id(), random_u32()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// A little entropy for file names and lock tokens (not for the search).
pub fn random_u32() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.write_u32(std::process::id());
    h.finish() as u32
}

#[derive(Debug)]
pub enum OpenError {
    /// Another copy holds the lock (the lock file's path and what it says).
    LockHeld(PathBuf, String),
    Io(String),
}

pub struct StateDir {
    pub dir: PathBuf,
    lock_path: PathBuf,
    token: String,
    pub initial_history: Vec<Value>,
}

impl StateDir {
    pub fn open(dir: &Path) -> Result<StateDir, OpenError> {
        fs::create_dir_all(dir.join("best")).map_err(|e| OpenError::Io(e.to_string()))?;
        let lock_path = dir.join("lock");
        let token = format!("{:08x}{:08x}", random_u32(), random_u32());
        let info = json!({
            "pid": std::process::id(),
            "hostname": hostname(),
            "started": crate::format::iso_now(),
            "token": token,
        });
        let text = format!("{info}\n");
        for _attempt in 0..3 {
            match fs::OpenOptions::new().write(true).create_new(true).open(&lock_path) {
                Ok(mut f) => {
                    f.write_all(text.as_bytes()).map_err(|e| OpenError::Io(e.to_string()))?;
                    let mut s = StateDir { dir: dir.to_path_buf(), lock_path, token, initial_history: Vec::new() };
                    s.init().map_err(|e| OpenError::Io(e.to_string()))?;
                    return Ok(s);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let held = fs::read_to_string(&lock_path).unwrap_or_default();
                    let holder: Value = serde_json::from_str(&held).unwrap_or(Value::Null);
                    let same_host = holder.get("hostname").and_then(|h| h.as_str()) == Some(hostname().as_str());
                    let pid = holder.get("pid").and_then(|p| p.as_u64()).map(|p| p as u32);
                    // stale: from this machine, and its process no longer runs
                    let stale = same_host && pid.map_or(false, |p| p != std::process::id() && !pid_alive(p));
                    if !stale {
                        return Err(OpenError::LockHeld(lock_path, crate::answers::clean_text(&held, 200)));
                    }
                    let _ = fs::remove_file(&lock_path);
                }
                Err(e) => return Err(OpenError::Io(e.to_string())),
            }
        }
        Err(OpenError::LockHeld(lock_path, "the lock could not be taken".into()))
    }

    fn init(&mut self) -> std::io::Result<()> {
        let state = self.dir.join("state.json");
        if !state.exists() {
            write_atomic(&state, "{\"state_version\":2,\"units\":\"diameter\"}\n")?;
        }
        let history = self.dir.join("history.jsonl");
        if let Ok(text) = fs::read_to_string(&history) {
            let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
            self.initial_history = lines.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect();
            if lines.len() > HISTORY_LIMIT {
                let keep = lines[lines.len() - HISTORY_LIMIT..].join("\n") + "\n";
                write_atomic(&history, &keep)?;
            }
        }
        Ok(())
    }

    /// Removes the lock if it is still this copy's.
    pub fn close(&self) {
        if let Ok(text) = fs::read_to_string(&self.lock_path) {
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if v.get("token").and_then(|t| t.as_str()) == Some(self.token.as_str()) {
                let _ = fs::remove_file(&self.lock_path);
            }
        }
    }

    pub fn read_memory(&self) -> Value {
        fs::read_to_string(self.dir.join("memory.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
    }

    pub fn write_memory(&self, memory: &Value) -> std::io::Result<()> {
        write_atomic(&self.dir.join("memory.json"), &format!("{memory}\n"))
    }

    pub fn append_history(&self, line: &Value) -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new().create(true).append(true).open(self.dir.join("history.jsonl"))?;
        f.write_all(format!("{line}\n").as_bytes())
    }

    pub fn best_path(&self, n: u32, m: u32, p: usize) -> PathBuf {
        self.dir.join("best").join(format!("{n}-{m}-{p}.json"))
    }

    pub fn read_best(&self, n: u32, m: u32, p: usize) -> Option<Value> {
        let v: Value = serde_json::from_str(&fs::read_to_string(self.best_path(n, m, p)).ok()?).ok()?;
        // only files in the current units, of this problem, strict, with a configuration
        let ok = v.get("N").and_then(|x| x.as_u64()) == Some(n as u64)
            && v.get("M").and_then(|x| x.as_u64()) == Some(m as u64)
            && v.get("P").and_then(|x| x.as_u64()) == Some(p as u64)
            && v.get("strict").and_then(|x| x.as_bool()) == Some(true)
            && v.get("units").and_then(|x| x.as_str()) == Some("diameter")
            && v.get("score").and_then(|x| x.as_f64()).map_or(false, |s| s.is_finite() && s > 0.0)
            && v.get("config").is_some();
        if ok {
            Some(v)
        } else {
            None
        }
    }

    pub fn write_best(&self, n: u32, m: u32, p: usize, file: &Value) -> std::io::Result<()> {
        write_atomic(&self.best_path(n, m, p), &format!("{file}\n"))
    }
}
