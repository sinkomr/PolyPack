//! The Rust side of the comparison of the SQLite store with its TypeScript source: replays the
//! calls that native/tools/store-ref.mts wrote, on a database file, and writes each result as one
//! line of JSON. native/tools/store-compare.mjs compares the lines and the database files;
//! native/tools/store-diff.sh runs all of it.
//!
//!   storediff run CALLS SPACEIDS DB FROM TO OUT [leave]
//!       opens DB with the Rust store and makes the calls FROM <= i < TO, appending the results to OUT
//!   storediff replay TRACE DB
//!       sends the statements of a trace (see STORE_TRACE below) to DB one by one, through this
//!       binary's SQLite and none of the store's code: what the TypeScript store's statements leave
//!       when the SQLite under them is the one bundled here
//!
//! With STORE_TRACE=FILE in the environment, every statement the store prepares, steps (with the
//! values bound) or executes is appended to FILE, in the form the ref tool writes the TypeScript's
//! own statements in: `store-compare.mjs trace` then checks that the two implementations sent
//! SQLite the same statements with the same values in the same order.
//!
//! The clocks are the counters of the ref tool (performance.now advances 4.25 ms a call, Date.now
//! 25 s a call), and the answers of packages/spaces about problem ids are read from SPACEIDS,
//! which the ref tool wrote from the TypeScript.

use std::cell::Cell;
use std::collections::HashMap;
use std::fs;
use std::io::Write;

use polypack_js::json::stringify;
use polypack_server::store::*;
use serde_json::{json, Map, Number, Value};

struct MockClock {
    perf: Cell<f64>,
    date: Cell<f64>,
}
impl Clock for MockClock {
    fn performance_now(&self) -> f64 {
        self.perf.set(self.perf.get() + 4.25);
        self.perf.get()
    }
    fn date_now(&self) -> f64 {
        self.date.set(self.date.get() + 25_000.0);
        self.date.get()
    }
}

/// parseSpaceId as the TypeScript answered it for every problem id of the run.
struct TableSpaceIds {
    names: Vec<String>,
    ids: HashMap<String, Option<SpaceIdFields>>,
}
impl TableSpaceIds {
    fn load(path: &str) -> Self {
        let v: Value = serde_json::from_str(&fs::read_to_string(path).expect("the table of ids")).expect("JSON");
        let names = v["names"].as_array().expect("names").iter().map(|n| n.as_str().expect("a name").to_string()).collect();
        let mut ids = HashMap::new();
        for (key, fields) in v["ids"].as_object().expect("ids") {
            let fields = fields.as_object().map(|o| {
                SpaceIdFields(
                    o.iter()
                        .map(|(k, f)| {
                            let f = match f {
                                Value::Number(n) => SpaceIdField::Number(n.as_f64().expect("a number")),
                                Value::String(s) => SpaceIdField::Text(s.clone()),
                                other => panic!("a field of an id is {other}"),
                            };
                            (k.clone(), f)
                        })
                        .collect(),
                )
            });
            ids.insert(key.clone(), fields);
        }
        TableSpaceIds { names, ids }
    }
}
impl SpaceIds for TableSpaceIds {
    fn space_names(&self) -> Vec<String> {
        self.names.clone()
    }
    fn parse_space_id(&self, space: &str, id: &str) -> Option<SpaceIdFields> {
        match self.ids.get(&format!("{space}\n{id}")) {
            Some(fields) => fields.clone(),
            // never a guess: an id the TypeScript was not asked about stops the run
            None => {
                eprintln!("storediff: no answer of the TypeScript for the id {id:?} of {space:?}");
                std::process::exit(2);
            }
        }
    }
}

