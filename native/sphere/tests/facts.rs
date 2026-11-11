//! A few facts about the sphere family that do not need the TypeScript: known packings and bounds.

use polypack_js::math::PI;
use polypack_sphere::server::check;
use polypack_sphere::{
    area_bound, piece_exists, validation_steps, SphereConfig, SpherePiece, SphereProblem, ValidateOptions,
};

fn config(rho: f64, quats: &[[f64; 4]]) -> SphereConfig {
    SphereConfig {
        rho,
        pieces: quats.iter().map(|q| SpherePiece { q: q.to_vec() }).collect(),
    }
}

#[test]
fn two_antipodal_pieces_fit_just_above_the_existence_limit() {
    // sphere/N/2: the pieces are nearly hemispheres about the two poles
    for n in [3.0, 4.0, 5.0, 12.0, 100.0] {
        let rho = n / (2.0 * PI) * (1.0 + 1e-9);
        assert!(piece_exists(n, rho));
        let c = config(rho, &[[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]]);
        let v = validation_steps(&SphereProblem { n, p: 2.0 }, &c, &ValidateOptions::default());
        assert!(v.valid && v.errors.is_empty(), "N = {n}: {v:?}");
        assert!(!piece_exists(n, n / (2.0 * PI) * (1.0 - 1e-9)));
    }
}

#[test]
fn two_caps_touch_at_rho_one_over_pi() {
    // two caps of angular radius pi/2 are the two hemispheres: rho = 1/(2 a) = 1/pi
    assert!((area_bound(0.0, 2.0) - 1.0 / PI).abs() < 1e-15);
    let poles = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]];
    assert!(check(0.0, 2.0, &config(1.0 / PI * (1.0 + 1e-12), &poles), 1e-9, 20).is_empty());
    assert_eq!(
        check(0.0, 2.0, &config(0.3, &poles), 1e-9, 20),
        vec!["disks larger than a hemisphere cannot both fit".to_string()]
    );
}

#[test]
fn coincident_pieces_overlap_and_the_sentence_names_them() {
    let same = [[1.0, 0.0, 0.0, 0.0], [2.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]];
    let reasons = check(4.0, 3.0, &config(2.0, &same), 1e-9, 20);
    assert_eq!(reasons.len(), 1);
    assert!(reasons[0].starts_with("pieces 0 and 1 overlap by "), "{reasons:?}");
}

#[test]
fn the_validator_lists_what_is_wrong_with_the_input() {
    let c = SphereConfig {
        rho: -1.0,
        pieces: vec![
            SpherePiece { q: vec![0.0; 4] },
            SpherePiece {
                q: vec![1.0, f64::NAN, 0.0],
            },
        ],
    };
    let v = validation_steps(&SphereProblem { n: 2.0, p: 3.0 }, &c, &ValidateOptions::default());
    assert!(!v.valid && v.worst_pair.is_none() && v.min_gap == f64::NEG_INFINITY);
    assert_eq!(
        v.errors,
        [
            "N must be 0 or an integer in [3, 100]",
            "number of pieces differs from P",
            "rho must be positive and finite",
            "piece 0: zero quaternion",
            "piece 1: q must be 4 finite numbers",
        ]
    );
}
