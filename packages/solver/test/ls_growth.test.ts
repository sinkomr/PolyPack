import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areaLowerBound,
  containerProtrusions,
  evaluate,
  findOverlaps,
  pieceSeparation,
  type Container,
  type PackingConfig,
} from "@polypack/geometry";
import { run, registry, MethodRegistry, seededRandom, type MethodContext } from "../src/index";
import { seedMethod } from "../src/methods/seed";
import { penaltyMethod } from "../src/methods/penalty";
import { executeGrowth, lsGrowthMethod, randomLoose, type GrowthObservation } from "../src/methods/ls_growth";
import { GrowthDynamics } from "../src/methods/ls_growth/dynamics";
import {
  collideDiscs,
  discCircleWallTime,
  discDiscTime,
  discEdgeTime,
  EventQueue,
  horizonPairs,
} from "../src/methods/ls_growth/events";
import { strictEnclose } from "../src/methods/mc_compress/state";
import { scatter } from "../src/methods/penalty/restoration";

function strict(config: PackingConfig, container?: Container, tolerance = 0): void {
  expect(config.pieces).toHaveLength(config.P);
  expect(findOverlaps(config.N, config.pieces, tolerance)).toEqual([]);
  for (let i = 0; i < config.P; i++) {
    for (let j = 0; j < i; j++)
      expect(pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep).toBeGreaterThanOrEqual(-tolerance);
    if (container)
      expect(containerProtrusions(config.N, config.pieces[i], container).every((p) => p.depth <= 1e-12)).toBe(true);
  }
}

/** Independent fixed-step search brackets the first sign change, without using a quadratic. */
function brute(gap: (t: number) => number, end: number, steps = 10000): number {
  for (let step = 1; step <= steps; step++) {
    const time = (end * step) / steps;
    if (gap(time) <= 0) return time;
  }
  return Infinity;
}

