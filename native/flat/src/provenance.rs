//! Port of packages/geometry/src/provenance.ts: how a submission was found, read from the fields
//! of an untrusted POST /api/submit body.
//!
//! JavaScript's `undefined` is an absent key here and its `null` is `Value::Null`; the source
//! tells them apart (`seed: null` is an error, an absent seed is not) and so does this.

use crate::protocol::{FoundWith, Provenance, RunBudget, FOUND_WITH};
use polypack_js::fmt;
use serde_json::{Map, Value};

/// provenance.ts: MAX_METHOD_PARAMS_BYTES. Largest `method_params` accepted, in bytes of its JSON
/// text.
pub const MAX_METHOD_PARAMS_BYTES: usize = 4096;
/// provenance.ts: MAX_SOFTWARE_LENGTH. Longest `software` name accepted, in UTF-16 code units (a
/// JavaScript string's `length`).
pub const MAX_SOFTWARE_LENGTH: usize = 80;

/// provenance.ts: utf8Length. Length of a string in UTF-8 bytes, counted as the source counts it
/// over UTF-16 code units. A Rust string holds no lone surrogate, so this is `text.len()`; the
/// loop is kept so that the port can be read against its source.
pub fn utf8_length(text: &str) -> usize {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut n = 0;
    let mut i = 0;
    while i < units.len() {
        let c = units[i];
        if c < 0x80 {
            n += 1;
        } else if c < 0x800 {
            n += 2;
        } else if (0xd800..=0xdbff).contains(&c) && i + 1 < units.len() && (units[i + 1] & 0xfc00) == 0xdc00 {
            // a surrogate pair is one code point of four bytes
            n += 4;
            i += 1;
        } else {
            n += 3;
        }
        i += 1;
    }
    n
}

/// `JSON.stringify(value)` for a parsed JSON value: no spaces, numbers as JavaScript writes them
/// (`1e21`, `1e-7`, `-0` as `0`), strings with JavaScript's escapes, and an object's keys in
/// JavaScript's order: the keys that are array indices ("0", "1", ...; up to 2^32 - 2) ascending,
/// then the others in the order `map` gives them. That is the order of the text only when
/// serde_json keeps insertion order (its `preserve_order` feature); the length of the result,
/// which is all [`parse_provenance`] uses, does not depend on it.
pub fn json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_f64() {
            Some(x) if x.is_finite() => out.push_str(&fmt::num(x)),
            _ => out.push_str("null"),
        },
        Value::String(s) => write_json_string(s, out),
        Value::Array(list) => {
            out.push('[');
            for (i, v) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(v, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut indices: Vec<(u32, &String, &Value)> = Vec::new();
            let mut names: Vec<(&String, &Value)> = Vec::new();
            for (k, v) in map {
                match array_index(k) {
                    Some(i) => indices.push((i, k, v)),
                    None => names.push((k, v)),
                }
            }
            indices.sort_by_key(|e| e.0);
            out.push('{');
            let mut first = true;
            for (k, v) in indices.into_iter().map(|(_, k, v)| (k, v)).chain(names) {
                if !first {
                    out.push(',');
                }
                first = false;
                write_json_string(k, out);
                out.push(':');
                write_json(v, out);
            }
            out.push('}');
        }
    }
}

/// The array index a property key is, if it is one: the canonical decimal text of a whole number
/// below 2^32 - 1. JavaScript lists such keys first, in ascending order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse::<u64>().ok().filter(|&v| v < 4294967295).map(|v| v as u32)
}

/// A string as `JSON.stringify` quotes it.
fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `Number.isSafeInteger(v)`: the number, when the value is a whole number of magnitude at most
/// 2^53 - 1.
fn safe_integer(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite() && x.trunc() == *x && x.abs() <= 9007199254740991.0),
        _ => None,
    }
}

/// provenance.ts: RUN_FIELDS.
const RUN_FIELDS: [&str; 4] = ["method", "method_params", "seed", "budget"];

