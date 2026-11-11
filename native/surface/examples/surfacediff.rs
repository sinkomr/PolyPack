//! The surface validator on a file of cases, for comparison with the TypeScript reference
//! (native/tools/surface-ref.mts writes the cases and the reference, native/tools/surface-compare.mjs
//! compares).
//!
//!   cargo run --release -p polypack-surface --example surfacediff -- cases  DIR
//!   cargo run --release -p polypack-surface --example surfacediff -- solids DIR
//!   cargo run --release -p polypack-surface --example surfacediff -- domain DIR
//!
//! `cases` reads DIR/cases.jsonl, one case per line
//! `{id, solid, mode, N, s, pieces: [{face, x, y, theta}], opts: {maxErrors, maxChains, scale}}`
//! (a number that JSON cannot write is the string "NaN", "Infinity", "-Infinity" or "-0"; a
//! `maxChains` of null is no limit), and writes DIR/rust.jsonl: for each case the verdicts at the tolerances
//! 1e-9 and 1e-11, each `{ok, errors, minPairSep, minConeSep, minWallSep}` with the numbers as
//! JavaScript prints them, or `{throw: "ChainLimitError" | "Error", message}`. DIR/rust-times.json
//! holds the best of five timings of the check at 1e-9 per case, in nanoseconds.
//!
//! `solids` writes DIR/solids-rust.jsonl: every solid with all its fields.
//! `domain` writes DIR/domain-rust.json (the domain's info and the bounds of the probes of
//! DIR/domain-probes.json), DIR/sample-<limit>.rust.txt for the limits of the probes file and
//! DIR/bounds-rust.f64 (area and one-piece bound of every solid, N and P, as little-endian doubles).

use polypack_js::fmt;
use polypack_surface::chains::ChainError;
use polypack_surface::domain::{domain_bound, domain_info, domain_sample, surface_bounds, surface_ns, SURFACE_MAX_P};
use polypack_surface::solids::{all_solid_names, get_solid};
use polypack_surface::validate::{validate, Mode, SurfaceConfig, ValidateOptions, Validation};
use polypack_surface::SurfacePose;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Instant;

/// A number of a case: a JSON number, or one of the strings for what JSON cannot write.
fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("not a number: {other}"),
        },
        other => panic!("not a number: {other}"),
    }
}

struct Case {
    id: u64,
    cfg: SurfaceConfig,
    mode: Mode,
    opts: ValidateOptions,
}

fn read_case(v: &Value) -> Case {
    let pieces = v["pieces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| SurfacePose { face: num(&p["face"]), x: num(&p["x"]), y: num(&p["y"]), theta: num(&p["theta"]) })
        .collect();
    let o = &v["opts"];
    let mut opts = ValidateOptions::default();
    if !o["maxErrors"].is_null() {
        opts.max_errors = o["maxErrors"].as_u64().unwrap() as usize;
    }
    if !o["maxChains"].is_null() {
        opts.max_chains = num(&o["maxChains"]);
    }
    if !o["scale"].is_null() {
        opts.scale = num(&o["scale"]);
    }
    Case {
        id: v["id"].as_u64().unwrap(),
        cfg: SurfaceConfig { solid: v["solid"].as_str().unwrap().to_string(), n: num(&v["N"]), s: num(&v["s"]), pieces },
        mode: Mode::of(v["mode"].as_str().unwrap()),
        opts,
    }
}

fn verdict(r: &Result<Validation, ChainError>) -> Value {
    match r {
        Ok(v) => json!({
            "ok": v.ok,
            "errors": v.errors,
            "minPairSep": fmt::num(v.min_pair_sep),
            "minConeSep": fmt::num(v.min_cone_sep),
            "minWallSep": fmt::num(v.min_wall_sep),
        }),
        Err(e) => json!({ "throw": if e.is_chain_limit() { "ChainLimitError" } else { "Error" }, "message": e.message() }),
    }
}

fn run_cases(dir: &str) {
    let input = BufReader::new(std::fs::File::open(format!("{dir}/cases.jsonl")).unwrap());
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/rust.jsonl")).unwrap());
    let mut cases: Vec<Case> = Vec::new();
    for line in input.lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        cases.push(read_case(&serde_json::from_str(&line).unwrap()));
    }
    for c in &cases {
        let at = |tol: f64| verdict(&validate(&c.cfg, c.mode, &ValidateOptions { tol, ..c.opts }));
        writeln!(out, "{}", json!({ "id": c.id, "r": [at(1e-9), at(1e-11)] })).unwrap();
    }
    out.flush().unwrap();
    let mut best: Vec<u128> = vec![u128::MAX; cases.len()];
    let mut sink = 0usize;
    for _ in 0..5 {
        for (i, c) in cases.iter().enumerate() {
            let opts = ValidateOptions { tol: 1e-9, ..c.opts };
            let t = Instant::now();
            let r = std::hint::black_box(validate(std::hint::black_box(&c.cfg), c.mode, &opts));
            let d = t.elapsed().as_nanos();
            sink += r.map_or(1, |v| v.errors.len());
            if d < best[i] {
                best[i] = d;
            }
        }
    }
    std::hint::black_box(sink);
    let times: Vec<u64> = best.iter().map(|&b| b as u64).collect();
    std::fs::write(format!("{dir}/rust-times.json"), serde_json::to_string(&times).unwrap()).unwrap();
    println!("{} cases", cases.len());
}

