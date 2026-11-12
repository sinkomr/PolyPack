//! The port against the TypeScript's answers kept in `tests/fixtures/` (written by
//! `native/tools/balls-ref.mts --fixtures` under Node 24 on Linux x86-64, the production platform:
//! native/tools/LINUX_REFERENCE.md): a few cases of every kind for each kind of problem (balls in a ball, in a
//! cube, in another solid; solids in a ball) with what the server's parse and `validateBalls` (tolerances 1e-9 and
//! 1e-11, at most 20 errors) said, and lines of the catalogue. Every answer and every line must be the
//! TypeScript's byte for byte. The full comparison is the example `ballsdiff` with
//! `native/tools/balls-compare.mjs`.

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

/// Names, lists, ids, containers, messages and bounds are the TypeScript's byte for byte. The volume bound is a cube
/// root: `polypack_js::math::cbrt` is V8's own, bit for bit, so its lines are exact too.
#[test]
fn catalogue_is_the_typescript_s() {
    let reference = lines("catalogue.jsonl");
    assert!(reference.len() > 400);
    for want in &reference {
        let v: Value = serde_json::from_str(want).expect("a catalogue line");
        let key = v["k"].as_str().expect("k");
        assert_eq!(&common::catalogue_line(key), want, "{key}");
    }
}
