//! The personal 2D-on-3D sweep (--sweep-2d-on-3d): the client's main loop for the surface, sphere
//! and torus problems, taken in the order of sweep_order.rs instead of at random. For each problem:
//! read it (GET /api/spaces/:space/problems/<id>), skip it when it is closed, unknown, or led by
//! the user's name (unless --include-own), search it with its share of the threads (space_engine.rs,
//! a port of the TypeScript engine's policy), validate the best with the server's own validator,
//! read the leader again, decide as the TypeScript client does (space_api.rs) and submit to
//! POST /api/spaces/submit with the client's submit key, pacing and retries.

use crate::answers::{clean_text, describe_answer, stored_name};
use crate::format::{format_duration, format_score, iso_now, relative_percent};
use crate::http::{read_submit_key, sleep_unless, Answer, Api, Pacer, SubmitCheck, SubmitOutcome, KEYED_SUBMISSIONS_PER_MINUTE, SUBMISSIONS_PER_MINUTE, SUBMISSION_WINDOW_MS};
use crate::options::{Options, SweepOptions};
use crate::space_api::{
    best_ref, build_known, check_job_result, check_space_config, check_space_stored, decide_space_submission, read_space_problem, read_space_submit_response, space_submission_body,
    BestRef, DecideArgs, Rule, SpaceProblemInfo,
};
use crate::space_engine::{search_space_problem, Candidate, SpaceControl, SpaceSearchInput, SpaceSearcher};
use crate::state::{random_u32, StateDir};
use crate::sweep_order::{Dispenser, Next, Order, Taken};
use crate::volunteer::{lane_shares, log, ActiveClock, MIN_PROBLEM_SECONDS, NOTHING_WAIT_MS, SOFTWARE, STOP_GRACE_MS, UNITS};
use polypack_flat::validate::improves_on;
use polypack_spaces::parse_space_id;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Tries at reading one problem (each already retried by the API layer) before it is passed over.
const UNREACHABLE_TRIES: u32 = 3;

struct Current {
    label: String,
    lanes: usize,
    control: Arc<SpaceControl>,
    started_at: f64,
    max_seconds: f64,
    jobs: AtomicUsize,
    best: Mutex<Option<f64>>,
    leader: Mutex<Option<f64>>,
}

enum Searched {
    /// Searched; false when it was cut short (stop), so that a restart does it again.
    Done(bool),
    /// Closed, unknown, unreadable or led by the user: handled without a search.
    Skipped,
    Unreachable,
}

pub struct Shared {
    o: Options,
    sw: SweepOptions,
    searcher: Arc<dyn SpaceSearcher>,
    clock: ActiveClock,
    stop: Arc<AtomicBool>,
    hard: Arc<AtomicBool>,
    paused: AtomicBool,
    stop_reason: Mutex<Option<String>>,
    upgrade: Mutex<Option<String>>,
    reader: Api,
    submitter: Api,
    state: Mutex<StateDir>,
    dispenser: Dispenser,
    currents: Mutex<Vec<Arc<Current>>>,
    /// problems searched, submissions sent, accepted, took the lead
    counts: Mutex<[usize; 4]>,
    skipped: AtomicUsize,
    started: Instant,
}

