//! Short searches: valid packings with an improving trace on diverse problems, reproducible
//! evaluation-budget runs, and the client interface (stop flag, wall deadline, a start configuration).

use polypack_flat::clock::thread_cpu_seconds;
use polypack_fresh_surface_fold::fresh::{fresh_search, handles};
use polypack_fresh_surface_fold::model::Budget;
use polypack_fresh_surface_fold::search::{Report, Search};
use polypack_fresh_surface_fold::{check, Problem};
use polypack_spaceauto::FreshJob;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn run(id: &str, seed: u64, evals: u64) -> Report {
    let prob = Problem::parse(id).unwrap();
    let clock = thread_cpu_seconds;
    let budget = Budget::new(f64::INFINITY, Some(evals), &clock);
    let mut checker = |c: &Value| check(id, c);
    let search = Search::new(&prob, seed, budget, &mut checker).unwrap();
    search.run(None)
}

/// Ten problems across the families and shapes: the result passes the check at its score, the trace
/// strictly improves and ends at it, and it is no worse than the lower bound allows.
#[test]
fn short_runs_are_valid_with_an_improving_trace() {
    let ids = [
        "surface/cube/fold/4/12",
        "surface/tetrahedron/fold/0/7",
        "surface/icosahedron/fold/3/20",
        "surface/truncated_octahedron/fold/6/9",
        "surface/snub_cube/fold/0/30",
        "surface/rhombic_dodecahedron/fold/5/11",
        "surface/disdyakis_triacontahedron/fold/8/6",
        "surface/prism5/fold/12/5",
        "surface/antiprism9/fold/3/24",
        "surface/elongated_pentagonal_gyrobirotunda/fold/65/4",
        "surface/square_pyramid/fold/100/1",
        "surface/bilunabirotunda/fold/0/1",
    ];
    for id in ids {
        let r = run(id, 1, 40_000);
        let best = r.best.unwrap_or_else(|| panic!("{id}: no packing"));
        assert_eq!(check(id, &best.config), Some(best.score), "{id}: the check does not give the reported score");
        assert!(!r.trace.is_empty());
        for w in r.trace.windows(2) {
            assert!(w[1].1 < w[0].1 && w[1].0 >= w[0].0, "{id}: trace not improving");
        }
        assert_eq!(r.trace.last().unwrap().1, best.score);
        let bound = Problem::parse(id).unwrap().bound;
        assert!(best.score >= bound * (1.0 - 1e-9));
        eprintln!("{id}: {} ({} improvements, {} evaluations, {:.3} of the bound)", best.score, r.trace.len(), r.evaluations, best.score / bound);
    }
}

/// The same id, seed and evaluation budget give the same packing.
#[test]
fn evaluation_budgets_are_reproducible() {
    for id in ["surface/octahedron/fold/3/9", "surface/cuboctahedron/fold/0/14", "surface/prism7/fold/72/6"] {
        let a = run(id, 7, 20_000);
        let b = run(id, 7, 20_000);
        assert_eq!(a.evaluations, b.evaluations, "{id}");
        assert_eq!(a.best.as_ref().map(|x| x.config.clone()), b.best.as_ref().map(|x| x.config.clone()), "{id}");
        let ta: Vec<f64> = a.trace.iter().map(|t| t.1).collect();
        let tb: Vec<f64> = b.trace.iter().map(|t| t.1).collect();
        assert_eq!(ta, tb, "{id}");
    }
}

#[test]
fn handles_only_fold_ids() {
    assert!(handles("surface/cube/fold/4/12"));
    assert!(handles("surface/bilunabirotunda/fold/0/1"));
    assert!(handles("surface/prism7/fold/100/100"));
    assert!(!handles("surface/cube/nofold/4/12"));
    assert!(!handles("surface/cube/fold/2/12"));
    assert!(!handles("surface/cube/fold/4/0"));
    assert!(!handles("surface/cube/fold/4/101"));
    assert!(!handles("surface/nosuchsolid/fold/4/12"));
    assert!(!handles("sphere/0/12"));
    let stop = AtomicBool::new(false);
    let job = FreshJob { id: "surface/cube/nofold/4/12", seed: 1, cpu_seconds: 1.0, deadline: Instant::now() + Duration::from_secs(5), stop: &stop, start: None, max_evals: None };
    assert!(fresh_search(&job, &mut |_, _| {}).is_err());
}

/// The stop flag and the wall deadline end a long search within about 0.2 s; improvements are reported
/// in order and the result is the last of them.
#[test]
fn stop_flag_and_deadline_are_honoured() {
    let id = "surface/truncated_cuboctahedron/fold/0/41";
    // the stop flag, set by another thread after 0.4 s
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let setter = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        s2.store(true, Ordering::Relaxed);
    });
    let t0 = Instant::now();
    let job = FreshJob { id, seed: 1, cpu_seconds: 100.0, deadline: Instant::now() + Duration::from_secs(100), stop: &stop, start: None, max_evals: None };
    let mut seen: Vec<f64> = Vec::new();
    let r = fresh_search(&job, &mut |s, _| seen.push(s)).unwrap();
    let wall = t0.elapsed().as_secs_f64();
    setter.join().unwrap();
    assert!(wall < 0.4 + 0.25, "stop flag: returned after {wall} s");
    assert_eq!(r.stopped, "stop");
    assert!(r.score.is_some());
    assert_eq!(seen.last().copied(), r.score);
    for w in seen.windows(2) {
        assert!(w[1] < w[0]);
    }
    // the wall deadline
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    let job = FreshJob { id, seed: 2, cpu_seconds: 100.0, deadline: Instant::now() + Duration::from_millis(500), stop: &stop, start: None, max_evals: None };
    let r = fresh_search(&job, &mut |_, _| {}).unwrap();
    let wall = t0.elapsed().as_secs_f64();
    assert!(wall < 0.5 + 0.25, "deadline: returned after {wall} s");
    assert_eq!(r.stopped, "deadline");
    assert!(r.score.is_some());
}

/// A valid start is the first best: the result is never worse, also when the budget is tiny.
#[test]
fn a_valid_start_is_never_returned_worse() {
    let id = "surface/icosahedron/fold/3/20";
    let first = run(id, 3, 15_000).best.unwrap();
    for (seed, evals) in [(4u64, 1u64), (5, 3_000), (6, 30_000)] {
        let stop = AtomicBool::new(false);
        let job = FreshJob { id, seed, cpu_seconds: 100.0, deadline: Instant::now() + Duration::from_secs(100), stop: &stop, start: Some(&first.config), max_evals: Some(evals) };
        let r = fresh_search(&job, &mut |_, _| {}).unwrap();
        let s = r.score.unwrap();
        assert!(s <= first.score, "start {} returned worse {s}", first.score);
        assert_eq!(check(id, r.config.as_ref().unwrap()), Some(s));
    }
}