describe("growing disc event mathematics", () => {
  it("matches brute stepping for disc-disc contacts including growing and linear-degenerate cases", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.double({ min: 0.2, max: 3, noNaN: true }),
        fc.double({ min: -0.2, max: 0.2, noNaN: true }),
        (radius, growth, speed, tangent) => {
          const a = { x: -3 * radius, y: 0, theta: 0 };
          const b = { x: 3 * radius, y: 0, theta: 0 };
          const va = { x: speed, y: tangent, omega: 0 };
          const vb = { x: -speed, y: -tangent, omega: 0 };
          const time = discDiscTime(a, b, va, vb, radius, growth);
          if (!Number.isFinite(time)) return;
          const gap = (t: number) =>
            Math.hypot(a.x - b.x + (va.x - vb.x) * t, (va.y - vb.y) * t) - 2 * (radius + growth * t);
          expect(Math.abs(gap(time))).toBeLessThan(1e-11);
          const end = time * 1.01;
          const stepped = brute(gap, end);
          expect(stepped).toBeGreaterThanOrEqual(time - 1e-12);
          expect(stepped - time).toBeLessThanOrEqual(end / 10000 + 1e-12);
        },
      ),
      { numRuns: 80, seed: 817 },
    );
    const p = { x: 0, y: 0, theta: 0 };
    const q = { x: 4, y: 0, theta: 0 };
    expect(discDiscTime(p, q, { x: 1, y: 0, omega: 0 }, { x: 0, y: 0, omega: 0 }, 1, 0.5)).toBe(1);
    expect(discDiscTime(p, q, { x: 0, y: 0, omega: 0 }, { x: 0, y: 0, omega: 0 }, 1, 0.5)).toBe(2);
    expect(discDiscTime(p, q, { x: -1, y: 0, omega: 0 }, { x: 1, y: 0, omega: 0 }, 1, 0)).toBe(Infinity);
  });

  it("matches brute stepping for polygon edges and circular walls with growing radii", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.double({ min: 0.1, max: 3, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (growth, speed, angle) => {
          const nx = Math.cos(angle);
          const ny = Math.sin(angle);
          const p = { x: 0.3 * nx, y: 0.3 * ny, theta: 0 };
          const v = { x: speed * nx, y: speed * ny, omega: 0 };
          const edge = discEdgeTime(p, v, 0.8, growth, nx, ny, 3);
          const wall = discCircleWallTime(p, v, 0.8, growth, 3);
          for (const [time, gap] of [
            [edge, (t: number) => 3 - (p.x + v.x * t) * nx - (p.y + v.y * t) * ny - 0.8 - growth * t],
            [wall, (t: number) => 3 - Math.hypot(p.x + v.x * t, p.y + v.y * t) - 0.8 - growth * t],
          ] as const) {
            expect(Math.abs(gap(time))).toBeLessThan(1e-11);
            const end = time * 1.01;
            expect(Math.abs(brute(gap, end) - time)).toBeLessThanOrEqual(end / 10000 + 1e-12);
          }
        },
      ),
      { numRuns: 80, seed: 618 },
    );
    const p = { x: 0, y: 0, theta: 0 };
    expect(discCircleWallTime(p, { x: 0, y: 0, omega: 0 }, 1, 0.5, 3)).toBe(4);
    expect(discCircleWallTime(p, { x: 0, y: 0, omega: 0 }, 1, 0, 3)).toBe(Infinity);
    // Moving inward first must choose the later exiting root at the opposite wall.
    expect(discCircleWallTime({ ...p, x: 2 }, { x: -1, y: 0, omega: 0 }, 1, 0, 3)).toBe(4);
  });

  it("conserves disc momentum and translational energy at zero growth, and separates growing surfaces", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (x, y, angle) => {
          const a = { x, y, omega: 0 };
          const b = { x: -2, y: 1, omega: 0 };
          const before = { x: a.x + b.x, y: a.y + b.y, energy: a.x ** 2 + a.y ** 2 + b.x ** 2 + b.y ** 2 };
          collideDiscs(a, b, Math.cos(angle), Math.sin(angle), 0);
          expect(a.x + b.x).toBeCloseTo(before.x, 12);
          expect(a.y + b.y).toBeCloseTo(before.y, 12);
          expect(a.x ** 2 + a.y ** 2 + b.x ** 2 + b.y ** 2).toBeCloseTo(before.energy, 11);
        },
      ),
      { numRuns: 80, seed: 915 },
    );
    const a = { x: -1, y: 0, omega: 0 };
    const b = { x: 1, y: 0, omega: 0 };
    collideDiscs(a, b, 1, 0, 0.1);
    expect(a.x - b.x - 0.2).toBeGreaterThan(0);
  });

  it("orders heap events and includes fast cell-crossing neighbours", () => {
    const queue = new EventQueue();
    for (const time of [9, 1, 3, 2, 7]) queue.push({ time, i: 0, j: 1, edge: -1 });
    expect(Array.from({ length: 5 }, () => queue.pop()!.time)).toEqual([1, 2, 3, 7, 9]);
    expect(queue.pop()).toBeUndefined();
    const pieces = [
      { x: 0, y: 0, theta: 0 },
      { x: 5, y: 0, theta: 0 },
    ];
    expect(horizonPairs(pieces, 6, () => false)).toEqual([[0, 1]]);
    expect(horizonPairs(pieces, 2, () => false)).toEqual([]);
  });

  it("repairs rounding by uniform shrink and rejects substantial overlaps", () => {
    const config: PackingConfig = {
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: -1, y: 0, theta: 0 },
        { x: 1, y: 0, theta: 0 },
      ],
    };
    const state = new GrowthDynamics(config, { M: 0, cx: 0, cy: 0, phi: 0, size: 3 }, 1, 0.01, 1, 0, seededRandom(1));
    state.scale = 1 + 1e-13;
    expect(state.repair(() => false)).toBe(true);
    expect(state.repairs).toBe(1);
    strict(state.config(), state.unitContainer());
    state.scale = 1.1;
    expect(state.repair(() => false)).toBe(false);
  });

  it("handles tangency to a curved wall as an immediate event with microscopic retreat", () => {
    // a disk of radius 1/2 (growing at 0.005) touches the wall of a container of diameter 5 at x = 2
    const p = { x: 2, y: 0, theta: 0 };
    const v = { x: -0.005, y: 1, omega: 0 };
    expect(discCircleWallTime(p, v, 0.5, 0.005, 2.5)).toBe(0);
    const config: PackingConfig = { N: 0, M: 0, P: 1, container_phi: 0, pieces: [p] };
    const state = new GrowthDynamics(config, { M: 0, cx: 0, cy: 0, phi: 0, size: 5 }, 1, 0.01, 1, 0, seededRandom(1));
    Object.assign(state.velocities[0], v);
    expect(state.discAdvance(() => false).repaired).toBe(true);
    for (let i = 0; i < 100; i++) {
      expect(state.discAdvance(() => false).failed).toBe(false);
      strict(state.config(), state.unitContainer());
    }
    expect(state.repairs).toBeGreaterThan(0);
  });

  it("applies a polygon impulse to the first backed-up contact rather than a later overlapping pair", () => {
    const config: PackingConfig = {
      N: 4,
      M: 4,
      P: 3,
      container_phi: 0,
      pieces: [
        { x: 4.499, y: 0, theta: Math.PI / 4 },
        { x: 0, y: 0, theta: Math.PI / 4 },
        { x: 1.003, y: 0, theta: Math.PI / 4 },
      ],
    };
    const state = new GrowthDynamics(config, { M: 4, cx: 0, cy: 0, phi: 0, size: 10 }, 1, 0.01, 1, 0, seededRandom(1));
    for (let i = 0; i < 3; i++) Object.assign(state.velocities[i], { x: i === 2 ? -1 : 1, y: 0, omega: 0 });
    const step = state.polygonAdvance(0.02, () => false);
    expect(step.failed).toBe(false);
    expect(step.dt).toBeCloseTo(0.001 / 1.005, 10);
    expect(state.velocities[0].x).toBeLessThan(0);
    expect(state.velocities[1].x).toBe(1);
    expect(state.velocities[2].x).toBe(-1);
    strict(state.config(), state.unitContainer());
  });
});