impl Shared {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn request_stop(&self, why: &str) {
        let mut reason = self.stop_reason.lock().unwrap();
        if reason.is_some() {
            return;
        }
        *reason = Some(why.to_string());
        drop(reason);
        let n = self.currents.lock().unwrap().len();
        log(&format!(
            "{why}: stopping. {}Exiting within {} s; a second Ctrl-C exits at once.",
            if n > 1 {
                "The searches are aborted; each one's best is submitted if it beats the leader. "
            } else if n == 1 {
                "The search is aborted; its best is submitted if it beats the leader. "
            } else {
                ""
            },
            STOP_GRACE_MS / 1000
        ));
        self.stop.store(true, Ordering::Relaxed);
        for c in self.currents.lock().unwrap().iter() {
            c.control.aborted.store(true, Ordering::Relaxed);
        }
        let hard = self.hard.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(STOP_GRACE_MS));
            hard.store(true, Ordering::Relaxed);
        });
    }

    fn set_paused(&self, paused: bool) {
        if self.paused.swap(paused, Ordering::Relaxed) == paused {
            return;
        }
        if paused {
            self.clock.pause();
        } else {
            self.clock.resume();
        }
        for c in self.currents.lock().unwrap().iter() {
            c.control.paused.store(paused, Ordering::Relaxed);
        }
    }

    fn deadline_left(&self) -> f64 {
        if !self.o.hours.is_finite() {
            return f64::INFINITY;
        }
        self.o.hours * 3600.0 - self.started.elapsed().as_secs_f64()
    }

    fn check_deadline(&self, starting: bool) -> bool {
        if !self.o.hours.is_finite() || self.stop_reason.lock().unwrap().is_some() {
            return self.stop_reason.lock().unwrap().is_some();
        }
        let left = self.deadline_left();
        if left <= 0.0 {
            self.request_stop(&format!("The --hours limit ({} h) is reached", self.o.hours));
            return true;
        }
        let least = MIN_PROBLEM_SECONDS.min(self.o.minutes_per_problem * 60.0);
        if starting && left < least {
            self.request_stop(&format!("Only {} of the --hours limit ({} h) is left, too little for another problem", format_duration(left), self.o.hours));
            return true;
        }
        false
    }

    fn max_seconds(&self) -> f64 {
        let mut s = (self.o.minutes_per_problem * 60.0).max(1.0);
        if self.o.hours.is_finite() {
            s = s.min(self.deadline_left().max(1.0));
        }
        s
    }

    fn sub(&self, label: &str) -> String {
        if self.o.parallel_problems > 1 {
            format!("  {label}: ")
        } else {
            "  ".into()
        }
    }

    fn read_problem(&self, api: &Api, id: &str, space: &str) -> (Option<SpaceProblemInfo>, Option<Answer>) {
        let a = api.space_problem(space, id);
        let info = a.as_ref().filter(|a| a.status == 200).and_then(|a| {
            let parsed = parse_space_id(parse_space(space)?, id).ok()?;
            read_space_problem(&a.body, &parsed)
        });
        (info, a)
    }
}

fn parse_space(space: &str) -> Option<polypack_spaces::SpaceName> {
    polypack_spaces::SpaceName::parse(space)
}

#[cfg(feature = "real-search")]
fn real_searcher() -> Result<Arc<dyn SpaceSearcher>, String> {
    Ok(Arc::new(crate::real_search::RealSearcher))
}

#[cfg(not(feature = "real-search"))]
fn real_searcher() -> Result<Arc<dyn SpaceSearcher>, String> {
    Err("--sweep-2d-on-3d needs the 2D-on-3D searches (surface, sphere, torus), which this build does not include.\nBuild the client with them: cargo build --release -p polypack-native --features real-search".into())
}

/// The sweep with the real searches; 2 and a message when the build has none.
pub fn run(o: Options) -> i32 {
    match real_searcher() {
        Ok(searcher) => run_with(o, searcher, true),
        Err(why) => {
            eprintln!("polypack-native: {why}");
            2
        }
    }
}

