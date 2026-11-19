//! The search of the balls family: seeded, budgeted, stoppable and synchronous. Port of
//! `packages/balls/src/search.ts` (`searchBalls`); its file comment describes it:
//!
//!  1. Start. A given configuration (any size; an invalid one is first legalized) is polished, unless it is this
//!     search's own polished result (`start_polished`). Without one, a new start: for balls random centres or a
//!     cut of a lattice packing; for solids the circumscribed balls of the pieces placed as a lattice cut of unit
//!     balls, turned at random, or for cubes a cut of the cubic lattice. It is polished.
//!  2. Hops until the budget ends, from the best so far, one in ten a new start instead; each is polished and
//!     legalized, and a smaller result replaces the best.
//!
//! Every configuration kept is legalized with the clearance (default `BALLS_CLEARANCE`, 1e-10, between pieces
//! and from the container) and checked with the validator at tolerance 0.
//!
//! Budget: `max_evals` counts objective evaluations of the polish, so a run that ends on its evaluations is
//! reproducible from its seed; `should_stop` is polled at every evaluation and in the work between evaluations
//! (pair lists, legalizations) and ends the run with its best so far, a partly polished candidate included when
//! it is valid and better. (The source's `maxSeconds`, `now`, `onProgress` and `log` options are not used by
//! the Auto search and are not ported.)

// Index loops and negated comparisons are kept as the source writes them: `!(a < b)` is not `a >= b` for NaN (native/PORTING.md, rule 4).
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::ball_pieces::{
    fresh_start, hop_balls, lattice_cut, legalize_balls, polish_balls, centres_of, Hops, BALL_MUS,
};
use crate::catalogue::{balls_problem_of, BallsProblem, BALL_RADIUS};
use crate::random::Rng;
use crate::solid_pieces::{
    cube_lattice_cut, hop_solids, legalize_solids, polish_solids, solids_at, SOLID_MUS,
};
use crate::stop::{Fail, Stop, Ticker, Why};
use crate::validate::{validate_balls, BallsConfig, BallsValidateOptions};
use polypack_js::math;
use polypack_polyhedra::get_solid;

/// `search.ts: BALLS_CLEARANCE`: clearance of the search's results between pieces and from the container: far
/// above the float error of the validators at these sizes (about 1e-14) and far below the tie tolerance 1e-9.
pub const BALLS_CLEARANCE: f64 = 1e-10;

/// `BallsSearchOptions`.
pub struct BallsSearchOptions<'a> {
    pub seed: u32,
    /// Configuration to start from (any size).
    pub start: Option<&'a BallsConfig>,
    /// True when the start is this search's own polished result: it is legalized and taken as it is.
    pub start_polished: bool,
    /// Most objective evaluations; the source's default is 200,000.
    pub max_evals: u64,
    /// Polled at every evaluation: true ends the run with the best so far.
    pub should_stop: Option<&'a dyn Fn() -> bool>,
    /// Clearance between pieces and from the container; default `BALLS_CLEARANCE`.
    pub clearance: Option<f64>,
    pub hops: Hops,
}

impl BallsSearchOptions<'_> {
    pub fn new(seed: u32) -> Self {
        BallsSearchOptions {
            seed,
            start: None,
            start_polished: false,
            max_evals: 200_000,
            should_stop: None,
            clearance: None,
            hops: Hops::Holes,
        }
    }
}

/// `BallsSearchResult.stopped` (the source's "done" never happens: the loop ends only by a stop).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    Evals,
    Aborted,
}

/// `BallsSearchResult`.
#[derive(Clone, Debug)]
pub struct BallsSearchResult {
    /// The best configuration found, valid by `validate_balls` at tolerance 0, or None.
    pub config: Option<BallsConfig>,
    /// Its s; Infinity when there is none.
    pub score: f64,
    /// s of the (polished) start, or None without a start.
    pub start_score: Option<f64>,
    pub evaluations: u64,
    pub hops: u64,
    pub stopped: Stopped,
}

/// The state of one `searchBalls` call: the closures of the source's function body.
struct Run<'a> {
    problem: &'static BallsProblem,
    p: usize,
    balls: bool,
    clearance: f64,
    rng: Rng,
    tk: Ticker<'a>,
    best: Option<BallsConfig>,
}

