import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  boundingRadius,
  containerProtrusions,
  evaluate,
  pairPenetration,
  type PackingConfig,
} from "@polypack/geometry";
import { MethodRegistry, run, seededRandom } from "../src/index";
import { lbfgs } from "../src/methods/penalty/lbfgs";
import { nextPenaltyWeight, penaltyMethod } from "../src/methods/penalty";
import type { MethodContext, SubRunResult } from "../src/framework";
import { createPenaltyObjective, nearbyPairs, packState, unpackState } from "../src/methods/penalty/objective";
import { restore, scatter } from "../src/methods/penalty/restoration";

function knownStart(N: number, P: number, seed = 1): PackingConfig {
  const random = seededRandom(seed);
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
  return {
    N,
    M: N,
    P,
    container_phi: 0,
    pieces: pieces.map((p) => ({
      x: 1.2 * p.x + 0.004 * (random() - 0.5),
      y: 1.2 * p.y + 0.004 * (random() - 0.5),
      theta: p.theta + (N === 0 ? 0 : 0.002 * (random() - 0.5)),
    })),
  };
}

describe("penalty numerical helpers", () => {
  it("raises quadratic weights and raises augmented weights only when violation reduction stalls", () => {
    expect(nextPenaltyWeight(10, 4, false, 0.1, Infinity)).toBe(40);
    expect(nextPenaltyWeight(10, 4, true, 0.1, Infinity)).toBe(10);
    expect(nextPenaltyWeight(10, 4, true, 0.04, 0.1)).toBe(10);
    expect(nextPenaltyWeight(10, 4, true, 0.05, 0.1)).toBe(10);
    expect(nextPenaltyWeight(10, 4, true, 0.051, 0.1)).toBe(40);
    expect(nextPenaltyWeight(10, 4, true, 0, 0)).toBe(10);
    expect(nextPenaltyWeight(10, 1, true, 0.2, 0.1)).toBe(10);
    expect(nextPenaltyWeight(10, 4, true, 0.075, 0.1, 0.8)).toBe(10);
    expect(nextPenaltyWeight(10, 4, true, 0.075, 0.1, 0.7)).toBe(40);
  });

  it("repairs coincidences with deterministic seeded directions and keeps the optional-random API compatible", () => {
    for (const N of [0, 4, 5]) {
      const config: PackingConfig = {
        N,
        M: 4,
        P: 6,
        container_phi: 0,
        pieces: Array.from({ length: 6 }, () => ({ x: 0, y: 0, theta: 0 })),
      };
      const snapshot = structuredClone(config);
      for (const strategy of ["expand", "separate"] as const) {
        const first = restore(config, strategy, () => false, seededRandom(17));
        const again = restore(config, strategy, () => false, seededRandom(17));
        const other = restore(config, strategy, () => false, seededRandom(18));
        expect(config).toEqual(snapshot);
        expect(first).toBeDefined();
        expect(first).toEqual(again);
        expect(first!.pieces).not.toEqual(other?.pieces);
        expect(evaluate(first!, { autoOrient: false }).valid).toBe(true);
        expect(Math.max(...first!.pieces.map((p) => p.y)) - Math.min(...first!.pieces.map((p) => p.y))).toBeGreaterThan(
          0.1,
        );
        const legacy = restore(config, strategy, () => false);
        expect(legacy).toEqual(restore(config, strategy, () => false));
        if (legacy) expect(evaluate(legacy, { autoOrient: false }).valid).toBe(true);
      }
    }
  });
  it("minimises an anisotropic convex quadratic and Rosenbrock", async () => {
    const quadratic = await lbfgs(
      ([x, y]) => ({ value: (x - 3) ** 2 + 17 * (y + 2) ** 2, gradient: [2 * (x - 3), 34 * (y + 2)] }),
      [-9, 8],
      { iterations: 300, memory: 8, tolerance: 1e-8 },
    );
    expect(quadratic.value).toBeLessThan(1e-15);
    expect(quadratic.status).toBe("converged");
    const rosenbrock = await lbfgs(
      ([x, y]) => ({
        value: (1 - x) ** 2 + 100 * (y - x * x) ** 2,
        gradient: [2 * (x - 1) - 400 * x * (y - x * x), 200 * (y - x * x)],
      }),
      [-1.2, 1],
      { iterations: 1000, memory: 8, tolerance: 1e-8 },
    );
    expect(rosenbrock.value).toBeLessThan(1e-15);
    expect(rosenbrock.x[0]).toBeCloseTo(1, 7);
    expect(rosenbrock.x[1]).toBeCloseTo(1, 7);
  });

  it("accepts only descent steps and contains nonfinite line-search trials", async () => {
    const values: number[] = [];
    const objective = ([x]: readonly number[]) => ({ value: x > 3 ? Infinity : (x - 2) ** 2, gradient: [2 * (x - 2)] });
    const result = await lbfgs(objective, [-4], {
      iterations: 100,
      memory: 5,
      tolerance: 1e-10,
      onIteration: async (x) => {
        values.push(objective(x).value);
        return true;
      },
    });
    expect(result.value).toBeLessThan(1e-15);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThan(values[i - 1]);
    const failed = await lbfgs(() => ({ value: NaN, gradient: [NaN] }), [1], {
      iterations: 100,
      memory: 5,
      tolerance: 1e-10,
    });
    expect(failed.status).toBe("nonfinite");
    expect(failed.x).toEqual([1]);
  });

  it("matches full pair sums, rebuilt grids, and objective finite differences", () => {
    for (const N of [0, 3, 4, 5, 6, 8]) {
      for (const M of [0, 4]) {
        const random = seededRandom(731 + N + M);
        const config: PackingConfig = {
          N,
          M,
          P: 5,
          container_phi: 0.21,
          pieces: Array.from({ length: 5 }, () => ({ x: 2 * random() - 1, y: 2 * random() - 1, theta: random() })),
        };
        const x = packState({ config, container: { M, cx: 0.31, cy: -0.27, size: 1.3, phi: 0.21 } });
        const objective = createPenaltyObjective(config, 7, new Map(), false);
        const output = objective.evaluate(x);
        let full = 1.3;
        for (let i = 0; i < config.P; i++) {
          for (let j = i + 1; j < config.P; j++)
            full += 7 * Math.max(0, pairPenetration(N, config.pieces[i], config.pieces[j]).depth) ** 2;
          for (const wall of containerProtrusions(N, config.pieces[i], unpackState(config, x).container))
            full += 7 * Math.max(0, wall.depth) ** 2;
        }
        expect(output.value).toBeCloseTo(full, 10);
        for (let k = 0; k < x.length; k++) {
          const plus = x.slice();
          const minus = x.slice();
          plus[k] += 1e-6;
          minus[k] -= 1e-6;
          const numeric = (objective.evaluate(plus).value - objective.evaluate(minus).value) / 2e-6;
          expect(Math.abs(numeric - output.gradient[k])).toBeLessThan(2e-5 * Math.max(1, Math.abs(numeric)));
        }
        const augmented = createPenaltyObjective(
          config,
          7,
          new Map([
            ["p:0:1", 5],
            ["w:0:0", 11],
            ["w:1:0", 9],
          ]),
          true,
        );
        const analytic = augmented.evaluate(x).gradient;
        for (let k = 0; k < x.length; k++) {
          const plus = x.slice();
          const minus = x.slice();
          plus[k] += 1e-6;
          minus[k] -= 1e-6;
          const numeric = (augmented.evaluate(plus).value - augmented.evaluate(minus).value) / 2e-6;
          expect(Math.abs(numeric - analytic[k])).toBeLessThan(2e-5 * Math.max(1, Math.abs(numeric)));
        }
        const moved = config.pieces.map((p, i) => ({ ...p, x: p.x + (i % 2 ? 20 : -20) }));
        const found = new Set(nearbyPairs(moved, 2 * boundingRadius(N), () => false).map(([i, j]) => `${i}:${j}`));
        for (let i = 0; i < moved.length; i++)
          for (let j = i + 1; j < moved.length; j++)
            expect(found.has(`${i}:${j}`)).toBe(
              Math.hypot(moved[i].x - moved[j].x, moved[i].y - moved[j].y) <= 2 * boundingRadius(N),
            );
      }
    }
  });

  it("keeps an active AL pair beyond the grid radius and releases its multiplier", () => {
    const config: PackingConfig = {
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: -1.5, y: 0.1, theta: 0 },
        { x: 1.5, y: 0.1, theta: 0 },
      ],
    };
    const multipliers = new Map([["p:0:1", 100]]);
    const objective = createPenaltyObjective(config, 10, multipliers, true);
    const x = packState({ config, container: { M: 0, cx: 0, cy: 0, phi: 0, size: 10 } });
    const result = objective.evaluate(x);
    expect(result.value).toBeCloseTo(10 + (60 ** 2 - 100 ** 2) / 40, 12);
    expect(result.gradient[0]).toBe(60);
    expect(result.gradient[2]).toBe(-60);
    objective.updateMultipliers(x);
    expect(multipliers.get("p:0:1")).toBe(60);
    createPenaltyObjective(config, 10, multipliers, true).updateMultipliers(x);
    createPenaltyObjective(config, 10, multipliers, true).updateMultipliers(x);
    expect(multipliers.has("p:0:1")).toBe(false);
  });

  it("matches the support-wall objective and its numeric-multiplier gradient", () => {
    for (const N of [0, 3, 4, 5, 6, 8]) {
      for (const M of [0, 4]) {
        const random = seededRandom(873 + N + M);
        const config: PackingConfig = {
          N,
          M,
          P: 4,
          container_phi: 0.31,
          pieces: Array.from({ length: 4 }, () => ({ x: 2 * random() - 1, y: 2 * random() - 1, theta: random() })),
        };
        const container = { M, cx: 0.21, cy: -0.17, size: 0.8, phi: 0.31 };
        const wallCount = M || N || 1;
        const multipliers = new Map<number, number>([
          [1, 5],
          [16, 11],
          [16 + wallCount, 9],
        ]);
        const objective = createPenaltyObjective(config, 7, multipliers, true, () => false, true);
        const x = packState({ config, container });
        const output = objective.evaluate(x);
        const term = (key: number, depth: number) => {
          const lambda = multipliers.get(key) ?? 0;
          return (Math.max(0, lambda + 14 * depth) ** 2 - lambda ** 2) / 28;
        };
        let expected = container.size;
        for (let i = 0; i < config.P; i++) {
          for (let j = i + 1; j < config.P; j++)
            expected += term(i * config.P + j, pairPenetration(N, config.pieces[i], config.pieces[j]).depth);
          const all = containerProtrusions(N, config.pieces[i], container);
          for (let wall = 0; wall < wallCount; wall++) {
            const depth =
              M === 0 ? all[wall].depth : Math.max(...all.filter((w) => w.edge === wall).map((w) => w.depth));
            expected += term(config.P ** 2 + i * wallCount + wall, depth);
          }
        }
        expect(Math.abs(output.value - expected)).toBeLessThan(1e-9 * (1 + Math.abs(expected)));
        for (let k = 0; k < x.length; k++) {
          const plus = x.slice();
          const minus = x.slice();
          plus[k] += 1e-6;
          minus[k] -= 1e-6;
          const numeric = (objective.evaluate(plus).value - objective.evaluate(minus).value) / 2e-6;
          expect(Math.abs(numeric - output.gradient[k])).toBeLessThan(2e-5 * Math.max(1, Math.abs(numeric)));
        }
      }
    }
  });

  it("preserves empty legacy string maps and numeric production maps across multiplier updates", () => {
    const config: PackingConfig = {
      N: 4,
      M: 4,
      P: 2,
      container_phi: 0.21,
      pieces: [
        { x: 0, y: 0, theta: 0.13 },
        { x: 0.2, y: 0.1, theta: 0.27 },
      ],
    };
    const x = packState({ config, container: { M: 4, cx: 0, cy: 0, size: 0.5, phi: 0.21 } });
    const legacy = new Map<string, number>();
    createPenaltyObjective(config, 7, legacy, true).updateMultipliers(x);
    expect(legacy.size).toBeGreaterThan(0);
    expect([...legacy.keys()].every((key) => typeof key === "string" && /^[pw]:\d+:\d+$/.test(key))).toBe(true);
    const numeric = new Map<number, number>();
    createPenaltyObjective(config, 7, numeric, true, () => false, true).updateMultipliers(x);
    expect(numeric.size).toBeGreaterThan(0);
    expect([...numeric.keys()].every((key) => Number.isSafeInteger(key))).toBe(true);
    const numericFull = new Map<number, number>([[1, 5]]);
    const stringFull = new Map<string, number>([["p:0:1", 5]]);
    const a = createPenaltyObjective(config, 7, numericFull, true);
    const b = createPenaltyObjective(config, 7, stringFull, true);
    expect(a.evaluate(x)).toEqual(b.evaluate(x));
    a.updateMultipliers(x);
    b.updateMultipliers(x);
    const translated = new Map<number, number>();
    for (const [key, value] of stringFull) {
      const [kind, i, j] = key.split(":");
      translated.set(kind === "p" ? Number(i) * 2 + Number(j) : 4 + Number(i) * 16 + Number(j), value);
    }
    expect(numericFull).toEqual(translated);
  });

  it("rejects finite spatial blow-ups while allowing finite large angles and bounded huge-cell scans", () => {
    const config: PackingConfig = {
      N: 4,
      M: 4,
      P: 2,
      container_phi: 0.21,
      pieces: [
        { x: 0, y: 0, theta: 0.13 },
        { x: 0.2, y: 0.1, theta: 0.27 },
      ],
    };
    const x = packState({ config, container: { M: 4, cx: 0, cy: 0, size: 2, phi: 0.21 } });
    const objective = createPenaltyObjective(config, 7, new Map<number, number>(), true, () => false, true);
    for (const index of [0, 1, 3, 4, 6, 7]) {
      for (const value of [-1e308, 1e308]) {
        const trial = x.slice();
        trial[index] = value;
        const result = objective.evaluate(trial);
        expect(result.value).toBe(Infinity);
        expect(result.gradient.every(Number.isFinite)).toBe(true);
      }
    }
    const angles = x.slice();
    angles[2] = 1e9;
    angles[5] = -1e9;
    angles[9] = 1e9;
    const result = objective.evaluate(angles);
    expect(Number.isFinite(result.value)).toBe(true);
    expect(result.gradient.every(Number.isFinite)).toBe(true);
    for (const coordinate of [-1e308, 1e308]) {
      const pairs = nearbyPairs(
        [
          { x: coordinate, y: coordinate, theta: 0 },
          { x: coordinate, y: coordinate, theta: 0 },
        ],
        2,
        () => false,
      );
      expect(pairs).toContainEqual([0, 1]);
      expect(new Set(pairs.map(([i, j]) => `${i}:${j}`)).size).toBe(pairs.length);
    }
    const expansion: PackingConfig = {
      N: 0,
      M: 0,
      P: 3,
      container_phi: 0,
      pieces: [
        { x: 0, y: 0, theta: 0 },
        { x: 1e-10, y: 0, theta: 0 },
        { x: 1e5, y: 1e5, theta: 0 },
      ],
    };
    // The factor needed by the near-coincident pair would send the third
    // centre far outside the accepted coordinate range. Reject before scanning it.
    expect(restore(expansion, "expand", () => false)).toBeUndefined();
  });
});

