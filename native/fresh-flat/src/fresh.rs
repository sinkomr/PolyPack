//! The client's entry point (`polypack_spaceauto::FreshSearch`): one whole search of one flat problem
//! `flat/<N>/<M>/<P>` (N = 0 or 3 to 16 sides, M = 0 or 3 to 100, P = 2 to 500) on the calling thread.
//! The search is `Search::run`, the same as the binary's; this adds the client's stop flag and wall
//! deadline to the places where it reads its CPU clock, and reports each checked improvement.

use crate::search::Search;
use polypack_flat::clock::thread_cpu_seconds;
use polypack_flat::shapes::Config;
use polypack_flat::validate::server_check;
use polypack_spaceauto::{FreshJob, FreshResult};
use serde_json::{json, Value};

/// `flat/<N>/<M>/<P>` as (N, M, P), when this engine searches it.
pub fn parse_id(id: &str) -> Option<(usize, usize, usize)> {
    let parts: Vec<&str> = id.split('/').collect();
    if parts.len() != 4 || parts[0] != "flat" {
        return None;
    }
    let (n, m, p) = (parts[1].parse::<usize>().ok()?, parts[2].parse::<usize>().ok()?, parts[3].parse::<usize>().ok()?);
    let ok = (n == 0 || (3..=16).contains(&n)) && (m == 0 || (3..=100).contains(&m)) && (2..=500).contains(&p);
    ok.then_some((n, m, p))
}

/// The submission format of a flat configuration.
pub fn config_json(cfg: &Config, n: usize, m: usize, p: usize) -> Value {
    let pieces: Vec<Value> = cfg.pieces.iter().map(|q| json!({"x": q.x, "y": q.y, "theta": q.theta})).collect();
    json!({"N": n, "M": m, "P": p, "container_phi": cfg.phi, "pieces": pieces})
}

/// Searches the flat problem `job.id` until the CPU budget, the wall deadline, the stop flag or the
/// evaluation budget ends it. `job.start` is not used. Err for an id this engine does not handle.
pub fn fresh_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
    let (n, m, p) = parse_id(job.id).ok_or_else(|| format!("fresh-flat does not search {}", job.id))?;
    let t0 = thread_cpu_seconds();
    let mut relay = |score: f64, cfg: &Config| on_improve(score, &config_json(cfg, n, m, p));
    let mut s = Search::new(n, m, p, job.seed, t0);
    s.model.deadline = t0 + job.cpu_seconds;
    s.model.stop = Some(job.stop);
    s.model.wall = Some(job.deadline);
    if let Some(e) = job.max_evals {
        s.model.eval_limit = e;
    }
    s.on_improve = Some(&mut relay);
    s.run();
    let evaluations = s.model.evals;
    let stopped = if s.model.halt.is_empty() { "cpu" } else { s.model.halt };
    let best = if s.best_q.is_empty() {
        None
    } else {
        let cfg = s.config(&s.best_q);
        let chk = server_check(&cfg, p);
        (chk.valid && chk.strict).then(|| (chk.score, config_json(&cfg, n, m, p)))
    };
    let (score, config) = match best {
        Some((Some(score), config)) => (Some(score), Some(config)),
        _ => (None, None),
    };
    Ok(FreshResult { config, score, evaluations, stopped: stopped.into(), method: "fresh flat".into() })
}
