import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { boundingRadius, evaluate, type PackingConfig } from "@polypack/geometry";
import { MethodRegistry, type MethodContext } from "../src/framework";
import { polish } from "../src/polish";
import { run } from "../src/index";

const problem = { N: 0, M: 0, P: 2 };
const validStart = (): PackingConfig => ({
  ...problem,
  container_phi: 0,
  pieces: [
    { x: -1, y: 0, theta: 0 },
    { x: 1, y: 0, theta: 0 },
  ],
});

function registry(execute: (context: MethodContext) => Promise<void>): MethodRegistry {
  const methods = new MethodRegistry();
  methods.register({
    name: "probe",
    schema: { type: "object", additionalProperties: false },
    defaults: {},
    doc: "docs/methods/probe.md",
    execute,
  });
  return methods;
}

describe("adversarial framework contracts", () => {
  it("rejects concurrent evaluations while preserving the evaluated start", async () => {
    const methods = registry(async (context) => {
      await Promise.all(Array.from({ length: 20 }, () => context.evaluate(validStart())));
    });
    const result = await methods.run(problem, {
      method: "probe",
      start: validStart(),
      budget: { evals: 3 },
      seed: 1,
      finalPolish: false,
    });
    expect(result.evaluations).toBeLessThanOrEqual(3);
    expect(result.termination).toBe("error");
    expect(result.reasons.join()).toMatch(/sequential/);
    expect(result.best).toEqual(validStart());
  });

  it("returns repeatable errors for concurrent evaluation requests", async () => {
    const methods = registry(async (context) => {
      await Promise.all(Array.from({ length: 40 }, () => context.evaluate(validStart())));
    });
    const options = { method: "probe", start: validStart(), budget: { evals: 16 }, seed: 1, finalPolish: false };
    const first = await methods.run(problem, options);
    const second = await methods.run(problem, options);
    expect(first.termination).toBe("error");
    expect(first.best).toEqual(second.best);
    expect(first.score).toBe(second.score);
  });

  it("snapshots requests before an awaiting method can mutate their configuration", async () => {
    const methods = registry(async (context) => {
      const candidate = validStart();
      const assessment = context.evaluate(candidate);
      candidate.pieces[1].x = candidate.pieces[0].x;
      await assessment;
    });
    const result = await methods.run(problem, { method: "probe", budget: { evals: 5 }, seed: 1 });
    expect(result.best).toEqual(validStart());
    expect(result.valid).toBe(true);
  });

  it("snapshots a candidate before a paused evaluation yields", async () => {
    const control = { paused: true, aborted: false };
    const methods = registry(async (context) => {
      const candidate = validStart();
      const assessment = context.evaluate(candidate);
      candidate.pieces[1].x = candidate.pieces[0].x;
      await assessment;
    });
    setTimeout(() => {
      control.paused = false;
    }, 25);
    const result = await methods.run(problem, {
      method: "probe",
      budget: { evals: 5 },
      seed: 1,
      control,
      finalPolish: false,
    });
    expect(result.best).toEqual(validStart());
    expect(result.valid).toBe(true);
  });

  it("does not let methods or progress callbacks corrupt a saved best", async () => {
    const start = validStart();
    const methods = registry(async (context) => {
      const candidate = validStart();
      await context.evaluate(candidate);
      candidate.pieces[1].x = candidate.pieces[0].x;
      if (context.start) context.start.pieces[0].x = 100;
    });
    const result = await methods.run(problem, {
      method: "probe",
      start,
      budget: { evals: 5 },
      seed: 1,
      onProgress: (frame) => {
        frame.config!.pieces[1].x = frame.config!.pieces[0].x;
      },
    });
    expect(result.best).toEqual(validStart());
    expect(start).toEqual(validStart());
    expect(evaluate(result.best!, { autoOrient: true }).valid).toBe(true);
  });

  it("leaves absent best and explicit reasons when only invalid candidates were seen", async () => {
    const methods = registry(async (context) => {
      const invalid = validStart();
      invalid.pieces[1].x = -1;
      await context.evaluate(invalid);
      await context.evaluate({ ...validStart(), pieces: [] });
    });
    const result = await methods.run(problem, { method: "probe", budget: { evals: 10 }, seed: 1 });
    expect(result.valid).toBe(false);
    expect(result.best).toBeUndefined();
    expect(result.score).toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.trace).toEqual([]);
  });

  it("validates every pipeline stage before executing any stage", async () => {
    let executed = 0;
    const methods = registry(async () => {
      executed++;
    });
    await expect(
      methods.runPipeline(
        problem,
        { stages: [{ method: "probe" }, { method: "missing" }] },
        { budget: { evals: 10 }, seed: 1 },
      ),
    ).rejects.toThrow("unknown method");
    expect(executed).toBe(0);
  });

  it("counts wrong-problem and nonfinite candidates as invalid without losing best", async () => {
    for (const candidate of [
      { ...validStart(), M: 4 },
      {
        ...validStart(),
        pieces: [
          { x: NaN, y: 0, theta: 0 },
          { x: 1, y: 0, theta: 0 },
        ],
      },
    ]) {
      const methods = registry(async (context) => {
        await context.evaluate(candidate);
      });
      const result = await methods.run(problem, {
        method: "probe",
        start: validStart(),
        budget: { evals: 10 },
        seed: 1,
        finalPolish: false,
      });
      expect(result.evaluations).toBe(2);
      expect(result.termination).toBe("completed");
      expect(result.best).toEqual(validStart());
    }
  });

  it("keeps registry metadata and nested defaults isolated across runs", async () => {
    const methods = new MethodRegistry();
    const defaults = { nested: { value: 2 } };
    const values: unknown[] = [];
    methods.register({
      name: "probe",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          nested: {
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        },
        required: ["nested"],
      },
      defaults,
      doc: "docs/methods/probe.md",
      execute: async (context) => {
        values.push((context.params.nested as { value: number }).value);
        (context.params.nested as { value: number }).value = 9;
      },
    });
    defaults.nested.value = 100;
    const metadata = methods.list();
    (metadata[0].defaults.nested as { value: number }).value = 200;
    metadata[0].schema.properties!.nested.properties!.value.type = "string";
    const first = await methods.run(problem, { method: "probe", budget: { evals: 10 }, seed: 1 });
    const second = await methods.run(problem, { method: "probe", budget: { evals: 10 }, seed: 1 });
    expect(values).toEqual([2, 2]);
    expect(first.params).toEqual({ nested: { value: 2 } });
    expect(second.params).toEqual(first.params);
  });

  it("fills missing nested fields without replacing caller-supplied values", async () => {
    const methods = new MethodRegistry();
    methods.register({
      name: "probe",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          nested: {
            type: "object",
            additionalProperties: false,
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
        required: ["nested"],
      },
      defaults: { nested: { a: 1, b: 2 } },
      doc: "docs/methods/probe.md",
      execute: async () => {},
    });
    const result = await methods.run(problem, {
      method: "probe",
      params: { nested: { a: 3 } },
      budget: { evals: 10 },
      seed: 1,
    });
    expect(result.params).toEqual({ nested: { a: 3, b: 2 } });
  });
});

