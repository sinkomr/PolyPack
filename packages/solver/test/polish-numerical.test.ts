import { describe, expect, it } from "vitest";
import { evaluate, pieceSeparation, type PackingConfig } from "@polypack/geometry";
import { contactResiduals, identifyContacts, polish } from "../src/polish";
import { seededRandom } from "../src/framework";

function squares(expansion = 1): PackingConfig {
  const d = ((1 + Math.SQRT1_2) / 2) * expansion;
  return {
    N: 4,
    M: 4,
    P: 5,
    container_phi: 0,
    pieces: [
      { x: 0, y: 0, theta: 0 },
      ...[
        [-d, -d],
        [d, -d],
        [-d, d],
        [d, d],
      ].map(([x, y]) => ({ x, y, theta: Math.PI / 4 })),
    ],
  };
}

function circles(expansion: number): PackingConfig {
  return {
    N: 0,
    M: 0,
    P: 7,
    container_phi: 0,
    pieces: [
      { x: 0, y: 0, theta: 0 },
      ...Array.from({ length: 6 }, (_, k) => ({
        x: 2 * expansion * Math.cos((k * Math.PI) / 3),
        y: 2 * expansion * Math.sin((k * Math.PI) / 3),
        theta: 0,
      })),
    ],
  };
}

function strictGeometry(config: PackingConfig): number {
  const result = evaluate(config, { autoOrient: true });
  expect(result.valid).toBe(true);
  for (let i = 0; i < config.P; i++)
    for (let j = i + 1; j < config.P; j++) {
      expect(pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep).toBeGreaterThanOrEqual(-1e-12);
    }
  const walls = identifyContacts(config, result.container!, Infinity).filter((c) => c.kind !== "pair");
  expect(Math.min(...contactResiduals(config, result.container!, walls))).toBeGreaterThanOrEqual(-1e-12);
  expect(evaluate(config).score).toBe(result.score);
  return result.score!;
}

describe("polish precision and numerical work", () => {
  it("recovers a jittered five-square packing to 1e-9 with strict separation", async () => {
    const start = squares(1.03);
    const random = seededRandom(2);
    const jitter = () => 0.02 * (random() - 0.5);
    start.pieces = start.pieces.map((p) => ({ x: p.x + jitter(), y: p.y + jitter(), theta: p.theta + jitter() }));
    const out = await polish(start);
    expect(out).toBeDefined();
    expect(Math.abs(strictGeometry(out!) - (2 + Math.SQRT1_2))).toBeLessThan(1e-9);
  });

  it("compresses disconnected seven-circle and two-circle starts", async () => {
    expect(Math.abs(strictGeometry((await polish(circles(1.5)))!) - 3)).toBeLessThan(1e-8);
    const two: PackingConfig = {
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: -5, y: 0, theta: 0 },
        { x: 5, y: 0, theta: 0 },
      ],
    };
    expect(Math.abs(strictGeometry((await polish(two))!) - 2)).toBeLessThan(1e-9);
  });

  it("does not exploit touching tolerance on three triangles in a triangle", async () => {
    // Three corner unit triangles fit an enclosing triangle of side two.
    const start: PackingConfig = {
      N: 3,
      M: 3,
      P: 3,
      container_phi: 0,
      pieces: [
        [0, Math.sqrt(3) / 3],
        [-0.5, -Math.sqrt(3) / 6],
        [0.5, -Math.sqrt(3) / 6],
      ].map(([x, y]) => ({ x: x * 1.02, y: y * 1.02, theta: 0 })),
    };
    const score = strictGeometry((await polish(start))!);
    expect(score).toBeGreaterThanOrEqual(2 - 1e-11);
    expect(score).toBeLessThan(2 + 1e-9);
  });

  it("retains an exact two-circle optimum and never assesses a tolerance gain", async () => {
    const start: PackingConfig = {
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: -1, y: 0, theta: 0 },
        { x: 1, y: 0, theta: 0 },
      ],
    };
    const out = await polish(start, {
      evaluate: async (config, options) => {
        const result = evaluate(config, options);
        expect(result.score).toBeGreaterThanOrEqual(2);
        return result;
      },
    });
    expect(out).toEqual(start);
    expect(strictGeometry(out!)).toBe(2);
  });

  it("does not return a fallback that only passes the server's touching tolerance", async () => {
    const start: PackingConfig = {
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: 0, y: 0, theta: 0 },
        { x: 2 - 9e-10, y: 0, theta: 0 },
      ],
    };
    expect(evaluate(start).valid).toBe(true);
    expect(await polish(start, { maxIterations: 0 })).toBeUndefined();
    // Separating these circles cannot preserve their falsely low original score.
    expect(await polish(start)).toBeUndefined();
  });

  it("caps maxIterations at 300 and gives it precedence over the old alias", async () => {
    const start = squares(1.03);
    expect(await polish(start, { maxIterations: 1e9 })).toEqual(await polish(start, { maxIterations: 300 }));
    const out = await polish(start, { maxIterations: 0, iterations: 300 });
    expect(out).toEqual(start);
    for (const value of [NaN, Infinity, -1])
      await expect(polish(start, { maxIterations: value })).rejects.toThrow(RangeError);
  });

  it("checks synchronous stop inside a phase without awaiting inner checkpoints", async () => {
    const start = circles(1.02);
    let assessments = 0,
      phases = 0,
      checks = 0;
    const out = await polish(start, {
      checkpoint: async () => {
        phases++;
        return true;
      },
      shouldStop: () => ++checks === 100,
      evaluate: async (config, options) => {
        assessments++;
        return evaluate(config, options);
      },
    });
    expect(out).toEqual(start);
    expect(phases).toBe(2);
    expect(assessments).toBe(1);
    expect(checks).toBe(100);
  });

  it("reuses a supplied initial assessment and requests fixed phi in numerical phases", async () => {
    const start = squares(1.02);
    let assessments = 0;
    expect(
      await polish(start, {
        maxIterations: 0,
        initialEvaluation: evaluate(start, { autoOrient: true }),
        evaluate: async () => {
          assessments++;
          return undefined;
        },
      }),
    ).toEqual(start);
    expect(assessments).toBe(0);
    const orientationModes: boolean[] = [];
    await polish(start, {
      maxIterations: 1,
      evaluate: async (config, options) => {
        orientationModes.push(options?.autoOrient ?? false);
        return evaluate(config, options);
      },
    });
    expect(orientationModes[0]).toBe(true);
    expect(orientationModes.slice(1, -1).every((autoOrient) => !autoOrient)).toBe(true);
    expect(orientationModes.at(-1)).toBe(true);
  });
});
