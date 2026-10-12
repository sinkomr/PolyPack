import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  boundingRadius,
  containerProtrusions,
  enclose,
  evaluate,
  findOverlaps,
  MAX_COORD,
  pieceSeparation,
  type Container,
  type PackingConfig,
} from "@polypack/geometry";
import { registry, run, seededRandom, type MethodContext } from "../src/index";
import { executeCompression, mcCompressMethod, type CompressionObservation } from "../src/methods/mc_compress";
import { acceptSize, adaptStep, CompressionState, MIN_STEP } from "../src/methods/mc_compress/state";

function gridStart(N: number, M: number, P: number): PackingConfig {
  const width = Math.ceil(Math.sqrt(P));
  const step = 2.5 * boundingRadius(N);
  return {
    N,
    M,
    P,
    container_phi: 0.17,
    pieces: Array.from({ length: P }, (_, i) => ({
      x: step * (i % width),
      y: step * Math.floor(i / width),
      theta: 0.23,
    })),
  };
}

function looseKnown(N: number, P: number): PackingConfig {
  const d = (1 + Math.SQRT1_2) / 2;
  const pieces =
    N === 4
      ? [
          { x: 0, y: 0, theta: 0 },
          ...[
            [-d, -d],
            [d, -d],
            [-d, d],
            [d, d],
          ].map(([x, y]) => ({ x, y, theta: Math.PI / 4 })),
        ]
      : P === 2
        ? [
            { x: -1, y: 0, theta: 0 },
            { x: 1, y: 0, theta: 0 },
          ]
        : [
            { x: 0, y: 0, theta: 0 },
            ...Array.from({ length: 6 }, (_, k) => ({
              x: 2 * Math.cos((k * Math.PI) / 3),
              y: 2 * Math.sin((k * Math.PI) / 3),
              theta: 0,
            })),
          ];
  return { N, M: N, P, container_phi: 0, pieces: pieces.map((p) => ({ ...p, x: 1.3 * p.x, y: 1.3 * p.y })) };
}

function assertState(config: PackingConfig, container: Container): void {
  expect(config.pieces).toHaveLength(config.P);
  for (let i = 0; i < config.P; i++) {
    expect(containerProtrusions(config.N, config.pieces[i], container).every((c) => c.depth <= 1e-12)).toBe(true);
    for (let j = 0; j < i; j++)
      expect(pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep).toBeGreaterThanOrEqual(0);
  }
}

async function instrument(
  start: PackingConfig,
  params: Record<string, unknown>,
  evaluations: number,
  observer: (e: CompressionObservation) => void,
): Promise<number> {
  let count = 0;
  const ctx: MethodContext = {
    problem: { N: start.N, M: start.M, P: start.P },
    start,
    starts: [],
    initialEvaluation: evaluate(start, { autoOrient: false }),
    params: { ...mcCompressMethod.defaults, ...params },
    random: seededRandom(73),
    shouldStop: () => count >= evaluations,
    checkpoint: async () => count < evaluations,
    remaining: () => ({ evals: evaluations - count, time_s: Infinity }),
    evaluate: async (config, options) => {
      expect(options).toEqual({ autoOrient: false });
      count++;
      const result = evaluate(config, options);
      expect(result.valid).toBe(true);
      return result;
    },
    emit: async () => {
      throw new Error("Unexpected emit");
    },
    run: async () => {
      throw new Error("Unexpected seed for valid start");
    },
  };
  await executeCompression(ctx, observer);
  return count;
}

