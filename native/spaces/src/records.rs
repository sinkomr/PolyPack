//! The catalogue of a space: its research records (data/<space>/records.json) reduced to what the
//! site needs, one compact entry per problem, with the configuration kept as JSON text. Port of
//! packages/spaces/src/records.ts. Pure: the caller reads the file (see load.rs) and passes the
//! parsed JSON, which can then be dropped.
//!
//! A space whose records file keeps the configurations apart (polyhedra, balls and ndim:
//! data/<space>/configs/<file>.jsonl, one line per P, which each record's `config_at` locates) has
//! entries without configuration text (`config_apart`, `config_at`); load.rs then gives the
//! catalogue a loader that reads one on demand.
//!
//! A space may also have a domain (domain.rs): then every id of its domain is a problem, and one
//! without a record is made on demand (`problem_of`) with the status `no_record`, its bound and no
//! certified value or configuration.
//!
//! A catalogue is built once and read from many threads: it is `Send + Sync`, and its entries are
//! shared (`Arc`).

use crate::domain::{domain_max_p, SpaceDomain};
use crate::ids::{parse_space_id_value, surface_solids, ParsedSpaceId, BOUNDARY_PIECES, BOUNDARY_POLYTOPES, SURFACE_MODES, TORUS_FAMILIES};
use crate::load::ConfigLoader;
use crate::types::{
    Bound, CertifiedStatus, CertifiedValue, Field, Fields, Nofold, SiteBest, SpaceName, SpaceProblemExtra, SpaceProblemStatus,
    SpaceProblemSummary,
};
use crate::validate::{parse_space_config, Parsed};
use polypack_balls::BALLS_CODES;
use polypack_js::{fmt, json, math};
use polypack_ndim::space::nd_shape_names;
use polypack_polyhedra::PROBLEM_ORDER;
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

/// records.ts: `SpaceProblemEntry`. One problem of a catalogue.
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceProblemEntry {
    pub space: SpaceName,
    pub id: String,
    pub fields: Fields,
    /// The number of pieces (the source's field `P`).
    pub p: u32,
    /// The research record's status, or `no_record` for a problem of the domain without one (`problem_of`).
    pub status: SpaceProblemStatus,
    /// The research record's certified value; None for infeasible problems.
    pub certified: Option<CertifiedValue>,
    pub bound: Option<Bound>,
    /// Why the problem takes no submissions (proven or infeasible); None when it is open.
    pub closed_reason: Option<String>,
    /// The research record's configuration in the space's format, as JSON text; None when there is
    /// none (infeasible). Its stated size is score_cert for curved, sphere, boundary and polyhedra,
    /// and score_float for surface and torus, whose certificates shrink the pieces instead.
    pub config: Option<String>,
    /// True when the configuration is kept in a file of its own and read on demand
    /// (`entry_config`); the source's optional `configApart`.
    pub config_apart: bool,
    /// Where it is in that file: the byte offset and length of its line (the record's config_at).
    pub config_at: Option<(u64, u64)>,
    /// The nofold comparison (boundary only); absent for the other spaces.
    pub extra: Option<SpaceProblemExtra>,
}

/// records.ts: `SpaceCatalogue`.
pub struct SpaceCatalogue {
    pub space: SpaceName,
    /// The records file's `generated` field.
    pub generated: Option<String>,
    pub problems: Vec<Arc<SpaceProblemEntry>>,
    pub by_id: HashMap<String, Arc<SpaceProblemEntry>>,
    /// The largest P of the records and of the domain.
    pub max_p: f64,
    /// Records left out, with the reason (none for the shipped data).
    pub skipped: Vec<String>,
    /// The space's domain (domain.rs), when its problems are given by one: then `problems` holds its records only.
    pub domain: Option<&'static SpaceDomain>,
    /// Reads the research configuration of an entry whose configuration is kept apart
    /// (`config_apart`), checked as the catalogue checks the others. Set by load.rs (the source's
    /// `loadConfig`).
    pub load_config: Option<Arc<ConfigLoader>>,
}

