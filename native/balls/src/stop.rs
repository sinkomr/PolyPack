//! How a search ends: `StopSearch` of `packages/polyhedra/src/polish.ts` (the exception the polishes and the
//! search throw to end the run) and the search's `tick` and `poll` (`packages/balls/src/search.ts`).

use crate::validate::BallsConfig;

/// `StopSearch.why`. The source's "time" (`maxSeconds`) is not used by the Auto search, which has the job's
/// stop flag and deadline in `should_stop` instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    Evals,
    Aborted,
}

/// A `StopSearch` with the `partial` that the polishes attach to it: the last iterate, legalized.
#[derive(Clone, Debug)]
pub struct Stop {
    pub why: Why,
    pub partial: Option<BallsConfig>,
}

impl Stop {
    pub fn new(why: Why) -> Stop {
        Stop { why, partial: None }
    }
}

/// What can end a function of the search: a `StopSearch`, or any other error the source throws (a zero
/// quaternion in `place`, an unknown solid), which is the `Err` here with its message.
#[derive(Clone, Debug)]
pub enum Fail {
    Stop(Stop),
    Err(String),
}

impl From<Stop> for Fail {
    fn from(s: Stop) -> Fail {
        Fail::Stop(s)
    }
}

impl From<String> for Fail {
    fn from(s: String) -> Fail {
        Fail::Err(s)
    }
}

/// The `tick` and `poll` of `searchBalls`: `tick` counts an objective evaluation and ends the run when the
/// budget is spent or the stop is asked for; `poll` is the stop check alone, for the work between evaluations.
pub struct Ticker<'a> {
    pub evaluations: u64,
    pub max_evals: u64,
    pub should_stop: Option<&'a dyn Fn() -> bool>,
}

impl Ticker<'_> {
    /// `poll`: `if (o.shouldStop?.()) throw new StopSearch("aborted")`.
    #[inline]
    pub fn poll(&self) -> Result<(), Stop> {
        if let Some(f) = self.should_stop {
            if f() {
                return Err(Stop::new(Why::Aborted));
            }
        }
        Ok(())
    }

    /// `tick`: `evaluations++; if (evaluations > maxEvals) throw StopSearch("evals"); poll()`.
    #[inline]
    pub fn tick(&mut self) -> Result<(), Stop> {
        self.evaluations += 1;
        if self.evaluations > self.max_evals {
            return Err(Stop::new(Why::Evals));
        }
        self.poll()
    }
}