fn run_solids(dir: &str) {
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/solids-rust.jsonl")).unwrap());
    for name in all_solid_names() {
        let s = get_solid(name).unwrap();
        writeln!(
            out,
            "{}",
            json!({
                "name": s.name, "family": s.family.as_str(), "title": s.title,
                "M": s.m, "F": s.f, "V": s.v, "E": s.e,
                "degree": s.degree, "faceAngle": s.face_angle, "coneAngle": s.cone_angle,
                "vertices": s.vertices, "faces": s.faces,
                "adj": s.adj.iter().map(|row| row.iter().map(|r| json!({ "face": r.face, "edge": r.edge })).collect::<Vec<_>>()).collect::<Vec<_>>(),
                "sides": s.sides, "uniform": s.uniform, "regular": s.regular,
                "unitFaces": s.unit_faces, "corner": s.corner, "edgeAngle": s.edge_angle,
                "vertexDegree": s.vertex_degree, "vertexCone": s.vertex_cone,
                "frame3D": s.frame_3d.iter().map(|f| json!({ "o": f.o, "ex": f.ex, "ey": f.ey })).collect::<Vec<_>>(),
            })
        )
        .unwrap();
    }
    out.flush().unwrap();
    println!("{} solids", all_solid_names().len());
}

fn run_domain(dir: &str) {
    let probes: Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/domain-probes.json")).unwrap()).unwrap();
    let bounds: Vec<Value> = probes["bounds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| match domain_bound(p["solid"].as_str().unwrap(), p["mode"].as_str().unwrap(), num(&p["N"]), num(&p["P"])) {
            Some(b) => json!({ "value": fmt::num(b.value), "label": b.label }),
            None => Value::Null,
        })
        .collect();
    let info = serde_json::to_string(&domain_info()).unwrap();
    std::fs::write(format!("{dir}/domain-rust.json"), serde_json::to_string(&json!({ "info": info, "bounds": bounds })).unwrap()).unwrap();
    for limit in probes["samples"].as_array().unwrap() {
        let limit = limit.as_u64().unwrap() as usize;
        let ids = domain_sample(limit);
        std::fs::write(format!("{dir}/sample-{limit}.rust.txt"), ids.join("\n") + "\n").unwrap();
    }
    let mut bytes: Vec<u8> = Vec::new();
    for solid in all_solid_names() {
        for n in surface_ns() {
            for p in 1..=SURFACE_MAX_P {
                let b = surface_bounds(solid, n, p as f64).unwrap();
                bytes.extend_from_slice(&b.area.to_le_bytes());
                bytes.extend_from_slice(&b.one.to_le_bytes());
            }
        }
    }
    std::fs::write(format!("{dir}/bounds-rust.f64"), &bytes).unwrap();
    println!("domain: {} probes, {} bounds", bounds.len(), bytes.len() / 16);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: surfacediff cases|solids|domain DIR");
        std::process::exit(2);
    }
    match args[1].as_str() {
        "cases" => run_cases(&args[2]),
        "solids" => run_solids(&args[2]),
        "domain" => run_domain(&args[2]),
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(2);
        }
    }
}