// Explicit opt-in measurements are excluded from the fast unit/property suite.
it.skipIf(process.env.LS_ORDER !== "1")(
  "twenty-seed bond-order measurements",
  async () => {
    for (const P of [19, 30]) {
      for (const growthRate of [0.001, 0.01, 0.1]) {
        const samples: { seed: number; score: number; order: number; neighbours: number }[] = [];
        for (let seed = 1; seed <= 20; seed++) {
          const problem = { N: 0, M: 0, P };
          const start = randomLoose(problem, seededRandom(seed), () => false);
          const result = await run(problem, {
            method: "ls_growth",
            start,
            params: { growthRate },
            budget: { evals: 3000 },
            seed,
          });
          expect(result.valid).toBe(true);
          let real = 0;
          let imaginary = 0;
          let bonds = 0;
          for (let i = 0; i < P; i++) {
            for (let j = 0; j < i; j++) {
              const a = result.best!.pieces[i];
              const b = result.best!.pieces[j];
              if (Math.hypot(a.x - b.x, a.y - b.y) > 2.4) continue;
              const angle = Math.atan2(a.y - b.y, a.x - b.x);
              real += Math.cos(6 * angle);
              imaginary += Math.sin(6 * angle);
              bonds++;
            }
          }
          samples.push({
            seed,
            score: result.score!,
            order: bonds ? Math.hypot(real, imaginary) / bonds : 0,
            neighbours: (2 * bonds) / P,
          });
        }
        console.log("LS_BOND_ORDER", JSON.stringify({ P, growthRate, samples }));
      }
    }
  },
  3600000,
);

it.skipIf(process.env.LS_PERF !== "1")(
  "dynamics throughput measurements",
  () => {
    for (const [N, M, P, limit] of [
      [0, 0, 30, 4000],
      [0, 0, 200, 2000],
      [4, 4, 30, 1000],
    ]) {
      const samples = [];
      for (let seed = 1; seed <= 5; seed++) {
        const random = seededRandom(seed);
        const start = randomLoose({ N, M, P }, random, () => false);
        const state = new GrowthDynamics(start, strictEnclose(start), 0.8, 0.01, 1, 0.3, random);
        const begun = performance.now();
        for (let i = 0; i < limit; i++) {
          const step = N === 0 ? state.discAdvance(() => false) : state.polygonAdvance(0.02, () => false);
          expect(step.failed).toBe(false);
          state.thermostat(4);
        }
        const seconds = (performance.now() - begun) / 1000;
        samples.push({
          seed,
          seconds,
          operations: state.operations,
          events: state.collisions,
          repairs: state.repairs,
          operationsPerSecond: state.operations / seconds,
          eventsPerSecond: state.collisions / seconds,
        });
      }
      console.log("LS_THROUGHPUT", JSON.stringify({ N, M, P, samples }));
    }
  },
  60000,
);

