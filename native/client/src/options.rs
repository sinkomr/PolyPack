//! Command-line options, matching the JavaScript client's (apps/volunteer/src/options.ts) where
//! they apply to flat problems. Parsing is pure: the machine's core count and home directory are
//! passed in.

use crate::target::{DEFAULT_TARGET_MARGIN, DEFAULT_TARGET_MIN_SECONDS};
use std::path::PathBuf;

pub const DEFAULT_BASE: &str = "https://polypack.fly.dev";
pub const DEFAULT_MINUTES_PER_PROBLEM: f64 = 10.0;
pub const MAX_NAME_LENGTH: usize = 40;
pub const MAX_NOTE_LENGTH: usize = 200;
pub const THREADS_PER_PROBLEM: usize = 4;
pub const MAX_SIDES: u32 = 100;
pub const MAX_PIECES: usize = 500;

#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    /// Display name of the submissions; None when none was given (then a dry run).
    pub name: Option<String>,
    pub base: String,
    pub cores: usize,
    pub parallel_problems: usize,
    /// Hours before the client stops; INFINITY for never.
    pub hours: f64,
    pub minutes_per_problem: f64,
    pub n: Option<Vec<u32>>,
    pub m: Option<Vec<u32>>,
    /// The numbers of pieces allowed (--P and --max-P together); None for 1 to 500.
    pub p: Option<Vec<usize>>,
    /// True when nothing is submitted: --dry-run, or no --name.
    pub dry_run: bool,
    pub state_dir: PathBuf,
    /// A file holding the site's submit key (--key-file); read when the client starts.
    pub key_file: Option<PathBuf>,
    pub note: String,
    pub battery_pause: bool,
    pub low_priority: bool,
    pub once: bool,
    /// Only problems without a leader (--open-only).
    pub open_only: bool,
    /// Target mode: only the problems this holder leads (--target-holder).
    pub target_holder: Option<String>,
    pub target_refresh: bool,
    pub target_any_entry: bool,
    pub target_max_budget: Option<f64>,
    pub target_include_unknown: bool,
    pub target_min_seconds: f64,
    pub target_margin: f64,
    /// Personal 2D-on-3D sweep (--sweep-2d-on-3d, sweep.rs); None for the flat client.
    pub sweep: Option<SweepOptions>,
}

/// The spaces the sweep covers, in the order it visits them within one P and N.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SweepKind {
    Surface,
    Sphere,
    Torus,
}

impl SweepKind {
    pub const ALL: [SweepKind; 3] = [SweepKind::Surface, SweepKind::Sphere, SweepKind::Torus];

    pub fn name(self) -> &'static str {
        match self {
            SweepKind::Surface => "surface",
            SweepKind::Sphere => "sphere",
            SweepKind::Torus => "torus",
        }
    }
}

