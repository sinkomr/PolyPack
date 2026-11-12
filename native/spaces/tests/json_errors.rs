//! `v8_json_error` against Node: the cases of tests/fixtures/json_errors.json, which
//! native/tools/routes-jsonerr.mts writes with what `JSON.parse` says of each text.
//! `POLYPACK_JSON_ERRORS=<file>` runs another file of the same form (a larger sample).

use polypack_spaces::json_error::v8_json_error;
use serde_json::Value;

#[test]
fn the_messages_are_v8s() {
    let path = std::env::var("POLYPACK_JSON_ERRORS").unwrap_or_else(|_| format!("{}/tests/fixtures/json_errors.json", env!("CARGO_MANIFEST_DIR")));
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("the cases")).expect("JSON");
    let cases = file["cases"].as_array().expect("cases");
    assert!(cases.len() >= 500);
    let mut wrong = Vec::new();
    for case in cases {
        let text = case["text"].as_str().expect("a text");
        let expected = case["message"].as_str().map(str::to_string);
        let got = v8_json_error(text);
        if got != expected {
            wrong.push(format!("{text:?}\n  Node: {expected:?}\n  here: {got:?}"));
        }
    }
    assert!(wrong.is_empty(), "{} of {} differ:\n{}", wrong.len(), cases.len(), wrong.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
}
