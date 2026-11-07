//! The client's main loop (apps/volunteer/src/main.ts, flat problems): draw a problem at random
//! (pick.rs), read it from the server, search it with the engine on its share of the threads,
//! submit the best only when it beats the site's leader, and draw the next. Several problems are
//! searched at once (--parallel-problems), each in its own slot.
//!
//! Two modes narrow the draws: --open-only skips problems that have a leader, and target mode
//! (--target-holder, target.rs) draws only from the problems one holder leads, checks before each
//! search that it still leads (and, by default, that its entry is the problem's only one), and ends
//! a search early once it is ahead by --target-margin.

use crate::answers::{clean_text, describe_answer, read_problem_info, read_stored_entry, read_submit_response, stored_name, ProblemInfo, SiteBest};
use crate::engine::{search, Candidate, Known, SearchInput, ThreadRunner};
use crate::format::{format_duration, format_score, iso_now, now_ms, relative_percent, timestamp};
use crate::http::{sleep_unless, Answer, Api, Pacer, SubmitCheck, SubmitOutcome, SUBMISSIONS_PER_MINUTE, SUBMISSION_WINDOW_MS};
use crate::memory::Memory;
use crate::options::Options;
use crate::pick::{draw_problem, note_search, prune_recent, FlatKind};
use crate::state::{random_u32, StateDir};
use crate::target::{is_lazy, leaderboard_verdict, load_targets, read_budget_seconds, stop_early, BudgetCache, Filters, TargetPool, Verdict, BUDGETS_FILE};
use polypack_flat::clock::ClockKind;
use polypack_flat::rng::Rng;
use polypack_flat::shapes::{Config, Pose, Problem};
use polypack_flat::validate::{canonical, improves_on, server_check, SCORE_TIE};
use polypack_flat::{Control, Method};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SOFTWARE: &str = concat!("polypack-native ", env!("CARGO_PKG_VERSION"));
pub const UNITS: &str = "diameter";
pub const SKIP_MS: i64 = 10 * 60_000;
pub const NOTHING_WAIT_MS: u64 = 60_000;
pub const SKIPS_BEFORE_WAIT: usize = 20;
pub const STOP_GRACE_MS: u64 = 30_000;
pub const MIN_PROBLEM_SECONDS: f64 = 120.0;
pub const MAX_METHOD_PARAMS_BYTES: usize = 4096;
/// Target mode: the wait after a drawn problem turned out not to be a target.
pub const TARGET_DROP_PAUSE_MS: u64 = 250;
/// --open-only: problems with a leader in a row before a minute's wait.
pub const OPEN_ONLY_SKIPS_BEFORE_WAIT: usize = 500;
/// Target mode: how often a search checks whether it may end early.
pub const EARLY_CHECK_MS: u64 = 100;

pub fn log(message: &str) {
    println!("[{}] {message}", timestamp());
}

/// Active time: seconds since start, not counting pauses (the engine's clock).
pub struct ActiveClock {
    origin: Instant,
    inner: Mutex<(Option<Instant>, f64)>,
}

impl ActiveClock {
    pub fn new() -> Self {
        ActiveClock { origin: Instant::now(), inner: Mutex::new((None, 0.0)) }
    }
    pub fn now(&self) -> f64 {
        let g = self.inner.lock().unwrap();
        let t = self.origin.elapsed().as_secs_f64();
        let pausing = g.0.map_or(0.0, |p| p.elapsed().as_secs_f64());
        t - g.1 - pausing
    }
    pub fn pause(&self) {
        let mut g = self.inner.lock().unwrap();
        if g.0.is_none() {
            g.0 = Some(Instant::now());
        }
    }
    pub fn resume(&self) {
        let mut g = self.inner.lock().unwrap();
        if let Some(p) = g.0.take() {
            g.1 += p.elapsed().as_secs_f64();
        }
    }
}

/// A problem being searched, for the status line, the stop and the pause.
struct Current {
    label: String,
    lanes: usize,
    control: Arc<Control>,
    started_at: f64,
    max_seconds: f64,
    jobs: AtomicUsize,
    best: Mutex<Option<f64>>,
    leader: Mutex<Option<f64>>,
}

enum Searched {
    Done(bool),
    Skipped,
    Unreachable,
    /// Not searched: it has a leader (--open-only), or it is not a target now (target mode).
    Held,
}

/// No answer, or one that says to come back later.
fn unreachable(a: Option<&Answer>) -> bool {
    a.map_or(true, |a| a.status == 429 || a.status >= 500)
}

/// A relative margin as the personal JavaScript build prints it: 1e-6, 0.01.
fn format_margin(r: f64) -> String {
    if r > 0.0 && r < 1e-3 {
        format!("{r:e}")
    } else {
        format!("{r}")
    }
}

struct Shared {
    o: Options,
    clock: ActiveClock,
    stop: Arc<AtomicBool>,
    hard: Arc<AtomicBool>,
    paused: AtomicBool,
    stop_reason: Mutex<Option<String>>,
    upgrade: Mutex<Option<String>>,
    reader: Api,
    submitter: Api,
    state: Mutex<StateDir>,
    memory: Mutex<Memory>,
    recent: Mutex<HashMap<String, i64>>,
    skip_until: Mutex<HashMap<String, i64>>,
    in_flight: Mutex<HashSet<String>>,
    currents: Mutex<Vec<Arc<Current>>>,
    rng: Mutex<Rng>,
    kind: FlatKind,
    /// Target mode's list and the leaders' search times (--target-max-budget).
    targets: Mutex<Option<TargetPool>>,
    budgets: Mutex<Option<BudgetCache>>,
    reloading: AtomicBool,
    held_skipped: AtomicUsize,
    counts: Mutex<[usize; 4]>,
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