/// The options of --sweep-2d-on-3d. The flat options --N, --P and --max-P also narrow it (the
/// shape codes and the numbers of pieces it visits); --M does not apply.
#[derive(Clone, Debug, PartialEq)]
pub struct SweepOptions {
    /// The kinds to search, in the sweep's order (surface, sphere, torus).
    pub kinds: Vec<SweepKind>,
    /// "fold" and "nofold", in that order.
    pub surface_modes: Vec<String>,
    /// The solids to search, in catalogue order; None for every solid.
    pub solids: Option<Vec<String>>,
    /// Only shape codes up to this one (the disk, 0, always passes).
    pub max_n: Option<u32>,
    /// Start over from the first loop of the first pass.
    pub restart: bool,
    /// Also search problems the user already leads.
    pub include_own: bool,
    /// Only problems with no best at all, neither a site entry nor a research record (--open-only).
    pub open_only: bool,
    /// Stop at the end of the current pass instead of starting the next (--one-pass).
    pub one_pass: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Parsed {
    Help,
    Version,
    Run(Options),
}

#[derive(Clone, Debug, PartialEq)]
pub struct OptionError(pub String);

pub struct Machine {
    pub available_parallelism: usize,
    pub home: PathBuf,
}

pub fn default_cores(m: &Machine) -> usize {
    m.available_parallelism.saturating_sub(1).max(1)
}

pub fn default_parallel_problems(cores: usize) -> usize {
    ((cores as f64 / THREADS_PER_PROBLEM as f64).round() as usize).max(1)
}

pub fn help_text(m: &Machine) -> String {
    let cores = default_cores(m);
    format!(
        "polypack-native {version}: give spare CPU time to PolyPack ({DEFAULT_BASE})

A native client for flat problems (polygons in polygons): it draws problems at random, several
at once on a machine with many cores, searches each with many methods and seeds on its share of
the cores, and submits a result only when it beats the site's leader.

Usage: polypack-native [options]

  --name NAME              display name shown with your entries (at most {MAX_NAME_LENGTH} characters);
                           without it nothing is submitted: the client runs as a dry run
  --server URL             server (default {DEFAULT_BASE}); --base is the same option
  --cores K                search threads (default: all cores but one, here {cores})
  --parallel-problems K    problems searched at once, sharing the threads (default: one per
                           {THREADS_PER_PROBLEM} threads, here {pp}); 1 searches one at a time
  --hours H                stop after H hours (default: never)
  --minutes-per-problem T  most minutes of search per problem, pauses excluded (default {DEFAULT_MINUTES_PER_PROBLEM})
  --N LIST                 piece shapes, e.g. 0,3-6 (0 = circle; default: all)
  --M LIST                 container shapes, same syntax (default: all)
  --P LIST                 only problems with these numbers of pieces, e.g. 10-50 or 1-10,100-150
                           (default: all)
  --max-P K                shorthand for --P 1-K; with both, the numbers in both
  --open-only              skip problems that already have a leader: only first entries are made
                           (with --sweep-2d-on-3d: skip problems with any best, a site entry or a research record)
                           (not with --target-holder)
  --dry-run                search, but never submit
  --note TEXT              free text shown with your entries (at most {MAX_NOTE_LENGTH} characters)
  --state DIR              where the client keeps its state (default {state})
  --key-file PATH          a file holding the site's submit key, given out by its operator: the
                           submissions count against the key's limit of 600 a minute instead of this
                           address's 120, and are paced at it
  --priority low|normal    CPU priority of the search threads (default low)
  --no-battery-pause       keep searching on battery power (by default it pauses)
  --once                   search one problem, then exit
  --help                   this text
  --version                the version

2D on 3D sweep (personal build): instead of drawing flat problems at random, search the surface,
sphere and torus problems from easy to hard.

  --sweep-2d-on-3d         the mode. Loop k = 1, 2, 3 ... covers the problems with
                           max(P, rank of N) = k, where N is ranked disk first (N = 0, 3, 4, 5 ...: rank
                           1, 2, 3, 4 ...); within a loop by P, then N, then kind (surface, sphere,
                           torus), then solid in catalogue order, then mode and torus family. The
                           position is kept in the state directory (sweep.json), so a restart goes on
                           where it stopped; after the last loop a second pass starts at loop 1. A problem
                           that is closed or unknown to the server is skipped, and so is one the
                           --name already leads (unless --include-own). Needs a build with the
                           real-search feature
  --kinds LIST             of surface,sphere,torus (default: all three)
  --surface-modes LIST     of fold,nofold (default: both)
  --solids LIST            surface solids, by name (cube, snub_cube, square_pyramid ...) or group (platonic,
                           archimedean, catalan, johnson); searched in catalogue order (default: all 141)
  --max-N K                only shape codes N up to K (the disk, 0, passes)
                           (--N LIST, --P LIST and --max-P K narrow the sweep too)
  --sweep-restart          forget the kept position and start again at loop 1 of pass 1
  --include-own            also search problems the --name already leads (default: skip them)
  --one-pass               stop when the current pass is complete instead of starting the next one

Target mode: re-search the low-effort records of one holder.

  --target-holder NAME     search only the problems that NAME leads now and whose only accepted
                           submission is NAME's (a \"first entry\": the server's count of accepted
                           submissions, total of /api/leaderboard, is 1; such records are nearly all
                           low-effort ones). The list comes from /api/holder, is kept in the state
                           directory (targets.json) and fetched again after 24 hours. A drawn problem
                           whose leader is no longer NAME, or that has more than one accepted submission
                           (a count that never goes down), is skipped and dropped from the list. --N, --M
                           and --P still narrow the list. Not with --open-only
  --target-refresh         fetch the list again now, whatever its age
  --target-any-entry       do not require a first entry: also search problems with several accepted submissions
  --target-max-budget S    also require that the leader's entry says it took at most S seconds (budget.time_s);
                           off by default. Each entry is looked up once (/api/submissions/ID), the answer is kept (lazy.json)
  --target-include-unknown with --target-max-budget: also search a leader whose entry gives no time_s (default: skipped)
  --target-min-seconds A   a target's search ends early only after A active seconds (default {DEFAULT_TARGET_MIN_SECONDS})
  --target-margin R        ... and ends then as soon as its best strict packing is at most
                           leader * (1 - R), R relative (default {DEFAULT_TARGET_MARGIN}); otherwise it runs up to
                           --minutes-per-problem (0.5 is 30 s). Any result that beats the leader is
                           submitted, margin or not

The modes are meant to run as separate processes, each with its own --state directory.

Benchmark (no server): polypack-native bench --N n --M m --P p [--seconds S] [--seed K]
  [--lanes L] [--clock cpu|wall]: one problem's search, printed as JSON.

Stop it with Ctrl-C: it submits the current problem's best if that beats the leader, saves its
state and exits within about 30 s. A second Ctrl-C exits at once.
",
        version = env!("CARGO_PKG_VERSION"),
        pp = default_parallel_problems(cores),
        state = m.home.join(".polypack-native").display(),
    )
}

