//! Short runs: valid packings at the reported score with an improving trace, reproducible runs with an
//! evaluation budget, the client's stop flag and deadline, and a valid start never returned worse.

use fresh_surface_nofold::fresh::{fresh_search, handles};
use fresh_surface_nofold::solve;
use polypack_spaceauto::FreshJob;
use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const PROBLEMS: [&str; 12] = [
    "surface/cube/nofold/0/13",
    "surface/tetrahedron/nofold/3/40",
    "surface/icosahedron/nofold/5/72",
    "surface/cuboctahedron/nofold/4/30",
    "surface/truncated_icosahedron/nofold/12/50",
    "surface/rhombic_dodecahedron/nofold/5/30",
    "surface/pentagonal_hexecontahedron/nofold/0/70",
    "surface/triakis_tetrahedron/nofold/66/7",
    "surface/prism11/nofold/7/30",
    "surface/antiprism9/nofold/3/5",
    "surface/square_pyramid/nofold/100/9",
    "surface/pentagonal_gyrocupolarotunda/nofold/8/51",
];

fn check(id: &str, cfg: &serde_json::Value, strict: bool) -> Option<f64> {
    let opts = SpaceValidateOptions { no_record: strict, ..SpaceValidateOptions::default() };
    let v = validate_space_submission(SpaceName::Surface, id, cfg, &opts);
    if v.valid {
        v.score
    } else {
        None
    }
}

#[test]
fn short_runs_pass_the_check_with_an_improving_trace() {
    for id in PROBLEMS {
        let out = solve(id, 1, 0.4, None, None, None, None).unwrap();
        let cfg = out.config.as_ref().unwrap_or_else(|| panic!("{id}: no packing"));
        let score = out.score.unwrap();
        let checked = check(id, cfg, false).unwrap_or_else(|| panic!("{id}: the check refuses the packing"));
        assert_eq!(checked, score, "{id}");
        assert!(check(id, cfg, true).is_some(), "{id}: not valid at the strict tolerance");
        assert!(!out.trace.is_empty(), "{id}: empty trace");
        for w in out.trace.windows(2) {
            assert!(w[1].1 < w[0].1 && w[1].0 >= w[0].0, "{id}: trace not improving: {:?}", out.trace);
        }
        assert_eq!(out.trace.last().unwrap().1, score, "{id}: the trace ends elsewhere");
        let bound = polypack_surface::surface_bound(id.split('/').nth(1).unwrap(), id.split('/').nth(3).unwrap().parse().unwrap(), id.split('/').nth(4).unwrap().parse().unwrap()).unwrap().value;
        assert!(score >= bound * (1.0 - 1e-9), "{id}: score {score} below the lower bound {bound}");
    }
}

#[test]
fn runs_with_an_evaluation_budget_repeat() {
    for id in ["surface/cube/nofold/0/13", "surface/rhombic_dodecahedron/nofold/5/30", "surface/cuboctahedron/nofold/4/30", "surface/prism11/nofold/7/30"] {
        let a = solve(id, 3, 100.0, Some(150_000), None, None, None).unwrap();
        let b = solve(id, 3, 100.0, Some(150_000), None, None, None).unwrap();
        assert_eq!(a.stopped, b.stopped, "{id}");
        assert_eq!(a.score, b.score, "{id}");
        assert_eq!(a.config, b.config, "{id}");
        let sa: Vec<f64> = a.trace.iter().map(|t| t.1).collect();
        let sb: Vec<f64> = b.trace.iter().map(|t| t.1).collect();
        assert_eq!(sa, sb, "{id}");
    }
}

#[test]
fn handles_only_nofold_ids() {
    assert!(handles("surface/cube/nofold/0/13"));
    assert!(handles("surface/j92/nofold/100/100") || !polypack_surface::is_solid_name("j92"));
    assert!(handles("surface/snub_dodecahedron/nofold/100/1"));
    assert!(!handles("surface/cube/fold/0/13"));
    assert!(!handles("surface/cube/nofold/2/13"));
    assert!(!handles("surface/cube/nofold/101/13"));
    assert!(!handles("surface/cube/nofold/4/0"));
    assert!(!handles("surface/cube/nofold/4/101"));
    assert!(!handles("surface/nosuchsolid/nofold/4/10"));
    assert!(!handles("flat/4/4/10"));
    let stop = AtomicBool::new(false);
    let job = FreshJob { id: "surface/cube/fold/0/13", seed: 1, cpu_seconds: 1.0, deadline: Instant::now() + Duration::from_secs(5), stop: &stop, start: None, max_evals: None };
    assert!(fresh_search(&job, &mut |_, _| {}).is_err());
}

#[test]
fn stop_flag_and_deadline_end_a_search_quickly() {
    for id in ["surface/tetrahedron/nofold/7/100", "surface/truncated_icosidodecahedron/nofold/100/100", "surface/prism12/nofold/0/100"] {
        // the stop flag, set from another thread
        let stop = AtomicBool::new(false);
        let t0 = Instant::now();
        let end = std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                stop.store(true, Ordering::Relaxed);
            });
            let job = FreshJob { id, seed: 1, cpu_seconds: 100.0, deadline: Instant::now() + Duration::from_secs(100), stop: &stop, start: None, max_evals: None };
            let r = fresh_search(&job, &mut |_, _| {}).unwrap();
            assert_eq!(r.stopped, "stop", "{id}");
            assert!(r.config.is_some(), "{id}");
            t0.elapsed()
        });
        assert!(end < Duration::from_millis(500), "{id}: stopped after {end:?}");
        // the wall deadline
        let stop = AtomicBool::new(false);
        let t0 = Instant::now();
        let job = FreshJob { id, seed: 1, cpu_seconds: 100.0, deadline: Instant::now() + Duration::from_millis(300), stop: &stop, start: None, max_evals: None };
        let r = fresh_search(&job, &mut |_, _| {}).unwrap();
        assert_eq!(r.stopped, "deadline", "{id}");
        assert!(t0.elapsed() < Duration::from_millis(500), "{id}: deadline overrun {:?}", t0.elapsed());
    }
}

#[test]
fn a_valid_start_is_never_returned_worse() {
    for id in ["surface/cube/nofold/0/13", "surface/rhombic_dodecahedron/nofold/5/30", "surface/truncated_icosahedron/nofold/12/50"] {
        let first = solve(id, 1, 0.5, None, None, None, None).unwrap();
        let start = first.config.unwrap();
        let s0 = first.score.unwrap();
        for evals in [1u64, 1000, 100_000] {
            let stop = AtomicBool::new(false);
            let mut reported: Vec<f64> = Vec::new();
            let job = FreshJob { id, seed: 7, cpu_seconds: 5.0, deadline: Instant::now() + Duration::from_secs(10), stop: &stop, start: Some(&start), max_evals: Some(evals) };
            let r = fresh_search(&job, &mut |s, cfg| {
                assert!(check(id, cfg, false) == Some(s));
                reported.push(s);
            })
            .unwrap();
            let s = r.score.unwrap();
            assert!(s <= s0, "{id} evals {evals}: {s} worse than the start {s0}");
            assert_eq!(check(id, r.config.as_ref().unwrap(), false), Some(s), "{id}");
            assert!(reported.iter().all(|&x| x < s0), "{id}: reported a score no better than the start");
        }
    }
}
