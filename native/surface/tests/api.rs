//! The shape of what the server calls, on configurations small enough to read.

use polypack_surface::chains::{chain_path, enumerate_chains, ChainError, MAX_CHAIN_DEPTH};
use polypack_surface::{all_solid_names, get_solid, validate, Mode, SurfaceConfig, SurfacePose, ValidateOptions};

fn server() -> ValidateOptions {
    // packages/spaces/src/validate.ts: check (MAX_REASONS = 20, SURFACE_MAX_CHAINS = 600)
    ValidateOptions { max_errors: 20, max_chains: 600.0, ..ValidateOptions::default() }
}

fn piece(face: usize, x: f64, y: f64, theta: f64) -> SurfacePose {
    SurfacePose { face: face as f64, x, y, theta }
}

#[test]
fn the_solids_of_the_family() {
    let names = all_solid_names();
    assert_eq!(names.len(), 141);
    assert_eq!(names[0], "tetrahedron");
    assert_eq!(names[140], "triangular_hebesphenorotunda");
    let cube = get_solid("cube").unwrap();
    assert_eq!((cube.f, cube.v, cube.e, cube.m), (6, 8, 12.0, 4));
    assert!(cube.uniform);
    // every edge is glued to its reverse
    for name in names {
        let s = get_solid(name).unwrap();
        for f in 0..s.f {
            for k in 0..s.sides[f] {
                let r = s.adj[f][k];
                assert_eq!((s.adj[r.face][r.edge].face, s.adj[r.face][r.edge].edge), (f, k), "{name}");
            }
        }
    }
}

#[test]
fn one_square_per_face_of_a_cube() {
    // a unit square in a face of edge 1 fills it: valid without folding, at both tolerances
    let pieces: Vec<SurfacePose> = (0..6).map(|f| piece(f, 0.0, 0.0, std::f64::consts::FRAC_PI_4)).collect();
    let cfg = SurfaceConfig { solid: "cube".to_string(), n: 4.0, s: 1.0, pieces };
    for tol in [1e-9, 1e-11] {
        for mode in [Mode::Nofold, Mode::Fold] {
            let v = validate(&cfg, mode, &ValidateOptions { tol, ..server() }).unwrap();
            assert!(v.ok, "{mode:?} at {tol:e}: {:?}", v.errors);
            assert!(v.errors.is_empty());
        }
    }
    // a slightly smaller cube: every square leaves its face (nofold), and in fold mode the squares overlap
    let small = SurfaceConfig { s: 0.99, ..cfg.clone() };
    let v = validate(&small, Mode::Nofold, &server()).unwrap();
    assert!(!v.ok);
    assert_eq!(v.errors.len(), 6);
    assert!(v.errors[0].starts_with("piece 0 leaves face 0 by 0.00"), "{}", v.errors[0]);
    let v = validate(&small, Mode::Fold, &server()).unwrap();
    assert!(!v.ok);
    assert!(v.errors.iter().any(|e| e.contains("overlap on face")), "{:?}", v.errors);
}

#[test]
fn malformed_configurations_give_the_reasons_of_check_shape() {
    let cfg = SurfaceConfig { solid: "cube".to_string(), n: 2.0, s: 0.0, pieces: vec![] };
    let v = validate(&cfg, Mode::Fold, &server()).unwrap();
    assert!(!v.ok);
    assert_eq!(v.errors, ["N must be 0 or an integer >= 3", "s must be a positive finite number", "pieces must be a non-empty array"]);
    assert!(v.min_pair_sep.is_nan() && v.min_cone_sep.is_nan() && v.min_wall_sep.is_nan());
    let cfg = SurfaceConfig { solid: "hypercube".to_string(), n: 4.0, s: 1.0, pieces: vec![piece(0, 0.0, 0.0, 0.0)] };
    assert_eq!(validate(&cfg, Mode::Nofold, &server()).unwrap().errors, ["unknown solid hypercube"]);
    let cfg = SurfaceConfig {
        solid: "cube".to_string(),
        n: 4.0,
        s: 1.0,
        pieces: vec![piece(6, 0.0, 0.0, 0.0), SurfacePose { face: 1.5, x: 0.0, y: 0.0, theta: 0.0 }, piece(0, f64::NAN, 0.0, 0.0)],
    };
    assert_eq!(
        validate(&cfg, Mode::Fold, &server()).unwrap().errors,
        ["pieces[0].face out of range", "pieces[1].face out of range", "pieces[2] needs finite x, y, theta"]
    );
}

#[test]
fn the_chain_limit_is_an_error_the_caller_can_tell_apart() {
    // a tetrahedron of edge 0.01 under a unit triangle: far more than 600 chains of faces
    let cfg = SurfaceConfig { solid: "tetrahedron".to_string(), n: 3.0, s: 0.01, pieces: vec![piece(2, 0.0, 0.0, 0.0)] };
    let e = validate(&cfg, Mode::Fold, &server()).unwrap_err();
    assert!(e.is_chain_limit());
    assert_eq!(e.message(), "more than 600 chains of faces from one point (face 2): the solid is far too small for its pieces");
    assert_eq!(e.to_string(), e.message());
    // nofold never enumerates chains
    assert!(validate(&cfg, Mode::Nofold, &server()).is_ok());
    // without a chain limit the search stops at the depth limit, which is another error
    let solid = get_solid("tetrahedron").unwrap();
    match enumerate_chains(solid, 0.01, 0, 0.0, 0.0, 1.0, f64::INFINITY) {
        Err(ChainError::Other(m)) => assert!(m.starts_with("chain depth limit reached: 0:") && m.contains(" w="), "{m}"),
        other => panic!("{other:?}"),
    }
    // the path of a node is as long as its depth
    let nodes = enumerate_chains(solid, 1.0, 0, 0.0, 0.0, 1.0, f64::INFINITY).unwrap();
    assert!(nodes.len() > 1);
    for (i, n) in nodes.iter().enumerate() {
        assert_eq!(chain_path(&nodes, i).len(), n.depth);
        assert!(n.depth < MAX_CHAIN_DEPTH);
    }
}