/// The sweep with any searcher (the tests', a fake one); `signals` installs the Ctrl-C handler.
pub fn run_with(o: Options, searcher: Arc<dyn SpaceSearcher>, signals: bool) -> i32 {
    let Some(sw) = o.sweep.clone() else {
        log("Internal error: the sweep has no options");
        return 1;
    };
    let order = Order::new(&sw, o.n.as_ref(), o.p.as_ref());
    if order.is_empty() {
        log("No 2D-on-3D problem passes --kinds, --solids, --surface-modes, --N, --P, --max-P and --max-N together: there is nothing to search.");
        return 1;
    }
    let submit_key = match &o.key_file {
        Some(path) => match read_submit_key(path) {
            Ok(k) => Some(k),
            Err(e) => {
                log(&format!("Cannot use --key-file: {e}"));
                return 1;
            }
        },
        None => None,
    };
    let state = match StateDir::open(&o.state_dir) {
        Ok(s) => s,
        Err(crate::state::OpenError::LockHeld(path, holder)) => {
            log(&format!(
                "Another copy of the client is using {} ({holder}). Stop it first, or give this one its own --state directory. If no other copy is running, delete {}.",
                o.state_dir.display(),
                path.display()
            ));
            return 1;
        }
        Err(crate::state::OpenError::Io(e)) => {
            log(&format!("Cannot use the state directory {}: {e}", o.state_dir.display()));
            return 1;
        }
    };
    let stop = Arc::new(AtomicBool::new(false));
    let hard = Arc::new(AtomicBool::new(false));
    let per_minute = if submit_key.is_some() { KEYED_SUBMISSIONS_PER_MINUTE } else { SUBMISSIONS_PER_MINUTE };
    let pacer = Arc::new(Mutex::new(Pacer::new(per_minute, SUBMISSION_WINDOW_MS)));
    let user_agent = format!("polypack-native/{} ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
    let cell: Arc<Mutex<Option<std::sync::Weak<Shared>>>> = Arc::new(Mutex::new(None));
    let c1 = cell.clone();
    let on_upgrade: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |message: &str| {
        if let Some(s) = c1.lock().unwrap().as_ref().and_then(|w| w.upgrade()) {
            *s.upgrade.lock().unwrap() = Some(message.to_string());
            s.request_stop("The server answered 426 (upgrade required)");
        }
    });
    let c2 = cell.clone();
    let on_key_refused: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |said: &str| {
        if let Some(s) = c2.lock().unwrap().as_ref().and_then(|w| w.upgrade()) {
            s.request_stop(&format!("The server refused the submit key (401: {said}); check the file given with --key-file"));
        }
    });
    let logger: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|m: &str| log(m));
    let reader = Api::new(&o.base, &user_agent, stop.clone(), pacer.clone(), logger.clone(), on_upgrade.clone());
    let submitter = Api::new(&o.base, &user_agent, hard.clone(), pacer, logger.clone(), on_upgrade).with_submit_key(submit_key, on_key_refused);
    let dispenser = Dispenser::open(order, Some(&o.state_dir), sw.restart, logger).with_one_pass(sw.one_pass);
    let shared = Arc::new(Shared {
        searcher,
        clock: ActiveClock::new(),
        stop,
        hard,
        paused: AtomicBool::new(false),
        stop_reason: Mutex::new(None),
        upgrade: Mutex::new(None),
        reader,
        submitter,
        state: Mutex::new(state),
        dispenser,
        currents: Mutex::new(Vec::new()),
        counts: Mutex::new([0; 4]),
        skipped: AtomicUsize::new(0),
        started: Instant::now(),
        sw,
        o,
    });
    *cell.lock().unwrap() = Some(Arc::downgrade(&shared));
    banner(&shared);
    if signals {
        let s = shared.clone();
        let _ = ctrlc::set_handler(move || {
            if s.stop_reason.lock().unwrap().is_some() {
                println!("Interrupted again: exiting at once");
                s.state.lock().unwrap().close();
                std::process::exit(130);
            }
            s.request_stop("Interrupted");
        });
    }
    let done = Arc::new(AtomicBool::new(false));
    if shared.o.battery_pause && signals {
        let s = shared.clone();
        let d = done.clone();
        std::thread::spawn(move || {
            while !d.load(Ordering::Relaxed) {
                let battery = crate::platform::on_battery();
                if battery != s.paused.load(Ordering::Relaxed) {
                    s.set_paused(battery);
                    log(if battery {
                        "On battery power: paused. The search resumes on AC power (--no-battery-pause keeps it running)."
                    } else {
                        "On AC power: resuming."
                    });
                }
                for _ in 0..300 {
                    if d.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        });
    }
    {
        let s = shared.clone();
        let d = done.clone();
        std::thread::spawn(move || {
            let mut ticks = 0u64;
            while !d.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(1000));
                ticks += 1;
                if ticks % 10 == 0 {
                    s.check_deadline(false);
                }
                if ticks % 60 == 0 {
                    status(&s);
                }
            }
        });
    }
    let shares = lane_shares(shared.o.cores, shared.o.parallel_problems);
    let handles: Vec<_> = shares
        .into_iter()
        .map(|lanes| {
            let s = shared.clone();
            std::thread::spawn(move || slot(&s, lanes))
        })
        .collect();
    let codes: Vec<i32> = handles.into_iter().map(|h| h.join().unwrap_or(1)).collect();
    let code = i32::from(codes.iter().any(|&c| c != 0));
    done.store(true, Ordering::Relaxed);
    if let Some(up) = shared.upgrade.lock().unwrap().clone() {
        log(&format!("This client ({}) is out of date: {up} Download the current client and start it again.", env!("CARGO_PKG_VERSION")));
    }
    let c = *shared.counts.lock().unwrap();
    let (pass, k) = shared.dispenser.position();
    log(&format!(
        "Stopped after {}: {} problem(s) searched, {} skipped, {} submission(s) sent, {} accepted, {} took the lead. At loop {k} of pass {pass}; state is in {}.",
        format_duration(shared.started.elapsed().as_secs_f64()),
        c[0],
        shared.skipped.load(Ordering::Relaxed),
        c[1],
        c[2],
        c[3],
        shared.o.state_dir.display()
    ));
    shared.state.lock().unwrap().close();
    if shared.upgrade.lock().unwrap().is_some() {
        1
    } else {
        code
    }
}