    /// Stops at the --hours limit; before a new problem also when too little is left.
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

    fn save_memory(&self) {
        let m = self.memory.lock().unwrap().to_json();
        if let Err(e) = self.state.lock().unwrap().write_memory(&m) {
            log(&format!("could not save the engine's memory: {e}"));
        }
    }

    fn sub(&self, label: &str) -> String {
        if self.o.parallel_problems > 1 {
            format!("  {label}: ")
        } else {
            "  ".into()
        }
    }

    fn target_mode(&self) -> bool {
        self.o.target_holder.is_some()
    }

    fn holder(&self) -> &str {
        self.o.target_holder.as_deref().unwrap_or("")
    }

    /// Takes a problem off the target list for good (and from the draws of this run).
    fn drop_target(&self, problem: &Problem) {
        self.skip_until.lock().unwrap().insert(problem.key(), i64::MAX);
        if let Some(t) = self.targets.lock().unwrap().as_mut() {
            if let Err(e) = t.drop_problem(problem) {
                log(&format!("could not save the target list: {e}"));
            }
        }
    }

    fn flush_targets(&self) {
        let t = self.targets.lock().unwrap().as_mut().map(|t| t.flush());
        let b = self.budgets.lock().unwrap().as_mut().map(|b| b.flush());
        for r in [t, b].into_iter().flatten() {
            if let Err(e) = r {
                log(&format!("could not save the target files: {e}"));
            }
        }
    }

    fn read_problem(&self, api: &Api, p: &Problem) -> (Option<ProblemInfo>, Option<Answer>) {
        let a = api.problem(p.n, p.m, p.p);
        let info = a.as_ref().filter(|a| a.status == 200).and_then(|a| read_problem_info(&a.body, p.n, p.m, p.p));
        (info, a)
    }
}

/// The threads of each of `problems` problems searched at once: `cores` split as evenly as it
/// goes, the larger shares first.
pub fn lane_shares(cores: usize, problems: usize) -> Vec<usize> {
    let k = problems.min(cores).max(1);
    (0..k).map(|i| cores / k + usize::from(i < cores % k)).collect()
}

fn and_list(xs: &[String]) -> String {
    match xs.len() {
        0 => String::new(),
        1 => xs[0].clone(),
        n => format!("{} and {}", xs[..n - 1].join(", "), xs[n - 1]),
    }
}

