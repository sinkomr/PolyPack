//! The port against the TypeScript's verdicts, without Node: the cases and results under
//! `tests/fixtures/` were written by `native/tools/torus-ref.mts --fixtures` (a few cases of
//! every kind of the full comparison, small ones) under Node 24 on Linux x86-64, the production
//! platform (native/tools/LINUX_REFERENCE.md). A result must be the reference's exactly: every
//! boolean, index, count and string, and every number the same double
//! (`polypack_torus::json::agreement` must say `Identical`; "equal up to the last digits" fails).
//! `Identical` takes 0 and -0 for one number: the reference is JSON, which has no -0.

use polypack_torus::json::{agreement, aux_result, case_line, Agreement};
use serde_json::Value;

fn fixture(name: &str) -> Vec<Value> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// Runs `port` on every case and compares with the reference; returns how many cases there are.
fn check_all(cases: &str, reference: &str, port: impl Fn(&Value) -> Value) -> usize {
    let (cases, reference) = (fixture(cases), fixture(reference));
    assert_eq!(cases.len(), reference.len());
    let mut failures = Vec::new();
    for (case, expected) in cases.iter().zip(&reference) {
        assert_eq!(case["id"], expected["id"]);
        match agreement(expected, &port(case)) {
            Agreement::Identical => {}
            Agreement::Close => failures.push(format!(
                "case {} ({}): equal only up to the last digits of a number",
                case["id"],
                case.get("kind").unwrap_or(&case["fn"])
            )),
            Agreement::Different(place) => failures.push(format!(
                "case {} ({}): {place}",
                case["id"],
                case.get("kind").unwrap_or(&case["fn"])
            )),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} are not the TypeScript's exactly:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    cases.len()
}

#[test]
fn validator_and_check_agree_with_the_typescript() {
    let identical = check_all("cases.jsonl", "ref.jsonl", case_line);
    println!("torus cases: {identical} identical");
    assert!(identical >= 40, "the fixtures are missing");
}

#[test]
fn other_functions_agree_with_the_typescript() {
    let identical = check_all(
        "aux-cases.jsonl",
        "aux-ref.jsonl",
        |v| serde_json::json!({ "id": v["id"], "result": aux_result(v) }),
    );
    println!("torus functions: {identical} identical");
    assert!(identical >= 20, "the fixtures are missing");
}
