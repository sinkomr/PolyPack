//! The HTTP contract of the spaces: polyhedral surfaces, constant curvature, the whole sphere,
//! flat tori, the boundaries of polytopes, polyhedra in polyhedra, balls, and n dimensions. Port of
//! packages/spaces/src/types.ts.
//!
//! The server answers with these shapes. Each one serializes (through `polypack_js::json::stringify`)
//! to the TypeScript's JSON: the keys in the order the source builds the object, a field that is
//! `undefined` there left out, `null` written as `null`.
//!
//! Two kinds of value are listed side by side and never mixed up:
//!  - `certified`: the research record shipped in data/<space>/records.json, proven valid with
//!    interval arithmetic by python/<space>/ (its `score_cert`);
//!  - `site_best`: the best entry submitted to the site, checked by the server's floating-point
//!    validator of that space with PolyPack's usual tolerance, like every other site entry.

use polypack_js::fmt;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;

/// types.ts: `SpaceName`. Spaces that take submissions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SpaceName {
    Surface,
    Curved,
    Sphere,
    Torus,
    Boundary,
    Polyhedra,
    Balls,
    Ndim,
}

/// types.ts: `SPACE_NAMES`, in its order.
pub const SPACE_NAMES: [SpaceName; 8] = [
    SpaceName::Surface,
    SpaceName::Curved,
    SpaceName::Sphere,
    SpaceName::Torus,
    SpaceName::Boundary,
    SpaceName::Polyhedra,
    SpaceName::Balls,
    SpaceName::Ndim,
];

impl SpaceName {
    /// The name as ids and the API write it.
    pub const fn as_str(self) -> &'static str {
        match self {
            SpaceName::Surface => "surface",
            SpaceName::Curved => "curved",
            SpaceName::Sphere => "sphere",
            SpaceName::Torus => "torus",
            SpaceName::Boundary => "boundary",
            SpaceName::Polyhedra => "polyhedra",
            SpaceName::Balls => "balls",
            SpaceName::Ndim => "ndim",
        }
    }

    /// The space of a name, or None (`isSpaceName(v) ? v : undefined`).
    pub fn parse(name: &str) -> Option<SpaceName> {
        SPACE_NAMES.into_iter().find(|s| s.as_str() == name)
    }

    /// The place of the space in `SPACE_NAMES` (the key of a table by space).
    pub const fn index(self) -> usize {
        self as usize
    }
}

impl std::fmt::Display for SpaceName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for SpaceName {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// types.ts: `isSpaceName`, for a string.
pub fn is_space_name(v: &str) -> bool {
    SpaceName::parse(v).is_some()
}

/// types.ts: `isSpaceName`, for any JSON value (`v: unknown`): a string that names a space.
pub fn is_space_name_value(v: &Value) -> bool {
    v.as_str().is_some_and(is_space_name)
}

/// types.ts: `SPACE_NAMES` as strings, for a caller that keeps no enum (the database layer's
/// `SpaceIds::space_names`).
pub fn space_names() -> Vec<String> {
    SPACE_NAMES.iter().map(|s| s.as_str().to_string()).collect()
}

/// A field of a parsed problem id: `string | number`.
#[derive(Clone, Debug, PartialEq)]
pub enum Field {
    Number(f64),
    Text(String),
}

impl Field {
    /// `String(field)`: what a template string writes.
    pub fn js_string(&self) -> String {
        match self {
            Field::Number(x) => fmt::num(*x),
            Field::Text(s) => s.clone(),
        }
    }

    /// `Number(field)`: a number is itself; a string is read as JavaScript reads one (the fields
    /// that are strings are names, which are NaN).
    pub fn js_number(&self) -> f64 {
        match self {
            Field::Number(x) => *x,
            Field::Text(s) => {
                // a decimal number as the ids write one; any other text (a name) is NaN. JavaScript
                // also reads "", "0x10" and "Infinity" as numbers, which no field of an id is.
                let decimal = !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'));
                if decimal {
                    s.parse::<f64>().unwrap_or(f64::NAN)
                } else {
                    f64::NAN
                }
            }
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Field::Number(x) => Some(*x),
            Field::Text(_) => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Field::Number(_) => None,
            Field::Text(s) => Some(s),
        }
    }
}

impl Serialize for Field {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Field::Number(x) => serializer.serialize_f64(*x),
            Field::Text(s) => serializer.serialize_str(s),
        }
    }
}

