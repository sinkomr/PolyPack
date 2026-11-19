//! packages/methods/src/methods/basin_hopping.ts on any kernel: perturb the current packing, solve
//! locally (local.rs squeeze), offer the result and accept it by a Metropolis rule on its finished
//! score. With basin-operators.ts (the operators kick, swap, reinsert and restart, the Metropolis
//! rule), basin-final.ts (the offer accounting and the final refinement) and `fitIterations` of
//! seed-starts.ts.
//!
//! The parameters are the method's defaults (the space's Auto search passes none).

use crate::framework::Ctx;
use crate::kernel::{FamilyKernel, KernelState, StopReason, Throw};
use crate::local::{squeeze, SqueezeOptions};
use crate::random::{random_int, sample, Mulberry32};
use polypack_js::math;

type State<K> = KernelState<<K as FamilyKernel>::Aux>;

/// basin_hopping.ts: SEEDS. Structured starts asked of a kernel with the capability "seeds", for
/// the restart set.
const SEEDS: usize = 4;
/// basin_hopping.ts: SQUEEZE_SOLVES. The solves of a squeeze: its six penalty weights and the relax
/// after them.
const SQUEEZE_SOLVES: f64 = 7.0;
/// basin_hopping.ts: MAX_REDRAWS. Redraws in a row of a perturbation that changed nothing before a
/// kick is forced.
const MAX_REDRAWS: usize = 8;
/// basin_hopping.ts: REINSERT_SQUEEZE. The shrink of the probe that picks the piece to reinsert.
const REINSERT_SQUEEZE: f64 = 0.02;

/// basin-operators.ts: OPERATORS, in this order: kick, swap, reinsert, restart.
const KICK: usize = 0;
const SWAP: usize = 1;
const REINSERT: usize = 2;
const RESTART: usize = 3;
const OPERATORS: usize = 4;

/// basin-operators.ts: TIE. Scores within this relative difference are a tie (float noise of the
/// finishing).
const TIE: f64 = 1e-9;

/// basin_hopping.ts: `defaults`.
struct Params {
    temperature: f64,
    kick_magnitude: f64,
    kick_fraction: f64,
    reinsertion_trials: usize,
    restart_strength: f64,
    target_acceptance: f64,
    adaptation_rate: f64,
    weight_floor: f64,
    /// The operators' base weights, in the order of OPERATORS.
    weights: [f64; OPERATORS],
    local_iterations: usize,
    refinement_evals: f64,
}

const DEFAULTS: Params = Params {
    temperature: 0.01,
    kick_magnitude: 0.35,
    kick_fraction: 0.4,
    reinsertion_trials: 48,
    restart_strength: 3.0,
    target_acceptance: 0.5,
    adaptation_rate: 0.15,
    weight_floor: 0.2,
    weights: [4.0, 1.0, 2.0, 0.3],
    local_iterations: 200,
    refinement_evals: 3000.0,
};

/// basin-operators.ts: OperatorStats.
#[derive(Clone, Copy, Default)]
struct OperatorStats {
    tries: usize,
    accepted: usize,
    improvements: usize,
    /// Exponential moving average of improvements, which raises the operator's weight.
    success_rate: f64,
}

/// basin-operators.ts: assign. Moves s's contents to target (s is a fresh state the caller no
/// longer uses).
fn assign<A>(target: &mut KernelState<A>, s: KernelState<A>) {
    *target = s;
}

/// basin-operators.ts: metropolis. A strict improvement is accepted without a draw; otherwise, at a
/// positive temperature (score units), with probability exp(-(candidate - current) / temperature),
/// ties included. Nonfinite scores are rejected.
fn metropolis(current: f64, candidate: f64, temperature: f64, rng: &mut Mulberry32) -> bool {
    if !candidate.is_finite() || !current.is_finite() {
        return false;
    }
    if candidate < current {
        return true;
    }
    if !(temperature > 0.0) {
        return false;
    }
    rng.next() < math::exp(-(candidate - current) / temperature)
}

