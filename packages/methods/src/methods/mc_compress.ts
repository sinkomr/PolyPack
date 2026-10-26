/**
 * Monte Carlo compression (mc_compress) on any kernel: the polygon method of the same name
 * (docs/methods/mc_compress.md) written against the kernel. Design and measurements:
 * docs/methods/dimensions/mc_compress.md.
 *
 * Hard-particle Monte Carlo (mc-chain.ts). A sweep is P single-piece trials: a jiggle of a random
 * piece or, now and then, a random re-placement, each kept when the piece is clear. Every
 * shrinkEvery sweeps the chain tries to shrink by one fraction: the arrangement with the container
 * (setSize, which moves the pieces with it), else the centres alone, and then the container alone,
 * the last two where the space has them (sizeMoves in mc-chain.ts). Every globalEvery sweeps it
 * tries a move of the kernel's globals, the cell's shape where the space has one. The jiggle,
 * shrink and globals steps adapt separately to a target acceptance. With a positive temperature
 * a container expansion is sometimes tried and kept by the Metropolis rule on the size. After
 * stagnationSweeps sweeps without progress the chain is grown and started again (maxRestarts
 * times), else the method returns.
 */
import type { MethodContext, SpaceMethodDefinition } from "../framework";
import type { KernelState } from "../kernel";
import { randomInt } from "../random";
import {
  adaptStep,
  contract,
  HardChain,
  hardStart,
  jiggleGlobals,
  MIN_STEP,
  numeric,
  Progress,
  scaleCentres,
  sizeMoves,
} from "./mc-chain";

/** The largest jiggle, in steps (one step is about an inradius): about two bounding radii, as the polygon method's cap. */
const MAX_MOVE = 4;
/** The largest shrink fraction, as in the polygon method. */
const MAX_SHRINK = 0.05;
/** The largest move of the globals, in globalSteps. */
const MAX_GLOBAL = 1;

const defaults = {
  moveStep: 0.15,
  jumpRate: 0.02,
  shrinkFraction: 0.01,
  targetAcceptance: 0.3,
  adaptationGain: 1,
  adaptationSweeps: 20,
  shrinkEvery: 2,
  globalEvery: 10,
  globalStep: 0.1,
  initialExpansion: 0.05,
  warmupSweeps: 5,
  stagnationSweeps: 2000,
  maxRestarts: 20,
  restartExpansion: 1.15,
  initialTemperature: 0,
  coolingRate: 0.9995,
  offerShare: 0.2,
};
type Params = typeof defaults;

export const mcCompress: SpaceMethodDefinition = {
  name: "mc_compress",
  title: "Monte Carlo compression",
  summary: "Pieces jiggle at random, never overlapping, while the container keeps shrinking around them.",
  doc: "docs/methods/dimensions/mc_compress.md",
  requires: [],
  defaults,
  schema: {
    type: "object",
    title: "Monte Carlo compression",
    description:
      "Hard-particle single-piece moves and adaptive container shrinks, with optional size-energy annealing and restarts.",
    additionalProperties: false,
    properties: {
      moveStep: numeric(
        "Move step",
        "Initial jiggle amount in the kernel's steps (about one inradius each); adapts to the target acceptance.",
        defaults.moveStep,
        MIN_STEP,
        MAX_MOVE,
      ),
      jumpRate: numeric(
        "Jump rate",
        "Share of single-piece trials that re-place the piece at a random pose instead of jiggling it.",
        defaults.jumpRate,
        0,
        1,
      ),
      shrinkFraction: numeric(
        "Shrink fraction",
        "Initial fractional size decrease of a shrink attempt; adapts to the shrink acceptance.",
        defaults.shrinkFraction,
        MIN_STEP,
        MAX_SHRINK,
      ),
      targetAcceptance: numeric(
        "Target acceptance",
        "Target for jiggles, shrinks and globals moves, each measured separately.",
        defaults.targetAcceptance,
        0.01,
        0.99,
      ),
      adaptationGain: numeric(
        "Adaptation gain",
        "Steps multiply by exp(gain * (acceptance - target)) at each interval; zero keeps them fixed.",
        defaults.adaptationGain,
        0,
        10,
      ),
      adaptationSweeps: numeric(
        "Adaptation interval",
        "Sweeps per acceptance measurement and step update.",
        defaults.adaptationSweeps,
        1,
        10000,
        true,
      ),
      shrinkEvery: numeric(
        "Shrink interval",
        "Try to shrink, with and without the pieces, every this many sweeps.",
        defaults.shrinkEvery,
        1,
        1000,
        true,
      ),
      globalEvery: numeric(
        "Globals interval",
        "Try a move of the kernel's globals (a cell's shape) every this many sweeps; ignored without globals.",
        defaults.globalEvery,
        1,
        1000,
        true,
      ),
      globalStep: numeric(
        "Globals step",
        "Initial globals move, in the kernel's globalSteps; adapts to its acceptance.",
        defaults.globalStep,
        MIN_STEP,
        MAX_GLOBAL,
      ),
      initialExpansion: numeric(
        "Initial room",
        "A start used as given is contracted, then the container grows by this fraction (alone where the space allows) for the free-room sweeps.",
        defaults.initialExpansion,
        0,
        1,
      ),
      warmupSweeps: numeric(
        "Free-room sweeps",
        "Sweeps without shrinks or globals moves, at the start and after each restart.",
        defaults.warmupSweeps,
        0,
        1000,
        true,
      ),
      stagnationSweeps: numeric(
        "Stagnation sweeps",
        "Restart or return after this many sweeps without progress; zero never does.",
        defaults.stagnationSweeps,
        0,
        1000000,
        true,
      ),
      maxRestarts: numeric(
        "Restart limit",
        "Restarts after stagnation; at the limit the method returns early.",
        defaults.maxRestarts,
        0,
        10000,
        true,
      ),
      restartExpansion: numeric(
        "Restart expansion",
        "A restart grows the arrangement with the container (setSize) by this factor.",
        defaults.restartExpansion,
        1,
        2,
      ),
      initialTemperature: numeric(
        "Initial temperature",
        "Size-energy temperature in score units; zero is greedy compression, a positive value allows expansions.",
        defaults.initialTemperature,
        0,
        100,
      ),
      coolingRate: numeric("Cooling rate", "Temperature multiplier after every sweep.", defaults.coolingRate, 0, 1),
      offerShare: numeric(
        "Offer share",
        "Share of the evaluations spent finishing the chain's states; the start's offer and the last ones come on top.",
        defaults.offerShare,
        0.01,
        0.9,
      ),
    },
  },
  run: runCompression,
};

