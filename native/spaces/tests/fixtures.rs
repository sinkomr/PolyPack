//! The port against the TypeScript's answers, without Node: the fixtures under tests/fixtures/ are
//! cases with the answers `native/tools/spaces-ref.mts --fixtures` wrote for them (a sample of the
//! comparison described in native/PORTING.md).
//!
//!  - validate.jsonl: `{ case, ref }`, a configuration of a problem with the options the server
//!    passes, and what parseSpaceConfig, validateSpaceSubmission and its Async variant answer;
//!  - aux.jsonl: `{ case, result }`: ids, domains, catalogues of damaged record files, problems of
//!    the repository's data/, stored configurations of free tori, the comparison rules, the constants.
//!
//! Booleans, counts, keys and the text of every message must be the same; a stored configuration
//! and an id must be the same text; a computed number may differ by 1e-6 relative or 1e-12 absolute
//! (the last digits of a sine).

mod support;

use serde_json::Value;

/// The numbers of a text, and the text with each replaced by `#`.
fn numbers(text: &str) -> (String, Vec<String>) {
    let b = text.as_bytes();
    let mut shape = String::new();
    let mut found = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let mut j = i;
        if b[j] == b'-' && j + 1 < b.len() && b[j + 1].is_ascii_digit() {
            j += 1;
        }
        if j < b.len() && b[j].is_ascii_digit() {
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j < b.len() && b[j] == b'.' {
                j += 1;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
            }
            if j < b.len() && b[j] == b'e' {
                let mut k = j + 1;
                if k < b.len() && (b[k] == b'-' || b[k] == b'+') {
                    k += 1;
                }
                if k < b.len() && b[k].is_ascii_digit() {
                    while k < b.len() && b[k].is_ascii_digit() {
                        k += 1;
                    }
                    j = k;
                }
            }
            found.push(text[start..j].to_string());
            shape.push('#');
            i = j;
        } else {
            let ch = text[i..].chars().next().unwrap();
            shape.push(ch);
            i += ch.len_utf8();
        }
    }
    (shape, found)
}

fn near(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    let d = (a - b).abs();
    d <= 1e-12 || d <= 1e-6 * a.abs().max(b.abs())
}

fn text_near(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (sa, na) = numbers(a);
    let (sb, nb) = numbers(b);
    let whole = |t: &str| t.bytes().all(|c| c.is_ascii_digit() || c == b'-');
    sa == sb
        && na.len() == nb.len()
        && na.iter().zip(&nb).all(|(x, y)| if whole(x) && whole(y) { x == y } else { near(x.parse().unwrap_or(f64::NAN), y.parse().unwrap_or(f64::NAN)) })
}

/// Fields whose text is passed through and must be the same bytes.
const EXACT: [&str; 7] = ["config", "id", "formatted", "text", "ids", "byId", "served"];

/// The path of the first difference of two answers, or None.
fn differ(a: &Value, b: &Value, path: &str, key: &str) -> Option<String> {
    if a == b {
        return None;
    }
    let exact = EXACT.contains(&key);
    match (a, b) {
        (Value::String(x), Value::String(y)) if !exact && text_near(x, y) => None,
        (Value::Number(x), Value::Number(y)) if x.as_f64() == y.as_f64() || (!exact && near(x.as_f64().unwrap(), y.as_f64().unwrap())) => None,
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x.iter().zip(y).enumerate().find_map(|(i, (u, v))| differ(u, v, &format!("{path}[{i}]"), key)),
        (Value::Object(x), Value::Object(y)) if x.keys().eq(y.keys()) => x.iter().find_map(|(k, u)| differ(u, &y[k], &format!("{path}.{k}"), k)),
        _ => Some(format!("{path}: {a} | {b}")),
    }
}

fn fixtures(name: &str) -> Vec<Value> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| polypack_js::json::parse(l.as_bytes()).unwrap())
        .collect()
}

#[test]
fn the_checks_answer_as_the_typescript() {
    let list = fixtures("validate.jsonl");
    assert!(list.len() >= 40, "{} fixtures", list.len());
    let mut failures = Vec::new();
    for f in &list {
        let (case, want) = (&f["case"], &f["ref"]);
        // The plain check does not load the ndim polytopes kept on demand; the reference ran its
        // cases in another order, so here the Async variant runs first and the plain one is
        // compared when the reference's two verdicts agree (the polytopes were loaded for both).
        let ndim = case["space"] == "ndim";
        let got = support::main_result_in_order(case, ndim);
        for part in ["parse", "sync", "async"] {
            if part == "sync" && ndim && want["sync"] != want["async"] {
                continue;
            }
            if let Some(why) = differ(&want[part], &got[part], part, part) {
                failures.push(format!("case {} ({}, {}, {}) {why}", case["id"], case["space"], case["kind"], case["problem"]));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), list.len(), failures.join("\n"));
}

#[test]
fn ids_domains_and_catalogues_answer_as_the_typescript() {
    let list = fixtures("aux.jsonl");
    assert!(list.len() >= 40, "{} fixtures", list.len());
    let mut failures = Vec::new();
    for f in &list {
        let (case, want) = (&f["case"], &f["result"]);
        let got = support::aux_result(case);
        if let Some(why) = differ(want, &got, "", "") {
            failures.push(format!("case {} ({}) {why}", case["id"], case["kind"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), list.len(), failures.join("\n"));
}
