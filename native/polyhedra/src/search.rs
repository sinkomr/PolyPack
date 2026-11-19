//! The search of the polyhedra family: seeded, budgeted, stoppable. Port of `packages/polyhedra/src/search.ts`.
//!
//!  1. Start. A given configuration (any scale; an invalid one is first legalized by moving its pieces apart) is
//!     polished; without one, a soft-to-rigid run of the simulator (sim.rs) packs balls that harden into the
//!     solids, and its result is polished.
//!  2. Hops, until the budget ends: from the best configuration, either a soft hop of the simulator (expand by
//!     0.5-3 %, soften, shake until the arrangement changes, re-harden; upstream's gentle hop) or a jiggle (expand
//!     by 0.5-3 % and move and turn one to three pieces at random), then a polish. A hop result replaces the best
//!     when it is smaller.
//!
//! Every configuration returned is legalized (polish.rs) and checked with the validator at tolerance 0. The budget
//! `max_evals` counts simulator steps and polish function evaluations, so a run that ends on evaluations is
//! reproducible from its seed; `should_stop` is polled at every evaluation and in the work between them.
//!
//! Not ported, because the job runner never sets them: `maxSeconds` and `now`, `onProgress`, `log`, `schedule`
//! and `clearance` (the defaults are used).

// The port keeps the source's index loops and its NaN-aware comparisons (`!(a < b)` is not `a >= b`), line by line.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::geom::Pose;
use crate::polish::{legalize_config, polish_config, PolishOptions};
use crate::problems::PolyhedraProblem;
use crate::sim::{gauss, hop, make_problem, run, to_int32, Gate, Halt, HopConfig, Rng, SimResult, Why};
use crate::solids::get_solid;
use crate::validate::{validate_polyhedra, PolyhedraConfig, ValidateOptions};
use polypack_js::math;
use std::cell::Cell;

/// `search.ts: PolyhedraSearchOptions`.
pub struct PolyhedraSearchOptions<'a> {
    pub seed: f64,
    /// Configuration to start from (any scale).
    pub start: Option<&'a PolyhedraConfig>,
    /// True when the start is this search's own polished result: it is legalized and taken as it is, not polished
    /// again.
    pub start_polished: bool,
    /// Most simulator steps plus polish evaluations; the source's default is 200,000.
    pub max_evals: f64,
    /// Polled at every evaluation: true ends the run with the best so far.
    pub should_stop: &'a dyn Fn() -> bool,
}

/// `search.ts: PolyhedraSearchResult`.
#[derive(Debug)]
pub struct PolyhedraSearchResult {
    /// The best configuration found, valid by `validate_polyhedra` at tolerance 0, or None.
    pub config: Option<PolyhedraConfig>,
    /// Its s; Infinity when there is none.
    pub score: f64,
    /// s of the polished start, or None without a start.
    pub start_score: Option<f64>,
    pub evaluations: u64,
    pub hops: u64,
    pub stopped: Why,
}

/// `search.ts: fromSim`: converts a simulator packing (internal units, container size L) to a configuration.
fn from_sim(scale: f64, s_of_l: impl Fn(f64) -> f64, r: &SimResult) -> PolyhedraConfig {
    PolyhedraConfig {
        s: s_of_l(r.l),
        pieces: r
            .c
            .iter()
            .zip(&r.q)
            .map(|(c, q)| [c[0] / scale, c[1] / scale, c[2] / scale, q[0], q[1], q[2], q[3]] as Pose)
            .collect(),
    }
}