pub fn run(o: Options) -> i32 {
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
    let memory = Memory::parse(&state.read_memory());
    let mut recent = HashMap::new();
    for line in &state.initial_history {
        note_search(&mut recent, line, o.dry_run);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let hard = Arc::new(AtomicBool::new(false));
    let pacer = Arc::new(Mutex::new(Pacer::new(SUBMISSIONS_PER_MINUTE, SUBMISSION_WINDOW_MS)));
    let user_agent = format!("polypack-native/{} ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
    let shared_cell: Arc<Mutex<Option<std::sync::Weak<Shared>>>> = Arc::new(Mutex::new(None));
    let cell = shared_cell.clone();
    let on_upgrade: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |message: &str| {
        if let Some(s) = cell.lock().unwrap().as_ref().and_then(|w| w.upgrade()) {
            *s.upgrade.lock().unwrap() = Some(message.to_string());
            s.request_stop("The server answered 426 (upgrade required)");
        }
    });
    let logger: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|m: &str| log(m));
    let reader = Api::new(&o.base, &user_agent, stop.clone(), pacer.clone(), logger.clone(), on_upgrade.clone());
    let submitter = Api::new(&o.base, &user_agent, hard.clone(), pacer, logger, on_upgrade);
    let kind = FlatKind::new(o.n.as_ref(), o.m.as_ref(), o.p.as_ref());
    let shared = Arc::new(Shared {
        clock: ActiveClock::new(),
        stop,
        hard,
        paused: AtomicBool::new(false),
        stop_reason: Mutex::new(None),
        upgrade: Mutex::new(None),
        reader,
        submitter,
        state: Mutex::new(state),
        memory: Mutex::new(memory),
        recent: Mutex::new(recent),
        skip_until: Mutex::new(HashMap::new()),
        in_flight: Mutex::new(HashSet::new()),
        currents: Mutex::new(Vec::new()),
        rng: Mutex::new(Rng::new(random_u32())),
        kind,
        targets: Mutex::new(None),
        budgets: Mutex::new(None),
        reloading: AtomicBool::new(false),
        held_skipped: AtomicUsize::new(0),
        counts: Mutex::new([0; 4]),
        started: Instant::now(),
        o,
    });
    *shared_cell.lock().unwrap() = Some(Arc::downgrade(&shared));
    banner(&shared);
    if let Some(holder) = shared.o.target_holder.clone() {
        let o = &shared.o;
        let filters = Filters { n: o.n.clone(), m: o.m.clone(), p: o.p.clone() };
        let fetch = || shared.reader.holder(&holder);
        match load_targets(&o.state_dir, &holder, &o.base, &filters, o.target_refresh, &fetch, &|m: &str| log(m)) {
            Err(why) => {
                log(&format!("Cannot start: {why}."));
                shared.state.lock().unwrap().close();
                return 1;
            }
            Ok(pool) => {
                log(&format!(
                    "{} of them pass --N, --M and --P; {}{}",
                    pool.size(),
                    if o.target_any_entry {
                        "any of them is searched while the holder leads it (--target-any-entry)"
                    } else {
                        "only those whose only accepted submission is the holder's (first entries) are searched"
                    },
                    o.target_max_budget.map_or(String::new(), |b| format!(
                        ", and only if the leader's entry took {b} s or less{}",
                        if o.target_include_unknown { " or says nothing" } else { "" }
                    ))
                ));
                *shared.targets.lock().unwrap() = Some(pool);
                if o.target_max_budget.is_some() {
                    *shared.budgets.lock().unwrap() = Some(BudgetCache::open(o.state_dir.join(BUDGETS_FILE)));
                }
            }
        }
    }

    // Ctrl-C: the first stops, the second exits at once
    {
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
    if shared.o.battery_pause {
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
    let targets_left = shared.targets.lock().unwrap().as_ref().map(|t| (t.size(), t.total(), t.holder().to_string()));
    let code = if let Some((0, total, holder)) = targets_left {
        log(&format!("None of the {total} problem(s) \"{holder}\" leads passes --N, --M and --P: there is nothing to search."));
        1
    } else if shared.kind.size() == 0 {
        log("No problem passes --N, --M, --P and --max-P together: there is nothing to search.");
        1
    } else {
        let shares = lane_shares(shared.o.cores, shared.o.parallel_problems);
        let handles: Vec<_> = shares
            .into_iter()
            .map(|lanes| {
                let s = shared.clone();
                std::thread::spawn(move || slot(&s, lanes))
            })
            .collect();
        let codes: Vec<i32> = handles.into_iter().map(|h| h.join().unwrap_or(1)).collect();
        i32::from(codes.iter().any(|&c| c != 0))
    };
    done.store(true, Ordering::Relaxed);
    shared.flush_targets();
    if let Some(up) = shared.upgrade.lock().unwrap().clone() {
        log(&format!("This client ({}) is out of date: {up} Download the current client and start it again.", env!("CARGO_PKG_VERSION")));
    }
    let c = *shared.counts.lock().unwrap();
    log(&format!(
        "Stopped after {}: {} problem(s) searched, {} submission(s) sent, {} accepted, {} took the lead. State is in {}.",
        format_duration(shared.started.elapsed().as_secs_f64()),
        c[0],
        c[1],
        c[2],
        c[3],
        shared.o.state_dir.display()
    ));
    shared.save_memory();
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
            format!("{} problems at once ({} threads), ", o.parallel_problems, and_list(&lane_shares(o.cores, o.parallel_problems).iter().map(|x| x.to_string()).collect::<Vec<_>>()))
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
            format!("submitting as \"{}\"{}", o.name.as_deref().unwrap_or(""), if o.note.is_empty() { String::new() } else { format!(" with the note \"{}\"", o.note) })
        }
    ));
    let methods: Vec<&str> = polypack_flat::methods::ALL.iter().filter(|m| m.available() && !matches!(m, Method::Identity | Method::Seed | Method::Polish)).map(|m| m.name()).collect();
    log(&format!(
        "Up to {} per problem; state in {}; {}{}; search methods {}",
        format_duration(o.minutes_per_problem * 60.0),
        o.state_dir.display(),
        if o.battery_pause { "pauses on battery power" } else { "keeps running on battery power" },
        if o.hours.is_finite() { format!("; stops after {} h", o.hours) } else { String::new() },
        methods.join(", ")
    ));
    if let Some(holder) = &o.target_holder {
        log(&format!(
            "Target mode: targets {holder}'s {}{}; stops ≥{} s once ahead by {}; ≤{} s each",
            if o.target_any_entry { "records, first entries or not (--target-any-entry)" } else { "first entries (problems whose only accepted submission is theirs)" },
            o.target_max_budget.map_or(String::new(), |b| format!(
                ", only those of at most {b} s{} (--target-max-budget)",
                if o.target_include_unknown { " or of unknown effort" } else { "" }
            )),
            o.target_min_seconds,
            format_margin(o.target_margin),
            (o.minutes_per_problem * 60.0).max(1.0)
        ));
    } else {
        log(&format!(
            "Draws each problem at random, every one as likely, from {} flat problems{}",
            s.kind.size(),
            if o.open_only { "; open problems only (a problem that already has a leader is skipped)" } else { "" }
        ));
    }
}

fn status(s: &Shared) {
    let currents = s.currents.lock().unwrap().clone();
    let c = *s.counts.lock().unwrap();
    let paused = if s.paused.load(Ordering::Relaxed) { "; paused on battery power" } else { "" };
    let describe = |c: &Current| {
        let elapsed = s.clock.now() - c.started_at;
        let best = c.best.lock().unwrap().map_or("none yet".into(), format_score);
        let vs = match *c.leader.lock().unwrap() {
            None => "no leader".to_string(),
            Some(l) => format!("leader {}{}", format_score(l), c.best.lock().unwrap().map_or(String::new(), |b| format!(" ({})", relative_percent(b, l)))),
        };
        format!("{}, {} of {}; best {best} vs {vs}; {} job(s) run", c.label, format_duration(elapsed), format_duration(c.max_seconds), c.jobs.load(Ordering::Relaxed))
    };
    for cur in &currents {
        log(&format!("Status: {} on {} thread(s)", describe(cur), cur.lanes));
    }
    log(&format!("Status: {} of {} problems being searched; {} submission(s) accepted{paused}", currents.len(), s.o.parallel_problems, c[2]));
}

