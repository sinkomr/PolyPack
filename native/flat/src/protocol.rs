//! Port of packages/geometry/src/protocol.ts: the types shared by the client, the server and
//! data/records.json, and the rules that compare a score with a published value or with a leader.
//!
//! The record and answer types are plain data. Those the server reads from JSON
//! ([`LiteratureRecord`], [`Pose`]) implement `Deserialize`. None implements `Serialize`: the
//! server's answers are written by `JSON.stringify`, whose numbers are JavaScript's
//! (`polypack_js::fmt::num`: 1e-7, not 0.0000001) and whose fields come in the order the route
//! builds them, so the writer belongs with the routes.

use crate::config::StrictResult;
use crate::math;
use crate::shapes::{Container, Pose};
use serde::Deserialize;
use serde_json::{Map, Value};

/// protocol.ts: RecordStatus.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordStatus {
    Proven,
    ProvenUnrefereed,
    BestKnown,
    TrivialTiling,
}

impl RecordStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordStatus::Proven => "proven",
            RecordStatus::ProvenUnrefereed => "proven_unrefereed",
            RecordStatus::BestKnown => "best_known",
            RecordStatus::TrivialTiling => "trivial_tiling",
        }
    }
}

/// protocol.ts: LiteratureRecord. One published value, already converted to the site conventions
/// (polygon side 1, disk diameter 1). The fields are in the source's order.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LiteratureRecord {
    #[serde(rename = "N")]
    pub n: u32,
    #[serde(rename = "M")]
    pub m: u32,
    #[serde(rename = "P")]
    pub p: u32,
    /// Container side (polygon) or diameter (circle) in site conventions.
    pub value: f64,
    /// The value as it can be quoted from the source after conversion, e.g. "2.44719+".
    pub display: String,
    /// Number of decimals of `value` that the source supports.
    pub display_precision: f64,
    pub status: RecordStatus,
    pub source_name: String,
    pub source_url: String,
    #[serde(default)]
    pub picture_url: Option<String>,
    /// ISO date on which the source was read.
    pub accessed: String,
    #[serde(default)]
    pub citation: Option<String>,
    /// How the source value was converted to site conventions.
    pub conversion_note: String,
    #[serde(default)]
    pub note: Option<String>,
    /// Where the coordinates come from, when not from the source of the value.
    #[serde(default)]
    pub coordinates_note: Option<String>,
    /// Coordinates, when available.
    #[serde(default)]
    pub pieces: Option<Vec<Pose>>,
    #[serde(default)]
    pub container_phi: Option<f64>,
}

/// protocol.ts: Verification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verification {
    None,
    Pending,
    Confirmed,
    Rejected,
}

impl Verification {
    pub fn as_str(self) -> &'static str {
        match self {
            Verification::None => "none",
            Verification::Pending => "pending",
            Verification::Confirmed => "confirmed",
            Verification::Rejected => "rejected",
        }
    }
}

/// protocol.ts: FOUND_WITH. How a submitted packing was found: by hand on the board, by a PolyPack
/// optimizer (unchanged, or edited by hand afterwards), or by the submitter's own software.
/// Entries stored before this was recorded, and legacy submissions that declared `agent: "ai"`
/// without it, have none (`null`).
pub const FOUND_WITH: [&str; 4] = ["hand", "optimizer", "optimizer_edited", "external"];

/// protocol.ts: FoundWith.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FoundWith {
    Hand,
    Optimizer,
    OptimizerEdited,
    External,
}

impl FoundWith {
    pub fn as_str(self) -> &'static str {
        match self {
            FoundWith::Hand => "hand",
            FoundWith::Optimizer => "optimizer",
            FoundWith::OptimizerEdited => "optimizer_edited",
            FoundWith::External => "external",
        }
    }

    /// The value with this name in FOUND_WITH.
    pub fn parse(name: &str) -> Option<FoundWith> {
        match name {
            "hand" => Some(FoundWith::Hand),
            "optimizer" => Some(FoundWith::Optimizer),
            "optimizer_edited" => Some(FoundWith::OptimizerEdited),
            "external" => Some(FoundWith::External),
            _ => None,
        }
    }
}

