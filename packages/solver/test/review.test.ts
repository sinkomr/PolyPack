/**
 * Independent review of Phase 2 build step 1 (framework and polish).
 *
 * Tests in the "defect" blocks fail against the reviewed code on purpose. Each carries a
 * one-line DEFECT comment naming what is wrong. All other tests document behaviour that was
 * checked and found sound.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundingRadius, evaluate, parseConfig, type PackingConfig } from "@polypack/geometry";
import { createApp } from "../../../apps/server/src/app";
import { SqliteStore } from "../../../apps/server/src/sqlite-store";
import { MethodRegistry, polish, registry, run, runPipeline, seededRandom, type MethodContext } from "../src";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Five unit squares in a square; expansion 1 is the tight packing with side 2 + 1/sqrt(2). */
function squares(expansion: number, phi = 0): PackingConfig {
  const d = ((1 + Math.SQRT1_2) / 2) * expansion;
  return {
    N: 4,
    M: 4,
    P: 5,
    container_phi: phi,
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

/** Seven unit-diameter disks in a circle; expansion 1 is the tight packing with diameter 3. */
function circles(expansion: number): PackingConfig {
  return {
    N: 0,
    M: 0,
    P: 7,
    container_phi: 0,
    pieces: [
      { x: 0, y: 0, theta: 0 },
      ...Array.from({ length: 6 }, (_, k) => ({
        x: expansion * Math.cos((k * Math.PI) / 3),
        y: expansion * Math.sin((k * Math.PI) / 3),
        theta: 0,
      })),
    ],
  };
}

/** Two unit-diameter disks in a circle; `half` = 1 is the tight packing (centres 1 apart) with diameter 2. */
function twoCircles(half: number): PackingConfig {
  return {
    N: 0,
    M: 0,
    P: 2,
    container_phi: 0,
    pieces: [
      { x: -half / 2, y: 0, theta: 0 },
      { x: half / 2, y: 0, theta: 0 },
    ],
  };
}

/** Square grid of pieces with the given gap between bounding circles. */
function grid(N: number, M: number, P: number, gap: number, theta = 0.2, phi = 0.1): PackingConfig {
  const spacing = 2 * boundingRadius(N) + gap;
  const width = Math.ceil(Math.sqrt(P));
  return {
    N,
    M,
    P,
    container_phi: phi,
    pieces: Array.from({ length: P }, (_, i) => ({
      x: spacing * (i % width),
      y: spacing * Math.floor(i / width),
      theta,
    })),
  };
}

/** Random poses in a box; dense enough that some draws overlap and some do not. */
function scatter(N: number, M: number, P: number, seed: number, density: number): PackingConfig {
  const random = seededRandom(seed);
  const side = Math.sqrt(P) * 2 * boundingRadius(N) * density;
  return {
    N,
    M,
    P,
    container_phi: (random() - 0.5) * 6,
    pieces: Array.from({ length: P }, () => ({
      x: (random() - 0.5) * side,
      y: (random() - 0.5) * side,
      theta: (random() - 0.5) * 6,
    })),
  };
}

function probeRegistry(execute: (context: MethodContext) => Promise<void>): MethodRegistry {
  const methods = new MethodRegistry();
  methods.register({ name: "probe", schema: { type: "object" }, defaults: {}, doc: "docs/methods/probe.md", execute });
  return methods;
}

function server() {
  return createApp({
    store: new SqliteStore(":memory:"),
    records: [],
    limits: { perIp: 1e6 },
    log: () => {},
  });
}

async function submit(app: ReturnType<typeof createApp>, config: PackingConfig) {
  const response = await app.request("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...config, name: "reviewer", agent: "ai" }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { valid: boolean; score: number | null; reasons: string[] },
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Result against the real server
// ---------------------------------------------------------------------------------------------

describe("review: Result against server scoring", () => {
  it("every valid Result is accepted by POST /api/submit with exactly the reported score", async () => {
    const app = server();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 6, 8, 12),
        fc.constantFrom(0, 3, 4, 5, 6, 8, 12, 20),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 1e6 }),
        fc.double({ min: 0.9, max: 2.2, noNaN: true }),
        fc.constantFrom("identity", "polish"),
        async (N, M, P, seed, density, method) => {
          const start = scatter(N, M, P, seed, density);
          const result = await run({ N, M, P }, { method, start, budget: { evals: 12 }, seed });
          expect(result.valid).toBe(result.best !== undefined);
          if (!result.best) {
            expect(result.score).toBeNull();
            expect(evaluate(start, { autoOrient: true }).valid).toBe(false);
            return;
          }
          expect(evaluate(result.best, { autoOrient: true }).score).toBe(result.score);
          const reply = await submit(app, result.best);
          expect(reply.status).toBe(200);
          expect(reply.body.valid).toBe(true);
          expect(reply.body.score).toBe(result.score);
        },
      ),
      // 40 runs took over 30 s once polish iterated to convergence; 15 keeps CI time reasonable
      { numRuns: 15, seed: 4101 },
    );
  });

  it("rejects on the server exactly what the framework refuses to store as best", async () => {
    const app = server();
    const overlapping = twoCircles(0.5);
    const result = await run(overlapping, {
      method: "polish",
      start: overlapping,
      params: { iterations: 0 },
      budget: { evals: 5 },
      seed: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.best).toBeUndefined();
    expect((await submit(app, overlapping)).status).toBe(422);
  });

  // DEFECT: Result.best keeps the submitted container_phi, which is not the phi that achieves Result.score.
  it("defect: best.container_phi is the orientation at which the reported score is attained", async () => {
    const start = squares(1, 0.3);
    const result = await run(start, { start, budget: { evals: 3 }, seed: 1 });
    expect(result.score).toBeCloseTo(2 + Math.SQRT1_2, 12);
    // The web board draws the container at config.container_phi (apps/web/src/board.ts), without auto-orient.
    expect(evaluate(result.best!).score).toBe(result.score);
  });

  // DEFECT: the same holds after polish; it re-orients internally but the framework stores the raw candidate.
  it("defect: a polished Result scores the same with and without auto-orientation", async () => {
    const start = squares(1.02, 0.3);
    const result = await run(start, { method: "polish", start, budget: { evals: 200 }, seed: 1 });
    expect(evaluate(result.best!).score).toBe(result.score);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Budgets and stop
// ---------------------------------------------------------------------------------------------

describe("review: budgets and stop", () => {
  // Design decision: methods call the framework sequentially, and budget.evals is at least 1.
  it("enforces an evals budget exactly with bursts of calls across pipeline stages", async () => {
    let requested = 0;
    const methods = new MethodRegistry();
    methods.register({
      name: "burst",
      schema: { type: "object", properties: { width: { type: "integer", minimum: 1 } }, additionalProperties: false },
      defaults: { width: 4 },
      doc: "docs/methods/burst.md",
      async execute(context) {
        const width = context.params.width as number;
        for (let round = 0; round < 3; round++) {
          for (let k = 0; k < width; k++) {
            requested++;
            await context.evaluate(twoCircles(1 + context.random()));
          }
        }
      },
    });
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 80 }),
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        async (evals, widths, withStart) => {
          requested = 0;
          const stages = widths.map((width) => ({ method: "burst", params: { width } }));
          const result = await methods.runPipeline(
            twoCircles(1),
            { stages },
            {
              start: withStart ? twoCircles(1.5) : undefined,
              budget: { evals },
              seed: 3,
              // the automatic final polish is tested separately; here the stages get the whole budget
              finalPolish: false,
            },
          );
          const wanted = requested + (withStart ? 1 : 0);
          expect(result.evaluations).toBeLessThanOrEqual(evals);
          // Nothing is lost either: the count is the smaller of the budget and the demand.
          if (wanted >= evals) expect(result.evaluations).toBe(evals);
          else expect(result.evaluations).toBe(3 * widths.reduce((a, b) => a + b, 0) + (withStart ? 1 : 0));
        },
      ),
      { numRuns: 60, seed: 4102 },
    );
  });

  it("does not evaluate anything after the budget even when a method ignores undefined", async () => {
    const methods = probeRegistry(async (context) => {
      for (let i = 0; i < 50; i++) await context.evaluate(twoCircles(1 + i));
    });
    const result = await methods.run(twoCircles(1), { method: "probe", budget: { evals: 7 }, seed: 1 });
    expect(result.evaluations).toBe(7);
    expect(result.score).toBe(2);
  });

  it("stops a P = 30 polish within one second of an abort and keeps a valid best", async () => {
    const start = grid(8, 8, 30, 0.03);
    const signal = { aborted: false };
    let abortedAt = 0;
    setTimeout(() => {
      signal.aborted = true;
      abortedAt = performance.now();
    }, 40);
    const result = await run(start, { method: "polish", start, budget: { evals: 1e9 }, seed: 1, signal });
    expect(abortedAt).toBeGreaterThan(0);
    expect(performance.now() - abortedAt).toBeLessThan(1000);
    expect(result.termination).toBe("aborted");
    expect(evaluate(result.best!, { autoOrient: true }).valid).toBe(true);
  });

  it("holds a time budget to within one atomic evaluation for a cooperative method", async () => {
    const start = grid(8, 8, 30, 0.03);
    const result = await run(start, { method: "polish", start, budget: { time_s: 0.15 }, seed: 1 });
    expect(result.termination).toBe("time");
    // Measured overrun here is below 5 ms; 150 ms of slack keeps this stable on a loaded machine.
    expect(result.wallTime).toBeLessThan(0.3);
    expect(result.valid).toBe(true);
  });

  // DEFECT: a method that throws after finding a valid configuration makes run() reject, so the best is lost.
  it("defect: a method failure still returns the best valid configuration found so far", async () => {
    const methods = probeRegistry(async (context) => {
      await context.evaluate(twoCircles(1));
      throw new Error("numerical breakdown inside the method");
    });
    const outcome = await methods.run(twoCircles(1), { method: "probe", budget: { evals: 10 }, seed: 1 }).then(
      (result) => ({ valid: result.valid, score: result.score }),
      (error: Error) => ({ rejected: error.message }),
    );
    expect(outcome).toEqual({ valid: true, score: 2 });
  });

  // DEFECT: one non-finite or out-of-range candidate (a routine optimizer blow-up) rejects the whole run.
  it("defect: a non-finite candidate is reported as not evaluated instead of destroying the run", async () => {
    const methods = probeRegistry(async (context) => {
      await context.evaluate(twoCircles(1));
      await context.evaluate({
        ...twoCircles(1),
        pieces: [
          { x: NaN, y: 0, theta: 0 },
          { x: 1, y: 0, theta: 0 },
        ],
      });
      await context.evaluate({
        ...twoCircles(1),
        pieces: [
          { x: -2e6, y: 0, theta: 0 },
          { x: 1, y: 0, theta: 0 },
        ],
      });
    });
    const outcome = await methods.run(twoCircles(1), { method: "probe", budget: { evals: 10 }, seed: 1 }).then(
      (result) => ({ valid: result.valid, score: result.score }),
      (error: Error) => ({ rejected: error.message }),
    );
    expect(outcome).toEqual({ valid: true, score: 2 });
  });

  // DEFECT: the checkpoint sleeps on a timer every 16 calls, which caps throughput near 16 evaluations per timer tick.
  it("defect: yields to the event loop are driven by elapsed time, not by a fixed call count", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const start = twoCircles(1);
    const result = await run(start, {
      start,
      params: { iterations: 1e9 },
      budget: { evals: 4000 },
      seed: 1,
      finalPolish: false,
    });
    const yields = timers.mock.calls.length;
    expect(result.evaluations).toBe(4000);
    // One yield per 4 ms is already twice as often as the 8 ms the code states as its own target.
    expect(yields).toBeLessThanOrEqual(2 + (result.wallTime * 1000) / 4);
  });

  // DEFECT: runPipeline throws synchronously for an empty pipeline, while every other input error is a rejection.
  it("defect: runPipeline reports an empty pipeline as a rejected promise", () => {
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = runPipeline(twoCircles(1), { stages: [] }, { budget: { evals: 1 }, seed: 1 });
    }).not.toThrow();
    promise?.catch(() => {});
  });

  // DEFECT: after the first stage an invalid start is dropped, so a later repairing stage gets no input.
  it("defect: a pipeline passes a repairable start on to a later stage that can repair it", async () => {
    const start = circles(0.99999);
    const alone = await run(start, { method: "polish", start, budget: { evals: 300 }, seed: 1 });
    expect(alone.valid).toBe(true);
    const chained = await runPipeline(
      start,
      { stages: [{ method: "identity" }, { method: "polish" }] },
      {
        start,
        budget: { evals: 300 },
        seed: 1,
      },
    );
    expect(chained.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Determinism
// ---------------------------------------------------------------------------------------------

/** A small randomized search: random kicks, keep improvements. Decisions use only context.random. */
function kickRegistry(): MethodRegistry {
  const methods = new MethodRegistry();
  methods.register({
    name: "kick",
    schema: { type: "object", properties: { step: { type: "number", minimum: 0 } }, additionalProperties: false },
    defaults: { step: 0.2 },
    doc: "docs/methods/kick.md",
    async execute(context) {
      let current = context.start!;
      let score = Infinity;
      const step = context.params.step as number;
      while (await context.checkpoint()) {
        const trial = {
          ...current,
          container_phi: current.container_phi + step * (context.random() - 0.5),
          pieces: current.pieces.map((p) => ({
            x: p.x + step * (context.random() - 0.5),
            y: p.y + step * (context.random() - 0.5),
            theta: p.theta + step * (context.random() - 0.5),
          })),
        };
        const result = await context.evaluate(trial);
        if (!result) break;
        if (result.valid && result.score! < score) {
          current = trial;
          score = result.score!;
        }
      }
    },
  });
  return methods;
}

describe("review: determinism", () => {
  it("gives a bit-identical best and score for a randomized method, and a different one for another seed", async () => {
    const methods = kickRegistry();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5),
        fc.constantFrom(0, 3, 4, 6),
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 0, max: 2 ** 32 - 2 }),
        async (N, M, P, seed) => {
          const start = grid(N, M, P, 0.4);
          const options = { method: "kick", start, budget: { evals: 60 }, seed };
          const a = await methods.run(start, options);
          const b = await methods.run(start, options);
          expect(JSON.stringify(a.best)).toBe(JSON.stringify(b.best));
          expect(Object.is(a.score, b.score)).toBe(true);
          expect(a.evaluations).toBe(b.evaluations);
          expect(a.trace.map(([, score]) => score)).toEqual(b.trace.map(([, score]) => score));
          const c = await methods.run(start, { ...options, seed: seed + 1 });
          expect(JSON.stringify(c.best)).not.toBe(JSON.stringify(a.best));
        },
      ),
      { numRuns: 12, seed: 4103 },
    );
  });

  it("gives a bit-identical polish through the framework, also when progress callbacks are attached", async () => {
    for (const start of [squares(1.03, 0.4), circles(1.1), grid(5, 6, 12, 0.04), scatter(6, 0, 9, 11, 1.6)]) {
      const options = { method: "polish", start, budget: { evals: 70 }, seed: 5 };
      const a = await run(start, options);
      const b = await run(start, { ...options, onProgress: () => {} });
      expect(JSON.stringify(a.best)).toBe(JSON.stringify(b.best));
      expect(Object.is(a.score, b.score)).toBe(true);
      expect(a.evaluations).toBe(b.evaluations);
    }
  });

  it("is independent of clock speed for a sequential method under an evals budget", async () => {
    const methods = kickRegistry();
    const start = grid(4, 4, 6, 0.4);
    const options = { method: "kick", start, budget: { evals: 80 }, seed: 9 };
    const fast = await methods.run(start, options);
    // A clock that jumps 20 ms on every reading makes every checkpoint take the time-driven yield.
    let fake = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => (fake += 20));
    const slow = await methods.run(start, options);
    expect(JSON.stringify(slow.best)).toBe(JSON.stringify(fast.best));
    expect(slow.score).toBe(fast.score);
  });

  it("keeps concurrent polishes inside one method in the same order at any clock speed", async () => {
    const starts = [circles(1.2), circles(1.1), circles(1.3)];
    const methods = probeRegistry(async (context) => {
      await Promise.all(
        starts.map((start) => polish(start, { checkpoint: context.checkpoint, evaluate: context.evaluate })),
      );
    });
    const options = { method: "probe", budget: { evals: 45 }, seed: 1 };
    const fast = await methods.run(circles(1), options);
    let fake = performance.now();
    let reads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (fake += ++reads % 7 === 0 ? 9 : 0.001));
    const slow = await methods.run(circles(1), options);
    expect(slow.evaluations).toBe(fast.evaluations);
    expect(JSON.stringify(slow.best)).toBe(JSON.stringify(fast.best));
  });

  // Decision E: concurrent framework calls are rejected, preserving the evaluated valid start.
  it("defect: concurrent workers inside one method are rejected with the best preserved", async () => {
    const methods = probeRegistry(async (context) => {
      await Promise.all([context.checkpoint(), context.evaluate(twoCircles(1))]);
    });
    const options = { method: "probe", start: twoCircles(1.1), budget: { evals: 70 }, seed: 4 };
    const result = await methods.run(twoCircles(1), options);
    expect(result.termination).toBe("error");
    expect(result.reasons.join()).toMatch(/sequential|pending|await/);
    expect(result.valid).toBe(true);
    expect(evaluate(result.best!).valid).toBe(true);
  });

  it("never calls Math.random or Date.now in a run", async () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random used");
    });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now used");
    });
    const start = squares(1.05);
    const result = await runPipeline(
      start,
      { stages: [{ method: "identity" }, { method: "polish" }] },
      {
        start,
        budget: { evals: 40 },
        seed: 2,
      },
    );
    expect(result.valid).toBe(true);
  });

  it("has no clock, DOM or Node dependency in the core source beyond runtime.ts", () => {
    const dir = resolve(import.meta.dirname, "../src");
    // methods live in subdirectories, so every source file below src is scanned
    const names = (readdirSync(dir, { recursive: true }) as string[]).filter((name) => name.endsWith(".ts"));
    expect(names.length).toBeGreaterThan(4);
    for (const name of names) {
      // Comments may mention the forbidden names; only code counts.
      const source = readFileSync(resolve(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(source, name).not.toMatch(
        /Math\.random|\bDate\b|from "node:|\brequire\(|\bprocess\.|\bwindow\b|\bdocument\b/,
      );
      if (name !== "runtime.ts") expect(source, name).not.toMatch(/performance\.now|setTimeout|setInterval/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Polish
// ---------------------------------------------------------------------------------------------

/** Polishes and checks the two safety properties: never invalid, never worse than a valid input. */
async function polishChecked(start: PackingConfig, options: Parameters<typeof polish>[1] = {}) {
  const before = evaluate(start, { autoOrient: true });
  const out = await polish(start, options);
  const after = out ? evaluate(out, { autoOrient: true }) : undefined;
  if (out) {
    expect(parseConfig(out).ok).toBe(true);
    expect(out.pieces.length).toBe(start.P);
    expect(after!.valid).toBe(true);
  }
  if (before.valid) {
    expect(out).toBeDefined();
    expect(after!.score!).toBeLessThanOrEqual(before.score!);
  }
  return { before, after, out };
}

describe("review: polish safety", () => {
  it("never returns an invalid or worse configuration for random starts, valid or overlapping", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 6, 7, 12, 20),
        fc.constantFrom(0, 3, 4, 5, 6, 12, 20),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 1e6 }),
        fc.double({ min: 0.7, max: 2.5, noNaN: true }),
        async (N, M, P, seed, density) => {
          await polishChecked(scatter(N, M, P, seed, density), { iterations: 6 });
        },
      ),
      // reduced from 60 for the same reason
      { numRuns: 20, seed: 4104 },
    );
  });

  it("never returns an invalid or worse configuration for tight grids with P = 30", async () => {
    for (const [N, M] of [
      [0, 0],
      [0, 4],
      [4, 0],
      [4, 4],
      [3, 6],
      [12, 20],
      [20, 12],
      [8, 3],
    ]) {
      for (const gap of [0, 1e-9, 0.02]) await polishChecked(grid(N, M, 30, gap), { iterations: 4 });
    }
  });

  it("handles degenerate starts: coincident pieces, one piece, far apart pieces, extreme phi", async () => {
    const coincident = (N: number, M: number, P: number): PackingConfig => ({
      N,
      M,
      P,
      container_phi: 0,
      pieces: Array.from({ length: P }, () => ({ x: 1, y: 1, theta: 0.3 })),
    });
    for (const [N, M] of [
      [0, 0],
      [4, 4],
      [5, 0],
      [0, 6],
      [12, 20],
    ]) {
      const few = { iterations: 8 };
      for (const P of [2, 5]) await polishChecked(coincident(N, M, P), few);
      await polishChecked({ N, M, P: 1, container_phi: 0.5, pieces: [{ x: 3, y: -4, theta: 1 }] }, few);
      await polishChecked(grid(N, M, 4, 25), few);
      await polishChecked({ ...grid(N, M, 6, 0.01), container_phi: 1e6 }, few);
      await polishChecked({ ...grid(N, M, 6, 0.01), container_phi: -2.9 }, few);
    }
    // Pieces at the coordinate limit must not be pushed outside it into an unparseable result.
    await polishChecked({
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: 1e6, y: 1e6, theta: 0 },
        { x: 1e6 - 1, y: 1e6, theta: 0 },
      ],
    });
  });

  it("keeps a single piece at its exact optimum for every shape pairing", async () => {
    // [CALC] One unit-diameter disk: square side 1, circle diameter 1. One unit square: circle diameter sqrt(2), square side 1.
    const cases: [number, number, number][] = [
      [0, 4, 1],
      [0, 0, 1],
      [4, 0, Math.SQRT2],
      [4, 4, 1],
    ];
    for (const [N, M, target] of cases) {
      const { after } = await polishChecked({ N, M, P: 1, container_phi: 0.9, pieces: [{ x: 2, y: 3, theta: 0.4 }] });
      expect(after!.score).toBeCloseTo(target, 12);
    }
  });

  it("does not modify its input and ignores rejected option values", async () => {
    const start = squares(1.02);
    const copy = structuredClone(start);
    await polish(start);
    expect(start).toEqual(copy);
    await expect(polish(start, { iterations: NaN })).rejects.toThrow(RangeError);
    await expect(polish(start, { contactTolerance: -1 })).rejects.toThrow(RangeError);
  });

  it("stops inside the evaluation budget when run through the framework", async () => {
    for (const evals of [1, 2, 3, 10]) {
      const start = grid(5, 5, 30, 0.02);
      const result = await run(start, { method: "polish", start, budget: { evals }, seed: 1 });
      expect(result.evaluations).toBe(evals);
      expect(result.valid).toBe(true);
      expect(result.score!).toBeLessThanOrEqual(evaluate(start, { autoOrient: true }).score!);
    }
  });
});