/// NaN, the infinities and -0 travel in the calls as {"$num": "NaN"} and so on.
fn num(v: &Value) -> f64 {
    if let Some(s) = v.get("$num").and_then(Value::as_str) {
        return match s {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("unknown $num {other}"),
        };
    }
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}
fn opt_num(v: &Value) -> Option<f64> {
    if v.is_null() {
        None
    } else {
        Some(num(v))
    }
}
fn text(v: &Value) -> String {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}")).to_string()
}
fn opt_text(v: &Value) -> Option<String> {
    if v.is_null() {
        None
    } else {
        Some(text(v))
    }
}
/// A JSON value of a call, with its {"$num"} markers read; a number JSON cannot hold becomes what
/// `JSON.stringify` writes for it (null), which is all the store does with such a value.
fn dec(v: &Value) -> Value {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("$num") => Number::from_f64(num(v)).map_or(Value::Null, Value::Number),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), dec(x))).collect::<Map<_, _>>()),
        Value::Array(a) => Value::Array(a.iter().map(dec).collect()),
        other => other.clone(),
    }
}
fn opt_json(v: &Value) -> Option<Value> {
    if v.is_null() {
        None
    } else {
        Some(dec(v))
    }
}
fn key(v: &Value) -> ProblemKey {
    ProblemKey { n: num(&v["N"]), m: num(&v["M"]), p: num(&v["P"]) }
}
fn opt_key(v: &Value) -> Option<ProblemKey> {
    if v.is_null() {
        None
    } else {
        Some(key(v))
    }
}
fn provenance(v: &Value) -> Provenance {
    Provenance {
        found_with: opt_text(&v["found_with"]),
        method: opt_text(&v["method"]),
        method_params: opt_json(&v["method_params"]),
        seed: opt_num(&v["seed"]),
        budget: opt_json(&v["budget"]),
        software: opt_text(&v["software"]),
    }
}
fn submission(v: &Value) -> NewSubmission {
    let p = provenance(v);
    NewSubmission {
        n: num(&v["N"]),
        m: num(&v["M"]),
        p: num(&v["P"]),
        score: num(&v["score"]),
        name: text(&v["name"]),
        agent_note: text(&v["agent_note"]),
        pieces: v["pieces"]
            .as_array()
            .expect("pieces")
            .iter()
            .map(|q| Pose { x: num(&q["x"]), y: num(&q["y"]), theta: num(&q["theta"]) })
            .collect(),
        container_phi: num(&v["container_phi"]),
        created_at: text(&v["created_at"]),
        verification: text(&v["verification"]),
        literature_value: opt_num(&v["literature_value"]),
        strict_check: opt_json(&v["strict_check"]),
        found_with: p.found_with,
        method: p.method,
        method_params: p.method_params,
        seed: p.seed,
        budget: p.budget,
        software: p.software,
    }
}
fn space_entry(v: &Value) -> NewSpaceEntry {
    NewSpaceEntry {
        space: text(&v["space"]),
        problem: text(&v["problem"]),
        score: num(&v["score"]),
        name: text(&v["name"]),
        agent_note: text(&v["agent_note"]),
        software: opt_text(&v["software"]),
        method: opt_text(&v["method"]),
        seed: opt_num(&v["seed"]),
        config: text(&v["config"]),
        created_at: text(&v["created_at"]),
    }
}
fn list<T>(v: &Value, f: impl Fn(&Value) -> T) -> Vec<T> {
    v.as_array().expect("a list").iter().map(f).collect()
}
fn space_problem(v: &Value) -> SpaceProblem {
    SpaceProblem { space: text(&v["space"]), problem: text(&v["problem"]) }
}

