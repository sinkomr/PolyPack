//! Target mode (the personal JavaScript build's src/target.ts): search only the flat problems one
//! holder leads, by preference their first entries (problems whose only accepted submission is
//! theirs, nearly all low-effort records).
//!
//!   targets.json  the problems the holder led when GET /api/holder was last read, fetched again
//!                 after 24 hours; a problem whose leader is no longer the holder, or that can no
//!                 longer be a first entry, is dropped from it
//!   lazy.json     the search time each leader's entry states (budget.time_s), looked up once per
//!                 entry, for --target-max-budget
//!
//! Both are written atomically, at most every two seconds while the client runs and at its end.

use crate::format::{iso_of_ms, now_ms, parse_iso};
use crate::http::Answer;
use crate::state::write_atomic;
use polypack_flat::rng::Rng;
use polypack_flat::shapes::Problem;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

pub const TARGETS_FILE: &str = "targets.json";
pub const BUDGETS_FILE: &str = "lazy.json";
pub const TARGET_MAX_AGE_MS: i64 = 24 * 3_600_000;
pub const MAX_BUDGETS: usize = 20_000;
pub const SAVE_EVERY_MS: i64 = 2000;
pub const DEFAULT_TARGET_MIN_SECONDS: f64 = 10.0;
pub const DEFAULT_TARGET_MARGIN: f64 = 1e-6;

const MAX_SIDES: u64 = 100;
const MAX_PIECES: u64 = 500;

fn is_shape(v: u64) -> bool {
    v == 0 || (3..=MAX_SIDES).contains(&v)
}

/// The problems of one pair of shapes, P ascending.
#[derive(Clone, Debug, PartialEq)]
pub struct Pair {
    pub n: u32,
    pub m: u32,
    pub ps: Vec<usize>,
}

/// The list as the file keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct TargetFile {
    pub holder: String,
    pub base: String,
    pub fetched_at: String,
    pub computed_at: Option<String>,
    pub pairs: Vec<Pair>,
}

fn read_pairs(v: &Value) -> Option<Vec<Pair>> {
    let mut out = Vec::new();
    for item in v.as_array()? {
        let o = item.as_object()?;
        let n = o.get("N")?.as_u64().filter(|&x| is_shape(x))?;
        let m = o.get("M")?.as_u64().filter(|&x| is_shape(x))?;
        let mut ps = Vec::new();
        for p in o.get("P")?.as_array()? {
            ps.push(p.as_u64().filter(|&x| (1..=MAX_PIECES).contains(&x))? as usize);
        }
        ps.sort_unstable();
        ps.dedup();
        out.push(Pair { n: n as u32, m: m as u32, ps });
    }
    Some(out)
}

/// GET /api/holder's answer for `holder`; None when it is malformed or another name's.
pub fn read_holder_answer(body: &Value, holder: &str, base: &str, fetched_at_ms: i64) -> Option<TargetFile> {
    let o = body.as_object()?;
    if let Some(name) = o.get("name").and_then(|x| x.as_str()) {
        if name != holder {
            return None;
        }
    }
    let pairs = read_pairs(o.get("pairs")?)?;
    Some(TargetFile {
        holder: holder.to_string(),
        base: base.to_string(),
        fetched_at: iso_of_ms(fetched_at_ms),
        computed_at: o.get("computed_at").and_then(|x| x.as_str()).map(|s| s.chars().take(40).collect()),
        pairs,
    })
}

pub fn read_targets_file(path: &Path) -> Option<TargetFile> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    if v.get("version").and_then(|x| x.as_u64()) != Some(1) {
        return None;
    }
    let holder = v.get("holder")?.as_str()?.to_string();
    let base = v.get("base")?.as_str()?.to_string();
    let fetched_at = v.get("fetched_at")?.as_str()?.to_string();
    parse_iso(&fetched_at)?;
    let pairs = read_pairs(v.get("pairs")?)?;
    let computed_at = v.get("computed_at").and_then(|x| x.as_str()).map(|s| s.to_string());
    Some(TargetFile { holder, base, fetched_at, computed_at, pairs })
}

/// --N, --M and --P, which narrow the list (None: every value).
#[derive(Clone, Debug, Default)]
pub struct Filters {
    pub n: Option<Vec<u32>>,
    pub m: Option<Vec<u32>>,
    pub p: Option<Vec<usize>>,
}

