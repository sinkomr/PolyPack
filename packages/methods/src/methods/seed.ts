/**
 * seed: many cheap starts rather than one deep optimisation (docs/methods/dimensions/seed.md).
 * Starts come from the kernel's structured seeds (capability "seeds") and its random starts
 * (seed-starts.ts); each gets a short squeeze, a few L-BFGS iterations at a few rising weights, and
 * is offered, so the run keeps the best start found. Its result is a good start for penalty or
 * basin_hopping.
 */
import type { MethodContext, SpaceMethodDefinition } from "../framework";
import type { KernelState, SpaceKernel } from "../kernel";
import { relax, squeeze } from "../local";
import { StartStream, fitIterations } from "./seed-starts";

interface SeedParams {
  seedShare: number;
  batch: number;
  squeeze: number;
  iterations: number;
  jitter: number;
  starts: number;
}

/** The short relaxation of a start: a squeeze at weights 10 ... 10^squeeze, or a relaxation at its size. */
function settle(k: SpaceKernel, s: KernelState, p: SeedParams, maxIter: number): void {
  if (p.squeeze === 0) relax(k, s, { maxIter });
  else squeeze(k, s, { mus: Array.from({ length: p.squeeze }, (_, i) => 10 ** (i + 1)), maxIter });
}

function run(ctx: MethodContext): void {
  const p = ctx.params as unknown as SeedParams;
  const k = ctx.kernel;
  const starts = new StartStream(ctx, p.seedShare, p.batch, p.jitter);
  for (let n = 0; p.starts === 0 || n < p.starts; n++) {
    const s = n === 0 && ctx.start ? starts.given(ctx.start) : starts.next();
    settle(k, s, p, fitIterations(ctx, p.iterations, p.squeeze + 1, !ctx.best()));
    ctx.offer(s);
  }
}

export const seed: SpaceMethodDefinition = {
  name: "seed",
  title: "Seeds",
  summary: "Tries many quick starting layouts, settles each one briefly, and keeps the tightest.",
  doc: "docs/methods/dimensions/seed.md",
  requires: [],
  defaults: {
    seedShare: 0.5,
    batch: 8,
    squeeze: 4,
    iterations: 200,
    jitter: 0.1,
    starts: 0,
  },
  schema: {
    type: "object",
    title: "Seeds",
    description:
      "Offer many cheap starts, the space's structured seeds and random layouts, each after a short squeeze; keep the best.",
    additionalProperties: false,
    properties: {
      seedShare: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.5,
        title: "Seed share",
        description:
          "Fraction of the starts taken from the space's structured seeds, where it has them; the rest are random. Once the seeds give nothing new, every start is random.",
      },
      batch: {
        type: "integer",
        minimum: 1,
        maximum: 256,
        default: 8,
        title: "Seed batch",
        description: "Structured seeds asked of the space at once; each costs one evaluation.",
      },
      squeeze: {
        type: "integer",
        minimum: 0,
        maximum: 8,
        default: 4,
        title: "Squeeze weights",
        description:
          "The short squeeze uses the weights 10, 100, ... up to 10^k; 0 only relaxes each start at its size.",
      },
      iterations: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        default: 200,
        title: "Iterations",
        description: "L-BFGS iterations per weight of the short squeeze.",
      },
      jitter: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.1,
        title: "Jitter",
        description:
          "Seeded move of every structured start, in piece steps; a given start moves 1e-4 of it, random starts not at all; 0 disables it.",
      },
      starts: {
        type: "integer",
        minimum: 0,
        maximum: 1000000,
        default: 0,
        title: "Starts",
        description: "Starts to offer, the given start first; 0 offers starts while the budget lasts.",
      },
    },
  },
  run,
};