/// basin-operators.ts: chooseOperator. Roulette over base * (floor + success rate); a zero base
/// weight disables an operator, and all zero falls back to kick.
fn choose_operator(
    base: &[f64; OPERATORS],
    stats: &[OperatorStats; OPERATORS],
    floor: f64,
    rng: &mut Mulberry32,
) -> usize {
    let mut effective = [0.0f64; OPERATORS];
    for o in 0..OPERATORS {
        effective[o] = base[o] * (floor + stats[o].success_rate);
    }
    let mut total = 0.0f64;
    for w in effective {
        total += w;
    }
    if !(total > 0.0) {
        return KICK;
    }
    let mut draw = rng.next() * total;
    for i in 0..OPERATORS {
        draw -= effective[i];
        if draw < 0.0 {
            return i;
        }
    }
    for i in (0..OPERATORS).rev() {
        if effective[i] > 0.0 {
            return i;
        }
    }
    KICK
}

/// basin-operators.ts: kick. Jiggles max(1, ceil(fraction P)) distinct pieces by up to `amount`
/// steps in each variable.
fn kick<K: FamilyKernel>(k: &mut K, s: &mut State<K>, rng: &mut Mulberry32, amount: f64, fraction: f64) {
    let p = k.p();
    let count = (p as f64).min(math::max(1.0, math::ceil(fraction * p as f64))) as usize;
    for i in sample(rng, p, count) {
        k.jiggle(s, i, amount, rng);
    }
}

/// basin-operators.ts: swapPair. Exchanges the orientations of two distinct random pieces
/// (capability "swap").
fn swap_pair<K: FamilyKernel>(k: &mut K, s: &mut State<K>, rng: &mut Mulberry32) {
    if !k.has_swap() || k.p() < 2 {
        return;
    }
    let pair = sample(rng, k.p(), 2);
    k.swap(s, pair[0], pair[1]);
}

/// basin-operators.ts: stressedPiece. The piece to reinsert: drawn with probability proportional to
/// its energy in a copy of s shrunk by `squeeze` (so every contact becomes an overlap). Costs one
/// energy sweep.
fn stressed_piece<K: FamilyKernel>(
    ctx: &mut Ctx<'_, K>,
    s: &State<K>,
    squeeze: f64,
) -> Result<usize, Throw> {
    let mut probe = ctx.k.clone_state(s);
    ctx.k.set_size(&mut probe, s.size * (1.0 - squeeze));
    let p = ctx.k.p();
    let mut e = vec![0.0f64; p];
    let mut total = 0.0f64;
    for i in 0..p {
        e[i] = ctx.piece_energy(&probe, i, None)?;
        total += e[i];
    }
    if !(total > 0.0) {
        return Ok(random_int(&mut ctx.rng, p));
    }
    let mut draw = ctx.rng.next() * total;
    for i in 0..p {
        draw -= e[i];
        if draw < 0.0 {
            return Ok(i);
        }
    }
    Ok(p - 1)
}

/// basin-operators.ts: reinsert. Re-places piece i at the best of `trials` uniformly random poses
/// by its own energy against the others at s's size: the deepest hole the samples find. Stops early
/// at a pose with no overlap.
fn reinsert<K: FamilyKernel>(ctx: &mut Ctx<'_, K>, s: &mut State<K>, i: usize, trials: usize) -> Result<(), Throw> {
    let mut scratch = ctx.k.clone_state(s);
    let mut best: Option<State<K>> = None;
    let mut best_energy = f64::INFINITY;
    for _ in 0..trials {
        // randomPose replaces the piece's whole pose, so the scratch state needs no reset between samples
        ctx.k.random_pose(&mut scratch, i, &mut ctx.rng);
        let e = ctx.piece_energy(&scratch, i, None)?;
        if e < best_energy {
            best_energy = e;
            best = Some(ctx.k.clone_state(&scratch));
            if e == 0.0 {
                break;
            }
        }
    }
    if let Some(b) = best {
        assign(s, b);
    }
    Ok(())
}

