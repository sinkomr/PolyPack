//! The job API: reproducibility, the stop flag, starts, failures, and results that pass the rule.

use polypack_curved::{
    check_config, run_job, run_job_with, Budget, CurvedConfig, CurvedProblem, JobOptions, Rule, Termination,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const RECORD: &str = r#"{"size":1.724148891504105,"pieces":[{"x":-0.7764145291718095,"y":0.20772581604160836,"theta":4.047426214757005},{"x":-0.12530104877408077,"y":-0.7641082721281892,"theta":4.2739477331451985},{"x":0.021891400877602482,"y":0.08532157903034833,"theta":5.388675298255929},{"x":0.5271992300058851,"y":0.6970724278560901,"theta":1.8580819400292397},{"x":-0.6379610101608442,"y":-0.4106429096829371,"theta":3.116667750028599},{"x":-0.35373428202129004,"y":0.7902172734176479,"theta":2.8532304916627695},{"x":0.5395044165320629,"y":-0.6599031140743641,"theta":5.440226162341727},{"x":0.5156797295581319,"y":-0.09825721152765993,"theta":0.17524711387801004}]}"#;

fn evals(n: u64) -> Budget {
    Budget {
        evals: Some(n),
        cpu_seconds: None,
    }
}

#[test]
fn the_same_seed_and_evaluation_budget_give_the_same_result() {
    let stop = AtomicBool::new(false);
    for id in ["curved/-1/3/6/8", "curved/0.5/0/0/7", "curved/-0.1/4/5/6"] {
        let p = CurvedProblem::parse(id).unwrap();
        let a = run_job(&p, None, evals(12), 7, &stop);
        let b = run_job(&p, None, evals(12), 7, &stop);
        assert_eq!(a.termination, Termination::Evals, "{id}");
        assert_eq!(a.evaluations, 12);
        assert_eq!(a.config, b.config, "{id}");
        assert!(a.config.is_some(), "{id}: no result");
        assert_eq!(a.score.map(f64::to_bits), b.score.map(f64::to_bits));
        // the same seed above 2^32 is folded, not truncated
        let c = run_job(&p, None, evals(12), 7 + (1u64 << 32), &stop);
        assert_eq!(c.evaluations, 12);
    }
}

#[test]
fn results_pass_the_strict_rule() {
    let stop = AtomicBool::new(false);
    for id in [
        "curved/1/3/3/6",
        "curved/-1/0/0/9",
        "curved/0.01/4/0/7",
        "curved/-0.25/6/8/3",
    ] {
        let p = CurvedProblem::parse(id).unwrap();
        let rule = Rule {
            bound: p.lower_bound(),
            certified: None,
            no_record: true,
        };
        let opts = JobOptions {
            rule,
            ..JobOptions::default()
        };
        let out = run_job_with(&p, None, evals(10), 3, &stop, &opts);
        let c = out.config.unwrap_or_else(|| panic!("{id}: {:?}", out.reasons));
        assert!(check_config(&p, &c, &rule).valid, "{id}");
        assert_eq!(out.score, Some(c.size));
    }
}

#[test]
fn a_valid_start_is_never_lost() {
    let stop = AtomicBool::new(false);
    let p = CurvedProblem::parse("curved/-1/3/6/8").unwrap();
    let start: CurvedConfig = serde_json::from_str(RECORD).unwrap();
    let out = run_job(&p, Some(&start), evals(1), 1, &stop);
    assert!(out.score.unwrap() <= start.size);
    // a start shrunk below its feasible size is repaired by the search, not returned
    let mut small = start.clone();
    small.size *= 0.99;
    let out = run_job(&p, Some(&small), evals(3), 1, &stop);
    let c = out.config.unwrap();
    assert!(check_config(&p, &c, &Rule::default()).valid);
}

#[test]
fn malformed_starts_and_impossible_problems_are_errors() {
    let stop = AtomicBool::new(false);
    let p = CurvedProblem::parse("curved/-1/3/6/8").unwrap();
    let mut start: CurvedConfig = serde_json::from_str(RECORD).unwrap();
    start.pieces.pop();
    let out = run_job(&p, Some(&start), evals(3), 1, &stop);
    assert_eq!(out.termination, Termination::Error);
    assert!(out.config.is_none());
    // no unit heptagon exists at K = 1; 13 unit triangles do not fit in the open hemisphere
    for id in ["curved/1/7/3/1", "curved/1/3/3/13"] {
        let out = run_job(&CurvedProblem::parse(id).unwrap(), None, evals(3), 1, &stop);
        assert_eq!(out.termination, Termination::Error, "{id}");
    }
}

#[test]
fn the_stop_flag_ends_a_job() {
    let p = CurvedProblem::parse("curved/0.01/3/3/60").unwrap();
    let set = AtomicBool::new(true);
    let out = run_job(&p, None, Budget::default(), 1, &set);
    assert_eq!(out.termination, Termination::Aborted);
    assert_eq!(out.evaluations, 0);
    // set from another thread while the job works, with no budget at all
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        s2.store(true, Ordering::Relaxed);
    });
    let t0 = Instant::now();
    let out = run_job(&p, None, Budget::default(), 1, &stop);
    t.join().unwrap();
    assert_eq!(out.termination, Termination::Aborted);
    assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
}

#[test]
fn the_time_budget_ends_a_job() {
    let stop = AtomicBool::new(false);
    let p = CurvedProblem::parse("curved/0.01/3/3/60").unwrap();
    let out = run_job(
        &p,
        None,
        Budget {
            evals: None,
            cpu_seconds: Some(0.5),
        },
        1,
        &stop,
    );
    assert_eq!(out.termination, Termination::Time);
    assert!(out.seconds >= 0.5 && out.seconds < 3.0, "{}", out.seconds);
}

#[test]
fn a_paused_job_waits() {
    let p = CurvedProblem::parse("curved/-1/3/6/8").unwrap();
    let stop = AtomicBool::new(false);
    let paused = Arc::new(AtomicBool::new(true));
    let p2 = paused.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        p2.store(false, Ordering::Relaxed);
    });
    let t0 = Instant::now();
    let opts = JobOptions {
        paused: Some(&paused),
        ..JobOptions::default()
    };
    let out = run_job_with(&p, None, evals(2), 1, &stop, &opts);
    t.join().unwrap();
    assert!(t0.elapsed() >= Duration::from_millis(400));
    assert_eq!(out.termination, Termination::Evals);
}
