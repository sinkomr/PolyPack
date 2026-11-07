//! Command-line options, matching the JavaScript client's (apps/volunteer/src/options.ts) where
//! they apply to flat problems. Parsing is pure: the machine's core count and home directory are
//! passed in.

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
    pub max_p: Option<usize>,
    /// True when nothing is submitted: --dry-run, or no --name.
    pub dry_run: bool,
    pub state_dir: PathBuf,
    pub note: String,
    pub battery_pause: bool,
    pub low_priority: bool,
    pub once: bool,
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
  --max-P K                only problems of at most K pieces
  --dry-run                search, but never submit
  --note TEXT              free text shown with your entries (at most {MAX_NOTE_LENGTH} characters)
  --state DIR              where the client keeps its state (default {state})
  --priority low|normal    CPU priority of the search threads (default low)
  --no-battery-pause       keep searching on battery power (by default it pauses)
  --once                   search one problem, then exit
  --help                   this text
  --version                the version

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

const VALUE_OPTIONS: &[&str] = &["name", "base", "server", "cores", "parallel-problems", "hours", "minutes-per-problem", "N", "M", "max-P", "state", "note", "priority"];
const FLAG_OPTIONS: &[&str] = &["dry-run", "no-battery-pause", "once", "help", "version"];
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
    Ok(Parsed::Run(Options {
        name,
        base,
        cores,
        parallel_problems,
        hours: match get("hours") {
            Some(v) => positive_number("hours", &v)?,
            None => f64::INFINITY,
        },
        minutes_per_problem: match get("minutes-per-problem") {
            Some(v) => positive_number("minutes-per-problem", &v)?,
            None => DEFAULT_MINUTES_PER_PROBLEM,
        },
        n: match get("N") {
            Some(v) => Some(parse_int_list(&v, "N", 0, MAX_SIDES, is_shape)?),
            None => None,
        },
        m: match get("M") {
            Some(v) => Some(parse_int_list(&v, "M", 0, MAX_SIDES, is_shape)?),
            None => None,
        },
        max_p: match get("max-P") {
            Some(v) => Some(positive_integer("max-P", &v, MAX_PIECES)?),
            None => None,
        },
        dry_run,
        state_dir,
        note,
        battery_pause: !flag("no-battery-pause"),
        low_priority: priority == "low",
        once,
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
}