/// The fields of a problem id, `Record<string, string | number>`, in the order `parseSpaceId`
/// writes them: surface {solid, mode, N, P}; curved {K, N, M, P}; sphere {N, P}; torus {family, N,
/// P}; boundary {polytope, piece, P}; polyhedra and balls {code, piece, container, P}; ndim {d,
/// piece, container, P}. (No key is an array index, so the order written is the order of insertion.)
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Fields(pub Vec<(&'static str, Field)>);

impl Fields {
    /// `fields[key]`, None for `undefined`.
    pub fn get(&self, key: &str) -> Option<&Field> {
        self.0.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }

    /// `fields[key] as number`: NaN when the field is absent or a string.
    pub fn number(&self, key: &str) -> f64 {
        self.get(key).and_then(Field::as_number).unwrap_or(f64::NAN)
    }

    /// `fields[key] as string`: "" when the field is absent or a number.
    pub fn text(&self, key: &str) -> &str {
        self.get(key).and_then(Field::as_text).unwrap_or("")
    }

    /// `String(fields[key])`: "undefined" for an absent field.
    pub fn js_string(&self, key: &str) -> String {
        self.get(key).map_or_else(|| "undefined".to_string(), Field::js_string)
    }
}

impl Serialize for Fields {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// types.ts: `CertifiedStatus`. Status of a research record: `proven` only with a published proof;
/// `infeasible` = no packing exists (proved).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CertifiedStatus {
    BestKnown,
    Proven,
    Infeasible,
}

impl CertifiedStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            CertifiedStatus::BestKnown => "best_known",
            CertifiedStatus::Proven => "proven",
            CertifiedStatus::Infeasible => "infeasible",
        }
    }
}

/// types.ts: `SpaceProblemStatus`. Status of a problem: its research record's, or `no_record` for a
/// problem of the space's domain that has no research record yet. Such a problem takes entries;
/// its best value is the site's, none until a first entry is kept, and every entry must pass the
/// strict check (validate.rs).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpaceProblemStatus {
    BestKnown,
    Proven,
    Infeasible,
    NoRecord,
}

impl SpaceProblemStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            SpaceProblemStatus::BestKnown => "best_known",
            SpaceProblemStatus::Proven => "proven",
            SpaceProblemStatus::Infeasible => "infeasible",
            SpaceProblemStatus::NoRecord => "no_record",
        }
    }
}

impl From<CertifiedStatus> for SpaceProblemStatus {
    fn from(s: CertifiedStatus) -> Self {
        match s {
            CertifiedStatus::BestKnown => SpaceProblemStatus::BestKnown,
            CertifiedStatus::Proven => SpaceProblemStatus::Proven,
            CertifiedStatus::Infeasible => SpaceProblemStatus::Infeasible,
        }
    }
}

/// An object of strings by string keys, written in the order of the list (as `JSON.stringify`
/// writes an object whose keys were set in that order and are no array indices).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Texts(pub Vec<(String, String)>);

impl Texts {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

impl Serialize for Texts {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// types.ts: `SpaceInfo`. A space as GET /api/spaces lists it. The keys are written in the order
/// the server builds the object: those of `SPACE_INFO` (info.rs), then `problems`, `records` and
/// `domain`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceInfo {
    pub space: SpaceName,
    pub title: String,
    /// One or two plain sentences.
    pub summary: String,
    /// What the score measures, smaller is better.
    pub score: String,
    /// The id pattern, e.g. "surface/<solid>/<mode>/<N>/<P>".
    pub problem_id: String,
    /// Units, pose and container conventions, as short sentences keyed by topic.
    pub conventions: Texts,
    /// Path of the static viewer, e.g. "/spaces/surface.html"; empty when the space has none yet.
    pub viewer: String,
    /// URL of the space's notes on GitHub.
    pub docs: String,
    /// Problems of the space: the size of its domain when it has one, else its research records
    /// (infeasible ones included).
    pub problems: f64,
    /// Problems with a research record; the others of the domain have none yet (status `no_record`).
    pub records: usize,
    /// The space's domain, when its problems are given by one (domain.rs): `SpaceDomainInfo` as JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<Value>,
}

/// types.ts: `SpaceExhibit`. Research material that is shown but takes no submissions (the
/// curvature sweeps).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpaceExhibit {
    pub name: String,
    pub title: String,
    pub summary: String,
    pub viewer: String,
    pub docs: String,
}

