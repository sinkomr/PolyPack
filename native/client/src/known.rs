//! The problems of the swept spaces that already have a best, read in bulk: GET
//! /api/spaces/:space/records (every problem with a research record, with its site best) and GET
//! /api/spaces/:space/site-only (every problem with a site entry and no research record, a page at a
//! time). With them the sweep passes over a problem that has a best (with --open-only), is closed, or
//! is led by the user, without reading that problem on its own. A problem the lists do not name is
//! read as before, so a list a little out of date costs a read, never a wrong submission.

use crate::answers::stored_name;
use crate::http::Api;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Problems per page of /site-only (the server's largest page).
pub const SITE_ONLY_PAGE: usize = 5000;
/// How long a list is used before it is read again.
pub const REFRESH_SECONDS: u64 = 3600;

/// What the lists say of the problems they name.
#[derive(Default, Debug)]
pub struct Known {
    /// Problems with a best: a research record or a site entry.
    pub has_best: HashSet<String>,
    /// Problems that take no submissions.
    pub closed: HashSet<String>,
    /// The name of each problem's site leader.
    pub leader: HashMap<String, String>,
}

/// Why a problem can be passed over without reading it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Skip {
    Closed,
    HasBest,
    Own,
}

impl Known {
    /// Notes one problem summary of either list.
    pub fn add(&mut self, p: &Value) {
        let Some(id) = p.get("id").and_then(Value::as_str) else { return };
        if p.get("accepts_submissions").and_then(Value::as_bool) == Some(false) {
            self.closed.insert(id.to_string());
        }
        if p.get("best_score").map_or(false, Value::is_number) {
            self.has_best.insert(id.to_string());
        }
        if let Some(name) = p.get("site_best").and_then(|b| b.get("name")).and_then(Value::as_str) {
            self.leader.insert(id.to_string(), name.to_string());
        }
    }

    /// Why `id` can be passed over: closed; with a best when only open problems are wanted; led by
    /// `own` (the user's name, None with --include-own or without --name). None: read it.
    pub fn skip(&self, id: &str, open_only: bool, own: Option<&str>) -> Option<Skip> {
        if self.closed.contains(id) {
            return Some(Skip::Closed);
        }
        if open_only && self.has_best.contains(id) {
            return Some(Skip::HasBest);
        }
        if let (Some(own), Some(leader)) = (own, self.leader.get(id)) {
            if stored_name(leader) == stored_name(own) {
                return Some(Skip::Own);
            }
        }
        None
    }

    fn take_page(&mut self, body: &Value) -> usize {
        let list = body.get("problems").and_then(Value::as_array);
        for p in list.into_iter().flatten() {
            self.add(p);
        }
        list.map_or(0, Vec::len)
    }
}

/// Reads both lists of each space. Err with the reason when one cannot be read; the sweep then
/// reads every problem on its own, as without the lists.
pub fn load(api: &Api, spaces: &[&str]) -> Result<Known, String> {
    let mut k = Known::default();
    for space in spaces {
        let path = format!("/api/spaces/{space}/records");
        let a = api.get(&path).ok_or_else(|| format!("GET {path}: no answer"))?;
        if a.status != 200 {
            return Err(format!("GET {path}: HTTP {}", a.status));
        }
        k.take_page(&a.body);
        let mut after: Option<String> = None;
        for _ in 0..100_000 {
            let path = match &after {
                None => format!("/api/spaces/{space}/site-only?limit={SITE_ONLY_PAGE}"),
                Some(a) => format!("/api/spaces/{space}/site-only?limit={SITE_ONLY_PAGE}&after={a}"),
            };
            let a = api.get(&path).ok_or_else(|| format!("GET {path}: no answer"))?;
            if a.status != 200 {
                return Err(format!("GET {path}: HTTP {}", a.status));
            }
            k.take_page(&a.body);
            match a.body.get("next").and_then(Value::as_str) {
                Some(next) if Some(next) != after.as_deref() => after = Some(next.to_string()),
                _ => break,
            }
        }
    }
    Ok(k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notes_bests_closed_problems_and_leaders() {
        let mut k = Known::default();
        k.add(&json!({"id": "sphere/0/5", "best_score": 1.2, "accepts_submissions": true, "site_best": null}));
        k.add(&json!({"id": "sphere/0/6", "best_score": null, "accepts_submissions": false}));
        k.add(&json!({"id": "sphere/0/7", "best_score": 2.0, "accepts_submissions": true, "site_best": {"name": "Tester", "score": 2.0}}));
        k.add(&json!({"id": "sphere/0/8", "best_score": null, "accepts_submissions": true}));
        assert_eq!(k.skip("sphere/0/5", true, None), Some(Skip::HasBest));
        assert_eq!(k.skip("sphere/0/5", false, None), None);
        assert_eq!(k.skip("sphere/0/6", false, None), Some(Skip::Closed));
        assert_eq!(k.skip("sphere/0/7", false, Some("Tester")), Some(Skip::Own));
        assert_eq!(k.skip("sphere/0/7", false, Some("Someone")), None);
        assert_eq!(k.skip("sphere/0/7", true, Some("Someone")), Some(Skip::HasBest));
        // not in the lists: read it
        assert_eq!(k.skip("sphere/0/8", true, Some("Tester")), None);
        assert_eq!(k.skip("sphere/0/9", true, Some("Tester")), None);
    }
}
