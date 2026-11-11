//! Checks of the catalogue and the poses that need no reference: the polytopes' own facts.
use polypack_ndim::polytope::{lazy_codes, load_polytope, polytope_codes};
use polypack_ndim::pose::{cayley_matrix, n_params};
use polypack_ndim::space::{nd_code, nd_shapes, ndim_domain_info_json, ndim_domain_sample, ND_DIMENSIONS};
use polypack_ndim::{polytope_info_table, validate_nd, NdConfig, NdProblem, ValidateOptions};

#[test]
fn every_polytope_has_its_counts_radii_and_unit_edges() {
    assert_eq!(polytope_codes().len(), 34);
    assert_eq!(lazy_codes(), ["4:120cell", "4:24cell", "4:600cell", "6:122", "6:221", "7:321", "8:421"]);
    for info in polytope_info_table() {
        let p = load_polytope(&info.code).expect("a catalogue polytope loads");
        let d = p.d;
        assert_eq!((p.v.len(), p.n.len(), p.b.len()), (p.n_v * d, p.n_f * d, p.n_f), "{}", p.code);
        // every vertex inside every facet, the radii, unit normals
        let mut worst = f64::NEG_INFINITY;
        let mut far = 0.0f64;
        for v in p.v.chunks(d) {
            far = far.max(v.iter().map(|x| x * x).sum::<f64>().sqrt());
            for (f, nf) in p.n.chunks(d).enumerate() {
                worst = worst.max(nf.iter().zip(v).map(|(a, b)| a * b).sum::<f64>() - p.b[f]);
            }
        }
        assert!(worst.abs() < 1e-12, "{}: a vertex is {worst} off its facets", p.code);
        assert!((far - p.circumradius).abs() < 1e-12, "{}", p.code);
        let inr = p.b.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!((inr - p.inradius).abs() < 1e-12, "{}", p.code);
        for nf in p.n.chunks(d) {
            assert!((nf.iter().map(|x| x * x).sum::<f64>() - 1.0).abs() < 1e-12, "{}", p.code);
        }
        // the shortest distance between two vertices is the edge, 1 (the large ones by their first vertices)
        let take = p.n_v.min(120);
        let mut shortest = f64::INFINITY;
        for i in 0..take {
            for j in 0..p.n_v {
                if i != j {
                    let s: f64 = (0..d).map(|c| (p.v[i * d + c] - p.v[j * d + c]).powi(2)).sum();
                    shortest = shortest.min(s.sqrt());
                }
            }
        }
        assert!((shortest - 1.0).abs() < 1e-12, "{}: shortest edge {shortest}", p.code);
    }
}

