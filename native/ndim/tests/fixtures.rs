//! The port against the TypeScript without Node: `fixtures/cases.jsonl` holds cases of the
//! comparison (native/tools/ndim-ref.mts wrote them, `--fixtures`) with the TypeScript's answers,
//! and every answer of the crate must be the same, as native/tools/ndim-compare.mjs decides it
//! (numbers inside messages and number fields to 1e-6 relative or 1e-12 absolute; in fact they are
//! the same doubles except the bounds, which go through `Math.pow`).
//!
//! This file holds one test on purpose: the cases run in the file's order in a process of their
//! own, as they did for the reference, because the polytopes that are loaded on demand stay loaded
//! (a `table` case says whether its polytope was loaded before).
#[path = "eval/mod.rs"]
mod eval;

use serde_json::Value;

#[test]
fn the_answers_are_the_typescripts() {
    polypack_ndim::validate::performance_now();
    let text = include_str!("fixtures/cases.jsonl");
    let mut n = 0;
    let mut identical = 0;
    let mut kinds = std::collections::BTreeSet::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let v: Value = serde_json::from_str(line).expect("a fixture line");
        let case = &v["case"];
        let got = eval::answer(case);
        let mut exact = true;
        assert!(
            eval::same(&v["ref"], &got, &mut exact),
            "case {} ({} / {} / {}):\n  TypeScript: {}\n  Rust:       {}",
            case["id"],
            case["op"],
            case["group"],
            case["kind"],
            v["ref"],
            got
        );
        n += 1;
        identical += exact as usize;
        kinds.insert(format!("{}/{}", case["op"].as_str().unwrap_or(""), case["group"].as_str().unwrap_or("")));
    }
    assert!(n >= 36, "only {n} fixtures");
    assert!(kinds.len() >= 12, "only {} kinds of fixtures", kinds.len());
    println!("{n} fixtures, {identical} identical in every digit, {} kinds", kinds.len());
}