/// "0,3-6,12" into the sorted distinct integers it names, each in [min, max] and allowed.
pub fn parse_int_list(text: &str, what: &str, min: u32, max: u32, allowed: impl Fn(u32) -> bool) -> Result<Vec<u32>, OptionError> {
    let mut out = std::collections::BTreeSet::new();
    for part in text.split(',').map(|s| s.trim()) {
        if part.is_empty() {
            return Err(OptionError(format!("--{what}: empty item in \"{text}\"")));
        }
        let (lo, hi) = match part.split_once('-') {
            Some((a, b)) => (a, b),
            None => (part, part),
        };
        let parse = |s: &str| -> Result<u32, OptionError> {
            if s.is_empty() || s.len() > 6 || !s.chars().all(|c| c.is_ascii_digit()) {
                return Err(OptionError(format!("--{what}: \"{part}\" is not an integer or a range a-b")));
            }
            Ok(s.parse().unwrap())
        };
        let (lo, hi) = (parse(lo)?, parse(hi)?);
        if hi < lo {
            return Err(OptionError(format!("--{what}: range \"{part}\" is reversed")));
        }
        if lo < min || hi > max {
            return Err(OptionError(format!("--{what}: \"{part}\" is outside {min}..{max}")));
        }
        for v in lo..=hi {
            if allowed(v) {
                out.insert(v);
            }
        }
    }
    if out.is_empty() {
        return Err(OptionError(format!("--{what}: \"{text}\" names no allowed value")));
    }
    Ok(out.into_iter().collect())
}

fn is_shape(v: u32) -> bool {
    v == 0 || (3..=MAX_SIDES).contains(&v)
}

fn positive_integer(name: &str, text: &str, max: usize) -> Result<usize, OptionError> {
    let t = text.trim();
    match t.parse::<usize>() {
        Ok(v) if (1..=max).contains(&v) && t.len() <= 9 => Ok(v),
        _ => Err(OptionError(format!("--{name} must be an integer from 1 to {max}"))),
    }
}

fn positive_number(name: &str, text: &str) -> Result<f64, OptionError> {
    match text.trim().parse::<f64>() {
        Ok(v) if v.is_finite() && v > 0.0 => Ok(v),
        _ => Err(OptionError(format!("--{name} must be a positive number"))),
    }
}

