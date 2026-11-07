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
mod state;
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
            "trace": trace,
        })
    );
    0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(|a| a.as_str()) == Some("bench") {
        std::process::exit(bench(&args[1..]));
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
    std::process::exit(code);
}
