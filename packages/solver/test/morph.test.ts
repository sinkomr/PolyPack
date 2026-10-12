import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  boundingRadius,
  circumradius,
  containerProtrusions,
  enclose,
  evaluate,
  findOverlaps,
  inradius,
  pairPenetration,
  pieceSeparation,
  pieceVertices,
  polygonCircleSeparation,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import { run, seededRandom } from "../src";
import { morphMethod } from "../src/methods/morph";
import { createPenaltyObjective, packState } from "../src/methods/penalty/objective";
import { scatter } from "../src/methods/penalty/restoration";
import { roundedShape, shapeSeparation, superellipseError, superellipseVertices } from "../src/methods/morph/shapes";
import type { MethodContext } from "../src/framework";

const codes = [0, 3, 4, 5, 6, 8] as const;
const pose = fc.record({
  x: fc.integer({ min: -2000, max: 2000 }).map((x) => x / 997),
  y: fc.integer({ min: -2000, max: 2000 }).map((x) => x / 997),
  theta: fc.integer({ min: -3000, max: 3000 }).map((x) => x / 997),
});
const fraction = fc.integer({ min: 0, max: 1000 }).map((x) => x / 1000);

function minimumSeparation(config: PackingConfig): number {
  let minimum = Infinity;
  for (let i = 0; i < config.P; i++) {
    for (let j = 0; j < i; j++)
      minimum = Math.min(minimum, pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep);
  }
  return minimum;
}

/** Boundary consists of N circular arcs and N straight segments, sampled by arc length. */
function roundedBoundary(N: number, p: Pose, t: number, samples: number): Float64Array {
  const vertices = pieceVertices(N, p, t);
  const pad = (1 - t) * inradius(N);
  const points: number[] = [];
  for (let k = 0; k < N; k++) {
    const next = (k + 1) % N;
    const normal = p.theta + Math.PI / 2 + ((2 * k + 1) * Math.PI) / N;
    for (let j = 0; j < samples; j++) {
      const a = normal - (2 * Math.PI) / N + (2 * Math.PI * j) / (N * samples);
      points.push(vertices[2 * k] + pad * Math.cos(a), vertices[2 * k + 1] + pad * Math.sin(a));
      const u = j / samples;
      points.push(
        (1 - u) * vertices[2 * k] + u * vertices[2 * next] + pad * Math.cos(normal),
        (1 - u) * vertices[2 * k + 1] + u * vertices[2 * next + 1] + pad * Math.sin(normal),
      );
    }
  }
  return new Float64Array(points);
}

