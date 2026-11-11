//! The port against the TypeScript's answers kept in `tests/fixtures` (written by
//! `native/tools/flat-ref.mts --fixtures`): a sample of the comparison that runs without Node.
//!
//! - cases.jsonl / ref.jsonl: bodies of POST /api/submit (real leading boards, their mutants,
//!   random boards, lattices, boards at the limits, malformed bodies, JSON texts) with what
//!   parseConfig, parseProvenance, evaluate, findOverlaps and strictVerify answer;
//! - calls.jsonl / calls-ref.jsonl: single calls of the kernels, the shape constants, the hull and
//!   the enclosing containers, strictVerify, the rules about published values, parseProvenance and
//!   eventKeys.
//!
//! The rule is native/PORTING.md's (see `support::difference`): the same verdicts, counts and
//! pieces, texts equal once numbers are placeholders, numbers to the last digits.

mod support;

use serde_json::Value;

fn lines(name: &str) -> Vec<Value> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{path}: {e}")))
        .collect()
}

#[test]
fn bodies_are_answered_as_the_typescript_answers_them() {
    let cases = lines("cases.jsonl");
    let reference = lines("ref.jsonl");
    assert_eq!(cases.len(), reference.len());
    assert!(cases.len() >= 100, "only {} cases", cases.len());
    let mut kinds: Vec<&str> = cases.iter().map(|c| c["kind"].as_str().unwrap()).collect();
    kinds.sort_unstable();
    kinds.dedup();
    assert!(kinds.len() >= 14, "kinds: {kinds:?}");
    let (mut valid, mut invalid, mut malformed) = (0, 0, 0);
    for (case, want) in cases.iter().zip(&reference) {
        let got = support::run_case(case);
        if let Some(d) = support::difference("case", want, &got, support::coordinate_scale(case)) {
            panic!("case {} ({}): {d}", case["id"], case["kind"]);
        }
        match want["server"]["valid"].as_bool() {
            Some(true) => valid += 1,
            Some(false) => invalid += 1,
            None => malformed += 1,
        }
    }
    // the sample holds every kind of answer
    assert!(valid >= 30 && invalid >= 30 && malformed >= 30, "{valid} valid, {invalid} invalid, {malformed} malformed");
}

#[test]
fn single_functions_answer_as_the_typescript_does() {
    let calls = lines("calls.jsonl");
    let reference = lines("calls-ref.jsonl");
    assert_eq!(calls.len(), reference.len());
    let mut functions: Vec<&str> = calls.iter().map(|c| c["fn"].as_str().unwrap()).collect();
    functions.sort_unstable();
    functions.dedup();
    assert_eq!(functions, ["bound", "eventKeys", "improves", "lit", "pair", "points", "provenance", "shape", "shapeCode", "strict"]);
    for (call, want) in calls.iter().zip(&reference) {
        let got = support::run_call(call);
        if let Some(d) = support::difference("call", want, &got, support::coordinate_scale(call)) {
            panic!("call {} ({}): {d}", call["id"], call["fn"]);
        }
    }
}

/// The refusal names the pair the TypeScript names: the scan of `findOverlaps` and its cut at the
/// limit are the source's. Every reason of the sample is the same text, byte for byte.
#[test]
fn refusals_are_the_same_text() {
    let cases = lines("cases.jsonl");
    let reference = lines("ref.jsonl");
    let mut checked = 0;
    for (case, want) in cases.iter().zip(&reference) {
        let Some(reasons) = want["server"]["reasons"].as_array() else { continue };
        if reasons.is_empty() {
            continue;
        }
        let got = support::run_case(case);
        assert_eq!(got["server"]["reasons"], want["server"]["reasons"], "case {}", case["id"]);
        assert_eq!(got["server"]["overlaps"]["hash"], want["server"]["overlaps"]["hash"], "case {}", case["id"]);
        assert_eq!(got["full"]["overlaps"]["hash"], want["full"]["overlaps"]["hash"], "case {}", case["id"]);
        checked += 1;
    }
    assert!(checked >= 30, "only {checked} refusals in the sample");
}
