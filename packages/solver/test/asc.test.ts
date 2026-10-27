import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  boundingRadius,
  containerProtrusions,
  evaluate,
  findOverlaps,
  pieceSeparation,
  type Container,
  type PackingConfig,
} from "@polypack/geometry";
import { MethodRegistry, registry, run, seededRandom, type MethodContext, type SubRunResult } from "../src/index";
import { ascMethod, CHECKPOINT_MOVES, executeAsc, type AscObservation } from "../src/methods/asc";
import { seedMethod } from "../src/methods/seed";
import { AscState, collectiveTrial, configurationKey, fullyContained, moveKinds } from "../src/methods/asc/state";
import { adaptStep, feasible, MIN_STEP, strictEnclose } from "../src/methods/mc_compress/state";

function grid(N: number, M: number, P: number): PackingConfig {
  const width = Math.ceil(Math.sqrt(P));
  const pitch = 2.6 * boundingRadius(N);
  return {
    N,
    M,
    P,
    container_phi: 0.17,
    pieces: Array.from({ length: P }, (_, i) => ({
      x: pitch * (i % width),
      y: pitch * Math.floor(i / width),
      theta: 0.23,
    })),
  };
}

function assertState(config: PackingConfig, container: Container): void {
  expect(config.pieces).toHaveLength(config.P);
  expect(findOverlaps(config.N, config.pieces, 0)).toEqual([]);
  for (let i = 0; i < config.P; i++) {
    expect(containerProtrusions(config.N, config.pieces[i], container).every((p) => p.depth <= 0)).toBe(true);
    for (let j = 0; j < i; j++)
      expect(pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep).toBeGreaterThanOrEqual(0);
  }
}

async function instrument(
  start: PackingConfig,
  params: Record<string, unknown>,
  limit: number,
  observer: (event: AscObservation) => void,
  checkpoint: () => Promise<void> = async () => {},
): Promise<number> {
  let count = 0;
  const seen = new Set([configurationKey(start)]);
  const ctx: MethodContext = {
    problem: { N: start.N, M: start.M, P: start.P },
    start,
    starts: [],
    initialEvaluation: evaluate(start, { autoOrient: false }),
    params: { ...ascMethod.defaults, ...params },
    random: seededRandom(73),
    shouldStop: () => count >= limit,
    checkpoint: async () => {
      await checkpoint();
      return count < limit;
    },
    remaining: () => ({ evals: limit - count, time_s: Infinity }),
    evaluate: async (config, options) => {
      expect(options).toEqual({ autoOrient: false });
      const key = configurationKey(config);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      count++;
      const result = evaluate(config, options);
      expect(result.valid).toBe(true);
      expect(findOverlaps(config.N, config.pieces, 0)).toEqual([]);
      return result;
    },
    emit: async () => {
      throw new Error("Unexpected emission");
    },
    run: async () => {
      throw new Error("Unexpected seeding");
    },
  };
  await executeAsc(ctx, observer);
  return count;
}

