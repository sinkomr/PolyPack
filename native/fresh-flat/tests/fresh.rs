//! The client's entry point: the stop flag and the wall deadline end a long run at once, and what it
//! returns passes the client's check; ids it does not search are refused.

use polypack_flat::shapes::{Config, Pose, Problem};
use polypack_flat::validate::server_check;
use polypack_fresh_flat::fresh::fresh_search;
use polypack_spaceauto::FreshJob;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn config_of(c: &Value) -> Config {
    let n = c["N"].as_u64().unwrap() as u32;
    let m = c["M"].as_u64().unwrap() as u32;
    let p = c["P"].as_u64().unwrap() as usize;
    let pieces = c["pieces"].as_array().unwrap().iter().map(|q| Pose::new(q["x"].as_f64().unwrap(), q["y"].as_f64().unwrap(), q["theta"].as_f64().unwrap())).collect();
    Config::new(Problem::new(n, m, p), pieces, c["container_phi"].as_f64().unwrap())
}

fn job<'a>(id: &'a str, stop: &'a AtomicBool, cpu_seconds: f64, wall: Duration) -> FreshJob<'a> {
    FreshJob { id, seed: 3, cpu_seconds, deadline: Instant::now() + wall, stop, start: None, max_evals: None }
}

#[test]
fn the_stop_flag_ends_a_long_run_within_a_third_of_a_second() {
    let stop = AtomicBool::new(false);
    let id = "flat/4/6/12";
    let j = job(id, &stop, 120.0, Duration::from_secs(300));
    let mut improvements: Vec<f64> = Vec::new();
    let (res, late) = std::thread::scope(|sc| {
        sc.spawn(|| {
            std::thread::sleep(Duration::from_millis(1500));
            stop.store(true, Ordering::Relaxed);
        });
        let t = Instant::now();
        let res = fresh_search(&j, &mut |s, c| {
            assert!(c["pieces"].is_array());
            improvements.push(s);
        })
        .unwrap();
        (res, t.elapsed().as_secs_f64() - 1.5)
    });
    assert!(late < 0.3, "ended {late} s after the stop flag");
    assert_eq!(res.stopped, "stop");
    assert!(!improvements.is_empty() && improvements.windows(2).all(|w| w[1] < w[0]));
    let chk = server_check(&config_of(res.config.as_ref().expect("a packing")), 12);
    assert!(chk.valid && chk.strict);
    assert_eq!(chk.score, res.score);
    assert_eq!(res.score, improvements.last().copied());
}

#[test]
fn the_wall_deadline_ends_a_run_and_ids_are_checked() {
    let stop = AtomicBool::new(false);
    let t = Instant::now();
    let res = fresh_search(&job("flat/0/4/9", &stop, 120.0, Duration::from_millis(800)), &mut |_, _| {}).unwrap();
    assert!(t.elapsed().as_secs_f64() < 1.1, "{:?}", t.elapsed());
    assert_eq!(res.stopped, "deadline");
    assert!(res.config.is_some());
    // every N and M up to 100 is searched: many-sided pieces in a many-sided container
    for (id, p) in [("flat/100/97/9", 9), ("flat/37/0/20", 20), ("flat/3/100/30", 30)] {
        assert!(polypack_fresh_flat::fresh::handles(id));
        let t = Instant::now();
        let res = fresh_search(&job(id, &stop, 120.0, Duration::from_millis(800)), &mut |_, _| {}).unwrap();
        assert!(t.elapsed().as_secs_f64() < 1.1, "{id}: {:?}", t.elapsed());
        assert_eq!(res.stopped, "deadline");
        let chk = server_check(&config_of(res.config.as_ref().expect("a packing")), p);
        assert!(chk.valid && chk.strict, "{id}");
        assert_eq!(chk.score, res.score);
    }
    for id in ["flat/101/4/9", "flat/4/101/9", "flat/2/4/9", "flat/4/2/9", "flat/0/4/1", "flat/0/4/501", "flat/4/6", "sphere/0/9", "flat/1/4/9"] {
        assert!(fresh_search(&job(id, &stop, 1.0, Duration::from_secs(5)), &mut |_, _| {}).is_err(), "{id}");
    }
}