describe("review: polish effectiveness on known tight packings", () => {
  // [CALC] Targets: 2 + 1/sqrt(2) (five squares), 3 (seven circles), 2 (two circles).
  it("recovers five squares in a square from loosened, rotated and mis-oriented starts", async () => {
    const target = 2 + Math.SQRT1_2;
    const rotate = (c: PackingConfig, a: number): PackingConfig => ({
      ...c,
      pieces: c.pieces.map((p) => ({
        x: p.x * Math.cos(a) - p.y * Math.sin(a),
        y: p.x * Math.sin(a) + p.y * Math.cos(a),
        theta: p.theta + a,
      })),
    });
    for (const start of [
      squares(1.02),
      squares(1.1),
      squares(1.3),
      squares(1.02, 0.7),
      rotate(squares(1.05), 0.3),
      squares(0.97),
    ]) {
      const { after } = await polishChecked(start);
      expect(Math.abs(after!.score! - target)).toBeLessThan(1e-9);
    }
  });

  it("recovers seven circles in a circle and two circles in a circle", async () => {
    for (const expansion of [1.02, 1.2, 0.95]) {
      const { after } = await polishChecked(circles(expansion));
      expect(Math.abs(after!.score! - 3)).toBeLessThan(1e-9);
    }
    for (const half of [1.01, 1.5, 0, 0.6]) {
      const { after } = await polishChecked(twoCircles(half));
      expect(Math.abs(after!.score! - 2)).toBeLessThan(1e-9);
    }
  });

  it("solves vertex-edge contacts with rotation: tilted squares settle into a 2 by 2 block", async () => {
    // [CALC] Four unit squares fill a square of side 2 exactly, so 2 is the optimum.
    const start: PackingConfig = {
      N: 4,
      M: 4,
      P: 4,
      container_phi: 0,
      pieces: [
        [0, 0, 0.05],
        [1.1, 0, -0.04],
        [0, 1.1, 0.03],
        [1.12, 1.09, -0.06],
      ].map(([x, y, a]) => ({
        x,
        y,
        theta: Math.PI / 4 + a,
      })),
    };
    const { after } = await polishChecked(start);
    expect(Math.abs(after!.score! - 2)).toBeLessThan(1e-9);
  });

  // DEFECT: with the default 80 iterations the polish stops well short of the optimum on a perturbed start.
  it("defect: polish reaches 1e-9 of the optimum from a slightly jittered five-square start", async () => {
    const random = seededRandom(2);
    const jitter = () => 0.02 * (random() - 0.5);
    const start = squares(1.03);
    start.pieces = start.pieces.map((p) => ({ x: p.x + jitter(), y: p.y + jitter(), theta: p.theta + jitter() }));
    const { after } = await polishChecked(start);
    expect(Math.abs(after!.score! - (2 + Math.SQRT1_2))).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Registry and schema edge cases
// ---------------------------------------------------------------------------------------------

describe("review: registry and schema", () => {
  it("is not polluted through __proto__ or constructor parameter names", async () => {
    const params = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}');
    await expect(run(twoCircles(1), { start: twoCircles(1), params, budget: { evals: 2 }, seed: 1 })).rejects.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects bad budgets, seeds, problems and starts before running anything", async () => {
    const start = twoCircles(1);
    const bad: Record<string, unknown>[] = [
      { budget: { evals: 1.5 }, seed: 1 },
      { budget: { time_s: Infinity }, seed: 1 },
      { budget: { time_s: -1 }, seed: 1 },
      { budget: { evals: 5 }, seed: 1.5 },
      { budget: { evals: 5 }, seed: NaN },
      { budget: { evals: 5 }, seed: 1, start: { ...start, P: 3 } },
      { budget: { evals: 5 }, seed: 1, start: { ...start, pieces: [{ x: Infinity, y: 0, theta: 0 }] } },
      { budget: { evals: 5 }, seed: 1, method: "missing" },
    ];
    for (const options of bad) await expect(run(start, { start, ...options } as never)).rejects.toThrow();
    await expect(run({ N: 2, M: 0, P: 2 }, { budget: { evals: 5 }, seed: 1 })).rejects.toThrow();
    await expect(run({ N: 0, M: 0, P: 0 }, { budget: { evals: 5 }, seed: 1 })).rejects.toThrow();
  });

  it("lists the built-in methods with schema, defaults and an existing doc page", () => {
    const listed = registry.list();
    // more methods register as Phase 2 proceeds; each one must come with its doc page
    expect(listed.map((m) => m.name)).toEqual(expect.arrayContaining(["identity", "polish"]));
    for (const method of listed) {
      expect(() => readFileSync(resolve(import.meta.dirname, "../../..", method.doc), "utf8")).not.toThrow();
      expect(JSON.parse(JSON.stringify(method))).toEqual(method);
    }
  });

  // DEFECT: seeds are reduced modulo 2^32 without notice, so distinct accepted seeds give identical runs.
  // Design decision: seeds are limited to uint32, so two accepted seeds can never alias.
  it("rejects seeds outside [0, 2^32 - 1] instead of aliasing them", async () => {
    const start = twoCircles(1);
    for (const seed of [-1, 2 ** 32, 7 + 2 ** 32, 1.5]) {
      await expect(run(start, { start, budget: { evals: 5 }, seed })).rejects.toThrow(/seed/);
    }
  });
});