function runCompression(ctx: MethodContext): void {
  const k = ctx.kernel;
  const p = ctx.params as Params;
  const { state, given } = hardStart(ctx);
  // a start used as given is already the run's best; a generated one is offered at once
  const chain = new HardChain(ctx, state, p.offerShare, !given);
  // whether this space moves the centres and the container apart (reference disks, polyhedra,
  // curved) or only together (torus, surface, sphere, boundary)
  const moves = sizeMoves(k, state);
  if (given) {
    // A loose start keeps its contact pattern when it shrinks as a whole first.
    contract(chain, moves);
    chain.offer();
    // free room at the walls only, as the polygon method's explicit container: the contacts
    // stay, the pieces next to the walls can move; where the walls do not move alone, room
    // everywhere (setSize)
    if (p.initialExpansion > 0) chain.collective((t) => resize(t, 1 + p.initialExpansion), Infinity);
  } else chain.offer();

  /** The container alone where the space has that move, else the arrangement with it. */
  function resize(t: KernelState, f: number) {
    if (moves.walls) t.size *= f;
    else k.setSize(t, t.size * f);
  }

  let moveStep = p.moveStep;
  let shrinkFraction = p.shrinkFraction;
  let globalStep = p.globalStep;
  let temperature = p.initialTemperature;
  let warmupUntil = p.warmupSweeps;
  let restarts = 0;
  const progress = new Progress(chain);
  const counts = { move: [0, 0], shrink: [0, 0], global: [0, 0] };
  const tally = (c: number[], kept: boolean) => {
    c[0]++;
    if (kept) c[1]++;
  };

  for (let sweep = 1; ; sweep++) {
    for (let m = 0; m < k.P; m++) {
      const i = randomInt(ctx.rng, k.P);
      if (p.jumpRate > 0 && ctx.rng() < p.jumpRate) chain.jump(i);
      else tally(counts.move, chain.jiggle(i, moveStep));
    }
    if (sweep > warmupUntil && sweep % p.shrinkEvery === 0) {
      const f = 1 - shrinkFraction;
      const before = state.size;
      // the arrangement with the container (centres move in, pieces keep their size); where the
      // space has the moves, else the centres alone, which frees pieces at the walls (the polygon
      // method's contraction), and then the container alone (its enclosure)
      if (!chain.collective((t) => k.setSize(t, t.size * f), temperature) && moves.centres)
        chain.collective((t) => scaleCentres(k, t, f), temperature);
      if (moves.walls) chain.collective((t) => (t.size *= f), temperature);
      // a contraction counts when the size fell: the centres alone change no size
      tally(counts.shrink, state.size < before);
      if (temperature > 0 && ctx.rng() < 0.1) chain.collective((t) => resize(t, 1 + shrinkFraction), temperature);
    }
    if (k.globals > 0 && sweep > warmupUntil && sweep % p.globalEvery === 0)
      tally(
        counts.global,
        chain.collective((t) => jiggleGlobals(k, t, globalStep, ctx.rng), temperature),
      );
    if (sweep % p.adaptationSweeps === 0) {
      const rate = (c: number[]) => c[1] / c[0];
      const { targetAcceptance: target, adaptationGain: gain } = p;
      if (counts.move[0]) moveStep = adaptStep(moveStep, rate(counts.move), target, gain, MAX_MOVE);
      if (counts.shrink[0]) shrinkFraction = adaptStep(shrinkFraction, rate(counts.shrink), target, gain, MAX_SHRINK);
      if (counts.global[0]) globalStep = adaptStep(globalStep, rate(counts.global), target, gain, MAX_GLOBAL);
      for (const c of Object.values(counts)) c.fill(0);
      chain.rebase();
    }
    temperature *= p.coolingRate;
    chain.endSweep();
    progress.update(chain, sweep);

    if (p.stagnationSweeps > 0 && sweep - progress.sweep >= p.stagnationSweeps) {
      chain.offer();
      if (restarts >= p.maxRestarts) return;
      // A restart begins a new chain from the jammed one grown about the container's centre: not
      // an uphill step of the chain, and the framework's best is unaffected.
      if (!chain.grow(p.restartExpansion)) return;
      restarts++;
      warmupUntil = sweep + p.warmupSweeps;
      temperature = p.initialTemperature;
      moveStep = p.moveStep;
      shrinkFraction = p.shrinkFraction;
      globalStep = p.globalStep;
      for (const c of Object.values(counts)) c.fill(0);
      progress.reset(chain, sweep);
    }
  }
}