/// protocol.ts: RunBudget. Search budget of an optimizer run, as the solver takes it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RunBudget {
    pub evals: Option<f64>,
    pub time_s: Option<f64>,
}

/// protocol.ts: Provenance. How a stored entry was found, as GET /api/submissions/{id} returns it.
/// The method fields are set only for found_with "optimizer" and "optimizer_edited"; `software`
/// for those and "external". A JavaScript `null` is None.
#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    pub found_with: Option<FoundWith>,
    /// Registered PolyPack search method.
    pub method: Option<String>,
    /// The method's resolved parameters, as the body gave them.
    pub method_params: Option<Map<String, Value>>,
    /// A whole number from 0 to 2^53 - 1 (a double, as the source holds it; it can be -0).
    pub seed: Option<f64>,
    pub budget: Option<RunBudget>,
    /// Name of the submitter's own tool, or of the program that ran the optimizer.
    pub software: Option<String>,
}

/// protocol.ts: LeaderboardEntry.
#[derive(Clone, Debug, PartialEq)]
pub struct LeaderboardEntry {
    pub id: i64,
    pub name: String,
    pub found_with: Option<FoundWith>,
    pub agent_note: String,
    pub score: f64,
    pub created_at: String,
    pub verification: Verification,
}

/// protocol.ts: ProblemInfo. (`conventions` is the route's own table and is not held here.)
#[derive(Clone, Debug, PartialEq)]
pub struct ProblemInfo {
    pub n: u32,
    pub m: u32,
    pub p: u32,
    pub area_bound: f64,
    pub literature: Option<LiteratureRecord>,
    /// The leader of the problem; None when there is none or the problem is closed.
    pub site_best: Option<LeaderboardEntry>,
    /// False when the published optimum is proven: see [`closed_to_submissions`].
    pub accepts_submissions: bool,
}

/// protocol.ts: SubmitResponse.
#[derive(Clone, Debug, PartialEq)]
pub struct SubmitResponse {
    pub valid: bool,
    pub reasons: Vec<String>,
    pub score: Option<f64>,
    /// 1 when this entry is the problem's leader after it was stored, otherwise its position (at least 2).
    pub rank: Option<u32>,
    /// True exactly when `rank` is 1.
    pub leader: bool,
    /// Score of the problem's leader after this submission; None when nothing was stored.
    pub leader_score: Option<f64>,
    pub id: Option<i64>,
    pub container: Option<Container>,
    pub pending_verification: bool,
    pub strict_check: Option<StrictResult>,
}

/// protocol.ts: AtlasTile["source"].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AtlasSource {
    Site,
    Literature,
}

impl AtlasSource {
    pub fn as_str(self) -> &'static str {
        match self {
            AtlasSource::Site => "site",
            AtlasSource::Literature => "literature",
        }
    }
}

/// protocol.ts: AtlasTile. One drawing of the records atlas: the best configuration the site can
/// draw for one P.
#[derive(Clone, Debug, PartialEq)]
pub struct AtlasTile {
    pub p: u32,
    /// Where the coordinates come from.
    pub source: AtlasSource,
    /// Size of the drawn packing: the entry's score, or the published value.
    pub score: f64,
    pub pieces: Vec<Pose>,
    pub container_phi: f64,
    /// Submission id; site entries only.
    pub id: Option<i64>,
    /// Site entries only. Rejected entries are never listed.
    pub verification: Option<Verification>,
    /// Site entries only: how the entry was found (`Some(None)` is a site entry with `null`).
    pub found_with: Option<Option<FoundWith>>,
}

/// protocol.ts: AtlasResponse. Answer of GET /api/atlas: the drawable packings of one (N, M) for
/// P in [from, to].
#[derive(Clone, Debug, PartialEq)]
pub struct AtlasResponse {
    pub n: u32,
    pub m: u32,
    pub from: u32,
    pub to: u32,
    /// First P of the range that was left out to keep the response small; None when complete.
    pub next: Option<u32>,
    pub tiles: Vec<AtlasTile>,
}

