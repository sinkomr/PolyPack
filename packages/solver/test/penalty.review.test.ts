// Independent review of the penalty / augmented Lagrangian method (written by a reviewer, not the author).
// Tests marked "// DEFECT:" fail on the reviewed commit and describe a real problem; all others pass.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  boundingRadius,
  containerProtrusions,
  evaluate,
  pieceSeparation,
  type Container,
  type PackingConfig,
} from "@polypack/geometry";
import { run, seededRandom } from "../src/index";
import { lbfgs, type ObjectiveValue } from "../src/methods/penalty/lbfgs";
import { createPenaltyObjective, nearbyPairs, packState } from "../src/methods/penalty/objective";
import { restore, scatter } from "../src/methods/penalty/restoration";

const KINDS: [number, number][] = [
  [0, 0],
  [0, 3],
  [0, 7],
  [3, 0],
  [5, 0],
  [12, 0],
  [3, 3],
  [4, 4],
  [5, 5],
  [4, 3],
  [3, 8],
  [7, 5],
  [12, 12],
  [5, 12],
  [12, 5],
];

/** A dense random state with overlaps and protrusions, so that many penalty terms are active. */
function randomState(N: number, M: number, random: () => number) {
  const P = 2 + Math.floor(9 * random());
  const spread = boundingRadius(N) * Math.sqrt(P) * (0.5 + 0.7 * random());
  const u = () => (2 * random() - 1) * spread;
  const config: PackingConfig = {
    N,
    M,
    P,
    container_phi: 0,
    pieces: Array.from({ length: P }, () => ({ x: u(), y: u(), theta: N === 0 ? 0 : 8 * random() - 4 })),
  };
  const container: Container = {
    M,
    cx: 0.6 * random() - 0.3,
    cy: 0.6 * random() - 0.3,
    size: (M === 0 ? 1 : 2) * spread * (0.6 + 0.7 * random()),
    phi: M === 0 ? 0 : 6 * random() - 3,
  };
  return { config, container, P };
}

/** Loose valid grid with random angles; `offset` translates the whole arrangement. */
function looseStart(N: number, M: number, P: number, seed: number, offset = 0): PackingConfig {
  const random = seededRandom(seed);
  const pitch = 2.6 * boundingRadius(N);
  const width = Math.ceil(Math.sqrt(P));
  return {
    N,
    M,
    P,
    container_phi: 0,
    pieces: Array.from({ length: P }, (_, i) => ({
      x: offset + pitch * (i % width) + 0.1 * random(),
      y: offset + pitch * Math.floor(i / width) + 0.1 * random(),
      theta: N === 0 ? 0 : 6 * random(),
    })),
  };
}

