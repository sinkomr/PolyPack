//! What the boundary search's driver needs from a kind of piece: a penalty energy of a state with its
//! gradient, the largest violation (for the final scaling), starts and hops.
//! Port of packages/boundary/src/search/model.ts (State, PieceModel, copyState, scaleState).
//!
//! A state holds each piece's anchor cell and centre (n local coordinates at the state's edge s).
//! The driver moves centres through the charts (chart.rs) and asks the model only for energies at
//! actual positions, so a model never deals with re-anchoring.

use super::random::Mulberry32;
use super::Res;
use crate::types::{BoundaryConfig, BoundaryPiece};

/// packages/boundary/src/search/model.ts: State
#[derive(Clone, Debug)]
pub struct State {
    pub cells: Vec<usize>,
    /// n numbers per piece: its centre in its anchor cell's local frame, at the state's edge.
    pub u: Vec<f64>,
    /// Models of rotated pieces only: 9 numbers per piece, its orientation, an orthogonal matrix
    /// (row-major) in its anchor's local frame (improper after a gluing that reverses handedness).
    pub r: Option<Vec<f64>>,
}

/// What finalize_state needs of any model (the d-cube and nD models offer no more).
pub trait Finish {
    /// Smallest edge worth trying: a proven lower bound for balls; for aligned cubes the family's own
    /// floor or the volume bound.
    fn floor(&self) -> f64;
    /// Largest violation (a length; <= 0 when the state is valid by the model's own exact rule).
    fn violation(&mut self, st: &State, s: f64) -> f64;
    /// The pieces of a state (at edge s), clamped into their closed cells.
    fn pieces(&mut self, st: &State, s: f64) -> Vec<BoundaryPiece>;
}

/// The models of the 4-polytopes' search: balls, aligned cubes and the rotated solids.
/// packages/boundary/src/search/model.ts: PieceModel
pub trait PieceModel: Finish {
    /// True for models of rotated pieces: the state carries orientations and the search adds three
    /// rotation variables per piece after the 3P displacements.
    fn rotates(&self) -> bool {
        false
    }
    /// A relaxation counts as feasible below this energy.
    fn target(&self) -> f64;
    /// Longest move of the centres in one line-search step.
    fn max_step(&self) -> f64;
    /// Penalty energy at edge s (sum of squared violations); its gradient with respect to U (and a
    /// rotation increment of each orientation, for rotated pieces) is written into g.
    fn energy(&mut self, st: &State, s: f64, g: &mut [f64]) -> f64;
    /// Edge of the random starts.
    fn start_edge(&self) -> f64;
    fn random_state(&mut self, s: f64, rand: &mut Mulberry32) -> State;
    /// A copy of the state (at edge s) with one to three pieces moved at random.
    fn hop(&mut self, st: &State, s: f64, rand: &mut Mulberry32) -> State;
    /// A constructed start (cubes: the two rings), or None.
    fn constructed_start(&mut self, rand: &mut Mulberry32) -> Res<Option<(State, f64)>>;
    /// The state of a configuration, or None when the model cannot represent it (a turned cube).
    fn state_of(&self, config: &BoundaryConfig) -> Option<State>;
}

/// packages/boundary/src/search/model.ts: copyState
pub fn copy_state(st: &State) -> State {
    st.clone()
}

/// The state scaled by k about the cells' centres (for a change of edge s -> k s).
/// packages/boundary/src/search/model.ts: scaleState
pub fn scale_state(st: &State, k: f64) -> State {
    State { cells: st.cells.clone(), u: st.u.iter().map(|x| x * k).collect(), r: st.r.clone() }
}
