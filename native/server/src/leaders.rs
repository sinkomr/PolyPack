//! Port of apps/server/src/leaders.ts: GET /api/leaders, who leads, for many problems at once.

use std::sync::{Arc, Mutex};

use indexmap::{IndexMap, IndexSet};
use polypack_flat::shapes::{is_shape_code_number, MAX_PIECES};
use polypack_js::fmt;
use serde::Serialize;

use crate::hono::{self, Handled, Req};
use crate::js;
use crate::spaces::SpacesPort;
use crate::store::{ProblemKey, SpaceProblem, SqliteStore};
use crate::url;

/// leaders.ts: LEADERS_MAX_KEYS. Most keys one /api/leaders request names.
pub const LEADERS_MAX_KEYS: usize = 200;
/// leaders.ts: LEADERS_MAX_URL. Longest request URL /api/leaders answers, in characters: 200 keys
/// of the longest ids stay well under it.
pub const LEADERS_MAX_URL: usize = 12_000;
/// leaders.ts: RESEARCH_RECORD_NAME. The name a research record goes by as a leader (the one
/// Tighter shows for it).
pub const RESEARCH_RECORD_NAME: &str = "the research record";

/// leaders.ts: LeaderInfo. One problem's leader, as /api/leaders answers it.
#[derive(Serialize)]
struct LeaderInfo {
    score: f64,
    name: String,
    /// Submission id of the site entry; null for a research record.
    id: Option<f64>,
    /// A polygon leader's verification; absent for space problems.
    #[serde(skip_serializing_if = "Option::is_none")]
    verification: Option<String>,
    /// Present, true, when the leader is the problem's research record and not a site entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    research: Option<bool>,
}

/// leaders.ts: LeadersResponse.
#[derive(Serialize)]
struct LeadersResponse {
    leaders: IndexMap<String, Option<LeaderInfo>>,
    unknown: Vec<String>,
}

/// leaders.ts: POLYGON_KEY, `/^(0|[1-9]\d{0,2})\/(0|[1-9]\d{0,2})\/([1-9]\d{0,5})$/`: a polygon
/// problem written "N/M/P", without leading zeros.
fn polygon_key(key: &str) -> Option<(f64, f64, f64)> {
    let mut parts = key.split('/');
    let (n, m, p) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let shape = |s: &str| s == "0" || (digits(s) && s.len() <= 3 && !s.starts_with('0'));
    if !shape(n) || !shape(m) || !(digits(p) && p.len() <= 6 && !p.starts_with('0')) {
        return None;
    }
    Some((js::number(n), js::number(m), js::number(p)))
}

/// A key that names a problem of a space: what leaders.ts keeps of it in its `spaces` map.
struct SpaceAsked {
    space: String,
    id: String,
    certified: Option<f64>,
    open: bool,
}