fn banner(s: &Shared) {
    let o = &s.o;
    log(&format!(
        "polypack-native {} ({} {}): {} search thread(s) on {} core(s), {}{} priority",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        o.cores,
        crate::platform::available_parallelism(),
        if o.parallel_problems > 1 {
            format!("{} problems at once ({} threads), ", o.parallel_problems, lane_shares(o.cores, o.parallel_problems).iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "))
        } else {
            String::new()
        },
        if o.low_priority { "low" } else { "normal" }
    ));
    log(&format!(
        "Server {}; {}",
        o.base,
        if o.dry_run {
            if o.name.is_none() {
                "dry run: nothing is submitted, because no --name was given".to_string()
            } else {
                "dry run (--dry-run): nothing is submitted".to_string()
            }
        } else {
            format!(
                "submitting as \"{}\"{}; {}",
                o.name.as_deref().unwrap_or(""),
                if o.note.is_empty() { String::new() } else { format!(" with the note \"{}\"", o.note) },
                match &o.key_file {
                    Some(path) => format!("with the submit key from {}, at most {KEYED_SUBMISSIONS_PER_MINUTE} a minute", path.display()),
                    None => format!("at most {SUBMISSIONS_PER_MINUTE} a minute (the limit per address)"),
                }
            )
        }
    ));
    let (pass, k) = s.dispenser.position();
    log(&format!(
        "Sweep 2D on 3D: {}; loop {k} of {} (pass {pass}); up to {} per problem; {}",
        s.dispenser.order().describe(),
        s.dispenser.order().loops(),
        format_duration(o.minutes_per_problem * 60.0),
        if s.sw.include_own { "problems you lead are searched again (--include-own)" } else { "problems you already lead are skipped" }
    ));
}

fn status(s: &Shared) {
    let currents = s.currents.lock().unwrap().clone();
    let c = *s.counts.lock().unwrap();
    let paused = if s.paused.load(Ordering::Relaxed) { "; paused on battery power" } else { "" };
    for cur in &currents {
        let elapsed = s.clock.now() - cur.started_at;
        let best = cur.best.lock().unwrap().map_or("none yet".into(), format_score);
        let vs = match *cur.leader.lock().unwrap() {
            None => "no best".to_string(),
            Some(l) => format!("best {}{}", format_score(l), cur.best.lock().unwrap().map_or(String::new(), |b| format!(" ({})", relative_percent(b, l)))),
        };
        log(&format!(
            "Status: {}, {} of {}; best {best} vs {vs}; {} job(s) run, on {} thread(s)",
            cur.label,
            format_duration(elapsed),
            format_duration(cur.max_seconds),
            cur.jobs.load(Ordering::Relaxed),
            cur.lanes
        ));
    }
    let (pass, k) = s.dispenser.position();
    log(&format!("Status: loop {k} of pass {pass}; {} of {} problems being searched; {} submission(s) accepted{paused}", currents.len(), s.o.parallel_problems, c[2]));
}

/// One problem after another on `lanes` threads, until the client stops.
fn slot(s: &Arc<Shared>, lanes: usize) -> i32 {
    while !s.stopped() {
        while s.paused.load(Ordering::Relaxed) && !s.stopped() {
            std::thread::sleep(Duration::from_millis(500));
        }
        if s.stopped() || s.check_deadline(true) {
            break;
        }
        let t = match s.dispenser.take() {
            Next::Wait => {
                sleep_unless(&s.stop, 250);
                continue;
            }
            Next::Finished => {
                s.request_stop("The pass is complete (--one-pass)");
                break;
            }
            Next::Problem(t) => t,
        };
        let mut tries = 0;
        loop {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| search_one(s, &t, lanes)));
            let searched = outcome.unwrap_or_else(|_| {
                log(&format!("Passing over {} after an unexpected error", t.problem.id));
                Searched::Skipped
            });
            match searched {
                Searched::Unreachable => {
                    tries += 1;
                    if s.stopped() {
                        break;
                    }
                    if tries >= UNREACHABLE_TRIES {
                        log(&format!("Could not reach the server to read {} after {tries} tries: passing over it", t.problem.id));
                        s.dispenser.finish(&t, false);
                        break;
                    }
                    let ms = 60_000u64.min(2000 * 2u64.pow(tries + 1));
                    log(&format!("Could not reach the server to read a problem; trying again in {} s", ms / 1000));
                    sleep_unless(&s.stop, ms);
                    continue;
                }
                Searched::Skipped => {
                    s.skipped.fetch_add(1, Ordering::Relaxed);
                    s.dispenser.finish(&t, false);
                }
                Searched::Done(complete) => {
                    if complete {
                        s.dispenser.finish(&t, true);
                    }
                    if s.o.once {
                        return 0;
                    }
                }
            }
            break;
        }
    }
    0
}

