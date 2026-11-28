//! The geometry of the search against the validator's, and the energy's gradient against finite differences.

use fresh_polyhedra::energy::{Energy, State};
use fresh_polyhedra::lbfgs::{Budget, Tol};
use fresh_polyhedra::model::{rot, Problem};
use fresh_polyhedra::repair::{check, check_default, size_needed, Repairer};
use fresh_polyhedra::rng::Rng;
use fresh_polyhedra::search::Search;
use polypack_polyhedra::{place, separation, validate_polyhedra, wall_gap, PolyhedraConfig, ValidateOptions};

/// Problems of every kind of piece and container: Platonic, Archimedean, Catalan, prisms (long ones too),
/// antiprisms, bipyramids, trapezohedra, Johnson solids, and solids in a ball.
const IDS: [&str; 14] = [
    "polyhedra/tetintet/6",
    "polyhedra/cubintet/5",
    "polyhedra/octincub/7",
    "polyhedra/dodinico/4",
    "polyhedra/tteintte/5",
    "polyhedra/rdoinrdo/4",
    "polyhedra/pr3l3incub/6",
    "polyhedra/ap7incub/5",
    "polyhedra/bp5inbp5/4",
    "polyhedra/tz6incub/5",
    "polyhedra/j01inj92/6",
    "polyhedra/j92inpr3l3/5",
    "balls/tetinball/5",
    "balls/j37inball/4",
];

fn random_state(prob: &Problem, s: f64, rng: &mut Rng) -> State {
    let mut st = State::default();
    for _ in 0..prob.p {
        let c = prob.cont.random_inside(s, 0.0, rng);
        let q = rng.quaternion();
        // quaternions of other lengths too: R depends on the direction only
        let l = rng.range(0.5, 2.0);
        st.x.extend_from_slice(&[c[0], c[1], c[2], q[0] * l, q[1] * l, q[2] * l, q[3] * l]);
    }
    st
}

#[test]
fn gradient_matches_finite_differences() {
    let mut rng = Rng::new(7);
    for id in IDS {
        let prob = Problem::parse(id).unwrap();
        let mut en = Energy::new(&prob.piece, &prob.cont, prob.p);
        for round in 0..4 {
            // dense enough for overlaps and protrusions
            let s = prob.size_at_density(0.5 + 0.2 * round as f64);
            let mut st = random_state(&prob, s, &mut rng);
            en.s = s;
            en.rebuild(&mut st, None);
            // keep the raw quaternion lengths and perturb the planes off their initial values
            for i in 0..prob.p {
                let l = rng.range(0.5, 2.0);
                for k in 3..7 {
                    st.x[7 * i + k] *= l;
                }
            }
            for v in st.x[7 * prob.p..].iter_mut() {
                *v += 0.05 * rng.range(-1.0, 1.0);
            }
            std::mem::swap(&mut en.pairs, &mut st.pairs);
            let n = st.x.len();
            let mut g = vec![0.0; n];
            let e0 = en.eval(&st.x, &mut g);
            assert!(e0 > 0.0, "{id}: the test wants overlaps");
            let mut gs = vec![0.0; n];
            let mut worst = 0.0f64;
            let gmax = g.iter().fold(0.0f64, |a, &b| a.max(b.abs()));
            for k in 0..n {
                let h = 1e-6;
                let mut xp = st.x.clone();
                xp[k] += h;
                let ep = en.eval(&xp, &mut gs);
                let mut xm = st.x.clone();
                xm[k] -= h;
                let em = en.eval(&xm, &mut gs);
                let fd = (ep - em) / (2.0 * h);
                worst = worst.max((fd - g[k]).abs());
            }
            assert!(worst <= 1e-5 * gmax.max(1.0), "{id} round {round}: gradient error {worst:.3e} (max component {gmax:.3e})");
            std::mem::swap(&mut en.pairs, &mut st.pairs);
        }
    }
}

