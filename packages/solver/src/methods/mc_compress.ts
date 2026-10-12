import { boundingRadius, findOverlaps, type Container, type PackingConfig } from "@polypack/geometry";
import type { MethodContext, MethodDefinition } from "../framework";
import type { ParameterSchema } from "../schema";
import { adaptStep, CompressionState, feasible, MIN_STEP, strictEnclose } from "./mc_compress/state";

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

export const mcCompressMethod: MethodDefinition = {
  name: "mc_compress",
  doc: "docs/methods/mc_compress.md",
  defaults: {
    translationStep: 0.15,
    rotationStep: 0.15,
    shrinkFraction: 0.01,
    targetAcceptance: 0.3,
    adaptationGain: 1,
    adaptationSweeps: 20,
    sweepsPerEvaluation: 10,
    shrinkEvery: 2,
    orientEvery: 10,
    containerRotation: 0.1,
    initialExpansion: 0.05,
    warmupSweeps: 5,
    stagnationEvals: 500,
    maxRestarts: 0,
    restartExpansion: 1.15,
    seedEvals: 24,
    initialTemperature: 0,
    coolingRate: 0.9995,
  },
  schema: {
    type: "object",
    title: "Monte Carlo compression (settle)",
    description:
      "Hard-particle translations, rotations and adaptive container compression, with optional size-energy annealing.",
    additionalProperties: false,
    properties: {
      translationStep: numeric(
        "Translation step",
        "Initial uniform proposal half-width in each coordinate, in piece units.",
        0.15,
        MIN_STEP,
        100,
      ),
      rotationStep: numeric(
        "Rotation step",
        "Initial uniform polygon angle proposal half-width, in radians; circles ignore it.",
        0.15,
        MIN_STEP,
        Math.PI,
      ),
      shrinkFraction: numeric(
        "Shrink fraction",
        "Initial fractional centre contraction and container shrink; adapts to shrink acceptance.",
        0.01,
        MIN_STEP,
        0.5,
      ),
      targetAcceptance: numeric(
        "Target acceptance",
        "Target for translation, rotation and contraction separately.",
        0.3,
        0.01,
        0.99,
      ),
      adaptationGain: numeric(
        "Adaptation gain",
        "Multiply steps by exp(gain*(measured acceptance-target)); zero disables adaptation.",
        1,
        0,
        10,
      ),
      adaptationSweeps: numeric(
        "Adaptation interval",
        "Sweeps per independent acceptance-rate interval.",
        20,
        1,
        10000,
        true,
      ),
      sweepsPerEvaluation: numeric(
        "Evaluation interval",
        "Score every fixed number of sweeps, also after each accepted best-improving shrink.",
        10,
        1,
        1000,
        true,
      ),
      shrinkEvery: numeric(
        "Compression interval",
        "Attempt a centre contraction and a container-only shrink every this many sweeps.",
        2,
        1,
        1000,
        true,
      ),
      orientEvery: numeric(
        "Orientation interval",
        "Re-enclose fixed pieces at a trial phi every this many sweeps; ignored for circles.",
        10,
        1,
        1000,
        true,
      ),
      containerRotation: numeric(
        "Container angle step",
        "Trial phi half-width in radians; one in ten orientation proposals samples a full symmetry period.",
        0.1,
        0,
        Math.PI,
      ),
      initialExpansion: numeric(
        "Initial room",
        "Initial explicit-container room fraction; retained for warmupSweeps before compression.",
        0.05,
        0,
        1,
      ),
      warmupSweeps: numeric(
        "Free-room sweeps",
        "Sweeps without compression or container orientation changes, initially and after every restart.",
        5,
        0,
        1000,
        true,
      ),
      stagnationEvals: numeric(
        "Stagnation assessments",
        "Stop or restart after this many assessments without a meaningful accepted shrink or best improvement; zero disables detection.",
        500,
        0,
        1000000,
        true,
      ),
      maxRestarts: numeric(
        "Restart limit",
        "Maximum deterministic expansion restarts after stagnation; zero returns early. The scored best remains unchanged.",
        0,
        0,
        100,
        true,
      ),
      restartExpansion: numeric(
        "Restart expansion",
        "Factor expanding both centres and the container about its centre; positive-temperature restarts also reheat to the initial temperature.",
        1.15,
        1,
        2,
      ),
      seedEvals: numeric(
        "Seed evaluation cap",
        "Auto seed assessment cap; invalid supplied starts get at least three child assessments, clipped to remaining budget.",
        24,
        1,
        256,
        true,
      ),
      initialTemperature: numeric(
        "Initial temperature",
        "Size-energy temperature in score units; zero gives greedy compression; positive values permit container expansion.",
        0,
        0,
        100,
      ),
      coolingRate: numeric("Cooling rate", "Temperature multiplier after every sweep; T(k)=T(0)*rate^k.", 0.9995, 0, 1),
    },
  },
  execute: executeCompression,
};

