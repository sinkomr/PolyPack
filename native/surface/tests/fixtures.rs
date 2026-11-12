//! The port against the TypeScript's verdicts, without Node: the fixtures under tests/fixtures were
//! written by `native/tools/surface-ref.mts OUTDIR --fixtures native/surface/tests/fixtures` from
//! packages/surface, under Node 24 on Linux x86-64, the production platform
//! (native/tools/LINUX_REFERENCE.md).
//!
//! Every answer must be the TypeScript's exactly: the same form of verdict, the same `ok`, the same
//! messages character for character (so every digit of the numbers they quote), and every number
//! the same double. `polypack_js::math` is that Node's Math bit for bit, and nothing of this family
//! goes through `Math.pow` with an exponent other than 2 or 0.5. A verdict's numbers are compared as
//! the text JavaScript writes them (String(x), where a -0 is "0").

use polypack_js::fmt;
use polypack_surface::chains::ChainError;
use polypack_surface::domain::{domain_bound, domain_info, domain_sample};
use polypack_surface::solids::{all_solid_names, get_solid};
use polypack_surface::validate::{validate, Mode, SurfaceConfig, ValidateOptions, Validation};
use polypack_surface::SurfacePose;
use serde_json::Value;

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// A number of a fixture: a JSON number, or one of the strings for what JSON cannot write.
fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) => text_number(s),
        other => panic!("not a number: {other}"),
    }
}

/// `Number(text)` for the texts JavaScript writes a number as.
fn text_number(s: &str) -> f64 {
    match s {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        other => other.parse().unwrap_or_else(|_| panic!("not a number: {other}")),
    }
}

/// What differs between the TypeScript's verdict and the port's, or None.
fn verdict_diff(want: &Value, got: &Result<Validation, ChainError>) -> Option<String> {
    match got {
        Err(e) => {
            let Some(class) = want["throw"].as_str() else {
                return Some(format!("the port threw `{e}`, the TypeScript did not"));
            };
            let got_class = if e.is_chain_limit() { "ChainLimitError" } else { "Error" };
            if class != got_class {
                return Some(format!("thrown class {class} / {got_class}"));
            }
            let message = want["message"].as_str().unwrap();
            if message != e.message() {
                return Some(format!("thrown message `{message}` / `{}`", e.message()));
            }
            None
        }
        Ok(v) => {
            if !want["throw"].is_null() {
                return Some("the TypeScript threw, the port did not".to_string());
            }
            if want["ok"].as_bool().unwrap() != v.ok {
                return Some(format!("ok {} / {}", want["ok"], v.ok));
            }
            let errors = want["errors"].as_array().unwrap();
            if errors.len() != v.errors.len() {
                return Some(format!("{} errors / {}: {:?}", errors.len(), v.errors.len(), v.errors));
            }
            for (a, b) in errors.iter().zip(&v.errors) {
                if a.as_str().unwrap() != b {
                    return Some(format!("error `{}` / `{b}`", a.as_str().unwrap()));
                }
            }
            for (key, x) in [("minPairSep", v.min_pair_sep), ("minConeSep", v.min_cone_sep), ("minWallSep", v.min_wall_sep)] {
                let a = want[key].as_str().unwrap();
                if a != fmt::num(x) {
                    return Some(format!("{key} {a} / {}", fmt::num(x)));
                }
            }
            None
        }
    }
}

#[test]
fn cases_give_the_typescript_verdicts() {
    let text = fixture("cases.jsonl");
    let mut checked = 0;
    let mut kinds = std::collections::BTreeSet::new();
    let mut failures = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let c: Value = serde_json::from_str(line).unwrap();
        let pieces = c["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| SurfacePose { face: num(&p["face"]), x: num(&p["x"]), y: num(&p["y"]), theta: num(&p["theta"]) })
            .collect();
        let cfg = SurfaceConfig { solid: c["solid"].as_str().unwrap().to_string(), n: num(&c["N"]), s: num(&c["s"]), pieces };
        let mode = Mode::of(c["mode"].as_str().unwrap());
        let mut opts = ValidateOptions::default();
        let o = &c["opts"];
        if !o["maxErrors"].is_null() {
            opts.max_errors = o["maxErrors"].as_u64().unwrap() as usize;
        }
        if !o["maxChains"].is_null() {
            opts.max_chains = num(&o["maxChains"]);
        }
        if !o["scale"].is_null() {
            opts.scale = num(&o["scale"]);
        }
        kinds.insert(c["kind"].as_str().unwrap().to_string());
        for (t, tol) in [1e-9, 1e-11].into_iter().enumerate() {
            let got = validate(&cfg, mode, &ValidateOptions { tol, ..opts });
            if let Some(d) = verdict_diff(&c["r"][t], &got) {
                failures.push(format!("case {} ({}, {}) at tol {tol:e}: {d}", c["id"], c["kind"], c["origin"]));
            }
            checked += 1;
        }
    }
    assert!(failures.is_empty(), "{} verdicts differ:\n{}", failures.len(), failures.join("\n"));
    assert!(checked >= 60, "only {checked} verdicts in the fixtures");
    assert!(kinds.len() >= 15, "only {} kinds of case in the fixtures", kinds.len());
}

