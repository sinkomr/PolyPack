//! polypack-native: the native PolyPack volunteer client for flat problems.
//!
//!   polypack-native [options]       the volunteer client (see --help)
//!   polypack-native bench [...]     one problem's search without a server, as JSON

mod answers;
mod engine;
mod format;
mod http;
mod memory;
mod options;
mod pick;
mod platform;
#[cfg_attr(not(feature = "real-search"), allow(dead_code))]
mod real_search;
mod space_api;
mod space_engine;
mod space_search;
mod state;
mod target;
mod volunteer;

use engine::{search, InlineRunner, Runner, SearchInput, ThreadRunner};
use memory::Memory;
use options::{help_text, parse_options, Machine, Parsed};
use polypack_flat::clock::{thread_cpu_seconds, ClockKind};
use polypack_flat::shapes::{area_lower_bound, Problem};
use polypack_flat::validate::server_check;
use polypack_flat::Control;
use serde_json::json;
use std::time::Instant;

fn machine() -> Machine {
    Machine { available_parallelism: platform::available_parallelism(), home: platform::home_dir() }
}

/// `bench --N n --M m --P p [--seconds S] [--seed K] [--lanes L] [--clock cpu|wall] [--memory FILE]`:
/// the engine on one problem from scratch, as the volunteer client runs it, without a server.
/// With one lane and the CPU clock the jobs run on the calling thread, whose CPU time is the
/// engine's clock (a fair measure on a loaded machine).
fn bench(args: &[String]) -> i32 {
    let mut n = None;
    let mut m = None;
    let mut p = None;
    let mut seconds = 60.0;
    let mut seed = 1u32;
    let mut lanes = 1usize;
    let mut cpu = true;
    let mut i = 0;
    while i < args.len() {
        let v = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--N" => n = v.parse::<u32>().ok(),
            "--M" => m = v.parse::<u32>().ok(),
            "--P" => p = v.parse::<usize>().ok(),
            "--seconds" => seconds = v.parse().unwrap_or(60.0),
            "--seed" => seed = v.parse().unwrap_or(1),
            "--lanes" => lanes = v.parse().unwrap_or(1),
            "--clock" => cpu = v == "cpu",
            other => {
                eprintln!("bench: unknown option {other}");
                return 2;
            }
        }
        i += 2;
    }
    let (Some(n), Some(m), Some(p)) = (n, m, p) else {
        eprintln!("bench needs --N, --M and --P");
        return 2;
    };
    let problem = Problem::new(n, m, p);
    let control = Control::new();
    let clock_kind = if cpu && lanes == 1 { ClockKind::ThreadCpu } else { ClockKind::Wall };
    let wall0 = Instant::now();
    let cpu0 = thread_cpu_seconds();
    let now = move || match clock_kind {
        ClockKind::ThreadCpu => thread_cpu_seconds() - cpu0,
        ClockKind::Wall => wall0.elapsed().as_secs_f64(),
    };
    let mut trace: Vec<serde_json::Value> = Vec::new();
    let mut on_result = |r: &engine::JobResult, best: Option<&engine::Candidate>| {
        trace.push(json!({
            "t": now(),
            "method": r.job.method.name(),
            "kind": r.job.kind,
            "time_s": r.job.time_s,
            "evaluations": r.evaluations,
            "score": r.score,
            "strict": r.strict,
            "best": best.map(|b| b.score),
        }));
    };
    let memory_now = || Memory::empty();
    let mut inline;
    let mut threaded;
    let runner: &mut dyn Runner = if lanes == 1 {
        inline = InlineRunner::new(control.clone(), clock_kind);
        &mut inline
    } else {
        threaded = ThreadRunner::new(control.clone(), clock_kind, false);
        &mut threaded
    };
    let outcome = search(
        SearchInput {
            problem,
            known: None,
            area_bound: area_lower_bound(n, m, p),
            max_seconds: seconds,
            lanes,
            seed,
            memory: Memory::empty(),
            now: &now,
            control: control.clone(),
            on_result: &mut on_result,
            memory_now: &memory_now,
        },
        runner,
    );
    let engine_seconds = now();
    let check = outcome.best.as_ref().map(|b| server_check(&b.config, p));
    println!(
        "{}",
        json!({
            "N": n, "M": m, "P": p, "seed": seed, "seconds": seconds, "lanes": lanes,
            "clock": if clock_kind == ClockKind::ThreadCpu { "cpu" } else { "wall" },
            "score": outcome.best.as_ref().map(|b| b.score),
            "method": outcome.best.as_ref().map(|b| b.job.method.name()),
            "jobs": outcome.jobs,
            "evaluations": outcome.evaluations,
            "engine_seconds": engine_seconds,
            "wall_seconds": wall0.elapsed().as_secs_f64(),
            "evaluations_per_second": outcome.evaluations as f64 / engine_seconds.max(1e-9),
            "stopped": outcome.stopped.as_str(),
            "check_valid": check.as_ref().map(|c| c.valid),
            "check_strict": check.as_ref().map(|c| c.strict),
            "config": outcome.best.as_ref().map(|b| json!({
                "N": n, "M": m, "P": p, "container_phi": b.config.phi,
                "pieces": b.config.pieces.iter().map(|q| json!({ "x": q.x, "y": q.y, "theta": q.theta })).collect::<Vec<_>>(),
            })),
            "trace": trace,
        })
    );
    0
}