describe("adversarial polish contracts", () => {
  it("reproduces registered polish output bit for bit with an evaluation budget", async () => {
    const start: PackingConfig = {
      N: 0,
      M: 0,
      P: 7,
      container_phi: 0,
      pieces: [
        { x: 0, y: 0, theta: 0 },
        ...Array.from({ length: 6 }, (_, i) => ({
          x: 2.04 * Math.cos((i * Math.PI) / 3),
          y: 2.04 * Math.sin((i * Math.PI) / 3),
          theta: 0,
        })),
      ],
    };
    const options = { method: "polish", start, budget: { evals: 10 }, seed: 17 };
    const first = await run(start, options);
    const second = await run(start, options);
    expect(JSON.stringify(first.best)).toBe(JSON.stringify(second.best));
    expect(first.score).toBe(second.score);
    expect(first.evaluations).toBe(second.evaluations);
    expect(first.trace.map(([, score]) => score)).toEqual(second.trace.map(([, score]) => score));
    expect(first.valid).toBe(true);
  });

  it("preserves poses and records scoring orientation when no steps are requested", async () => {
    const start: PackingConfig = { N: 4, M: 4, P: 1, container_phi: 0, pieces: [{ x: 0, y: 0, theta: 0.123 }] };
    const result = await polish(start, { maxIterations: 0 });
    expect(result!.pieces).toEqual(start.pieces);
    expect(evaluate(result!).score).toBe(evaluate(start, { autoOrient: true }).score);
  });

  it("preserves validity and never worsens sparse random packings with P at most 30", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 8),
        fc.constantFrom(0, 3, 4, 6),
        fc.integer({ min: 1, max: 30 }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        async (N, M, P, theta) => {
          const spacing = 2 * boundingRadius(N) + 1;
          const start: PackingConfig = {
            N,
            M,
            P,
            container_phi: 0.4,
            pieces: Array.from({ length: P }, (_, i) => ({
              x: spacing * (i % 6),
              y: spacing * Math.floor(i / 6),
              theta,
            })),
          };
          const before = evaluate(start, { autoOrient: true });
          const result = await polish(start, { iterations: 1 });
          expect(before.valid).toBe(true);
          expect(result).toBeDefined();
          const after = evaluate(result!, { autoOrient: true });
          expect(after.valid).toBe(true);
          expect(after.score!).toBeLessThanOrEqual(before.score!);
        },
      ),
      { numRuns: 15, seed: 20261008 },
    );
  });

  it("does not return overlapping input when no valid repair was established", async () => {
    const start = validStart();
    start.pieces[1].x = start.pieces[0].x;
    expect(await polish(start, { iterations: 0 })).toBeUndefined();
  });
});