/// provenance.ts: parseProvenance. Reads how a submission was found from the fields of an
/// untrusted POST /api/submit body (a JSON object; the route does not call this for anything
/// else). `methods` lists the registered PolyPack search methods. Absent fields are None.
///
/// Without `found_with` the entry counts as found by hand, except for a legacy body that declares
/// `agent: "ai"`: how such an entry was found is unknown, so it is stored as not recorded (None).
/// `agent` itself is otherwise ignored, whatever its value.
pub fn parse_provenance(input: &Map<String, Value>, methods: &[&str]) -> Result<Provenance, Vec<String>> {
    let mut errors: Vec<String> = Vec::new();
    let o = input;
    let found: Option<FoundWith>;
    match o.get("found_with") {
        None => found = if o.get("agent").and_then(Value::as_str) == Some("ai") { None } else { Some(FoundWith::Hand) },
        Some(Value::String(s)) if FoundWith::parse(s).is_some() => found = FoundWith::parse(s),
        Some(_) => {
            let list: Vec<String> = FOUND_WITH.iter().map(|v| format!("\"{v}\"")).collect();
            errors.push(format!("found_with must be one of {}", list.join(", ")));
            found = None;
        }
    }
    let run = found == Some(FoundWith::Optimizer) || found == Some(FoundWith::OptimizerEdited);

    let method = o.get("method");
    if method.is_some_and(|v| !v.as_str().is_some_and(|name| methods.contains(&name))) {
        errors.push(format!("method must be the name of a registered search method: {}", methods.join(", ")));
    } else if run && method.is_none() {
        errors.push(format!("method is required when found_with is \"{}\"", found.unwrap().as_str()));
    }

    let method_params = o.get("method_params");
    if let Some(v) = method_params {
        match v {
            Value::Object(_) => {
                if utf8_length(&json_stringify(v)) > MAX_METHOD_PARAMS_BYTES {
                    errors.push(format!("method_params must be at most {MAX_METHOD_PARAMS_BYTES} bytes as JSON"));
                }
            }
            _ => errors.push("method_params must be a JSON object".to_string()),
        }
    }

    let seed = o.get("seed");
    if seed.is_some_and(|v| !safe_integer(v).is_some_and(|x| x >= 0.0)) {
        errors.push("seed must be a non-negative integer".to_string());
    }

    let budget = o.get("budget");
    if let Some(b) = budget {
        let ok = match b {
            Value::Object(fields) => {
                !fields.is_empty()
                    && fields.keys().all(|k| k == "evals" || k == "time_s")
                    && fields.get("evals").map_or(true, |v| safe_integer(v).is_some_and(|x| x > 0.0))
                    && fields.get("time_s").map_or(true, |v| matches!(v, Value::Number(n) if n.as_f64().is_some_and(|x| x.is_finite() && x > 0.0)))
            }
            _ => false,
        };
        if !ok {
            errors.push("budget must be {evals?: positive integer, time_s?: positive number} with at least one of them".to_string());
        }
    }

    let software = o.get("software");
    if let Some(v) = software {
        match v {
            Value::String(s) => {
                if s.encode_utf16().count() > MAX_SOFTWARE_LENGTH {
                    errors.push(format!("software must be at most {MAX_SOFTWARE_LENGTH} characters"));
                }
            }
            _ => errors.push("software must be a string".to_string()),
        }
    }

    // The run fields describe a PolyPack optimizer run, and the software field the program that
    // produced the packing: one's own tool, or the client that ran a PolyPack optimizer (such as
    // "polypack-volunteer/1.0"). Each contradicts any other declaration, a packing made by hand
    // included, so it is refused rather than silently dropped.
    if found.is_some() || o.get("found_with").is_none() {
        let stray: Vec<&str> = RUN_FIELDS.iter().copied().filter(|k| o.contains_key(*k)).collect();
        if !run && !stray.is_empty() {
            errors.push(format!(
                "{} describe a PolyPack optimizer run: they need found_with \"optimizer\" or \"optimizer_edited\"",
                stray.join(", ")
            ));
        }
        if !run && found != Some(FoundWith::External) && software.is_some() {
            errors.push("software needs found_with \"external\", \"optimizer\" or \"optimizer_edited\"".to_string());
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }
    // `?? null`: an absent field and a null one are both None. (With no errors, method is a
    // string or absent, method_params an object or absent, and so on.)
    let number = |v: &Value| v.as_f64();
    Ok(Provenance {
        found_with: found,
        method: method.and_then(Value::as_str).map(str::to_string),
        method_params: method_params.and_then(Value::as_object).cloned(),
        seed: seed.and_then(number),
        budget: budget.and_then(Value::as_object).map(|b| RunBudget {
            evals: b.get("evals").and_then(number),
            time_s: b.get("time_s").and_then(number),
        }),
        software: software.and_then(Value::as_str).map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_text_is_javascripts() {
        let v = json!({"b": 1.0, "10": [1e21, 1e-7, -0.0, 0.1, null, true], "2": "a\"\\\n\u{1}é😀", "a": {}});
        let text = json_stringify(&v);
        assert!(text.starts_with("{\"2\":\"a\\\"\\\\\\n\\u0001é😀\",\"10\":[1e+21,1e-7,0,0.1,null,true],"));
        assert_eq!(utf8_length(&text), text.len());
        assert_eq!(utf8_length("aé€😀"), 1 + 2 + 3 + 4);
        assert_eq!(array_index("4294967294"), Some(4294967294));
        assert_eq!(array_index("4294967295"), None);
        assert_eq!(array_index("01"), None);
        assert_eq!(array_index("0"), Some(0));
    }

    #[test]
    fn a_body_without_found_with_is_by_hand() {
        let methods = ["basin-hopping", "ls-growth"];
        let body = json!({"N": 4});
        let p = parse_provenance(body.as_object().unwrap(), &methods).unwrap();
        assert_eq!(p.found_with, Some(FoundWith::Hand));
        let body = json!({"agent": "ai"});
        assert_eq!(parse_provenance(body.as_object().unwrap(), &methods).unwrap().found_with, None);
        let body = json!({"found_with": "optimizer", "seed": -1, "software": 5});
        assert_eq!(
            parse_provenance(body.as_object().unwrap(), &methods),
            Err(vec![
                "method is required when found_with is \"optimizer\"".to_string(),
                "seed must be a non-negative integer".to_string(),
                "software must be a string".to_string(),
            ])
        );
        let body = json!({"method": "ls-growth", "software": "x"});
        assert_eq!(
            parse_provenance(body.as_object().unwrap(), &methods),
            Err(vec![
                "method describe a PolyPack optimizer run: they need found_with \"optimizer\" or \"optimizer_edited\"".to_string(),
                "software needs found_with \"external\", \"optimizer\" or \"optimizer_edited\"".to_string(),
            ])
        );
    }
}