/// protocol.ts: Holder. One name of GET /api/holders.
#[derive(Clone, Debug, PartialEq)]
pub struct Holder {
    pub name: String,
    /// Leading entries that are the record: at least as good as the published value, or without one.
    pub records: u32,
    /// Of `records`, those below the published value (see [`beats_literature`]).
    pub beat_published: u32,
    /// Leading entries, whatever their value.
    pub site_bests: u32,
    /// Of `site_bests`, claims awaiting review.
    pub pending: u32,
    /// The most `records` the name has held at once.
    pub peak: u32,
}

/// protocol.ts: HoldersResponse. Answer of GET /api/holders, most records first.
#[derive(Clone, Debug, PartialEq)]
pub struct HoldersResponse {
    pub holders: Vec<Holder>,
}

/// protocol.ts: HolderPair. One pair of shapes in the answer of GET /api/holder.
#[derive(Clone, Debug, PartialEq)]
pub struct HolderPair {
    pub n: u32,
    pub m: u32,
    /// The values of P of the pair that the name leads, ascending.
    pub p: Vec<u32>,
    pub records: u32,
    pub beat_published: u32,
    pub pending: u32,
}

/// protocol.ts: HolderResponse. Answer of GET /api/holder?name=.
#[derive(Clone, Debug, PartialEq)]
pub struct HolderResponse {
    pub holder: Holder,
    /// When the answer was made, as an ISO 8601 time (UTC).
    pub computed_at: String,
    pub pairs: Vec<HolderPair>,
}

/// protocol.ts: LeaderboardEvent. Sent to all viewers when a problem gets a new leader.
#[derive(Clone, Debug, PartialEq)]
pub struct LeaderboardEvent {
    pub n: u32,
    pub m: u32,
    pub p: u32,
    pub id: i64,
    pub score: f64,
    /// Always 1; kept for clients written when several rows were shown.
    pub rank: u32,
    pub name: String,
}

/// protocol.ts: MAX_EVENT_KEYS. Most keys one live-update stream may follow.
pub const MAX_EVENT_KEYS: usize = 100;