/// One problem after another on `lanes` threads, until the client stops.
fn slot(s: &Arc<Shared>, lanes: usize) -> i32 {
    let mut failures = 0u32;
    let mut skipped = 0usize;
    let mut held = 0usize;
    while !s.stopped() {
        while s.paused.load(Ordering::Relaxed) && !s.stopped() {
            std::thread::sleep(Duration::from_millis(500));
        }
        if s.stopped() || s.check_deadline(true) {
            break;
        }
        let now = now_ms();
        let pick = {
            let mut skip = s.skip_until.lock().unwrap();
            skip.retain(|_, until| *until > now);
            let mut recent = s.recent.lock().unwrap();
            prune_recent(&mut recent, now);
            let mut all: HashSet<String> = skip.keys().cloned().collect();
            let mut in_flight = s.in_flight.lock().unwrap();
            all.extend(in_flight.iter().cloned());
            let targets = s.targets.lock().unwrap();
            let d = match targets.as_ref() {
                Some(t) => draw_problem(&|r: &mut Rng| t.draw(r), &recent, &all, now, &mut s.rng.lock().unwrap()),
                None => draw_problem(&|r: &mut Rng| s.kind.draw(r), &recent, &all, now, &mut s.rng.lock().unwrap()),
            };
            if let Some(p) = &d {
                in_flight.insert(p.key());
            }
            d
        };
        let Some(problem) = pick else {
            match s.targets.lock().unwrap().as_ref() {
                Some(t) => log(&format!(
                    "No target is left: the list holds {} problem(s) \"{}\" may still lead, {} of them not skipped yet (and those are being searched or could not be read lately).",
                    t.total(),
                    t.holder(),
                    t.size()
                )),
                None => log("Nothing to search: every problem drawn was closed, could not be read lately, or is being searched by another slot."),
            }
            if s.o.once {
                return 0;
            }
            sleep_unless(&s.stop, NOTHING_WAIT_MS);
            reload_targets(s);
            continue;
        };
        let key = problem.key();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| search_one(s, problem, lanes)));
        s.in_flight.lock().unwrap().remove(&key);
        let searched = match outcome {
            Ok(r) => r,
            Err(_) => {
                log(&format!("Skipping {} for 10 minutes after an unexpected error", problem.label()));
                s.skip_until.lock().unwrap().insert(key, now_ms() + SKIP_MS);
                Searched::Done(false)
            }
        };
        match searched {
            Searched::Unreachable => {
                if s.o.once {
                    return 1;
                }
                failures += 1;
                let ms = 60_000u64.min(2000 * 2u64.pow(failures.min(10)));
                log(&format!("Could not reach the server to read a problem; trying again in {} s", ms / 1000));
                sleep_unless(&s.stop, ms);
                continue;
            }
            Searched::Held => {
                failures = 0;
                if s.o.open_only {
                    held += 1;
                    if held % OPEN_ONLY_SKIPS_BEFORE_WAIT == 0 {
                        log(&format!("{held} problems in a row already had a leader; drawing again in 1m00s"));
                        sleep_unless(&s.stop, NOTHING_WAIT_MS);
                    }
                } else if s.target_mode() {
                    sleep_unless(&s.stop, TARGET_DROP_PAUSE_MS);
                }
                continue;
            }
            Searched::Skipped => {
                failures = 0;
                held = 0;
                skipped += 1;
                if skipped % SKIPS_BEFORE_WAIT == 0 {
                    log(&format!("{skipped} problems in a row were closed or unknown to the server; drawing again in 1m00s"));
                    sleep_unless(&s.stop, NOTHING_WAIT_MS);
                }
                continue;
            }
            Searched::Done(ok) => {
                failures = 0;
                skipped = 0;
                held = 0;
                if s.o.once {
                    return if ok || s.stopped() { 0 } else { 1 };
                }
            }
        }
    }
    0
}

/// Target mode: fetches the list again when it is older than a day, once the draws have run out
/// of problems.
fn reload_targets(s: &Arc<Shared>) {
    let Some(holder) = s.o.target_holder.clone() else { return };
    let fetched = s.targets.lock().unwrap().as_ref().map_or(i64::MAX, |t| t.fetched_at_ms);
    if s.stopped() || now_ms() - fetched < crate::target::TARGET_MAX_AGE_MS || s.reloading.swap(true, Ordering::Relaxed) {
        return;
    }
    let o = &s.o;
    let filters = Filters { n: o.n.clone(), m: o.m.clone(), p: o.p.clone() };
    let fetch = || s.reader.holder(&holder);
    if let Ok(mut fresh) = load_targets(&o.state_dir, &holder, &o.base, &filters, true, &fetch, &|m: &str| log(m)) {
        let file = fresh.to_file();
        if let Some(t) = s.targets.lock().unwrap().as_mut() {
            if let Err(e) = t.replace(file) {
                log(&format!("could not save the target list: {e}"));
            }
        }
        let _ = fresh.flush();
    }
    s.reloading.store(false, Ordering::Relaxed);
}

/// Target mode, before a drawn problem is read: one GET /api/leaderboard/N/M/P says whether it is
/// still a target. It is not (Held, and dropped from the list) when it is closed, the holder does
/// not lead it, or more than one submission was accepted (the count never decreases, so it cannot
/// be a first entry again). None when the search goes on. Not made with --target-any-entry.
fn first_entry_gate(s: &Arc<Shared>, problem: &Problem, label: &str) -> Option<Searched> {
    let a = s.reader.leaderboard(problem.n, problem.m, problem.p);
    if s.stopped() {
        return Some(Searched::Done(false));
    }
    if a.as_ref().map_or(false, |a| a.status == 404) {
        log(&format!("{label}: the server has no such problem; dropping it from the list"));
        s.drop_target(problem);
        return Some(Searched::Held);
    }
    let verdict = a.as_ref().filter(|a| a.status == 200).and_then(|a| leaderboard_verdict(&a.body, s.holder(), false));
    let Some(verdict) = verdict else {
        if unreachable(a.as_ref()) {
            return Some(Searched::Unreachable);
        }
        log(&format!(
            "Could not read the leaderboard of {label} ({}); skipping it for 10 minutes",
            if a.as_ref().map_or(false, |a| a.status == 200) { "malformed answer".into() } else { describe_answer(a.as_ref()) }
        ));
        s.skip_until.lock().unwrap().insert(problem.key(), now_ms() + SKIP_MS);
        return Some(Searched::Done(false));
    };
    let other = |leader: &Option<String>| {
        format!(
            "{}, not \"{}\": dropping it from the list",
            leader.as_ref().map_or("no leader".into(), |l| format!("now led by \"{}\"", clean_text(l, 60))),
            s.holder()
        )
    };
    match verdict {
        Verdict::Keep => return None,
        Verdict::Closed { .. } => log(&format!("{label} is closed: its published optimum is proven. Dropping it from the list")),
        Verdict::NotFirst { total } => log(&format!("{label}: {total} accepted submissions, not a first entry: dropping it")),
        Verdict::NoLeader => log(&format!("{label}: {}", other(&None))),
        Verdict::OtherLeader { leader } => log(&format!("{label}: {}", other(&Some(leader)))),
    }
    s.drop_target(problem);
    Some(Searched::Held)
}

