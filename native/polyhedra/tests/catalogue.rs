//! The catalogue of names against the table of solids, without the TypeScript: the names typed in
//! `src/catalogue.rs` must be the ones `data/solids.json` carries (the tool wrote that file from the source's
//! table), and every pair of codes must read back as itself.

use polypack_polyhedra as ph;

#[test]
fn every_named_solid_is_in_the_table_with_the_same_code_family_and_title() {
    assert_eq!(ph::SOLID_NAMES_LIST.len(), 186);
    assert_eq!(ph::SOLID_NAMES.len(), 186);
    assert_eq!(ph::JOHNSON_SOLID_NAMES.len(), 92);
    for s in ph::SOLID_NAMES_LIST.iter() {
        let solid = ph::get_solid(&s.name).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(solid.code, s.code, "{}", s.name);
        assert_eq!(solid.family, s.family, "{}", s.name);
        assert_eq!(solid.title, s.title, "{}", s.name);
        assert_eq!(ph::solid_name_of_code(&s.code), Some(s.name.as_str()));
        assert!(ph::is_solid_name(&s.name));
    }
    // the table's own order of names is the catalogue's
    let listed: Vec<&str> = ph::SOLID_NAMES_LIST.iter().map(|s| s.name.as_str()).collect();
    let table: Vec<&str> = ph::SOLID_NAMES.iter().map(|s| s.as_str()).collect();
    assert_eq!(listed, table);
    assert_eq!(ph::get_solid("ball").unwrap_err(), "unknown solid ball");
}

#[test]
fn every_solid_is_closed_and_as_the_table_says() {
    for s in ph::SOLID_NAMES_LIST.iter() {
        let solid = ph::get_solid(&s.name).unwrap();
        // Euler's formula, and two faces on every edge
        assert_eq!(solid.nv + solid.faces.len(), solid.edges.len() + 2, "{}", s.name);
        assert_eq!(solid.edge_faces.len(), solid.edges.len());
        assert_eq!(solid.n.len(), 3 * solid.faces.len());
        assert_eq!(solid.offsets.len(), solid.faces.len());
        let least = solid.offsets.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!((least - solid.inradius).abs() <= 1e-12, "{}", s.name);
        let far = solid.v.chunks_exact(3).map(|v| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()).fold(0.0, f64::max);
        assert!((far - solid.circumradius).abs() <= 1e-12, "{}", s.name);
    }
}

#[test]
fn the_problems_and_their_codes() {
    assert_eq!(ph::PROBLEM_NAMES.len(), 150);
    assert_eq!(ph::PROBLEM_ORDER.len(), 150);
    assert_eq!(ph::PROBLEM_NAMES.iter().filter(|p| p.wiki).count(), 86);
    assert_eq!(ph::pair_count(), 34596);
    let first = ph::get_problem("cubintet").unwrap();
    assert_eq!((first.piece.as_str(), first.container.as_str(), first.title.as_str()), ("cube", "tetrahedron", "Cubes in a tetrahedron"));
    assert_eq!(first.family, ph::ProblemFamily::Platonic);
    let pair = ph::get_problem("j05inj92").unwrap();
    assert_eq!(pair.family, ph::ProblemFamily::Pairs);
    assert_eq!(pair.title, "J5 pentagonal cupolas in a J92 triangular hebesphenorotunda");
    assert!(ph::get_problem("cubinball").is_none());
    assert!(ph::get_problem("").is_none());
    // no code of two solids has a second reading
    for p in ph::SOLID_NAMES_LIST.iter() {
        for c in ph::SOLID_NAMES_LIST.iter() {
            let code = format!("{}in{}", p.code, c.code);
            let problem = ph::problem_name_of(&code).unwrap_or_else(|| panic!("{code}"));
            assert_eq!((problem.piece.as_str(), problem.container.as_str()), (p.name.as_str(), c.name.as_str()), "{code}");
            assert_eq!(problem.code, code);
        }
    }
}

#[test]
fn the_domain() {
    let info = ph::polyhedra_domain_info();
    assert_eq!(info.problems, 34596 * 499);
    assert_eq!(info.fields[0].values.as_ref().unwrap().len(), 186);
    assert_eq!(ph::polyhedra_domain_sample(3), ["polyhedra/tetintet/101", "polyhedra/octinoct/101", "polyhedra/icoinico/101"]);
    assert_eq!(ph::polyhedra_domain_sample(1_000_000).len(), 150 * 400);
    assert!(ph::polyhedra_domain_bound("cubincub", 1.0).is_none());
    assert!(ph::polyhedra_domain_bound("cubincub", 2.5).is_none());
    assert!(ph::polyhedra_domain_bound("cubincub", 501.0).is_none());
    let b = ph::polyhedra_domain_bound("cubincub", 8.0).unwrap();
    assert_eq!((b.value, b.label.as_str()), (2.0, "volume bound; [CALC]"));
}

/// How untrusted JSON numbers reach the check of the form. JSON.parse reads a literal too large for a double as
/// Infinity, which the source's check then refuses with its own message; serde_json refuses the whole text
/// instead ("number out of range"), so such a body never reaches `config_errors`. Everything else reads alike.
#[test]
fn json_numbers() {
    use serde_json::Value;
    assert!(serde_json::from_str::<Value>(r#"{"s":1e999,"pieces":[]}"#).is_err());
    let read = |text: &str| ph::config_errors(&serde_json::from_str::<Value>(text).unwrap(), None, 20);
    // too small for a double: zero in both languages
    assert_eq!(read(r#"{"s":1e-999,"pieces":[]}"#), ["s must be a positive finite number of at most 1000000"]);
    // integers beyond 2^64 and exponents
    assert!(read(r#"{"s":2E0,"pieces":[[0,0,0,123456789012345678901234567890,-98765432109876543210,1e+2,-0]]}"#).is_empty());
    assert_eq!(
        read(r#"{"s":1000000.0000000001,"pieces":[[0,0,0,1e101,0,0,0],[10000.000000000002,0,0,1,0,0,0],[0,0,0,5e-7,0,0,0],[0,0,0,1]]}"#),
        [
            "s must be a positive finite number of at most 1000000",
            "pieces[0]: quaternion components must be at most 1e+100 in absolute value",
            "pieces[1]: x, y and z must be at most 10000 in absolute value",
            "pieces[2]: the quaternion must have a norm of at least 0.000001",
            "pieces[3] must be [x, y, z, qw, qx, qy, qz] of finite numbers",
        ]
    );
    // a later "s" replaces an earlier one, as in JavaScript
    assert!(read(r#"{"s":-1,"pieces":[],"s":2}"#).is_empty());
}
