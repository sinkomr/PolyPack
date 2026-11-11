//! The domain of the nD in nD space for the spaces listing (packages/ndspace/src/domain.ts; the
//! interface is packages/spaces/src/domain.ts): every ordered pair of a dimension's shapes with the
//! dimension's P range. Problems are defined by ranges and never enumerated here except by
//! `ndim_domain_sample`.
use super::bounds::{nd_bound_entry, NdBoundEntry};
use super::catalogue::{
    format_nd_id, nd_in_range, nd_p_range, nd_problem_count_all, nd_shape_names, nd_shape_title, nd_shapes,
    ND_DIMENSIONS, ND_MAX_P,
};
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

/// An object with string keys, in the order JavaScript lists its properties (and so the order
/// `JSON.stringify` writes them): the keys that are array indices ("4", "122") first, ascending, then
/// the others in the order they were added.
#[derive(Debug, Clone, PartialEq)]
pub struct JsObject<T>(pub Vec<(String, T)>);

impl<T> JsObject<T> {
    /// `Object.fromEntries(entries)`.
    pub fn from_entries(entries: Vec<(String, T)>) -> Self {
        // a canonical array index: digits without a leading zero, below 2^32 - 1
        let index = |k: &str| -> Option<u32> {
            let canonical = k == "0" || (!k.is_empty() && !k.starts_with('0') && k.bytes().all(|c| c.is_ascii_digit()));
            if canonical {
                k.parse::<u32>().ok().filter(|&v| v != u32::MAX)
            } else {
                None
            }
        };
        let mut numbered: Vec<(u32, (String, T))> = Vec::new();
        let mut named: Vec<(String, T)> = Vec::new();
        for (k, v) in entries {
            // a key given twice keeps its first place and takes the last value
            if let Some(at) = numbered.iter().position(|(_, (q, _))| *q == k) {
                numbered[at].1 .1 = v;
            } else if let Some(at) = named.iter().position(|(q, _)| *q == k) {
                named[at].1 = v;
            } else {
                match index(&k) {
                    Some(i) => numbered.push((i, (k, v))),
                    None => named.push((k, v)),
                }
            }
        }
        numbered.sort_by_key(|(i, _)| *i);
        JsObject(numbered.into_iter().map(|(_, e)| e).chain(named).collect())
    }
    pub fn get(&self, key: &str) -> Option<&T> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

impl<T: Serialize> Serialize for JsObject<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// packages/spaces/src/domain.ts: SpaceDomainField.dependent. For a field whose values or range
/// depend on the value of another field: the other field's key and, by its value, the values or the
/// [min, max] range that hold.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NdDependent {
    pub on: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<JsObject<Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranges: Option<JsObject<(u32, u32)>>,
}

/// packages/spaces/src/domain.ts: SpaceDomainField, with the fields this space uses, in the order
/// the source's object literals have them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NdDomainField {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub titles: Option<JsObject<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependent: Option<NdDependent>,
}

/// packages/spaces/src/domain.ts: SpaceDomainInfo. What /api/spaces says about the domain.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NdDomainInfo {
    pub id: String,
    pub fields: Vec<NdDomainField>,
    pub problems: u64,
}

/// packages/ndspace/src/domain.ts: ndimDomain.info.
pub fn ndim_domain_info() -> NdDomainInfo {
    let names: Vec<String> = nd_shape_names().iter().map(|s| s.to_string()).collect();
    // the object `shapeValues`
    let shape_field = |key: &str, label: &str| NdDomainField {
        key: key.into(),
        label: label.into(),
        values: Some(names.clone()),
        titles: Some(JsObject::from_entries(names.iter().map(|n| (n.clone(), nd_shape_title(n))).collect())),
        min: None,
        max: None,
        // a field whose values depend on the dimension (the shapes of each, the P range of each)
        dependent: Some(NdDependent {
            on: "d".into(),
            values: Some(JsObject::from_entries(
                ND_DIMENSIONS
                    .iter()
                    .map(|&d| (d.to_string(), nd_shapes(d).iter().map(|s| s.to_string()).collect()))
                    .collect(),
            )),
            ranges: None,
        }),
    };
    NdDomainInfo {
        id: "ndim/<d>/<piece>/<container>/<P>".into(),
        fields: vec![
            NdDomainField {
                key: "d".into(),
                label: "Dimension".into(),
                values: Some(ND_DIMENSIONS.iter().map(|d| d.to_string()).collect()),
                titles: None,
                min: None,
                max: None,
                dependent: None,
            },
            shape_field("piece", "Piece"),
            shape_field("container", "Container"),
            NdDomainField {
                key: "P".into(),
                label: "Pieces (P)".into(),
                values: None,
                titles: None,
                min: Some(2),
                max: Some(ND_MAX_P),
                dependent: Some(NdDependent {
                    on: "d".into(),
                    values: None,
                    ranges: Some(JsObject::from_entries(
                        ND_DIMENSIONS
                            .iter()
                            .map(|&d| (d.to_string(), nd_p_range(d).expect("a dimension of the space")))
                            .collect(),
                    )),
                }),
            },
        ],
        problems: nd_problem_count_all(),
    }
}

/// `JSON.stringify(ndimDomain.info)`: the same text, key for key.
pub fn ndim_domain_info_json() -> String {
    polypack_js::json::stringify(&ndim_domain_info())
}

/// packages/ndspace/src/domain.ts: ndimDomain.bound. The lower bound of a problem of the domain, or
/// None (the source's `undefined`) when the id lies outside the domain: a shape the dimension does
/// not have, or P outside the dimension's range.
pub fn ndim_domain_bound(d: u32, piece: &str, container: &str, p: u32) -> Option<NdBoundEntry> {
    let shapes = nd_shapes(d);
    if !shapes.contains(&piece) || !shapes.contains(&container) || !nd_in_range(d, p) {
        return None;
    }
    // the shapes are the dimension's, so the bound does not fail
    nd_bound_entry(d, piece, container, p).ok()
}

/// packages/ndspace/src/domain.ts: ndimDomain.sample. Small P first, dimension by dimension: the
/// first problems of each dimension's pairs.
pub fn ndim_domain_sample(limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in 2..=ND_MAX_P {
        for d in ND_DIMENSIONS {
            if !nd_in_range(d, p) {
                continue;
            }
            for a in nd_shapes(d) {
                for b in nd_shapes(d) {
                    if out.len() >= limit {
                        return out;
                    }
                    out.push(format_nd_id(d, a, b, p));
                }
            }
        }
    }
    out
}
