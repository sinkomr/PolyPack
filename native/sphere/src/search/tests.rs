use super::*;

#[test]
fn tight_size_finds_the_threshold_from_either_side() {
    for rho0 in [0.5, 1.0, 1.7, 3.0] {
        let mut calls = 0;
        let mut valid_at = |rho: f64| -> Result<bool, Stop> {
            calls += 1;
            Ok(rho >= 1.234)
        };
        let r = tight_size(&mut valid_at, rho0, 0.1).unwrap().unwrap();
        assert!(r >= 1.234 && r - 1.234 <= 1e-12, "{rho0}: {r}");
        assert!(calls < 100);
    }
    // never valid: none within the factor of the steps
    let mut never = |_: f64| -> Result<bool, Stop> { Ok(false) };
    assert_eq!(tight_size(&mut never, 1.0, 0.1).unwrap(), None);
}

#[test]
fn ticker_counts_and_stops_on_the_budget() {
    let mut t = Ticker {
        evaluations: 0,
        max_evals: 2,
        job: None,
    };
    assert!(t.tick().is_ok() && t.tick().is_ok());
    assert_eq!(t.tick(), Err(Stop::Evals));
}

#[test]
fn centre_theta_poses_put_the_centre_where_asked() {
    let c = unit(&[1.0, 2.0, -0.5]);
    let q = quat_from_centre_theta(&c, 0.7);
    let got = crate::geometry::centre_of(&q);
    for k in 0..3 {
        assert!((got[k] - c[k]).abs() < 1e-14);
    }
    for q in spiral_start(9, &[1.0, 0.0, 0.0, 0.0]) {
        assert!((math::hypot4(q[0], q[1], q[2], q[3]) - 1.0).abs() < 1e-14);
    }
}

#[test]
fn random_quats_are_unit() {
    let mut r = Rng::new(5);
    for _ in 0..100 {
        let q = random_quat(&mut r);
        assert!((math::hypot4(q[0], q[1], q[2], q[3]) - 1.0).abs() < 1e-14);
    }
}

#[test]
fn bad_problems_are_refused() {
    let o = SearchOptions {
        seed: 1,
        start: None,
        max_evals: 10,
        job: None,
    };
    assert!(search_sphere(&SphereProblem { n: 2.0, p: 5.0 }, &o).is_err());
    assert!(search_sphere(&SphereProblem { n: 4.0, p: 0.0 }, &o).is_err());
    assert!(search_sphere(&SphereProblem { n: 4.0, p: 101.0 }, &o).is_err());
}
