//! A few facts about the torus family that do not need the TypeScript: known packings and lattices.

use polypack_torus::server::{check, reduced_lattice, LatticeSpec};
use polypack_torus::{
    gauss_reduce, lattice_images, max_image_candidates, torus_score, validation_steps, Lattice, Pose, TorusFamily,
    TorusPacking, ValidateOptions,
};

const MAX_TRANSLATES: f64 = 1000.0;

#[test]
fn one_disk_needs_a_square_torus_of_side_one() {
    let pose = [[0.3, 0.4, 0.0]];
    assert!(check(
        TorusFamily::Sq,
        0.0,
        &LatticeSpec::L(1.0),
        &pose,
        1e-9,
        20,
        MAX_TRANSLATES
    )
    .is_empty());
    // the server refuses a lattice vector shorter than the piece's width before the validator runs
    let reasons = check(
        TorusFamily::Sq,
        0.0,
        &LatticeSpec::L(0.9),
        &pose,
        1e-9,
        20,
        MAX_TRANSLATES,
    );
    assert_eq!(
        reasons,
        ["the lattice has a vector of length 0.9, shorter than the piece's width 1: every piece overlaps its own translate"]
    );
    // the validator alone names the translates
    let v = validation_steps(
        &TorusPacking {
            family: TorusFamily::Sq,
            n: 0.0,
            lattice: Lattice {
                b1: [0.9, 0.0],
                b2: [0.0, 0.9],
            },
            poses: vec![Pose {
                x: 0.3,
                y: 0.4,
                theta: 0.0,
            }],
        },
        &ValidateOptions::default(),
    );
    assert!(!v.valid);
    assert_eq!(
        v.overlaps.iter().map(|o| (o.i, o.j, o.m, o.n)).collect::<Vec<_>>(),
        [(0, 0, 0.0, 1.0), (0, 0, 1.0, 0.0)]
    );
    assert!((v.min_sep + 0.1).abs() < 1e-15 && v.score == 0.9);
}

#[test]
fn unit_squares_tile_a_square_torus() {
    // squares with horizontal edges (theta = pi/4), four in a torus of side 2
    let t = std::f64::consts::FRAC_PI_4;
    let poses = [[0.0, 0.0, t], [1.0, 0.0, t], [0.0, 1.0, t], [1.0, 1.0, t]];
    assert!(check(
        TorusFamily::Sq,
        4.0,
        &LatticeSpec::L(2.0),
        &poses,
        1e-11,
        20,
        MAX_TRANSLATES
    )
    .is_empty());
    let reasons = check(
        TorusFamily::Sq,
        4.0,
        &LatticeSpec::L(2.0 - 1e-6),
        &poses,
        1e-9,
        20,
        MAX_TRANSLATES,
    );
    assert!(
        reasons
            .iter()
            .any(|r| r.starts_with("pieces 0 and 1 overlap (translate (-1, 0)) by ")),
        "{reasons:?}"
    );
}

#[test]
fn a_skewed_or_left_handed_basis_is_reduced() {
    let skewed = Lattice {
        b1: [1.0, 0.0],
        b2: [5.0, 1.0],
    };
    let g = gauss_reduce(&skewed);
    assert_eq!(
        g.lattice,
        Lattice {
            b1: [1.0, 0.0],
            b2: [0.0, 1.0]
        }
    );
    assert_eq!(g.m, [[1.0, -5.0], [0.0, 1.0]]);
    assert_eq!(
        reduced_lattice(&skewed),
        Some(Lattice {
            b1: [1.0, 0.0],
            b2: [0.0, 1.0]
        })
    );
    // left-handed: stored with det > 0
    let left = Lattice {
        b1: [0.0, 1.0],
        b2: [1.0, 0.0],
    };
    assert_eq!(
        reduced_lattice(&left),
        Some(Lattice {
            b1: [0.0, 1.0],
            b2: [-1.0, -0.0]
        })
    );
    // reduced and right-handed: kept as sent
    assert_eq!(
        reduced_lattice(&Lattice {
            b1: [1.0, 0.0],
            b2: [0.5, 1.0]
        }),
        None
    );
    assert_eq!(torus_score(TorusFamily::Free, &skewed), 1.0);
    assert_eq!(torus_score(TorusFamily::Sq, &skewed), 1.0);
}

#[test]
fn a_nearly_degenerate_basis_is_refused_not_enumerated() {
    let l = Lattice {
        b1: [1.0, 0.0],
        b2: [1.0, 1e-9],
    };
    assert!(max_image_candidates(&l, 1.0) > 1e15);
    assert_eq!(
        lattice_images(&l, &[0.2, 0.0], 1.0, false),
        Err("lattice image enumeration too large (nearly degenerate basis)".to_string())
    );
    let reasons = check(
        TorusFamily::Free,
        0.0,
        &LatticeSpec::Basis {
            b1: [3.0, 0.0],
            b2: [3000.0, 3.0],
        },
        &[[0.0, 0.0, 0.0]],
        1e-9,
        20,
        MAX_TRANSLATES,
    );
    assert_eq!(reasons.len(), 1);
    assert!(
        reasons[0].starts_with("the lattice basis is too skewed: up to "),
        "{reasons:?}"
    );
}