describe("asc", () => {
  it("registers JSON Schema tooltips and defaults and rejects unknown parameters", async () => {
    const method = registry.list().find((m) => m.name === "asc")!;
    expect(method.schema.title).toBeTruthy();
    expect(method.schema.description).toBeTruthy();
    for (const [name, property] of Object.entries(method.schema.properties!)) {
      expect(property.title).toBeTruthy();
      expect(property.description).toBeTruthy();
      expect(property.default).toEqual(method.defaults[name]);
    }
    await expect(
      run({ N: 0, M: 0, P: 1 }, { method: "asc", params: { unknown: 0 }, budget: { evals: 10 }, seed: 1 }),
    ).rejects.toThrow();
  });

  it("returns exactly P strict pieces for random shapes and never worsens a valid start", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 100000 }),
        async (N, M, P, seed) => {
          const start = grid(N, M, P);
          const snapshot = structuredClone(start);
          const result = await run({ N, M, P }, { method: "asc", start, budget: { evals: 100 }, seed });
          expect(result.valid).toBe(true);
          expect(result.best!.pieces).toHaveLength(P);
          expect(result.score!).toBeLessThanOrEqual(evaluate(start, { autoOrient: true }).score!);
          expect(evaluate(result.best!, { autoOrient: true }).valid).toBe(true);
          expect(findOverlaps(N, result.best!.pieces, 1e-12)).toEqual([]);
          expect(result.evaluations).toBeLessThanOrEqual(100);
          expect(start).toEqual(snapshot);
        },
      ),
      { numRuns: 24, seed: 7714 },
    );
  }, 15000);

  it("checks every assessed explicit state and unique configuration through shared geometry", async () => {
    for (const [N, M] of [
      [0, 0],
      [3, 8],
      [4, 4],
      [5, 3],
      [6, 0],
      [8, 5],
    ]) {
      let evaluations = 0;
      const count = await instrument(grid(N, M, 30), { temperature: 0.1, stagnationSweeps: 10000 }, 60, (event) => {
        if (event.kind !== "evaluation") return;
        evaluations++;
        assertState(event.config, event.container);
      });
      expect(count).toBe(60);
      expect(evaluations).toBe(count);
    }
  }, 15000);

  it("accepts each collective strain exactly when shared geometry accepts it, otherwise preserves state", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.constantFrom("balanced", "uniaxial", "sector", "radial"),
        fc.double({ min: 1e-7, max: 0.3, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (N, M, kind, amplitude, angle) => {
          const config = grid(N, M, 12);
          const container = strictEnclose(config);
          const state = new AscState(config, container);
          const snapshot = structuredClone(state.config);
          const trial = collectiveTrial(
            config,
            container,
            kind as "balanced" | "uniaxial" | "sector" | "radial",
            amplitude,
            angle,
            Math.PI / 3,
          );
          expect(trial.pieces.map((p) => p.theta)).toEqual(config.pieces.map((p) => p.theta));
          const accepted = state.replace(trial, container, 0, () => 0.5);
          expect(accepted).toBe(feasible(trial, container));
          if (accepted) assertState(state.config, state.container);
          else expect(state.config).toEqual(snapshot);
        },
      ),
      { numRuns: 80, seed: 3711 },
    );
  });

  it("uses reciprocal transverse strain and half-plane or sector masks", () => {
    const config = {
      N: 0,
      M: 0,
      P: 3,
      container_phi: 0,
      pieces: [
        { x: 4, y: 0, theta: 0 },
        { x: 0, y: 4, theta: 0 },
        { x: -4, y: 0, theta: 0 },
      ],
    };
    const container = { M: 0, cx: 0, cy: 0, phi: 0, size: 6 };
    const balanced = collectiveTrial(config, container, "balanced", 0.2, 0);
    expect(balanced.pieces[0].x).toBe(3.2);
    expect(balanced.pieces[1].y).toBe(5);
    const uniaxial = collectiveTrial(config, container, "uniaxial", 0.2, 0);
    expect(uniaxial.pieces[1].y).toBe(4);
    const sector = collectiveTrial(config, container, "sector", 0.2, 0, Math.PI / 3);
    expect(sector.pieces[0].x).toBe(3.2);
    expect(sector.pieces.slice(1)).toEqual(config.pieces.slice(1));
  });

  it("rejects sub-tolerance penetrations and checks full vertices even at huge finite angles", () => {
    const pair = {
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: -0.5, y: 0, theta: 0 },
        { x: 0.5, y: 0, theta: 0 },
      ],
    };
    const state = new AscState(pair, { M: 0, cx: 0, cy: 0, phi: 0, size: 3 });
    expect(state.move(0, { x: -0.5 + 1e-13, y: 0, theta: 0 })).toBe(false);
    expect(state.config.pieces).toEqual(pair.pieces);
    const single = { N: 0, M: 0, P: 1, container_phi: 0, pieces: [{ x: 0, y: 0, theta: 0 }] };
    const wall = new AscState(single, { M: 0, cx: 0, cy: 0, phi: 0, size: 1 });
    expect(wall.move(0, { x: 1e-13, y: 0, theta: 0 })).toBe(false);
    expect(wall.replace(single, { ...wall.container, size: 1 - 1e-13 }, 0, () => 0)).toBe(false);
    expect(wall.container.size).toBe(1);
    const triangle = { N: 3, M: 4, P: 1, container_phi: 0, pieces: [{ x: 0, y: 0, theta: 1e16 }] };
    const polygon = new AscState(triangle, { M: 4, cx: 0, cy: 0, phi: 0, size: 2 });
    expect(polygon.replace(triangle, { ...polygon.container, size: 0.44267891428189843 }, 0, () => 0)).toBe(false);
    expect(polygon.container.size).toBe(2);
  });

  it("recovers expanded seven- and two-circle packings with final polish and never scores below two", async () => {
    for (const P of [2, 7]) {
      const pieces =
        P === 2
          ? [
              { x: -1.3, y: 0, theta: 0 },
              { x: 1.3, y: 0, theta: 0 },
            ]
          : [
              { x: 0, y: 0, theta: 0 },
              ...Array.from({ length: 6 }, (_, k) => ({
                x: 2.6 * Math.cos((k * Math.PI) / 3),
                y: 2.6 * Math.sin((k * Math.PI) / 3),
                theta: 0,
              })),
            ];
      const start = { N: 0, M: 0, P, container_phi: 0, pieces };
      for (let seed = 1; seed <= 5; seed++) {
        const result = await run(start, { method: "asc", start, budget: { evals: 600 }, seed });
        expect(result.valid).toBe(true);
        expect(result.score!).toBeLessThanOrEqual(P === 2 ? 2 + 1e-8 : 3.0001);
        expect(result.score!).toBeGreaterThanOrEqual(P === 2 ? 2 : 3 - 1e-12);
        expect(findOverlaps(0, result.best!.pieces, 1e-12)).toEqual([]);
        expect(result.stages.at(-1)!.method).toBe("polish");
      }
    }
  });

  it("never accepts an increase in explicit size at zero temperature, including collective moves", async () => {
    for (const [N, M] of [
      [0, 0],
      [4, 4],
      [5, 5],
    ]) {
      let previous = Infinity;
      await instrument(grid(N, M, 12), {}, 70, (event) => {
        expect(event.container.size).toBeLessThanOrEqual(previous);
        previous = event.container.size;
      });
    }
    const config = grid(0, 0, 2);
    const state = new AscState(config, strictEnclose(config));
    const bigger = { ...state.container, size: state.container.size + 0.1 };
    expect(state.replace(config, bigger, 0, () => 0)).toBe(false);
    expect(state.replace(config, bigger, 1, () => 0)).toBe(true);
  });

  it("adapts every active amplitude independently with floors and stops on stagnation", async () => {
    let observed: AscObservation | undefined;
    await instrument(grid(4, 4, 12), { adaptationSweeps: 2 }, 80, (event) => {
      observed = event;
    });
    for (const kind of moveKinds) {
      const stats = observed!.statistics[kind];
      expect(stats.attempts).toBeGreaterThan(0);
      expect(stats.amplitude).toBeGreaterThanOrEqual(MIN_STEP);
    }
    expect(adaptStep(MIN_STEP, 0, 0.3, 1, 1)).toBe(MIN_STEP);
    const tight = { N: 0, M: 0, P: 1, container_phi: 0, pieces: [{ x: 0, y: 0, theta: 0 }] };
    const result = await run(tight, {
      method: "asc",
      start: tight,
      params: { stagnationSweeps: 20 },
      budget: { evals: 10000 },
      seed: 8,
      finalPolish: false,
    });
    expect(result.evaluations).toBe(1);
    expect(result.valid).toBe(true);
    expect(result.termination).toBe("completed");
  });

  it("is bit reproducible and respects an exact evaluation cap when the chain keeps moving", async () => {
    const start = grid(5, 4, 30);
    const options = { method: "asc", start, budget: { evals: 80 }, seed: 23, finalPolish: false };
    const a = await run(start, options);
    const b = await run(start, options);
    expect(a.best).toEqual(b.best);
    expect(a.score).toBe(b.score);
    expect(a.evaluations).toBe(80);
    expect(b.evaluations).toBe(80);
    expect(findOverlaps(start.N, a.best!.pieces, 0)).toEqual([]);
    expect(findOverlaps(start.N, b.best!.pieces, 0)).toEqual([]);
    for (const evals of [1, 2, 3, 7]) {
      const result = await run(start, { ...options, budget: { evals } });
      expect(result.valid).toBe(true);
      expect(result.evaluations).toBeLessThanOrEqual(evals);
    }
  });

  it("repairs overlapping or incomplete starts with small budgets and can seed all supported shapes", async () => {
    for (const [N, M] of [
      [0, 0],
      [3, 8],
      [4, 4],
      [5, 3],
      [6, 0],
      [8, 5],
    ]) {
      const problem = { N, M, P: 6 };
      for (const count of [5, 6]) {
        const start = {
          ...problem,
          container_phi: 0,
          pieces: Array.from({ length: count }, () => ({ x: 0, y: 0, theta: 0 })),
        };
        const result = await run(problem, { method: "asc", start, budget: { evals: 6 }, seed: 19 });
        expect(result.valid).toBe(true);
        expect(result.best!.pieces).toHaveLength(problem.P);
        expect(findOverlaps(N, result.best!.pieces, 1e-12)).toEqual([]);
      }
      const result = await run(problem, { method: "asc", budget: { evals: 40 }, seed: 19 });
      expect(result.valid).toBe(true);
    }
  });

  it("respects a time budget within 0.2 seconds and responds to timer abort within one second", async () => {
    const start = grid(8, 8, 30);
    const timed = await run(start, { method: "asc", start, budget: { time_s: 0.05 }, seed: 19 });
    expect(timed.valid).toBe(true);
    expect(timed.wallTime).toBeLessThan(0.25);
    const control = { aborted: false };
    let abortAt = 0;
    const timer = setTimeout(() => {
      abortAt = performance.now();
      control.aborted = true;
    }, 25);
    try {
      const result = await run(start, {
        method: "asc",
        start,
        params: { stagnationSweeps: 100000, sweepsPerEvaluation: 1000 },
        budget: { evals: 100000 },
        seed: 19,
        control,
      });
      expect(abortAt).toBeGreaterThan(0);
      expect(result.valid).toBe(true);
      expect(result.termination).toBe("aborted");
      expect(performance.now() - abortAt).toBeLessThan(1000);
    } finally {
      clearTimeout(timer);
    }
  });

  it("records framework limits when execution cannot start or repair has no evaluation available", async () => {
    const problem = { N: 0, M: 0, P: 2 };
    const absent = await run(problem, { method: "asc", budget: { evals: 1 }, seed: 1 });
    expect(absent.valid).toBe(false);
    expect(absent.evaluations).toBe(0);
    const invalid = {
      ...problem,
      container_phi: 0,
      pieces: [
        { x: 0, y: 0, theta: 0 },
        { x: 0, y: 0, theta: 0 },
      ],
    };
    const noRepair = await run(problem, { method: "asc", start: invalid, budget: { evals: 1 }, seed: 1 });
    expect(noRepair.valid).toBe(false);
    expect(noRepair.evaluations).toBe(1);
  });

  it("repairs roundoff-level seed contacts and then moves, instead of returning the seed untouched", async () => {
    const problem = { N: 5, M: 0, P: 50 };
    const budget = 60;
    const attempt = async () => {
      let seeded: SubRunResult | undefined;
      let first: { config: PackingConfig; container: Container } | undefined;
      let moves = 0;
      let accepted = 0;
      const own = new MethodRegistry();
      own.register(seedMethod);
      own.register({
        ...ascMethod,
        execute: (ctx) =>
          executeAsc(
            { ...ctx, run: async (method, params, options) => (seeded = await ctx.run(method, params, options)) },
            (event) => {
              // The observed state is live, so keep a copy of the first assessed one.
              if (event.kind === "evaluation")
                first ??= structuredClone({ config: event.config, container: event.container });
              if (event.kind !== "move") return;
              moves++;
              if (event.accepted) accepted++;
            },
          ),
      });
      const result = await own.run(problem, { method: "asc", budget: { evals: budget }, seed: 1, finalPolish: false });
      return { result, seeded: seeded!, first, moves, accepted };
    };
    const a = await attempt();
    // The generated lattice is valid for the evaluator, but its contacts are slightly negative.
    const found = a.seeded.found!;
    expect(findOverlaps(problem.N, found.pieces)).toEqual([]);
    expect(findOverlaps(problem.N, found.pieces, 0).length).toBeGreaterThan(0);
    expect(a.moves).toBeGreaterThan(problem.P);
    expect(a.accepted).toBeGreaterThan(0);
    // ASC's first assessment is that lattice with its centres dilated by about 1.5e-12.
    const first = a.first!;
    assertState(first.config, first.container);
    for (let i = 0; i < problem.P; i++) {
      const p = first.config.pieces[i];
      expect(Math.hypot(p.x - found.pieces[i].x, p.y - found.pieces[i].y)).toBeLessThan(1e-9);
      expect(p.theta).toBe(found.pieces[i].theta);
    }
    expect(a.result.evaluations).toBeGreaterThan(a.seeded.evaluations + 1);
    expect(a.result.evaluations).toBeLessThanOrEqual(budget);
    expect(a.result.valid).toBe(true);
    expect(a.result.strict).toBe(true);
    expect(a.result.score!).toBeLessThan(a.seeded.foundScore!);
    expect(findOverlaps(problem.N, a.result.best!.pieces, 0)).toEqual([]);
    // The repair draws no random numbers and its assessment is counted, so the run stays reproducible.
    const b = await attempt();
    expect(b.result.best).toEqual(a.result.best);
    expect(b.result.score).toBe(a.result.score);
    expect(b.result.evaluations).toBe(a.result.evaluations);
  }, 30000);

  it("repairs a tolerance-only start in place and measures improvement from the repaired state", async () => {
    // Two unit-diameter disks 5e-10 too close, side by side in a square: within the evaluator's 1e-9
    // allowance, so the start scores 2 - 5e-10, below every strict state near it.
    const start = {
      N: 0,
      M: 4,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: -0.5 + 2.5e-10, y: 0, theta: 0 },
        { x: 0.5 - 2.5e-10, y: 0, theta: 0 },
      ],
    };
    const nearStart = (config: PackingConfig) => {
      expect(findOverlaps(start.N, config.pieces, 0)).toEqual([]);
      for (let i = 0; i < start.P; i++)
        expect(Math.hypot(config.pieces[i].x - start.pieces[i].x, config.pieces[i].y - start.pieces[i].y)).toBeLessThan(
          1e-9,
        );
    };
    expect(evaluate(start, { autoOrient: false }).valid).toBe(true);
    expect(findOverlaps(start.N, start.pieces, 0)).toHaveLength(1);

    // With one assessment left after the start's own, the strict repair of this start is what
    // comes back, although the tolerance-only start scores lower. No seed or grid replaces it.
    const result = await run(start, { method: "asc", start, budget: { evals: 2 }, seed: 3, finalPolish: false });
    expect(result.evaluations).toBe(2);
    expect(result.strict).toBe(true);
    nearStart(result.best!);
    expect(result.score!).toBeGreaterThan(evaluate(start, { autoOrient: true }).score!);

    // instrument() rejects any seeding and any assessed state that is not strictly separated.
    const scores: number[] = [];
    let first: PackingConfig | undefined;
    let last: AscObservation | undefined;
    await instrument(start, { stagnationSweeps: 10000 }, 80, (event) => {
      if (event.kind === "evaluation") {
        scores.push(evaluate(event.config, { autoOrient: false }).score!);
        first ??= structuredClone(event.config);
      }
      last = event;
    });
    nearStart(first!);
    const tolerance = evaluate(start, { autoOrient: false }).score!;
    expect(scores[0]).toBeGreaterThan(tolerance);
    // Attributed gains telescope to (first assessed score - best assessed score). Seeding the
    // score to beat from the tolerance-only start would leave them 5e-10 short.
    const gains = moveKinds.reduce((sum, kind) => sum + last!.statistics[kind].scoreGain, 0);
    const improved = scores[0] - Math.min(...scores);
    expect(improved).toBeGreaterThan(1e-3);
    expect(Math.abs(gains - improved)).toBeLessThan(1e-11);
    expect(Math.abs(gains - (tolerance - Math.min(...scores)))).toBeGreaterThan(1e-10);
  });

  it("reaches a checkpoint every few piece trials and before each whole-configuration trial", async () => {
    const start = grid(5, 4, 60);
    const trace = async (pause: () => Promise<void>) => {
      const keys: string[] = [];
      let sinceCheckpoint = 0;
      let longest = 0;
      let unguarded = 0;
      let pieceTrials = 0;
      let wholeTrials = 0;
      await instrument(
        start,
        { radialWarmup: 0 },
        40,
        (event) => {
          if (event.kind === "evaluation") keys.push(configurationKey(event.config));
          if (event.kind !== "move") return;
          if (event.move === "translation" || event.move === "rotation") pieceTrials++;
          else {
            wholeTrials++;
            if (sinceCheckpoint > 0) unguarded++;
          }
          longest = Math.max(longest, ++sinceCheckpoint);
        },
        async () => {
          sinceCheckpoint = 0;
          await pause();
        },
      );
      return { keys, longest, unguarded, pieceTrials, wholeTrials };
    };
    const plain = await trace(async () => {});
    // At least one whole sweep ran: P = 60 piece trials, then the container and collective
    // trials. One checkpoint per sweep would leave a stretch of more than 60 trials.
    expect(plain.pieceTrials).toBeGreaterThanOrEqual(start.P);
    expect(plain.wholeTrials).toBeGreaterThanOrEqual(7);
    expect(plain.longest).toBeLessThanOrEqual(CHECKPOINT_MOVES);
    expect(plain.unguarded).toBe(0);
    // Checkpoints take no part in the search: yielding at each one assesses the same states.
    const yielding = await trace(() => new Promise<void>((resolve) => setImmediate(resolve)));
    expect(yielding.keys).toEqual(plain.keys);
    expect(yielding.pieceTrials).toBe(plain.pieceTrials);
  });

  it("falls back to the seed path when a start has no strict enclosure where it lies", async () => {
    // Near 1e4 one unit in the last place is 1.8e-12, more than the margin of a strict enclosure.
    const pair = (gap: number) => ({
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: 1e4, y: -1e4, theta: 0 },
        { x: 1e4 + 1 + gap, y: -1e4, theta: 0 },
      ],
    });
    const options = { method: "asc", budget: { evals: 30 }, seed: 1, finalPolish: false };
    // 5e-10 too close: parting the pair does not help, because the parted state cannot be
    // enclosed there either. The run must not end on that tolerance-only start.
    const close = pair(-5e-10);
    expect(evaluate(close, { autoOrient: true }).valid).toBe(true);
    expect(findOverlaps(0, close.pieces, 1e-12)).toHaveLength(1);
    const parted = await run(close, { ...options, start: close });
    expect(parted.strict).toBe(true);
    expect(parted.evaluations).toBeGreaterThan(1);
    expect(parted.score!).toBeGreaterThanOrEqual(2);
    expect(parted.score!).toBeLessThan(2 + 1e-9);
    // A strictly separated loose pair at the same place gets the same fallback, not a silent return.
    const loose = pair(0.6);
    const walls = strictEnclose(loose);
    expect(findOverlaps(0, loose.pieces, 0)).toEqual([]);
    expect(feasible(loose, walls) && loose.pieces.every((p) => fullyContained(0, p, walls))).toBe(false);
    const moved = await run(loose, { ...options, start: loose });
    expect(moved.strict).toBe(true);
    expect(moved.evaluations).toBeGreaterThan(1);
    expect(moved.score!).toBeLessThan(evaluate(loose, { autoOrient: true }).score! - 0.1);
  });

  it("parts a tolerance-only lattice in a short stretch, so an early stop still leaves a strict result", async () => {
    // 100 unit squares in a contact lattice, every neighbour 5e-10 too close. The shared repair
    // alone polls the stop flag about 138,000 times here before it has a strict state.
    const pitch = 1 - 5e-10;
    const start = {
      N: 4,
      M: 4,
      P: 100,
      container_phi: 0,
      pieces: Array.from({ length: 100 }, (_, i) => ({
        x: pitch * (i % 10),
        y: pitch * Math.floor(i / 10),
        theta: Math.PI / 4,
      })),
    };
    const given = evaluate(start, { autoOrient: true });
    expect(given.valid).toBe(true);
    expect(findOverlaps(4, start.pieces, 1e-12).length).toBeGreaterThan(100);
    // A fake clock: the run is aborted at the 20,000th look at the stop flag, wherever that falls.
    let looks = 0;
    const control = {
      get aborted() {
        return ++looks > 20000;
      },
    };
    const result = await run(start, {
      method: "asc",
      start,
      budget: { evals: 100000 },
      seed: 1,
      control,
      finalPolish: false,
    });
    expect(result.termination).toBe("aborted");
    expect(result.strict).toBe(true);
    expect(result.evaluations).toBeGreaterThanOrEqual(2);
    expect(findOverlaps(4, result.best!.pieces, 0)).toEqual([]);
    // The strict result is the supplied lattice parted in place, not a replacement grid.
    expect(result.score!).toBeGreaterThan(given.score!);
    expect(result.score!).toBeLessThan(given.score! + 1e-6);
  });
});