it.skipIf(process.env.LS_BENCH_SHARD === undefined)(
  "twenty-seed ls_growth and penalty measurements",
  async () => {
    const shard = Number(process.env.LS_BENCH_SHARD);
    // Raw rows go to LS_BENCH_OUT, or to a per-shard file in the OS temporary directory; a
    // measurement must not append to a tracked document.
    const output = process.env.LS_BENCH_OUT ?? join(tmpdir(), `polypack-ls-bench-shard-${shard}.csv`);
    console.log(`LS benchmark rows are appended to ${output}`);
    const cases = [
      [0, 0, 7],
      [0, 0, 12],
      [0, 0, 19],
      [0, 0, 30],
      [0, 4, 10],
      [0, 4, 20],
      [0, 3, 6],
      [4, 4, 5],
      [5, 5, 6],
      [6, 6, 7],
    ];
    const records = JSON.parse(readFileSync("data/records.json", "utf8")).records as {
      N: number;
      M: number;
      P: number;
      value: number;
    }[];
    const measured = new MethodRegistry();
    measured.register(seedMethod);
    measured.register(penaltyMethod);
    const metrics = { operations: 0, collisions: 0, repairs: 0, thermostats: 0 };
    measured.register({
      ...lsGrowthMethod,
      execute: (ctx) =>
        executeGrowth(ctx, (event) => {
          Object.assign(metrics, event);
        }),
    });
    for (let index = 0; index < cases.length; index++) {
      if (index % 4 !== shard) continue;
      const [N, M, P] = cases[index];
      const problem = { N, M, P };
      const published = records.find((r) => r.N === N && r.M === M && r.P === P)?.value;
      for (const evals of [3000, 30000]) {
        const variants: [string, number][] = [
          ["ls_growth", 0.01],
          ["penalty", 0.01],
        ];
        if (N === 0 && M === 0 && (P === 19 || P === 30)) variants.push(["ls_growth", 0.001], ["ls_growth", 0.1]);
        for (const [method, rate] of variants) {
          const rows: string[] = [];
          for (let seed = 1; seed <= 20; seed++) {
            const start = randomLoose(problem, seededRandom(seed), () => false);
            Object.assign(metrics, { operations: 0, collisions: 0, repairs: 0, thermostats: 0 });
            const result = await measured.run(problem, {
              method,
              start,
              params: method === "ls_growth" ? { growthRate: rate } : {},
              budget: { evals },
              seed,
            });
            expect(result.valid).toBe(true);
            expect(result.evaluations).toBeLessThanOrEqual(evals);
            let minimum = Infinity;
            for (let i = 0; i < P; i++)
              for (let j = 0; j < i; j++)
                minimum = Math.min(minimum, pieceSeparation(N, result.best!.pieces[i], result.best!.pieces[j]).sep);
            rows.push(
              [
                N,
                M,
                P,
                evals,
                method,
                rate,
                seed,
                published ?? "missing",
                result.score,
                result.wallTime,
                result.evaluations,
                minimum,
                metrics.operations,
                metrics.collisions,
                metrics.repairs,
                metrics.thermostats,
              ].join(","),
            );
          }
          appendFileSync(output, rows.join("\n") + "\n");
          console.log("LS benchmark", { N, M, P, evals, method, rate, seeds: 20, output });
        }
      }
    }
  },
  3600000,
);

