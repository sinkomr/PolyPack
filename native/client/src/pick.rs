//! Which problem to search next (apps/volunteer/src/pick.ts, flat problems): one drawn uniformly
//! at random from every problem this client may search, with or without a record: N and M a
//! circle (0) or 3 to 100 sides and P from 1 to 500, narrowed by --N, --M and --max-P. A problem
//! this machine searched in the last week is drawn again at most RECENT_TRIES - 1 times in a row;
//! problems to skip (closed, unreadable, being searched by another slot) are never drawn.

use polypack_flat::rng::Rng;
use polypack_flat::shapes::Problem;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const RECENT_MS: i64 = 7 * 24 * 3600_000;
pub const RECENT_TRIES: usize = 20;
pub const DRAW_TRIES: usize = 1000;

pub fn shape_codes() -> Vec<u32> {
    std::iter::once(0).chain(3..=100).collect()
}

pub struct FlatKind {
    pub ns: Vec<u32>,
    pub ms: Vec<u32>,
    pub max_p: usize,
}

impl FlatKind {
    pub fn new(n: Option<&Vec<u32>>, m: Option<&Vec<u32>>, max_p: Option<usize>) -> Self {
        FlatKind {
            ns: n.cloned().unwrap_or_else(shape_codes),
            ms: m.cloned().unwrap_or_else(shape_codes),
            max_p: max_p.unwrap_or(500).min(500),
        }
    }

    pub fn size(&self) -> usize {
        self.ns.len() * self.ms.len() * self.max_p
    }

    fn draw(&self, rng: &mut Rng) -> Problem {
        let n = self.ns[rng.below(self.ns.len())];
        let m = self.ms[rng.below(self.ms.len())];
        let p = 1 + rng.below(self.max_p);
        Problem::new(n, m, p)
    }
}

/// Records one finished search (not one cut short by a signal or --hours). A dry run's search
/// counts for later dry runs only: a real run must still search the problem and submit.
pub fn note_search(recent: &mut HashMap<String, i64>, line: &Value, dry_run: bool) {
    let stopped = line.get("stopped").and_then(|s| s.as_str()).unwrap_or("");
    if matches!(stopped, "aborted" | "interrupted" | "crashed") {
        return;
    }
    let was_dry = line.get("dry_run").and_then(|d| d.as_bool()) == Some(true) || line.get("decision").and_then(|d| d.as_str()) == Some("dry run: would submit");
    if !dry_run && was_dry {
        return;
    }
    // space lines (written by the JavaScript client into its own directory) have no M
    let (Some(n), Some(m), Some(p)) = (line.get("N").and_then(|x| x.as_u64()), line.get("M").and_then(|x| x.as_u64()), line.get("P").and_then(|x| x.as_u64())) else {
        return;
    };
    let Some(time) = line.get("time").and_then(|t| t.as_str()).and_then(crate::format::parse_iso) else { return };
    let key = format!("{n}-{m}-{p}");
    let e = recent.entry(key).or_insert(time);
    if *e < time {
        *e = time;
    }
}

pub fn prune_recent(recent: &mut HashMap<String, i64>, now: i64) {
    recent.retain(|_, t| now - *t < RECENT_MS);
}

/// The next problem: a uniform draw not in `skip`, and not searched here within a week unless
/// RECENT_TRIES draws in a row were. None when DRAW_TRIES draws found only problems to skip.
pub fn draw_problem(kind: &FlatKind, recent: &HashMap<String, i64>, skip: &HashSet<String>, now: i64, rng: &mut Rng) -> Option<Problem> {
    if kind.size() == 0 {
        return None;
    }
    let mut recent_in_a_row = 0;
    for _ in 0..DRAW_TRIES {
        let d = kind.draw(rng);
        let key = d.key();
        if skip.contains(&key) {
            continue;
        }
        if recent.get(&key).map_or(false, |t| now - t < RECENT_MS) {
            recent_in_a_row += 1;
            if recent_in_a_row < RECENT_TRIES {
                continue;
            }
        }
        return Some(d);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_within_filters() {
        let kind = FlatKind::new(Some(&vec![4]), Some(&vec![0, 4]), Some(10));
        assert_eq!(kind.size(), 20);
        let mut rng = Rng::new(3);
        let recent = HashMap::new();
        let mut skip = HashSet::new();
        for _ in 0..200 {
            let p = draw_problem(&kind, &recent, &skip, 0, &mut rng).unwrap();
            assert!(p.n == 4 && (p.m == 0 || p.m == 4) && (1..=10).contains(&p.p));
        }
        for m in [0, 4] {
            for p in 1..=10 {
                skip.insert(format!("4-{m}-{p}"));
            }
        }
        assert!(draw_problem(&kind, &recent, &skip, 0, &mut rng).is_none());
    }
}