/// The hash of the fixtures' lists of whole numbers (FNV-1a over the numbers, 32 bits).
fn hash(list: impl Iterator<Item = usize>) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for v in list {
        h = (h ^ v as u32).wrapping_mul(0x01000193);
    }
    h
}

#[test]
fn solids_are_the_typescript_solids() {
    let want: Vec<Value> = serde_json::from_str(&fixture("solids.json")).unwrap();
    assert_eq!(want.len(), 141);
    assert_eq!(all_solid_names().len(), 141);
    for (w, name) in want.iter().zip(all_solid_names()) {
        assert_eq!(w["name"].as_str().unwrap(), name);
        let s = get_solid(name).unwrap();
        assert_eq!(w["family"].as_str().unwrap(), s.family.as_str(), "{name}");
        assert_eq!(w["title"].as_str().unwrap(), s.title, "{name}");
        assert_eq!(w["M"].as_u64().unwrap() as usize, s.m, "{name}");
        assert_eq!(w["F"].as_u64().unwrap() as usize, s.f, "{name}");
        assert_eq!(w["V"].as_u64().unwrap() as usize, s.v, "{name}");
        assert_eq!(w["E"].as_f64().unwrap(), s.e, "{name}");
        // Euler's formula, for the port's own sake
        assert_eq!(s.v as f64 - s.e + s.f as f64, 2.0, "{name}");
        match w["degree"].as_f64() {
            Some(d) => assert_eq!(d, s.degree, "{name}"),
            None => assert!(s.degree.is_nan(), "{name}"),
        }
        match w["coneAngle"].as_f64() {
            Some(c) => assert_eq!(c.to_bits(), s.cone_angle.to_bits(), "{name}: coneAngle {c} / {}", s.cone_angle),
            None => assert!(s.cone_angle.is_nan(), "{name}"),
        }
        assert_eq!(w["uniform"].as_bool().unwrap(), s.uniform, "{name}");
        assert_eq!(w["regular"].as_u64().unwrap() as usize, s.regular.iter().filter(|&&r| r).count(), "{name}");
        assert_eq!(w["faces"].as_u64().unwrap() as u32, hash(s.faces.iter().flatten().copied()), "{name}: faces");
        assert_eq!(
            w["adj"].as_u64().unwrap() as u32,
            hash(s.adj.iter().flatten().flat_map(|r| [r.face, r.edge])),
            "{name}: gluing"
        );
        let sums = [
            ("unitFaces", s.unit_faces.iter().flatten().fold(0.0, |a, b| a + b.abs())),
            ("corner", s.corner.iter().flatten().fold(0.0, |a, b| a + b)),
            ("edgeAngle", s.edge_angle.iter().flatten().fold(0.0, |a, b| a + b)),
            ("vertexCone", s.vertex_cone.iter().fold(0.0, |a, b| a + b)),
        ];
        for (key, got) in sums {
            let a = w[key].as_f64().unwrap();
            // the sum of the same doubles in the same order
            assert_eq!(a.to_bits(), got.to_bits(), "{name}: {key} {a} / {got}");
        }
    }
    assert!(get_solid("hypercube").is_err());
    assert_eq!(get_solid("hypercube").unwrap_err(), "unknown solid hypercube");
}

#[test]
fn domain_is_the_typescript_domain() {
    let want: Value = serde_json::from_str(&fixture("domain.json")).unwrap();
    assert_eq!(serde_json::to_string(&domain_info()).unwrap(), want["info"].as_str().unwrap());
    let sample: Vec<String> = want["sample"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert_eq!(domain_sample(sample.len()), sample);
    assert!(domain_sample(0).is_empty());
    let probes = want["probes"].as_array().unwrap();
    let bounds = want["bounds"].as_array().unwrap();
    assert!(probes.len() >= 50);
    let mut outside = 0;
    for (p, b) in probes.iter().zip(bounds) {
        let got = domain_bound(p["solid"].as_str().unwrap(), p["mode"].as_str().unwrap(), num(&p["N"]), num(&p["P"]));
        match got {
            None => {
                assert!(b.is_null(), "{p}: the TypeScript gives {b}");
                outside += 1;
            }
            Some(g) => {
                assert_eq!(b["label"].as_str().unwrap(), g.label, "{p}");
                let a = text_number(b["value"].as_str().unwrap());
                assert_eq!(a.to_bits(), g.value.to_bits(), "{p}: {a} / {}", g.value);
            }
        }
    }
    assert!(outside >= 10);
}