impl Filters {
    fn pass(&self, q: &Problem) -> bool {
        self.n.as_ref().map_or(true, |l| l.contains(&q.n)) && self.m.as_ref().map_or(true, |l| l.contains(&q.m)) && self.p.as_ref().map_or(true, |l| l.contains(&q.p))
    }
}

/// The target list: `all` is what the file keeps, `active` what may still be drawn (those that pass
/// the filters and were not held back).
pub struct TargetPool {
    file: TargetFile,
    pub fetched_at_ms: i64,
    all: BTreeMap<(u32, u32, usize), Problem>,
    active: Vec<Problem>,
    filters: Filters,
    path: PathBuf,
    dirty: bool,
    last_save_ms: i64,
}

impl TargetPool {
    pub fn new(file: TargetFile, filters: Filters, path: PathBuf) -> Self {
        let fetched_at_ms = parse_iso(&file.fetched_at).unwrap_or(0);
        let mut pool = TargetPool { file, fetched_at_ms, all: BTreeMap::new(), active: Vec::new(), filters, path, dirty: false, last_save_ms: i64::MIN };
        pool.fill();
        pool
    }

    fn fill(&mut self) {
        self.all.clear();
        self.active.clear();
        for pair in &self.file.pairs {
            for &p in &pair.ps {
                let q = Problem::new(pair.n, pair.m, p);
                self.all.insert((q.n, q.m, q.p), q);
                if self.filters.pass(&q) {
                    self.active.push(q);
                }
            }
        }
    }

    /// Problems left to draw.
    pub fn size(&self) -> usize {
        self.active.len()
    }

    /// Problems on the list, before --N, --M and --P and before any were held back.
    pub fn total(&self) -> usize {
        self.all.len()
    }

    pub fn holder(&self) -> &str {
        &self.file.holder
    }

    /// Every problem of the list equally likely; None when none is left.
    pub fn draw(&self, rng: &mut Rng) -> Option<Problem> {
        if self.active.is_empty() {
            return None;
        }
        Some(self.active[rng.below(self.active.len())])
    }

    /// Not drawn again until the list is replaced; it stays in the file.
    pub fn hold(&mut self, q: &Problem) {
        if let Some(i) = self.active.iter().position(|a| a == q) {
            self.active.swap_remove(i);
        }
    }

    /// Not drawn again, and gone from the file: its leader is no longer the holder, or it cannot
    /// be searched.
    pub fn drop_problem(&mut self, q: &Problem) -> std::io::Result<()> {
        self.hold(q);
        if self.all.remove(&(q.n, q.m, q.p)).is_some() {
            self.dirty = true;
            return self.save_soon();
        }
        Ok(())
    }

    /// The list after a new fetch.
    pub fn replace(&mut self, file: TargetFile) -> std::io::Result<()> {
        self.fetched_at_ms = parse_iso(&file.fetched_at).unwrap_or(0);
        self.file = file;
        self.fill();
        self.dirty = true;
        self.flush()
    }

    /// The file's content: the problems of `all`, by pair of shapes, P ascending.
    pub fn to_file(&self) -> TargetFile {
        let mut pairs: Vec<Pair> = Vec::new();
        for &(n, m, p) in self.all.keys() {
            match pairs.last_mut() {
                Some(last) if last.n == n && last.m == m => last.ps.push(p),
                _ => pairs.push(Pair { n, m, ps: vec![p] }),
            }
        }
        TargetFile { pairs, ..self.file.clone() }
    }

    fn save_soon(&mut self) -> std::io::Result<()> {
        if now_ms().saturating_sub(self.last_save_ms) >= SAVE_EVERY_MS {
            return self.flush();
        }
        Ok(())
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        write_atomic(&self.path, &format!("{}\n", file_json(&self.to_file())))?;
        self.dirty = false;
        self.last_save_ms = now_ms();
        Ok(())
    }
}

pub fn file_json(f: &TargetFile) -> Value {
    json!({
        "version": 1,
        "holder": f.holder,
        "base": f.base,
        "fetched_at": f.fetched_at,
        "computed_at": f.computed_at,
        "pairs": f.pairs.iter().map(|p| json!({ "N": p.n, "M": p.m, "P": p.ps })).collect::<Vec<_>>(),
    })
}