/// types.ts: `SpacesResponse`. GET /api/spaces.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpacesResponse {
    pub spaces: Vec<SpaceInfo>,
    pub exhibits: Vec<SpaceExhibit>,
}

/// types.ts: `CertifiedValue`. The research record of a problem, without its configuration.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CertifiedValue {
    /// score_cert: the size at which the stored configuration is proven valid.
    pub score: f64,
    /// score_cert rounded to the nearest at 6 decimals.
    pub display: String,
    pub status: CertifiedStatus,
}

/// A lower bound on the score and what it rests on: `{ value, label }`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Bound {
    pub value: f64,
    pub label: String,
}

/// types.ts: `SiteBest`. The leading site entry of a problem, without its configuration.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SiteBest {
    pub id: i64,
    pub score: f64,
    pub name: String,
    pub created_at: String,
}

/// The nofold value of a boundary record and what it rests on.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Nofold {
    pub value: f64,
    pub label: String,
}

/// types.ts: `SpaceProblemExtra`. Values a research record of some spaces carries besides its score
/// and bound. Only the boundary space has them: `nofold` is the best edge when every piece must
/// stay inside one cell, and `fold_gain` = 1 - score_float / nofold.value.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceProblemExtra {
    /// null when the record has none.
    pub nofold: Option<Nofold>,
    /// The research record's relative gain over nofold, from 0 to 1; null when the record has none.
    pub fold_gain: Option<f64>,
}

/// types.ts: `SpaceProblemSummary`. One problem as a listing shows it (no configurations), with the
/// keys in the order `spaceProblemSummary` (records.rs) writes them.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceProblemSummary {
    pub space: SpaceName,
    /// The problem id, e.g. "surface/cube/fold/0/12".
    pub id: String,
    pub fields: Fields,
    #[serde(rename = "P")]
    pub p: u32,
    /// The problem's status (always sent).
    pub status: SpaceProblemStatus,
    pub certified: Option<CertifiedValue>,
    /// Best lower bound on the score shipped with the record, and what it rests on.
    pub bound: Option<Bound>,
    pub site_best: Option<SiteBest>,
    /// The smaller of certified.score and site_best.score; null when there is neither.
    pub best_score: Option<f64>,
    /// False for proven and infeasible problems.
    pub accepts_submissions: bool,
    /// Why the problem takes no submissions; null when it is open (always sent).
    pub closed_reason: Option<String>,
    /// Sent for boundary problems only: the research record's nofold comparison.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<SpaceProblemExtra>,
}

/// types.ts: `SpaceRecordsResponse`. GET /api/spaces/:space/records.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceRecordsResponse {
    pub space: SpaceName,
    pub generated_at: String,
    pub problems: Vec<SpaceProblemSummary>,
}

/// types.ts: `SpaceSiteOnlyResponse`. GET /api/spaces/:space/site-only?limit=&after=.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceSiteOnlyResponse {
    pub space: SpaceName,
    pub generated_at: String,
    pub problems: Vec<SpaceProblemSummary>,
    pub next: Option<String>,
}

/// types.ts: `SpaceProblemResponse` without its two configurations, which the server appends as
/// raw JSON text (`certified_config`, `site_config`): the summary's keys, then `conventions`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceProblemHead {
    #[serde(flatten)]
    pub summary: SpaceProblemSummary,
    pub conventions: Texts,
}

/// types.ts: `SpaceEntryResponse` without its configuration, which the server appends as raw JSON
/// text (`config`). GET /api/spaces/entries/:id.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceEntryHead {
    pub id: i64,
    pub space: SpaceName,
    /// The problem id.
    pub problem: String,
    pub score: f64,
    pub name: String,
    pub agent_note: String,
    pub software: Option<String>,
    pub method: Option<String>,
    pub seed: Option<f64>,
    pub created_at: String,
}

/// types.ts: `SpaceSubmitResponse`. The answer of POST /api/spaces/submit.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceSubmitResponse {
    pub valid: bool,
    pub reasons: Vec<String>,
    /// The score the server computed from the configuration.
    pub score: Option<f64>,
    /// True when the entry now leads the site entries of its problem.
    pub leader: bool,
    /// The problem's best score after this submission (certified or site).
    pub best_score: Option<f64>,
    /// Entry id when it was kept (only the leader of a problem is kept).
    pub id: Option<i64>,
    /// True when the score is below the research record's score_cert.
    pub beats_certified: bool,
    /// `Some(false)` when the server did not check the configuration because its stated score could
    /// not be kept anyway; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
}