export interface CompressionObservation {
  kind: "evaluation" | "adaptation" | "container" | "restart";
  sweep: number;
  config: PackingConfig;
  container: Container;
  attempts: number;
  accepted: number;
  translationStep: number;
  rotationStep: number;
  shrinkFraction: number;
  translationRate: number;
  rotationRate: number;
  shrinkRate: number;
  evaluations: number;
  restarts: number;
}

/** Optional synchronous observer supports internal invariant and throughput tests. */
export async function executeCompression(
  ctx: MethodContext,
  observe?: (event: CompressionObservation) => void,
): Promise<void> {
  if (!(await ctx.checkpoint())) return;
  let initial = ctx.start;
  const suppliedValid = initial?.pieces.length === ctx.problem.P && !findOverlaps(initial.N, initial.pieces, 0).length;
  if (!suppliedValid) {
    // A child first reassesses the inherited start. Reserve candidate assessments
    // as well, so an invalid start cannot consume the whole bootstrap slice.
    const slice = Math.max(
      initial ? 3 : 1,
      Math.min(ctx.params.seedEvals as number, Math.floor(ctx.remaining().evals / 10)),
    );
    const seeded = await ctx.run("seed", { kind: "auto" }, { evals: slice });
    initial = seeded.found ?? seeded.best;
  }
  if (!initial || ctx.shouldStop()) return;
  // Translation invariance removes large absolute-coordinate roundoff and
  // keeps every emitted coordinate within the shared parser's accepted range.
  // The bounding-box midpoint, unlike a centroid, keeps a maximally skewed
  // configuration inside ±MAX_COORD when its full span is 2*MAX_COORD.
  const cx = (Math.min(...initial.pieces.map((p) => p.x)) + Math.max(...initial.pieces.map((p) => p.x))) / 2;
  const cy = (Math.min(...initial.pieces.map((p) => p.y)) + Math.max(...initial.pieces.map((p) => p.y))) / 2;
  const config = { ...initial, pieces: initial.pieces.map((p) => ({ ...p, x: p.x - cx, y: p.y - cy })) };
  // Tiny negative seed contacts caused by coordinate arithmetic are expanded
  // before entering the chain; the evaluator's tolerance is never free space.
  if (findOverlaps(config.N, config.pieces, 0).length) {
    for (const p of config.pieces) {
      p.x *= 1 + 1e-12;
      p.y *= 1 + 1e-12;
    }
  }
  const tight = strictEnclose(config);
  let state = new CompressionState(config, {
    ...tight,
    size: tight.size * (1 + (ctx.params.initialExpansion as number)),
  });
  if (!feasible(state.config, state.container)) return;
  let bestScore = ctx.initialEvaluation?.valid ? ctx.initialEvaluation.score! : tight.size;
  let translationStep = ctx.params.translationStep as number;
  let rotationStep = ctx.params.rotationStep as number;
  let shrinkFraction = ctx.params.shrinkFraction as number;
  let temperature = ctx.params.initialTemperature as number;
  let sweep = 0;
  let evaluations = 0;
  let restarts = 0;
  let lastProgress = 0;
  let warmupUntil = ctx.params.warmupSweeps as number;
  let attempts = 0;
  let accepted = 0;
  let translationAttempts = 0;
  let translationAccepted = 0;
  let rotationAttempts = 0;
  let rotationAccepted = 0;
  let shrinkAttempts = 0;
  let shrinkAccepted = 0;
  const notify = (kind: CompressionObservation["kind"]) =>
    observe?.({
      kind,
      sweep,
      config: state.config,
      container: state.container,
      attempts,
      accepted,
      translationStep,
      rotationStep,
      shrinkFraction,
      translationRate: translationAttempts ? translationAccepted / translationAttempts : 0,
      rotationRate: rotationAttempts ? rotationAccepted / rotationAttempts : 0,
      shrinkRate: shrinkAttempts ? shrinkAccepted / shrinkAttempts : 0,
      evaluations,
      restarts,
    });
  const submit = async (): Promise<boolean> => {
    if (ctx.shouldStop()) return false;
    notify("evaluation");
    const evaluation = await ctx.evaluate(state.config, { autoOrient: false });
    if (!evaluation) return false;
    evaluations++;
    if (!evaluation.valid) throw new Error(`mc_compress invariant: ${evaluation.reasons.join("; ")}`);
    if (evaluation.score! < bestScore - 1e-9 * Math.max(1, bestScore)) lastProgress = evaluations;
    bestScore = Math.min(bestScore, evaluation.score!);
    return ctx.checkpoint();
  };
  const afterContainer = async (before: number): Promise<boolean> => {
    if (state.container.size < before - 1e-9 * Math.max(1, before)) lastProgress = evaluations;
    notify("container");
    return state.container.size < bestScore ? submit() : true;
  };
  // A loose supplied start can be compressed without first losing its structure
  // to diffusion. Seed starts keep their initial free room for equilibration.
  const initialSize = state.container.size;
  if (suppliedValid && state.initialContraction(ctx.shouldStop, ctx.params.initialExpansion as number)) {
    if (!(await afterContainer(initialSize))) return;
  }
  while (!ctx.shouldStop()) {
    sweep++;
    // Yield every sweep as well as every assessment, even if evaluation spacing
    // is large; timer aborts must reach the synchronous Monte Carlo hot loop.
    if (!(await ctx.checkpoint())) return;
    for (let move = 0; move < config.P; move++) {
      if (ctx.shouldStop()) return;
      const i = Math.floor(ctx.random() * config.P);
      const p = state.config.pieces[i];
      const rotate = config.N !== 0 && ctx.random() < 0.5;
      const trial = rotate
        ? { ...p, theta: p.theta + (2 * ctx.random() - 1) * rotationStep }
        : {
            ...p,
            x: p.x + (2 * ctx.random() - 1) * translationStep,
            y: p.y + (2 * ctx.random() - 1) * translationStep,
          };
      attempts++;
      if (rotate) rotationAttempts++;
      else translationAttempts++;
      if (state.move(i, trial)) {
        accepted++;
        if (rotate) rotationAccepted++;
        else translationAccepted++;
      }
    }
    if (sweep > warmupUntil && sweep % (ctx.params.shrinkEvery as number) === 0) {
      shrinkAttempts++;
      const trial = state.contracted(1 - shrinkFraction);
      const enclosure = strictEnclose(trial, state.container.phi);
      let before = state.container.size;
      if (state.replace(trial, enclosure, 0, ctx.random)) {
        shrinkAccepted++;
        if (!(await afterContainer(before))) return;
      }
      if (ctx.shouldStop()) return;
      const fixed = strictEnclose(state.config, state.container.phi);
      // Try both finite wall motion and exact re-centring. The tight enclosure
      // removes unused slack even when contraction is blocked by a pair contact.
      const smaller = { ...state.container, size: state.container.size * (1 - shrinkFraction) };
      before = state.container.size;
      if (state.replace(state.config, smaller, 0, ctx.random) && !(await afterContainer(before))) return;
      before = state.container.size;
      if (state.replace(state.config, fixed, 0, ctx.random) && !(await afterContainer(before))) return;
      if (temperature > 0 && ctx.random() < 0.1) {
        const larger = { ...state.container, size: state.container.size * (1 + shrinkFraction) };
        before = state.container.size;
        if (state.replace(state.config, larger, temperature, ctx.random) && !(await afterContainer(before))) return;
      }
    }
    if (sweep > warmupUntil && config.M !== 0 && sweep % (ctx.params.orientEvery as number) === 0) {
      const period = (2 * Math.PI) / config.M;
      const phi =
        ctx.random() < 0.1
          ? ctx.random() * period
          : state.container.phi + (2 * ctx.random() - 1) * (ctx.params.containerRotation as number);
      const trial = strictEnclose(state.config, phi);
      const before = state.container.size;
      if (state.replace(state.config, trial, temperature, ctx.random) && !(await afterContainer(before))) return;
    }
    if (sweep % (ctx.params.adaptationSweeps as number) === 0) {
      notify("adaptation");
      const target = ctx.params.targetAcceptance as number;
      const gain = ctx.params.adaptationGain as number;
      if (translationAttempts)
        translationStep = adaptStep(
          translationStep,
          translationAccepted / translationAttempts,
          target,
          gain,
          2 * boundingRadius(config.N),
        );
      if (rotationAttempts)
        rotationStep = adaptStep(rotationStep, rotationAccepted / rotationAttempts, target, gain, Math.PI / config.N);
      if (shrinkAttempts)
        shrinkFraction = adaptStep(shrinkFraction, shrinkAccepted / shrinkAttempts, target, gain, 0.05);
      translationAttempts = 0;
      translationAccepted = 0;
      rotationAttempts = 0;
      rotationAccepted = 0;
      shrinkAttempts = 0;
      shrinkAccepted = 0;
    }
    temperature *= ctx.params.coolingRate as number;
    if (sweep % (ctx.params.sweepsPerEvaluation as number) === 0 && !(await submit())) return;
    const stagnation = ctx.params.stagnationEvals as number;
    if (stagnation > 0 && evaluations - lastProgress >= stagnation) {
      if (restarts >= (ctx.params.maxRestarts as number)) return;
      const factor = ctx.params.restartExpansion as number;
      const trial = state.contracted(factor);
      const container = { ...state.container, size: state.container.size * factor };
      if (!feasible(trial, container)) return;
      // A restart begins a new chain, rather than an uphill MC acceptance.
      // Its expanded state cannot replace the separately retained scored best.
      state = new CompressionState(trial, container);
      restarts++;
      lastProgress = evaluations;
      warmupUntil = sweep + (ctx.params.warmupSweeps as number);
      temperature = ctx.params.initialTemperature as number;
      translationStep = ctx.params.translationStep as number;
      rotationStep = ctx.params.rotationStep as number;
      shrinkFraction = ctx.params.shrinkFraction as number;
      translationAttempts = 0;
      translationAccepted = 0;
      rotationAttempts = 0;
      rotationAccepted = 0;
      shrinkAttempts = 0;
      shrinkAccepted = 0;
      notify("restart");
    }
  }
}