fn best_json(c: &Candidate, id: &str, p: usize) -> Value {
    let mut budget = json!({ "time_s": c.time_s });
    if let Some(e) = c.evals {
        budget["evals"] = json!(e);
    }
    json!({
        "space": id.split('/').next().unwrap_or(""),
        "id": id,
        "P": p,
        "score": c.score,
        "method": c.method,
        "seed": c.seed,
        "budget": budget,
        "kind": c.kind,
        "found_at": iso_now(),
        "version": env!("CARGO_PKG_VERSION"),
        "software": SOFTWARE,
        "units": UNITS,
        "config": c.config,
    })
}

fn candidate_of_file(v: &Value) -> Option<Candidate> {
    let budget = v.get("budget");
    Some(Candidate {
        config: v.get("config")?.clone(),
        score: v.get("score")?.as_f64()?,
        seed: v.get("seed").and_then(Value::as_u64).unwrap_or(0) as u32,
        method: v.get("method").and_then(Value::as_str)?.to_string(),
        kind: if v.get("kind").and_then(Value::as_str) == Some("iterate") { "iterate" } else { "fresh" },
        time_s: budget.and_then(|b| b.get("time_s")).and_then(Value::as_f64).unwrap_or(1.0),
        evals: budget.and_then(|b| b.get("evals")).and_then(Value::as_u64),
    })
}

fn leader_ref(l: &Option<BestRef>) -> Value {
    l.as_ref().map_or(Value::Null, |l| json!({ "id": l.id, "score": l.score, "source": l.source, "name": l.name }))
}