#[test]
fn the_space_lists_the_catalogue() {
    let mut codes: Vec<String> = Vec::new();
    for d in ND_DIMENSIONS {
        for shape in nd_shapes(d) {
            if shape != "ball" {
                codes.push(nd_code(d, shape));
            }
        }
    }
    codes.sort();
    let mut all: Vec<String> = polytope_codes().iter().map(|c| c.to_string()).collect();
    all.sort();
    assert_eq!(codes, all);
    assert_eq!(ndim_domain_sample(3), ["ndim/4/simplex/simplex/2", "ndim/4/simplex/cube/2", "ndim/4/simplex/ortho/2"]);
    // the whole text, as the TypeScript's JSON.stringify(ndimDomain.info) (written by native/tools/ndim-ref.mts)
    assert_eq!(ndim_domain_info_json(), include_str!("fixtures/domain-info.json").trim_end());
    assert!(ndim_domain_info_json().starts_with(r#"{"id":"ndim/<d>/<piece>/<container>/<P>","fields":[{"key":"d","label":"Dimension","values":["4","5","6","7","8","9","10"]},{"key":"piece","label":"Piece","values":["simplex","cube","ortho","24cell","120cell","600cell","demi","221","122","321","421","ball"],"titles":{"122":"1_22 polytope","221":"2_21 polytope","321":"3_21 polytope","421":"4_21 polytope","simplex":"Simplex","#));
}

#[test]
fn a_cayley_matrix_is_a_rotation() {
    for d in 4..=10usize {
        let params: Vec<f64> = (0..n_params(d)).map(|k| ((k * 37 % 19) as f64 - 9.0) / 4.0).collect();
        for flip in [0u32, 3, 5] {
            let r = cayley_matrix(&params, d, flip).expect("I - S is regular");
            for i in 0..d {
                for j in 0..d {
                    let g: f64 = (0..d).map(|k| r[k * d + i] * r[k * d + j]).sum();
                    assert!((g - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12, "d = {d}");
                }
            }
        }
    }
}

#[test]
fn a_grid_of_hypercubes_is_valid_and_a_tighter_container_is_not() {
    for d in 4..=10usize {
        let gap = 1e-7;
        let pieces: Vec<Vec<f64>> = (0..16usize)
            .map(|k| {
                let mut q: Vec<f64> = (0..d).map(|i| (((k >> i) & 1) as f64 - 0.5) * (1.0 + gap)).collect();
                q.extend(vec![0.0; n_params(d) + 1]);
                q
            })
            .collect();
        let problem = NdProblem { d: d as i64, piece: format!("{d}:cube"), container: format!("{d}:cube") };
        let good = validate_nd(&problem, &NdConfig { s: 2.0 + 2.0 * gap, pieces: pieces.clone() }, &ValidateOptions::default()).unwrap();
        assert!(good.valid && good.score == Some(2.0 + 2.0 * gap), "{d}D: {:?}", good.reasons);
        assert!((good.min_pair_sep - gap).abs() < 1e-12 && (good.min_wall_gap - gap / 2.0).abs() < 1e-12, "{d}D");
        let tight = validate_nd(&problem, &NdConfig { s: 2.0 - 1e-6, pieces }, &ValidateOptions::default()).unwrap();
        assert!(!tight.valid && tight.reasons[0].starts_with("piece 0 sticks out of the container by "), "{d}D");
    }
}

#[test]
fn a_configuration_is_read_from_json_as_javascript_reads_it() {
    use polypack_ndim::space::{parse_nd_config, NdParsed, NdProblemId};
    let p = NdProblemId { d: 4, piece: "cube".into(), container: "cube".into(), p: 2 };
    // a flip written 2.0 or 3 is the integer; a number too large for a double is not finite (null after
    // polypack_js::json::parse, Infinity in JavaScript: the same message)
    let text = br#"{"s": 2.5, "extra": true, "pieces": [[0.5,0,0,0, 0,0,0,0,0,0, 3.0], [-0.5,0,0,0, 0,0,0,0,0,0]]}"#;
    let raw = polypack_js::json::parse(text).unwrap();
    match parse_nd_config(&p, &raw).unwrap() {
        NdParsed::Ok { config, score } => {
            assert_eq!(score, 2.5);
            assert_eq!(config.pieces[0].len(), 11);
            assert_eq!(config.pieces[0][10], 3.0);
            assert_eq!(config.pieces[1].len(), 10);
        }
        other => panic!("{other:?}"),
    }
    let raw = polypack_js::json::parse(br#"{"s": 1e400, "pieces": [[1e999,0,0,0, 0,0,0,0,0,0], [0,0,0,0, 0,0,0,0,0,0, 1e400]]}"#).unwrap();
    assert_eq!(
        parse_nd_config(&p, &raw).unwrap(),
        NdParsed::Bad {
            malformed: true,
            errors: vec![
                "s must be a positive finite number of at most 1000000".into(),
                "pieces[0] must contain finite numbers only".into(),
                "pieces[1] the flip must be an integer in [0, 2^4)".into(),
            ],
        }
    );
    let raw = polypack_js::json::parse(br#"{"s": 2, "pieces": [[0,0,0,0, 0,0,0,0,0,0]]}"#).unwrap();
    assert_eq!(
        parse_nd_config(&p, &raw).unwrap(),
        NdParsed::Bad { malformed: false, errors: vec!["expected 2 pieces for this problem, got 1".into()] }
    );
}