/// records.ts: `entryConfig`. The research configuration of an entry, as JSON text: kept in the
/// entry, or read on demand (this call then waits for the file; run it on a thread that may block).
pub fn entry_config(cat: &SpaceCatalogue, entry: &SpaceProblemEntry) -> Option<String> {
    if entry.config.is_some() || !entry.config_apart {
        return entry.config.clone();
    }
    cat.load_config.as_ref().and_then(|l| l.load(entry))
}

/// What `configLocation` answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigLocation {
    pub file: String,
    pub offset: u64,
    pub length: u64,
}

/// records.ts: `configLocation`. Where a configuration kept apart lives: the file
/// configs/<file>.jsonl below the space's data folder, and the byte offset and length of its line
/// there. For polyhedra and balls the file is the problem's code, for nD in nD
/// "<d>-<piece>-<container>". The file name comes from a catalogue entry (a known code), never
/// from a request.
pub fn config_location(entry: &SpaceProblemEntry) -> ConfigLocation {
    let (offset, length) = entry.config_at.unwrap_or((0, 0));
    // nD in nD: one file per dimension and pair of shapes, "<d>-<piece>-<container>"
    let f = &entry.fields;
    let file = match f.get("code") {
        None => format!("{}-{}-{}", f.js_string("d"), f.js_string("piece"), f.js_string("container")),
        Some(code) => code.js_string(),
    };
    ConfigLocation { file, offset, length }
}

/// records.ts: `CONFIG_LINE_MAX`. Longest line of a configuration kept apart that is read (a
/// P = 100 configuration is about 20 kB).
pub const CONFIG_LINE_MAX: f64 = 1_000_000.0;

/// records.ts: `CONFIGS_APART`. Spaces whose records file may keep the configurations apart.
const CONFIGS_APART: [SpaceName; 3] = [SpaceName::Polyhedra, SpaceName::Balls, SpaceName::Ndim];

/// records.ts: `SpacesIndex`. The loaded catalogues, by space; a space whose records file is
/// missing and that has no domain is absent.
#[derive(Default)]
pub struct SpacesIndex {
    catalogues: [Option<Arc<SpaceCatalogue>>; 8],
}

impl SpacesIndex {
    /// `index[space]`.
    pub fn get(&self, space: SpaceName) -> Option<&Arc<SpaceCatalogue>> {
        self.catalogues[space.index()].as_ref()
    }

    /// `index[space] = catalogue`.
    pub fn set(&mut self, catalogue: SpaceCatalogue) {
        let k = catalogue.space.index();
        self.catalogues[k] = Some(Arc::new(catalogue));
    }

    /// The spaces that are loaded, in the order of `SPACE_NAMES` (`SPACE_NAMES.filter((s) => index[s])`).
    pub fn loaded(&self) -> Vec<SpaceName> {
        crate::types::SPACE_NAMES.into_iter().filter(|s| self.get(*s).is_some()).collect()
    }
}

/// `String(v)` of a JSON value (`None` is `undefined`).
pub(crate) fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => fmt::num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        // Array.prototype.join: null and undefined are the empty string
        Some(Value::Array(a)) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(",")
        }
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// `typeof v === "number" && Number.isFinite(v)` (a JSON number is finite).
fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// records.ts: `recordConfig`. The record's configuration in the space's submission format; None
/// is the source's `undefined`.
fn record_config(space: SpaceName, r: &Map<String, Value>) -> Option<Value> {
    match space {
        SpaceName::Surface => {
            // { s: r.s, pieces: r.pieces }: a field the record lacks is undefined, which reads as an absent one
            let mut c = Map::new();
            if let Some(s) = r.get("s") {
                c.insert("s".to_string(), s.clone());
            }
            if let Some(pieces) = r.get("pieces") {
                c.insert("pieces".to_string(), pieces.clone());
            }
            Some(Value::Object(c))
        }
        SpaceName::Curved | SpaceName::Sphere | SpaceName::Boundary => r.get("config").cloned(),
        SpaceName::Torus => r.get("configuration").cloned(),
        SpaceName::Polyhedra | SpaceName::Balls | SpaceName::Ndim => r.get("config").cloned(),
    }
}