describe("morph geometry", () => {
  it("reproduces both rounded endpoints and the circumscribed circle exactly", () => {
    fc.assert(
      fc.property(fc.constantFrom(3, 4, 5, 6, 8), pose, pose, (N, a, b) => {
        expect(shapeSeparation(N, a, b, roundedShape(N, 1, "inscribed"))).toBeCloseTo(pieceSeparation(N, a, b).sep, 14);
        for (const family of ["inscribed", "circumscribed"] as const) {
          const radius = family === "inscribed" ? inradius(N) : circumradius(N);
          expect(shapeSeparation(N, a, b, roundedShape(N, 0, family))).toBe(
            Math.hypot(a.x - b.x, a.y - b.y) - 2 * radius,
          );
        }
      }),
      { numRuns: 150, seed: 9501 },
    );
  });

  it("contains sampled inscribed-family boundary points in P for random t", () => {
    fc.assert(
      fc.property(fc.constantFrom(3, 4, 5, 6, 8), pose, fraction, (N, p, t) => {
        const original = pieceVertices(N, p);
        const points = roundedBoundary(N, p, t, 16);
        for (let k = 0; k < points.length; k += 2) {
          expect(polygonCircleSeparation(original, points[k], points[k + 1], 0).sep).toBeLessThanOrEqual(3e-15);
        }
        const shape = roundedShape(N, t, "circumscribed");
        // Support of the outer family is >= support of P for every direction.
        for (let k = 0; k < 64; k++) {
          const a = (2 * Math.PI * k) / 64;
          let support = -Infinity;
          for (let j = 0; j < N; j++)
            support = Math.max(
              support,
              (original[2 * j] - p.x) * Math.cos(a) + (original[2 * j + 1] - p.y) * Math.sin(a),
            );
          expect(shape.scale * support + shape.padding).toBeGreaterThanOrEqual(support - 2e-15);
        }
      }),
      { numRuns: 100, seed: 9502 },
    );
  });

  it("agrees with brute-force sampled boundary distance within the sample spacing", () => {
    const random = seededRandom(9503);
    for (const N of [3, 4, 5, 6, 8]) {
      for (let trial = 0; trial < 3; trial++) {
        const t = 0.05 + 0.9 * random();
        const a = { x: 0, y: 0, theta: random() * 5 };
        const b = { x: 3 * boundingRadius(N), y: random(), theta: random() * 5 };
        const A = roundedBoundary(N, a, t, 48);
        const B = roundedBoundary(N, b, t, 48);
        let distance = Infinity;
        for (let i = 0; i < A.length; i += 2) {
          for (let j = 0; j < B.length; j += 2)
            distance = Math.min(distance, Math.hypot(A[i] - B[j], A[i + 1] - B[j + 1]));
        }
        const gap = shapeSeparation(N, a, b, roundedShape(N, t, "inscribed"));
        const spacing = Math.max(t, ((1 - t) * inradius(N) * 2 * Math.PI) / N) / 48;
        expect(distance).toBeGreaterThanOrEqual(gap - 1e-13);
        expect(distance - gap).toBeLessThanOrEqual(spacing + 1e-13);
      }
    }
  });

  it("handles a diagonal rounded contact and tiny cores at large coordinates", () => {
    const a = { x: 0, y: 0, theta: Math.PI / 4 };
    const b = { ...a, x: 1, y: 1 };
    expect(Math.abs(pairPenetration(4, a, b, undefined, undefined, 0.5, Math.SQRT1_2 / 2).depth)).toBeLessThan(3e-16);
    const tiny = pairPenetration(
      4,
      { ...a, x: 1e6, y: 1e6 },
      { ...b, x: 1e6 + 1, y: 1e6 + 1 },
      undefined,
      undefined,
      1e-12,
      0.5,
    );
    expect([tiny.depth, ...Object.values(tiny.a), ...Object.values(tiny.b)].every(Number.isFinite)).toBe(true);
    expect(tiny.depth).toBeCloseTo(1 - Math.SQRT2, 10);
    const vertexContact = pairPenetration(
      10,
      { x: 0, y: 0, theta: 5.5632 },
      { x: 0.6401333626528783, y: 0.7298777390554397, theta: 8.704792653589793 },
      undefined,
      undefined,
      0.3,
      0.2,
    );
    expect(
      [vertexContact.depth, ...Object.values(vertexContact.a), ...Object.values(vertexContact.b)].every(
        Number.isFinite,
      ),
    ).toBe(true);
  });

  for (const p of [2, 4, 8, 32]) {
    it(`bounds the superellipse polygon error for p=${p}`, () => {
      const origin = { x: 0, y: 0, theta: 0.13 };
      const poly = superellipseVertices(origin, p, 64);
      const dense = superellipseVertices(origin, p, 4096);
      for (let i = 0; i < dense.length; i += 2) {
        expect(polygonCircleSeparation(poly, dense[i], dense[i + 1], 0).sep).toBeLessThanOrEqual(superellipseError(64));
      }
      const angle = origin.theta + Math.PI / 4;
      for (let i = 0; i < poly.length; i += 2) {
        const x = poly[i] * Math.cos(angle) + poly[i + 1] * Math.sin(angle);
        const y = -poly[i] * Math.sin(angle) + poly[i + 1] * Math.cos(angle);
        expect(Math.abs((Math.abs(x) / 0.5) ** p + (Math.abs(y) / 0.5) ** p - 1)).toBeLessThan(1e-13);
      }
    });
  }

  for (const N of [3, 4, 5, 6, 8]) {
    it(`matches rounded objective gradients for N=${N}`, () => {
      fc.assert(
        fc.property(pose, pose, fraction, fc.constantFrom(0, 3, 4, 5, 6, 8), (a, b, t, M) => {
          const template = { N, M, P: 2, pieces: [a, b], container_phi: 0.123 };
          const state = packState({ config: template, container: { M, cx: 0.17, cy: -0.23, phi: 0.123, size: 0.7 } });
          const shape = roundedShape(N, t, "inscribed");
          for (const augmented of [false, true]) {
            const objective = createPenaltyObjective(
              template,
              7,
              new Map<number, number>([
                [1, 0.3],
                [4, 0.1],
              ]),
              augmented,
              () => false,
              true,
              shape.scale,
              shape.padding,
            );
            const analytic = objective.evaluate(state);
            for (let j = 0; j < state.length; j++) {
              const plus = state.slice();
              const minus = state.slice();
              plus[j] += 1e-6;
              minus[j] -= 1e-6;
              const numeric = (objective.evaluate(plus).value - objective.evaluate(minus).value) / 2e-6;
              plus[j] = state[j] + 5e-7;
              minus[j] = state[j] - 5e-7;
              const halfStep = (objective.evaluate(plus).value - objective.evaluate(minus).value) / 1e-6;
              // Detect a feature switch independently of the analytic gradient under test.
              fc.pre(Math.abs(numeric - halfStep) < 1e-5);
              expect(Math.abs(numeric - analytic.gradient[j])).toBeLessThan(2e-5);
            }
          }
        }),
        { numRuns: 60, seed: 9510 + N },
      );
    });
  }
});

