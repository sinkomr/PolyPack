/**
 * Adaptive shrinking container (asc) on any kernel, after Torquato and Jiao's adaptive shrinking
 * cell: the polygon method of the same name (docs/methods/asc.md) written against the kernel.
 * Design, the mapping to periodic cells and measurements: docs/methods/dimensions/asc.md.
 *
 * Hard-particle Monte Carlo (mc-chain.ts) in which the container moves too. A sweep is P
 * single-piece trials, then one trial of each container and collective move:
 *  - drift: every piece moved by the same chart offset; in a container this is the container's
 *    translation relative to the pieces (the polygon method's container translation);
 *  - strain: a move of one of the kernel's globals at a fixed size, a change of the cell's shape
 *    where the space has a free cell (the shape part of Torquato and Jiao's cell strain);
 *  - scale: the container alone shrinks, or with a positive temperature sometimes grows; where the
 *    space has no move of the container alone (sizeMoves in mc-chain.ts: torus, surface, sphere,
 *    boundary), setSize, the arrangement with the container (the volume part of the cell strain);
 *  - radial and centres, only where the container moves alone: setSize to a smaller size, and the
 *    centres alone moving in (with the scale after it, the polygon method's radial strain).
 * Each move has its own amplitude, adapted to a target acceptance. Before the first sweep a run of
 * compressions shrinks a start used as given without changing its contact pattern. After
 * stagnationSweeps sweeps without progress the method returns.
 */
import type { MethodContext, SpaceMethodDefinition } from "../framework";
import type { KernelState } from "../kernel";
import { randomInt } from "../random";
import {
  adaptStep,
  drift,
  HardChain,
  hardStart,
  jiggleGlobals,
  MIN_STEP,
  numeric,
  Progress,
  scaleCentres,
  sizeMoves,
} from "./mc-chain";

const kinds = ["move", "drift", "strain", "radial", "centres", "scale"] as const;
type Kind = (typeof kinds)[number];

/** Each move's largest amplitude: jiggles and drifts in steps (about two bounding radii), strains in globalSteps, fractions 0.3 as in the polygon method. */
const MAXIMUM: Record<Kind, number> = { move: 4, drift: 4, strain: 1, radial: 0.3, centres: 0.3, scale: 0.3 };

const defaults = {
  moveStep: 0.15,
  jumpRate: 0.02,
  driftStep: 0.05,
  strainStep: 0.05,
  radialStep: 0.03,
  centresStep: 0.03,
  scaleStep: 0.01,
  targetAcceptance: 0.3,
  adaptationGain: 1,
  adaptationSweeps: 20,
  stagnationSweeps: 2000,
  radialWarmup: 64,
  temperature: 0,
  coolingRate: 0.9995,
  containerMoves: true,
  collectiveMoves: true,
  offerShare: 0.2,
};
type Params = typeof defaults;

export const asc: SpaceMethodDefinition = {
  name: "asc",
  title: "Adaptive shrinking container",
  summary: "Pieces jiggle without overlapping while the whole container drifts, changes shape and shrinks around them.",
  doc: "docs/methods/dimensions/asc.md",
  requires: [],
  defaults,
  schema: {
    type: "object",
    title: "Adaptive shrinking container",
    description:
      "Hard-particle Monte Carlo with collective translations, globals strains, radial compression and container scaling.",
    additionalProperties: false,
    properties: {
      moveStep: numeric(
        "Move step",
        "Initial jiggle amount in the kernel's steps (about one inradius each).",
        defaults.moveStep,
        MIN_STEP,
        MAXIMUM.move,
      ),
      jumpRate: numeric(
        "Jump rate",
        "Share of single-piece trials that re-place the piece at a random pose instead of jiggling it.",
        defaults.jumpRate,
        0,
        1,
      ),
      driftStep: numeric(
        "Collective translation",
        "Initial amount, in steps, of the offset that moves every piece at once (the container's translation).",
        defaults.driftStep,
        MIN_STEP,
        MAXIMUM.drift,
      ),
      strainStep: numeric(
        "Globals strain",
        "Initial move of the kernel's globals (a cell's shape) at a fixed size, in globalSteps; ignored without globals.",
        defaults.strainStep,
        MIN_STEP,
        MAXIMUM.strain,
      ),
      radialStep: numeric(
        "Radial strain",
        "Initial fractional size decrease of the arrangement with the container (setSize), where the container also moves alone.",
        defaults.radialStep,
        MIN_STEP,
        MAXIMUM.radial,
      ),
      centresStep: numeric(
        "Centre contraction",
        "Initial fractional contraction of the centres alone, the container staying, where the space has that move.",
        defaults.centresStep,
        MIN_STEP,
        MAXIMUM.centres,
      ),
      scaleStep: numeric(
        "Container scale",
        "Initial fractional size change of the container alone, or with the arrangement where it does not move alone; expansions use the Metropolis rule.",
        defaults.scaleStep,
        MIN_STEP,
        MAXIMUM.scale,
      ),
      targetAcceptance: numeric(
        "Target acceptance",
        "Adaptation target, the same for every move, each measured separately.",
        defaults.targetAcceptance,
        0.01,
        0.99,
      ),
      adaptationGain: numeric(
        "Adaptation gain",
        "Amplitudes multiply by exp(gain * (acceptance - target)); zero keeps them fixed.",
        defaults.adaptationGain,
        0,
        10,
      ),
      adaptationSweeps: numeric(
        "Adaptation interval",
        "Sweeps between amplitude updates.",
        defaults.adaptationSweeps,
        1,
        10000,
        true,
      ),
      stagnationSweeps: numeric(
        "Stagnation limit",
        "Return after this many sweeps without progress.",
        defaults.stagnationSweeps,
        1,
        1000000,
        true,
      ),
      radialWarmup: numeric(
        "Radial warmup",
        "Radial trials before the first sweep, adapting after each, to compress a loose start as a whole.",
        defaults.radialWarmup,
        0,
        256,
        true,
      ),
      temperature: numeric(
        "Temperature",
        "Size-energy temperature in score units; zero forbids every expansion.",
        defaults.temperature,
        0,
        100,
      ),
      coolingRate: numeric(
        "Cooling rate",
        "Temperature multiplier after every sweep.",
        defaults.coolingRate,
        0,
        1,
      ),
      containerMoves: {
        type: "boolean",
        title: "Container moves",
        description: "Collective translations and globals strains; the container scale stays on.",
        default: true,
      },
      collectiveMoves: {
        type: "boolean",
        title: "Collective moves",
        description: "Radial strains, centre contractions and the radial warmup.",
        default: true,
      },
      offerShare: numeric(
        "Offer share",
        "Share of the evaluations spent finishing the chain's states; the start's offer and the last ones come on top.",
        defaults.offerShare,
        0.01,
        0.9,
      ),
    },
  },
  run: runAsc,
};