/// records.ts: `recordFields`. The names of the record's own fields that the id must agree with.
fn record_fields(space: SpaceName) -> &'static [&'static str] {
    match space {
        SpaceName::Surface => &["solid", "mode", "N", "P"],
        SpaceName::Curved => &["K", "N", "M", "P"],
        SpaceName::Sphere => &["N", "P"],
        SpaceName::Torus => &["family", "N", "P"],
        SpaceName::Boundary => &["polytope", "piece", "P"],
        SpaceName::Polyhedra | SpaceName::Balls => &["code", "piece", "container", "P"],
        SpaceName::Ndim => &["d", "piece", "container", "P"],
    }
}

/// `own !== field`: a JSON value (None: undefined) against a field of an id.
fn differs(own: Option<&Value>, field: Option<&Field>) -> bool {
    match (own, field) {
        (None, None) => false,
        (Some(Value::Number(n)), Some(Field::Number(x))) => n.as_f64() != Some(*x),
        (Some(Value::String(s)), Some(Field::Text(t))) => s != t,
        _ => true,
    }
}

/// records.ts: `extraOf`. The record's nofold comparison (boundary): `nofold` {value, source} and
/// `fold_gain`, each kept only when it is well formed; None for the other spaces.
fn extra_of(space: SpaceName, r: &Map<String, Value>) -> Option<SpaceProblemExtra> {
    if space != SpaceName::Boundary {
        return None;
    }
    let n = r.get("nofold").and_then(Value::as_object);
    let value = n.and_then(|n| finite(n.get("value"))).filter(|v| *v > 0.0);
    let gain = finite(r.get("fold_gain"));
    Some(SpaceProblemExtra {
        nofold: value.map(|value| Nofold {
            value,
            label: n.and_then(|n| n.get("source")).and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        fold_gain: gain,
    })
}

/// `/^[a-z]+( piece)?$/`.
fn one_word(kind: &str) -> bool {
    let core = kind.strip_suffix(" piece").unwrap_or(kind);
    !core.is_empty() && core.bytes().all(|c| c.is_ascii_lowercase())
}

/// records.ts: `boundOf`. The bound as {value, label}: from `value` (surface, sphere, torus) or
/// `lower` (curved).
fn bound_of(space: SpaceName, b: Option<&Value>) -> Option<Bound> {
    let b = b?.as_object()?;
    let value = b.get("value").and_then(Value::as_f64).or_else(|| b.get("lower").and_then(Value::as_f64)).unwrap_or(f64::NAN);
    if !value.is_finite() {
        return None;
    }
    let label = b.get("label").and_then(Value::as_str).unwrap_or("");
    // `b.kind.replace(/[-_]/g, " ")`
    let kind = b.get("kind").and_then(Value::as_str).map(|k| k.replace(['-', '_'], " ")).unwrap_or_default();
    // surface and curved labels carry only the kind of claim ([CALC], rigorous); their `kind` says
    // which bound it is: one word ("area", "one piece") or a sentence of its own
    if matches!(space, SpaceName::Surface | SpaceName::Curved | SpaceName::Polyhedra | SpaceName::Balls | SpaceName::Ndim) && !kind.is_empty() {
        let what = if one_word(&kind) { format!("{kind} bound") } else { kind };
        return Some(Bound { value, label: if label.is_empty() { what } else { format!("{what}; {label}") } });
    }
    Some(Bound { value, label: if label.is_empty() { kind } else { label.to_string() } })
}

/// records.ts: `closedReason`.
fn closed_reason(space: SpaceName, r: &Map<String, Value>, status: CertifiedStatus, id: &ParsedSpaceId) -> Option<String> {
    if status == CertifiedStatus::Proven {
        let lit = r.get("literature").and_then(Value::as_object);
        let proof = match lit.and_then(|l| l.get("proof")).and_then(Value::as_array) {
            Some(list) => list.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "),
            None => String::new(),
        };
        // torus records list their sources; the entry with a `proof` proves the exact case
        let listed = r.get("literature").and_then(Value::as_array).and_then(|list| {
            list.iter().filter_map(Value::as_object).find(|e| e.get("proof").is_some_and(Value::is_string) && e.get("short").is_some_and(Value::is_string))
        });
        let cited = match listed {
            Some(e) => format!(
                "{}{}",
                e.get("short").and_then(Value::as_str).unwrap_or(""),
                e.get("doi").and_then(Value::as_str).map(|d| format!(", doi:{d}")).unwrap_or_default()
            ),
            None => String::new(),
        };
        // proof || cited || (typeof lit.source === "string" ? lit.source : "a published proof")
        let source = if !proof.is_empty() {
            proof
        } else if !cited.is_empty() {
            cited
        } else {
            lit.and_then(|l| l.get("source")).and_then(Value::as_str).unwrap_or("a published proof").to_string()
        };
        return Some(format!("its optimum {} is proven ({source})", js_string(r.get("display"))));
    }
    if status == CertifiedStatus::Infeasible {
        let proof = r.get("proof").and_then(Value::as_str).map(|p| format!(" (proof: {p})")).unwrap_or_default();
        let place = if space == SpaceName::Curved { format!(" at K = {}", id.fields.js_string("K")) } else { String::new() };
        return Some(format!("no packing exists: {} pieces do not fit in any container of this shape{place}{proof}", id.p));
    }
    None
}

/// records.ts: `ORDER`. The order of each space's named fields, kept per space: another space's
/// field of the same name (polyhedra's piece, say) is not sorted by this one's list. Fields not
/// named here sort by number. The place of `value` in the list of `space`'s field `key`
/// (`indexOf`: -1 when it is not there), or None when the field has no list.
fn order_index(space: SpaceName, key: &str, value: &str) -> Option<f64> {
    fn at<S: AsRef<str>>(list: &[S], value: &str) -> Option<f64> {
        Some(list.iter().position(|x| x.as_ref() == value).map_or(-1.0, |i| i as f64))
    }
    match (space, key) {
        (SpaceName::Surface, "solid") => at(surface_solids(), value),
        (SpaceName::Surface, "mode") => at(&SURFACE_MODES, value),
        (SpaceName::Torus, "family") => at(&TORUS_FAMILIES, value),
        (SpaceName::Boundary, "polytope") => at(&BOUNDARY_POLYTOPES, value),
        (SpaceName::Boundary, "piece") => at(&BOUNDARY_PIECES, value),
        (SpaceName::Polyhedra, "code") => at(&PROBLEM_ORDER, value),
        (SpaceName::Balls, "code") => at(&BALLS_CODES, value),
        (SpaceName::Ndim, "piece") | (SpaceName::Ndim, "container") => at(&nd_shape_names(), value),
        _ => None,
    }
}

/// records.ts: `SORT_KEYS`. Field order of the listing.
fn sort_keys(space: SpaceName) -> &'static [&'static str] {
    match space {
        SpaceName::Surface => &["solid", "mode", "N", "P"],
        SpaceName::Curved => &["K", "N", "M", "P"],
        SpaceName::Sphere => &["N", "P"],
        SpaceName::Torus => &["family", "N", "P"],
        SpaceName::Boundary => &["polytope", "piece", "P"],
        SpaceName::Polyhedra => &["code", "P"],
        SpaceName::Balls => &["code", "P"],
        SpaceName::Ndim => &["d", "piece", "container", "P"],
    }
}

/// The value an entry sorts by for one key of `sort_keys`: its place in the field's list, or the
/// field as a number.
fn sort_value(space: SpaceName, key: &str, fields: &Fields) -> f64 {
    match order_index(space, key, &fields.js_string(key)) {
        Some(i) => i,
        None => fields.get(key).map_or(f64::NAN, Field::js_number),
    }
}

/// records.ts: `compareSpaceProblems`.
pub fn compare_space_problems(a: &SpaceProblemEntry, b: &SpaceProblemEntry) -> Ordering {
    for k in sort_keys(a.space) {
        let d = sort_value(a.space, k, &a.fields) - sort_value(a.space, k, &b.fields);
        // `if (d) return d`: 0 and NaN go on to the next key
        if d < 0.0 {
            return Ordering::Less;
        }
        if d > 0.0 {
            return Ordering::Greater;
        }
    }
    // ids are ASCII, so the order of their bytes is the order of their UTF-16 units
    a.id.cmp(&b.id)
}

/// `Number.isSafeInteger(v)` of a JSON value.
fn safe_integer(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite() && *x == x.trunc() && x.abs() <= 9007199254740991.0)
}