impl Run<'_> {
    /// `accept`: keeps a smaller configuration valid at tolerance 0.
    fn accept(&mut self, c: BallsConfig) -> Result<bool, Fail> {
        if let Some(b) = &self.best {
            if !(c.s < b.s) {
                return Ok(false);
            }
        }
        let v = validate_balls(self.problem, &c, &BallsValidateOptions { tol: Some(0.0), max_errors: None })?;
        if !v.valid {
            return Ok(false);
        }
        self.best = Some(c);
        Ok(true)
    }

    /// `legalize`.
    fn legalize(&mut self, c: &BallsConfig) -> Result<BallsConfig, Fail> {
        let g = self.clearance;
        if self.balls {
            Ok(legalize_balls(self.problem, &centres_of(c), g, g)?)
        } else {
            let tk = &self.tk;
            legalize_solids(self.problem, &c.pieces, g, g, &mut || tk.poll())
        }
    }

    /// `polish`: the polish from the penalty weight number `from` on.
    fn polish(&mut self, c: &BallsConfig, from: usize) -> Result<BallsConfig, Fail> {
        if self.balls {
            polish_balls(self.problem, c, &mut self.tk, self.clearance, &BALL_MUS[from..])
        } else {
            polish_solids(self.problem, c, &mut self.tk, self.clearance, &SOLID_MUS[from..])
        }
    }

    /// `tryPolish`: a polish whose partial result, on a stop, is still considered.
    fn try_polish(&mut self, c: &BallsConfig, from: usize) -> Result<bool, Fail> {
        match self.polish(c, from) {
            Ok(r) => self.accept(r),
            Err(Fail::Stop(Stop { why, partial })) => {
                if let Some(part) = partial {
                    self.accept(part)?;
                }
                Err(Fail::Stop(Stop { why, partial: None }))
            }
            Err(e) => Err(e),
        }
    }

    /// `fresh`: a new start.
    fn fresh(&mut self) -> Result<BallsConfig, Fail> {
        let g = self.clearance;
        if self.balls {
            return Ok(fresh_start(self.problem, self.p, &mut self.rng, g)?);
        }
        let s = get_solid(&self.problem.piece)?;
        if self.problem.piece == "cube" && self.rng.next() < 0.4 {
            let cut = cube_lattice_cut(self.p, &mut self.rng);
            let tk = &self.tk;
            return legalize_solids(self.problem, &cut, g, g, &mut || tk.poll());
        }
        // unit balls of a lattice cut, scaled to the circumradius: the pieces' circumscribed balls are then disjoint
        let kind = if self.rng.next() < 0.5 { "fcc" } else { "hcp" };
        let centres = lattice_cut(balls_problem_of("ballinball").expect("ballinball"), self.p, &mut self.rng, kind, true)?;
        // (the lattice has balls of radius BALL_RADIUS, so the scale is the circumradius over that)
        let r = (s.circumradius / BALL_RADIUS) * (1.0 + 1e-9);
        let scaled: Vec<[f64; 3]> = centres.iter().map(|c| [c[0] * r, c[1] * r, c[2] * r]).collect();
        let poses = solids_at(&scaled, &mut self.rng);
        let tk = &self.tk;
        legalize_solids(self.problem, &poses, g, g, &mut || tk.poll())
    }

    /// `fresh()`, then `accept` and a full polish.
    fn fresh_polished(&mut self) -> Result<(), Fail> {
        let f = self.fresh()?;
        self.accept(f.clone())?;
        self.try_polish(&f, 0)?;
        Ok(())
    }

    /// The body of the source's `try` block: ends only with an error.
    fn run(&mut self, o: &BallsSearchOptions, hops: &mut u64, start_score: &mut Option<f64>) -> Fail {
        let step = (|| -> Result<(), Fail> {
            if let Some(start) = o.start {
                if start.pieces.len() != self.p {
                    return Err(Fail::Err(format!("the start has {} pieces, not {}", start.pieces.len(), self.p)));
                }
                let l = self.legalize(start)?;
                self.accept(l)?;
                if !o.start_polished {
                    self.try_polish(start, 3)?;
                }
                *start_score = self.best.as_ref().map(|b| b.s);
            } else {
                self.fresh_polished()?;
            }
            loop {
                let Some(b) = self.best.clone() else {
                    // nothing valid yet (a start that could not be legalized): build one
                    self.fresh_polished()?;
                    continue;
                };
                *hops += 1;
                let restart = self.p > 1 && self.rng.next() < 0.1;
                let cand = if restart {
                    self.fresh()?
                } else if self.balls {
                    hop_balls(self.problem, &b, &mut self.rng, o.hops)?
                } else {
                    hop_solids(self.problem, &b, &mut self.rng)?
                };
                self.try_polish(&cand, 0)?;
            }
        })();
        match step {
            Err(e) => e,
            Ok(()) => unreachable!("the search loop ends only with an error"),
        }
    }
}

/// `search.ts: searchBalls`. `Err` for what the source throws: a P below 1, a start of another size, a piece
/// the geometry cannot place.
pub fn search_balls(problem: &'static BallsProblem, p: usize, o: &BallsSearchOptions) -> Result<BallsSearchResult, String> {
    if p < 1 {
        return Err("P must be a positive integer".to_string());
    }
    let max_evals = o.max_evals;
    let clearance = o.clearance.unwrap_or(BALLS_CLEARANCE);
    // a 32-bit multiply, so that every uint32 seed gives its own generator state; a float product would round the
    // low bits of large seeds away
    let rng = Rng::new(math::imul(o.seed as i32, 2654435761u32 as i32) as u32);
    let mut run = Run {
        problem,
        p,
        balls: problem.piece == "ball",
        clearance,
        rng,
        tk: Ticker { evaluations: 0, max_evals, should_stop: o.should_stop },
        best: None,
    };
    let mut hops = 0u64;
    let mut start_score: Option<f64> = None;
    let stopped = match run.run(o, &mut hops, &mut start_score) {
        Fail::Err(m) => return Err(m),
        Fail::Stop(s) => match s.why {
            Why::Evals => Stopped::Evals,
            Why::Aborted => Stopped::Aborted,
        },
    };
    let out = run.best.take();
    Ok(BallsSearchResult {
        score: out.as_ref().map_or(f64::INFINITY, |c| c.s),
        config: out,
        start_score,
        evaluations: run.tk.evaluations.min(max_evals),
        hops,
        stopped,
    })
}