/// Target mode, a drawn problem with its leader read: Err(Held) when it is not a target now (its
/// leader is not the holder: it is dropped from the list; or its entry took more than
/// --target-max-budget seconds, or says nothing), Err(Unreachable) or Err(Done(false)) when the
/// entry could not be read; else the entry's answer when it had to be fetched (it has the packing
/// too), or None when a cached search time made the fetch unnecessary.
fn target_verdict(s: &Arc<Shared>, problem: &Problem, label: &str, leader: Option<&SiteBest>) -> Result<Option<Answer>, Searched> {
    let Some(l) = leader.filter(|l| l.name == s.holder()) else {
        log(&format!(
            "{label}: {}, not \"{}\": dropping it from the list",
            leader.map_or("no leader".into(), |l| format!("now led by \"{}\"", clean_text(&l.name, 60))),
            s.holder()
        ));
        s.drop_target(problem);
        return Err(Searched::Held);
    };
    let Some(max) = s.o.target_max_budget else { return Ok(None) };
    let cached = s.budgets.lock().unwrap().as_ref().and_then(|b| b.get(l.id));
    let mut entry = None;
    let seconds = match cached {
        Some(seconds) => seconds,
        None => {
            let a = s.reader.entry(l.id);
            if s.stopped() {
                return Err(Searched::Done(false));
            }
            if a.as_ref().map_or(true, |a| a.status != 200) {
                if unreachable(a.as_ref()) {
                    return Err(Searched::Unreachable);
                }
                log(&format!("Could not read entry #{} of {label} ({}); skipping it for 10 minutes", l.id, describe_answer(a.as_ref())));
                s.skip_until.lock().unwrap().insert(problem.key(), now_ms() + SKIP_MS);
                return Err(Searched::Done(false));
            }
            let seconds = read_budget_seconds(&a.as_ref().unwrap().body);
            if let Some(b) = s.budgets.lock().unwrap().as_mut() {
                if let Err(e) = b.set(l.id, seconds) {
                    log(&format!("could not save the target files: {e}"));
                }
            }
            entry = a;
            seconds
        }
    };
    if !is_lazy(seconds, max, s.o.target_include_unknown) {
        log(&format!(
            "{label}: the leader's entry #{} {}: skipping it",
            l.id,
            seconds.map_or("gives no search time".into(), |t| format!("took {t} s, over --target-max-budget {max}"))
        ));
        s.skip_until.lock().unwrap().insert(problem.key(), i64::MAX);
        if let Some(t) = s.targets.lock().unwrap().as_mut() {
            t.hold(problem);
        }
        return Err(Searched::Held);
    }
    Ok(entry)
}

/// The packing the engine starts from: the leader's, or the published one when it is better or
/// when the leader's coordinates are not at hand.
fn build_known(info: &ProblemInfo, problem: &Problem, leader: Option<(f64, Vec<Pose>, f64)>) -> Option<(Known, &'static str)> {
    let published = info.literature.as_ref().filter(|l| l.pieces.as_ref().map_or(false, |p| p.len() == problem.p));
    let site = leader.filter(|l| l.1.len() == problem.p);
    if let Some((score, pieces, phi)) = site {
        if published.map_or(true, |l| score <= l.value) {
            return Some((Known { config: Config { n: problem.n, m: problem.m, pieces, phi }, score }, "site"));
        }
    }
    published.map(|l| (Known { config: Config { n: problem.n, m: problem.m, pieces: l.pieces.clone().unwrap(), phi: l.container_phi }, score: l.value }, "literature"))
}

/// A best file's candidate (strict, of this problem).
fn candidate_of_file(v: &Value, problem: &Problem) -> Option<Candidate> {
    let config = v.get("config")?;
    let pieces = crate::answers::read_pieces(config.get("pieces")?, problem.p)?;
    let phi = config.get("container_phi").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let method = Method::from_name(v.get("method")?.as_str()?)?;
    let budget = v.get("budget");
    Some(Candidate {
        config: Config { n: problem.n, m: problem.m, pieces, phi },
        score: v.get("score")?.as_f64()?,
        strict: true,
        job: crate::engine::Job {
            problem: *problem,
            method,
            params: Value::Null,
            seed: v.get("seed").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            time_s: budget.and_then(|b| b.get("time_s")).and_then(|x| x.as_f64()).unwrap_or(1.0),
            evals: budget.and_then(|b| b.get("evals")).and_then(|x| x.as_u64()),
            start: None,
            final_polish: true,
            kind: match v.get("kind").and_then(|k| k.as_str()) {
                Some("warm") => "warm",
                Some("iterate") => "iterate",
                Some("polish") => "polish",
                _ => "fresh",
            },
        },
        params: v.get("params").cloned().unwrap_or(Value::Null),
    })
}

fn pieces_json(pieces: &[Pose]) -> Value {
    Value::Array(pieces.iter().map(|q| json!({ "x": q.x, "y": q.y, "theta": q.theta })).collect())
}

