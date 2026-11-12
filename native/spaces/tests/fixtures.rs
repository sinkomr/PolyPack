//! The port against the TypeScript's answers, without Node: the fixtures under tests/fixtures/ are
//! cases with the answers `native/tools/spaces-ref.mts --fixtures` wrote for them (a sample of the
//! comparison described in native/PORTING.md).
//!
//!  - validate.jsonl: `{ case, ref }`, a configuration of a problem with the options the server
//!    passes, and what parseSpaceConfig, validateSpaceSubmission and its Async variant answer;
//!  - aux.jsonl: `{ case, result }`: ids, domains, catalogues of damaged record files, problems of
//!    the repository's data/, stored configurations of free tori, the comparison rules, the constants.
//!
//! The fixtures were written under Node 24 on Linux x86-64, the production platform
//! (native/tools/LINUX_REFERENCE.md), and every answer must be the TypeScript's exactly: booleans,
//! counts, keys and their order, every text (a message, a stored configuration, an id) character
//! for character, and every number the same double (0 and -0 are one number: the fixtures are JSON).
//!
//! One kind of number is excepted, by name (`differ`): the volume bound of an ndim problem, which is
//! `Math.pow(x, 1 / d)` and may be the neighbouring double.

mod support;

use serde_json::Value;

/// Two doubles that are neighbours: one unit in the last place apart.
fn neighbours(x: f64, y: f64) -> bool {
    x.is_finite() && y.is_finite() && x.is_sign_negative() == y.is_sign_negative() && x.to_bits().abs_diff(y.to_bits()) == 1
}

/// The path of the first difference of two answers, or None when the port's is the TypeScript's exactly.
///
/// The exception, counted in `pow_differences`: in an answer about the ndim space (`ndim` true), the `value` of a
/// bound whose label is "volume bound; ..." may be the neighbouring double. That bound is
/// `Math.pow(P vol(piece) / vol(container), 1 / d)` (packages/ndspace/src/bounds.ts: ndLowerBound, times 1 - 1e-12
/// in ndBoundEntry): Node calls the C library's `pow`, which is not correctly rounded, and
/// `polypack_js::math::pow` is (native/PORTING.md, "Differences that are meant"). The volume bounds of the other
/// spaces are cube roots (`Math.cbrt`, V8's own, which the port has bit for bit) and are exact here.
fn differ(a: &Value, b: &Value, path: &str, ndim: bool, pow_differences: &mut usize) -> Option<String> {
    if a == b {
        return None;
    }
    let volume_bound = |o: &serde_json::Map<String, Value>| o.get("label").and_then(Value::as_str).is_some_and(|l| l.starts_with("volume bound"));
    match (a, b) {
        // (JSON writes 1 where the port holds 1.0: numbers are compared as doubles)
        (Value::Number(x), Value::Number(y)) if x.as_f64() == y.as_f64() => None,
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            x.iter().zip(y).enumerate().find_map(|(i, (u, v))| differ(u, v, &format!("{path}[{i}]"), ndim, pow_differences))
        }
        (Value::Object(x), Value::Object(y)) if x.keys().eq(y.keys()) => {
            let pow = ndim && volume_bound(x) && volume_bound(y);
            for (k, u) in x {
                let v = &y[k];
                if pow && k == "value" && u != v {
                    if let (Some(p), Some(q)) = (u.as_f64(), v.as_f64()) {
                        if p == q {
                            continue;
                        }
                        if neighbours(p, q) {
                            *pow_differences += 1;
                            continue;
                        }
                    }
                }
                if let Some(d) = differ(u, v, &format!("{path}.{k}"), ndim, pow_differences) {
                    return Some(d);
                }
            }
            None
        }
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
    let mut pow_differences = 0;
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
            if let Some(why) = differ(&want[part], &got[part], part, ndim, &mut pow_differences) {
                failures.push(format!("case {} ({}, {}, {}) {why}", case["id"], case["space"], case["kind"], case["problem"]));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), list.len(), failures.join("\n"));
    println!("{} checks, every answer the TypeScript's exactly; {pow_differences} ndim volume bounds (Math.pow) are the neighbouring double", list.len());
}

#[test]
fn ids_domains_and_catalogues_answer_as_the_typescript() {
    let list = fixtures("aux.jsonl");
    assert!(list.len() >= 40, "{} fixtures", list.len());
    let mut failures = Vec::new();
    let mut pow_differences = 0;
    for f in &list {
        let (case, want) = (&f["case"], &f["result"]);
        let got = support::aux_result(case);
        if let Some(why) = differ(want, &got, "", case["space"] == "ndim", &mut pow_differences) {
            failures.push(format!("case {} ({}) {why}", case["id"], case["kind"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), list.len(), failures.join("\n"));    println!("{} auxiliary cases, every answer the TypeScript's exactly; {pow_differences} ndim volume bounds (Math.pow) are the neighbouring double", list.len());
}

#[test]
fn the_exception_is_the_ndim_volume_bound_and_one_unit_only() {
    // 4D, 13 simplices in a 24-cell, met by the full comparison: Node 24 on Linux gives 0.6237804817406835 for the
    // listed bound (its Math.pow(0.15140043597654856, 0.25) is 0.6237804817413072, the correctly rounded value ...073)
    let bound = |value: f64, label: &str| serde_json::json!({ "bound": { "value": value, "label": label } });
    let (node, port) = (bound(0.6237804817406835, "volume bound; [CALC]"), bound(0.6237804817406836, "volume bound; [CALC]"));
    let mut used = 0;
    assert_eq!(differ(&node, &port, "", true, &mut used), None);
    assert_eq!(used, 1);
    // two units apart, another space, or another kind of bound: a difference
    assert!(differ(&node, &bound(0.6237804817406837, "volume bound; [CALC]"), "", true, &mut used).is_some());
    assert!(differ(&node, &port, "", false, &mut used).is_some());
    assert!(differ(&bound(0.6237804817406835, "inradius bound; [CALC]"), &bound(0.6237804817406836, "inradius bound; [CALC]"), "", true, &mut used).is_some());
}