describe("registered ls_growth", () => {
  it("has tooltip metadata on every schema node", () => {
    expect(registry.list().some((m) => m.name === "ls_growth")).toBe(true);
    const walk = (schema: typeof lsGrowthMethod.schema): void => {
      expect(schema.title).toBeTruthy();
      expect(schema.description).toBeTruthy();
      for (const child of Object.values(schema.properties ?? {})) walk(child);
      if (schema.items) walk(schema.items);
    };
    walk(lsGrowthMethod.schema);
  });

  it("evaluates only distinct strict states during long disc runs in circle, square and triangle", async () => {
    for (const M of [0, 4, 3]) {
      const problem = { N: 0, M, P: 30 };
      const start = randomLoose(problem, seededRandom(19), () => false);
      const keys = new Set([JSON.stringify([start.container_phi, start.pieces])]);
      let count = 0;
      let operations = 0;
      const ctx: MethodContext = {
        problem,
        start,
        starts: [],
        initialEvaluation: evaluate(start),
        params: { ...lsGrowthMethod.defaults, runs: 1 },
        random: seededRandom(91),
        shouldStop: () => count >= 300,
        remaining: () => ({ evals: 300 - count, time_s: Infinity }),
        checkpoint: async () => count < 300,
        evaluate: async (config, options) => {
          expect(options).toEqual({ autoOrient: false });
          const key = JSON.stringify([config.container_phi, config.pieces]);
          expect(keys.has(key)).toBe(false);
          keys.add(key);
          strict(config);
          count++;
          return evaluate(config, options);
        },
        emit: async () => {
          throw new Error("unexpected emit");
        },
        run: async () => {
          throw new Error("unexpected seed");
        },
      };
      await executeGrowth(ctx, (event: GrowthObservation) => {
        if (event.kind === "evaluation") strict(event.config, event.container);
        operations = event.operations;
      });
      expect(count).toBe(300);
      expect(operations).toBeGreaterThanOrEqual(4800);
    }
  }, 20000);

  it("returns exactly P valid pieces for all shape families and never worsens valid starts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 10000 }),
        async (N, M, P, seed) => {
          const problem = { N, M, P };
          const start = scatter(problem, seededRandom(seed));
          const result = await run(problem, { method: "ls_growth", start, budget: { evals: 80 }, seed });
          expect(result.valid).toBe(true);
          expect(result.score!).toBeLessThanOrEqual(evaluate(start).score!);
          expect(result.best!.pieces).toHaveLength(P);
          expect(findOverlaps(N, result.best!.pieces, 1e-12)).toEqual([]);
          strict(result.best!, result.container!, 1e-12);
        },
      ),
      { numRuns: 24, seed: 945 },
    );
  }, 20000);

  it("reaches the seven- and two-circle targets for at least four of five random seeds with final polish", async () => {
    for (const [P, target, tolerance] of [
      [7, 3, 1e-4],
      [2, 2, 1e-8],
    ]) {
      let successes = 0;
      for (let seed = 1; seed <= 5; seed++) {
        const result = await run(
          { N: 0, M: 0, P },
          { method: "ls_growth", params: { initialization: "random" }, budget: { evals: 3000 }, seed },
        );
        expect(result.valid).toBe(true);
        expect(result.score!).toBeGreaterThanOrEqual(target);
        strict(result.best!, result.container!);
        if (result.score! <= target + tolerance) successes++;
      }
      expect(successes).toBeGreaterThanOrEqual(4);
    }
  }, 15000);

  it("reproduces bits, counts the exact evaluation cap, and clips small budgets", async () => {
    const problem = { N: 0, M: 4, P: 12 };
    const options = {
      method: "ls_growth",
      budget: { evals: 64 },
      seed: 73,
      finalPolish: false,
      params: { growthRate: 1e-6, evaluationInterval: 1, runs: 1 },
    };
    const a = await run(problem, options);
    const b = await run(problem, options);
    expect(a.evaluations).toBe(64);
    expect(b.evaluations).toBe(64);
    expect(a.best).toEqual(b.best);
    expect(a.score).toBe(b.score);
    for (const evals of [1, 2, 3, 7]) {
      const start = scatter(problem, seededRandom(82));
      const result = await run(problem, { method: "ls_growth", start, budget: { evals }, seed: 82 });
      expect(result.valid).toBe(true);
      expect(result.evaluations).toBeLessThanOrEqual(evals);
    }
  });

  it("uses a seed slice of at least three when requested and repairs invalid tiny-budget starts", async () => {
    for (const initialization of ["random", "seed"]) {
      const result = await run(
        { N: 5, M: 3, P: 12 },
        { method: "ls_growth", params: { initialization }, budget: { evals: 20 }, seed: 7 },
      );
      expect(result.valid).toBe(true);
    }
    const problem = { N: 0, M: 3, P: 12 };
    const start = {
      ...problem,
      container_phi: 0,
      pieces: Array.from({ length: problem.P }, () => ({ x: 0, y: 0, theta: 0 })),
    };
    for (const evals of [2, 3, 8]) {
      const result = await run(problem, { method: "ls_growth", start, budget: { evals }, seed: 7, finalPolish: false });
      expect(result.valid).toBe(true);
      strict(result.best!, result.container!);
      expect(result.evaluations).toBeLessThanOrEqual(evals);
    }
  });

  it("stops a jam without burning the budget and returns a valid best", async () => {
    const result = await run(
      { N: 0, M: 0, P: 7 },
      {
        method: "ls_growth",
        params: { jamThreshold: 0.01, jamWindow: 2, runs: 1 },
        budget: { evals: 3000 },
        seed: 7,
        finalPolish: false,
      },
    );
    expect(result.valid).toBe(true);
    expect(result.evaluations).toBeLessThan(3000);
    strict(result.best!, result.container!);
  });

  it("includes event-free horizons when measuring growth between collisions", async () => {
    const problem = { N: 0, M: 0, P: 1 };
    const start: PackingConfig = {
      ...problem,
      container_phi: 0,
      pieces: [{ x: 0, y: 0, theta: 0 }],
    };
    let evaluations = 0;
    const observations: GrowthObservation[] = [];
    const ctx: MethodContext = {
      problem,
      start,
      starts: [],
      initialEvaluation: evaluate(start),
      params: {
        ...lsGrowthMethod.defaults,
        runs: 1,
        evaluationInterval: 1,
        jamThreshold: 0.001,
        jamWindow: 2,
      },
      random: () => 0,
      shouldStop: () => evaluations >= 8,
      remaining: () => ({ evals: 8 - evaluations, time_s: Infinity }),
      checkpoint: async () => evaluations < 8,
      evaluate: async (config, options) => {
        strict(config);
        evaluations++;
        return evaluate(config, options);
      },
      emit: async () => {
        throw new Error("unexpected emit");
      },
      run: async () => {
        throw new Error("unexpected seed");
      },
    };
    // The first two impacts occur on operations 2 and 5. Their final
    // horizon fractions are below 0.001, while their full flights exceed it.
    await executeGrowth(ctx, (event) => observations.push(event));
    expect(observations.some((event) => event.kind === "jam")).toBe(false);
    expect(evaluations).toBe(8);
    const assessments = observations.filter((event) => event.kind === "evaluation");
    expect(assessments[1].collisions).toBe(1);
    expect(assessments[4].collisions).toBe(2);
    expect(observations.at(-1)?.operations).toBe(8);
  });

  it("respects time within 0.2 seconds and a timer abort within one second", async () => {
    const problem = { N: 4, M: 4, P: 30 };
    const start = scatter(problem, seededRandom(7));
    const timed = await run(problem, { method: "ls_growth", start, budget: { time_s: 0.05 }, seed: 7 });
    expect(timed.valid).toBe(true);
    expect(timed.wallTime).toBeLessThan(0.25);
    const control = { aborted: false };
    let abortAt = 0;
    const timer = setTimeout(() => {
      abortAt = performance.now();
      control.aborted = true;
    }, 25);
    try {
      const result = await run(problem, {
        method: "ls_growth",
        start,
        params: { runs: 100 },
        budget: { evals: 100000 },
        seed: 7,
        control,
      });
      expect(abortAt).toBeGreaterThan(0);
      expect(performance.now() - abortAt).toBeLessThan(1000);
      expect(result.termination).toBe("aborted");
      expect(result.valid).toBe(true);
      strict(result.best!, result.container!);
    } finally {
      clearTimeout(timer);
    }
  });
});

