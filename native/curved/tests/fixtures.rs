//! The port against the TypeScript's own answers, without Node: the cases of
//! tests/fixtures/validate.jsonl and bound.jsonl were written by native/tools/curved-ref.mts
//! (`--fixtures native/curved/tests/fixtures`) with what packages/curved answered for them.
//!
//! The rule is the comparison's (native/PORTING.md, native/tools/curved-compare.mjs): the same
//! verdicts, counts, reasons and contacts, and numbers that agree to 1e-6 relative or 1e-12
//! absolute, also inside a message. Two things may differ, both in the last bit of a sine:
//! `strictlyValid` where the smallest gap is zero to 1e-12, and the witness of a contact (which
//! edge and vertex give the separation) where the gap is the same.

// Negated comparisons are the source's: `!(a <= b)` is true for NaN.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use polypack_curved::bound::{curved_bound_of, curved_max_p, curved_why_not, CURVED_MAX_P};
use polypack_curved::shapes::{container_circumradius, piece_exists};
use polypack_curved::validate::{validate_gaps, validation_steps, ValidationOptions, ValidationResult};
use polypack_curved::{CurvedConfig, CurvedProblem, Pose};
use polypack_js::{fmt as jsfmt, math};
use serde_json::Value;

/// A number of a case: a JSON number, or the name of one JSON cannot write.
fn dec_in(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) => dec(s),
        other => panic!("not a number: {other}"),
    }
}

/// A result number from its text (JavaScript's String(x), "-0" for the negative zero).
fn dec(s: &str) -> f64 {
    match s {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        "-0" => -0.0,
        other => other.parse().unwrap_or_else(|_| panic!("not a number: {other}")),
    }
}

/// The comparison's rule for two computed numbers.
fn close(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a == b || (a - b).abs() <= 1e-12 || (a - b).abs() <= 1e-6 * a.abs().max(b.abs())
}