/// Searches one problem and submits its best if it qualifies.
fn search_one(s: &Arc<Shared>, t: &Taken, lanes: usize) -> Searched {
    let id = t.problem.id.as_str();
    let space = t.problem.kind.name();
    let label = id.to_string();
    let Some(space_name) = parse_space(space) else { return Searched::Skipped };
    let Ok(parsed) = parse_space_id(space_name, id) else {
        log(&format!("{id} is not a problem id of the spaces: skipping it"));
        return Searched::Skipped;
    };
    let (info, answer) = s.read_problem(&s.reader, id, space);
    if s.stopped() {
        return Searched::Done(false);
    }
    let Some(info) = info else {
        if answer.as_ref().map_or(true, |a| a.status == 429 || a.status >= 500) {
            return Searched::Unreachable;
        }
        log(&format!(
            "Could not read {label} ({}); skipping it",
            if answer.as_ref().map_or(false, |a| a.status == 200) { "malformed answer".into() } else { describe_answer(answer.as_ref()) }
        ));
        return Searched::Skipped;
    };
    if !info.accepts_submissions {
        let why = info.closed_reason.clone().unwrap_or_else(|| {
            if info.certified.as_ref().map_or(false, |c| c.1 == "infeasible") {
                "no packing exists (proved)".into()
            } else {
                "its value is proven".into()
            }
        });
        log(&format!("{label} is closed: {why}. Skipping it."));
        return Searched::Skipped;
    }
    if s.sw.open_only {
        if let Some(best) = info.best_score {
            log(&format!("{label} already has a best ({}): skipping it (--open-only)", format_score(best)));
            return Searched::Skipped;
        }
    }
    let before = best_ref(&info);
    if let (Some(name), Some(l)) = (s.o.name.as_deref(), &info.site_best) {
        if !s.sw.include_own && stored_name(&l.name) == stored_name(name) {
            log(&format!("{label} is led by \"{}\" (entry #{}, {}): skipping it (--include-own searches it again)", clean_text(&l.name, 60), l.id, format_score(l.score)));
            return Searched::Skipped;
        }
    }
    let known = build_known(&info);
    let rule = Rule { bound: info.bound, certified: info.certified.as_ref().map(|c| c.0), no_record: info.no_record };
    let max_seconds = s.max_seconds();
    let engine_seed = random_u32();
    let control = Arc::new(SpaceControl::new());
    control.aborted.store(s.stopped(), Ordering::Relaxed);
    control.paused.store(s.paused.load(Ordering::Relaxed), Ordering::Relaxed);
    let cur = Arc::new(Current {
        label: label.clone(),
        lanes,
        control: control.clone(),
        started_at: s.clock.now(),
        max_seconds,
        jobs: AtomicUsize::new(0),
        best: Mutex::new(None),
        leader: Mutex::new(info.best_score),
    });
    s.currents.lock().unwrap().push(cur.clone());
    log(&format!(
        "Searching {label} (pass {}, loop {}, problem {} of {}): best {}, lower bound {}; starting from {}; up to {} on {lanes} thread(s)",
        t.pass,
        t.k,
        t.index + 1,
        t.size,
        before.as_ref().map_or("none".into(), |b| format!(
            "{} ({})",
            format_score(b.score),
            if b.source == "site" { format!("site entry by \"{}\"", clean_text(b.name.as_deref().unwrap_or(""), 60)) } else { "research record".into() }
        )),
        info.bound.map_or("none".into(), format_score),
        known.as_ref().map_or("nothing", |k| if k.source == "site" { "the site's leader" } else { "the research record" }),
        format_duration(max_seconds)
    ));
    let sub = s.sub(&label);
    let check = |c: &Value, claimed: f64| check_job_result(space_name, id, c, claimed, &rule);
    let now = || s.clock.now();
    let input = SpaceSearchInput { space, id, known: known.as_ref(), bound: info.bound, max_seconds, lanes, seed: engine_seed, now: &now, check: &check, low_priority: s.o.low_priority };
    let started_at = s.clock.now();
    let outcome = search_space_problem(&input, s.searcher.as_ref(), &control, &mut |r, best| {
        cur.jobs.fetch_add(1, Ordering::Relaxed);
        if !r.valid {
            if let Some(why) = r.reason.as_deref().filter(|_| r.failed || r.score.is_none()) {
                if r.crashed || r.failed {
                    log(&format!("{sub}a job failed: {}", clean_text(why, 200)));
                } else {
                    log(&format!("{sub}a job's result was not used: {}", clean_text(why, 200)));
                }
            }
        }
        if let Some(b) = best {
            let mut cb = cur.best.lock().unwrap();
            // improvements below 1e-9 relative are rounding: not worth a line
            if cb.map_or(true, |x| b.score < x * (1.0 - 1e-9)) {
                *cb = Some(b.score);
                let vs = cur.leader.lock().unwrap().map_or(String::new(), |l| format!(", {} against the best", relative_percent(b.score, l)));
                log(&format!("{sub}best so far {} ({}, {}, seed {}){vs}", format_score(b.score), b.method, b.kind, b.seed));
            }
        }
    });
    let active = s.clock.now() - started_at;
    s.currents.lock().unwrap().retain(|c| !Arc::ptr_eq(c, &cur));
    let mut stopped = outcome.stopped.to_string();
    let all_crashed = outcome.jobs > 0 && outcome.crashed == outcome.jobs;
    if all_crashed {
        stopped = "crashed".into();
        log(&format!("Every job of {label} lost its search thread"));
    }

    // The best this machine has found stays in best/spaces/. Both it and the search's best are
    // checked by the server's rule first, with the score the check computes.
    let passing = |c: Option<Candidate>| -> Option<Candidate> {
        let c = c?;
        let v = check_space_config(space_name, id, &c.config, &rule);
        v.score.filter(|_| v.valid).map(|score| Candidate { score, ..c })
    };
    let found = passing(outcome.best.clone());
    let file = s.state.lock().unwrap().read_space_best(id);
    let saved = passing(file.as_ref().and_then(candidate_of_file));
    if file.is_some() && saved.is_none() {
        log(&format!("The configuration kept in {} does not pass the check now; it is not offered", s.state.lock().unwrap().space_best_path(id).display()));
    }
    if let Some(f) = &found {
        if saved.as_ref().map_or(true, |sv| improves_on(f.score, sv.score)) {
            if let Err(e) = s.state.lock().unwrap().write_space_best(id, &best_json(f, id, parsed.p as usize)) {
                log(&format!("Could not save the best configuration: {e}"));
            }
        }
    }
    let (offer, from) = match (&found, &saved) {
        (Some(f), Some(sv)) => {
            if sv.score < f.score {
                (Some(sv.clone()), "file")
            } else {
                (Some(f.clone()), "search")
            }
        }
        (Some(f), None) => (Some(f.clone()), "search"),
        (None, Some(sv)) => (Some(sv.clone()), "file"),
        (None, None) => (None, "search"),
    };

    let mut decision = "no valid configuration".to_string();
    let mut after = before.clone();
    let mut sent: Option<SubmitOutcome> = None;
    if let Some(c) = &offer {
        let (fresh, fresh_answer) = s.read_problem(&s.submitter, id, space);
        match fresh {
            None => decision = format!("could not re-read the problem ({})", describe_answer(fresh_answer.as_ref())),
            Some(fi) => {
                after = best_ref(&fi);
                *cur.leader.lock().unwrap() = fi.best_score;
                let bound = fi.bound.or(info.bound);
                let fresh_rule = Rule { bound, certified: fi.certified.as_ref().map(|x| x.0).or(rule.certified), no_record: fi.no_record };
                let check = check_space_config(space_name, id, &c.config, &fresh_rule);
                let d = decide_space_submission(&DecideArgs {
                    has_best: true,
                    check: Some(&check),
                    open: fi.accepts_submissions,
                    best_score: fi.best_score,
                    bound,
                    dry_run: s.o.dry_run,
                    space: space_name,
                    certified: fi.certified.as_ref().map(|x| x.0),
                    leader: fi.site_best.as_ref().map(|l| l.score),
                });
                decision = d.reason;
                if d.submit {
                    let name = s.o.name.clone().unwrap();
                    let body = space_submission_body(space, id, c, &name, &s.o.note, SOFTWARE);
                    let score = c.score;
                    let again = || {
                        let (again, _) = s.read_problem(&s.submitter, id, space);
                        again.map(|i| check_space_stored(&i, &name, score))
                    };
                    let r = s.submitter.submit_to("/api/spaces/submit", &body, &again);
                    if r.requests > 0 {
                        s.counts.lock().unwrap()[1] += 1;
                    }
                    sent = Some(r);
                }
            }
        }
    }
    // what the submission came to
    let mut text: Option<String> = None;
    let mut response = Value::Null;
    if let (Some(r), Some(c)) = (&sent, &offer) {
        let kept = format!("the configuration stays in {}", s.state.lock().unwrap().space_best_path(id).display());
        let name = s.o.name.clone().unwrap_or_default();
        match &r.answer {
            Some(a) => {
                let resp = read_space_submit_response(&a.body);
                response = resp.as_ref().map_or(Value::Null, |x| x.to_json());
                if a.status == 200 && resp.as_ref().map_or(false, |x| x.valid) {
                    let resp = resp.unwrap();
                    s.counts.lock().unwrap()[2] += 1;
                    if resp.leader {
                        s.counts.lock().unwrap()[3] += 1;
                        text = Some(format!(
                            "submitted: HTTP 200, the new leader of the site's entries (#{}){}",
                            resp.id.unwrap_or(-1),
                            if resp.beats_certified { ", below the research record" } else { "" }
                        ));
                        after = Some(BestRef { id: resp.id, score: resp.score.unwrap_or(c.score), source: "site", name: Some(name) });
                    } else {
                        text = Some(format!("submitted: HTTP 200, valid, but the best stays at {}", resp.best_score.map_or("unchanged".into(), format_score)));
                    }
                } else {
                    text = Some(format!("refused: {}", describe_answer(Some(a))));
                }
            }
            None => {
                let failure = clean_text(r.failure.as_deref().unwrap_or("no answer"), 200);
                text = Some(match &r.check {
                    _ if r.requests == 0 => format!("not sent ({failure}); {kept}"),
                    Some(SubmitCheck::Ours { id: eid, score }) => {
                        s.counts.lock().unwrap()[2] += 1;
                        s.counts.lock().unwrap()[3] += 1;
                        after = Some(BestRef { id: Some(*eid), score: *score, source: "site", name: Some(name) });
                        format!("submitted: no answer came ({failure}), but the problem now shows it as the site's leader (#{eid})")
                    }
                    Some(SubmitCheck::Closed) => format!("no answer came ({failure}), and the problem is now closed"),
                    Some(SubmitCheck::Beaten { leader }) => format!("no answer came ({failure}); the best is now {}, at least as good: not sent again", format_score(*leader)),
                    Some(SubmitCheck::Absent) => format!("sent {} time(s) without an answer ({failure}), and not stored; {kept}", r.requests),
                    None => format!("sent, but no answer came ({failure}) and the problem could not be read again: it may be stored or not; {kept}"),
                });
            }
        }
    }
    let line = json!({
        "time": iso_now(),
        "space": space,
        "id": id,
        "P": parsed.p,
        "sweep": { "pass": t.pass, "loop": t.k, "index": t.index },
        "priority": null,
        "leader_before": leader_ref(&before),
        "leader_after": leader_ref(&after),
        "bound": info.bound,
        "best": offer.as_ref().map_or(Value::Null, |c| {
            let mut budget = json!({ "time_s": c.time_s });
            if let Some(e) = c.evals {
                budget["evals"] = json!(e);
            }
            json!({ "score": c.score, "method": c.method, "seed": c.seed, "kind": c.kind, "budget": budget, "from": from })
        }),
        "jobs": outcome.jobs,
        "evaluations": outcome.evaluations,
        "stopped": stopped,
        "active_s": (active * 1000.0).round() / 1000.0,
        "engine_seed": engine_seed,
        "dry_run": s.o.dry_run,
        "submitted": sent.as_ref().map_or(false, |r| r.requests > 0),
        "decision": decision,
        "status": sent.as_ref().and_then(|r| r.answer.as_ref()).map(|a| a.status),
        "response": response,
        "version": env!("CARGO_PKG_VERSION"),
        "software": SOFTWARE,
    });
    if let Err(e) = s.state.lock().unwrap().append_history(&line) {
        log(&format!("Could not write the history: {e}"));
    }
    s.counts.lock().unwrap()[0] += 1;
    let vs = match &offer {
        None => "no valid configuration".to_string(),
        Some(c) => format!(
            "best {} ({}, seed {}{}) vs {}",
            format_score(c.score),
            c.method,
            c.seed,
            if from == "file" { ", from an earlier search" } else { "" },
            before.as_ref().map_or("no best".into(), |b| format!("best {} ({})", format_score(b.score), relative_percent(c.score, b.score)))
        ),
    };
    log(&format!(
        "Finished {label} after {} ({stopped}), {} job(s), {} evaluations: {vs}; {}",
        format_duration(active),
        outcome.jobs,
        outcome.evaluations,
        text.unwrap_or(if offer.is_none() { "nothing to submit".into() } else { decision })
    ));
    // a search cut short by Ctrl-C is done again after a restart
    Searched::Done(stopped != "aborted")
}

#[allow(dead_code)]
const _: u64 = NOTHING_WAIT_MS;