/// The target list: the file's when it is this holder's and server's and younger than a day
/// (unless `refresh`), else a new fetch, else the old file; Err when there is none.
pub fn load_targets(
    dir: &Path,
    holder: &str,
    base: &str,
    filters: &Filters,
    refresh: bool,
    fetch: &dyn Fn() -> Option<Answer>,
    log: &dyn Fn(&str),
) -> Result<TargetPool, String> {
    let path = dir.join(TARGETS_FILE);
    let mine = read_targets_file(&path).filter(|f| f.holder == holder && f.base == base);
    let now = now_ms();
    let age = mine.as_ref().and_then(|f| parse_iso(&f.fetched_at)).map_or(i64::MAX, |t| now - t);
    if let Some(f) = &mine {
        if !refresh && (0..TARGET_MAX_AGE_MS).contains(&age) {
            let pool = TargetPool::new(f.clone(), filters.clone(), path);
            log(&format!(
                "Target list: {} problem(s) of \"{holder}\" from the list fetched {} ({} h ago; --target-refresh fetches it again)",
                pool.total(),
                f.fetched_at,
                (age as f64 / 3_600_000.0).round()
            ));
            return Ok(pool);
        }
    }
    let answer = fetch();
    let fresh = answer.as_ref().filter(|a| a.status == 200).and_then(|a| read_holder_answer(&a.body, holder, base, now_ms()));
    if let Some(f) = fresh {
        let computed = f.computed_at.clone();
        let mut pool = TargetPool::new(f.clone(), filters.clone(), path);
        if let Err(e) = pool.replace(f) {
            log(&format!("could not save the target list: {e}"));
        }
        log(&format!(
            "Target list: fetched {} problem(s) of \"{holder}\" from {base}/api/holder{}",
            pool.total(),
            computed.map_or(String::new(), |c| format!(" (computed {c}, up to 15 minutes before)"))
        ));
        return Ok(pool);
    }
    let why = match &answer {
        None => "no answer".to_string(),
        Some(a) if a.status == 200 => "malformed answer".to_string(),
        Some(a) => format!("HTTP {}", a.status),
    };
    if let Some(f) = mine {
        log(&format!("Could not fetch the target list ({why}); using the one fetched {}", f.fetched_at));
        return Ok(TargetPool::new(f, filters.clone(), path));
    }
    Err(format!("could not fetch the problems \"{holder}\" leads from /api/holder ({why})"))
}

/// Why a problem is no longer a target, from GET /api/leaderboard/N/M/P.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Keep,
    Closed { leader: Option<String> },
    NoLeader,
    OtherLeader { leader: String },
    NotFirst { total: i64 },
}

/// None when the answer is malformed.
pub fn leaderboard_verdict(body: &Value, holder: &str, any_entry: bool) -> Option<Verdict> {
    let o = body.as_object()?;
    let entries = o.get("entries")?.as_array()?;
    let total = o.get("total")?.as_i64().filter(|&t| t >= 0)?;
    let accepts = o.get("accepts_submissions")?.as_bool()?;
    let leader = match entries.first() {
        None => None,
        Some(first) => Some(first.get("name")?.as_str()?.to_string()),
    };
    Some(match leader {
        _ if !accepts => Verdict::Closed { leader },
        None => Verdict::NoLeader,
        Some(l) if l != holder => Verdict::OtherLeader { leader: l },
        Some(_) if !any_entry && total != 1 => Verdict::NotFirst { total },
        Some(_) => Verdict::Keep,
    })
}

/// The search time an entry states (budget.time_s); None when it says nothing.
pub fn read_budget_seconds(body: &Value) -> Option<f64> {
    body.get("budget")?.get("time_s")?.as_f64().filter(|t| t.is_finite() && *t >= 0.0)
}

pub fn is_lazy(seconds: Option<f64>, max: f64, include_unknown: bool) -> bool {
    seconds.map_or(include_unknown, |s| s <= max)
}

/// The search times of entries already looked up, newest last, at most MAX_BUDGETS.
pub struct BudgetCache {
    path: PathBuf,
    order: Vec<i64>,
    seconds: HashMap<i64, Option<f64>>,
    max: usize,
    dirty: bool,
    last_save_ms: i64,
}