/// leaders.ts: registerLeadersRoute, the route itself. GET /api/leaders?keys=<k1>,<k2>,...: the
/// current leader of each named problem, for a client that holds many records and checks them in
/// batches. A polygon problem's answer is its `site_best` of /api/problems/N/M/P (null when it is
/// closed or has no entry). A space problem's is the best value of
/// /api/spaces/<space>/problems/<id>: the research record when it is at least as good as the site
/// entry (that is `research: true`, `id` null), else the site entry. One indexed read per kind, no
/// configurations.
pub fn leaders_route(req: &Req, store: &Arc<Mutex<SqliteStore>>, spaces: Option<&Arc<dyn SpacesPort>>, closed: &dyn Fn(f64, f64, f64) -> bool) -> Handled {
    if js::utf16_len(&req.url) > LEADERS_MAX_URL {
        return Ok(hono::json_error(&format!("the URL is over {LEADERS_MAX_URL} characters"), 414));
    }
    let params = url::search_params(&req.url);
    let given: Vec<&String> = params.iter().filter(|(k, _)| k == "keys").map(|(_, v)| v).collect();
    let other = params.iter().any(|(k, _)| k != "keys");
    if given.len() != 1 || other {
        return Ok(hono::json_error("give keys once, as a comma-separated list: ?keys=3/3/5,sphere/0/12 (no other parameter)", 400));
    }
    let list: Vec<&str> = given[0].split(',').collect();
    if given[0].is_empty() || list.len() > LEADERS_MAX_KEYS {
        return Ok(hono::json_error(&format!("keys: from 1 to {LEADERS_MAX_KEYS} keys, comma-separated"), 400));
    }

    let mut unknown: Vec<String> = Vec::new();
    let mut polygons: IndexMap<String, ProblemKey> = IndexMap::new();
    let mut asked_spaces: IndexMap<String, SpaceAsked> = IndexMap::new();
    let mut seen: IndexSet<&str> = IndexSet::new();
    for key in list {
        if !seen.insert(key) {
            continue;
        }
        if let Some((n, m, p)) = polygon_key(key) {
            if is_shape_code_number(n) && is_shape_code_number(m) && p <= MAX_PIECES as f64 {
                polygons.insert(key.to_string(), ProblemKey { n, m, p });
            } else {
                unknown.push(key.to_string());
            }
            continue;
        }
        let space = key.split('/').next().unwrap_or("");
        let problem = match spaces {
            Some(s) if s.is_space_name(space) && s.has_catalogue(space) => s.problem_of(space, key),
            _ => None,
        };
        match problem {
            None => unknown.push(key.to_string()),
            Some(p) => {
                asked_spaces.insert(key.to_string(), SpaceAsked { space: space.to_string(), id: p.id, certified: p.certified_score, open: p.accepts_submissions });
            }
        }
    }

    let mut leaders: IndexMap<String, Option<LeaderInfo>> = IndexMap::new();
    // polygons: one read for the open problems; a closed one shows no site entry
    let open: Vec<ProblemKey> = polygons.values().filter(|p| !closed(p.n, p.m, p.p)).copied().collect();
    let key_of = |n: f64, m: f64, p: f64| format!("{}/{}/{}", fmt::num(n), fmt::num(m), fmt::num(p));
    let (found, entered) = {
        let store = store.lock().unwrap();
        let found: IndexMap<String, crate::store::ProblemLeader> = store.leaders_of(&open)?.into_iter().map(|l| (key_of(l.n, l.m, l.p), l)).collect();
        // spaces: one read for the open problems
        let wanted: Vec<SpaceProblem> = asked_spaces.values().filter(|s| s.open).map(|s| SpaceProblem { space: s.space.clone(), problem: s.id.clone() }).collect();
        let entered = if spaces.is_some() { store.space_leaders_of(&wanted)? } else { Vec::new() };
        (found, entered)
    };
    for (key, p) in &polygons {
        let l = found.get(&key_of(p.n, p.m, p.p));
        leaders.insert(
            key.clone(),
            match l {
                Some(l) if !closed(p.n, p.m, p.p) => Some(LeaderInfo { score: l.score, name: l.name.clone(), id: Some(l.id), verification: Some(l.verification.clone()), research: None }),
                _ => None,
            },
        );
    }
    let site: IndexMap<String, crate::store::SpaceLeader> = entered.into_iter().map(|l| (format!("{} {}", l.space, l.problem), l)).collect();
    for (key, s) in &asked_spaces {
        let lead = if s.open { site.get(&format!("{} {}", s.space, s.id)) } else { None };
        let cert = s.certified.filter(|c| *c > 0.0);
        leaders.insert(
            key.clone(),
            match (cert, lead) {
                (Some(c), lead) if lead.is_none_or(|l| c <= l.score) => Some(LeaderInfo { score: c, name: RESEARCH_RECORD_NAME.to_string(), id: None, verification: None, research: Some(true) }),
                (_, Some(l)) => Some(LeaderInfo { score: l.score, name: l.name.clone(), id: Some(l.id), verification: None, research: None }),
                _ => None,
            },
        );
    }
    // answered in the order the keys were asked
    let mut ordered: IndexMap<String, Option<LeaderInfo>> = IndexMap::new();
    for key in seen {
        if let Some(l) = leaders.swap_remove(key) {
            ordered.insert(key.to_string(), l);
        }
    }
    Ok(hono::json(&LeadersResponse { leaders: ordered, unknown }, 200))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polygon_keys() {
        assert_eq!(polygon_key("4/4/11"), Some((4.0, 4.0, 11.0)));
        assert_eq!(polygon_key("0/0/1"), Some((0.0, 0.0, 1.0)));
        assert_eq!(polygon_key("100/100/500"), Some((100.0, 100.0, 500.0)));
        assert_eq!(polygon_key("4/4/999999"), Some((4.0, 4.0, 999999.0)));
        for key in ["04/4/1", "4/4/0", "4/4/01", "4/4", "4/4/1/2", "x/4/1", "4/4/1234567", "1000/4/1", "", "4/4/", "-4/4/1", "4/4/1.5", "sphere/0/12"] {
            assert_eq!(polygon_key(key), None, "{key}");
        }
    }
}