function runAsc(ctx: MethodContext): void {
  const k = ctx.kernel;
  const p = ctx.params as Params;
  const { state, given } = hardStart(ctx);
  // a start used as given is already the run's best; a generated one is offered at once
  const chain = new HardChain(ctx, state, p.offerShare, !given);
  chain.offer();
  // Where the container moves alone (the reference disks, polyhedra, curved), scale is that move,
  // radial the arrangement with the container and centres the centres alone. Elsewhere (torus,
  // surface, sphere, boundary) setSize is the only size move: scale is setSize, and radial and
  // centres are left out (sizeMoves in mc-chain.ts).
  const moves = sizeMoves(k, state);

  let temperature = p.temperature;
  const amplitude: Record<Kind, number> = {
    move: p.moveStep,
    drift: p.driftStep,
    strain: p.strainStep,
    radial: p.radialStep,
    centres: p.centresStep,
    scale: p.scaleStep,
  };
  const window = Object.fromEntries(kinds.map((kind) => [kind, [0, 0]])) as Record<Kind, number[]>;
  const tally = (kind: Kind, kept: boolean) => {
    window[kind][0]++;
    if (kept) window[kind][1]++;
    return kept;
  };
  const adapt = (kind: Kind) => {
    const [tried, kept] = window[kind];
    if (!tried) return;
    amplitude[kind] = adaptStep(amplitude[kind], kept / tried, p.targetAcceptance, p.adaptationGain, MAXIMUM[kind]);
    window[kind].fill(0);
  };
  const trial = (kind: Kind, change: (t: KernelState) => void) => tally(kind, chain.collective(change, temperature));
  // the amplitudes as the polygon method uses them: the radial strain at its step, the container
  // translation and rotation (here drift and strain) uniform up to theirs, the scale between half
  // and all of its step
  const radial = () => moves.walls && trial("radial", (t) => k.setSize(t, t.size * (1 - amplitude.radial)));
  const centres = () => moves.centres && trial("centres", (t) => scaleCentres(k, t, 1 - amplitude.centres));
  const scale = (expand: boolean) => {
    const a = amplitude.scale * (0.5 + 0.5 * ctx.rng());
    const f = expand ? 1 + a : 1 - a;
    return trial("scale", (t) => (moves.walls ? (t.size *= f) : k.setSize(t, t.size * f)));
  };

  // The warmup keeps a loose start's contact pattern while it compresses. A random start has no
  // pattern to keep, and compressing it as a whole tends to cage pieces (one disk ringed by four).
  if (given && p.collectiveMoves)
    for (let n = 0; n < p.radialWarmup; n++) {
      if (moves.walls) radial();
      else scale(false);
      centres();
      for (const kind of ["radial", "centres", "scale"] as const) adapt(kind);
    }
  chain.offer();
  const progress = new Progress(chain);

  for (let sweep = 1; ; sweep++) {
    for (let m = 0; m < k.P; m++) {
      const i = randomInt(ctx.rng, k.P);
      if (p.jumpRate > 0 && ctx.rng() < p.jumpRate) chain.jump(i);
      else tally("move", chain.jiggle(i, amplitude.move));
    }
    if (p.containerMoves) {
      trial("drift", (t) => drift(k, t, amplitude.drift, ctx.rng));
      if (k.globals > 0) trial("strain", (t) => jiggleGlobals(k, t, amplitude.strain, ctx.rng));
    }
    if (p.collectiveMoves) {
      radial();
      centres();
    }
    scale(temperature > 0 && ctx.rng() < 0.2);

    if (sweep % p.adaptationSweeps === 0) {
      for (const kind of kinds) adapt(kind);
      chain.rebase();
    }
    temperature *= p.coolingRate;
    chain.endSweep();
    progress.update(chain, sweep);
    if (sweep - progress.sweep >= p.stagnationSweeps) {
      chain.offer();
      return;
    }
  }
}
