//! The client's entry point: the stop flag and the wall deadline end a long run at once, and what it
//! returns passes the check; ids it does not search are refused.

use fresh_balls::check;
use fresh_balls::fresh::fresh_search;
use polypack_spaceauto::FreshJob;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn job<'a>(id: &'a str, stop: &'a AtomicBool, cpu_seconds: f64, wall: Duration) -> FreshJob<'a> {
    FreshJob { id, seed: 5, cpu_seconds, deadline: Instant::now() + wall, stop, start: None, max_evals: None }
}

#[test]
fn the_stop_flag_ends_a_long_run_within_a_third_of_a_second() {
    for id in ["balls/ballinball/40", "balls/ballincub/25"] {
        let stop = AtomicBool::new(false);
        let j = job(id, &stop, 120.0, Duration::from_secs(300));
        let mut improvements: Vec<f64> = Vec::new();
        let (res, late) = std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(1500));
                stop.store(true, Ordering::Relaxed);
            });
            let t = Instant::now();
            let res = fresh_search(&j, &mut |s, _| improvements.push(s)).unwrap();
            (res, t.elapsed().as_secs_f64() - 1.5)
        });
        assert!(late < 0.3, "{id}: ended {late} s after the stop flag");
        assert_eq!(res.stopped, "stop", "{id}");
        assert!(!improvements.is_empty() && improvements.windows(2).all(|w| w[1] < w[0]), "{id}");
        assert_eq!(check(id, res.config.as_ref().expect("a packing")), res.score, "{id}");
        assert_eq!(res.score, improvements.last().copied());
    }
}

#[test]
fn the_wall_deadline_ends_a_run_and_ids_are_checked() {
    let stop = AtomicBool::new(false);
    let t = Instant::now();
    let res = fresh_search(&job("balls/ballinball/20", &stop, 120.0, Duration::from_millis(800)), &mut |_, _| {}).unwrap();
    assert!(t.elapsed().as_secs_f64() < 1.1, "{:?}", t.elapsed());
    assert_eq!(res.stopped, "deadline");
    assert!(res.config.is_some());
    for id in ["balls/cubinball/9", "balls/ballinball/1", "polyhedra/cubintet/5", "balls/nosuchcode/5", "flat/0/0/5"] {
        assert!(fresh_search(&job(id, &stop, 1.0, Duration::from_secs(5)), &mut |_, _| {}).is_err(), "{id}");
    }
}