/// One call; its result as JSON text.
fn perform(store: &SqliteStore, spaces: &dyn SpaceIds, c: &Value) -> Result<String> {
    let op = c["op"].as_str().expect("op");
    let (n, m, p) = (&c["N"], &c["M"], &c["P"]);
    Ok(match op {
        "submit" => stringify(&store.submit(&submission(&c["s"]))?),
        "insert" => stringify(&store.insert(&submission(&c["s"]))?),
        "get" => stringify(&store.get(num(&c["id"]))?),
        "get_many" => stringify(&store.get_many(&list(&c["ids"], num))?),
        "leader" => stringify(&store.leader(num(n), num(m), num(p))?),
        "count" => stringify(&store.count(num(n), num(m), num(p))?),
        "prune" => stringify(&store.prune(num(n), num(m), num(p))?),
        "rank" => stringify(&store.rank(num(n), num(m), num(p), num(&c["id"]))?),
        "best_per_p" => stringify(&store.best_per_p(num(n), num(m), c["verified"].as_bool().unwrap_or(false))?),
        "pairs" => stringify(&store.pairs()?),
        "leaders" => stringify(&store.leaders()?),
        "leaders_after" => stringify(&store.leaders_after(opt_key(&c["after"]), num(&c["limit"]))?),
        "leaders_of" => stringify(&store.leaders_of(&list(&c["problems"], key))?),
        "problems_named" => stringify(&store.problems_named(&text(&c["name"]), opt_key(&c["after"]), num(&c["limit"]))?),
        "holder_peaks" => stringify(&store.holder_peaks()?),
        "raise_holder_peaks" => {
            store.raise_holder_peaks(&list(&c["rows"], |r| HolderPeak { name: text(&r["name"]), peak: num(&r["peak"]) }))?;
            "null".to_string()
        }
        "pending" => stringify(&store.pending()?),
        "review" => {
            let decision = if c["decision"] == "rejected" { Decision::Rejected } else { Decision::Confirmed };
            stringify(&store.review(num(&c["id"]), decision)?)
        }
        "remove" => stringify(&store.remove(num(&c["id"]))?),
        "edit" => {
            let ch = &c["changes"];
            let changes = EntryEdit {
                name: ch.get("name").map(text),
                agent_note: ch.get("agent_note").map(text),
                provenance: ch.get("provenance").map(provenance),
            };
            stringify(&store.edit(num(&c["id"]), &changes)?)
        }
        "space_submit" => stringify(&store.space_submit(&space_entry(&c["e"]))?),
        "space_get" => stringify(&store.space_get(num(&c["id"]))?),
        "space_leader" => stringify(&store.space_leader(&text(&c["space"]), &text(&c["problem"]))?),
        "space_best" => stringify(&store.space_best(&text(&c["space"]))?),
        "space_leaders" => stringify(&store.space_leaders()?),
        "space_leaders_of" => stringify(&store.space_leaders_of(&list(&c["problems"], space_problem))?),
        "space_remove" => stringify(&store.space_remove(num(&c["id"]))?),
        "space_edit" => {
            let ch = &c["changes"];
            let changes = SpaceEntryEdit { name: ch.get("name").map(text), agent_note: ch.get("agent_note").map(text) };
            stringify(&store.space_edit(num(&c["id"]), &changes)?)
        }
        "pieces_migrated" => stringify(&store.pieces_migrated()?),
        "migrate_pieces" => stringify(&store.migrate_pieces(num(&c["batch"]))?),
        "start_pieces_migration" => {
            let mut log: Vec<String> = Vec::new();
            let mut delays: Vec<f64> = Vec::new();
            let opts = MigrationOptions { batch: num(&c["batch"]), pause_ms: num(&c["pauseMs"]), log_every_ms: c.get("logEveryMs").map(num) };
            let mut run = store.start_pieces_migration(opts, &mut |m| log.push(m.to_string()))?;
            // the timer of the HTTP layer, without the waiting
            let mut next = run.first_delay_ms();
            while let Some(delay) = next {
                delays.push(delay);
                next = run.tick(store, &mut |m| log.push(m.to_string()));
            }
            stringify(&json!({ "log": log, "delays": delays }))
        }
        "units_epoch" => stringify(&store.units_epoch()?),
        "units_migrate" => stringify(&store.migrate_units(c["reverse"].as_bool().expect("reverse"), spaces)?),
        "units_digest" => stringify(&units_digest(store.db())?),
        "exec" => {
            store.db().exec(&text(&c["sql"]))?;
            "null".to_string()
        }
        other => panic!("unknown op {other}"),
    })
}

fn error_json(e: &StoreError) -> Value {
    // a SyntaxError of JSON.parse by its class only: V8's wording is not ported
    if e.name() == "SyntaxError" {
        json!({ "name": e.name() })
    } else {
        json!({ "name": e.name(), "message": e.message() })
    }
}