fn best_file_of(c: &Candidate, problem: &Problem) -> Value {
    let mut budget = json!({ "time_s": c.job.time_s });
    if let Some(e) = c.job.evals {
        budget["evals"] = json!(e);
    }
    json!({
        "N": problem.n, "M": problem.m, "P": problem.p,
        "score": c.score,
        "strict": true,
        "method": c.job.method.name(),
        "params": c.params,
        "seed": c.job.seed,
        "budget": budget,
        "kind": c.job.kind,
        "found_at": iso_now(),
        "version": env!("CARGO_PKG_VERSION"),
        "software": SOFTWARE,
        "units": UNITS,
        "config": { "N": problem.n, "M": problem.m, "P": problem.p, "pieces": pieces_json(&c.config.pieces), "container_phi": c.config.phi },
    })
}

/// The body of POST /api/submit.
fn submission_body(c: &Candidate, problem: &Problem, name: &str, note: &str) -> Value {
    let mut body = json!({
        "N": problem.n, "M": problem.m, "P": problem.p,
        "pieces": pieces_json(&c.config.pieces),
        "container_phi": c.config.phi,
        // lengths in the units of 2026-10-27 (disks of diameter 1, circle containers by diameter)
        "units": UNITS,
        "name": name,
        "found_with": "optimizer",
        "method": c.job.method.name(),
        "seed": c.job.seed,
        "software": SOFTWARE,
    });
    if !note.is_empty() {
        body["agent_note"] = json!(note);
    }
    if c.params.is_object() && c.params.to_string().len() <= MAX_METHOD_PARAMS_BYTES {
        body["method_params"] = c.params.clone();
    }
    let mut budget = json!({ "time_s": c.job.time_s });
    if let Some(e) = c.job.evals {
        budget["evals"] = json!(e);
    }
    body["budget"] = budget;
    body
}

fn check_stored(info: &ProblemInfo, name: &str, score: f64) -> SubmitCheck {
    if !info.accepts_submissions {
        return SubmitCheck::Closed;
    }
    let Some(b) = &info.site_best else { return SubmitCheck::Absent };
    let same = (b.score - score).abs() <= SCORE_TIE * b.score.max(score);
    if same && stored_name(&b.name) == stored_name(name) {
        return SubmitCheck::Ours { id: b.id, score: b.score };
    }
    if !improves_on(score, b.score) {
        return SubmitCheck::Beaten { leader: b.score };
    }
    SubmitCheck::Absent
}

