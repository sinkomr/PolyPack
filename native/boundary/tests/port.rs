//! The port against the TypeScript's own verdicts, without Node. The fixtures were written under Node 24 on Linux x86-64,
//! the production platform (native/tools/LINUX_REFERENCE.md): cases.jsonl and extras.jsonl by native/tools/boundary-ref.mts
//! (mode `fixtures`) from the full comparison's cases, builders.json by native/tools/boundary-tables.mts. Every number is
//! compared exactly: `polypack_js::math` is that Node's Math bit for bit, and nothing here goes through `Math.pow` with a
//! result that depends on its last bit (the d-cube's volume bound starts from one and is then refined exactly).
//! A fixture cannot hold a -0 (JSON.stringify writes 0), so where numbers are compared as numbers 0 and -0 are the same;
//! the builders' fixture hashes the bits, signs of zero included.

mod common;

use common::{check, extra, outcome_json, read_case};
use polypack_boundary::pieces::{build_piece_shape, piece_shape, POLYTOPE_PIECES};
use polypack_boundary::polytope::{build_catalogue_polytope, get_polytope};
use polypack_boundary::types::{CONTAINERS, POLYTOPES};
use serde_json::Value;

fn lines(text: &str) -> Vec<Value> {
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).expect("a JSON line")).collect()
}

/// Is a run of the port the TypeScript's: the same verdict, score, work (nD) or thrown error, and the same reasons,
/// every character of them (so every digit of the numbers they quote)?
fn same_run(a: &Value, b: &Value) -> Result<(), String> {
    // numbers are compared as doubles (JSON writes 1 where Rust holds 1.0), everything else as it is
    let field = |v: &Value, k: &str| -> Value {
        match v.get(k) {
            Some(Value::Number(n)) => Value::String(format!("{:?}", n.as_f64().unwrap().to_bits())),
            Some(x) => x.clone(),
            None => Value::Null,
        }
    };
    for k in ["tol", "throw", "ok", "score", "steps", "ops", "reasons"] {
        if field(a, k) != field(b, k) {
            return Err(format!("{k}: {:?} against {:?}", a.get(k), b.get(k)));
        }
    }
    Ok(())
}

#[test]
fn the_validator_gives_the_verdicts_of_the_typescript() {
    let cases = lines(include_str!("fixtures/cases.jsonl"));
    assert!(cases.len() >= 24, "only {} fixture cases", cases.len());
    let mut runs = 0;
    for v in &cases {
        let c = read_case(v);
        let expected = v["runs"].as_array().expect("the TypeScript's runs");
        assert_eq!(expected.len(), c.tols.len());
        for (k, &tol) in c.tols.iter().enumerate() {
            let got = outcome_json(tol, &check(&c, tol));
            if let Err(why) = same_run(&expected[k], &got) {
                panic!("case {} ({}) at tolerance {}: {}", c.id, v["kind"], tol, why);
            }
            runs += 1;
        }
    }
    println!("{runs} runs of {} cases, every one the TypeScript's to the last digit", cases.len());
}

/// Do two results agree: the same structure and texts, and every number the same double (0 and -0 are one number here:
/// the fixture is JSON, which has no -0)?
fn agree(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64().unwrap() == y.as_f64().unwrap(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| agree(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| agree(p, q))),
        _ => a == b,
    }
}

#[test]
fn the_other_functions_give_the_results_of_the_typescript() {
    let extras = lines(include_str!("fixtures/extras.jsonl"));
    assert!(extras.len() >= 100);
    for q in &extras {
        let mut got = extra(q);
        let name = q["fn"].as_str().unwrap();
        if name == "domainInfo" {
            // as text, so that the order of the fields is compared too
            assert_eq!(got.as_str().unwrap(), q["out"].as_str().unwrap(), "the domain's description");
            continue;
        }
        if name == "checkMs" {
            // a product of two doubles: the same on both sides
            got = serde_json::from_str(&got.to_string()).unwrap();
        }
        // exact, the bounds too: ballBounds, pieceBounds and the domain's bounds that quote them are Math.cbrt's, and the
        // d-cube's volume bound is the largest double under an exact comparison, whatever Math.pow gave to start from
        assert!(agree(&q["out"], &got), "{q}: {got}");
    }
}

const FNV_OFFSET: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;

/// FNV-1a on 32 bits of a list of whole numbers (a -1 is its 32 bits), as native/tools/boundary-tables.mts hashes them.
fn hash_ints(list: &[i64]) -> u32 {
    list.iter().fold(FNV_OFFSET, |h, &v| (h ^ (v as i32 as u32)).wrapping_mul(FNV_PRIME))
}

/// FNV-1a on 32 bits of the high and then the low half of each double: a -0 is not a 0.
fn hash_bits(list: &[f64]) -> u32 {
    list.iter().fold(FNV_OFFSET, |h, &x| {
        let b = x.to_bits();
        let h = (h ^ (b >> 32) as u32).wrapping_mul(FNV_PRIME);
        (h ^ b as u32).wrapping_mul(FNV_PRIME)
    })
}