/// basin-operators.ts: samePacking. True when a and b give the same configuration.
fn same_packing<K: FamilyKernel>(k: &mut K, a: &State<K>, b: &State<K>) -> Result<bool, Throw> {
    let ca = k.to_config(a)?;
    let cb = k.to_config(b)?;
    Ok(k.same_config(&ca, &cb))
}

/// seed-starts.ts: fitIterations. L-BFGS iterations per solve for a descent of `solves` solves:
/// `wanted`, or fewer so that the descent and the offer after it fit in the evaluations left. A
/// run's first descent (`first`) takes at most half of what the offer leaves, so the run has a
/// result early and can go on; all of it when a second offer would not fit anyway. An iteration
/// costs about 1.5 gradients with its line search. At least 1. Without an evaluation budget,
/// `wanted`.
fn fit_iterations<K: FamilyKernel>(ctx: &Ctx<'_, K>, wanted: usize, solves: f64, first: bool) -> usize {
    let left = ctx.remaining();
    if !left.is_finite() {
        return wanted;
    }
    let k = &*ctx.k;
    let offer = k.finish_cost() + k.validate_cost().unwrap_or_else(|| k.finish_cost());
    let spare = left - offer;
    let share = if first && spare >= 2.0 * offer { spare / 2.0 } else { spare };
    let per_iteration = 1.5 * k.grad_cost().unwrap_or(1.0) * solves;
    // Math.max(1, Math.min(wanted, Math.floor(share / perIteration)))
    let v = math::max(1.0, math::min(wanted as f64, math::floor(share / per_iteration)));
    v as usize
}

/// basin-final.ts: offerCost. Evaluations of one offer that improves the best: the finish and the
/// server's check.
fn offer_cost<K: FamilyKernel>(k: &K) -> f64 {
    k.finish_cost() + k.validate_cost().unwrap_or_else(|| k.finish_cost())
}

/// basin-final.ts: REFINEMENT_MUS, the refinement's penalty weights: from a valid packing, so they
/// start high and end high.
const REFINEMENT_MUS: [f64; 3] = [1e5, 1e7, 1e9];
const REFINEMENT_ITER: usize = 400;
/// The refinement's squeeze is estimated at this multiple of the largest squeeze of the run.
const SQUEEZE_MARGIN: f64 = 1.25;
/// The refinement runs only when its reserve fits in this share of the evaluation budget.
const BUDGET_SHARE: f64 = 1.0 / 4.0;

/// basin-final.ts: squeezeWithin. Squeezes s, stopping once the run has used `limit` evaluations; s
/// is then where the squeeze got to (a point it evaluated). The kernel's own Stop still ends the
/// run.
fn squeeze_within<K: FamilyKernel>(
    ctx: &mut Ctx<'_, K>,
    s: &mut State<K>,
    limit: f64,
    o: SqueezeOptions<'_>,
) -> Result<(), Throw> {
    ctx.guard = Some(limit);
    let r = squeeze(ctx, s, o);
    ctx.guard = None;
    match r {
        Err(Throw::Spent) => Ok(()),
        Err(e) => Err(e),
        Ok(_) => Ok(()),
    }
}

/// basin-final.ts: FinalRefinement.
struct FinalRefinement {
    /// True once the refinement has run, and from the start when it never will (no evaluation
    /// budget, or a cap of 0).
    done: bool,
    largest_squeeze: f64,
    dearest_step: f64,
    limit: f64,
    cap: f64,
}

impl FinalRefinement {
    /// `cap`: the most evaluations the refinement's squeeze may take.
    fn new<K: FamilyKernel>(ctx: &Ctx<'_, K>, cap: f64) -> Self {
        let budget = ctx.remaining();
        FinalRefinement {
            done: !(cap > 0.0) || !budget.is_finite(),
            largest_squeeze: 0.0,
            dearest_step: 0.0,
            limit: BUDGET_SHARE * budget,
            cap,
        }
    }