/// `search.ts: searchPolyhedra`. `Err` where the source throws something other than a stop: a P that is not a
/// positive integer, a start of the wrong size or with a zero quaternion, an unknown solid.
pub fn search_polyhedra(problem: &PolyhedraProblem, p: usize, o: &PolyhedraSearchOptions) -> Result<PolyhedraSearchResult, String> {
    if p < 1 {
        return Err("P must be a positive integer".to_string());
    }
    let max_evals = o.max_evals;
    let g = 1e-12;
    let mut rng = Rng::new(o.seed * 2654435761.0);
    let gate = Gate { evaluations: Cell::new(0), max_evals, should_stop: o.should_stop };
    let pb = make_problem(&problem.piece, &problem.container)?;
    let scale = pb.p.edge;
    let mut best: Option<PolyhedraConfig> = None;
    let mut hops = 0u64;
    let mut start_score: Option<f64> = None;
    let pf = p as f64;

    // `accept`: keeps a valid configuration that is smaller than the best
    let accept = |best: &mut Option<PolyhedraConfig>, c: PolyhedraConfig| -> Result<bool, Halt> {
        let v = validate_polyhedra(problem, &c, &ValidateOptions { tol: Some(0.0), ..Default::default() })?;
        if !v.valid {
            return Ok(false);
        }
        if let Some(b) = best {
            if !(c.s < b.s) {
                return Ok(false);
            }
        }
        *best = Some(c);
        Ok(true)
    };
    // `polish` followed by `accept`, with the partial result of a polish that a stop cut short accepted as the
    // source's catch blocks do, and the stop passed on
    let polish_accept = |best: &mut Option<PolyhedraConfig>, c: &PolyhedraConfig, mus: Option<&[f64]>| -> Result<bool, Halt> {
        let r = polish_config(
            problem,
            c,
            &PolishOptions { pair_clearance: g, wall_clearance: g, mus, gate: &gate },
        )?;
        if let Some(why) = r.stopped {
            accept(best, r.config)?;
            return Err(Halt::Stop(why));
        }
        accept(best, r.config)
    };

    let mut body = || -> Result<(), Halt> {
        // 1. start
        if let Some(start) = o.start {
            if start.pieces.len() != p {
                return Err(Halt::Error(format!("the start has {} pieces, not {}", start.pieces.len(), p)));
            }
            let legal = legalize_config(problem, start, g, g, &gate)?;
            accept(&mut best, legal.clone())?;
            if !o.start_polished {
                polish_accept(&mut best, &legal, Some(&[1e4, 1e5, 1e6, 1e7, 1e8, 1e9]))?;
            }
            start_score = best.as_ref().map(|b| b.s);
        } else {
            let mut sch = (
                math::min(5000.0, 600.0 + 60.0 * pf),
                math::min(45000.0, 4000.0 + 600.0 * pf),
                math::min(3000.0, 500.0 + 50.0 * pf),
            );
            // the run must finish within the budget to give anything: at most 40 % of maxEvals
            let total = sch.0 + sch.1 + sch.2;
            if total > 0.4 * max_evals {
                let f = (0.4 * max_evals) / total;
                sch = (math::ceil(sch.0 * f), math::ceil(sch.1 * f), math::ceil(sch.2 * f));
            }
            let r = run(&pb, o.seed, p, sch, &gate)?;
            let fresh = from_sim(scale, |l| pb.s_of_l(l), &r);
            let legal = legalize_config(problem, &fresh, g, g, &gate)?;
            accept(&mut best, legal)?;
            polish_accept(&mut best, &fresh, None)?;
        }
        // 2. hops
        loop {
            let Some(b) = best.clone() else {
                return Err(Halt::Stop(Why::Evals));
            };
            hops += 1;
            // A soft hop has 3,800 + 120 P steps when the budget leaves room for them and a polish; with less
            // left (the board's short rounds of many large solids) it is shortened to 60 % of what is left, and
            // below a tenth of its length it gives way to a jiggle, which needs only a polish. The budget is
            // known in advance, so this keeps a run that ends on its evaluations reproducible.
            let morph0 = 3000.0 + 100.0 * pf;
            let settle0 = 800.0 + 20.0 * pf;
            let room = math::min(1.0, (0.6 * (max_evals - gate.evaluations.get() as f64)) / (morph0 + settle0));
            let soft = p > 1 && rng.next() < 0.5 && room >= 0.1;
            let cand: PolyhedraConfig = if soft {
                let l = pb.l_of_s(b.s);
                let c: Vec<[f64; 3]> = b.pieces.iter().map(|q| [q[0] * scale, q[1] * scale, q[2] * scale]).collect();
                let q: Vec<[f64; 4]> = b
                    .pieces
                    .iter()
                    .map(|q| {
                        let m = math::hypot4(q[3], q[4], q[5], q[6]);
                        [q[3] / m, q[4] / m, q[5] / m, q[6] / m]
                    })
                    .collect();
                // the options in the source's object-literal order, which is the order of the random draws
                let expand = 0.005 + 0.025 * rng.next();
                let min_diff = 0.02 + 0.08 * rng.next();
                let rh = 0.06 + 0.14 * rng.next();
                let focus = if rng.next() < 0.6 { math::max(2.0, math::floor(pf / 3.0)) as usize } else { 0 };
                let h = hop(
                    &pb,
                    &HopConfig {
                        c: &c,
                        q: &q,
                        l,
                        seed: to_int32(o.seed * 7919.0 + hops as f64) as f64,
                        expand,
                        rh,
                        min_diff,
                        morph: math::round(morph0 * room),
                        settle: math::round(settle0 * room),
                        focus,
                    },
                    &gate,
                )?;
                from_sim(scale, |l| pb.s_of_l(l), &h)
            } else {
                let e = 1.0 + 0.005 + 0.025 * rng.next();
                let k = 1.0 + math::floor(rng.next() * math::min(3.0, pf));
                let mut pieces: Vec<Pose> =
                    b.pieces.iter().map(|q| [q[0] * e, q[1] * e, q[2] * e, q[3], q[4], q[5], q[6]]).collect();
                let edge = get_solid(&problem.piece)?.inradius;
                let mut t = 0.0;
                while t < k {
                    let i = math::floor(rng.next() * pf) as usize;
                    let q = pieces[i];
                    let a = 0.3 * rng.next();
                    pieces[i] = [
                        q[0] + edge * 0.5 * gauss(&mut rng),
                        q[1] + edge * 0.5 * gauss(&mut rng),
                        q[2] + edge * 0.5 * gauss(&mut rng),
                        q[3] + a * gauss(&mut rng),
                        q[4] + a * gauss(&mut rng),
                        q[5] + a * gauss(&mut rng),
                        q[6] + a * gauss(&mut rng),
                    ];
                    t += 1.0;
                }
                PolyhedraConfig { s: b.s * e, pieces }
            };
            let mus: Option<&[f64]> = if soft { None } else { Some(&[1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9]) };
            polish_accept(&mut best, &cand, mus)?;
        }
    };
    let stopped = match body() {
        Ok(()) => unreachable!("the hop loop ends only by a stop"),
        Err(Halt::Stop(why)) => why,
        Err(Halt::Error(e)) => return Err(e),
    };
    let score = best.as_ref().map_or(f64::INFINITY, |b| b.s);
    Ok(PolyhedraSearchResult {
        config: best,
        score,
        start_score,
        evaluations: gate.evaluations.get().min(if max_evals < 1.8e19 { max_evals as u64 } else { u64::MAX }),
        hops,
        stopped,
    })
}