describe("mc_compress", () => {
  it("registers complete tooltip schemas and rejects unknown parameters", async () => {
    const method = registry.list().find((m) => m.name === "mc_compress")!;
    expect(method.defaults.initialTemperature).toBe(0);
    for (const property of Object.values(method.schema.properties!)) {
      expect(property.title).toBeTruthy();
      expect(property.description).toBeTruthy();
      expect(property.default).toBeDefined();
    }
    await expect(
      run({ N: 0, M: 0, P: 1 }, { method: "mc_compress", params: { unknown: true }, budget: { evals: 10 }, seed: 1 }),
    ).rejects.toThrow();
  });

  it("returns exactly P valid pieces across random shapes and never worsens a valid start", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 100000 }),
        async (N, M, P, seed) => {
          const start = gridStart(N, M, P);
          const snapshot = structuredClone(start);
          const result = await run({ N, M, P }, { method: "mc_compress", start, budget: { evals: 90 }, seed });
          expect(result.valid).toBe(true);
          expect(result.best!.pieces).toHaveLength(P);
          expect(evaluate(result.best!, { autoOrient: true }).valid).toBe(true);
          expect(result.score!).toBeLessThanOrEqual(evaluate(start, { autoOrient: true }).score!);
          expect(start).toEqual(snapshot);
          expect(result.evaluations).toBeLessThanOrEqual(90);
        },
      ),
      { numRuns: 24, seed: 4263 },
    );
  }, 15000);

  it("checks the explicit container and every pair through shared geometry at every evaluation", async () => {
    for (const [N, M] of [
      [0, 0],
      [3, 8],
      [4, 4],
      [5, 3],
      [6, 0],
      [8, 5],
    ]) {
      let attempts = 0;
      let accepted = 0;
      let evaluations = 0;
      await instrument(
        gridStart(N, M, 30),
        { initialTemperature: 0.03, coolingRate: 0.9999, sweepsPerEvaluation: 20 },
        100,
        (event) => {
          if (event.kind !== "evaluation") return;
          evaluations++;
          assertState(event.config, event.container);
          attempts = event.attempts;
          accepted = event.accepted;
        },
      );
      expect(evaluations).toBe(100);
      expect(attempts).toBeGreaterThan(1000);
      expect(accepted).toBeGreaterThan(100);
    }
  }, 15000);

  it("queries new cells for long moves and updates cells after accepted moves and contractions", () => {
    for (const N of [0, 4, 8]) {
      const start = gridStart(N, 0, 30);
      const state = new CompressionState(start, { M: 0, cx: 0, cy: 0, phi: 0, size: 100 });
      const random = seededRandom(118);
      for (let move = 0; move < 2000; move++) {
        const i = Math.floor(random() * start.P);
        const trial = { x: 30 * (random() - 0.5), y: 30 * (random() - 0.5), theta: 2 * Math.PI * random() };
        const expected = state.config.pieces.every((p, j) => i === j || pieceSeparation(N, trial, p).sep >= 0);
        expect(state.move(i, trial)).toBe(expected);
        if (move % 50 === 0) {
          const expanded = state.contracted(1.03);
          expect(state.replace(expanded, state.container, 1, () => 0)).toBe(true);
          expect(findOverlaps(N, state.config.pieces, 0)).toEqual([]);
        }
      }
      assertState(state.config, state.container);
    }
  });

  it("recovers loose known packings with final polish at 600 evaluations, including five square seeds", async () => {
    for (const [N, P, target] of [
      [0, 7, 3.0001],
      [0, 2, 2 + 1e-11],
      [4, 5, 2.72],
    ]) {
      let successes = 0;
      for (let seed = 1; seed <= 5; seed++) {
        const start = looseKnown(N, P);
        const result = await run({ N, M: N, P }, { method: "mc_compress", start, budget: { evals: 600 }, seed });
        expect(result.valid).toBe(true);
        expect(findOverlaps(N, result.best!.pieces, 1e-12)).toEqual([]);
        if (N === 0 && P === 2) {
          expect(result.score!).toBeGreaterThanOrEqual(2 - 1e-12);
          expect(Math.abs(result.score! - 2)).toBeLessThanOrEqual(1e-11);
        }
        expect(result.stages.at(-1)!.method).toBe("polish");
        if (result.score! <= target) successes++;
      }
      expect(successes).toBeGreaterThanOrEqual(N === 4 ? 3 : 5);
    }
  }, 15000);

  it("measures adaptation toward target on a fixed container and verifies independent rate updates", () => {
    const config = gridStart(0, 0, 30);
    const state = new CompressionState(config, enclose(config.N, config.pieces, config.M, 0));
    const random = seededRandom(33);
    const rates: number[] = [];
    let step = 0.0001;
    for (let window = 0; window < 55; window++) {
      let accepted = 0;
      for (let i = 0; i < 900; i++) {
        const index = Math.floor(random() * config.P);
        const pose = state.config.pieces[index];
        if (
          state.move(index, { ...pose, x: pose.x + (2 * random() - 1) * step, y: pose.y + (2 * random() - 1) * step })
        )
          accepted++;
      }
      const rate = accepted / 900;
      rates.push(rate);
      step = adaptStep(step, rate, 0.3, 1, 20);
    }
    const tail = rates.slice(-10).reduce((a, b) => a + b, 0) / 10;
    expect(Math.abs(tail - 0.3)).toBeLessThan(0.08);
    expect(Math.abs(tail - 0.3)).toBeLessThan(Math.abs(rates[0] - 0.3));
    expect(adaptStep(0.1, 0.8, 0.3, 0, 1)).toBe(0.1);
    expect(adaptStep(50, 0.3, 0.3, 0, 2)).toBe(50);
    expect(adaptStep(0.1, 0.1, 0.3, 1, 1)).toBeLessThan(0.1);
    expect(adaptStep(0.1, 0.8, 0.3, 1, 1)).toBeGreaterThan(0.1);
    expect(adaptStep(MIN_STEP, 0, 0.3, 10, 1)).toBe(MIN_STEP);
  });

  it("retains initial free room for the configured warmup before any container moves", async () => {
    let size: number | undefined;
    let phi: number | undefined;
    let observations = 0;
    await instrument(
      gridStart(4, 5, 10),
      {
        warmupSweeps: 30,
        sweepsPerEvaluation: 1,
        shrinkEvery: 1,
        orientEvery: 1,
      },
      40,
      (event) => {
        if (event.sweep > 30) return;
        if (event.kind === "container") expect(event.sweep).toBe(0);
        if (event.kind !== "evaluation") return;
        size ??= event.container.size;
        phi ??= event.container.phi;
        expect(event.container.size).toBe(size);
        expect(event.container.phi).toBe(phi);
        observations++;
      },
    );
    expect(observations).toBeGreaterThanOrEqual(30);
  });

  it("terminates a jammed chain early and optionally restarts with strict feasibility", async () => {
    const start = looseKnown(0, 2);
    const stopped = await instrument(
      start,
      {
        stagnationEvals: 5,
        initialExpansion: 0,
        warmupSweeps: 0,
        sweepsPerEvaluation: 1,
      },
      100,
      () => {},
    );
    expect(stopped).toBeLessThan(15);
    let restarts = 0;
    await instrument(
      start,
      {
        stagnationEvals: 5,
        maxRestarts: 2,
        restartExpansion: 1.15,
        initialExpansion: 0,
        warmupSweeps: 5,
        sweepsPerEvaluation: 1,
      },
      100,
      (event) => {
        if (event.kind !== "restart") return;
        restarts++;
        assertState(event.config, event.container);
        expect(event.restarts).toBe(restarts);
      },
    );
    expect(restarts).toBe(2);
    const options = {
      method: "mc_compress",
      start,
      params: { stagnationEvals: 5, maxRestarts: 2, restartExpansion: 1.15 },
      budget: { evals: 150 },
      finalPolish: false,
      seed: 71,
    };
    const a = await run(start, options);
    const b = await run(start, options);
    expect(a.best).toEqual(b.best);
    expect(a.evaluations).toBe(b.evaluations);
    expect(a.score!).toBeGreaterThanOrEqual(2 - 1e-12);
  });

  it("never accepts an increasing size at temperature zero and uses the specified energy rule", async () => {
    let previous = Infinity;
    let changes = 0;
    await instrument(gridStart(4, 5, 20), { initialTemperature: 0 }, 100, (event) => {
      if (event.kind === "container") {
        expect(event.container.size).toBeLessThanOrEqual(previous);
        previous = event.container.size;
        changes++;
      }
    });
    expect(changes).toBeGreaterThan(5);
    expect(acceptSize(2, 2.1, 0, () => 0)).toBe(false);
    expect(acceptSize(2, 2.1, 0.1, () => 0.3)).toBe(true);
    expect(acceptSize(2, 2.1, 0.1, () => 0.4)).toBe(false);
  });

  it("is deterministic with eval budgets, uses every eval without polish, and clips seeding", async () => {
    for (const supplied of [false, true]) {
      for (const evals of [1, 2, 7, 31, 150]) {
        const problem = { N: 5, M: 4, P: 12 };
        const options = {
          method: "mc_compress",
          start: supplied ? gridStart(5, 4, 12) : undefined,
          params: { initialTemperature: 0.02 },
          budget: { evals },
          seed: 73,
          finalPolish: false,
        };
        const a = await run(problem, options);
        const b = await run(problem, options);
        expect(a.valid).toBe(true);
        expect(a.best).toEqual(b.best);
        expect(a.score).toBe(b.score);
        expect(a.evaluations).toBe(evals);
        expect(b.evaluations).toBe(evals);
      }
    }
  });

  it("respects a time budget within 0.2 seconds", async () => {
    const start = gridStart(8, 8, 30);
    const result = await run(start, { method: "mc_compress", start, budget: { time_s: 0.1 }, seed: 92 });
    expect(result.valid).toBe(true);
    expect(result.termination).toBe("time");
    expect(result.wallTime).toBeLessThanOrEqual(0.3);
  });

  it("handles asymmetric valid starts spanning the coordinate limits", async () => {
    const problem = { N: 0, M: 0, P: 3 };
    const start = {
      ...problem,
      container_phi: 0,
      pieces: [MAX_COORD - 2, MAX_COORD, -MAX_COORD].map((x) => ({ x, y: 0, theta: 0 })),
    };
    const result = await run(problem, {
      method: "mc_compress",
      start,
      seed: 1,
      budget: { evals: 8 },
      finalPolish: false,
    });
    expect(result.termination).not.toBe("error");
    expect(result.valid).toBe(true);
    expect(result.evaluations).toBe(8);
  });

  it("cooperatively pauses and resumes without charging the paused interval", async () => {
    const start = gridStart(4, 4, 10);
    const control = { aborted: false, paused: true };
    const timer = setTimeout(() => {
      control.paused = false;
    }, 35);
    try {
      const result = await run(start, { method: "mc_compress", start, control, budget: { time_s: 0.03 }, seed: 1 });
      expect(result.valid).toBe(true);
      expect(result.wallTime).toBeGreaterThanOrEqual(0.035);
      expect(result.evaluations).toBeGreaterThan(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it("yields to timer aborts even with 1000 sweeps per evaluation and returns a valid best within 1 second", async () => {
    const start = gridStart(8, 8, 30);
    const control = { aborted: false };
    let abortAt = 0;
    const timer = setTimeout(() => {
      abortAt = performance.now();
      control.aborted = true;
    }, 40);
    try {
      const result = await run(start, {
        method: "mc_compress",
        start,
        params: { sweepsPerEvaluation: 1000 },
        budget: { evals: 100000 },
        seed: 92,
        control,
      });
      expect(abortAt).toBeGreaterThan(0);
      expect(performance.now() - abortAt).toBeLessThan(1000);
      expect(result.termination).toBe("aborted");
      expect(result.valid).toBe(true);
      expect(evaluate(result.best!).valid).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });
});