/// The overlap the planes measure is never less than the validator's penetration depth, and a pair the planes
/// show apart is apart for the validator; the size the search computes holds every vertex at the validator's
/// wall gap of zero.
#[test]
fn measures_agree_with_the_validator() {
    let mut rng = Rng::new(11);
    for id in IDS {
        let prob = Problem::parse(id).unwrap();
        let en = Energy::new(&prob.piece, &prob.cont, prob.p);
        let rho = prob.piece.rho;
        let solid = prob.piece.solid;
        for _ in 0..30 {
            let s = prob.size_at_density(0.6);
            let st = random_state(&prob, s, &mut rng);
            for i in 0..prob.p {
                for j in i + 1..prob.p {
                    let plane = en.init_plane(&st.x, i, j, None);
                    let u = [plane[0], plane[1], plane[2]];
                    let pose = |k: usize| {
                        let x = &st.x[7 * k..7 * k + 7];
                        [x[0] * rho, x[1] * rho, x[2] * rho, x[3], x[4], x[5], x[6]]
                    };
                    let a = place(solid, &pose(i)).unwrap();
                    let b = place(solid, &pose(j)).unwrap();
                    let hi = a.x.chunks_exact(3).map(|v| v[0] * u[0] + v[1] * u[1] + v[2] * u[2]).fold(f64::NEG_INFINITY, f64::max);
                    let lo = b.x.chunks_exact(3).map(|v| v[0] * u[0] + v[1] * u[1] + v[2] * u[2]).fold(f64::INFINITY, f64::min);
                    let gap = lo - hi;
                    let sep = separation(&a, &b, f64::INFINITY, None).sep;
                    if sep <= 0.0 {
                        assert!(gap <= sep + 1e-12, "{id}: plane gap {gap} above the validator's {sep}");
                    }
                    if gap >= 0.0 {
                        assert!(sep >= -1e-12, "{id}: apart along the plane ({gap}) but overlapping for the validator ({sep})");
                    }
                }
            }
            // containment: the least size from the vertices is where the validator's wall gap is zero
            for i in 0..prob.p {
                let x = &st.x[7 * i..7 * i + 7];
                let pose = [x[0] * rho, x[1] * rho, x[2] * rho, x[3], x[4], x[5], x[6]];
                let a = place(solid, &pose).unwrap();
                let need = size_needed(&prob, &a.x);
                if let Some(c) = prob.cont.solid {
                    let g = wall_gap(c, need, &a.x);
                    assert!(g.abs() <= 1e-12 * need, "{id}: wall gap {g} at the size needed");
                    assert!(wall_gap(c, need * (1.0 - 1e-9), &a.x) < 0.0);
                } else {
                    let far = a.x.chunks_exact(3).map(|v| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()).fold(0.0, f64::max);
                    assert!((need / 2.0 - far).abs() <= 1e-12 * need);
                }
                // and the internal measure agrees
                let r = rot(&x[3..7]);
                let internal = prob.cont.size_for_piece(&prob.piece, [x[0], x[1], x[2]], &r);
                assert!((internal - need).abs() <= 1e-9 * need, "{id}: internal size {internal} vs {need}");
            }
        }
    }
}

/// E = 0 at a size means the repaired packing is valid at (about) that size; repaired packings of any
/// arrangement pass the check, also at tolerance 0.
#[test]
fn relaxed_and_repaired_packings_are_valid() {
    for (n, id) in IDS.iter().enumerate() {
        let prob = Problem::parse(id).unwrap();
        let budget = Budget::new(u64::MAX, 1e9);
        let mut search = Search::new(&prob, 3 + n as u64, budget);
        let mut rep = Repairer::default();
        for round in 0..3 {
            let s = prob.size_at_density(0.25 + 0.1 * round as f64);
            let mut st = State::default();
            search.start_random(s, &mut st);
            // an unrelaxed arrangement (overlapping) still repairs to a valid packing
            let raw = rep.repair(&prob, &st, 1.0);
            let cfg = raw.to_json();
            assert!(check(&prob, &cfg).is_some(), "{id}: repaired raw arrangement refused");
            let tol = Tol { e_stop: 1e-28, rel: 1e-13, patience: 6, gtol: 1e-16, max_iter: 20000, max_step: 0.1, window: 0, window_rel: 0.0 };
            let e = search.relax(&mut st, s, &tol).e;
            let pk = rep.repair(&prob, &st, 1.0);
            let cfg = pk.to_json();
            assert_eq!(check_default(&prob, &cfg), Some(pk.s), "{id}: repaired packing refused");
            assert!(check(&prob, &cfg).is_some(), "{id}: repaired packing refused by the strict check");
            if prob.space == polypack_spaces::SpaceName::Polyhedra {
                let code = id.split('/').nth(1).unwrap();
                let problem = polypack_polyhedra::get_problem(code).unwrap();
                let c = PolyhedraConfig { s: pk.s, pieces: pk.poses.clone() };
                let v = validate_polyhedra(&problem, &c, &ValidateOptions { tol: Some(0.0), max_errors: None, stop_at: Some(f64::INFINITY) }).unwrap();
                assert!(v.valid, "{id}: not valid at tolerance 0: {:?}", v.errors);
            }
            if e <= 1e-28 {
                assert!(pk.s <= s * (1.0 + 1e-10), "{id}: feasible at {s} but repaired to {}", pk.s);
            }
        }
    }
}