impl BudgetCache {
    pub fn open(path: PathBuf) -> Self {
        let mut c = BudgetCache { path, order: Vec::new(), seconds: HashMap::new(), max: MAX_BUDGETS, dirty: false, last_save_ms: i64::MIN };
        let v: Value = std::fs::read_to_string(&c.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        if v.get("version").and_then(|x| x.as_u64()) == Some(1) {
            for e in v.get("entries").and_then(|x| x.as_array()).into_iter().flatten() {
                let Some(id) = e.get(0).and_then(|x| x.as_i64()) else { continue };
                let s = match e.get(1) {
                    Some(Value::Null) => None,
                    Some(x) => match x.as_f64().filter(|t| t.is_finite() && *t >= 0.0) {
                        Some(t) => Some(t),
                        None => continue,
                    },
                    None => continue,
                };
                if c.seconds.insert(id, s).is_some() {
                    c.order.retain(|&x| x != id);
                }
                c.order.push(id);
            }
        }
        c.trim();
        c
    }

    /// None when the entry was not looked up; Some(None) when it was and says nothing.
    pub fn get(&self, id: i64) -> Option<Option<f64>> {
        self.seconds.get(&id).copied()
    }

    pub fn set(&mut self, id: i64, seconds: Option<f64>) -> std::io::Result<()> {
        if self.seconds.insert(id, seconds).is_some() {
            self.order.retain(|&x| x != id);
        }
        self.order.push(id);
        self.trim();
        self.dirty = true;
        if now_ms().saturating_sub(self.last_save_ms) >= SAVE_EVERY_MS {
            return self.flush();
        }
        Ok(())
    }

    fn trim(&mut self) {
        if self.order.len() > self.max {
            let cut = self.order.len() - self.max;
            for id in self.order.drain(..cut) {
                self.seconds.remove(&id);
            }
        }
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let entries: Vec<Value> = self.order.iter().map(|id| json!([id, self.seconds[id]])).collect();
        write_atomic(&self.path, &format!("{}\n", json!({ "version": 1, "entries": entries })))?;
        self.dirty = false;
        self.last_save_ms = now_ms();
        Ok(())
    }
}

/// Whether a target's search may end now: after `min_seconds` of search, once its best strict
/// packing is at most leader * (1 - margin).
pub fn stop_early(best: Option<f64>, leader: Option<f64>, seconds: f64, min_seconds: f64, margin: f64) -> bool {
    match (best, leader) {
        (Some(b), Some(l)) if l > 0.0 => seconds >= min_seconds && b <= l * (1.0 - margin),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("polypack-native-target-{tag}-{}-{:08x}", std::process::id(), crate::state::random_u32()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn holder_answer_and_file() {
        let body = json!({ "name": "jg", "computed_at": "2026-11-07T00:00:00.000Z", "pairs": [{ "N": 4, "M": 4, "P": [9, 3, 3] }, { "N": 0, "M": 6, "P": [12] }] });
        let f = read_holder_answer(&body, "jg", "http://x", 86_400_000).unwrap();
        assert_eq!(f.pairs[0].ps, vec![3, 9]);
        assert_eq!(f.fetched_at, "1970-01-02T00:00:00.000Z");
        assert!(read_holder_answer(&body, "other", "http://x", 0).is_none());
        assert!(read_holder_answer(&json!({ "pairs": [{ "N": 1, "M": 4, "P": [3] }] }), "jg", "b", 0).is_none());
        assert!(read_holder_answer(&json!({ "pairs": [{ "N": 4, "M": 4, "P": [501] }] }), "jg", "b", 0).is_none());

        let d = dir("file");
        let filters = Filters { n: Some(vec![4]), ..Default::default() };
        let mut pool = TargetPool::new(f.clone(), filters, d.join(TARGETS_FILE));
        assert_eq!((pool.total(), pool.size()), (3, 2));
        pool.replace(f).unwrap();
        pool.drop_problem(&Problem::new(4, 4, 3)).unwrap();
        pool.hold(&Problem::new(4, 4, 9));
        assert_eq!((pool.total(), pool.size()), (2, 0));
        pool.flush().unwrap();
        let back = read_targets_file(&d.join(TARGETS_FILE)).unwrap();
        assert_eq!(back.pairs, vec![Pair { n: 0, m: 6, ps: vec![12] }, Pair { n: 4, m: 4, ps: vec![9] }]);
        assert_eq!(back.holder, "jg");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn loads_fresh_cached_and_falls_back() {
        let d = dir("load");
        let log = |_: &str| {};
        let body = json!({ "name": "jg", "pairs": [{ "N": 4, "M": 4, "P": [5] }] });
        let ok = || Some(Answer { status: 200, body: body.clone() });
        let down = || None;
        let f = Filters::default();
        assert!(load_targets(&d, "jg", "http://x", &f, false, &down, &log).is_err());
        assert_eq!(load_targets(&d, "jg", "http://x", &f, false, &ok, &log).unwrap().total(), 1);
        // a fresh file is used without a fetch; another holder's or server's is not
        assert_eq!(load_targets(&d, "jg", "http://x", &f, false, &down, &log).unwrap().total(), 1);
        assert!(load_targets(&d, "kh", "http://x", &f, false, &down, &log).is_err());
        assert!(load_targets(&d, "jg", "http://y", &f, false, &down, &log).is_err());
        // --target-refresh fetches; when that fails the old file still serves
        assert_eq!(load_targets(&d, "jg", "http://x", &f, true, &down, &log).unwrap().total(), 1);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn verdicts() {
        let lb = |accepts: bool, total: i64, name: Option<&str>| {
            json!({ "accepts_submissions": accepts, "total": total, "entries": name.map_or(vec![], |n| vec![json!({ "name": n })]) })
        };
        assert_eq!(leaderboard_verdict(&lb(true, 1, Some("jg")), "jg", false), Some(Verdict::Keep));
        assert_eq!(leaderboard_verdict(&lb(true, 3, Some("jg")), "jg", false), Some(Verdict::NotFirst { total: 3 }));
        assert_eq!(leaderboard_verdict(&lb(true, 3, Some("jg")), "jg", true), Some(Verdict::Keep));
        assert_eq!(leaderboard_verdict(&lb(true, 2, Some("me")), "jg", true), Some(Verdict::OtherLeader { leader: "me".into() }));
        assert_eq!(leaderboard_verdict(&lb(true, 0, None), "jg", false), Some(Verdict::NoLeader));
        assert_eq!(leaderboard_verdict(&lb(false, 1, Some("jg")), "jg", false), Some(Verdict::Closed { leader: Some("jg".into()) }));
        assert_eq!(leaderboard_verdict(&json!({ "entries": [], "total": -1, "accepts_submissions": true }), "jg", false), None);
        assert_eq!(leaderboard_verdict(&json!({ "entries": [{}], "total": 1, "accepts_submissions": true }), "jg", false), None);
    }

    #[test]
    fn budgets_and_early_stop() {
        assert_eq!(read_budget_seconds(&json!({ "budget": { "time_s": 12.5 } })), Some(12.5));
        assert_eq!(read_budget_seconds(&json!({ "budget": { "evals": 3 } })), None);
        assert!(is_lazy(Some(30.0), 30.0, false) && !is_lazy(Some(31.0), 30.0, true));
        assert!(is_lazy(None, 30.0, true) && !is_lazy(None, 30.0, false));
        let d = dir("lazy");
        let mut c = BudgetCache::open(d.join(BUDGETS_FILE));
        c.max = 2;
        c.set(1, Some(5.0)).unwrap();
        c.set(2, None).unwrap();
        c.set(3, Some(7.0)).unwrap();
        c.flush().unwrap();
        let back = BudgetCache::open(d.join(BUDGETS_FILE));
        assert_eq!((back.get(1), back.get(2), back.get(3)), (None, Some(None), Some(Some(7.0))));
        std::fs::remove_dir_all(&d).unwrap();
        assert!(stop_early(Some(0.99), Some(1.0), 10.0, 10.0, 1e-6));
        assert!(!stop_early(Some(0.99), Some(1.0), 9.9, 10.0, 1e-6));
        assert!(!stop_early(Some(1.0 - 1e-7), Some(1.0), 20.0, 10.0, 1e-6));
        assert!(!stop_early(Some(0.5), None, 20.0, 10.0, 1e-6));
    }
}
