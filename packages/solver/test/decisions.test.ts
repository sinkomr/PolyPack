import { evaluate, type PackingConfig } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import {
  MethodRegistry,
  registry,
  run,
  runPipeline,
  seededRandom,
  type MethodContext,
  type ProgressFrame,
} from "../src";

const problem = { N: 0, M: 0, P: 2 };
const pair = (half = 1.1): PackingConfig => ({
  ...problem,
  container_phi: 0,
  pieces: [
    { x: -half, y: 0, theta: 0 },
    { x: half, y: 0, theta: 0 },
  ],
});

function register(methods: MethodRegistry, name: string, execute: (context: MethodContext) => Promise<void>) {
  methods.register({ name, schema: { type: "object" }, defaults: {}, doc: `docs/methods/${name}.md`, execute });
}

function probe(execute: (context: MethodContext) => Promise<void>) {
  const methods = new MethodRegistry();
  register(methods, "probe", execute);
  return methods;
}

const options = { method: "probe", seed: 1, budget: { evals: 20 }, finalPolish: false };

describe("design decisions: evaluation and failures", () => {
  it("counts unparseable and wrong-problem candidates as invalid evaluations", async () => {
    const invalid: { valid: boolean; reasons: string[] }[] = [];
    const methods = probe(async (ctx) => {
      for (const candidate of [
        { ...pair(), N: 4 },
        { ...pair(), N: 2 },
        { ...pair(), M: 4 },
        { ...pair(), P: 3 },
        { ...pair(), pieces: [pair().pieces[0]] },
        { ...pair(), container_phi: Infinity },
        { ...pair(), pieces: [{ x: NaN, y: 0, theta: 0 }, pair().pieces[1]] },
        { ...pair(), pieces: [{ x: 2e6, y: 0, theta: 0 }, pair().pieces[1]] },
      ]) {
        invalid.push((await ctx.evaluate(candidate))!);
      }
    });
    const result = await methods.run(problem, { ...options, start: pair() });
    expect(result.evaluations).toBe(9);
    expect(result.valid).toBe(true);
    expect(result.termination).toBe("completed");
    for (const candidate of invalid) {
      expect(candidate.valid).toBe(false);
      expect(candidate.reasons.length).toBeGreaterThan(0);
    }
  });

  it("preserves best and records method errors even when a progress observer throws", async () => {
    const methods = probe(async (ctx) => {
      await ctx.evaluate(pair(1));
      throw new Error("contact factorization failed");
    });
    const result = await methods.run(problem, {
      ...options,
      start: pair(2),
      onProgress() {
        throw new Error("observer failed");
      },
    });
    expect(result.termination).toBe("error");
    expect(result.reasons.join()).toContain("contact factorization failed");
    expect(result.score).toBe(2);
    expect(evaluate(result.best!).valid).toBe(true);
  });

  it("evaluates a valid start first despite immediate stop or zero time", async () => {
    for (const stop of [{ signal: { aborted: true } }, { budget: { evals: 1, time_s: 0 } }]) {
      const result = await run(problem, { seed: 1, budget: { evals: 1 }, start: pair(), finalPolish: false, ...stop });
      expect(result.evaluations).toBe(1);
      expect(result.valid).toBe(true);
      expect(result.best).toEqual(pair());
    }
  });

  it("marks normal return at the exact evaluation limit completed", async () => {
    const methods = probe(async (ctx) => {
      await ctx.evaluate(pair(1));
    });
    const result = await methods.run(problem, { ...options, budget: { evals: 1 } });
    expect(result.evaluations).toBe(1);
    expect(result.termination).toBe("completed");
  });

  it("uses fixed orientation evaluations but finalizes the best at server orientation for free", async () => {
    const square: PackingConfig = {
      N: 4,
      M: 4,
      P: 1,
      container_phi: 0.2,
      pieces: [{ x: 0, y: 0, theta: 0.7 }],
    };
    let fixedScore: number | null | undefined;
    const methods = probe(async (ctx) => {
      fixedScore = (await ctx.evaluate(square, { autoOrient: false }))?.score;
    });
    const result = await methods.run(square, { ...options, budget: { evals: 1 } });
    expect(fixedScore).toBe(evaluate(square).score);
    expect(result.evaluations).toBe(1);
    expect(result.score).toBe(evaluate(square, { autoOrient: true }).score);
    expect(evaluate(result.best!).score).toBe(result.score);
    expect(result.container?.phi).toBe(result.best!.container_phi);
  });
});

