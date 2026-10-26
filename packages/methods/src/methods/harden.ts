/**
 * Soft-to-rigid hardening, after Yohei Nakajima, on any kernel with soft shapes.
 *
 * The method, its three-phase schedule (compress, follow the shape path, settle), its energy and
 * momentum update, and the default pressure, noise, softness and step counts come from his openly
 * published work, used here with thanks under its MIT licence:
 *   site        https://yoheinakajima.github.io/soft-to-rigid/
 *   repository  https://github.com/yoheinakajima/soft-to-rigid  (engine/engine2d.js, paper/main.pdf)
 * PolyPack's part is the port to the generic kernel (soft shapes by the kernel's setShape, the
 * energy and finishing of each space), the mapping of the evaluation budget onto the schedule,
 * restarts, and the closing squeeze. See docs/methods/dimensions/harden.md.
 *
 * Each run starts the pieces as their inscribed disks or balls (t = 0) at a roomy size, compresses
 * them under inward pressure, hardens them step by step into the true shapes (t rising to 1) while
 * the container keeps pushing, and settles at t = 1. Every offered state has the true shape: a
 * soft state is never offered. The framework keeps the best of the runs.
 */
import type { MethodContext, SpaceMethodDefinition } from "../framework";
import { squeeze } from "../local";
import { HardenDynamics, pieceLength } from "./harden-dynamics";
import { energyCost, offerFirst, offerTrueShape, withAllowance } from "./harden-offers";
import {
  HARDEN_PATHS,
  type HardenPath,
  type PhaseSteps,
  type RunCosts,
  pathShape,
  planPhases,
  planRuns,
  stepsFor,
} from "./harden-schedule";

/**
 * Charts are folded into their anchors this often (in steps). A step moves a piece by at most
 * 0.03 sqrt(dim) inradii, so a chart's offset stays within a few inradii, as in a local solve; a
 * piece whose chart rebase changes starts again from rest (HardenDynamics.rebase).
 */
const REBASE_INTERVAL = 64;
/** The size's unit (HardenDynamics.measureUnit) is measured this often, in steps, at one more gradient each. */
const UNIT_INTERVAL = 16;
/** The closing squeeze: its penalty weights, L-BFGS iterations per weight, and its allowance in gradient evaluations. */
const POLISH_MUS = [1e4, 1e5, 1e6];
const POLISH_ITERATIONS = 100;
const POLISH_GRADIENTS = 500;

const numeric = (
  title: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
) => ({ type: integer ? "integer" : "number", title, description, default: value, minimum, maximum }) as const;

export const harden: SpaceMethodDefinition = {
  name: "harden",
  title: "Soft-to-rigid hardening",
  summary:
    "Squeezes the pieces together as soft round blobs, then hardens them bit by bit into their real shapes while the walls keep pressing in.",
  doc: "docs/methods/dimensions/harden.md",
  requires: ["shape"],
  defaults: {
    path: "harden",
    pressure: 0.16,
    noise: 8,
    tau0: 1,
    compressSteps: 2500,
    morphSteps: 7500,
    settleSteps: 1500,
    restarts: 0,
    offerInterval: 1000,
    polish: true,
  },
  schema: {
    type: "object",
    title: "Soft-to-rigid hardening, after Yohei Nakajima",
    description:
      "Compress inscribed disks or balls under inward pressure, harden them into the true shapes, settle, and offer true shapes only. Best of independent seeded runs.",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        title: "Shape path",
        description:
          "harden: inscribed disks or balls become the true shapes (softness tau from tau0 to 0). rigid: true shapes throughout. snap: disks or balls, then the true shapes at once.",
        enum: [...HARDEN_PATHS],
        default: "harden",
      },
      pressure: numeric(
        "Inward pressure",
        "Pressure mu on the size, per inscribed diameter and per unit of a square container's side (twice that per unit of room): 3 mu while compressing, mu along the path, decaying to mu/10000 while settling. Default 0.16 is the reference's best-of-runs tuning for harden.",
        0.16,
        0.0001,
        4,
      ),
      noise: numeric(
        "Noise multiplier",
        "Multiplier nu of the decaying Gaussian noise: 0.015 nu inscribed diameters while compressing and 0.004 nu along the path, on every piece variable in piece units. Default 8 is the reference's tuning for harden; 0 disables noise.",
        8,
        0,
        64,
      ),
      tau0: numeric(
        "Starting softness",
        "Softness tau0 at the start of the harden path: 1 is the inscribed disk or ball, 0 the true shape. Ignored by the other paths.",
        1,
        0,
        1,
      ),
      compressSteps: numeric(
        "Compression steps",
        "Momentum steps of the compression phase in a full-length run (reference 2,500). A step costs one energy evaluation; an evaluation budget rescales all three phases in proportion so that a run always settles.",
        2500,
        0,
        1000000,
        true,
      ),
      morphSteps: numeric(
        "Path steps",
        "Momentum steps along the shape path in a full-length run (reference 7,500).",
        7500,
        1,
        1000000,
        true,
      ),
      settleSteps: numeric(
        "Settling steps",
        "Noise-free momentum steps with the true shape and decaying pressure in a full-length run (reference 1,500).",
        1500,
        0,
        1000000,
        true,
      ),
      restarts: numeric(
        "Runs",
        "Independent seeded runs sharing the budget equally. 0 chooses automatically: as many full-length runs as the evaluation budget allows (at least one, shortened if necessary), or runs until the time budget expires.",
        0,
        0,
        100000,
        true,
      ),
      offerInterval: numeric(
        "Settling steps per offer",
        "Settling steps between the offers of a run's current poses, besides the offer at its end; they leave a stopped run a nearly settled result. 0 offers only at the end.",
        1000,
        0,
        1000000,
        true,
      ),
      polish: {
        type: "boolean",
        title: "Closing squeeze",
        description:
          "After a run settles, squeeze its true shapes with rising penalty weights and offer the result too.",
        default: true,
      },
    },
  },
  run: (ctx) => runHarden(ctx),
};

