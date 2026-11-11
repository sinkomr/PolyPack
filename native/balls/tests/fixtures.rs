//! The port against the TypeScript's answers kept in `tests/fixtures/` (written by
//! `native/tools/balls-ref.mts --fixtures`): a few cases of every kind for each kind of problem (balls in a ball,
//! in a cube, in another solid; solids in a ball) with what the server's parse and `validateBalls` (tolerances
//! 1e-9 and 1e-11, at most 20 errors) said, and lines of the catalogue. The full comparison is the example
//! `ballsdiff` with `native/tools/balls-compare.mjs`.

mod common;

use serde_json::Value;

fn lines(name: &str) -> Vec<String> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// The validator has only sums, products, quotients, square roots and `Math.hypot`, which are the same in both
/// languages: every answer must be the TypeScript's byte for byte.
#[test]
fn cases_answer_as_the_typescript() {
    let cases = lines("cases.jsonl");
    let reference = lines("ref.jsonl");
    assert_eq!(cases.len(), reference.len());
    assert!(cases.len() >= 100, "only {} fixture cases", cases.len());
    let mut kinds = std::collections::BTreeSet::new();
    for (case, want) in cases.iter().zip(&reference) {
        let case: Value = serde_json::from_str(case).expect("a case");
        kinds.insert(case["kind"].as_str().unwrap().to_string());
        assert_eq!(&common::answer_line(&case), want, "case {} ({})", case["id"], case["kind"]);
    }
    assert!(kinds.len() >= 20, "kinds: {kinds:?}");
}

/// The numbers of a catalogue line: every JSON string that reads as a number, in order.
fn numbers(v: &Value, out: &mut Vec<f64>) {
    match v {
        Value::String(s) => {
            if let Ok(x) = s.parse::<f64>() {
                out.push(x);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| numbers(x, out)),
        Value::Object(o) => o.values().for_each(|x| numbers(x, out)),
        _ => {}
    }
}

/// Names, ids, containers and messages are the TypeScript's byte for byte. The volume bound is a cube root, and
/// `polypack_js::math::cbrt` can differ from V8's in the last place (native/PORTING.md): a bound's line must have
/// the same kind and label and its value within 1e-12 relative.
#[test]
fn catalogue_is_the_typescript_s() {
    let reference = lines("catalogue.jsonl");
    assert!(reference.len() > 400);
    for want in &reference {
        let v: Value = serde_json::from_str(want).expect("a catalogue line");
        let key = v["k"].as_str().expect("k");
        let got = common::catalogue_line(key);
        if &got == want {
            continue;
        }
        assert!(key.starts_with("bound/") || key.starts_with("domain_bound/"), "{key}:\n {got}\n {want}");
        let g: Value = serde_json::from_str(&got).unwrap();
        let (mut a, mut b) = (Vec::new(), Vec::new());
        numbers(&g["v"]["value"], &mut a);
        numbers(&v["v"]["value"], &mut b);
        assert_eq!(a.len(), 1, "{key}");
        assert_eq!(b.len(), 1, "{key}");
        assert!((a[0] - b[0]).abs() <= 1e-12 * b[0].abs(), "{key}: {} | {}", a[0], b[0]);
        assert_eq!(g["v"]["kind"], v["v"]["kind"], "{key}");
        assert_eq!(g["v"]["label"], v["v"]["label"], "{key}");
    }
}
