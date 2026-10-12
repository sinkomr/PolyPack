import { evaluate, PackingConfig } from "@polypack/geometry";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MethodRegistry, ProgressFrame, run, runPipeline, seededRandom } from "../src";

const start: PackingConfig = {
  N: 0,
  M: 0,
  P: 2,
  pieces: [
    { x: -1.1, y: 0, theta: 0 },
    { x: 1.1, y: 0, theta: 0 },
  ],
  container_phi: 0,
};
const problem = { N: 0, M: 0, P: 2 };

describe("framework", () => {
  it("fills defaults and rejects invalid parameters and budgets", async () => {
    expect((await run(problem, { start, seed: 1, budget: { evals: 5 } })).params).toEqual({ iterations: 1 });
    for (const params of [{ iterations: 0 }, { iterations: 1.5 }, { typo: true }, { iterations: NaN }]) {
      await expect(run(problem, { start, params, seed: 1, budget: { evals: 5 } })).rejects.toThrow();
    }
    await expect(run(problem, { start, seed: 1, budget: {} })).rejects.toThrow();
    await expect(run(problem, { start, seed: 1, budget: { evals: -1 } })).rejects.toThrow();
    await expect(run(problem, { start, seed: 1, budget: { evals: 0 } })).rejects.toThrow();
  });
  it("enforces exact evaluation limits", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 60 }), async (evals) => {
        const result = await run(problem, {
          start,
          params: { iterations: 1000 },
          seed: 1,
          budget: { evals },
          finalPolish: false,
        });
        expect(result.evaluations).toBe(evals);
        expect(result.termination).toBe("evals");
        expect(evaluate(result.best!, { autoOrient: true }).score).toBe(result.score);
      }),
      { numRuns: 25 },
    );
  });
  it("enforces time budgets", async () => {
    const result = await run(problem, {
      start,
      params: { iterations: 1e9 },
      seed: 1,
      budget: { time_s: 0.04 },
      finalPolish: false,
    });
    expect(result.termination).toBe("time");
    expect(result.wallTime).toBeGreaterThanOrEqual(0.04);
    expect(result.wallTime).toBeLessThan(0.2);
    expect(result.valid).toBe(true);
  });
  it("returns a valid best within one second of stop", async () => {
    const controller = new AbortController();
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = performance.now();
      controller.abort();
    }, 25);
    const result = await run(problem, {
      start,
      params: { iterations: 1e9 },
      seed: 1,
      budget: { evals: 1e9 },
      signal: controller.signal,
    });
    expect(performance.now() - abortedAt).toBeLessThan(1000);
    expect(result.termination).toBe("aborted");
    expect(result.valid).toBe(true);
    expect(evaluate(result.best!).valid).toBe(true);
  });
  it("throttles progress independently of candidate frequency", async () => {
    const times: number[] = [];
    const frames: ProgressFrame[] = [];
    const result = await run(problem, {
      start,
      params: { iterations: 1e9 },
      seed: 1,
      budget: { time_s: 0.16 },
      finalPolish: false,
      onProgress(frame) {
        times.push(performance.now());
        frames.push(frame);
        frame.config!.pieces[0].x = 999;
      },
    });
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < times.length; i++)
      // the throttle is 50 ms; allow scheduling jitter on a loaded machine
      if (!frames[i].final) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(40);
    expect(frames.at(-1)!.final).toBe(true);
    expect(result.best!.pieces[0].x).toBe(-1.1);
  });
  it("does not turn invalid starts into valid results", async () => {
    const invalid = { ...start, pieces: [start.pieces[0], start.pieces[0]] };
    const result = await run(problem, { start: invalid, seed: 1, budget: { evals: 10 }, finalPolish: false });
    expect(result.valid).toBe(false);
    expect(result.best).toBeUndefined();
    expect(result.score).toBeNull();
    expect(result.reasons.join()).toMatch(/overlapping/);
    expect((await run(problem, { seed: 1, budget: { evals: 10 } })).valid).toBe(false);
  });
  it("chains previous best with one shared budget and stream", async () => {
    const result = await runPipeline(
      problem,
      { stages: [{ method: "identity" }, { method: "identity", params: { iterations: 100 } }] },
      { start, seed: 1, budget: { evals: 4 }, finalPolish: false },
    );
    expect(result.evaluations).toBe(4);
    expect(result.params).toEqual({
      stages: [
        { method: "identity", params: { iterations: 1 } },
        { method: "identity", params: { iterations: 100 } },
      ],
    });
    expect(result.valid).toBe(true);
  });
  it("gives seeded methods bit-identical optimization output", async () => {
    const registry = new MethodRegistry();
    registry.register({
      name: "probe",
      schema: { type: "object", additionalProperties: false },
      defaults: {},
      doc: "docs/methods/probe.md",
      async execute(ctx) {
        while (await ctx.checkpoint()) {
          const d = 1 + ctx.random() / 10;
          if (
            !(await ctx.evaluate({
              ...start,
              pieces: [
                { x: -d, y: 0, theta: 0 },
                { x: d, y: 0, theta: 0 },
              ],
            }))
          )
            break;
        }
      },
    });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 0xffffffff }), async (seed) => {
        const options = { method: "probe", start, seed, budget: { evals: 40 }, finalPolish: false };
        const a = await registry.run(problem, options);
        const b = await registry.run(problem, options);
        expect(JSON.stringify(a.best)).toBe(JSON.stringify(b.best));
        expect(a.score).toBe(b.score);
        expect(a.evaluations).toBe(b.evaluations);
        expect(a.trace.map(([, score]) => score)).toEqual(b.trace.map(([, score]) => score));
      }),
      { numRuns: 12 },
    );
    const a = seededRandom(42),
      b = seededRandom(42);
    expect(Array.from({ length: 50 }, a)).toEqual(Array.from({ length: 50 }, b));
  });
});