/**
 * Hand-built context that behaves like the framework at its limits. Its clock advances one
 * millisecond per stop poll, so an expiry lands on an exact, repeatable poll, and nothing is
 * assessed once the clock or the evaluation cap has run out. It also records the stop polls between consecutive
 * framework calls, which are the only places where a pause or a Worker stop can take effect.
 */
function metered(
  problem: { N: number; M: number; P: number },
  limits: { evals?: number; ms?: number },
  params: Record<string, unknown> = {},
  seed = 5,
  start?: PackingConfig,
) {
  const evalLimit = limits.evals ?? Infinity;
  const timeLimit = limits.ms ?? Infinity;
  const log = { polls: 0, yields: 0, longest: 0, longestStart: 0, yieldsStart: 0, assessed: [] as PackingConfig[] };
  let since = 0;
  const stopped = (): boolean => log.polls >= timeLimit || log.assessed.length >= evalLimit;
  const yielded = (): void => {
    log.longest = Math.max(log.longest, since);
    if (!log.assessed.length) {
      log.longestStart = Math.max(log.longestStart, since);
      log.yieldsStart++;
    }
    log.yields++;
    since = 0;
  };
  const ctx: MethodContext = {
    problem,
    start,
    starts: [],
    // Like the framework, the supplied start is scored before the method runs, uncounted here.
    initialEvaluation: start ? evaluate(start) : undefined,
    params: { ...lsGrowthMethod.defaults, ...params },
    random: seededRandom(seed),
    shouldStop: () => {
      const stop = stopped();
      log.polls++;
      since++;
      return stop;
    },
    remaining: () => ({
      evals: Math.max(0, evalLimit - log.assessed.length),
      time_s: Math.max(0, timeLimit - log.polls) / 1000,
    }),
    checkpoint: async () => {
      yielded();
      return !stopped();
    },
    evaluate: async (config, options) => {
      yielded();
      if (stopped()) return undefined;
      expect(options).toEqual({ autoOrient: false });
      log.assessed.push(config);
      return evaluate(config, options);
    },
    emit: async () => {
      throw new Error("unexpected emit");
    },
    run: async () => {
      throw new Error("unexpected seed");
    },
  };
  return { ctx, log };
}

/** Zero-tolerance validity without the quadratic expectation count of strict(). */
function strictValid(config: PackingConfig | undefined, P: number): void {
  expect(config?.pieces).toHaveLength(P);
  expect(findOverlaps(config!.N, config!.pieces, 0)).toEqual([]);
  expect(evaluate(config!).valid).toBe(true);
}