/// A message with its numbers taken out: the text with a # for each, and the numbers.
fn split(text: &str) -> (String, Vec<f64>) {
    let b = text.as_bytes();
    let mut out = String::new();
    let mut numbers = Vec::new();
    let mut i = 0;
    while i < b.len() {
        for word in ["NaN", "-Infinity", "Infinity"] {
            if text[i..].starts_with(word) {
                numbers.push(dec(word));
                out.push('#');
                i += word.len();
            }
        }
        if i >= b.len() {
            break;
        }
        let digit = |j: usize| j < b.len() && b[j].is_ascii_digit();
        let start = i;
        let mut j = i;
        if b[j] == b'-' && digit(j + 1) {
            j += 1;
        }
        if digit(j) {
            while digit(j) {
                j += 1;
            }
            if j < b.len() && b[j] == b'.' && digit(j + 1) {
                j += 1;
                while digit(j) {
                    j += 1;
                }
            }
            if j < b.len()
                && b[j] == b'e'
                && (digit(j + 1) || (j + 1 < b.len() && (b[j + 1] == b'-' || b[j + 1] == b'+') && digit(j + 2)))
            {
                j += 2;
                while digit(j) {
                    j += 1;
                }
            }
            numbers.push(text[start..j].parse().unwrap());
            out.push('#');
            i = j;
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    (out, numbers)
}

fn same_texts(what: &str, expect: &[String], got: &[String]) {
    assert_eq!(expect.len(), got.len(), "{what}: {expect:?} | {got:?}");
    for (e, g) in expect.iter().zip(got) {
        let ((te, ne), (tg, ng)) = (split(e), split(g));
        assert_eq!(te, tg, "{what}");
        assert_eq!(ne.len(), ng.len(), "{what}: {e} | {g}");
        for (x, y) in ne.iter().zip(&ng) {
            assert!(close(*x, *y), "{what}: {e} | {g}");
        }
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

fn case_of(v: &Value) -> (CurvedProblem, CurvedConfig) {
    let problem = CurvedProblem {
        k: dec_in(&v["K"]),
        n: v["N"].as_u64().unwrap() as u32,
        m: v["M"].as_u64().unwrap() as u32,
        p: v["P"].as_u64().unwrap() as u32,
    };
    let config = CurvedConfig {
        size: dec_in(&v["size"]),
        pieces: v["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| Pose {
                x: dec_in(&q[0]),
                y: dec_in(&q[1]),
                theta: dec_in(&q[2]),
            })
            .collect(),
    };
    (problem, config)
}

fn same_run(what: &str, expect: &Value, got: &ValidationResult) {
    assert_eq!(expect["valid"].as_bool().unwrap(), got.valid, "{what}: valid");
    let number = |key: &str| dec(expect[key].as_str().unwrap());
    for (key, value) in [
        ("score", got.score),
        ("tightSize", got.tight_size),
        ("minGap", got.min_gap),
        ("minPairGap", got.min_pair_gap),
        ("minContainerGap", got.min_container_gap),
    ] {
        assert!(
            close(number(key), value),
            "{what}: {key} {} | {}",
            expect[key],
            jsfmt::num(value)
        );
    }
    if !(number("minGap").abs() <= 1e-12 && got.min_gap.abs() <= 1e-12) {
        assert_eq!(
            expect["strictlyValid"].as_bool().unwrap(),
            got.strictly_valid,
            "{what}: strictlyValid"
        );
    }
    assert_eq!(
        expect["nErrors"].as_u64().unwrap() as usize,
        got.errors.len(),
        "{what}: number of reasons"
    );
    let written = strings(&expect["errors"]);
    same_texts(what, &written, &got.errors[..written.len()]);
    let contacts = expect["contacts"].as_array().unwrap();
    // a contact on one side only is a tie when its gap is the contact tolerance to 1e-12
    let on_the_edge = |gap: f64| (gap - 1e-7).abs() <= 1e-12;
    if expect["nContacts"].as_u64().unwrap() as usize != got.contacts.len() {
        assert!(
            contacts.iter().any(|c| on_the_edge(dec(c[5].as_str().unwrap())))
                || got.contacts.iter().any(|c| on_the_edge(c.gap)),
            "{what}: {} contacts | {}",
            expect["nContacts"],
            got.contacts.len()
        );
        return;
    }
    for (e, g) in contacts.iter().zip(&got.contacts) {
        assert_eq!(e[0].as_str().unwrap(), g.kind.as_str(), "{what}: contact kind");
        assert_eq!(
            [e[1].as_i64().unwrap(), e[2].as_i64().unwrap(), e[3].as_i64().unwrap()],
            [g.i as i64, g.j as i64, g.wall as i64],
            "{what}: contact"
        );
        assert!(
            close(dec(e[5].as_str().unwrap()), g.gap),
            "{what}: contact gap {} | {}",
            e[5],
            jsfmt::num(g.gap)
        );
        // (the witness and the vertex of a pair may be another candidate of the same gap)
        if g.witness.is_none() {
            assert_eq!(e[4].as_i64().unwrap(), g.vertex as i64, "{what}: contact vertex");
        }
    }
}

/// packages/spaces/src/validate.ts: check(), the curved branch (as the curveddiff example has it).
fn check(problem: &CurvedProblem, config: &CurvedConfig, tol: f64) -> Vec<String> {
    let reach = container_circumradius(problem.m, problem.k, config.size);
    if reach.is_finite() {
        if let Some(far) = config
            .pieces
            .iter()
            .position(|p| !(math::hypot(p.x, p.y) <= reach * (1.0 + 1e-6) + 1e-6))
        {
            return vec![format!("the centre of piece {far} lies outside the container")];
        }
    }
    let v = validation_steps(problem, config, &server(tol));
    if v.valid {
        return vec![];
    }
    let list: Vec<String> = v.errors.into_iter().take(20).collect();
    if list.is_empty() {
        vec![format!("not a valid packing (smallest gap {})", jsfmt::num(v.min_gap))]
    } else {
        list
    }
}

fn server(tol: f64) -> ValidationOptions {
    ValidationOptions {
        tol,
        max_errors: Some(20),
        ..ValidationOptions::default()
    }
}

fn fixture_lines(name: &str) -> Vec<Value> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn the_validator_answers_as_the_typescript() {
    let lines = fixture_lines("validate.jsonl");
    assert!(lines.len() >= 40, "{} fixtures", lines.len());
    let mut kinds = std::collections::BTreeSet::new();
    for line in &lines {
        let (problem, config) = case_of(&line["case"]);
        let kind = line["case"]["kind"].as_str().unwrap();
        kinds.insert(kind.to_string());
        let what = format!("case {} ({kind})", line["case"]["id"]);
        let runs = &line["expect"]["runs"];
        same_run(
            &format!("{what}, tol 1e-9"),
            &runs[0],
            &validation_steps(&problem, &config, &server(1e-9)),
        );
        same_run(
            &format!("{what}, tol 1e-11"),
            &runs[1],
            &validation_steps(&problem, &config, &server(1e-11)),
        );
        same_run(
            &format!("{what}, default options"),
            &runs[2],
            &validation_steps(&problem, &config, &ValidationOptions::default()),
        );
        for (k, tol) in [1e-9, 1e-11].into_iter().enumerate() {
            same_texts(
                &format!("{what}, check at {tol:e}"),
                &strings(&line["expect"]["check"][k]),
                &check(&problem, &config, tol),
            );
        }
    }
    // the fixtures hold every kind of case the comparison makes
    assert!(kinds.len() >= 30, "{kinds:?}");
}

#[test]
fn leaving_the_contacts_out_changes_nothing_else() {
    for line in &fixture_lines("validate.jsonl") {
        let (problem, config) = case_of(&line["case"]);
        let with = validation_steps(&problem, &config, &server(1e-9));
        let without = validation_steps(
            &problem,
            &config,
            &ValidationOptions {
                contacts: false,
                ..server(1e-9)
            },
        );
        assert!(without.contacts.is_empty());
        assert_eq!(
            (with.valid, with.strictly_valid, &with.errors),
            (without.valid, without.strictly_valid, &without.errors)
        );
        for (a, b) in [
            (with.score, without.score),
            (with.tight_size, without.tight_size),
            (with.min_gap, without.min_gap),
            (with.min_pair_gap, without.min_pair_gap),
            (with.min_container_gap, without.min_container_gap),
        ] {
            assert_eq!(a.to_bits(), b.to_bits());
        }
    }
}

/// The search client's check (validate_gaps) computes the validator's numbers: bit for bit the
/// gaps, the verdict and the reasons of validation_steps.
#[test]
fn the_client_s_mirror_is_the_validator() {
    for line in &fixture_lines("validate.jsonl") {
        let (problem, config) = case_of(&line["case"]);
        for tol in [1e-9, 1e-11] {
            let v = validation_steps(&problem, &config, &server(tol));
            let g = validate_gaps(&problem, &config, tol, 20);
            let what = format!("case {} at {tol:e}", line["case"]["id"]);
            assert_eq!(v.valid, g.valid_mirror, "{what}");
            assert_eq!(v.errors, g.errors, "{what}");
            for (a, b) in [
                (v.min_gap, g.min_gap),
                (v.min_pair_gap, g.min_pair_gap),
                (v.min_container_gap, g.min_container_gap),
            ] {
                assert_eq!(a.to_bits(), b.to_bits(), "{what}: {a} | {b}");
            }
            // the safe verdict never accepts what the validator refuses
            assert!(!g.valid_safe || v.valid, "{what}");
        }
    }
}

#[test]
fn bounds_and_the_domain_answer_as_the_typescript() {
    let lines = fixture_lines("bound.jsonl");
    assert!(lines.len() >= 100, "{} lines", lines.len());
    let code = |n: f64| n == 0.0 || (n.is_finite() && n.fract() == 0.0 && (3.0..=100.0).contains(&n));
    let (mut bounds, mut sentences) = (0, 0);
    for v in &lines {
        let (k, n, m) = (dec_in(&v["K"]), dec_in(&v["N"]), dec_in(&v["M"]));
        let what = format!("K={} N={} M={} limit={}", v["K"], v["N"], v["M"], v["limit"]);
        let limit = if v["limit"].is_null() {
            CURVED_MAX_P as f64
        } else {
            dec_in(&v["limit"])
        };
        let max_p = curved_max_p(k, n, m, limit);
        let expect = dec(v["maxP"].as_str().unwrap());
        assert!(
            max_p == expect || (max_p.is_nan() && expect.is_nan()),
            "curvedMaxP {what}: {expect} | {max_p}"
        );
        let codes = code(n) && code(m);
        if codes {
            assert_eq!(
                v["exists"].as_bool().unwrap(),
                piece_exists(n as u32, k),
                "pieceExists {what}"
            );
        }
        for row in v["ps"].as_array().unwrap() {
            let p = dec_in(&row[0]);
            let why = curved_why_not(k, n, m, p);
            match (&row[2], &why) {
                (Value::Null, None) => {}
                (Value::String(e), Some(g)) => {
                    same_texts(
                        &format!("curvedWhyNot {what} P={p}"),
                        std::slice::from_ref(e),
                        std::slice::from_ref(g),
                    );
                    sentences += 1;
                }
                (e, g) => panic!("curvedWhyNot {what} P={p}: {e} | {g:?}"),
            }
            if row[1] == "skip" {
                continue;
            }
            bounds += 1;
            let bound = curved_bound_of(k, n as u32, m as u32, p as u32);
            match (&row[1], bound) {
                (Value::Null, None) => {}
                (Value::String(e), Some(g)) => {
                    let e = dec(e);
                    // near the ideal polygon (K < 0) the side is (2/r) atanh(a) with a near 1: one unit in the
                    // last place of a is sinh(2x)/(2x) of them in the side, x = r side / 2
                    let half = (-k).sqrt() * e / 2.0;
                    let condition = if k < 0.0 && m > 0.0 {
                        (2.0 * half).sinh() / (2.0 * half)
                    } else {
                        1.0
                    };
                    let allowed = 1e-12f64.max(64.0 * f64::EPSILON * condition);
                    assert!(((e - g) / e).abs() <= allowed, "curvedBoundOf {what} P={p}: {e} | {g}");
                }
                (e, g) => panic!("curvedBoundOf {what} P={p}: {e} | {g:?}"),
            }
        }
        for row in v["circ"].as_array().unwrap() {
            let (s, e) = (dec_in(&row[0]), dec(row[1].as_str().unwrap()));
            let g = container_circumradius(m as u32, k, s);
            assert!(
                e == g || (e.is_nan() && g.is_nan()) || ((e - g) / e).abs() <= 1e-12,
                "containerCircumradius {what} s={s}: {e} | {g}"
            );
        }
    }
    assert!(
        bounds >= 100 && sentences >= 20,
        "{bounds} bounds, {sentences} sentences"
    );
}

/// The number of curved problems that can exist is the sum of curved_max_p over the domain
/// (countCurvedProblems of packages/spaces/src/piece-domains.ts, 26,830,100 when this was written).
#[test]
fn the_domain_has_the_typescript_s_number_of_problems() {
    let path = format!("{}/tests/fixtures/domain.json", env!("CARGO_MANIFEST_DIR"));
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let list = |key: &str| -> Vec<f64> { v[key].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect() };
    let (ks, ns, ms) = (list("ks"), list("ns"), list("ms"));
    assert_eq!((ks.len(), ns.len(), ms.len()), (22, 99, 99));
    let mut count = 0.0;
    for &k in &ks {
        for &n in &ns {
            for &m in &ms {
                count += curved_max_p(k, n, m, CURVED_MAX_P as f64);
            }
        }
    }
    assert_eq!(count, v["problems"].as_f64().unwrap());
}

#[test]
fn messages_split_into_text_and_numbers() {
    let (text, numbers) = split("size must be below 3.141592653589793 (open hemisphere) at K=1e-7");
    assert_eq!(text, "size must be below # (open hemisphere) at K=#");
    assert_eq!(numbers, vec![std::f64::consts::PI, 1e-7]);
    let (text, numbers) =
        split("A 7-gon container at K = -0.5 holds at most 12 unit 3-gons: NaN -Infinity 2π/√K ≈ 6.283.");
    assert_eq!(
        text,
        "A #-gon container at K = # holds at most # unit #-gons: # # #π/√K ≈ #."
    );
    assert_eq!(numbers.len(), 8);
    assert!(numbers[4].is_nan() && numbers[5] == f64::NEG_INFINITY);
}
