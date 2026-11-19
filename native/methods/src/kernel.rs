//! packages/methods/src/kernel.ts: the geometry kernel of one family problem, as far as
//! `basin_hopping` uses it.
//!
//! A state holds each piece's variables in a local chart around a per-piece anchor that the kernel
//! keeps in `aux`: positions as lengths and turns as angles or rotation vectors, `dim` numbers per
//! piece. `rebase` folds the chart offsets into the anchors. The size the methods minimise is the
//! problem's score itself; smaller is tighter. The energy is a sum of squared hinge terms, zero for
//! a packing that is valid at its size by the kernel's own model.
//!
//! The source's `FamilyKernel` is an object of closures; here it is a trait with the family's
//! anchors (`Aux`) and its submission format (`Config`) as associated types. The source's
//! "unknown" configuration is a `Config`, and `JSON.stringify(toConfig(s))` (the comparison of
//! `samePacking`) is [`FamilyKernel::same_config`].

use crate::random::Mulberry32;

/// The variables of a packing as the methods see them (kernel.ts: KernelState).
#[derive(Debug, Clone)]
pub struct KernelState<A> {
    /// P * dim + globals numbers: piece i owns x[i * dim] ... x[i * dim + dim - 1], in its chart.
    pub x: Vec<f64>,
    /// The size being minimised, which is the problem's score at this state.
    pub size: f64,
    /// The kernel's own data: anchors and the soft-shape parameter.
    pub aux: A,
}

/// A valid configuration with its size (kernel.ts: Finished).
#[derive(Debug, Clone)]
pub struct Finished<C> {
    pub config: C,
    pub score: f64,
}

/// The server's rule for a configuration (kernel.ts: Validation, without the reasons the methods do
/// not read).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Validation {
    pub valid: bool,
    pub score: Option<f64>,
}

/// Why a run must end (framework.ts: Stop).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Evals,
    Time,
    Stopped,
    Bound,
}

/// What a JavaScript `throw` is here: the framework's `Stop`, the guard of `squeezeWithin` (its
/// `Spent`), or an `Error` of the kernel (the message).
#[derive(Debug, Clone, PartialEq)]
pub enum Throw {
    Stop(StopReason),
    Spent,
    Error(String),
}

/// The geometry kernel of one problem (kernel.ts: FamilyKernel). `&mut self` because a kernel keeps
/// scratch buffers.
#[allow(clippy::wrong_self_convention)]
pub trait FamilyKernel {
    /// The anchors of a state (the base orientations).
    type Aux: Clone;
    /// The family's submission format.
    type Config: Clone;

    /// Pieces.
    fn p(&self) -> usize;
    /// Variables per piece.
    fn dim(&self) -> usize;
    /// One typical step per variable of a piece (length dim).
    fn steps(&self) -> &[f64];
    /// Variables of the whole packing after the pieces'.
    fn globals(&self) -> usize;
    /// One typical step per global variable.
    fn global_steps(&self) -> &[f64];
    /// The problem's lower bound on the score, or None.
    fn bound(&self) -> Option<f64>;
    /// Energy evaluations one finish() costs, for the methods' budgets.
    fn finish_cost(&self) -> f64;
    /// Energy evaluations one validate() costs, when it is cheaper than a finish (default finishCost).
    fn validate_cost(&self) -> Option<f64>;
    /// Energy evaluations an energy() call with a gradient costs (default 1).
    fn grad_cost(&self) -> Option<f64>;
    /// The kernel has the capability "swap".
    fn has_swap(&self) -> bool;
    /// The kernel has the capability "seeds".
    fn has_seeds(&self) -> bool;

    /// A clean state from a configuration, or None when it is malformed or outside the server's limits.
    fn from_config(&mut self, config: &Self::Config) -> Option<KernelState<Self::Aux>>;
    /// The configuration of a state at its size; it need not be valid. An `Err` is a `throw`.
    fn to_config(&mut self, s: &KernelState<Self::Aux>) -> Result<Self::Config, Throw>;
    /// True when `JSON.stringify` of the two configurations is the same text.
    fn same_config(&self, a: &Self::Config, b: &Self::Config) -> bool;
    fn clone_state(&self, s: &KernelState<Self::Aux>) -> KernelState<Self::Aux> {
        s.clone()
    }
    /// Folds the chart offsets into the anchors; the configuration does not change.
    fn rebase(&mut self, s: &mut KernelState<Self::Aux>);
    /// Random poses at a size roomy enough that a short relaxation separates them.
    fn random_start(&mut self, rng: &mut Mulberry32) -> KernelState<Self::Aux>;
    /// Re-places piece i at a uniformly random pose in the container.
    fn random_pose(&mut self, s: &mut KernelState<Self::Aux>, i: usize, rng: &mut Mulberry32);
    /// Moves piece i by a uniform random amount of up to `amount` steps in each of its variables.
    fn jiggle(&mut self, s: &mut KernelState<Self::Aux>, i: usize, amount: f64, rng: &mut Mulberry32);
    /// Changes the size, keeping the normalized arrangement.
    fn set_size(&mut self, s: &mut KernelState<Self::Aux>, size: f64);
    /// Penalty energy at the state's size. With `grad` (length P * dim + globals + 1), writes dE/dx
    /// and, last, dE/dsize. `weights` (length P) scale every term of piece i.
    fn energy(
        &mut self,
        s: &KernelState<Self::Aux>,
        grad: Option<&mut [f64]>,
        weights: Option<&[f64]>,
    ) -> Result<f64, Throw>;
    /// The terms of piece i alone: its pairs and its walls, weighted as in energy().
    fn piece_energy(&mut self, s: &KernelState<Self::Aux>, i: usize, weights: Option<&[f64]>) -> Result<f64, Throw>;
    /// The family's exact finishing from s, or None when it finds no valid configuration near s. A
    /// long finishing polls `should_stop` and, once it is true, ends early.
    fn finish(
        &mut self,
        s: &KernelState<Self::Aux>,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Result<Option<Finished<Self::Config>>, Throw>;
    /// Capability "seeds": structured starts (lattices), at most `count`.
    fn seeds(&mut self, rng: &mut Mulberry32, count: usize) -> Vec<KernelState<Self::Aux>>;
    /// Capability "swap": exchanges the orientations of pieces i and j, leaving their positions.
    fn swap(&mut self, s: &mut KernelState<Self::Aux>, i: usize, j: usize);
}