/// CPU seconds of the whole process (all its threads). A space's jobs run on threads of their own, so the
/// calling thread's clock would not see them.
fn process_cpu_seconds() -> f64 {
    #[cfg(unix)]
    {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: clock_gettime writes one timespec into the pointer given.
        if unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut ts) } == 0 {
            return ts.tv_sec as f64 + ts.tv_nsec as f64 * 1e-9;
        }
    }
    thread_cpu_seconds()
}

/// `bench-space --id ID [--seconds S] [--seed K]`: one problem of a space from scratch with the client's own
/// engine (one lane, no known packing, the default rule: no bound, not certified, no record), without a server.
/// Prints the benchmark contract (native/FRESH.md). Its clock is the process's CPU time; the jobs' own
/// deadlines are wall-clock, as in the client.
fn bench_space(args: &[String]) -> i32 {
    let mut id = None;
    let mut seconds = 60.0;
    let mut seed = 1u32;
    let mut i = 0;
    while i < args.len() {
        let v = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--id" => id = Some(v),
            "--seconds" => seconds = v.parse().unwrap_or(60.0),
            "--seed" => seed = v.parse().unwrap_or(1),
            other => {
                eprintln!("bench-space: unknown option {other}");
                return 2;
            }
        }
        i += 2;
    }
    let Some(id) = id else {
        eprintln!("bench-space needs --id");
        return 2;
    };
    let space_name = match id.split('/').next().and_then(|s| polypack_spaces::SpaceName::parse(s)) {
        Some(s) => s,
        None => {
            eprintln!("bench-space: {id} is not a space problem id");
            return 2;
        }
    };
    let space = space_name.as_str();
    let searcher = match real_search::searcher() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("bench-space: {e}");
            return 2;
        }
    };
    let rule = space_api::Rule::default();
    let check = |c: &serde_json::Value, claimed: f64| space_api::check_job_result(space_name, &id, c, claimed, &rule);
    let cpu0 = process_cpu_seconds();
    let now = move || process_cpu_seconds() - cpu0;
    let control = Control::new();
    let input = space_engine::SpaceSearchInput { space, id: &id, known: None, bound: None, max_seconds: seconds, lanes: 1, seed, now: &now, check: &check, low_priority: false };
    let mut trace: Vec<serde_json::Value> = Vec::new();
    let mut last = f64::INFINITY;
    let wall0 = Instant::now();
    let outcome = space_engine::search_space_problem(&input, searcher.as_ref(), &control, &mut |_r, best| {
        if let Some(b) = best {
            if b.score < last {
                last = b.score;
                trace.push(json!({ "t": now(), "best": b.score }));
            }
        }
    });
    let engine_seconds = now();
    let verdict = outcome.best.as_ref().map(|b| space_api::check_space_config(space_name, &id, &b.config, &rule));
    println!(
        "{}",
        json!({
            "solver": "port", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
            "score": outcome.best.as_ref().map(|b| b.score),
            "config": outcome.best.as_ref().map(|b| b.config.clone()),
            "evaluations": outcome.evaluations,
            "check_valid": verdict.as_ref().map(|v| v.valid),
            "trace": trace,
            "jobs": outcome.jobs, "stopped": outcome.stopped,
            "engine_seconds": engine_seconds, "wall_seconds": wall0.elapsed().as_secs_f64(),
        })
    );
    0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(|a| a.as_str()) == Some("bench") {
        std::process::exit(bench(&args[1..]));
    }
    if args.first().map(|a| a.as_str()) == Some("bench-space") {
        std::process::exit(bench_space(&args[1..]));
    }
    let own_window = platform::console_is_own();
    if own_window && args.is_empty() {
        println!(
            "polypack-native runs in a window of its own. Without --name it searches but submits nothing.\n\
             To search under your name, start it from PowerShell instead: see https://polypack.fly.dev/volunteer.html (Windows).\n"
        );
    }
    let m = machine();
    let code = match parse_options(&args, &m) {
        Err(e) => {
            eprintln!("polypack-native: {}\nRun it with --help to see the options.", e.0);
            2
        }
        Ok(Parsed::Help) => {
            print!("{}", help_text(&m));
            0
        }
        Ok(Parsed::Version) => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            0
        }
        Ok(Parsed::Run(o)) => volunteer::run(o),
    };
    if own_window {
        // Windows closes a window it opened for the client as soon as the client ends: keep it open to be read
        println!("\nPress Enter to close this window.");
        let _ = std::io::stdin().read_line(&mut String::new());
    }
    std::process::exit(code);
}
