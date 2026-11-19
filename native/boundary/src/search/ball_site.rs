//! The ball model in site units (balls of diameter 1, units.rs): a wrapper that hands the working
//! model of balls.rs (written for balls of radius 1) the lengths x BALL_WORK and gives back lengths /
//! BALL_WORK. Both factors are 2, so every conversion is exact in binary64 and the wrapped model
//! computes exactly what it computed for radius 1.
//! Port of packages/boundary/src/search/ball-site.ts.
//!
//! Quantities: a length l (U, s, a violation, the floor, the longest step) converts by l / W; an
//! energy, a sum of squared lengths, by E / W^2; its gradient with respect to a length by g / W; the
//! target (an energy) by target / W^2.

use super::balls::BallModel;
use super::model::{Finish, PieceModel, State};
use super::random::Mulberry32;
use super::Res;
use crate::types::{BoundaryConfig, BoundaryPiece};
use crate::units::BALL_WORK;

const W: f64 = BALL_WORK;

/// packages/boundary/src/search/ball-site.ts: SiteBallModel
pub struct SiteBallModel {
    inner: BallModel,
    work: State,
    gw: Vec<f64>,
}

impl SiteBallModel {
    pub fn new(inner: BallModel) -> SiteBallModel {
        let p = inner.p;
        SiteBallModel { inner, work: State { cells: vec![0; p], u: vec![0.0; 3 * p], r: None }, gw: vec![0.0; 3 * p] }
    }

    /// The state in working units (the model's scratch: valid until the next call).
    fn up(&mut self, st: &State) {
        self.work.cells.copy_from_slice(&st.cells);
        for i in 0..st.u.len() {
            self.work.u[i] = st.u[i] * W;
        }
    }

    fn down(st: State) -> State {
        State { cells: st.cells, u: st.u.iter().map(|x| x / W).collect(), r: None }
    }
}

impl Finish for SiteBallModel {
    fn floor(&self) -> f64 {
        self.inner.floor() / W
    }

    fn violation(&mut self, st: &State, s: f64) -> f64 {
        self.up(st);
        self.inner.violation(&self.work, s * W) / W
    }

    fn pieces(&mut self, st: &State, s: f64) -> Vec<BoundaryPiece> {
        self.up(st);
        self.inner.pieces(&self.work, s * W).into_iter().map(|p| BoundaryPiece { cell: p.cell, u: p.u.iter().map(|x| x / W).collect(), q: None }).collect()
    }
}

impl PieceModel for SiteBallModel {
    fn target(&self) -> f64 {
        self.inner.target() / (W * W)
    }

    fn max_step(&self) -> f64 {
        self.inner.max_step() / W
    }

    fn energy(&mut self, st: &State, s: f64, g: &mut [f64]) -> f64 {
        self.up(st);
        let e = self.inner.energy(&self.work, s * W, &mut self.gw);
        for i in 0..g.len() {
            g[i] = self.gw[i] / W;
        }
        e / (W * W)
    }

    fn start_edge(&self) -> f64 {
        self.inner.start_edge() / W
    }

    fn random_state(&mut self, s: f64, rand: &mut Mulberry32) -> State {
        Self::down(self.inner.random_state(s * W, rand))
    }

    fn hop(&mut self, st: &State, s: f64, rand: &mut Mulberry32) -> State {
        self.up(st);
        let work = self.work.clone();
        Self::down(self.inner.hop(&work, s * W, rand))
    }

    fn constructed_start(&mut self, _rand: &mut Mulberry32) -> Res<Option<(State, f64)>> {
        Ok(None)
    }

    fn state_of(&self, config: &BoundaryConfig) -> Option<State> {
        let scaled = BoundaryConfig {
            s: config.s * W,
            pieces: config.pieces.iter().map(|p| BoundaryPiece { cell: p.cell, u: p.u.iter().map(|x| x * W).collect(), q: None }).collect(),
        };
        self.inner.state_of(&scaled).map(Self::down)
    }
}
