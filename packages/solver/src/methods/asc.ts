import { boundingRadius, containerInradius, findOverlaps, pieceInradius, TOL, type Container, type PackingConfig } from "@polypack/geometry";
import type { MethodContext, MethodDefinition } from "../framework";
import type { ParameterSchema } from "../schema";
import { adaptStep, feasible, MIN_STEP, strictEnclose } from "./mc_compress/state";
import { restore } from "./penalty/restoration";
import { AscState, collectiveTrial, configurationKey, fullyContained, moveKinds, type MoveKind } from "./asc/state";

/**
 * Single-piece trials between cooperative checkpoints. Stop and pause only take effect at a
 * checkpoint, and a sweep of P trials is far too long a stretch at large P.
 */
export const CHECKPOINT_MOVES = 16;

/** Stop polls per piece allowed to the shared repair; one of its sweeps takes about 15. */
const REPAIR_POLLS = 64;

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

export const ascMethod: MethodDefinition = {
  name: "asc",
  doc: "docs/methods/asc.md",
  defaults: {
    translationStep: 0.15,
    rotationStep: 0.15,
    containerTranslationStep: 0.05,
    containerRotationStep: 0.05,
    scaleStep: 0.01,
    balancedStep: 0.01,
    uniaxialStep: 0.01,
    sectorStep: 0.01,
    radialStep: 0.03,
    targetAcceptance: 0.3,
    adaptationGain: 1,
    adaptationSweeps: 20,
    sweepsPerEvaluation: 10,
    stagnationSweeps: 2000,
    radialWarmup: 64,
    seedEvals: 24,
    temperature: 0,
    coolingRate: 0.9995,
    containerMoves: true,
    collectiveMoves: true,
  },
  schema: {
    type: "object",
    title: "Adaptive shrinking container",
    description:
      "Hard-particle Monte Carlo with explicit container moves and centre strains in a fixed container shape.",
    additionalProperties: false,
    properties: {
      translationStep: numeric(
        "Translation step",
        "Particle coordinate proposal half-width in piece units.",
        0.15,
        MIN_STEP,
        100,
      ),
      rotationStep: numeric(
        "Rotation step",
        "Polygon angle proposal half-width in radians; omitted for circles.",
        0.15,
        MIN_STEP,
        Math.PI,
      ),
      containerTranslationStep: numeric(
        "Container translation",
        "Centre coordinate proposal half-width in piece units.",
        0.05,
        MIN_STEP,
        100,
      ),
      containerRotationStep: numeric(
        "Container rotation",
        "Explicit phi proposal half-width in radians; omitted for circles.",
        0.05,
        MIN_STEP,
        Math.PI,
      ),
      scaleStep: numeric(
        "Container scale",
        "Maximum fractional explicit size change; expansions use Metropolis acceptance.",
        0.01,
        MIN_STEP,
        0.3,
      ),
      balancedStep: numeric(
        "Balanced strain",
        "Maximum axial compression with reciprocal perpendicular expansion (determinant one).",
        0.01,
        MIN_STEP,
        0.3,
      ),
      uniaxialStep: numeric(
        "Uniaxial strain",
        "Maximum centre compression along a random axis; perpendicular coordinates stay fixed.",
        0.01,
        MIN_STEP,
        0.3,
      ),
      sectorStep: numeric(
        "Sector strain",
        "Maximum radial centre contraction restricted to a random half-plane or sector.",
        0.01,
        MIN_STEP,
        0.3,
      ),
      radialStep: numeric(
        "Radial strain",
        "Maximum isotropic centre contraction, coupled to an explicit conservative wall shrink.",
        0.03,
        MIN_STEP,
        0.3,
      ),
      targetAcceptance: numeric(
        "Target acceptance",
        "Independent adaptation target for each active move type.",
        0.3,
        0.01,
        0.99,
      ),
      adaptationGain: numeric(
        "Adaptation gain",
        "Steps multiply by exp(gain*(acceptance-target)); zero disables adaptation.",
        1,
        0,
        10,
      ),
      adaptationSweeps: numeric(
        "Adaptation interval",
        "Sweeps between independent move-type acceptance windows.",
        20,
        1,
        10000,
        true,
      ),
      sweepsPerEvaluation: numeric(
        "Evaluation interval",
        "Assess at fixed sweep intervals and after every accepted best-improving wall shrink; duplicates are skipped.",
        10,
        1,
        1000,
        true,
      ),
      stagnationSweeps: numeric(
        "Stagnation limit",
        "Stop after this many sweeps without a meaningful score improvement or wall compression.",
        2000,
        1,
        100000,
        true,
      ),
      radialWarmup: numeric(
        "Radial warmup",
        "Before diffusion, try this many adaptive isotropic strains to preserve a loose start's contact topology.",
        64,
        0,
        256,
        true,
      ),
      seedEvals: numeric(
        "Seed cap",
        "Small automatic seed slice, at least three assessments when available; invalid supplied starts first get a distinct safe bootstrap.",
        24,
        3,
        256,
        true,
      ),
      temperature: numeric(
        "Temperature",
        "Size-energy temperature in score units; zero forbids every accepted expansion.",
        0,
        0,
        100,
      ),
      coolingRate: numeric("Cooling rate", "Multiply temperature by this factor after each sweep.", 0.9995, 0, 1),
      containerMoves: {
        type: "boolean",
        title: "Container moves",
        description: "Enable explicit centre and phi trials; scaling stays active. Useful for ablation.",
        default: true,
      },
      collectiveMoves: {
        type: "boolean",
        title: "Collective moves",
        description: "Enable all centre strains and radial warmup. Useful for ablation.",
        default: true,
      },
    },
  },
  execute: executeAsc,
};