/// protocol.ts: eventKeys. The keys of a live-update stream that follows `problems` (N, M, P),
/// given in order of importance: one "N/M/P" each while they fit in `max`. Beyond that the pairs
/// with the most problems are followed whole ("N/M/*", which follows more than asked but nothing
/// less), and if that is still too many, the least important problems are left out.
pub fn event_keys(problems: &[(u32, u32, u32)], max: usize) -> Vec<String> {
    // [...new Set(...)]: the distinct keys in their first order
    let mut keys: Vec<String> = Vec::new();
    for &(n, m, p) in problems {
        let key = format!("{n}/{m}/{p}");
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let pair_of = |key: &str| key[..key.rfind('/').unwrap()].to_string();
    // a Map in insertion order
    let mut count: Vec<(String, usize)> = Vec::new();
    for k in &keys {
        let pair = pair_of(k);
        match count.iter_mut().find(|(q, _)| *q == pair) {
            Some((_, c)) => *c += 1,
            None => count.push((pair, 1)),
        }
    }
    let mut whole: Vec<String> = Vec::new();
    let mut size = keys.len();
    let mut sorted = count.clone();
    sorted.sort_by(|a, b| b.1.cmp(&a.1)); // stable, as Array.prototype.sort is
    for (pair, n) in sorted {
        if size <= max || n < 2 {
            break;
        }
        whole.push(pair);
        size -= n - 1;
    }
    // a pair followed whole takes the place of its most important problem
    let mut out: Vec<String> = Vec::new();
    for k in &keys {
        let pair = pair_of(k);
        let key = if whole.contains(&pair) { format!("{pair}/*") } else { k.clone() };
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out.truncate(max);
    out
}

/// protocol.ts: LEADERBOARD_SIZE. Number of leaderboard rows shown per problem: only the leader.
pub const LEADERBOARD_SIZE: usize = 1;

/// protocol.ts: SCORE_TIE. Relative score difference below which two entries count as equally
/// good. It has the magnitude of the validity tolerance TOL: a smaller improvement cannot be told
/// apart from the slack that validity already allows, so it must not take the lead from an earlier
/// entry.
///
/// The leader of a problem is the earliest listed entry whose score is within this tolerance of
/// the smallest listed score, i.e. score <= min * (1 + SCORE_TIE).
pub const SCORE_TIE: f64 = 1e-9;

/// protocol.ts: improvesOn. True when `score` is better than `leader_score` by more than the tie
/// tolerance.
pub fn improves_on(score: f64, leader_score: f64) -> bool {
    score < leader_score * (1.0 - SCORE_TIE)
}

/// protocol.ts: closedToSubmissions. True when a problem no longer takes submissions: its
/// published optimum is proven in the refereed literature or is a zero-waste tiling. An unrefereed
/// proof leaves the problem open, so that a counterexample can still be entered.
pub fn closed_to_submissions(rec: Option<&LiteratureRecord>) -> bool {
    matches!(rec, Some(r) if r.status == RecordStatus::Proven || r.status == RecordStatus::TrivialTiling)
}

/// protocol.ts: isProven.
pub fn is_proven(status: RecordStatus) -> bool {
    status != RecordStatus::BestKnown
}

/// protocol.ts: literatureTolerance. The uncertainty of a published value, 10^-display_precision
/// in the source's own unit, in the unit of the value. A polygon-in-circle value is the container
/// diameter, twice the radius the source printed, so its tolerance is doubled.
pub fn literature_tolerance(rec: &LiteratureRecord) -> f64 {
    pow10(-rec.display_precision) * (if rec.n > 0 && rec.m == 0 { 2.0 } else { 1.0 })
}

/// `Math.pow(10, e)`. For a whole exponent V8 returns the correctly rounded power of ten, the
/// double of the literal `1e-5` (checked on Node 26 for every exponent from -320 to 30), while
/// `polypack_js::math::pow`, which is fdlibm's, is one unit in the last place below it for 1e-5,
/// the precision of a third of the records. So a whole exponent is read as that literal, and any
/// other goes to `math::pow`.
fn pow10(e: f64) -> f64 {
    if e.trunc() == e && (-323.0..=308.0).contains(&e) {
        format!("1e{}", e as i32).parse().expect("a power of ten")
    } else {
        math::pow(10.0, e)
    }
}

/// protocol.ts: beatsLiterature. True when a score is below the published value by more than the
/// source's display precision (see [`literature_tolerance`]).
pub fn beats_literature(score: f64, rec: &LiteratureRecord) -> bool {
    score < rec.value - literature_tolerance(rec)
}

/// protocol.ts: reachesLiterature. True when a score is at least as good as the published value,
/// to the precision the source prints. Never finer than 1e-9, so that a re-derived optimum such as
/// 3.0000000000000004 still reaches 3.
pub fn reaches_literature(score: f64, rec: &LiteratureRecord) -> bool {
    score <= rec.value + math::max(literature_tolerance(rec), 1e-9)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_keys_follow_whole_pairs_when_the_keys_do_not_fit() {
        let problems = [(4, 4, 5), (4, 4, 6), (3, 0, 2), (4, 4, 5), (4, 4, 7), (3, 0, 9), (6, 6, 1)];
        assert_eq!(event_keys(&problems, 100), ["4/4/5", "4/4/6", "3/0/2", "4/4/7", "3/0/9", "6/6/1"]);
        assert_eq!(event_keys(&problems, 4), ["4/4/*", "3/0/2", "3/0/9", "6/6/1"]);
        assert_eq!(event_keys(&problems, 3), ["4/4/*", "3/0/*", "6/6/1"]);
        assert_eq!(event_keys(&problems, 2), ["4/4/*", "3/0/*"]);
    }
}