describe("design decisions: stopping and snapshots", () => {
  it("waits while paused, excludes pause from the time budget, and exposes synchronous stop", async () => {
    const control = { paused: true, aborted: false };
    let visited = false;
    let initialStop: boolean | undefined;
    const methods = probe(async (ctx) => {
      initialStop = ctx.shouldStop();
      if (await ctx.checkpoint()) visited = true;
    });
    setTimeout(() => {
      control.paused = false;
    }, 70);
    const result = await methods.run(problem, {
      ...options,
      start: pair(),
      control,
      budget: { evals: 10, time_s: 0.03 },
    });
    expect(initialStop).toBe(false);
    expect(visited).toBe(true);
    expect(result.termination).toBe("completed");
    expect(result.valid).toBe(true);
  });

  it("aborts within one second while paused and retains its evaluated start", async () => {
    const control = { paused: true, aborted: false };
    const methods = probe(async (ctx) => {
      await ctx.checkpoint();
    });
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = performance.now();
      control.aborted = true;
    }, 30);
    const result = await methods.run(problem, { ...options, start: pair(), control });
    expect(abortedAt).toBeGreaterThan(0);
    expect(performance.now() - abortedAt).toBeLessThan(1000);
    expect(result.termination).toBe("aborted");
    expect(result.valid).toBe(true);
  });

  it("emits an unthrottled final frame with validity, container and stage", async () => {
    const frames: ProgressFrame[] = [];
    const methods = probe(async (ctx) => {
      await ctx.evaluate(pair(1));
    });
    const result = await methods.run(problem, { ...options, onProgress: (frame) => frames.push(frame) });
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const final = frames.at(-1)!;
    expect(final.valid).toBe(true);
    expect(final.container).toEqual(result.container);
    expect(final.stage).toEqual({ index: 0, method: "probe" });
    expect(final.evaluations).toBe(result.evaluations);
    expect(final.bestScore).toBe(result.score);
    expect(result.stages[0]).toMatchObject({ method: "probe", evaluations: 1, termination: "completed" });
  });

  it("thins long traces while retaining first and final scores and never mutates after resolution", async () => {
    const count = 4100;
    const methods = probe(async (ctx) => {
      for (let i = 0; i < count; i++) await ctx.evaluate(pair(2 - i / count));
    });
    const result = await methods.run(problem, { ...options, budget: { evals: count } });
    expect(result.trace.length).toBeLessThanOrEqual(2000);
    expect(result.trace[0][1]).toBe(3);
    expect(result.trace.at(-1)![1]).toBe(result.score);
    const snapshot = JSON.stringify(result);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(JSON.stringify(result)).toBe(snapshot);
  });
});

describe("design decisions: parameters and sequential calls", () => {
  it("rejects uint32 seed and integer-positive budget violations asynchronously", async () => {
    for (const seed of [-1, 2 ** 32, 1.2, Infinity, NaN]) {
      await expect(run(problem, { start: pair(), seed, budget: { evals: 1 } })).rejects.toThrow();
    }
    for (const evals of [0, -1, 1.2, Infinity, NaN]) {
      await expect(run(problem, { start: pair(), seed: 1, budget: { evals } })).rejects.toThrow();
    }
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = runPipeline(problem, { stages: [] }, { seed: 1, budget: { evals: 1 } });
    }).not.toThrow();
    await expect(pending).rejects.toThrow();
  });

  it("ignores undefined parameter entries and lists descriptive standard schema annotations", async () => {
    const result = await run(problem, {
      seed: 1,
      start: pair(),
      budget: { evals: 4 },
      params: { iterations: undefined },
      finalPolish: false,
    });
    expect(result.params.iterations).toBe(1);
    for (const method of registry.list()) {
      expect(method.schema.type).toBe("object");
      for (const schema of Object.values(method.schema.properties ?? {}))
        expect(schema.description).toEqual(expect.any(String));
    }
  });

  it("supports numeric exclusive bounds and annotations", async () => {
    const methods = new MethodRegistry();
    methods.register({
      name: "probe",
      doc: "docs/methods/probe.md",
      schema: {
        type: "object",
        title: "Contact method",
        description: "Uses a bounded scale",
        properties: {
          scale: {
            type: "number",
            default: 0.5,
            description: "Scale to use",
            exclusiveMinimum: 0,
            exclusiveMaximum: 1,
          },
        },
      },
      defaults: { scale: 0.5 },
      async execute() {},
    });
    await expect(methods.run(problem, { ...options, params: { scale: 0 } })).rejects.toThrow();
    await expect(methods.run(problem, { ...options, params: { scale: 1 } })).rejects.toThrow();
    expect((await methods.run(problem, options)).params).toEqual({ scale: 0.5 });
  });

  it("rejects concurrent framework calls with a preserved valid best", async () => {
    const methods = probe(async (ctx) => {
      await Promise.all([ctx.checkpoint(), ctx.evaluate(pair(1))]);
    });
    const result = await methods.run(problem, { ...options, start: pair() });
    expect(result.termination).toBe("error");
    expect(result.reasons.join()).toMatch(/await|pending|sequential|concurrent/i);
    expect(result.valid).toBe(true);
  });
});

