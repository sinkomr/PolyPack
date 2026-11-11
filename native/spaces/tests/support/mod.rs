//! What the comparison with the TypeScript runs on a case (`native/tools/spaces-ref.mts` writes
//! the cases and the TypeScript's answers): shared by `examples/spacesdiff.rs`, which answers a
//! whole file of cases, and `tests/fixtures.rs`, which checks the fixtures kept in the repository.
//! Each answer is built as the reference tool builds its own, key for key.

#![allow(dead_code)]

use polypack_js::json;
use polypack_spaces::load::{config_loader_with, load_spaces_index, Log};
use polypack_spaces::*;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// The repository's root (the folder that holds data/).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("the repository's root")
}

/// A log that keeps its lines.
pub fn keeping_log() -> (Log, Arc<Mutex<Vec<String>>>) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    (Arc::new(move |m: &str| sink.lock().unwrap().push(m.to_string())), lines)
}

/// A number as the files hold it: the non-finite ones as their names.
fn num_out(x: f64) -> Value {
    if x.is_finite() {
        json!(x)
    } else {
        Value::String(polypack_js::fmt::num(x))
    }
}

fn space_of(case: &Value) -> SpaceName {
    SpaceName::parse(case["space"].as_str().expect("a space")).expect("a space's name")
}

/// The options of a case: `{ bound?, maxP?, certified?, noRecord? }`.
pub fn opts_of(v: &Value) -> SpaceValidateOptions {
    SpaceValidateOptions {
        bound: v.get("bound").and_then(Value::as_f64),
        max_p: v.get("maxP").and_then(Value::as_f64),
        certified: v.get("certified").and_then(Value::as_f64),
        no_record: v.get("noRecord").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn stored(config: Option<&SpaceConfig>) -> Value {
    config.map_or(Value::Null, |c| Value::String(c.to_json()))
}

fn verdict_json(v: &SpaceVerdict) -> Value {
    json!({ "valid": v.valid, "score": v.score, "reasons": v.reasons, "malformed": v.malformed, "config": stored(v.config.as_ref()) })
}

/// A main case `{ id, kind, space, problem, config, opts }`: parseSpaceConfig, and the verdicts of
/// validateSpaceSubmission and of its Async variant, in the reference's order (the plain one first).
pub fn main_result(case: &Value) -> Value {
    main_result_in_order(case, false)
}

/// `main_result`, with the Async variant run first when `async_first` (it loads the polytopes of
/// an ndim problem that are kept on demand, which the plain one does not).
pub fn main_result_in_order(case: &Value, async_first: bool) -> Value {
    let space = space_of(case);
    let config = &case["config"];
    let opts = opts_of(&case["opts"]);
    let problem = case.get("problem");
    let parse = match parse_space_id_value(space, problem) {
        Err(_) => Value::Null,
        Ok(id) => match parse_space_config(&id, Some(config)) {
            Parsed::Ok { config, score } => json!({ "ok": true, "score": score, "config": stored(Some(&config)) }),
            Parsed::Failed { malformed, errors } => json!({ "ok": false, "malformed": malformed, "errors": errors }),
        },
    };
    // an id that is not a string is refused by `prepare` with parseSpaceId's message
    let (sync, later) = match problem.and_then(Value::as_str) {
        Some(id) if async_first => {
            let later = validate_space_submission_async(space, id, config, &opts).verdict;
            (validate_space_submission(space, id, config, &opts), later)
        }
        Some(id) => (validate_space_submission(space, id, config, &opts), validate_space_submission_async(space, id, config, &opts).verdict),
        None => {
            let refused = SpaceVerdict { valid: false, score: None, reasons: vec!["id must be a string".into()], malformed: true, config: None };
            (refused.clone(), refused)
        }
    };
    json!({ "id": case["id"], "parse": parse, "sync": verdict_json(&sync), "async": verdict_json(&later) })
}

/// One pass of `validate_space_submission` on a main case, for the timings.
pub fn run_sync(case: &Value) -> usize {
    match case.get("problem").and_then(Value::as_str) {
        Some(id) => validate_space_submission(space_of(case), id, &case["config"], &opts_of(&case["opts"])).reasons.len(),
        None => 0,
    }
}

pub fn entry_json(p: &SpaceProblemEntry) -> Value {
    json!({
        "space": p.space,
        "id": p.id,
        "fields": p.fields,
        "P": p.p,
        "status": p.status,
        "certified": p.certified,
        "bound": p.bound,
        "closed_reason": p.closed_reason,
        "config": p.config,
        "configApart": p.config_apart,
        "configAt": p.config_at.map(|(o, l)| json!([o, l])),
        "extra": p.extra,
    })
}

pub fn catalogue_json(cat: &SpaceCatalogue) -> Map<String, Value> {
    let v = json!({
        "space": cat.space,
        "generated": cat.generated,
        "maxP": cat.max_p,
        "skipped": cat.skipped,
        "domain": cat.domain.is_some(),
        "loader": cat.load_config.is_some(),
        "count": cat.problems.len(),
    });
    v.as_object().expect("an object").clone()
}

/// The names of the fields of an id, as statics.
fn field_name(key: &str) -> &'static str {
    ["solid", "mode", "N", "P", "K", "M", "family", "polytope", "piece", "code", "container", "d"]
        .into_iter()
        .find(|k| *k == key)
        .unwrap_or_else(|| panic!("no field {key}"))
}

fn fields_of(v: &Value) -> Fields {
    Fields(
        v.as_object()
            .expect("fields")
            .iter()
            .map(|(k, v)| {
                let field = match v {
                    Value::Number(n) => Field::Number(n.as_f64().unwrap()),
                    Value::String(s) => Field::Text(s.clone()),
                    other => panic!("a field is a number or a string, not {other}"),
                };
                (field_name(k), field)
            })
            .collect(),
    )
}

fn bound_json(b: Option<Option<Bound>>) -> Value {
    match b {
        None => json!("outside"),
        Some(None) => Value::Null,
        Some(Some(b)) => json!(b),
    }
}

fn site_of(v: &Value) -> Option<SiteBest> {
    let o = v.as_object()?;
    Some(SiteBest {
        id: o["id"].as_i64().unwrap(),
        score: o["score"].as_f64().unwrap(),
        name: o["name"].as_str().unwrap().to_string(),
        created_at: o["created_at"].as_str().unwrap().to_string(),
    })
}

/// The index of the repository's data/, loaded once (the cases of kind "problem" ask it).
pub fn repo_index() -> &'static SpacesIndex {
    static INDEX: std::sync::OnceLock<SpacesIndex> = std::sync::OnceLock::new();
    INDEX.get_or_init(|| load_spaces_index(&repo_root(), no_log()))
}