    /// A squeeze of the method's, whose cost the estimate of the refinement learns from.
    fn squeeze<K: FamilyKernel>(
        &mut self,
        ctx: &mut Ctx<'_, K>,
        s: &mut State<K>,
        o: SqueezeOptions<'_>,
    ) -> Result<(), Throw> {
        let before = ctx.used();
        squeeze(ctx, s, o)?;
        self.largest_squeeze = math::max(self.largest_squeeze, ctx.used() - before);
        Ok(())
    }

    /// A run's first squeeze, before it has any result: like squeeze(), but it stops where the
    /// budget leaves one offer (and one evaluation of margin), so that the offer after it is
    /// always made.
    fn first_squeeze<K: FamilyKernel>(
        &mut self,
        ctx: &mut Ctx<'_, K>,
        s: &mut State<K>,
        o: SqueezeOptions<'_>,
    ) -> Result<(), Throw> {
        let room = ctx.remaining() - offer_cost(&*ctx.k) - 1.0;
        if !room.is_finite() {
            return self.squeeze(ctx, s, o);
        }
        let before = ctx.used();
        if room > 0.0 {
            squeeze_within(ctx, s, before + room, o)?;
        }
        self.largest_squeeze = math::max(self.largest_squeeze, ctx.used() - before);
        Ok(())
    }

    /// Records the cost of one step of the method.
    fn step(&mut self, cost: f64) {
        self.dearest_step = math::max(self.dearest_step, cost);
    }

    /// The evaluations to keep for the refinement: its squeeze and one offer.
    fn reserve<K: FamilyKernel>(&self, ctx: &Ctx<'_, K>) -> f64 {
        let squeeze_cost = if self.largest_squeeze > 0.0 { SQUEEZE_MARGIN * self.largest_squeeze } else { self.cap };
        math::min(self.cap, squeeze_cost) + offer_cost(&*ctx.k)
    }

    /// True while the refinement may still run: not done, and its reserve fits the budget's share.
    fn possible<K: FamilyKernel>(&self, ctx: &Ctx<'_, K>) -> bool {
        !self.done && self.reserve(ctx) <= self.limit
    }

    /// What the next step may cost: the dearest step so far, and at least the largest squeeze.
    fn next_step(&self) -> f64 {
        math::max(self.dearest_step, self.largest_squeeze)
    }

    /// True when the next step could cut into the reserve: time to refine.
    fn due<K: FamilyKernel>(&self, ctx: &Ctx<'_, K>) -> bool {
        self.possible(ctx) && ctx.remaining() <= self.reserve(ctx) + self.next_step()
    }

    /// The other starts of basin_hopping's first solve, after the first is offered: every
    /// candidate squeezed, smallest squeezed size first.
    fn squeezed_starts<K: FamilyKernel>(
        &mut self,
        ctx: &mut Ctx<'_, K>,
        mut candidates: Vec<State<K>>,
        o: SqueezeOptions<'_>,
    ) -> Result<Vec<State<K>>, Throw> {
        for s in candidates.iter_mut() {
            self.squeeze(ctx, s, o)?;
        }
        // `[...candidates].sort((a, b) => a.size - b.size)`: a stable sort (insertion, as the list is short)
        let mut sorted: Vec<State<K>> = Vec::with_capacity(candidates.len());
        for s in candidates {
            let mut at = sorted.len();
            while at > 0 && sorted[at - 1].size - s.size > 0.0 {
                at -= 1;
            }
            sorted.insert(at, s);
        }
        Ok(sorted)
    }

    /// The refinement: s squeezed tightly, leaving the budget one offer, and offered. Marks it done.
    fn run<K: FamilyKernel>(&mut self, ctx: &mut Ctx<'_, K>, s: &mut State<K>) -> Result<Option<f64>, Throw> {
        self.done = true;
        // one evaluation of margin: the fractional charges of pieceEnergy drift in the last digits
        let room = ctx.remaining() - offer_cost(&*ctx.k) - 1.0;
        if room > 0.0 {
            let limit = ctx.used() + room;
            squeeze_within(ctx, s, limit, SqueezeOptions { mus: Some(&REFINEMENT_MUS), max_iter: Some(REFINEMENT_ITER) })?;
        }
        ctx.offer(s)
    }
}

