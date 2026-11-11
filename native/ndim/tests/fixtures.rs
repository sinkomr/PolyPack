//! The port against the TypeScript without Node: `fixtures/cases.jsonl` holds cases of the
//! comparison (native/tools/ndim-ref.mts wrote them, `--fixtures`, under Node 24 on Linux x86-64, the
//! production platform: native/tools/LINUX_REFERENCE.md) with the TypeScript's answers, and every
//! answer of the crate must be the same exactly: every text, and every number the same double.
//! One kind of number is excepted, by name (`eval::difference`): a volume bound, which is
//! `Math.pow(x, 1 / d)` and may be the neighbouring double.
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
    the_exception_is_the_volume_bound_and_one_unit_only();
    let text = include_str!("fixtures/cases.jsonl");
    let mut n = 0;
    let mut pow_differences = 0;
    let mut kinds = std::collections::BTreeSet::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let v: Value = serde_json::from_str(line).expect("a fixture line");
        let case = &v["case"];
        let got = eval::answer(case);
        if let Some(why) = eval::difference(&v["ref"], &got, case["op"] == "bound", &mut pow_differences) {
            panic!("case {} ({} / {} / {}) {why}\n  TypeScript: {}\n  Rust:       {}", case["id"], case["op"], case["group"], case["kind"], v["ref"], got);
        }
        n += 1;
        kinds.insert(format!("{}/{}", case["op"].as_str().unwrap_or(""), case["group"].as_str().unwrap_or("")));
    }
    assert!(n >= 36, "only {n} fixtures");
    assert!(kinds.len() >= 12, "only {} kinds of fixtures", kinds.len());
    println!("{n} fixtures of {} kinds, every answer the TypeScript's exactly; {pow_differences} volume bounds (Math.pow) are the neighbouring double", kinds.len());
}

/// The one exception of `eval::difference`, on a row the full comparison met (4D, 13 simplices in a 24-cell: Node 24 on
/// Linux gives Math.pow(0.15140043597654856, 0.25) = 0.6237804817413072, the correctly rounded value is ...073): it
/// covers the volume bound's own numbers, by one unit in the last place, and nothing else. Called by the one test.
fn the_exception_is_the_volume_bound_and_one_unit_only() {
    let row = |value: &str, entry: &str, kind: &str| {
        serde_json::json!({ "rows": [{
            "P": 13,
            "domain": { "value": entry, "label": format!("{kind} bound; [CALC]") },
            "lower": { "value": value, "kind": kind, "entry": entry, "label": format!("{kind} bound; [CALC]") },
        }] })
    };
    let node = row("0.6237804817413072", "0.6237804817406835", "volume");
    let port = row("0.6237804817413073", "0.6237804817406836", "volume");
    let mut used = 0;
    assert_eq!(eval::difference(&node, &port, true, &mut used), None);
    assert_eq!(used, 3, "value, entry and the domain's value");
    // two units apart is a difference
    assert!(eval::difference(&node, &row("0.6237804817413074", "0.6237804817406835", "volume"), true, &mut used).is_some());
    // a bound of another kind is exact, and so is everything outside a `bound` case
    let (a, b) = (row("0.6237804817413072", "0.6237804817406835", "inradius"), row("0.6237804817413073", "0.6237804817406835", "inradius"));
    assert!(eval::difference(&a, &b, true, &mut used).is_some());
    assert!(eval::difference(&node, &port, false, &mut used).is_some());
}