export interface MoveStatistics {
  attempts: number;
  accepted: number;
  improvements: number;
  scoreGain: number;
  amplitude: number;
}
export interface AscObservation {
  kind: "move" | "evaluation" | "adaptation" | "final";
  move?: MoveKind;
  accepted?: boolean;
  sweep: number;
  config: PackingConfig;
  container: Container;
  statistics: Record<MoveKind, MoveStatistics>;
}

/** Optional observer is synchronous and never supplies decisions or randomness. */
export async function executeAsc(ctx: MethodContext, observe?: (event: AscObservation) => void): Promise<void> {
  if (!(await ctx.checkpoint())) return;
  const seen = new Set<string>();
  if (ctx.start) seen.add(configurationKey(ctx.start));
  let initial = ctx.start;
  const usable = (c: PackingConfig | undefined): c is PackingConfig =>
    !!c && c.pieces.length === ctx.problem.P && !findOverlaps(c.N, c.pieces, 0).length;
  // strictEnclose leaves an outward margin of 2e-13 relative to the size. Far from the origin
  // coordinate roundoff exceeds it, and the state as given has no strict walls to start from.
  const workable = (c: PackingConfig | undefined): c is PackingConfig => {
    if (!usable(c)) return false;
    const walls = strictEnclose(c);
    return feasible(c, walls) && c.pieces.every((p) => fullyContained(c.N, p, walls));
  };
  // Contact-tight inputs (generated lattices, saved records) commonly touch at about -1e-16:
  // valid for the evaluator, but not a hard-particle state. Dilating every centre about the
  // centroid by f widens the gap of a pair (a, b) along its separating axis n by
  // (f-1) n.(b-a), and n.(b-a) is at least twice the piece apothem less the penetration,
  // because each piece contains its incircle. With d the deepest penetration, the f below
  // therefore leaves every gap at least about 2e-12 in one O(P) pass. The shared repair then parts
  // whatever roundoff left. On its own it takes 48 sweeps and a bisected uniform expansion
  // for a dense P=500 lattice (about 90 ms in one stretch), hence the dilation first and a
  // bound on its stop polls. Neither step draws random numbers. A state beyond the
  // evaluator's tolerance, or one still not workable, keeps the bootstrap below.
  const separated = (c: PackingConfig | undefined): PackingConfig | undefined => {
    if (!c || c.pieces.length !== ctx.problem.P) return undefined;
    let depth = 0;
    for (const overlap of findOverlaps(c.N, c.pieces, 0)) depth = Math.max(depth, -overlap.sep);
    if (depth > TOL) return undefined;
    const factor = 1 + (depth + 2e-12) / (2 * pieceInradius(c.N));
    const cx = c.pieces.reduce((sum, p) => sum + p.x, 0) / c.P;
    const cy = c.pieces.reduce((sum, p) => sum + p.y, 0) / c.P;
    const dilated = {
      ...c,
      pieces: c.pieces.map((p) => ({ ...p, x: cx + factor * (p.x - cx), y: cy + factor * (p.y - cy) })),
    };
    let polls = 0;
    const parted = restore(dilated, "separate", () => ++polls > REPAIR_POLLS * c.P || ctx.shouldStop());
    return workable(parted) ? parted : undefined;
  };
  const supplied = workable(initial);
  // A repaired start is a configuration nothing has scored yet.
  let repaired = false;
  if (!supplied) {
    initial = separated(ctx.start);
    repaired = !!initial;
  }
  if (!initial) {
    let bootstrap: PackingConfig | undefined;
    if (ctx.start) {
      // ctx.run inherits and counts its start. A distinct safe grid avoids
      // paying twice for the invalid input, and makes tiny-budget repair useful.
      const width = Math.ceil(Math.sqrt(ctx.problem.P));
      const pitch = 2.1 * boundingRadius(ctx.problem.N);
      bootstrap = {
        ...ctx.problem,
        container_phi: 0,
        pieces: Array.from({ length: ctx.problem.P }, (_, i) => ({
          x: pitch * (i % width),
          y: pitch * Math.floor(i / width),
          theta: 0,
        })),
      };
    }
    const slice = Math.min(
      ctx.remaining().evals,
      Math.max(3, Math.min(ctx.params.seedEvals as number, Math.floor(ctx.remaining().evals / 10))),
    );
    const seeded = await ctx.run(
      "seed",
      { kind: "auto", poolLimit: 0 },
      bootstrap ? { evals: slice, start: bootstrap } : { evals: slice },
    );
    initial = usable(seeded.found) ? seeded.found : seeded.best;
    if (!workable(initial)) {
      initial = separated(seeded.found ?? seeded.best);
      repaired = !!initial;
    }
    if (bootstrap) seen.add(configurationKey(bootstrap));
  }
  if (!initial || ctx.shouldStop()) return;
  seen.add(configurationKey(initial));
  const config = { ...initial, pieces: initial.pieces.map((p) => ({ ...p })) };
  // Enclosure is computed only at initialization; accepted trials keep their
  // own centre, orientation and size, even if that container has unused room.
  const state = new AscState(config, strictEnclose(config));
  if (
    !feasible(state.config, state.container) ||
    !state.config.pieces.every((p) => fullyContained(config.N, p, state.container))
  )
    return;
  // Only an assessment of this exact working state may be the score to beat. A supplied start
  // that was not used as given would otherwise hide every improvement: a tolerance-only score
  // is below that of each strict state near it, and a replaced start says nothing about ours.
  let bestScore = supplied && ctx.initialEvaluation?.valid ? ctx.initialEvaluation.score! : state.container.size;
  let temperature = ctx.params.temperature as number;
  let sweep = 0;
  let lastProgress = 0;
  let lastChanged: MoveKind = "radial";
  const parameters = [
    "translationStep",
    "rotationStep",
    "containerTranslationStep",
    "containerRotationStep",
    "scaleStep",
    "balancedStep",
    "uniaxialStep",
    "sectorStep",
    "radialStep",
  ];
  const statistics = Object.fromEntries(
    moveKinds.map((kind, i) => [
      kind,
      { attempts: 0, accepted: 0, improvements: 0, scoreGain: 0, amplitude: ctx.params[parameters[i]] as number },
    ]),
  ) as Record<MoveKind, MoveStatistics>;
  const windows = Object.fromEntries(moveKinds.map((kind) => [kind, { attempts: 0, accepted: 0 }])) as Record<
    MoveKind,
    { attempts: number; accepted: number }
  >;
  const notify = (kind: AscObservation["kind"], move?: MoveKind, accepted?: boolean) =>
    observe?.({
      kind,
      move,
      accepted,
      sweep,
      config: state.config,
      container: state.container,
      statistics: Object.fromEntries(moveKinds.map((k) => [k, { ...statistics[k] }])) as Record<
        MoveKind,
        MoveStatistics
      >,
    });
  const submit = async (): Promise<boolean> => {
    if (ctx.shouldStop()) return false;
    const key = configurationKey(state.config);
    if (seen.has(key)) return true;
    seen.add(key);
    notify("evaluation");
    const result = await ctx.evaluate(state.config, { autoOrient: false });
    if (!result) return false;
    if (!result.valid) throw new Error(`asc invariant: ${result.reasons.join("; ")}`);
    if (result.score! < bestScore) {
      const gain = bestScore - result.score!;
      statistics[lastChanged].improvements++;
      statistics[lastChanged].scoreGain += gain;
      if (gain > 1e-10 * Math.max(1, bestScore)) lastProgress = sweep;
      bestScore = result.score!;
    }
    return true;
  };
  const adapt = (kind: MoveKind) => {
    const interval = windows[kind];
    if (!interval.attempts) return;
    const maximum =
      kind === "translation" || kind === "containerTranslation"
        ? 2 * boundingRadius(config.N)
        : kind === "rotation" || kind === "containerRotation"
          ? Math.PI
          : 0.3;
    statistics[kind].amplitude = adaptStep(
      statistics[kind].amplitude,
      interval.accepted / interval.attempts,
      ctx.params.targetAcceptance as number,
      ctx.params.adaptationGain as number,
      maximum,
    );
    interval.attempts = 0;
    interval.accepted = 0;
  };
  // Piece trials are cheap and share a checkpoint; every other trial rechecks all P pieces and
  // rebuilds the cell grid, so each has its own. A checkpoint draws no random numbers, assesses
  // nothing and declines exactly when shouldStop() does, so it cannot alter a seeded result.
  let sinceCheckpoint = 0;
  const attempt = async (kind: MoveKind, proposal: () => boolean): Promise<boolean> => {
    if ((kind !== "translation" && kind !== "rotation") || ++sinceCheckpoint >= CHECKPOINT_MOVES) {
      sinceCheckpoint = 0;
      if (!(await ctx.checkpoint())) return false;
    }
    if (ctx.shouldStop()) return false;
    const before = state.container.size;
    statistics[kind].attempts++;
    windows[kind].attempts++;
    const accepted = proposal();
    if (accepted) {
      statistics[kind].accepted++;
      windows[kind].accepted++;
      // Centre/size-only changes are absent from the scored configuration.
      if (kind !== "containerTranslation" && kind !== "scale") lastChanged = kind;
      if (state.container.size < before - 1e-10 * Math.max(1, before)) lastProgress = sweep;
    }
    notify("move", kind, accepted);
    return !accepted || state.container.size >= bestScore || submit();
  };
  const radial = () => {
    const a = statistics.radial.amplitude;
    const trial = collectiveTrial(state.config, state.container, "radial", a, 0);
    if (configurationKey(trial) === configurationKey(state.config)) return false;
    // A unit piece lies in a bounding disk B. Scaling centres by f needs
    // wall size f*s+(1-f)*B/apothem, rather than scaling the rigid pieces.
    const unitWall = boundingRadius(config.N) / containerInradius(config.M);
    const size = (1 - a) * state.container.size + a * unitWall;
    return state.replace(trial, { ...state.container, size }, temperature, ctx.random);
  };
  try {
    if (repaired) {
      if (ctx.shouldStop()) return;
      // Counted like any other assessment. It also hands the framework a strictly separated
      // result, which a tolerance-only supplied start cannot block, before any trial is accepted.
      seen.add(configurationKey(state.config));
      notify("evaluation");
      const result = await ctx.evaluate(state.config, { autoOrient: false });
      if (!result) return;
      if (!result.valid) throw new Error(`asc invariant: ${result.reasons.join("; ")}`);
      bestScore = result.score!;
    }
    if (ctx.params.collectiveMoves) {
      for (let k = 0; k < (ctx.params.radialWarmup as number); k++) {
        if (!(await attempt("radial", radial))) return;
        adapt("radial");
      }
    }
    while (!ctx.shouldStop()) {
      sweep++;
      if (!(await ctx.checkpoint())) return;
      for (let k = 0; k < config.P; k++) {
        if (ctx.shouldStop()) return;
        const i = Math.floor(ctx.random() * config.P);
        const p = state.config.pieces[i];
        const kind = config.N !== 0 && ctx.random() < 0.5 ? "rotation" : "translation";
        const a = statistics[kind].amplitude;
        if (
          !(await attempt(kind, () =>
            state.move(
              i,
              kind === "rotation"
                ? { ...p, theta: p.theta + (2 * ctx.random() - 1) * a }
                : { ...p, x: p.x + (2 * ctx.random() - 1) * a, y: p.y + (2 * ctx.random() - 1) * a },
            ),
          ))
        )
          return;
      }
      if (ctx.params.containerMoves) {
        const a = statistics.containerTranslation.amplitude;
        if (
          !(await attempt("containerTranslation", () =>
            state.replace(
              state.config,
              {
                ...state.container,
                cx: state.container.cx + (2 * ctx.random() - 1) * a,
                cy: state.container.cy + (2 * ctx.random() - 1) * a,
              },
              temperature,
              ctx.random,
            ),
          ))
        )
          return;
        if (config.M !== 0) {
          const b = statistics.containerRotation.amplitude;
          const period = (2 * Math.PI) / config.M;
          if (
            !(await attempt("containerRotation", () =>
              state.replace(
                state.config,
                {
                  ...state.container,
                  phi: (((state.container.phi + (2 * ctx.random() - 1) * b) % period) + period) % period,
                },
                temperature,
                ctx.random,
              ),
            ))
          )
            return;
        }
      }
      if (ctx.params.collectiveMoves) {
        for (const kind of ["balanced", "uniaxial", "sector"] as const) {
          const amplitude = statistics[kind].amplitude * (0.5 + 0.5 * ctx.random());
          const angle = 2 * Math.PI * ctx.random();
          const halfWidth = ctx.random() < 0.5 ? Math.PI / 2 : Math.PI * (0.1 + 0.4 * ctx.random());
          if (
            !(await attempt(kind, () => {
              const trial = collectiveTrial(state.config, state.container, kind, amplitude, angle, halfWidth);
              return (
                configurationKey(trial) !== configurationKey(state.config) &&
                state.replace(trial, state.container, temperature, ctx.random)
              );
            }))
          )
            return;
        }
        if (!(await attempt("radial", radial))) return;
      }
      if (
        !(await attempt("scale", () => {
          const a = statistics.scale.amplitude * (0.5 + 0.5 * ctx.random());
          const expansion = temperature > 0 && ctx.random() < 0.2;
          return state.replace(
            state.config,
            { ...state.container, size: state.container.size * (1 + (expansion ? a : -a)) },
            temperature,
            ctx.random,
          );
        }))
      )
        return;
      if (sweep % (ctx.params.adaptationSweeps as number) === 0) {
        for (const kind of moveKinds) adapt(kind);
        notify("adaptation");
      }
      temperature *= ctx.params.coolingRate as number;
      if (sweep % (ctx.params.sweepsPerEvaluation as number) === 0 && !(await submit())) return;
      if (sweep - lastProgress >= (ctx.params.stagnationSweeps as number)) {
        await submit();
        return;
      }
    }
  } finally {
    notify("final");
  }
}