describe("design decisions: composition", () => {
  it("shares evaluation counts and the random stream with explicitly started sub-runs", async () => {
    const methods = new MethodRegistry();
    const draws: number[] = [];
    register(methods, "child", async (ctx) => {
      expect(ctx.start).toEqual(pair(3));
      draws.push(ctx.random());
      await ctx.evaluate(pair(1));
    });
    register(methods, "probe", async (ctx) => {
      draws.push(ctx.random());
      const sub = await ctx.run("child", {}, { evals: 2, start: pair(3) });
      expect(sub.score).toBe(2);
      expect(sub.best).toBeDefined();
      draws.push(ctx.random());
    });
    const result = await methods.run(problem, { ...options, start: pair(2) });
    const random = seededRandom(1);
    expect(draws).toEqual(Array.from({ length: 3 }, random));
    expect(result.evaluations).toBeLessThanOrEqual(3);
    expect(result.score).toBe(2);
  });

  it("caps each stage within the shared overall budget and continues to the next stage", async () => {
    const methods = new MethodRegistry();
    register(methods, "search", async (ctx) => {
      while (await ctx.checkpoint()) await ctx.evaluate(pair(1 + ctx.random()));
    });
    const result = await methods.runPipeline(
      problem,
      {
        stages: [
          { method: "search", budget: { evals: 2 } },
          { method: "search", budget: { evals: 3 } },
        ],
      },
      { seed: 1, budget: { evals: 10 }, finalPolish: false },
    );
    expect(result.evaluations).toBe(5);
    expect(result.stages.map((stage) => stage.evaluations)).toEqual([2, 3]);
    expect(result.valid).toBe(true);
  });

  it("validates and counts emitted candidates and caps the next-stage pool at 64", async () => {
    const methods = new MethodRegistry();
    let poolSize = -1;
    register(methods, "produce", async (ctx) => {
      for (let i = 0; i < 70; i++) await ctx.emit(pair(1 + i / 100));
      await ctx.emit(pair(0.1));
    });
    register(methods, "consume", async (ctx) => {
      poolSize = ctx.starts.length;
      expect(ctx.start).toEqual(pair(1));
      for (const member of ctx.starts) expect(evaluate(member).valid).toBe(true);
    });
    const result = await methods.runPipeline(
      problem,
      { stages: [{ method: "produce" }, { method: "consume" }] },
      { seed: 1, budget: { evals: 100 }, finalPolish: false },
    );
    expect(poolSize).toBe(64);
    expect(result.evaluations).toBe(71);
    expect(result.score).toBe(2);
  });

  it("preserves a repairable invalid start through a stage with no valid outputs", async () => {
    const methods = new MethodRegistry();
    const invalid = pair(0.9);
    register(methods, "empty", async () => {});
    register(methods, "repair", async (ctx) => {
      expect(ctx.start).toEqual(invalid);
      await ctx.evaluate(pair(1));
    });
    const result = await methods.runPipeline(
      problem,
      { stages: [{ method: "empty" }, { method: "repair" }] },
      { seed: 1, start: invalid, budget: { evals: 10 }, finalPolish: false },
    );
    expect(result.valid).toBe(true);
    expect(result.score).toBe(2);
  });

  it("automatically reserves one tenth of evaluations for final polish", async () => {
    const methods = new MethodRegistry();
    register(methods, "probe", async (ctx) => {
      while (await ctx.checkpoint()) await ctx.evaluate(pair(2));
    });
    register(methods, "polish", async (ctx) => {
      while (await ctx.checkpoint()) await ctx.evaluate(pair(1));
    });
    const result = await methods.run(problem, { method: "probe", seed: 1, budget: { evals: 20 } });
    expect(result.evaluations).toBe(20);
    expect(result.stages.map((stage) => stage.method)).toEqual(["probe", "polish"]);
    expect(result.stages.map((stage) => stage.evaluations)).toEqual([18, 2]);
    expect(result.score).toBe(2);
    const single = await methods.run(problem, { method: "probe", seed: 1, budget: { evals: 20 }, finalPolish: false });
    expect(single.stages.map((stage) => stage.method)).toEqual(["probe"]);
    expect(single.score).toBe(3);
  });
});