/// records.ts: `buildSpaceCatalogue`. The catalogue of one space from its parsed records file, and
/// its domain when it has one (domain.rs). A record is left out (with a reason in `skipped`) when
/// its id does not match its fields, its status is unknown, its configuration is not one of the
/// space's format with P pieces, or it lies outside the domain. `file` may be None (the source's
/// `null`) for a space with a domain and no records file yet.
pub fn build_space_catalogue(space: SpaceName, file: Option<&Value>, domain: Option<&'static SpaceDomain>) -> SpaceCatalogue {
    let mut skipped: Vec<String> = Vec::new();
    let mut problems: Vec<SpaceProblemEntry> = Vec::new();
    // the order by which the entries sort, computed once per entry (compare_space_problems on these keys)
    let records = file.and_then(Value::as_object).and_then(|f| f.get("records")).and_then(Value::as_array);
    if records.is_none() && !(file.is_none() && domain.is_some()) {
        skipped.push("the file has no records list".to_string());
    }
    for (k, r) in records.map(|r| r.as_slice()).unwrap_or(&[]).iter().enumerate() {
        let Some(r) = r.as_object() else {
            skipped.push(format!("record {k} is not an object"));
            continue;
        };
        // `r.problem ?? r.id`: null and undefined give way
        let raw_id = if space == SpaceName::Torus { r.get("problem").filter(|v| !v.is_null()).or_else(|| r.get("id")) } else { r.get("id") };
        let id = match parse_space_id_value(space, raw_id) {
            Ok(id) => id,
            Err(message) => {
                skipped.push(format!("record {k}: {message}"));
                continue;
            }
        };
        let domain_bound = domain.map(|d| d.bound(&id));
        if domain_bound == Some(None) {
            skipped.push(format!("{}: outside the space's domain", id.id));
            continue;
        }
        if let Some(mismatch) = record_fields(space).iter().find(|f| differs(r.get(**f), id.fields.get(f))) {
            skipped.push(format!("{}: the id's {mismatch} differs from the record's ({})", id.id, js_string(r.get(*mismatch))));
            continue;
        }
        let status = match r.get("status").and_then(Value::as_str) {
            Some("best_known") => CertifiedStatus::BestKnown,
            Some("proven") => CertifiedStatus::Proven,
            Some("infeasible") => CertifiedStatus::Infeasible,
            _ => {
                skipped.push(format!("{}: unknown status {}", id.id, js_string(r.get("status"))));
                continue;
            }
        };
        let mut certified: Option<CertifiedValue> = None;
        let mut config: Option<String> = None;
        let mut config_apart = false;
        let mut config_at: Option<(u64, u64)> = None;
        if status != CertifiedStatus::Infeasible {
            let (Some(score_cert), Some(display)) = (finite(r.get("score_cert")), r.get("display").and_then(Value::as_str)) else {
                skipped.push(format!("{}: score_cert or display is missing", id.id));
                continue;
            };
            let raw = record_config(space, r);
            if raw.is_none() && CONFIGS_APART.contains(&space) {
                let at = r.get("config_at").and_then(Value::as_array).filter(|at| at.len() == 2);
                let place = at.and_then(|at| {
                    let offset = safe_integer(at.first()).filter(|o| *o >= 0.0)?;
                    let length = safe_integer(at.get(1)).filter(|l| *l >= 1.0 && *l <= CONFIG_LINE_MAX)?;
                    Some((offset as u64, length as u64))
                });
                let Some(place) = place else {
                    skipped.push(format!("{}: no configuration, and no config_at [offset, length] of one kept apart", id.id));
                    continue;
                };
                config_apart = true;
                config_at = Some(place);
            } else {
                match parse_space_config(&id, raw.as_ref()) {
                    Parsed::Failed { errors, .. } => {
                        skipped.push(format!("{}: {}", id.id, errors.join("; ")));
                        continue;
                    }
                    Parsed::Ok { config: parsed, .. } => config = Some(json::stringify(&parsed)),
                }
            }
            certified = Some(CertifiedValue { score: score_cert, display: display.to_string(), status });
        }
        let extra = extra_of(space, r);
        // boundOf(space, r.bound) ?? domain?.bound(id) ?? null
        let bound = bound_of(space, r.get("bound")).or_else(|| domain_bound.flatten().flatten());
        let closed_reason = closed_reason(space, r, status, &id);
        problems.push(SpaceProblemEntry {
            space,
            id: id.id,
            fields: id.fields,
            p: id.p,
            status: status.into(),
            certified,
            bound,
            closed_reason,
            config,
            config_apart,
            config_at,
            extra,
        });
    }
    // `problems.sort(compareSpaceProblems)`: a stable sort; the keys of each entry are worked out once
    let keys = sort_keys(space);
    let mut keyed: Vec<(Vec<f64>, SpaceProblemEntry)> =
        problems.into_iter().map(|p| (keys.iter().map(|k| sort_value(space, k, &p.fields)).collect(), p)).collect();
    keyed.sort_by(|(x, a), (y, b)| {
        for (u, v) in x.iter().zip(y) {
            let d = u - v;
            if d < 0.0 {
                return Ordering::Less;
            }
            if d > 0.0 {
                return Ordering::Greater;
            }
        }
        a.id.cmp(&b.id)
    });
    let mut by_id: HashMap<String, Arc<SpaceProblemEntry>> = HashMap::new();
    let mut unique: Vec<Arc<SpaceProblemEntry>> = Vec::new();
    for (_, p) in keyed {
        if by_id.contains_key(&p.id) {
            skipped.push(format!("{}: listed twice; the first is kept", p.id));
        } else {
            let p = Arc::new(p);
            by_id.insert(p.id.clone(), p.clone());
            unique.push(p);
        }
    }
    let largest = unique.iter().fold(0.0, |m, p| math::max(m, p.p as f64));
    SpaceCatalogue {
        space,
        generated: file.and_then(Value::as_object).and_then(|f| f.get("generated")).and_then(Value::as_str).map(str::to_string),
        max_p: math::max(largest, domain.map_or(0.0, domain_max_p)),
        problems: unique,
        by_id,
        skipped,
        domain,
        load_config: None,
    }
}