/// One bound value, as the ref tool writes it: a number as JavaScript prints it, a string as
/// JSON, bytes as hex.
fn traced(p: &Param<'_>) -> String {
    match p {
        Param::Null => "null".to_string(),
        Param::Num(x) => polypack_js::fmt::num(*x),
        Param::Text(s) => stringify(s),
        Param::Blob(b) => format!("x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
    }
}

fn tracer(path: String) -> Tracer {
    let mut out = std::io::BufWriter::new(fs::OpenOptions::new().create(true).append(true).open(path).expect("the trace"));
    Box::new(move |_, event| {
        let line = match event {
            TraceEvent::Exec(sql) => format!("E {}", stringify(sql)),
            TraceEvent::Prepare(sql) => format!("P {}", stringify(sql)),
            TraceEvent::Step(sql, params) => {
                format!("S {} [{}]", stringify(sql), params.iter().map(traced).collect::<Vec<_>>().join(","))
            }
        };
        writeln!(out, "{line}").expect("write");
        Ok(())
    })
}

/// The values of a traced step: `[null,1.5,"text",x00ff]`.
fn traced_values(list: &str) -> Vec<JsVal> {
    let mut out = Vec::new();
    let mut rest = list.strip_prefix('[').and_then(|l| l.strip_suffix(']')).expect("a list of values");
    while !rest.is_empty() {
        let end;
        if rest.starts_with('"') {
            let mut texts = serde_json::Deserializer::from_str(rest).into_iter::<String>();
            out.push(JsVal::Text(texts.next().expect("a string").expect("a JSON string")));
            end = texts.byte_offset();
        } else {
            end = rest.find(',').unwrap_or(rest.len());
            let token = &rest[..end];
            out.push(match token {
                "null" => JsVal::Null,
                "NaN" => JsVal::Num(f64::NAN),
                "Infinity" => JsVal::Num(f64::INFINITY),
                "-Infinity" => JsVal::Num(f64::NEG_INFINITY),
                t if t.starts_with('x') => {
                    JsVal::Blob((1..t.len()).step_by(2).map(|i| u8::from_str_radix(&t[i..i + 2], 16).expect("hex")).collect())
                }
                t => JsVal::Num(t.parse().unwrap_or_else(|_| panic!("a number: {t}"))),
            });
        }
        rest = rest[end..].strip_prefix(',').unwrap_or(&rest[end..]);
    }
    out
}

fn replay(trace: &str, path: &str) {
    let db = Db::open(path).expect("the database");
    let (mut sent, mut refused) = (0, 0);
    for line in fs::read_to_string(trace).expect("the trace").lines() {
        let (kind, rest) = line.split_at(2);
        let mut texts = serde_json::Deserializer::from_str(rest).into_iter::<String>();
        let sql = texts.next().expect("a statement").expect("a JSON string");
        let values = &rest[texts.byte_offset()..];
        let done = match kind {
            "E " => db.exec(&sql),
            "S " => {
                let values = traced_values(values.trim());
                db.prepare(&sql).and_then(|mut st| st.all(&values.iter().map(Param::from).collect::<Vec<_>>())).map(|_| ())
            }
            // preparing alone changes nothing
            _ => continue,
        };
        sent += 1;
        // a statement that failed for the store fails here too, and the store's ROLLBACK follows in the trace
        if done.is_err() {
            refused += 1;
        }
    }
    println!("{sent} statements sent, {refused} refused");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() == 3 && args[0] == "replay" {
        return replay(&args[1], &args[2]);
    }
    if args.len() < 7 || args[0] != "run" {
        eprintln!("usage: storediff run CALLS SPACEIDS DB FROM TO OUT [leave] | storediff replay TRACE DB");
        std::process::exit(1);
    }
    let calls: Vec<String> = fs::read_to_string(&args[1]).expect("the calls").lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
    let spaces = TableSpaceIds::load(&args[2]);
    let (from, to): (usize, usize) = (args[4].parse().expect("FROM"), args[5].parse().expect("TO"));
    let leave = args.get(7).is_some_and(|a| a == "leave");
    let mut lines: Vec<String> = Vec::new();
    let mut log: Vec<String> = Vec::new();
    let opened = {
        let mut on_log = |m: &str| log.push(m.to_string());
        SqliteStore::open(
            &args[3],
            OpenOptions {
                migrate_units: !leave,
                log: Some(&mut on_log),
                spaces: &spaces,
                clock: Box::new(MockClock { perf: Cell::new(0.0), date: Cell::new(1_800_000_000_000.0) }),
                tracer: std::env::var("STORE_TRACE").ok().filter(|f| !f.is_empty()).map(tracer),
            },
        )
    };
    match opened {
        Err(e) => lines.push(stringify(&json!({ "open": { "error": { "name": e.name(), "message": e.message() }, "log": log } }))),
        Ok(store) => {
            lines.push(format!(
                "{{\"open\":{{\"unitsReport\":{},\"log\":{},\"piecesMigrated\":{}}}}}",
                stringify(&store.units_report),
                stringify(&log),
                stringify(&store.pieces_migrated().expect("the meta table"))
            ));
            for call in calls.iter().take(to.min(calls.len())).skip(from) {
                let c: Value = serde_json::from_str(call).expect("a call");
                lines.push(match perform(&store, &spaces, &c) {
                    Ok(line) => line,
                    Err(e) => stringify(&json!({ "error": error_json(&e) })),
                });
            }
        }
    }
    let mut out = fs::OpenOptions::new().create(true).append(true).open(&args[6]).expect("OUT");
    out.write_all((lines.join("\n") + "\n").as_bytes()).expect("write");
}