fn non_negative_number(name: &str, text: &str) -> Result<f64, OptionError> {
    match text.trim().parse::<f64>() {
        Ok(v) if v.is_finite() && v >= 0.0 => Ok(v),
        _ => Err(OptionError(format!("--{name} must be a number, 0 or more"))),
    }
}

/// --P and --max-P together: the numbers of pieces both allow; None when neither is given.
fn parse_pieces(list: Option<&str>, max: Option<&str>) -> Result<Option<Vec<usize>>, OptionError> {
    let listed = match list {
        Some(l) => Some(parse_int_list(l, "P", 1, MAX_PIECES as u32, |_| true)?.into_iter().map(|v| v as usize).collect::<Vec<_>>()),
        None => None,
    };
    let Some(max) = max else { return Ok(listed) };
    let cap = positive_integer("max-P", max, MAX_PIECES)?;
    match listed {
        None => Ok(Some((1..=cap).collect())),
        Some(l) => {
            let both: Vec<usize> = l.into_iter().filter(|&p| p <= cap).collect();
            if both.is_empty() {
                return Err(OptionError(format!("--P {} and --max-P {cap} together allow no number of pieces", list.unwrap_or_default())));
            }
            Ok(Some(both))
        }
    }
}

const VALUE_OPTIONS: &[&str] = &[
    "name",
    "base",
    "server",
    "cores",
    "parallel-problems",
    "hours",
    "minutes-per-problem",
    "N",
    "M",
    "P",
    "max-P",
    "state",
    "key-file",
    "note",
    "priority",
    "target-holder",
    "target-max-budget",
    "target-min-seconds",
    "target-margin",
    "kinds",
    "surface-modes",
    "solids",
    "max-N",
];
const FLAG_OPTIONS: &[&str] = &[
    "dry-run",
    "no-battery-pause",
    "once",
    "help",
    "version",
    "open-only",
    "target-refresh",
    "target-any-entry",
    "target-include-unknown",
    "sweep-2d-on-3d",
    "sweep-restart",
    "include-own",
    "one-pass",
];
/// Options that only the sweep takes.
const SWEEP_ONLY: &[&str] = &["kinds", "surface-modes", "solids", "max-N", "sweep-restart", "include-own", "one-pass"];
const UNSUPPORTED: &[&str] = &["dimensions", "spaces", "only-dimensions", "only-spaces", "space-method", "space-params"];

/// The options as name -> value (flags have "true"), from `--name value` or `--name=value`.
pub fn split_args(argv: &[String]) -> Result<Vec<(String, String)>, OptionError> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        let Some(rest) = a.strip_prefix("--") else {
            return Err(OptionError(format!("unexpected argument \"{a}\"")));
        };
        let (key, inline) = match rest.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (rest.to_string(), None),
        };
        if UNSUPPORTED.contains(&key.as_str()) {
            return Err(OptionError(format!("--{key}: this client searches flat problems only; the JavaScript client covers the other kinds")));
        }
        if FLAG_OPTIONS.contains(&key.as_str()) {
            if inline.is_some() {
                return Err(OptionError(format!("--{key} takes no value")));
            }
            out.push((key, "true".to_string()));
            i += 1;
            continue;
        }
        if !VALUE_OPTIONS.contains(&key.as_str()) {
            return Err(OptionError(format!("unknown option --{key}")));
        }
        let value = match inline {
            Some(v) => v,
            None => {
                i += 1;
                match argv.get(i) {
                    Some(v) => v.clone(),
                    None => return Err(OptionError(format!("--{key} needs a value"))),
                }
            }
        };
        out.push((key, value));
        i += 1;
    }
    Ok(out)
}

/// "a,b" into the names, each one of `allowed`, in the order of `allowed`, without repeats.
fn parse_names(what: &str, text: &str, allowed: &[&str]) -> Result<Vec<String>, OptionError> {
    let mut chosen = std::collections::BTreeSet::new();
    for part in text.split(',').map(|s| s.trim()) {
        match allowed.iter().position(|a| *a == part) {
            Some(i) => {
                chosen.insert(i);
            }
            None => return Err(OptionError(format!("--{what}: \"{part}\" is not one of {}", allowed.join(", ")))),
        }
    }
    Ok(chosen.into_iter().map(|i| allowed[i].to_string()).collect())
}