describe("registered morph method", () => {
  it("describes every schema node and registers sensible defaults", () => {
    const check = (schema: typeof morphMethod.schema) => {
      expect(schema.title).toBeTruthy();
      expect(schema.description).toBeTruthy();
      Object.values(schema.properties ?? {}).forEach(check);
      if (schema.items) check(schema.items);
    };
    check(morphMethod.schema);
  });

  it("returns exactly P strict pieces and never worsens a valid start across random shapes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...codes),
        fc.constantFrom(...codes),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 10000 }),
        async (N, M, P, seed) => {
          const problem = { N, M, P };
          const start = scatter(problem, seededRandom(seed));
          const result = await run(problem, { method: "morph", start, seed, budget: { evals: 80 } });
          expect(result.valid, result.reasons.join("; ")).toBe(true);
          expect(result.best!.pieces).toHaveLength(P);
          expect(result.score!).toBeLessThanOrEqual(evaluate(start, { autoOrient: true }).score! + 1e-12);
          expect(minimumSeparation(result.best!)).toBeGreaterThanOrEqual(-1e-12);
          expect(findOverlaps(N, result.best!.pieces, 1e-12)).toEqual([]);
          const container = enclose(N, result.best!.pieces, M, result.best!.container_phi);
          expect(
            Math.max(...result.best!.pieces.flatMap((p) => containerProtrusions(N, p, container).map((v) => v.depth))),
          ).toBeLessThan(1e-10);
          expect(result.evaluations).toBeLessThanOrEqual(80);
        },
      ),
      { numRuns: 36, seed: 9601 },
    );
  }, 30000);

  it("is deterministic for both families, local methods, and the square superellipse path", async () => {
    for (const params of [{}, { family: "circumscribed" }, { localMethod: "mc_compress" }, { path: "superellipse" }]) {
      const problem = { N: 4, M: 0, P: 5 };
      const options = { method: "morph", params, seed: 89, budget: { evals: 100 }, finalPolish: false };
      const first = await run(problem, options);
      const second = await run(problem, options);
      expect(first.valid).toBe(true);
      expect(first.best).toEqual(second.best);
      expect(first.score).toBe(second.score);
      expect(first.evaluations).toBe(second.evaluations);
    }
  });

  it("repairs overlapping and incomplete starts with small budgets, without a duplicate seed assessment", async () => {
    for (const N of codes) {
      const problem = { N, M: 4, P: 5 };
      const start = {
        ...problem,
        container_phi: 0,
        pieces: Array.from({ length: 5 }, () => ({ x: 0, y: 0, theta: 0 })),
      };
      for (const budget of [3, 6, 12]) {
        const result = await run(problem, { method: "morph", start, seed: 5, budget: { evals: budget } });
        expect(result.valid).toBe(true);
        expect(result.best!.pieces).toHaveLength(5);
        expect(result.evaluations).toBeLessThanOrEqual(budget);
        expect(minimumSeparation(result.best!)).toBeGreaterThanOrEqual(-1e-12);
      }
      const incomplete = await run(problem, {
        method: "morph",
        start: { ...start, pieces: start.pieces.slice(1) },
        seed: 5,
        budget: { evals: 12 },
      });
      expect(incomplete.valid).toBe(true);
      expect(incomplete.best!.pieces).toHaveLength(5);
    }
  });

  it("submits only non-overlapping distinct true-shape candidates and counts exactly its assessments", async () => {
    const problem = { N: 4, M: 4, P: 5 };
    const start = scatter(problem, seededRandom(1));
    const keys = new Set([JSON.stringify([start.pieces, start.container_phi])]);
    let count = 1;
    const ctx: MethodContext = {
      problem,
      start,
      starts: [],
      initialEvaluation: evaluate(start),
      params: morphMethod.defaults,
      random: seededRandom(3),
      shouldStop: () => count >= 40,
      remaining: () => ({ evals: 40 - count, time_s: Infinity }),
      checkpoint: async () => count < 40,
      run: async () => {
        throw new Error("unexpected nested local solve");
      },
      emit: async () => {
        throw new Error("unexpected emission");
      },
      evaluate: async (candidate, options) => {
        const key = JSON.stringify([candidate.pieces, candidate.container_phi]);
        expect(keys.has(key)).toBe(false);
        keys.add(key);
        expect(findOverlaps(candidate.N, candidate.pieces, 0)).toEqual([]);
        count++;
        return evaluate(candidate, options);
      },
    };
    await morphMethod.execute(ctx);
    expect(count).toBe(keys.size);
    expect(count).toBe(40);
  });

  it("does not reassess a circle state when only ignored angles change", async () => {
    const problem = { N: 0, M: 0, P: 1 };
    const start: PackingConfig = { ...problem, container_phi: 0.71, pieces: [{ x: 0, y: 0, theta: 0.37 }] };
    let assessments = 0;
    const ctx: MethodContext = {
      problem,
      start,
      starts: [],
      initialEvaluation: evaluate(start),
      params: { ...morphMethod.defaults, jitter: 0 },
      random: seededRandom(3),
      shouldStop: () => false,
      remaining: () => ({ evals: 40, time_s: Infinity }),
      checkpoint: async () => true,
      run: async () => {
        throw new Error("unexpected seed");
      },
      emit: async () => {
        throw new Error("unexpected emission");
      },
      evaluate: async (candidate, options) => {
        assessments++;
        return evaluate(candidate, options);
      },
    };
    await morphMethod.execute(ctx);
    expect(assessments).toBe(0);
  });

  it("stops within one second of a timer abort and retains a valid packing", async () => {
    const control = { aborted: false };
    const problem = { N: 8, M: 8, P: 20 };
    let abortAt = 0;
    const timer = setTimeout(() => {
      abortAt = performance.now();
      control.aborted = true;
    }, 30);
    try {
      const result = await run(problem, {
        method: "morph",
        start: scatter(problem, seededRandom(33)),
        seed: 33,
        budget: { evals: 100000 },
        control,
        params: { stages: 64, innerIterations: 2000, outerIterations: 30 },
      });
      expect(abortAt).toBeGreaterThan(0);
      expect(performance.now() - abortAt).toBeLessThan(1000);
      expect(result.termination).toBe("aborted");
      expect(result.valid).toBe(true);
      expect(minimumSeparation(result.best!)).toBeGreaterThanOrEqual(-1e-12);
    } finally {
      clearTimeout(timer);
    }
  });
});