describe("ls_growth start insurance", () => {
  it("assesses a strict grid before a time budget expires inside large-P start construction", async () => {
    const problem = { N: 4, M: 4, P: 300 };
    // 200 polls cannot finish 300 placements. With an evaluation cap the grid replaces the
    // start in the last 25 ms, or the second half of a shorter budget; the cap is respected.
    for (const ms of [200, 30]) {
      const both = metered(problem, { evals: 3, ms });
      await executeGrowth(both.ctx);
      expect(both.log.assessed.length).toBeGreaterThanOrEqual(1);
      expect(both.log.assessed.length).toBeLessThanOrEqual(3);
      for (const config of both.log.assessed) strictValid(config, problem.P);
    }
    // With unlimited evaluations the grid is assessed first, so even a budget that expires on
    // the second stop poll, or a stop requested there, leaves one valid configuration.
    for (const ms of [1, 2, 200]) {
      const timed = metered(problem, { ms });
      await executeGrowth(timed.ctx);
      expect(timed.log.assessed.length).toBeGreaterThanOrEqual(1);
      expect(timed.log.assessed.length).toBeLessThanOrEqual(ms === 200 ? 2 : 1);
      for (const config of timed.log.assessed) strictValid(config, problem.P);
    }
  });

  it("returns a strict configuration from the framework when stop arrives during start construction", async () => {
    const problem = { N: 4, M: 4, P: 500 };
    // The ninth read of the flag reports the stop: deterministic, and after the at most six
    // reads that precede the first assessment. Unfixed code is then still placing pieces.
    let reads = 0;
    const control = {
      get aborted() {
        return ++reads > 8;
      },
    };
    const result = await run(problem, { method: "ls_growth", budget: { time_s: 3600 }, seed: 5, control });
    expect(result.termination).toBe("aborted");
    expect(result.evaluations).toBe(1);
    expect(result.valid).toBe(true);
    expect(result.strict).toBe(true);
    strictValid(result.best, problem.P);
  });

  it("returns a strict configuration from the framework when a short time budget joins an evaluation cap", async () => {
    const problem = { N: 4, M: 4, P: 500 };
    // Every reading of the framework clock advances it by 0.1 ms, so the 100 ms budget expires
    // after a fixed amount of polling, well inside the roughly 1900 placement trials.
    let clock = 0;
    const spy = vi.spyOn(globalThis.performance, "now").mockImplementation(() => (clock += 0.1));
    try {
      const result = await run(problem, {
        method: "ls_growth",
        budget: { evals: 5, time_s: 0.1 },
        seed: 5,
        finalPolish: false,
      });
      expect(result.termination).toBe("time");
      expect(result.evaluations).toBeGreaterThanOrEqual(1);
      expect(result.evaluations).toBeLessThanOrEqual(5);
      expect(result.valid).toBe(true);
      expect(result.strict).toBe(true);
      strictValid(result.best, problem.P);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ls_growth tolerance-only starts under a time budget", () => {
  it("spends the time on repairing a start that is valid within tolerance, never on the grid", async () => {
    // Touching discs on a 6 by 6 lattice score 6; one pair overlaps by 5e-10, inside the
    // validity tolerance but not strict. The insurance grid would score about 7.
    const problem = { N: 0, M: 4, P: 36 };
    const start: PackingConfig = {
      ...problem,
      container_phi: 0,
      pieces: Array.from({ length: problem.P }, (_, i) => ({
        x: (i % 6) - 2.5 - (i === 1 ? 5e-10 : 0),
        y: Math.floor(i / 6) - 2.5,
        theta: 0,
      })),
    };
    const scored = evaluate(start);
    expect(scored.valid).toBe(true);
    expect(findOverlaps(problem.N, start.pieces, 0)).toHaveLength(1);
    const grid = scatter(problem, () => 0.5);
    expect(evaluate(grid).score!).toBeGreaterThan(scored.score! + 0.5);
    // Ample time, with and without an evaluation cap: the first assessment is the repaired
    // start, strict and as good as the supplied one, and the grid is never assessed.
    for (const limits of [{ ms: 1e9 }, { evals: 6, ms: 1e9 }]) {
      const { ctx, log } = metered(problem, limits, { runs: 1, stagnationEvaluations: 2 }, 5, start);
      await executeGrowth(ctx);
      expect(log.assessed.length).toBeGreaterThanOrEqual(1);
      strictValid(log.assessed[0], problem.P);
      expect(evaluate(log.assessed[0]).score!).toBeLessThan(scored.score! + 1e-6);
      expect(log.assessed).not.toContainEqual(grid);
    }
    // A budget that ends inside the repair assesses nothing: the framework keeps the supplied
    // start it already scored instead of exchanging it for the looser grid.
    for (const limits of [{ ms: 1 }, { ms: 20 }, { evals: 6, ms: 20 }]) {
      const { ctx, log } = metered(problem, limits, {}, 5, start);
      await executeGrowth(ctx);
      expect(log.assessed).toEqual([]);
    }
  });
});

describe("ls_growth cooperative checkpoints", () => {
  it("bounds the stop polls between framework calls in start construction and in both dynamics", async () => {
    for (const problem of [
      { N: 4, M: 4, P: 500 },
      { N: 0, M: 0, P: 500 },
    ]) {
      const { ctx, log } = metered(problem, { evals: 4 }, { runs: 1 });
      await executeGrowth(ctx);
      expect(log.assessed).toHaveLength(4);
      // One placement trial is one poll and scans every placed piece. Placing P pieces without
      // a checkpoint takes at least P polls; with them no stretch reaches half of that.
      expect(log.yieldsStart).toBeGreaterThan(8);
      expect(log.longestStart).toBeLessThan(problem.P / 2);
      // A feasibility probe polls once per piece. Sixteen unbroken operations poll at least
      // 48 P times; a checkpoint is due after about 2048 weighted piece visits.
      expect(log.longest).toBeLessThan(16 * problem.P);
    }
  });

  it("reproduces run signatures: the budget, strictness, bounds and repeatability of seeded runs", async () => {
    // Before the diameter-1 units change this test pinned scores, collision and repair counts that
    // were recorded on one platform (event-driven trajectories are chaotic in the last bits of
    // libm). Native diameter-1 disks change every trajectory, so the pins are replaced by the
    // properties that hold on any platform: the budget and strictness, the area bound, and a
    // second run of the same seed reproducing the first exactly.
    for (const [N, M, P, evals, seed] of [
      [0, 0, 7, 60, 3],
      [0, 4, 12, 90, 8],
      [4, 4, 5, 60, 5],
      [5, 3, 9, 50, 13],
    ]) {
      const once = async () => {
        const last = { run: -1, operations: -1, collisions: -1, repairs: -1, thermostats: -1 };
        const observed = new MethodRegistry();
        observed.register({
          ...lsGrowthMethod,
          execute: (ctx) =>
            executeGrowth(ctx, (event) => {
              for (const key of Object.keys(last) as (keyof typeof last)[]) last[key] = event[key];
            }),
        });
        const result = await observed.run(
          { N, M, P },
          { method: "ls_growth", budget: { evals }, seed, finalPolish: false },
        );
        return { result, last };
      };
      const { result, last } = await once();
      expect(result.evaluations).toBe(evals);
      expect(result.termination).toBe("evals");
      expect(result.strict).toBe(true);
      strictValid(result.best, P);
      expect(result.score!).toBeGreaterThanOrEqual(areaLowerBound(N, M, P));
      // Cumulative totals reported at the end of the fourth and last run.
      expect(last.run).toBe(3);
      expect(last.operations).toBeGreaterThan(0);
      // Same platform, same seed: the same trajectory, bit for bit.
      const again = await once();
      expect(again.result.score).toBe(result.score);
      expect(again.last).toEqual(last);
    }
  });

  it("keeps seeded evaluation-budget results identical with inner checkpoints and an ample time budget", async () => {
    for (const problem of [
      { N: 5, M: 3, P: 60 },
      { N: 0, M: 6, P: 120 },
    ]) {
      const options = { method: "ls_growth", budget: { evals: 40 }, seed: 29 };
      const a = await run(problem, options);
      const b = await run(problem, options);
      const c = await run(problem, { ...options, budget: { evals: 40, time_s: 3600 } });
      expect(a.valid).toBe(true);
      for (const other of [b, c]) {
        expect(other.best).toEqual(a.best);
        expect(other.score).toBe(a.score);
        expect(other.evaluations).toBe(a.evaluations);
      }
      // The metered context sees the same assessments with and without a distant deadline.
      const plain = metered(problem, { evals: 6 });
      const distant = metered(problem, { evals: 6, ms: 1e12 });
      await executeGrowth(plain.ctx);
      await executeGrowth(distant.ctx);
      expect(distant.log.assessed).toEqual(plain.log.assessed);
      expect(plain.log.assessed[0]).toEqual(randomLoose(problem, seededRandom(5), () => false));
    }
  });

  it("honours a pause requested during start construction at a checkpoint and resumes to identical bits", async () => {
    const problem = { N: 5, M: 4, P: 300 };
    const options = { method: "ls_growth", budget: { evals: 4 }, seed: 31, finalPolish: false };
    const plain = await run(problem, options);
    const control = { aborted: false, paused: false };
    let polls = 0;
    const honoured: { call: string; polls: number }[] = [];
    const pausing = new MethodRegistry();
    pausing.register({
      ...lsGrowthMethod,
      execute: (ctx) => {
        // The framework waits inside the next call; resuming from a timer is not a race.
        const waits = (call: string): void => {
          if (!control.paused) return;
          honoured.push({ call, polls: polls - 40 });
          setTimeout(() => {
            control.paused = false;
          }, 20);
        };
        return executeGrowth({
          ...ctx,
          // The fortieth stop poll, early in placement, stands in for a Worker pause message.
          shouldStop: () => {
            if (++polls === 40) control.paused = true;
            return ctx.shouldStop();
          },
          checkpoint: () => {
            waits("checkpoint");
            return ctx.checkpoint();
          },
          evaluate: (config, evaluation) => {
            waits("evaluate");
            return ctx.evaluate(config, evaluation);
          },
        });
      },
    });
    const resumed = await pausing.run(problem, { ...options, control });
    expect(honoured).toHaveLength(1);
    expect(honoured[0].call).toBe("checkpoint");
    // Fewer polls than there are pieces: the wait began while pieces were still being placed.
    expect(honoured[0].polls).toBeLessThan(problem.P);
    expect(plain.valid).toBe(true);
    expect(resumed.best).toEqual(plain.best);
    expect(resumed.score).toBe(plain.score);
    expect(resumed.evaluations).toBe(plain.evaluations);
    expect(resumed.termination).toBe(plain.termination);
  });
});