/// --solids: names and group names into the catalogue's names, in the catalogue's order.
fn parse_solids(text: &str) -> Result<Vec<String>, OptionError> {
    let all = polypack_spaces::surface_solids();
    let mut chosen = vec![false; all.len()];
    for part in text.split(',').map(|s| s.trim()) {
        let group: Option<&[String]> = match part {
            "platonic" => Some(polypack_spaces::surface_platonic()),
            "archimedean" => Some(polypack_spaces::surface_archimedean()),
            "catalan" => Some(polypack_spaces::surface_catalan()),
            "johnson" => Some(polypack_spaces::surface_johnson()),
            _ => None,
        };
        if let Some(g) = group {
            for s in g {
                chosen[all.iter().position(|a| a == s).unwrap()] = true;
            }
        } else if let Some(i) = all.iter().position(|a| a == part) {
            chosen[i] = true;
        } else {
            return Err(OptionError(format!(
                "--solids: \"{part}\" is not a solid of the surface catalogue (a name such as cube or snub_cube, or one of platonic, archimedean, catalan, johnson)"
            )));
        }
    }
    Ok(all.iter().zip(chosen).filter(|(_, c)| *c).map(|(s, _)| s.clone()).collect())
}

pub fn parse_options(argv: &[String], machine: &Machine) -> Result<Parsed, OptionError> {
    let pairs = split_args(argv)?;
    let get = |k: &str| pairs.iter().rev().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    let flag = |k: &str| pairs.iter().any(|(key, _)| key == k);
    if flag("help") {
        return Ok(Parsed::Help);
    }
    if flag("version") {
        return Ok(Parsed::Version);
    }
    if get("base").is_some() && get("server").is_some() {
        return Err(OptionError("--server and --base are the same option: give one of them".into()));
    }
    let base = get("server").or(get("base")).unwrap_or_else(|| DEFAULT_BASE.to_string()).trim().trim_end_matches('/').to_string();
    let host_ok = |rest: &str| !rest.is_empty() && !rest.starts_with('/') && !rest.chars().next().unwrap().is_whitespace();
    if !(base.strip_prefix("https://").map_or(false, host_ok) || base.strip_prefix("http://").map_or(false, host_ok)) {
        return Err(OptionError("--server must be an http(s) URL".into()));
    }
    let name = get("name").map(|n| n.trim().to_string());
    if name.as_deref() == Some("") {
        return Err(OptionError("--name is empty".into()));
    }
    if name.as_ref().map_or(false, |n| n.chars().count() > MAX_NAME_LENGTH) {
        return Err(OptionError(format!("--name is limited to {MAX_NAME_LENGTH} characters by the server")));
    }
    let note = get("note").unwrap_or_default().trim().to_string();
    if note.chars().count() > MAX_NOTE_LENGTH {
        return Err(OptionError(format!("--note is limited to {MAX_NOTE_LENGTH} characters by the server")));
    }
    let priority = get("priority").unwrap_or_else(|| "low".into());
    if priority != "low" && priority != "normal" {
        return Err(OptionError("--priority must be \"low\" or \"normal\"".into()));
    }
    let cores = match get("cores") {
        Some(v) => positive_integer("cores", &v, 1024)?,
        None => default_cores(machine),
    };
    let once = flag("once");
    let asked = match get("parallel-problems") {
        Some(v) => Some(positive_integer("parallel-problems", &v, 1024)?),
        None => None,
    };
    if once && asked.map_or(false, |a| a > 1) {
        return Err(OptionError("--once searches one problem: leave out --parallel-problems, or give 1".into()));
    }
    let parallel_problems = asked.unwrap_or(if once { 1 } else { default_parallel_problems(cores) });
    if parallel_problems > cores {
        return Err(OptionError(format!(
            "--parallel-problems ({parallel_problems}) is more than the search threads (--cores {cores}): each problem needs a thread"
        )));
    }
    let target_holder = get("target-holder").map(|h| h.trim().to_string());
    if target_holder.as_deref() == Some("") {
        return Err(OptionError("--target-holder is empty".into()));
    }
    if target_holder.as_ref().map_or(false, |h| h.chars().count() > MAX_NAME_LENGTH) {
        return Err(OptionError(format!("--target-holder: a name has at most {MAX_NAME_LENGTH} characters")));
    }
    let open_only = flag("open-only");
    if target_holder.is_some() && open_only {
        return Err(OptionError(
            "--target-holder and --open-only cannot be combined: a target is a problem with a leader, open-only skips those; run two processes with different --state directories".into(),
        ));
    }
    if target_holder.is_none() {
        for f in ["target-refresh", "target-any-entry", "target-max-budget", "target-include-unknown", "target-min-seconds", "target-margin"] {
            if pairs.iter().any(|(key, _)| key == f) {
                return Err(OptionError(format!("--{f} needs --target-holder NAME")));
            }
        }
    }
    let target_max_budget = match get("target-max-budget") {
        Some(v) => Some(non_negative_number("target-max-budget", &v)?),
        None => None,
    };
    if flag("target-include-unknown") && target_max_budget.is_none() {
        return Err(OptionError("--target-include-unknown needs --target-max-budget S (without it no budget is looked at)".into()));
    }
    let target_min_seconds = match get("target-min-seconds") {
        Some(v) => non_negative_number("target-min-seconds", &v)?,
        None => DEFAULT_TARGET_MIN_SECONDS,
    };
    let target_margin = match get("target-margin") {
        Some(v) => non_negative_number("target-margin", &v)?,
        None => DEFAULT_TARGET_MARGIN,
    };
    if target_margin >= 1.0 {
        return Err(OptionError("--target-margin is relative and must be below 1".into()));
    }
    let minutes_per_problem = match get("minutes-per-problem") {
        Some(v) => positive_number("minutes-per-problem", &v)?,
        None => DEFAULT_MINUTES_PER_PROBLEM,
    };
    if target_holder.is_some() && target_min_seconds > minutes_per_problem * 60.0 {
        return Err(OptionError(format!(
            "--target-min-seconds ({target_min_seconds}) is longer than --minutes-per-problem ({minutes_per_problem} minutes): no search could end early"
        )));
    }
    let p = parse_pieces(get("P").as_deref(), get("max-P").as_deref())?;
    let sweep = if flag("sweep-2d-on-3d") {
        if target_holder.is_some() {
            return Err(OptionError("--sweep-2d-on-3d searches 2D-on-3D problems: it cannot be combined with --target-holder".into()));
        }
        if pairs.iter().any(|(key, _)| key == "M") {
            return Err(OptionError("--M does not apply to --sweep-2d-on-3d (the containers are the surfaces); --N, --P and --max-P do".into()));
        }
        let kinds = match get("kinds") {
            Some(v) => parse_names("kinds", &v, &["surface", "sphere", "torus"])?,
            None => vec!["surface".into(), "sphere".into(), "torus".into()],
        };
        let kinds: Vec<SweepKind> = SweepKind::ALL.iter().copied().filter(|k| kinds.iter().any(|n| n == k.name())).collect();
        let surface_modes = match get("surface-modes") {
            Some(v) => parse_names("surface-modes", &v, &["fold", "nofold"])?,
            None => vec!["fold".into(), "nofold".into()],
        };
        let max_n = match get("max-N") {
            Some(v) => match v.trim().parse::<u32>() {
                Ok(k) if k <= MAX_SIDES && v.trim().len() <= 3 => Some(k),
                _ => return Err(OptionError(format!("--max-N must be an integer from 0 to {MAX_SIDES}"))),
            },
            None => None,
        };
        Some(SweepOptions {
            kinds,
            surface_modes,
            solids: match get("solids") {
                Some(v) => Some(parse_solids(&v)?),
                None => None,
            },
            max_n,
            restart: flag("sweep-restart"),
            include_own: flag("include-own"),
            open_only,
            one_pass: flag("one-pass"),
        })
    } else {
        if let Some((key, _)) = pairs.iter().find(|(key, _)| SWEEP_ONLY.contains(&key.as_str())) {
            return Err(OptionError(format!("--{key} needs --sweep-2d-on-3d")));
        }
        None
    };
    let mut state_dir = match get("state") {
        Some(s) => PathBuf::from(s),
        None => machine.home.join(".polypack-native"),
    };
    let text = state_dir.to_string_lossy().to_string();
    if text == "~" || text.starts_with("~/") {
        state_dir = machine.home.join(text.trim_start_matches('~').trim_start_matches('/'));
    }
    if !state_dir.is_absolute() {
        state_dir = std::env::current_dir().unwrap_or_default().join(state_dir);
    }
    let dry_run = flag("dry-run") || name.is_none();
    let key_file = get("key-file").map(|f| {
        let f = PathBuf::from(&f);
        let text = f.to_string_lossy().to_string();
        if text == "~" || text.starts_with("~/") {
            machine.home.join(text.trim_start_matches('~').trim_start_matches('/'))
        } else {
            f
        }
    });
    Ok(Parsed::Run(Options {
        name,
        base,
        cores,
        parallel_problems,
        hours: match get("hours") {
            Some(v) => positive_number("hours", &v)?,
            None => f64::INFINITY,
        },
        minutes_per_problem,
        n: match get("N") {
            Some(v) => Some(parse_int_list(&v, "N", 0, MAX_SIDES, is_shape)?),
            None => None,
        },
        m: match get("M") {
            Some(v) => Some(parse_int_list(&v, "M", 0, MAX_SIDES, is_shape)?),
            None => None,
        },
        p,
        dry_run,
        state_dir,
        key_file,
        note,
        battery_pause: !flag("no-battery-pause"),
        low_priority: priority == "low",
        once,
        open_only,
        target_refresh: flag("target-refresh"),
        target_any_entry: flag("target-any-entry"),
        target_include_unknown: flag("target-include-unknown"),
        target_holder,
        target_max_budget,
        target_min_seconds,
        target_margin,
        sweep,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine() -> Machine {
        Machine { available_parallelism: 8, home: PathBuf::from("/home/u") }
    }

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn defaults_and_lists() {
        let Parsed::Run(o) = parse_options(&[], &machine()).unwrap() else { panic!() };
        assert_eq!(o.cores, 7);
        assert_eq!(o.parallel_problems, 2);
        assert!(o.dry_run);
        assert_eq!(o.state_dir, PathBuf::from("/home/u/.polypack-native"));
        let Parsed::Run(o) = parse_options(&args(&["--name", "x", "--N", "0,3-5", "--server=http://localhost:9000/", "--once"]), &machine()).unwrap() else { panic!() };
        assert_eq!(o.n, Some(vec![0, 3, 4, 5]));
        assert_eq!(o.base, "http://localhost:9000");
        assert!(!o.dry_run);
        assert_eq!(o.parallel_problems, 1);
        assert!(parse_options(&args(&["--N", "1"]), &machine()).is_err());
        assert!(parse_options(&args(&["--dimensions", "all"]), &machine()).is_err());
        assert!(parse_options(&args(&["--server", "ftp://x"]), &machine()).is_err());
    }

    #[test]
    fn sweep_options() {
        let run = |a: &[&str]| match parse_options(&args(a), &machine()) {
            Ok(Parsed::Run(o)) => Ok(o),
            Ok(_) => panic!(),
            Err(e) => Err(e.0),
        };
        assert_eq!(run(&[]).unwrap().sweep, None);
        let o = run(&["--sweep-2d-on-3d"]).unwrap().sweep.unwrap();
        assert_eq!(o.kinds, SweepKind::ALL.to_vec());
        assert_eq!(o.surface_modes, vec!["fold", "nofold"]);
        assert!(o.solids.is_none() && o.max_n.is_none() && !o.restart && !o.include_own);
        let o = run(&["--sweep-2d-on-3d", "--kinds", "torus,surface", "--surface-modes=nofold", "--solids", "snub_cube,cube", "--max-N", "6", "--sweep-restart", "--include-own"])
            .unwrap()
            .sweep
            .unwrap();
        assert_eq!(o.kinds, vec![SweepKind::Surface, SweepKind::Torus]);
        assert_eq!(o.surface_modes, vec!["nofold"]);
        assert_eq!(o.solids, Some(vec!["cube".to_string(), "snub_cube".to_string()]));
        assert_eq!(o.max_n, Some(6));
        assert!(o.restart && o.include_own);
        assert_eq!(run(&["--sweep-2d-on-3d", "--solids", "platonic"]).unwrap().sweep.unwrap().solids.unwrap().len(), 5);
        assert!(run(&["--sweep-2d-on-3d", "--kinds", "flat"]).is_err());
        assert!(run(&["--sweep-2d-on-3d", "--solids", "cub"]).is_err());
        assert!(run(&["--sweep-2d-on-3d", "--max-N", "101"]).is_err());
        assert!(run(&["--sweep-2d-on-3d", "--M", "4"]).is_err());
        assert!(run(&["--sweep-2d-on-3d", "--open-only"]).unwrap().sweep.unwrap().open_only);
        assert!(!run(&["--sweep-2d-on-3d"]).unwrap().sweep.unwrap().open_only);
        assert!(run(&["--sweep-2d-on-3d", "--target-holder", "jg"]).is_err());
        assert!(run(&["--kinds", "sphere"]).unwrap_err().contains("needs --sweep-2d-on-3d"));
        assert!(run(&["--include-own"]).is_err());
        assert_eq!(run(&["--sweep-2d-on-3d", "--max-P", "5"]).unwrap().p, Some(vec![1, 2, 3, 4, 5]));
    }

    #[test]
    fn pieces_and_target_mode() {
        let run = |a: &[&str]| match parse_options(&args(a), &machine()) {
            Ok(Parsed::Run(o)) => Ok(o),
            Ok(_) => panic!(),
            Err(e) => Err(e.0),
        };
        assert_eq!(run(&["--P", "3,10-12"]).unwrap().p, Some(vec![3, 10, 11, 12]));
        assert_eq!(run(&["--key-file", "~/k.txt"]).unwrap().key_file, Some(PathBuf::from("/home/u/k.txt")));
        assert_eq!(run(&["--key-file=/etc/k"]).unwrap().key_file, Some(PathBuf::from("/etc/k")));
        assert_eq!(run(&[]).unwrap().key_file, None);
        assert_eq!(run(&["--P", "3,10-12", "--max-P", "10"]).unwrap().p, Some(vec![3, 10]));
        assert_eq!(run(&["--max-P", "3"]).unwrap().p, Some(vec![1, 2, 3]));
        assert!(run(&["--P", "20-30", "--max-P", "10"]).is_err());
        assert!(run(&["--P", "501"]).is_err());
        let o = run(&["--target-holder", " jg-claude ", "--target-max-budget", "30", "--target-include-unknown"]).unwrap();
        assert_eq!(o.target_holder.as_deref(), Some("jg-claude"));
        assert_eq!((o.target_max_budget, o.target_min_seconds, o.target_margin), (Some(30.0), 10.0, 1e-6));
        assert!(o.target_include_unknown && !o.target_any_entry && !o.open_only);
        assert!(run(&["--target-holder", "jg", "--open-only"]).is_err());
        assert!(run(&["--target-margin", "0.01"]).is_err());
        assert!(run(&["--target-holder", "jg", "--target-include-unknown"]).is_err());
        assert!(run(&["--target-holder", "jg", "--target-margin", "1"]).is_err());
        assert!(run(&["--target-holder", "jg", "--target-min-seconds", "90", "--minutes-per-problem", "1"]).is_err());
        assert!(run(&["--target-holder", ""]).is_err());
        assert!(run(&["--open-only"]).unwrap().open_only);
    }
}