/// The lists the fixture hashes (the header of native/tools/boundary-tables.mts gives their order) against one row of it.
fn assert_row(what: &str, row: &Value, counts: &[(&str, usize)], ints: &[i64], doubles: &[f64], named: &[(&str, f64)]) {
    for &(key, n) in counts {
        assert_eq!(row[key].as_u64(), Some(n as u64), "{what}: {key}");
    }
    assert_eq!(row["ints"].as_u64(), Some(ints.len() as u64), "{what}: how many whole numbers");
    assert_eq!(row["structure"].as_u64(), Some(hash_ints(ints) as u64), "{what}: the structure (cells, facets, gluings, edges)");
    assert_eq!(row["doubles"].as_u64(), Some(doubles.len() as u64), "{what}: how many doubles");
    assert_eq!(row["bits"].as_u64(), Some(hash_bits(doubles) as u64), "{what}: a double is not Node's (the hash of their bits)");
    let sum = doubles.iter().fold(0.0, |a, b| a + b);
    assert_eq!(row["sum"].as_f64().unwrap().to_bits(), sum.to_bits(), "{what}: the sum of the doubles, {sum}");
    for &(key, x) in named {
        assert_eq!(row[key].as_f64().unwrap().to_bits(), x.to_bits(), "{what}: {key} {x}");
    }
}

#[test]
fn the_builders_give_the_polytopes_and_pieces_of_linux_node() {
    // hull.rs and polytope.rs (build_polytope, with the topology cache) and pieces.rs (build_piece_shape) against what
    // Node 24 on Linux x86-64 builds: the same cells, facets, gluings and edges, and every double the same bits
    let fixture: Value = serde_json::from_str(include_str!("fixtures/builders.json")).unwrap();
    let rows = fixture["polytopes"].as_array().unwrap();
    assert_eq!(rows.len(), POLYTOPES.len());
    for (row, name) in rows.iter().zip(POLYTOPES) {
        assert_eq!(row["name"].as_str(), Some(name));
        let p = get_polytope(name).unwrap();
        assert_eq!(row["d"].as_u64(), Some(p.d as u64));
        let mut ints: Vec<i64> = Vec::new();
        let mut doubles: Vec<f64> = p.vertices.iter().flatten().copied().collect();
        for (i, c) in p.cells.iter().enumerate() {
            let ct = &p.topo.cells[i];
            ints.push(c.index as i64);
            ints.extend(c.vertex_ids.iter().map(|&v| v as i64));
            ints.extend(c.hinges.iter().flatten().map(|&v| v as i64));
            doubles.extend(&c.normal);
            doubles.extend(&c.origin);
            doubles.extend(c.frame.iter().flatten());
            doubles.extend(c.vertices.iter().flatten());
            for f in &c.facets {
                ints.push(f.neighbor as i64);
                ints.push(f.neighbor_facet as i64);
                ints.extend(f.vertices.iter().map(|&v| v as i64));
                doubles.extend(&f.inside.n);
                doubles.push(f.inside.h);
                doubles.extend(f.to_neighbor.a.iter().flatten());
                doubles.extend(&f.to_neighbor.b);
            }
            ints.extend(ct.pair_hinge.iter().map(|&v| v as i64));
            ints.extend(p.topo.hinge_edge[i].iter().map(|&v| v as i64));
            doubles.extend(&ct.hinge_dihedral);
            for g in &ct.glue {
                doubles.extend(g.m);
                doubles.extend(g.t);
            }
        }
        ints.extend(p.edges.iter().flatten().map(|&v| v as i64));
        doubles.push(p.hinge_angle);
        doubles.extend(&p.edge_angles);
        doubles.push(p.volume);
        let counts = [
            ("vertices", p.vertices.len()),
            ("cells", p.cells.len()),
            ("facets", p.cells.iter().map(|c| c.facets.len()).sum()),
            ("hinges", p.cells.iter().map(|c| c.hinges.len()).sum()),
            ("edges", p.edges.len()),
        ];
        assert_row(name, row, &counts, &ints, &doubles, &[("hingeAngle", p.hinge_angle), ("volume", p.volume)]);
        // what `get_polytope` keeps is what the builder gives each time
        let again = build_catalogue_polytope(name).unwrap();
        assert_eq!(common::polytope_json(p).to_string(), common::polytope_json(&again).to_string(), "{name}: built twice");
    }
    let rows = fixture["pieces"].as_array().unwrap();
    assert_eq!(rows.len(), POLYTOPE_PIECES.len());
    for (row, name) in rows.iter().zip(POLYTOPE_PIECES) {
        assert_eq!(row["name"].as_str(), Some(name));
        let s = piece_shape(name).unwrap();
        assert_eq!(s, &build_piece_shape(name).unwrap(), "{name}: built twice");
        let mut ints: Vec<i64> = Vec::new();
        for f in &s.faces {
            ints.push(f.len() as i64);
            ints.extend(f.iter().map(|&v| v as i64));
        }
        ints.extend(s.edges.iter().flatten().map(|&v| v as i64));
        let mut doubles: Vec<f64> = s.vertices.iter().flatten().copied().collect();
        doubles.extend(s.normals.iter().flatten());
        doubles.extend([s.inradius, s.circumradius, s.midradius, s.volume]);
        doubles.extend(&s.mirror);
        doubles.extend(s.edge_dirs.iter().flatten());
        let counts = [("vertices", s.vertices.len()), ("faces", s.faces.len()), ("edges", s.edges.len()), ("edgeDirs", s.edge_dirs.len())];
        let named = [("inradius", s.inradius), ("circumradius", s.circumradius), ("midradius", s.midradius), ("volume", s.volume)];
        assert_row(name, row, &counts, &ints, &doubles, &named);
    }
}

