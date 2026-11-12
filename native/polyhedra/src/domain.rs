//! Solid pairs and piece ranges, independent of the research records: every ordered pair of the 186 solids,
//! P = 2 to 500. Port of `packages/polyhedra/src/domain.ts` (`polyhedraDomain`).
//!
//! The board picks the piece and the container in two menus (grouped by the solids' families); the code of the
//! problem is the two solids' codes joined by "in" (catalogue.rs).
//!
//! The types serialise as the source's object does with JSON.stringify: the same fields in the same order, and
//! the `titles` and `groups` records in the order their keys were set.

use crate::catalogue::{pair_count, solid_group, PROBLEM_ORDER, SOLIDS_BY_GROUP};
use crate::info::POLYHEDRA_MAX_P;
use crate::problems::{get_problem, volume_bound};
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

/// A JavaScript record of strings in the order its keys were set (`Object.fromEntries` of a list of pairs).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Record(pub Vec<(String, String)>);

impl Record {
    /// `Object.fromEntries`: a later pair with the same key replaces the value and keeps the first one's place.
    pub fn from_entries(entries: impl IntoIterator<Item = (String, String)>) -> Record {
        let mut out: Vec<(String, String)> = Vec::new();
        for (k, v) in entries {
            match out.iter_mut().find(|(key, _)| *key == k) {
                Some(slot) => slot.1 = v,
                None => out.push((k, v)),
            }
        }
        Record(out)
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

impl Serialize for Record {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// One field of a domain's ids (packages/spaces/src/domain.ts: SpaceDomainField, the parts this family and the
/// balls family use): a list of values with their titles and groups, or a range of integers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DomainField {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub titles: Option<Record>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Record>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<u64>,
}

/// packages/spaces/src/domain.ts: SpaceDomainJoin: an id field written from two picker fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DomainJoin {
    pub key: String,
    pub parts: Vec<String>,
    pub separator: String,
}

/// packages/spaces/src/domain.ts: SpaceDomainInfo: what /api/spaces says about a domain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DomainInfo {
    pub id: String,
    pub fields: Vec<DomainField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub joined: Option<Vec<DomainJoin>>,
    pub problems: u64,
}

/// What a domain's `bound` answers: the lower bound of a problem and the words of a listing.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DomainBound {
    pub value: f64,
    pub label: String,
}

/// `domain.ts: SOLID_VALUES`: the values of the piece and the container menus: the solids' codes, by family.
fn solid_values(key: &str, label: &str) -> DomainField {
    DomainField {
        key: key.to_string(),
        label: label.to_string(),
        values: Some(SOLIDS_BY_GROUP.iter().map(|s| s.code.clone()).collect()),
        titles: Some(Record::from_entries(SOLIDS_BY_GROUP.iter().map(|s| (s.code.clone(), s.title.clone())))),
        groups: Some(Record::from_entries(
            SOLIDS_BY_GROUP.iter().map(|s| (s.code.clone(), solid_group(s.family).to_string())),
        )),
        min: None,
        max: None,
    }
}

/// `domain.ts: polyhedraDomain.info`.
pub fn polyhedra_domain_info() -> DomainInfo {
    DomainInfo {
        // written from the two menus; a page loaded before the pairs (which builds the id from the fields' names)
        // still composes it
        id: "polyhedra/<piece>in<container>/<P>".to_string(),
        fields: vec![
            solid_values("piece", "Piece"),
            solid_values("container", "Container"),
            DomainField {
                key: "P".to_string(),
                label: "Pieces (P)".to_string(),
                values: None,
                titles: None,
                groups: None,
                min: Some(2),
                max: Some(POLYHEDRA_MAX_P as u64),
            },
        ],
        joined: Some(vec![DomainJoin {
            key: "code".to_string(),
            parts: vec!["piece".to_string(), "container".to_string()],
            separator: "in".to_string(),
        }]),
        problems: (pair_count() * (POLYHEDRA_MAX_P - 1)) as u64,
    }
}

/// `domain.ts: polyhedraDomain.bound`: the volume bound of the problem `code` with P pieces, or None when the
/// code names no pair of solids or P is not a whole number from 2 to POLYHEDRA_MAX_P (the source's `undefined`).
/// `p` is the id's P as the number it is in the source.
pub fn polyhedra_domain_bound(code: &str, p: f64) -> Option<DomainBound> {
    let problem = get_problem(code)?;
    // !Number.isInteger(P) || P < 2 || P > POLYHEDRA_MAX_P
    if !(p.is_finite() && p == p.trunc()) || p < 2.0 || p > POLYHEDRA_MAX_P as f64 {
        return None;
    }
    let value = volume_bound(&problem, p).ok()?;
    Some(DomainBound { value, label: "volume bound; [CALC]".to_string() })
}

/// `domain.ts: polyhedraDomain.sample`: at most `limit` ids: only the unrecorded range of the 150 problems of
/// the research records, small P first, as the volunteers' work list offered them until it was removed on
/// 2026-10-29. Every pair is open to entries, and the volunteer client now draws from all of them at random.
pub fn polyhedra_domain_sample(limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    for p in 101..=POLYHEDRA_MAX_P {
        for code in PROBLEM_ORDER.iter() {
            if out.len() >= limit {
                return out;
            }
            out.push(format!("polyhedra/{code}/{p}"));
        }
    }
    out
}