describe("review: penalty objective", () => {
  it("equals a brute-force all-pairs sum and matches finite differences, for both schedules and all kinds", () => {
    const random = seededRandom(4242);
    let checked = 0;
    for (const [N, M] of KINDS) {
      for (const augmented of [false, true]) {
        for (let t = 0; t < 4; t++) {
          const { config, container, P } = randomState(N, M, random);
          const weight = 1 + 199 * random();
          const multipliers = new Map<string, number>();
          if (augmented) {
            // Includes multipliers on separated pairs beyond the grid reach and on inactive walls.
            const walls = (N === 0 ? 1 : N) * (M === 0 ? 1 : M);
            for (let i = 0; i < P; i++) {
              for (let j = i + 1; j < P; j++) if (random() < 0.5) multipliers.set(`p:${i}:${j}`, 30 * random());
              for (let k = 0; k < walls; k++) if (random() < 0.3) multipliers.set(`w:${i}:${k}`, 30 * random());
            }
          }
          const lambda = (key: string) => (augmented ? (multipliers.get(key) ?? 0) : 0);
          const term = (l: number, depth: number) => (Math.max(0, l + 2 * weight * depth) ** 2 - l * l) / (4 * weight);
          let expected = container.size;
          for (let i = 0; i < P; i++) {
            for (let j = i + 1; j < P; j++)
              expected += term(lambda(`p:${i}:${j}`), -pieceSeparation(N, config.pieces[i], config.pieces[j]).sep);
            containerProtrusions(N, config.pieces[i], container).forEach(
              (w, k) => (expected += term(lambda(`w:${i}:${k}`), w.depth)),
            );
          }
          const objective = createPenaltyObjective(config, weight, multipliers, augmented);
          const x = packState({ config, container });
          const base = objective.evaluate(x);
          expect(Math.abs(base.value - expected)).toBeLessThan(1e-9 * (1 + Math.abs(expected)));
          expect(base.gradient).toHaveLength(x.length);
          for (let k = 0; k < x.length; k++) {
            const at = (d: number) => objective.evaluate(x.map((v, i) => (i === k ? v + d : v))).value;
            const h = 1e-6;
            const numeric = (at(h) - at(-h)) / (2 * h);
            const half = (at(h / 2) - at(-h / 2)) / h;
            // A SAT feature switch inside the stencil makes the two estimates disagree; skip those.
            if (Math.abs(numeric - half) > 1e-5 * (1 + Math.abs(numeric))) continue;
            if (Math.abs(numeric - base.gradient[k]) > 2e-5 * (1 + Math.abs(numeric)))
              throw new Error(
                `N=${N} M=${M} augmented=${augmented} variable ${k}/${x.length}: ${numeric} vs ${base.gradient[k]}`,
              );
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it("neighbour grid never misses a pair within reach, for any coordinates including cell boundaries", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.oneof(fc.double({ min: -6, max: 6, noNaN: true }), fc.integer({ min: -4, max: 4 })),
            fc.oneof(fc.double({ min: -6, max: 6, noNaN: true }), fc.integer({ min: -4, max: 4 })),
          ),
          { minLength: 2, maxLength: 40 },
        ),
        fc.constantFrom(1, 2, Math.SQRT2, 0.5),
        fc.constantFrom(0, 1e5, -4.9e5),
        (points, reach, offset) => {
          const poses = points.map(([x, y]) => ({ x: x * reach + offset, y: y * reach - offset, theta: 0 }));
          const got = new Set(nearbyPairs(poses, reach, () => false).map(([i, j]) => `${i}:${j}`));
          let within = 0;
          for (let i = 0; i < poses.length; i++) {
            for (let j = i + 1; j < poses.length; j++) {
              const distance = Math.hypot(poses[j].x - poses[i].x, poses[j].y - poses[i].y);
              if (distance <= reach) within++;
              // A pair whose rounded distance equals the reach exactly can sit two cells apart and be
              // skipped (found by fast-check: y = 1 and y = -5e-324). Its bounding circles only touch,
              // so its depth is zero to rounding and the omission is harmless; require the rest.
              if (distance < reach * (1 - 1e-12)) expect(got.has(`${i}:${j}`)).toBe(true);
            }
          }
          expect(got.size).toBeLessThanOrEqual(within);
        },
      ),
      { numRuns: 400, seed: 7 },
    );
  });

  it("multiplier updates turn a biased quadratic solution into a feasible one at constant weight", async () => {
    // With growthFactor 1 the quadratic schedule keeps a fixed overlap bias of order 1/weight,
    // while the augmented schedule removes it. This is the evidence that the multipliers act.
    // The scatter start is named explicitly: the default seed start is already at r = 3 for seven circles.
    const options = { budget: { evals: 3000 }, seed: 1, finalPolish: false };
    const quadratic = await run(
      { N: 0, M: 0, P: 7 },
      { ...options, method: "penalty", params: { schedule: "quadratic", growthFactor: 1, start: "scatter" } },
    );
    const augmented = await run(
      { N: 0, M: 0, P: 7 },
      { ...options, method: "penalty", params: { schedule: "augmented", growthFactor: 1, start: "scatter" } },
    );
    expect(augmented.score! - 3).toBeLessThan(1e-8);
    expect(quadratic.score! - 3).toBeGreaterThan(1e-4);
  });
});

describe("review: L-BFGS line search", () => {
  const cases: [string, (x: readonly number[]) => ObjectiveValue, number[]][] = [
    [
      "l1",
      (x) => ({ value: Math.abs(x[0]) + 10 * Math.abs(x[1]), gradient: [Math.sign(x[0]), 10 * Math.sign(x[1])] }),
      [3.3, 1.7],
    ],
    [
      "kinked valley",
      (x) => ({
        value: Math.abs(x[0] - x[1]) + 0.01 * (x[0] ** 2 + x[1] ** 2),
        gradient: [Math.sign(x[0] - x[1]) + 0.02 * x[0], -Math.sign(x[0] - x[1]) + 0.02 * x[1]],
      }),
      [5, 2],
    ],
    ["ascent gradient", (x) => ({ value: x[0] * x[0], gradient: [-2 * x[0]] }), [1]],
    [
      "concave with a wall",
      (x) => ({ value: Math.abs(x[0]) > 10 ? Infinity : -x[0] * x[0], gradient: [-2 * x[0]] }),
      [1],
    ],
    ["not a number", () => ({ value: NaN, gradient: [NaN] }), [1]],
  ];
  for (const [name, f, start] of cases) {
    it(`terminates, never increases the value and never accepts a nonfinite point: ${name}`, async () => {
      let calls = 0;
      let previous = f(start).value;
      const result = await lbfgs((x) => (calls++, f(x)), start, {
        iterations: 300,
        memory: 8,
        tolerance: 1e-8,
        onIteration: async (x) => {
          const value = f(x).value;
          expect(value).toBeLessThan(previous);
          previous = value;
          return true;
        },
      });
      expect(calls).toBeLessThan(300 * 49 + 2);
      expect(result.x.every(Number.isFinite)).toBe(true);
      if (name !== "not a number") expect(result.value).toBeLessThanOrEqual(f(start).value);
      else expect(result.status).toBe("nonfinite");
    });
  }
});

describe("review: restoration", () => {
  it("returns either nothing or a configuration the shared geometry accepts, for dense random overlaps", () => {
    const random = seededRandom(77);
    for (const strategy of ["separate", "expand"] as const) {
      let restored = 0;
      for (let t = 0; t < 400; t++) {
        const N = [0, 3, 4, 5, 6, 8, 12, 30][t % 8];
        const P = 2 + Math.floor(29 * random());
        const side = boundingRadius(N) * Math.sqrt(P) * (0.2 + 1.6 * random());
        const pieces = Array.from({ length: P }, () => ({
          x: (random() - 0.5) * side,
          y: (random() - 0.5) * side,
          theta: N === 0 ? 0 : 7 * random() - 3,
        }));
        if (t % 10 === 0) pieces[1] = { ...pieces[0] };
        const out = restore({ N, M: 4, P, pieces, container_phi: 0 }, strategy, () => false);
        if (!out) continue;
        restored++;
        expect(out.pieces).toHaveLength(P);
        expect(evaluate(out, { autoOrient: false }).valid).toBe(true);
      }
      expect(restored).toBeGreaterThan(300);
    }
  });
});

describe("review: registered method, safety", () => {
  it("is valid, never worse than a valid start, within budget and reproducible for awkward problems", async () => {
    const problems: [number, number, number][] = [
      [0, 3, 1],
      [3, 0, 2],
      [4, 4, 1],
      [20, 5, 2],
      [5, 20, 3],
      [24, 24, 2],
      [0, 3, 6],
      [7, 0, 9],
    ];
    for (const [N, M, P] of problems) {
      for (const start of [undefined, looseStart(N, M, P, 3), looseStart(N, M, P, 4, 1e5)]) {
        for (const evals of [2, 5, 150]) {
          const options = { method: "penalty", start, budget: { evals }, seed: 11 };
          const result = await run({ N, M, P }, options);
          expect(result.termination).not.toBe("error");
          expect(result.evaluations).toBeLessThanOrEqual(evals);
          expect(result.valid).toBe(true);
          const check = evaluate(result.best!, { autoOrient: false });
          expect(check.valid).toBe(true);
          expect(check.score).toBe(result.score);
          if (start) expect(result.score!).toBeLessThanOrEqual(evaluate(start, { autoOrient: true }).score!);
          const again = await run({ N, M, P }, options);
          expect(again.best).toEqual(result.best);
          expect(again.score).toBe(result.score);
          expect(again.evaluations).toBe(result.evaluations);
        }
      }
    }
  });

  it("survives every edge of the parameter schema and rejects values outside it", async () => {
    const start = looseStart(4, 4, 7, 5);
    const startScore = evaluate(start, { autoOrient: true }).score!;
    const edges: Record<string, unknown>[] = [
      { initialWeight: 5e-324 },
      { initialWeight: 1e308, growthFactor: 100 },
      { growthFactor: 1, schedule: "augmented" },
      { growthFactor: 100, outerIterations: 100 },
      { outerIterations: 1, innerIterations: 1 },
      { innerIterations: 10000, outerIterations: 100, memory: 100 },
      { memory: 1 },
      { gradientTolerance: 5e-324 },
      { gradientTolerance: 1e300 },
      { schedule: "quadratic", restoration: "expand" },
    ];
    for (const params of edges) {
      for (const given of [start, undefined]) {
        const result = await run(
          { N: 4, M: 4, P: 7 },
          { method: "penalty", params, start: given, budget: { evals: 200 }, seed: 3 },
        );
        expect(result.termination).not.toBe("error");
        expect(result.valid).toBe(true);
        expect(evaluate(result.best!, { autoOrient: false }).valid).toBe(true);
        expect(result.evaluations).toBeLessThanOrEqual(200);
        if (given) expect(result.score!).toBeLessThanOrEqual(startScore);
      }
    }
    for (const params of [
      { initialWeight: 0 },
      { growthFactor: 0.5 },
      { growthFactor: 101 },
      { outerIterations: 0 },
      { innerIterations: 1.5 },
      { memory: 0 },
      { gradientTolerance: 0 },
      { schedule: "linear" },
      { restoration: "shrink" },
      { unknown: 1 },
    ])
      await expect(
        run({ N: 4, M: 4, P: 7 }, { method: "penalty", params, budget: { evals: 10 }, seed: 3 }),
      ).rejects.toThrow();
  });

  it("repairs overlapping starts and stops within one second of an abort on a heavy problem", async () => {
    const overlapping = looseStart(5, 5, 9, 6);
    overlapping.pieces.forEach((p) => ((p.x *= 0.4), (p.y *= 0.4)));
    expect(evaluate(overlapping).valid).toBe(false);
    const repaired = await run(
      { N: 5, M: 5, P: 9 },
      { method: "penalty", start: overlapping, budget: { evals: 300 }, seed: 1 },
    );
    expect(repaired.valid).toBe(true);
    expect(evaluate(repaired.best!, { autoOrient: false }).valid).toBe(true);

    for (const [N, M, P] of [
      [50, 50, 30],
      [8, 8, 30],
      [0, 0, 30],
    ]) {
      const control = { aborted: false };
      let abortedAt = 0;
      setTimeout(() => {
        control.aborted = true;
        abortedAt = performance.now();
      }, 60);
      const result = await run({ N, M, P }, { method: "penalty", budget: { time_s: 20 }, seed: 2, control });
      expect(result.termination).toBe("aborted");
      expect(performance.now() - abortedAt).toBeLessThan(1000);
      expect(result.valid).toBe(true);
      expect(evaluate(result.best!, { autoOrient: false }).valid).toBe(true);
    }
  });

  it("keeps a time budget on a P = 30 octagon problem", async () => {
    const began = performance.now();
    const result = await run({ N: 8, M: 8, P: 30 }, { method: "penalty", budget: { time_s: 0.3 }, seed: 5 });
    expect(performance.now() - began).toBeLessThan(1300);
    expect(result.valid).toBe(true);
    expect(result.termination).toBe("time");
  });
});

describe("review: registered method, defects and limits", () => {
  it("optimises the same arrangement equally well wherever it sits inside the accepted coordinate range", async () => {
    // DEFECT: objective.ts:133 and restoration.ts:25 treat |coordinate| >= 5e5 as nonfinite, but starts are accepted up to 1e6; such a valid start makes the method return after one evaluation without optimising.
    const near = await run(
      { N: 0, M: 0, P: 7 },
      { method: "penalty", start: looseStart(0, 0, 7, 4), budget: { evals: 2000 }, seed: 1, finalPolish: false },
    );
    const far = await run(
      { N: 0, M: 0, P: 7 },
      { method: "penalty", start: looseStart(0, 0, 7, 4, 6e5), budget: { evals: 2000 }, seed: 1, finalPolish: false },
    );
    expect(near.score!).toBeLessThan(3.001);
    expect(far.stages[0].evaluations).toBeGreaterThan(1);
    expect(far.score!).toBeLessThan(3.001);
  });

  it("does not turn a start with coincident pieces into a straight line", async () => {
    // DEFECT: restoration.ts:35-41 pushes every coincident pair along the same fixed normal (1,0), giving an exactly collinear row; the method then returns 6.0 for six circles where no start at all gives 3.0.
    const coincident: PackingConfig = {
      N: 0,
      M: 0,
      P: 6,
      container_phi: 0,
      pieces: Array.from({ length: 6 }, () => ({ x: 0, y: 0, theta: 0 })),
    };
    const none = await run({ N: 0, M: 0, P: 6 }, { method: "penalty", budget: { evals: 3000 }, seed: 1 });
    const result = await run(
      { N: 0, M: 0, P: 6 },
      { method: "penalty", start: coincident, budget: { evals: 3000 }, seed: 1 },
    );
    expect(none.score!).toBeLessThan(3.001);
    expect(result.valid).toBe(true);
    expect(result.score!).toBeLessThan(3.5);
  });

  it("leaves an exactly collinear valid start, which is a saddle and not a local minimum", async () => {
    // DEFECT: penalty.ts never perturbs its start, so on a symmetric start (a row seed) the transverse gradient is exactly zero and the run converges to the tight row, 6.0 for six circles; a 1e-6 jitter reaches 3.0.
    const row = (jitter: number): PackingConfig => ({
      N: 0,
      M: 0,
      P: 6,
      container_phi: 0,
      pieces: Array.from({ length: 6 }, (_, i) => ({ x: 2.5 * i, y: jitter * (((i * 7919) % 5) - 2), theta: 0 })),
    });
    const options = { method: "penalty", budget: { evals: 3000 }, seed: 1 };
    const jittered = await run({ N: 0, M: 0, P: 6 }, { ...options, start: row(1e-6) });
    const exact = await run({ N: 0, M: 0, P: 6 }, { ...options, start: row(0) });
    expect(jittered.score!).toBeLessThan(3.001);
    expect(exact.score!).toBeLessThan(5.9);
  });

  it("measures throughput on a configuration that really has active pair penalties, as the doc page states", () => {
    // DEFECT: docs/methods/penalty.md:169 says contracting scatter(seed 1) by 0.7 ensures active pair penalties; for squares (pitch 2.4R*0.7 = 1.19 > 1) no pair overlaps, so the N = 4 throughput row measures no pair gradient work.
    for (const N of [0, 4, 8]) {
      const config = scatter({ N, M: N, P: 30 }, seededRandom(1));
      config.pieces.forEach((p) => ((p.x *= 0.7), (p.y *= 0.7)));
      expect(evaluate(config, { autoOrient: false }).overlaps.length).toBeGreaterThan(0);
    }
  });

  // Decision after the review: the aligned grid start caused squares to stop at 3.0, so the
  // built-in scatter now draws uniformly random angles. This replaces the test that recorded the old start.
  it("built-in scatter is valid and has spread-out piece angles", async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const start = scatter({ N: 4, M: 4, P: 5 }, seededRandom(seed));
      expect(evaluate(start).valid).toBe(true);
      // a square repeats every quarter turn; random angles must not all sit near the axis-aligned one
      const quarter = Math.PI / 2;
      const offsets = start.pieces.map((p) => {
        const r = (((p.theta - Math.PI / 4) % quarter) + quarter) % quarter;
        return Math.min(r, quarter - r);
      });
      expect(Math.max(...offsets)).toBeGreaterThan(0.1);
    }
  });
});
