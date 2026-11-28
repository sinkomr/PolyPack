//! One problem of a kind beyond Flat (a space): the main loop (volunteer.rs) draws it by its id,
//! and this reads it (GET /api/spaces/:space/problems/<id>), skips it when it is closed or unknown,
//! searches it with its share of the threads (space_engine.rs, a port of the TypeScript engine's
//! policy, over each space's Auto search, real_search.rs), checks the best with the server's own
//! validator, reads the leader again, decides as the TypeScript client does (space_api.rs) and
//! submits to POST /api/spaces/submit, with the client's pacing and retries.

use crate::answers::{clean_text, describe_answer};
use crate::format::{format_duration, format_score, iso_now, relative_percent};
use crate::http::{Answer, Api, SubmitCheck, SubmitOutcome};
use crate::space_api::{
    best_ref, build_known, check_job_result, check_space_config, check_space_stored, decide_space_submission, read_space_problem, read_space_submit_response, space_submission_body,
    BestRef, DecideArgs, Rule, SpaceProblemInfo,
};
use crate::space_engine::{search_space_problem, Candidate, SpaceSearchInput};
use crate::state::random_u32;
use crate::fresh_engines::{self, Event, FreshRun};
use crate::sweep_order::Taken;
use crate::volunteer::{log, Current, Searched, Shared, SOFTWARE, UNITS};
use polypack_flat::validate::improves_on;
use polypack_flat::Control;
use polypack_spaces::{parse_space_id, SpaceName};
use crate::options::EngineChoice;
use crate::space_engine::{Known, SpaceOutcome};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// The problem as the server describes it, and the answer it came in.
fn read_problem(api: &Api, space: SpaceName, id: &str) -> (Option<SpaceProblemInfo>, Option<Answer>) {
    let a = api.space_problem(space.as_str(), id);
    let info = a.as_ref().filter(|a| a.status == 200).and_then(|a| {
        let parsed = parse_space_id(space, id).ok()?;
        read_space_problem(&a.body, &parsed)
    });
    (info, a)
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

/// A space problem searched by a fresh engine, one job per lane (fresh_engines.rs); None when no engine handles
/// it: the port searches it.
#[allow(clippy::too_many_arguments)]
fn space_fresh(
    s: &Arc<Shared>,
    space_name: SpaceName,
    id: &str,
    cur: &Arc<Current>,
    known: Option<&Known>,
    bound: Option<f64>,
    rule: &Rule,
    lanes: usize,
    seconds: f64,
    seed: u32,
    sub: &str,
) -> Option<SpaceOutcome> {
    if !fresh_engines::claimed(&s.fresh, id) {
        return None;
    }
    let check = |c: &Value, claimed: f64| check_job_result(space_name, id, c, claimed, rule);
    let run = FreshRun { id, lanes, seed, seconds, halt: &cur.halt, start: known.map(|k| &k.config), bound, low_priority: s.o.low_priority, check: &check };
    log(&format!("{sub}searching with the fresh engine on {lanes} lane(s)"));
    let on_event = |e: Event| match e {
        Event::Best(f) => {
            let mut cb = cur.best.lock().unwrap();
            // improvements below 1e-9 relative are rounding: not worth a line
            if cb.map_or(true, |x| f.score < x * (1.0 - 1e-9)) {
                *cb = Some(f.score);
                let vs = cur.leader.lock().unwrap().map_or(String::new(), |l| format!(", {} against the best", relative_percent(f.score, l)));
                log(&format!("{sub}best so far {} ({}, fresh, seed {}){vs}", format_score(f.score), f.method, f.seed));
            }
        }
        Event::Rejected { seed, why } => log(&format!("{sub}a lane's packing was not used (seed {seed}): {}", clean_text(why, 200))),
        Event::Lost { seed, why } => log(&format!("{sub}a lane failed (seed {seed}): {}", clean_text(why, 200))),
        Event::LaneDone => {
            cur.jobs.fetch_add(1, Ordering::Relaxed);
        }
    };
    let out = fresh_engines::search(&s.fresh, &run, &on_event)?;
    let best = out.best.map(|f| Candidate { config: f.config, score: f.score, seed: f.seed, method: f.method, kind: "fresh", time_s: seconds, evals: None });
    let stopped = match out.stopped {
        "halted" if s.stopped() => "aborted",
        "halted" => "paused",
        "bound" => "bound",
        "stagnation" => "stagnation",
        _ => "time",
    };
    Some(SpaceOutcome { best, jobs: out.jobs, evaluations: out.evaluations, stopped, crashed: out.crashed })
}

/// Searches one problem and submits its best if it qualifies. `tag` is the sweep's position of the problem.
pub(crate) fn search_space(s: &Arc<Shared>, space_name: SpaceName, id: &str, lanes: usize, tag: Option<&Taken>) -> Searched {
    let space = space_name.as_str();
    let label = id.to_string();
    if s.o.engine == EngineChoice::Fresh && !fresh_engines::claimed(&s.fresh, id) {
        // no fresh engine handles it: nothing is read, and it is not drawn again
        s.skip_until.lock().unwrap().insert(id.to_string(), i64::MAX);
        return Searched::Held;
    }
    let Some(searcher) = s.searcher.clone() else {
        log(&format!("{id}: this build has no search for {space}; skipping it"));
        return Searched::Skipped;
    };
    let Ok(parsed) = parse_space_id(space_name, id) else {
        log(&format!("{id} is not a problem id of the spaces: skipping it"));
        return Searched::Skipped;
    };
    let (info, answer) = read_problem(&s.reader, space_name, id);
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
    // --open-only: a problem with a best (a site entry or a research record) is not searched
    if s.o.open_only && info.best_score.is_some() {
        return Searched::Held;
    }
    if let (Some(sw), Some(name), Some(l)) = (&s.sweep, s.o.name.as_deref(), &info.site_best) {
        if !sw.o.include_own && crate::answers::stored_name(&l.name) == crate::answers::stored_name(name) {
            log(&format!("{label} is led by \"{}\" (entry #{}, {}): skipping it (--include-own searches it again)", clean_text(&l.name, 60), l.id, format_score(l.score)));
            return Searched::Skipped;
        }
    }
    let before = best_ref(&info);
    let known = build_known(&info);
    let rule = Rule { bound: info.bound, certified: info.certified.as_ref().map(|c| c.0), no_record: info.no_record };
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
        leader: Mutex::new(info.best_score),
        halt: std::sync::atomic::AtomicBool::new(s.stopped() || s.paused.load(Ordering::Relaxed)),
    });
    s.currents.lock().unwrap().push(cur.clone());
    log(&format!(
        "Searching {label}{}: best {}, lower bound {}; starting from {}; up to {} on {lanes} thread(s)",
        tag.map_or(String::new(), |t| format!(" (pass {}, loop {}, problem {} of {})", t.pass, t.k, t.index + 1, t.size)),
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
    let fresh_outcome = space_fresh(s, space_name, id, &cur, known.as_ref(), info.bound, &rule, lanes, max_seconds, engine_seed, &sub);
    let outcome = fresh_outcome.unwrap_or_else(|| search_space_problem(&input, searcher.as_ref(), &control, &mut |r, best| {
        cur.jobs.fetch_add(1, Ordering::Relaxed);
        if !r.valid {
            if let Some(why) = r.reason.as_deref().filter(|_| r.failed || r.score.is_none()) {
                if r.crashed || r.failed {
                    log(&format!("{sub}a job failed ({} job, seed {}): {}", r.kind, r.seed, clean_text(why, 200)));
                } else {
                    log(&format!("{sub}a job's result was not used ({} job, seed {}): {}", r.kind, r.seed, clean_text(why, 200)));
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
    }));
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
        let (fresh, fresh_answer) = read_problem(&s.submitter, space_name, id);
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
                        let (again, _) = read_problem(&s.submitter, space_name, id);
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
        "sweep": tag.map_or(Value::Null, |t| json!({ "pass": t.pass, "loop": t.k, "index": t.index })),
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