describe("registered penalty method", () => {
  it("requests a bounded automatic seed and uses its valid arrangement", async () => {
    const problem = { N: 0, M: 0, P: 2 };
    const best = knownStart(0, 2);
    const assessment = evaluate(best, { autoOrient: false });
    const subrun = vi.fn(async (): Promise<SubRunResult> => ({
      best,
      found: best,
      foundScore: assessment.score,
      ...assessment,
      evaluations: 24,
      termination: "evals",
    }));
    const submitted: PackingConfig[] = [];
    const ctx: MethodContext = {
      problem,
      starts: [],
      params: { ...penaltyMethod.defaults },
      random: seededRandom(27),
      checkpoint: async () => true,
      shouldStop: () => submitted.length > 0,
      remaining: () => ({ evals: Infinity, time_s: Infinity }),
      evaluate: async (candidate) => {
        submitted.push(candidate);
        return evaluate(candidate, { autoOrient: false });
      },
      emit: async () => undefined,
      run: subrun,
    };
    await penaltyMethod.execute(ctx);
    expect(subrun).toHaveBeenCalledExactlyOnceWith("seed", { kind: "auto" }, { evals: 24 });
    expect(submitted).toHaveLength(1);
    submitted[0].pieces.forEach((piece, i) => {
      expect(piece.x).toBeCloseTo(best.pieces[i].x, 12);
      expect(piece.y).toBeCloseTo(best.pieces[i].y, 12);
    });
  });

  it("falls back to a valid deterministic scatter when the seed subrun has no usable result", async () => {
    const problem = { N: 0, M: 0, P: 3 };
    const failed: SubRunResult = {
      foundScore: null,
      score: null,
      valid: false,
      container: null,
      evaluations: 0,
      termination: "completed",
      reasons: [],
    };
    for (const outcome of [failed, { ...failed, valid: true, best: knownStart(0, 2) }, new Error("seed failed")]) {
      const submitted: PackingConfig[] = [];
      const ctx: MethodContext = {
        problem,
        starts: [],
        params: { ...penaltyMethod.defaults },
        random: seededRandom(27),
        checkpoint: async () => true,
        shouldStop: () => submitted.length > 0,
        remaining: () => ({ evals: Infinity, time_s: Infinity }),
        evaluate: async (candidate) => {
          submitted.push(candidate);
          return evaluate(candidate, { autoOrient: false });
        },
        emit: async () => undefined,
        run: async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      };
      await penaltyMethod.execute(ctx);
      const expected = scatter(problem, seededRandom(27));
      expect(submitted).toHaveLength(1);
      expect(evaluate(submitted[0], { autoOrient: false }).valid).toBe(true);
      submitted[0].pieces.forEach((piece, i) => {
        expect(piece.x).toBeCloseTo(expected.pieces[i].x, 12);
        expect(piece.y).toBeCloseTo(expected.pieces[i].y, 12);
      });
    }
  });

  it("bypasses seeding for complete valid and invalid supplied starts and explicit scatter mode", async () => {
    const problem = { N: 0, M: 0, P: 2 };
    for (const start of [knownStart(0, 2), { ...knownStart(0, 2), pieces: Array(2).fill({ x: 0, y: 0, theta: 0 }) }]) {
      const snapshot = structuredClone(start);
      const options = { method: "penalty", start, budget: { evals: 40 }, seed: 27, finalPolish: false };
      const seeded = await run(problem, { ...options, params: { start: "seed" } });
      const scattered = await run(problem, { ...options, params: { start: "scatter" } });
      expect(seeded.valid).toBe(true);
      expect(seeded.best).toEqual(scattered.best);
      expect(seeded.evaluations).toBe(scattered.evaluations);
      expect(start).toEqual(snapshot);
    }
    const subrun = vi.fn(async () => {
      throw new Error("seeding must be bypassed");
    });
    for (const start of [
      undefined,
      knownStart(0, 2),
      { ...knownStart(0, 2), pieces: Array(2).fill({ x: 0, y: 0, theta: 0 }) },
    ])
      await penaltyMethod.execute({
        problem,
        start,
        starts: [],
        initialEvaluation: start ? evaluate(start) : undefined,
        params: { ...penaltyMethod.defaults, start: start ? "seed" : "scatter" },
        random: seededRandom(27),
        checkpoint: async () => true,
        shouldStop: () => true,
        remaining: () => ({ evals: Infinity, time_s: Infinity }),
        evaluate: async () => undefined,
        emit: async () => undefined,
        run: subrun,
      });
    expect(subrun).not.toHaveBeenCalled();
  });

  it("recovers to scatter when the seed method is unavailable in a custom registry", async () => {
    const registry = new MethodRegistry();
    registry.register(penaltyMethod);
    const problem = { N: 0, M: 0, P: 3 };
    const options = { method: "penalty", budget: { evals: 60 }, seed: 27, finalPolish: false };
    const fallback = await registry.run(problem, options);
    const baseline = await registry.run(problem, { ...options, params: { start: "scatter" } });
    expect(fallback.valid).toBe(true);
    expect(fallback.termination).not.toBe("error");
    expect(fallback.best).toEqual(baseline.best);
    expect(fallback.score).toBe(baseline.score);
    expect(fallback.evaluations).toBe(baseline.evaluations);
  });

  it("clips the seed subrun to tiny parent budgets and reproduces its valid best", async () => {
    const problem = { N: 5, M: 3, P: 7 };
    for (const evals of [2, 3, 7, 24, 25, 31]) {
      const options = { method: "penalty", budget: { evals }, seed: 27 };
      const first = await run(problem, options);
      const second = await run(problem, options);
      expect(first.valid).toBe(true);
      expect(first.evaluations).toBeLessThanOrEqual(evals);
      expect(first.best!.pieces).toHaveLength(problem.P);
      expect(evaluate(first.best!, { autoOrient: false }).valid).toBe(true);
      expect(first.best).toEqual(second.best);
      expect(first.score).toBe(second.score);
      expect(first.evaluations).toBe(second.evaluations);
    }
    await expect(
      run(problem, { method: "penalty", params: { start: "other" }, budget: { evals: 2 }, seed: 27 }),
    ).rejects.toThrow();
  });

  it("keeps a row when jitter is disabled and breaks its transverse symmetry by default", async () => {
    const start: PackingConfig = {
      N: 0,
      M: 0,
      P: 6,
      container_phi: 0,
      pieces: Array.from({ length: 6 }, (_, i) => ({ x: 2.5 * i, y: 0, theta: 0 })),
    };
    const options = { method: "penalty", start, budget: { evals: 3000 }, seed: 1, finalPolish: false };
    const disabled = await run(start, { ...options, params: { jitter: 0 } });
    const automatic = await run(start, options);
    const again = await run(start, options);
    expect(disabled.valid).toBe(true);
    expect(automatic.valid).toBe(true);
    expect(disabled.best!.pieces.every((p) => Math.abs(p.y) < 1e-12)).toBe(true);
    expect(disabled.score!).toBeGreaterThan(5.9);
    expect(automatic.score!).toBeLessThan(5.9);
    expect(
      Math.max(...automatic.best!.pieces.map((p) => p.y)) - Math.min(...automatic.best!.pieces.map((p) => p.y)),
    ).toBeGreaterThan(0.1);
    expect(automatic.best).toEqual(again.best);
    expect(automatic.evaluations).toBe(again.evaluations);
  });
  it("draws valid random scatters with angles spread across each shape's rotation period", () => {
    for (const N of [0, 3, 4, 5, 6, 8]) {
      const bins = Array<number>(8).fill(0);
      for (let seed = 1; seed <= 10; seed++) {
        const start = scatter({ N, M: 4, P: 30 }, seededRandom(seed));
        expect(evaluate(start, { autoOrient: false }).valid).toBe(true);
        expect(start).toEqual(scatter({ N, M: 4, P: 30 }, seededRandom(seed)));
        for (const pose of start.pieces) {
          if (N === 0) {
            expect(pose.theta).toBe(0);
            continue;
          }
          const period = (2 * Math.PI) / N;
          const phase = ((pose.theta % period) + period) % period;
          bins[Math.min(7, Math.floor((8 * phase) / period))]++;
        }
      }
      if (N !== 0) for (const count of bins) expect(count).toBeGreaterThan(15);
    }
  });

  it("optimises centroid-relative states equally well near both ends of the coordinate range", async () => {
    for (const N of [0, 4]) {
      const start: PackingConfig = {
        N,
        M: N,
        P: 4,
        container_phi: 0,
        pieces: [
          [-1.5, -1.5],
          [1.5, -1.5],
          [-1.5, 1.5],
          [1.5, 1.5],
        ].map(([x, y], i) => ({
          x,
          y,
          theta: N === 0 ? 0 : 0.17 + 0.11 * i,
        })),
      };
      const options = { method: "penalty", budget: { evals: 1800 }, seed: 13, finalPolish: false };
      const near = await run(start, { ...options, start });
      expect(near.valid).toBe(true);
      for (const offset of [-6e5, 6e5]) {
        const shifted = {
          ...start,
          pieces: start.pieces.map((pose) => ({ ...pose, x: pose.x + offset, y: pose.y - offset })),
        };
        const far = await run(start, { ...options, start: shifted });
        expect(far.valid).toBe(true);
        expect(far.stages[0].evaluations).toBeGreaterThan(1);
        expect(Math.abs(far.score! - near.score!)).toBeLessThan(1e-6);
        for (let i = 0; i < start.P; i++) {
          expect(Math.abs(far.best!.pieces[i].x - offset - near.best!.pieces[i].x)).toBeLessThan(1e-4);
          expect(Math.abs(far.best!.pieces[i].y + offset - near.best!.pieces[i].y)).toBeLessThan(1e-4);
          expect(Math.abs(far.best!.pieces[i].theta - near.best!.pieces[i].theta)).toBeLessThan(1e-4);
        }
      }
    }
  });
  it("returns exactly P valid pieces and never worsens valid starts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 100000 }),
        async (N, M, P, seed) => {
          const problem = { N, M, P };
          const start = scatter(problem, seededRandom(seed));
          const result = await run(problem, { method: "penalty", start, budget: { evals: 180 }, seed });
          expect(result.valid).toBe(true);
          expect(result.best!.pieces).toHaveLength(P);
          expect(evaluate(result.best!, { autoOrient: true }).valid).toBe(true);
          expect(result.score!).toBeLessThanOrEqual(evaluate(start, { autoOrient: true }).score!);
          expect(result.evaluations).toBeLessThanOrEqual(180);
        },
      ),
      { numRuns: 24, seed: 4142 },
    );
  });

  it("recovers known answers from starts expanded by 20 percent and jittered", async () => {
    for (const [N, P, target] of [
      [4, 5, 2 + Math.SQRT1_2],
      [0, 7, 3],
      [0, 2, 2],
    ]) {
      const start = knownStart(N, P);
      const result = await run({ N, M: N, P }, { method: "penalty", start, budget: { evals: 5000 }, seed: 1 });
      expect(result.valid).toBe(true);
      expect(Math.abs(result.score! - target)).toBeLessThanOrEqual(1e-8);
      expect(result.stages.at(-1)!.method).toBe("polish");
    }
  });

  it("reaches the scatter targets for at least four of five seeds with 2500 evaluations", async () => {
    for (const [N, P, target] of [
      [0, 7, 3.05],
      [4, 4, 2.05],
    ]) {
      let successes = 0;
      for (let seed = 1; seed <= 5; seed++) {
        const result = await run(
          { N, M: N, P },
          { method: "penalty", params: { start: "scatter" }, budget: { evals: 2500 }, seed },
        );
        expect(result.valid).toBe(true);
        if (result.score! <= target) successes++;
      }
      expect(successes).toBeGreaterThanOrEqual(4);
    }
  });

  it("is deterministic with an evaluation budget and supports both schedules and restoration strategies", async () => {
    for (const schedule of ["quadratic", "augmented"])
      for (const restoration of ["expand", "separate"]) {
        const options = { method: "penalty", params: { schedule, restoration }, budget: { evals: 140 }, seed: 79 };
        const problem = { N: 5, M: 4, P: 6 };
        const a = await run(problem, options);
        const b = await run(problem, options);
        expect(a.valid).toBe(true);
        expect(a.best).toEqual(b.best);
        expect(a.score).toBe(b.score);
        expect(a.evaluations).toBe(b.evaluations);
      }
  });

  it("respects tiny evaluation and time budgets with a valid start", async () => {
    const problem = { N: 4, M: 4, P: 30 };
    const start = scatter(problem, seededRandom(82));
    for (const evals of [1, 2, 7, 31]) {
      const result = await run(problem, { method: "penalty", start, budget: { evals }, seed: 82 });
      expect(result.valid).toBe(true);
      expect(result.evaluations).toBeLessThanOrEqual(evals);
    }
    const result = await run(problem, {
      method: "penalty",
      start,
      params: { outerIterations: 100, innerIterations: 10000 },
      budget: { time_s: 0.01 },
      seed: 82,
    });
    expect(result.valid).toBe(true);
    expect(result.termination).toBe("time");
    expect(result.wallTime).toBeLessThan(0.5);
  });

  it("assesses a no-start fallback with the smallest runnable budgets", async () => {
    const problem = { N: 5, M: 3, P: 30 };
    for (const evals of [2, 3]) {
      const result = await run(problem, { method: "penalty", budget: { evals }, seed: 101 });
      expect(result.valid).toBe(true);
      expect(result.evaluations).toBeLessThanOrEqual(evals);
      expect(result.best!.pieces).toHaveLength(30);
    }
  });

  it("records the framework's pre-execution no-start limitation", async () => {
    const problem = { N: 0, M: 0, P: 7 };
    for (const options of [
      { budget: { evals: 1 } },
      { budget: { time_s: 0 } },
      { budget: { evals: 100 }, control: { aborted: true } },
    ]) {
      const result = await run(problem, { method: "penalty", seed: 5, ...options });
      expect(result.best).toBeUndefined();
      expect(result.valid).toBe(false);
      expect(result.evaluations).toBe(0);
    }
  });

  it("returns within one second after abort with a valid best", async () => {
    const problem = { N: 8, M: 8, P: 30 };
    for (const supplied of [false, true]) {
      const control = { aborted: false };
      let abortAt = 0;
      const began = performance.now();
      const result = await run(problem, {
        method: "penalty",
        start: supplied ? scatter(problem, seededRandom(22)) : undefined,
        budget: { evals: 100000 },
        seed: 22,
        control,
        onProgress: (frame) => {
          if (!frame.final && frame.valid && !control.aborted) {
            abortAt = performance.now();
            control.aborted = true;
          }
        },
      });
      expect(result.valid).toBe(true);
      expect(result.termination).toBe("aborted");
      expect(abortAt).toBeGreaterThanOrEqual(began);
      expect(performance.now() - abortAt).toBeLessThan(1000);
      expect(evaluate(result.best!, { autoOrient: true }).valid).toBe(true);
    }
  });

  it("contains overflow from an absurd initial weight and returns the valid fallback", async () => {
    const problem = { N: 4, M: 4, P: 7 };
    const result = await run(problem, {
      method: "penalty",
      params: { initialWeight: 1e308 },
      budget: { evals: 400 },
      seed: 551,
    });
    expect(result.valid).toBe(true);
    expect(result.termination).not.toBe("error");
    expect(Number.isFinite(result.score)).toBe(true);
    expect(evaluate(result.best!, { autoOrient: true }).valid).toBe(true);
  });

  it("repairs coincident invalid starts and accepts a timer abort during numerical work", async () => {
    const problem = { N: 0, M: 4, P: 12 };
    const start: PackingConfig = {
      ...problem,
      container_phi: 0,
      pieces: Array.from({ length: problem.P }, () => ({ x: 0, y: 0, theta: 0 })),
    };
    for (const restoration of ["expand", "separate"]) {
      const result = await run(problem, {
        method: "penalty",
        start,
        params: { restoration },
        budget: { evals: 120 },
        seed: 53,
      });
      expect(result.valid).toBe(true);
      expect(evaluate(result.best!, { autoOrient: true }).valid).toBe(true);
    }
    const incomplete = await run(problem, {
      method: "penalty",
      start: { ...start, pieces: start.pieces.slice(1) },
      budget: { evals: 120 },
      seed: 53,
    });
    expect(incomplete.valid).toBe(true);
    expect(incomplete.best!.pieces).toHaveLength(problem.P);
    const control = { aborted: false };
    let abortAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const large = { N: 8, M: 8, P: 30 };
      const result = await run(large, {
        method: "penalty",
        start: scatter(large, seededRandom(87)),
        params: { innerIterations: 10000, outerIterations: 100 },
        budget: { evals: 100000 },
        seed: 87,
        control,
        onProgress: (frame) => {
          if (frame.valid && !frame.final && timer === undefined) {
            timer = setTimeout(() => {
              abortAt = performance.now();
              control.aborted = true;
            }, 25);
          }
        },
      });
      expect(abortAt).toBeGreaterThan(0);
      expect(result.evaluations).toBeGreaterThan(1);
      expect(result.termination).toBe("aborted");
      expect(result.valid).toBe(true);
      expect(performance.now() - abortAt).toBeLessThan(1000);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
});