/// An auxiliary case `{ id, kind, ... }`: the result the reference tool writes for it.
pub fn aux_result(c: &Value) -> Value {
    match c["kind"].as_str().expect("a kind") {
        "id" => {
            let space = space_of(c);
            let value = &c["value"];
            let of = value.as_str().and_then(space_of_id);
            match parse_space_id_value(space, Some(value)) {
                Err(error) => json!({ "error": error, "spaceOf": of, "isSpace": is_space_name_value(value) }),
                Ok(parsed) => json!({
                    "id": parsed.id,
                    "space": parsed.space,
                    "fields": parsed.fields,
                    "P": parsed.p,
                    "formatted": format_space_id(space, &parsed.fields).expect("the id of a parsed id"),
                    "spaceOf": of,
                }),
            }
        }
        "format" => match format_space_id(space_of(c), &fields_of(&c["fields"])) {
            Ok(text) => json!({ "text": text }),
            Err(thrown) => json!({ "thrown": thrown }),
        },
        "curvature" => {
            let k = match &c["K"] {
                Value::String(s) => match s.as_str() {
                    "NaN" => f64::NAN,
                    "Infinity" => f64::INFINITY,
                    _ => f64::NEG_INFINITY,
                },
                v => v.as_f64().unwrap(),
            };
            match format_curvature(k) {
                Ok(text) => json!({ "text": text }),
                Err(thrown) => json!({ "thrown": thrown }),
            }
        }
        "domain-info" => {
            let d = space_domain(space_of(c)).unwrap();
            json!({ "text": json::stringify(&d.info), "maxP": domain_max_p(d) })
        }
        "domain-sample" => json!({ "ids": space_domain(space_of(c)).unwrap().sample(c["limit"].as_u64().unwrap() as usize) }),
        "domain-bound" => {
            let space = space_of(c);
            match parse_space_id_value(space, Some(&c["value"])) {
                Err(error) => json!({ "error": error }),
                Ok(parsed) => {
                    let mut out = Map::new();
                    out.insert("bound".into(), bound_json(space_domain(space).unwrap().bound(&parsed)));
                    if c.get("impossible").and_then(Value::as_bool) == Some(true) {
                        out.insert("impossible".into(), json!(impossible_reason(space, &parsed)));
                    }
                    Value::Object(out)
                }
            }
        }
        "curved-menu" => {
            let chosen: Vec<(String, String)> = c["chosen"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
            match space_domain(SpaceName::Curved).unwrap().menu(c["key"].as_str().unwrap(), &chosen) {
                None => json!({ "menu": "none" }),
                Some(DomainMenu::Values(values)) => json!({ "values": values, "range": null }),
                Some(DomainMenu::Range(a, b)) => json!({ "values": null, "range": [num_out(a), num_out(b)] }),
            }
        }
        "catalogue" => {
            let space = space_of(c);
            let file = if c["file"].is_null() { None } else { Some(&c["file"]) };
            let domain = if c["domain"].as_bool().unwrap() { space_domain(space) } else { None };
            let cat = build_space_catalogue(space, file, domain);
            let mut out = catalogue_json(&cat);
            out.insert("problems".into(), Value::Array(cat.problems.iter().map(|p| entry_json(p)).collect()));
            let mut ids: Vec<&String> = cat.by_id.keys().collect();
            ids.sort();
            out.insert("byId".into(), json!(ids));
            Value::Object(out)
        }
        "problem" => {
            let space = space_of(c);
            match parse_space_id_value(space, Some(&c["value"])) {
                Err(error) => json!({ "error": error }),
                Ok(parsed) => {
                    let cat = repo_index().get(space).expect("the space's catalogue");
                    match problem_of(cat, &parsed) {
                        None => json!({ "problem": null }),
                        Some(p) => {
                            let site = site_of(&c["site"]);
                            let summary = space_problem_summary(&p, site.as_ref());
                            let head = SpaceProblemHead { summary: summary.clone(), conventions: space_info(space).conventions.clone() };
                            let location = if p.config_apart {
                                let l = config_location(&p);
                                json!({ "file": l.file, "offset": l.offset, "length": l.length })
                            } else {
                                Value::Null
                            };
                            json!({
                                "problem": entry_json(&p),
                                "accepts": accepts_submissions(&p),
                                "hasRecord": has_record(&p),
                                "summary": json::stringify(&summary),
                                "head": json::stringify(&head),
                                "location": location,
                                "config": entry_config(cat, &p),
                            })
                        }
                    }
                }
            }
        }
        "stored" => {
            let space = space_of(c);
            let problem = c["problem"].as_str().unwrap();
            let opts = opts_of(&c["opts"]);
            let sent = c["sentScore"].as_f64();
            let id = parse_space_id(space, problem).expect("an id");
            let Parsed::Ok { config, .. } = parse_space_config(&id, Some(&c["config"])) else {
                panic!("{problem}: the configuration of a stored case parses");
            };
            let sync = stored_space_config(space, problem, &config, &opts, sent);
            let later = stored_space_config_async(space, problem, &config, &opts, sent);
            json!({ "sync": sync.to_json(), "async": later.config.to_json() })
        }
        "beats" => {
            let space = space_of(c);
            let (score, certified, leader) = (c["score"].as_f64().unwrap(), c["certified"].as_f64(), c["leader"].as_f64());
            json!({
                "score": beats_space_score(score, leader),
                "record": beats_space_record(space, score, certified),
                "improves": improves_space_best(space, score, certified, leader),
            })
        }
        "heavy" => {
            let space = space_of(c);
            match parse_space_id_value(space, Some(&c["value"])) {
                Err(error) => json!({ "error": error }),
                Ok(parsed) => {
                    let f = &parsed.fields;
                    if space == SpaceName::Boundary {
                        let (polytope, piece, p) = (f.text("polytope"), f.text("piece"), parsed.p as f64);
                        json!({ "ms": num_out(boundary_check_ms(polytope, piece, p)), "heavy": boundary_is_heavy(polytope, piece, p) })
                    } else {
                        let problem = NdProblemId { d: f.number("d") as u32, piece: f.text("piece").into(), container: f.text("container").into(), p: parsed.p };
                        json!({ "ops": nd_check_ops(&problem), "heavy": nd_is_heavy(&problem) })
                    }
                }
            }
        }
        "constants" => {
            let per_space = |f: &dyn Fn(SpaceName) -> f64| -> Vec<f64> { SPACE_NAMES.iter().map(|s| f(*s)).collect() };
            json!({
                "SPACE_NAMES": SPACE_NAMES,
                "PIECE_NS": *PIECE_NS,
                "CURVED_KS": *CURVED_KS,
                "CURVED_MENU_KS": CURVED_MENU_KS,
                "CURVED_MENU_K_IDS": *CURVED_MENU_K_IDS,
                "CURVED_MS": *CURVED_MS,
                "CURVED_TILING_KS": CURVED_TILING_KS,
                "countCurvedProblems": count_curved_problems(),
                "SPACE_MAX_P": per_space(&space_max_p),
                "SPACE_RECORD_MARGIN": per_space(&space_record_margin),
                "SPACE_MAX_SIZE": SPACE_MAX_SIZE,
                "SPACE_BOUND_SLACK": SPACE_BOUND_SLACK,
                "SPACE_STRICT_REASON": SPACE_STRICT_REASON,
                "SPACE_STRICT_NO_RECORD_REASON": SPACE_STRICT_NO_RECORD_REASON,
                "SPACE_TOL": SPACE_TOL,
                "SPACE_STRICT_TOL": SPACE_STRICT_TOL,
                "SPACE_MAX_COORD": SPACE_MAX_COORD,
                "SPACE_MIN_QUATERNION_NORM": SPACE_MIN_QUATERNION_NORM,
                "SURFACE_MAX_CHAINS": SURFACE_MAX_CHAINS,
                "TORUS_MAX_TRANSLATES": TORUS_MAX_TRANSLATES,
                "BOUNDARY_MAX_CHAINS": BOUNDARY_MAX_CHAINS,
                "BOUNDARY_MAX_S": BOUNDARY_MAX_S,
                "POLYHEDRA_MAX_QUATERNION": POLYHEDRA_MAX_QUATERNION,
                "info": json::stringify(&SPACE_NAMES.iter().map(|s| space_info(*s)).collect::<Vec<_>>()),
                "exhibits": json::stringify(space_exhibits()),
            })
        }
        "loader" => {
            let root = PathBuf::from(c["root"].as_str().unwrap());
            let space = space_of(c);
            let (log, lines) = keeping_log();
            let text = std::fs::read(root.join("data").join(space.as_str()).join("records.json")).expect("the scenario's records file");
            let file = json::parse(&text).expect("a records file");
            let cat = build_space_catalogue(space, Some(&file), space_domain(space));
            let loader = config_loader_with(&root, space, log, c["limitBytes"].as_u64().unwrap() as usize, c["atOnce"].as_u64().unwrap() as usize);
            let mut steps: Vec<Value> = Vec::new();
            for step in c["steps"].as_array().unwrap() {
                let entries: Vec<&Arc<SpaceProblemEntry>> = step.as_array().unwrap().iter().map(|id| &cat.by_id[id.as_str().unwrap()]).collect();
                // the loads of one step start together, each on its own thread
                let served: Vec<Option<String>> = if entries.len() == 1 {
                    vec![loader.load(entries[0])]
                } else {
                    let gate = std::sync::Barrier::new(entries.len());
                    std::thread::scope(|s| {
                        let handles: Vec<_> = entries
                            .iter()
                            .map(|e| {
                                let (loader, gate) = (&loader, &gate);
                                s.spawn(move || {
                                    gate.wait();
                                    loader.load(e)
                                })
                            })
                            .collect();
                        handles.into_iter().map(|h| h.join().unwrap()).collect()
                    })
                };
                let stats = loader.stats();
                steps.push(json!({
                    "served": served,
                    "cached": loader.cached(),
                    "stats": { "reads": stats.reads, "peakAtOnce": stats.peak_at_once, "bytes": stats.bytes },
                }));
            }
            let root_text = root.display().to_string();
            let log: Vec<String> = lines.lock().unwrap().iter().map(|m| m.replace(&root_text, "<root>")).collect();
            json!({ "skipped": cat.skipped, "steps": steps, "log": log })
        }
        "index" => {
            let root = PathBuf::from(c["root"].as_str().unwrap());
            let (log, lines) = keeping_log();
            let ix = load_spaces_index(&root, log);
            let root_text = root.display().to_string();
            let log: Vec<String> = lines.lock().unwrap().iter().map(|m| m.replace(&root_text, "<root>")).collect();
            let catalogues: Vec<Value> = SPACE_NAMES
                .iter()
                .map(|s| match ix.get(*s) {
                    None => Value::Null,
                    Some(cat) => {
                        let mut out = catalogue_json(cat);
                        out.insert("ids".into(), json!(cat.problems.iter().map(|p| &p.id).collect::<Vec<_>>()));
                        Value::Object(out)
                    }
                })
                .collect();
            json!({ "log": log, "catalogues": catalogues })
        }
        kind => panic!("no such kind {kind}"),
    }
}

/// The site entry the reference tool gives every third problem of a listing.
pub fn listing_site(p: &SpaceProblemEntry, k: usize) -> Option<SiteBest> {
    if !k.is_multiple_of(3) {
        return None;
    }
    let certified = p.certified.as_ref().map_or(2.0, |c| c.score);
    Some(SiteBest {
        id: 1000 + k as i64,
        score: certified * if k % 2 == 1 { 0.999 } else { 1.001 },
        name: format!("entry {k}"),
        created_at: "2026-11-10T12:00:00.000Z".to_string(),
    })
}

/// The records listing of a space as the server sends it (apps/server/src/spaces.ts).
pub fn listing_json(cat: &SpaceCatalogue) -> String {
    let listing = SpaceRecordsResponse {
        space: cat.space,
        generated_at: "2026-11-10T12:00:00.000Z".to_string(),
        problems: cat.problems.iter().enumerate().map(|(k, p)| space_problem_summary(p, listing_site(p, k).as_ref())).collect(),
    };
    json::stringify(&listing)
}

/// The answer of GET /api/spaces as the server builds it (apps/server/src/spaces.ts).
pub fn spaces_json(index: &SpacesIndex) -> String {
    let loaded = index.loaded();
    let spaces: Vec<SpaceInfo> = loaded
        .iter()
        .map(|s| {
            let cat = index.get(*s).unwrap();
            let text = space_info(*s);
            SpaceInfo {
                space: *s,
                title: text.title.clone(),
                summary: text.summary.clone(),
                score: text.score.clone(),
                problem_id: text.problem_id.clone(),
                conventions: text.conventions.clone(),
                viewer: text.viewer.clone(),
                docs: text.docs.clone(),
                problems: cat.domain.map_or(cat.problems.len() as f64, |d| d.problems()),
                records: cat.problems.iter().filter(|p| has_record(p)).count(),
                domain: cat.domain.map(|d| d.info.clone()),
            }
        })
        .collect();
    let exhibits = if loaded.is_empty() { Vec::new() } else { space_exhibits().to_vec() };
    json::stringify(&SpacesResponse { spaces, exhibits })
}
