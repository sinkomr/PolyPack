import { findOverlaps, type PackingConfig } from "@polypack/geometry";
import type { MethodDefinition } from "../framework";
import type { ParameterSchema } from "../schema";
import { restore, scatter } from "./penalty/restoration";
import { monteCarloStage, penaltyStage } from "./morph/local";
import { rescale, roundedShape, type MorphShape } from "./morph/shapes";

function numeric(
  title: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
): ParameterSchema {
  return { type: integer ? "integer" : "number", title, description, default: value, minimum, maximum };
}

export const morphMethod: MethodDefinition = {
  name: "morph",
  doc: "docs/methods/morph.md",
  defaults: {
    path: "rounded",
    family: "inscribed",
    localMethod: "penalty",
    stages: 7,
    spacing: 1,
    adaptive: true,
    residualThreshold: 0.02,
    maxExponent: 32,
    vertices: 64,
    innerIterations: 120,
    outerIterations: 6,
    initialWeight: 10,
    jitter: 0.03,
    mcSweeps: 2000,
    translationStep: 0.1,
    rotationStep: 0.1,
  },
  schema: {
    type: "object",
    title: "Shape continuation",
    description:
      "Carry a circle arrangement toward the true polygon, repairing and scoring only true-shape configurations.",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        title: "Shape path",
        description:
          "Rounded Minkowski sums for every polygon; superellipses for squares (other polygons use rounded). Superellipse stages use hard-particle Monte Carlo for either localMethod.",
        enum: ["rounded", "superellipse"],
        default: "rounded",
      },
      family: {
        type: "string",
        title: "Rounded family",
        description:
          "Inscribed starts with the polygon inradius circle and grows inside P; circumscribed starts with its circumradius circle and shrinks around P. Ignored for superellipses.",
        enum: ["inscribed", "circumscribed"],
        default: "inscribed",
      },
      localMethod: {
        type: "string",
        title: "Local optimizer",
        description:
          "Analytic augmented penalty with L-BFGS or hard-particle Monte Carlo compression. Circle pieces receive one stage. Finite superellipses always use Monte Carlo.",
        enum: ["penalty", "mc_compress"],
        default: "penalty",
      },
      stages: numeric(
        "Stages",
        "Number of base stages including t=0 and t=1; adaptive subdivision may add at most two stages per interval.",
        7,
        2,
        64,
        true,
      ),
      spacing: numeric(
        "Schedule power",
        "Base schedule t=(j/(stages-1))^spacing; finite superellipse exponents increase geometrically to maxExponent before the exact square.",
        1,
        0.25,
        4,
      ),
      adaptive: {
        type: "boolean",
        title: "Adaptive schedule",
        description:
          "Halve the next shape step after a large residual, at most twice per base interval. Monte Carlo stages have zero overlap residual.",
        default: true,
      },
      residualThreshold: numeric(
        "Residual threshold",
        "Positive stage violation in piece units that triggers a smaller next shape step.",
        0.02,
        0,
        1,
      ),
      maxExponent: numeric(
        "Largest superellipse exponent",
        "Largest finite p before the exact-square endpoint. Hausdorff error to the square is at most (1-2^(-1/p))/sqrt(2).",
        32,
        2,
        128,
      ),
      vertices: numeric(
        "Superellipse vertices",
        "Uniform polar samples, rounded up to a multiple of eight; inscribed polygon Hausdorff error <= pi/K. Final stage uses the exact square.",
        64,
        16,
        256,
        true,
      ),
      innerIterations: numeric(
        "Inner iterations",
        "Maximum accepted L-BFGS iterations per outer solve, further capped by the stage assessment slice.",
        120,
        1,
        2000,
        true,
      ),
      outerIterations: numeric(
        "Outer solves",
        "Maximum augmented penalty solves per shape, stopping when a solve repeats its state or stalls without a step.",
        6,
        1,
        30,
        true,
      ),
      initialWeight: numeric(
        "Initial penalty weight",
        "Squared violation weight, increased fourfold if residual reduction stalls.",
        10,
        0.001,
        1e8,
      ),
      jitter: numeric(
        "Initial perturbation",
        "Seeded translation and angle jitter before continuation; the assessed start remains a fallback.",
        0.03,
        0,
        0.5,
      ),
      mcSweeps: numeric(
        "Monte Carlo sweeps",
        "Maximum P-move sweeps per shape; stops after 40 unchanged or 200 size-stagnant sweeps.",
        2000,
        1,
        20000,
        true,
      ),
      translationStep: numeric(
        "Translation step",
        "Initial uniform displacement half-width for Monte Carlo, adapted toward 30 percent acceptance.",
        0.1,
        0.000001,
        0.5,
      ),
      rotationStep: numeric(
        "Rotation step",
        "Initial uniform angular displacement half-width in radians for Monte Carlo.",
        0.1,
        0.000001,
        0.5,
      ),
    },
  },
  async execute(ctx) {
    if (!(await ctx.checkpoint())) return;
    const seen = new Set<string>();
    const rawSeen = new Set<string>();
    // Circle angles do not describe a different packing. Canonical scalar arrays
    // also make duplicate detection independent of pose property order.
    const signature = (config: PackingConfig) =>
      JSON.stringify([
        config.pieces.map((p) => (config.N === 0 ? [p.x, p.y] : [p.x, p.y, p.theta])),
        config.M === 0 ? 0 : config.container_phi,
      ]);
    if (ctx.start) seen.add(signature(ctx.start));
    let initial = ctx.start?.pieces.length === ctx.problem.P ? ctx.start : undefined;
    if (!ctx.start) {
      const remaining = ctx.remaining().evals;
      const slice = Number.isFinite(remaining) ? Math.max(3, Math.min(24, Math.floor(remaining / 20))) : 24;
      const seeded = await ctx.run("seed", { kind: "auto", poolLimit: 0 }, { evals: slice });
      initial = seeded.found ?? seeded.best;
      if (initial) seen.add(signature(initial));
    }
    if (ctx.shouldStop()) return;
    initial ??= scatter(ctx.problem, ctx.random);
    let config = { ...initial, pieces: initial.pieces.map((p) => ({ ...p })) };
    // Restoration is necessary even for server-valid starts with a tiny negative pair gap.
    if (findOverlaps(config.N, config.pieces, 0).length || config.pieces.length !== config.P) {
      config = restore(config, "expand", ctx.shouldStop, ctx.random) ?? scatter(ctx.problem, ctx.random);
    }
    const submit = async (trial: PackingConfig): Promise<boolean> => {
      if (ctx.shouldStop()) return false;
      const rawKey = signature(trial);
      if (rawSeen.has(rawKey)) return true;
      rawSeen.add(rawKey);
      const repaired = restore(trial, "expand", ctx.shouldStop, ctx.random);
      if (!repaired || findOverlaps(repaired.N, repaired.pieces, 0).length) return !ctx.shouldStop();
      const key = signature(repaired);
      if (seen.has(key)) return true;
      seen.add(key);
      return (await ctx.evaluate(repaired, { autoOrient: false })) !== undefined;
    };
    if (!(await submit(config))) return;
    // Recenter with the bounding-box midpoint: accepted extreme coordinates remain in range.
    const cx = (Math.min(...config.pieces.map((p) => p.x)) + Math.max(...config.pieces.map((p) => p.x))) / 2;
    const cy = (Math.min(...config.pieces.map((p) => p.y)) + Math.max(...config.pieces.map((p) => p.y))) / 2;
    config = { ...config, pieces: config.pieces.map((p) => ({ ...p, x: p.x - cx, y: p.y - cy })) };
    const jitter = ctx.params.jitter as number;
    for (const p of config.pieces) {
      p.x += jitter * (2 * ctx.random() - 1);
      p.y += jitter * (2 * ctx.random() - 1);
      if (config.N !== 0) p.theta += jitter * (2 * ctx.random() - 1);
    }
    const stages = config.N === 0 ? 1 : (ctx.params.stages as number);
    const schedule =
      config.N === 0
        ? [1]
        : Array.from({ length: stages }, (_, j) => (j / (stages - 1)) ** (ctx.params.spacing as number));
    let previousT = 0;
    let residual = 0;
    let subdivisions = 0;
    while (schedule.length && !ctx.shouldStop()) {
      if (!(await ctx.checkpoint())) return;
      let t = schedule.shift()!;
      if (
        ctx.params.adaptive &&
        residual > (ctx.params.residualThreshold as number) &&
        t > previousT &&
        subdivisions < 2
      ) {
        schedule.unshift(t);
        t = (previousT + t) / 2;
        subdivisions++;
      } else {
        subdivisions = 0;
      }
      let shape: MorphShape = roundedShape(config.N, t, ctx.params.family as "inscribed" | "circumscribed");
      if (config.N === 4 && ctx.params.path === "superellipse" && t < 1) {
        shape = {
          scale: 1,
          padding: 0,
          p:
            2 *
            ((ctx.params.maxExponent as number) / 2) **
              Math.min(1, t / (stages > 2 ? ((stages - 2) / (stages - 1)) ** (ctx.params.spacing as number) : 1)),
          vertices: 8 * Math.ceil((ctx.params.vertices as number) / 8),
        };
      }
      const scaled = await rescale(config, shape, ctx.shouldStop, ctx.checkpoint);
      if (!scaled) break;
      config = scaled;
      const remaining = ctx.remaining().evals;
      const slice = Number.isFinite(remaining) ? Math.max(1, Math.floor(remaining / (schedule.length + 1))) : Infinity;
      const local = ctx.params.localMethod === "mc_compress" || shape.p !== undefined ? monteCarloStage : penaltyStage;
      const outcome = await local(ctx, config, shape, slice, submit);
      config = outcome.config;
      residual = outcome.residual;
      previousT = t;
      if (!(await submit(config))) return;
    }
    // The last raw state is repaired even when a stage failed; duplicate assessment is skipped.
    await submit(config);
  },
};