/// Searches one problem and submits its best if it qualifies.
fn search_one(s: &Arc<Shared>, problem: Problem, lanes: usize) -> Searched {
    let key = problem.key();
    let label = problem.label();
    if s.target_mode() && !s.o.target_any_entry {
        if let Some(r) = first_entry_gate(s, &problem, &label) {
            return r;
        }
    }
    let (info, answer) = s.read_problem(&s.reader, &problem);
    if s.stopped() {
        return Searched::Done(false);
    }
    let Some(info) = info else {
        if answer.as_ref().map_or(true, |a| a.status == 429 || a.status >= 500) {
            return Searched::Unreachable;
        }
        let gone = answer.as_ref().map_or(false, |a| a.status == 404);
        log(&format!(
            "Could not read {label} ({}); skipping it{}",
            if answer.as_ref().map_or(false, |a| a.status == 200) { "malformed answer".into() } else { describe_answer(answer.as_ref()) },
            if gone { "" } else { " for 10 minutes" }
        ));
        s.skip_until.lock().unwrap().insert(key, if gone { i64::MAX } else { now_ms() + SKIP_MS });
        if gone && s.target_mode() {
            s.drop_target(&problem);
            return Searched::Held;
        }
        return if gone { Searched::Skipped } else { Searched::Done(false) };
    };
    if !info.accepts_submissions {
        log(&format!("{label} is closed: its published optimum is proven. Skipping it."));
        s.skip_until.lock().unwrap().insert(key, i64::MAX);
        if s.target_mode() {
            s.drop_target(&problem);
            return Searched::Held;
        }
        return Searched::Skipped;
    }
    let leader = info.site_best.clone();
    if s.o.open_only {
        if let Some(l) = &leader {
            s.skip_until.lock().unwrap().insert(key, i64::MAX);
            let n = s.held_skipped.fetch_add(1, Ordering::Relaxed) + 1;
            if n <= 5 || n % 100 == 0 {
                log(&format!("{label} has a leader (#{}): skipping it (--open-only; {n} skipped so far)", l.id));
            }
            return Searched::Held;
        }
    }
    let mut leader_entry = None;
    if s.target_mode() {
        match target_verdict(s, &problem, &label, leader.as_ref()) {
            Err(r) => return r,
            Ok(entry) => leader_entry = entry,
        }
    }
    let published = info.literature.as_ref().map(|l| l.value);
    let published_start = info.literature.as_ref().map_or(false, |l| l.pieces.is_some());
    // the leader's coordinates are read only when they are the better start
    let mut stored = None;
    if let Some(l) = &leader {
        if !(published_start && published.map_or(false, |v| v < l.score)) {
            let a = leader_entry.take().or_else(|| s.reader.entry(l.id));
            stored = a.as_ref().filter(|a| a.status == 200).and_then(|a| read_stored_entry(&a.body, problem.p));
            if stored.is_none() && !s.stopped() {
                log(&format!("Could not read the leader's packing #{} ({})", l.id, describe_answer(a.as_ref())));
            }
        }
    }
    if s.stopped() {
        return Searched::Done(false);
    }
    let known = build_known(&info, &problem, stored);
    let max_seconds = s.max_seconds();
    let engine_seed = random_u32();
    let control = Control::new();
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
        leader: Mutex::new(leader.as_ref().map(|l| l.score)),
    });
    s.currents.lock().unwrap().push(cur.clone());
    log(&format!(
        "Searching {label}: leader {}, published {}, area bound {}; starting from {}; up to {} on {lanes} thread(s)",
        leader.as_ref().map_or("none".into(), |l| format!("{} by \"{}\"", format_score(l.score), clean_text(&l.name, 60))),
        published.map_or("none".into(), format_score),
        format_score(info.area_bound),
        match &known {
            Some((_, "site")) => "the leader's packing",
            Some(_) => "the published packing",
            None => "nothing",
        },
        format_duration(max_seconds)
    ));
    let memory = s.memory.lock().unwrap().clone();
    let sub = s.sub(&label);
    let mut on_result = |_r: &crate::engine::JobResult, best: Option<&Candidate>| {
        cur.jobs.fetch_add(1, Ordering::Relaxed);
        if let Some(b) = best {
            let mut cb = cur.best.lock().unwrap();
            // improvements below 1e-9 relative are rounding: not worth a line
            if cb.map_or(true, |x| b.score < x * (1.0 - 1e-9)) {
                *cb = Some(b.score);
                let vs = cur.leader.lock().unwrap().map_or(String::new(), |l| format!(", {} against the leader", relative_percent(b.score, l)));
                log(&format!("{sub}best so far {} ({}, {}, seed {}){vs}", format_score(b.score), b.job.method.name(), b.job.kind, b.job.seed));
            }
        }
    };
    let now = || s.clock.now();
    let memory_now = || s.memory.lock().unwrap().clone();
    let mut runner = ThreadRunner::new(control.clone(), ClockKind::Wall, s.o.low_priority);
    let started_at = s.clock.now();
    // target mode: the search ends early once it is ahead of the holder by --target-margin, after
    // --target-min-seconds (checked every EARLY_CHECK_MS on a thread of its own)
    let early = AtomicBool::new(false);
    let finished = AtomicBool::new(false);
    let target_leader = if s.target_mode() { leader.as_ref().map(|l| l.score) } else { None };
    let outcome = std::thread::scope(|scope| {
        if let Some(leader_score) = target_leader {
            let (cur, control, early, finished, sub) = (&cur, &control, &early, &finished, &sub);
            scope.spawn(move || {
                while !finished.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(EARLY_CHECK_MS));
                    if control.aborted.load(Ordering::Relaxed) {
                        continue;
                    }
                    let seconds = s.clock.now() - cur.started_at;
                    let best = *cur.best.lock().unwrap();
                    if stop_early(best, Some(leader_score), seconds, s.o.target_min_seconds, s.o.target_margin) {
                        early.store(true, Ordering::Relaxed);
                        control.aborted.store(true, Ordering::Relaxed);
                        log(&format!(
                            "{sub}{} is {} against the leader after {}: ending the search (--target-margin {}, --target-min-seconds {})",
                            format_score(best.unwrap()),
                            relative_percent(best.unwrap(), leader_score),
                            format_duration(seconds),
                            format_margin(s.o.target_margin),
                            s.o.target_min_seconds
                        ));
                        return;
                    }
                }
            });
        }
        let outcome = search(
            SearchInput {
                problem,
                known: known.as_ref().map(|k| k.0.clone()),
                area_bound: info.area_bound,
                max_seconds,
                lanes,
                seed: engine_seed,
                memory,
                now: &now,
                control: control.clone(),
                on_result: &mut on_result,
                memory_now: &memory_now,
            },
            &mut runner,
        );
        finished.store(true, Ordering::Relaxed);
        outcome
    });
    let active = s.clock.now() - started_at;
    s.currents.lock().unwrap().retain(|c| !Arc::ptr_eq(c, &cur));
    *s.memory.lock().unwrap() = outcome.memory.clone();
    s.save_memory();
    let mut stopped = outcome.stopped.as_str();
    if early.load(Ordering::Relaxed) && stopped == "aborted" {
        stopped = "early";
    }

    // this search's best, kept on disk when it is the best this machine has found for the problem
    let found = outcome.best.clone().filter(|b| b.strict);
    let saved_file = s.state.lock().unwrap().read_best(problem.n, problem.m, problem.p);
    let saved = saved_file.as_ref().and_then(|f| candidate_of_file(f, &problem));
    if let Some(f) = &found {
        if saved.as_ref().map_or(true, |sv| improves_on(f.score, sv.score)) {
            if let Err(e) = s.state.lock().unwrap().write_best(problem.n, problem.m, problem.p, &best_file_of(f, &problem)) {
                log(&format!("Could not save the best packing: {e}"));
            }
        }
    }
    // an earlier search's best still counts: its submission may have failed, or it was a dry run
    let offer = match (&found, &saved) {
        (Some(f), Some(sv)) => Some(if sv.score < f.score { (sv.clone(), "file") } else { (f.clone(), "search") }),
        (Some(f), None) => Some((f.clone(), "search")),
        (None, Some(sv)) => Some((sv.clone(), "file")),
        (None, None) => None,
    };
    // the client's own check of the server's rule, stricter than the server: never offer a
    // packing it would refuse, nor a score it would compute differently
    let offer = offer.and_then(|(c, from)| {
        // angles in one symmetry period keep the rounding margin of the check small
        let config = canonical(&c.config);
        let check = server_check(&config, problem.p);
        if !(check.valid && check.strict) {
            log(&format!("{sub}the best packing does not pass the server's rule here ({}); it is not offered", check.reasons.join("; ")));
            return None;
        }
        let score = check.score.unwrap();
        Some((Candidate { score, config, ..c }, from))
    });

    let mut decision = "no strict packing".to_string();
    let mut sent: Option<SubmitOutcome> = None;
    let mut leader_after = leader.clone();
    if let Some((c, _)) = &offer {
        let (fresh, fresh_answer) = s.read_problem(&s.submitter, &problem);
        match fresh {
            None => decision = format!("could not re-read the leader ({})", describe_answer(fresh_answer.as_ref())),
            Some(fi) => {
                leader_after = fi.site_best.clone();
                *cur.leader.lock().unwrap() = fi.site_best.as_ref().map(|l| l.score);
                if !fi.accepts_submissions {
                    s.skip_until.lock().unwrap().insert(key.clone(), i64::MAX);
                    decision = "the problem is closed".into();
                } else if fi.site_best.as_ref().map_or(false, |l| !improves_on(c.score, l.score)) {
                    decision = "not better than the leader".into();
                } else if s.o.dry_run {
                    decision = "dry run: would submit".into();
                } else {
                    let name = s.o.name.clone().unwrap();
                    let body = submission_body(c, &problem, &name, &s.o.note);
                    let score = c.score;
                    let check = || {
                        let (again, _) = s.read_problem(&s.submitter, &problem);
                        again.map(|i| check_stored(&i, &name, score))
                    };
                    let r = s.submitter.submit(&body, &check);
                    if r.requests > 0 {
                        s.counts.lock().unwrap()[1] += 1;
                    }
                    decision = if fi.site_best.is_none() { "the problem has no leader".into() } else { "better than the leader".into() };
                    sent = Some(r);
                }
            }
        }
    }
    // what the submission came to
    let mut text = None;
    let mut response = Value::Null;
    if let (Some(r), Some((c, _))) = (&sent, &offer) {
        match &r.answer {
            Some(a) => {
                let resp = read_submit_response(&a.body);
                response = resp.as_ref().map_or(Value::Null, |x| x.to_json());
                if a.status == 200 && resp.as_ref().map_or(false, |x| x.valid) {
                    let resp = resp.unwrap();
                    s.counts.lock().unwrap()[2] += 1;
                    if resp.leader {
                        s.counts.lock().unwrap()[3] += 1;
                        text = Some(format!("submitted: HTTP 200, the new leader (#{}){}", resp.id.unwrap_or(-1), if resp.pending_verification { ", pending verification" } else { "" }));
                        leader_after = Some(crate::answers::SiteBest { id: resp.id.unwrap_or(-1), score: resp.score.unwrap_or(c.score), name: s.o.name.clone().unwrap_or_default() });
                    } else {
                        text = Some(format!("submitted: HTTP 200, accepted, but the leader stays at {}", resp.leader_score.map_or("unchanged".into(), format_score)));
                    }
                } else {
                    if a.status == 409 {
                        s.skip_until.lock().unwrap().insert(key.clone(), i64::MAX);
                    }
                    text = Some(format!("refused: {}", describe_answer(Some(a))));
                }
            }
            None => {
                let failure = clean_text(r.failure.as_deref().unwrap_or("no answer"), 200);
                text = Some(match &r.check {
                    _ if r.requests == 0 => format!("not sent ({failure})"),
                    Some(SubmitCheck::Ours { id, .. }) => {
                        s.counts.lock().unwrap()[2] += 1;
                        s.counts.lock().unwrap()[3] += 1;
                        format!("submitted: no answer came ({failure}), but the problem now shows it as the leader (#{id})")
                    }
                    Some(SubmitCheck::Closed) => {
                        s.skip_until.lock().unwrap().insert(key.clone(), i64::MAX);
                        format!("no answer came ({failure}), and the problem is now closed")
                    }
                    Some(SubmitCheck::Beaten { leader }) => format!("no answer came ({failure}); the leader is now {}, at least as good: not sent again", format_score(*leader)),
                    Some(SubmitCheck::Absent) => format!("sent {} time(s) without an answer ({failure}), and not stored", r.requests),
                    None => format!("sent, but no answer came ({failure}) and the problem could not be read again: it may be stored or not"),
                });
            }
        }
    }
    // a target the holder no longer leads (taken here, or by someone else meanwhile) leaves the list
    if s.target_mode() && leader_after.as_ref().map_or(false, |l| l.name != s.holder()) {
        s.drop_target(&problem);
    }
    let leader_ref = |l: &Option<crate::answers::SiteBest>| l.as_ref().map_or(Value::Null, |l| json!({ "id": l.id, "score": l.score, "name": l.name }));
    let best_json = offer.as_ref().map_or(Value::Null, |(c, from)| {
        let mut budget = json!({ "time_s": c.job.time_s });
        if let Some(e) = c.job.evals {
            budget["evals"] = json!(e);
        }
        json!({ "score": c.score, "method": c.job.method.name(), "seed": c.job.seed, "kind": c.job.kind, "budget": budget, "from": from })
    });
    let line = json!({
        "time": iso_now(),
        "N": problem.n, "M": problem.m, "P": problem.p,
        "reason": "random",
        "priority": null,
        "leader_before": leader_ref(&leader),
        "leader_after": leader_ref(&leader_after),
        "published": published,
        "best": best_json,
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
    note_search(&mut s.recent.lock().unwrap(), &line, s.o.dry_run);
    s.counts.lock().unwrap()[0] += 1;
    let vs = match &offer {
        None => "no strict packing".to_string(),
        Some((c, from)) => format!(
            "best {} ({}, seed {}{}) vs {}",
            format_score(c.score),
            c.job.method.name(),
            c.job.seed,
            if *from == "file" { ", from an earlier search" } else { "" },
            leader.as_ref().map_or("no leader".into(), |l| format!("leader {} ({})", format_score(l.score), relative_percent(c.score, l.score)))
        ),
    };
    log(&format!(
        "Finished {label} after {} ({stopped}), {} job(s), {} evaluations: {vs}; {}",
        format_duration(active),
        outcome.jobs,
        outcome.evaluations,
        text.unwrap_or(if offer.is_none() { "nothing to submit".into() } else { decision })
    ));
    Searched::Done(true)
}