#[test]
fn the_catalogue_is_the_source_s() {
    // CONTAINERS = [...POLYTOPES, ...NCUBE_NAMES, ...ND_NAMES], ND_NAMES = families x dimensions
    let mut names: Vec<String> = POLYTOPES.iter().map(|s| s.to_string()).collect();
    names.extend(polypack_boundary::NCUBE_NAMES.iter().map(|s| s.to_string()));
    for family in polypack_boundary::ND_FAMILIES {
        for d in polypack_boundary::nd::names::ND_DIMS {
            names.push(format!("{d}{family}"));
        }
    }
    assert_eq!(names, CONTAINERS);
    assert_eq!(&names[12..], polypack_boundary::ND_NAMES);
    assert_eq!(get_polytope("600cell").unwrap().cells.len(), 600);
    assert_eq!(get_polytope("120cell").unwrap().vertices.len(), 600);
    assert!(get_polytope("8cell").is_err());
}

#[test]
fn a_typed_configuration_is_checked_as_its_json() {
    use polypack_boundary::{validate_boundary_config, BoundaryConfig, BoundaryError, BoundaryPiece, BoundaryProblem, ValidateOptions};
    // the server's limits (packages/spaces/src/validate.ts: MAX_REASONS 20, BOUNDARY_MAX_CHAINS 1024)
    let server = |tol: f64| ValidateOptions { tol: Some(tol), max_reasons: Some(20.0), max_chains: Some(1024.0), ..Default::default() };
    // the research record of boundary/tesseract/ball/1
    let record = BoundaryConfig { s: 0.7071067811872548, pieces: vec![BoundaryPiece { cell: 0, u: vec![0.0, 0.0, 0.0], q: None }] };
    let problem = BoundaryProblem::new("tesseract", "ball", 1);
    for tol in [1e-9, 1e-11] {
        let v = validate_boundary_config(&problem, &record, &server(tol)).unwrap();
        assert!(v.ok && v.reasons.is_empty());
        assert_eq!(v.score, Some(record.s));
    }
    // a tolerance that is none is the caller's mistake: the source's RangeError
    let thrown = validate_boundary_config(&problem, &record, &server(-1.0));
    assert_eq!(thrown, Err(BoundaryError::Range("validateBoundary: tol must be a finite number >= 0, not -1".to_string())));
    // a turned cube is not a cube of the tesseract's problem; the same cube on the 16-cell is checked
    let turned = BoundaryConfig { s: 5.0, pieces: vec![BoundaryPiece { cell: 0, u: vec![0.0, 0.0, 0.0], q: Some([0.3f64.cos(), 0.3f64.sin(), 0.0, 0.0]) }] };
    let v = validate_boundary_config(&BoundaryProblem::new("tesseract", "cube", 1), &turned, &server(1e-9)).unwrap();
    assert_eq!(v.reasons, ["Piece 0: the cubes of the tesseract are axis-aligned; q must be absent or a rotation that maps the cube onto itself (one of its 24 symmetries), not a turned cube."]);
    let v = validate_boundary_config(&BoundaryProblem::new("16cell", "cube", 1), &turned, &server(1e-9)).unwrap();
    assert!(v.ok, "{:?}", v.reasons);
    // a number that is not finite reads as JavaScript's NaN does
    let nan = BoundaryConfig { s: f64::NAN, pieces: vec![] };
    let v = validate_boundary_config(&problem, &nan, &server(1e-9)).unwrap();
    assert_eq!(v.reasons, ["The edge s must be a finite number.", "The configuration has 0 pieces; the problem needs exactly 1."]);
}

#[test]
fn the_cube_roots_of_the_bounds_are_node_s() {
    // The bounds of bounds.rs are cube roots that the server shows and compares sizes with, so they need Math.cbrt bit for
    // bit: V8's (FreeBSD's s_cbrt.c, accurate to 0.667 units in the last place) differs from a correctly rounded cube root
    // for about one argument in seven. [x, Math.cbrt(x)] for 1,507 arguments, as Node 24 on Linux x86-64 gives them (the
    // same doubles as the file first held, from Node 26 on a Mac).
    let vectors: Vec<(f64, f64)> = serde_json::from_str(include_str!("fixtures/cbrt.json")).unwrap();
    assert!(vectors.len() > 1000);
    for (x, y) in &vectors {
        assert_eq!(polypack_js::math::cbrt(*x).to_bits(), y.to_bits(), "cbrt({x})");
    }
}