/// records.ts: `problemOf`. The problem of an id in a catalogue: its record, or, for an id of the
/// space's domain without one, an entry made now with the status `no_record` and the domain's
/// bound; None when the id is neither.
pub fn problem_of(cat: &SpaceCatalogue, id: &ParsedSpaceId) -> Option<Arc<SpaceProblemEntry>> {
    if let Some(p) = cat.by_id.get(&id.id) {
        return Some(p.clone());
    }
    let bound = cat.domain?.bound(id)?;
    Some(Arc::new(SpaceProblemEntry {
        space: cat.space,
        id: id.id.clone(),
        fields: id.fields.clone(),
        p: id.p,
        status: SpaceProblemStatus::NoRecord,
        certified: None,
        bound,
        closed_reason: None,
        config: None,
        config_apart: false,
        config_at: None,
        extra: None,
    }))
}

/// records.ts: `acceptsSubmissions`. True when a problem takes submissions: its research record is
/// neither proven nor infeasible (or it has none).
pub fn accepts_submissions(p: &SpaceProblemEntry) -> bool {
    p.closed_reason.is_none()
}

/// records.ts: `hasRecord`. True when a problem has a research record (its status is not `no_record`).
pub fn has_record(p: &SpaceProblemEntry) -> bool {
    p.status != SpaceProblemStatus::NoRecord
}

/// records.ts: `spaceProblemSummary`. A problem as a listing shows it, with the leading site entry
/// (none for closed problems). best_score is the smaller of the certified and the site value.
pub fn space_problem_summary(p: &SpaceProblemEntry, site: Option<&SiteBest>) -> SpaceProblemSummary {
    let open = accepts_submissions(p);
    let site_best = if open { site.cloned() } else { None };
    let values: Vec<f64> = [p.certified.as_ref().map(|c| c.score), site_best.as_ref().map(|s| s.score)].into_iter().flatten().collect();
    SpaceProblemSummary {
        space: p.space,
        id: p.id.clone(),
        fields: p.fields.clone(),
        p: p.p,
        status: p.status,
        certified: p.certified.clone(),
        bound: p.bound.clone(),
        site_best,
        best_score: if values.is_empty() { None } else { Some(math::min_of(&values)) },
        accepts_submissions: open,
        closed_reason: p.closed_reason.clone(),
        extra: p.extra.clone(),
    }
}