/// basin_hopping.ts: runBasinHopping. The method's loop; it ends by an `Err` (a stop, or a failure
/// of the kernel), as the source's does by a throw.
pub fn run_basin_hopping<K: FamilyKernel>(ctx: &mut Ctx<'_, K>) -> Result<(), Throw> {
    let p = &DEFAULTS;
    let mut operators = [OperatorStats::default(); OPERATORS];
    let mut kick_magnitude = p.kick_magnitude;
    let temperature = p.temperature;
    let rate = p.adaptation_rate;
    // A squeeze's iterations per solve, fitted to the budget (fitIterations): the wanted
    // `localIterations`, or fewer so that `solves` solves and one offer fit in what is left; a
    // run's first squeeze takes at most half of it, so the run has a result early.
    let fitted = |ctx: &Ctx<'_, K>, solves: f64, first: bool| -> usize {
        fit_iterations(ctx, p.local_iterations, solves, first)
    };
    // the final refinement (basin-final.ts), which learns its cost from the hops' squeezes
    let mut fin = FinalRefinement::new(ctx, p.refinement_evals);

    // The restart set: the supplied start and the kernel's structured starts.
    let mut restarts: Vec<State<K>> = Vec::new();
    if let Some(start) = &ctx.start {
        restarts.push(ctx.k.clone_state(start));
    }
    if ctx.k.has_seeds() {
        let seeds = ctx.seeds(SEEDS)?;
        restarts.extend(seeds);
    }

    // The first local solve. Without a valid supplied start, the first candidate (the supplied
    // start, else the first structured start, else random poses) is squeezed and offered at once,
    // until one finishes: the run has a result as early as the budget allows. Then the other
    // candidates are squeezed, fitted together to what is left, and offered smallest first while
    // they could beat the current packing, until one finishes. A valid start the solve does not
    // beat stays the current packing. The current packing is the squeezed state, not its finished
    // configuration: the next hop perturbs the local minimum of the penalty, and the finished score
    // decides acceptance.
    let mut current: Option<State<K>> = None;
    let mut current_score = f64::INFINITY;
    fn take<A>(current: &mut Option<KernelState<A>>, current_score: &mut f64, s: KernelState<A>, score: Option<f64>) {
        if let Some(score) = score {
            if score < *current_score {
                *current = Some(s);
                *current_score = score;
            }
        }
    }
    if let Some((state, score)) = ctx.best() {
        take(&mut current, &mut current_score, state, Some(score));
    }
    let mut queue: Vec<State<K>> = restarts.iter().map(|s| ctx.k.clone_state(s)).collect();
    while current.is_none() {
        let mut s = if queue.is_empty() { ctx.random_start()? } else { queue.remove(0) };
        // before any result, the squeeze stops where the budget leaves the offer
        if ctx.best().is_some() {
            let o = SqueezeOptions { mus: None, max_iter: Some(fitted(ctx, SQUEEZE_SOLVES, false)) };
            fin.squeeze(ctx, &mut s, o)?;
        } else {
            let o = SqueezeOptions { mus: None, max_iter: Some(fitted(ctx, SQUEEZE_SOLVES, true)) };
            fin.first_squeeze(ctx, &mut s, o)?;
        }
        let score = ctx.offer(&s)?;
        take(&mut current, &mut current_score, s, score);
    }
    if !queue.is_empty() {
        let o = SqueezeOptions {
            mus: None,
            max_iter: Some(fitted(ctx, SQUEEZE_SOLVES * queue.len() as f64, false)),
        };
        let rest = fin.squeezed_starts(ctx, queue, o)?;
        for s in rest {
            if !(s.size < current_score) {
                break;
            }
            let score = ctx.offer(&s)?;
            take(&mut current, &mut current_score, s, score);
            if score.is_some() {
                break;
            }
        }
    }

    let mut redraws = 0usize;
    loop {
        ctx.check()?;
        if fin.due(ctx) {
            // A tight squeeze of the best so far; the hops then go on with what is left.
            match ctx.best() {
                Some((mut state, _)) => {
                    let score = fin.run(ctx, &mut state)?;
                    if let Some(score) = score {
                        if score < current_score {
                            current = Some(state);
                            current_score = score;
                        }
                    }
                }
                None => fin.done = true,
            }
            continue;
        }
        let before = ctx.used();
        let mut base = p.weights;
        if !ctx.k.has_swap() || ctx.k.p() < 2 {
            base[SWAP] = 0.0;
        }
        // Perturbations that change nothing are redrawn without a solve; after a few, a kick is forced.
        let forced = redraws >= MAX_REDRAWS;
        if forced {
            for o in 0..OPERATORS {
                base[o] = if o == KICK { 1.0 } else { 0.0 };
            }
        }
        let op = choose_operator(&base, &operators, p.weight_floor, &mut ctx.rng);
        let cur = current.as_ref().expect("a current packing");
        let mut s = ctx.k.clone_state(cur);
        if op == SWAP {
            swap_pair(ctx.k, &mut s, &mut ctx.rng);
        } else if op == REINSERT {
            let piece = stressed_piece(ctx, &s, REINSERT_SQUEEZE)?;
            reinsert(ctx, &mut s, piece, p.reinsertion_trials)?;
        } else if op == RESTART {
            if !restarts.is_empty() {
                let at = random_int(&mut ctx.rng, restarts.len());
                s = ctx.k.clone_state(&restarts[at]);
                kick(ctx.k, &mut s, &mut ctx.rng, kick_magnitude * p.restart_strength, 1.0);
            } else {
                s = ctx.random_start()?;
            }
        } else {
            kick(ctx.k, &mut s, &mut ctx.rng, kick_magnitude, p.kick_fraction);
        }
        let cur = current.as_ref().expect("a current packing");
        if !forced && same_packing(ctx.k, &s, cur)? {
            redraws += 1;
            continue;
        }
        redraws = 0;
        operators[op].tries += 1;
        let o = SqueezeOptions { mus: None, max_iter: Some(fitted(ctx, SQUEEZE_SOLVES, false)) };
        fin.squeeze(ctx, &mut s, o)?;
        let raw = ctx.offer(&s)?;
        let previous = current_score;
        // a difference within float noise is a tie: it neither improves nor changes the kick size
        let tie = matches!(raw, Some(r) if math::abs(r - previous) <= TIE * previous);
        let score = if tie { Some(previous) } else { raw };
        let improved = matches!(score, Some(sc) if sc < previous);
        // the finished score decides, not the squeezed size: the finishing is the family's own
        let accepted = match score {
            Some(sc) => metropolis(previous, sc, temperature * previous, &mut ctx.rng),
            None => false,
        };
        if accepted {
            current = Some(s);
            current_score = score.expect("an accepted score");
            operators[op].accepted += 1;
        }
        if improved {
            operators[op].improvements += 1;
        }
        operators[op].success_rate = (1.0 - rate) * operators[op].success_rate + rate * (improved as u8 as f64);
        // A kick that comes back to the same minimum (a tie) counts as accepted: the kick was too
        // small to leave the basin, so it grows, as uphill rejections shrink it.
        if op == KICK {
            kick_magnitude = math::max(
                0.001,
                math::min(
                    10.0,
                    kick_magnitude * math::exp(rate * ((accepted || tie) as u8 as f64 - p.target_acceptance)),
                ),
            );
        }
        fin.step(ctx.used() - before);
    }
}

/// Which stop an `Err` of the loop is, for a caller that wants to tell a stop from a failure.
pub fn is_stop(t: &Throw) -> Option<StopReason> {
    match t {
        Throw::Stop(r) => Some(*r),
        _ => None,
    }
}