export function runHarden(ctx: MethodContext): void {
  const k = ctx.kernel;
  const p = ctx.params;
  const path = p.path as HardenPath;
  const tau0 = p.tau0 as number;
  const full: PhaseSteps = {
    compress: p.compressSteps as number,
    morph: p.morphSteps as number,
    settle: p.settleSteps as number,
  };
  const fullSteps = full.compress + full.morph + full.settle;
  // Pressure and noise are stated per inscribed diameter, twice the inradius. The size moves in
  // units of room (HardenDynamics.unit), and the published pressure is per unit of a square
  // container's side, the reference's main container, whose side moves its walls by half as much:
  // so twice as much per unit of room.
  const diameter = 2 * pieceLength(k);
  const pressure = (p.pressure as number) * diameter * 2;
  // positional noise in inscribed diameters is twice as much in piece units (inradii)
  const noise = 2 * (p.noise as number);
  const offer = k.finishCost + (k.validateCost ?? k.finishCost);
  const polishEvals = POLISH_GRADIENTS * energyCost(k, true);
  const costs: RunCosts = {
    step: energyCost(k, true),
    measure: UNIT_INTERVAL,
    offer,
    full,
    interval: p.offerInterval as number,
    polish: p.polish ? polishEvals + offer : 0,
  };

  // Before any long work, a first result that the space's finishing can take: the supplied
  // start, a structured seed, or a random start relaxed apart (harden-offers.ts).
  offerFirst(ctx, [() => ctx.start ?? undefined, () => (k.seeds ? k.seeds(ctx.rng, 1)[0] : undefined)], () =>
    k.randomStart(ctx.rng),
  );

  const limited = Number.isFinite(ctx.remaining());
  const runs = planRuns(ctx.remaining(), costs, p.restarts as number);
  for (let run = 0; run < runs; run++) {
    // A supplied start replaces the random start of the first run.
    const supplied = run === 0 && ctx.start !== null;
    const s = supplied ? ctx.kernel.clone(ctx.start!) : k.randomStart(ctx.rng);

    // An evaluation allowance fixes the run's length: its share of what is left. Without one
    // every run has the full length and the time or the stop ends the last run.
    let c = costs;
    let steps = fullSteps;
    if (limited) {
      const share = Math.floor(ctx.remaining() / (runs - run));
      // a share too small for the closing squeeze goes to the steps
      if (c.polish > 0 && share < 4 * c.polish) c = { ...c, polish: 0 };
      steps = stepsFor(share, c);
      if (steps < 1) return;
    }
    const plan = planPhases(steps, full, !supplied);
    const total = plan.compress + plan.morph + plan.settle;
    const dyn = new HardenDynamics(k, s);
    let t = pathShape(path, 0, tau0);
    k.setShape!(s, t);
    let diverged = false;
    for (let done = 0; done < total; done++) {
      // the phase, the progress u along the path, and the reference's pressure and noise for this step
      let strength = pressure;
      let sigma = 0;
      if (done < plan.compress) {
        strength = 3 * pressure;
        sigma = 0.015 * noise * (1 - done / plan.compress);
      } else if (done < plan.compress + plan.morph) {
        const u = (done - plan.compress) / plan.morph;
        sigma = 0.004 * noise * (1 - u);
        const next = pathShape(path, u, tau0);
        if (next !== t) k.setShape!(s, (t = next));
      } else {
        if (t !== 1) k.setShape!(s, (t = 1));
        strength = pressure * 10 ** ((-4 * (done - plan.compress - plan.morph)) / plan.settle);
      }
      if (!dyn.step(strength, sigma, ctx.rng, done % UNIT_INTERVAL === 0)) {
        // a diverged state cannot be offered or continued; the next run starts afresh
        diverged = true;
        break;
      }
      if ((done + 1) % REBASE_INTERVAL === 0) dyn.rebase();
      // offers inside the run only while settling: earlier states are soft and overlap deeply
      const settled = done + 1 - plan.compress - plan.morph;
      if (settled > 0 && c.interval > 0 && settled % c.interval === 0 && done + 1 < total) offerTrueShape(ctx, s);
    }
    if (diverged) continue;
    k.rebase(s);
    offerTrueShape(ctx, s);
    if (c.polish > 0) {
      // The closing squeeze: the settled state keeps a slack of the order of the last pressure.
      // squeeze keeps the size above the bound, so a state pressed onto it starts just above.
      const q = k.clone(s);
      k.setShape!(q, 1);
      if (k.bound !== null && k.bound > 0 && q.size <= k.bound * (1 + 1e-9)) k.setSize(q, k.bound * (1 + 1e-6));
      squeeze(withAllowance(k, polishEvals).kernel, q, { mus: POLISH_MUS, maxIter: POLISH_ITERATIONS });
      ctx.offer(q);
    }
  }
}
