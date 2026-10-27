import { describe, expect, it } from "vitest";
import {
  type MethodContext,
  type SpaceMethodDefinition,
  Stop,
  getMethod,
  methodsFor,
  registerMethod,
  relax,
  runMethod,
  squeeze,
} from "../src";
import { checkKernel } from "../src/contract";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";
import { mulberry32 } from "../src/random";

// A method for these tests only: squeeze random starts, offering each.
const restarts: SpaceMethodDefinition = {
  name: "test_restarts",
  title: "Restarts (test)",
  summary: "Squeezes random starts.",
  doc: "docs/methods/dimensions/test_restarts.md",
  requires: [],
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { mu: { type: "number", exclusiveMinimum: 0 } },
  },
  defaults: { mu: 1e4 },
  run(ctx: MethodContext) {
    const k = ctx.kernel;
    if (ctx.start) {
      squeeze(k, ctx.start);
      ctx.offer(ctx.start);
    }
    for (;;) {
      const s = k.randomStart(ctx.rng);
      squeeze(k, s, { mus: [10, 100, ctx.params.mu as number] });
      ctx.offer(s);
    }
  },
};
registerMethod(restarts);
const restartsDef = () => restarts;

describe("the reference kernel", () => {
  it("passes the kernel contract", () => {
    for (const P of [1, 2, 5, 9]) expect(checkKernel(() => disksKernel(P), { seed: P })).toEqual([]);
  });

  it("squeezes random starts to within a few percent of the best known packings", () => {
    const rng = mulberry32(3);
    for (const P of [2, 3, 4, 5, 6, 7]) {
      const k = disksKernel(P);
      let best = Infinity;
      for (let t = 0; t < 8; t++) {
        const s = k.randomStart(rng);
        squeeze(k, s);
        const f = k.finish(s);
        if (f) best = Math.min(best, f.score);
      }
      expect(best).toBeLessThan(DISKS_IN_CIRCLE_BEST[P] * 1.03);
      expect(best).toBeGreaterThanOrEqual(DISKS_IN_CIRCLE_BEST[P] * (1 - 1e-9));
    }
  });

  it("relaxes overlapping disks apart at a fixed size", () => {
    const k = disksKernel(3);
    const s = k.fromConfig({
      R: 2.5,
      centres: [
        [0, 0],
        [0.5, 0],
        [0, 0.5],
      ],
    })!;
    expect(k.energy(s)).toBeGreaterThan(1);
    expect(relax(k, s)).toBeLessThan(1e-18);
    expect(s.size).toBe(2.5);
  });
});

describe("running a method", () => {
  it("returns a valid best, reproducibly from the seed with an evaluation budget", () => {
    const k = disksKernel(5);
    const a = runMethod(k, "test_restarts", { seed: 9, budget: { evals: 3000 } });
    const b = runMethod(disksKernel(5), "test_restarts", { seed: 9, budget: { evals: 3000 } });
    expect(a.stopped).toBe("evals");
    expect(a.score).not.toBeNull();
    expect(validateDisks(5, a.config, 0).valid).toBe(true);
    expect(b.config).toEqual(a.config);
    expect(a.evaluations).toBeGreaterThanOrEqual(3000);
    expect(a.evaluations).toBeLessThan(3000 + 20);
  });

  it("never returns worse than a valid start, and checks parameters against the schema", () => {
    const k = disksKernel(4);
    const start = {
      R: 2.4142135623730954,
      centres: [
        [1.4142135623730951, 0],
        [0, 1.4142135623730951],
        [-1.4142135623730951, 0],
        [0, -1.4142135623730951],
      ],
    };
    expect(validateDisks(4, start, 0).valid).toBe(true);
    const r = runMethod(k, "test_restarts", { seed: 1, start, budget: { evals: 50 } });
    expect(r.score).toBeLessThanOrEqual(start.R);
    expect(() => runMethod(k, "test_restarts", { seed: 1, params: { mu: -1 }, budget: { evals: 10 } })).toThrow(/mu/);
    expect(() => runMethod(k, "test_restarts", { seed: 1, params: { nope: 1 }, budget: { evals: 10 } })).toThrow(
      /unknown parameter/,
    );
  });

  it("ends on the external stop, on time, and at the lower bound", () => {
    const k = disksKernel(3);
    let calls = 0;
    const stopped = runMethod(k, "test_restarts", { seed: 2, budget: {}, shouldStop: () => ++calls > 500 });
    expect(stopped.stopped).toBe("stopped");
    let t = 0;
    const timed = runMethod(k, "test_restarts", { seed: 2, budget: { time_s: 1 }, now: () => (t += 0.001) });
    expect(timed.stopped).toBe("time");
    // one disk: the bound is R = 1, which the first offer reaches
    const one = runMethod(disksKernel(1), "test_restarts", { seed: 2, budget: { evals: 1e6 } });
    expect(one.stopped).toBe("bound");
    expect(one.score).toBeCloseTo(1, 9);
  });

  it("polls the stop with the evaluations charged so far, never decreasing, and a pausing poll changes nothing", () => {
    const k = disksKernel(4);
    const seen: number[] = [];
    const plain = runMethod(k, "test_restarts", { seed: 3, budget: { evals: 400 } });
    // a poll that does work of its own (as a pause that blocks) but never stops the run
    const polled = runMethod(k, "test_restarts", {
      seed: 3,
      budget: { evals: 400 },
      shouldStop: (used) => (seen.push(used), false),
    });
    expect(seen.length).toBeGreaterThan(10);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(400);
    expect(polled.stopped).toBe(plain.stopped);
    expect(polled.evaluations).toBe(plain.evaluations);
    expect(polled.score).toBe(plain.score);
    expect(polled.config).toEqual(plain.config);
    // a poll that ends the run once `used` reaches a limit, as a step does, ends before that charge
    const cut = runMethod(k, "test_restarts", { seed: 3, budget: { evals: 400 }, shouldStop: (u) => u >= 120 });
    expect(cut.stopped).toBe("stopped");
    expect(cut.evaluations).toBeGreaterThanOrEqual(120);
    expect(cut.evaluations).toBeLessThan(120 + 10);
  });

  it("keeps the result of a finish a stop arrives in, charging it once, and flags the poll inside a finish", () => {
    const base = disksKernel(4);
    let stop = false;
    let atFinish = -1;
    const flags: (boolean | undefined)[] = [];
    // a finish that polls once, as a real finish does, and then completes
    const k = {
      ...base,
      finishCost: 50,
      finish: (s: Parameters<typeof base.finish>[0], poll?: () => boolean) => {
        poll?.();
        return base.finish(s);
      },
    };
    const r = runMethod(k, "test_restarts", {
      seed: 5,
      budget: { evals: 10_000 },
      shouldStop: (used, finishing) => {
        flags.push(finishing);
        if (finishing && !stop) {
          stop = true;
          atFinish = used;
        }
        return stop;
      },
    });
    expect(r.stopped).toBe("stopped");
    expect(r.score).not.toBeNull();
    expect(flags.filter((f) => f === true)).toHaveLength(1);
    // the finish's cost was in `used` when it polled; the run then added only the check of its result
    expect(r.evaluations).toBe(atFinish + (k.validateCost ?? k.finishCost));
  });

  it("offers a method only to kernels with the capabilities it needs", () => {
    expect(getMethod("test_restarts")).toBeDefined();
    const needs: SpaceMethodDefinition = {
      ...restarts,
      name: "test_needs_swap",
      doc: "docs/methods/dimensions/test_needs_swap.md",
      requires: ["swap"],
    };
    registerMethod(needs);
    expect(methodsFor(disksKernel(3)).map((m) => m.name)).toContain("test_restarts");
    expect(methodsFor(disksKernel(3)).map((m) => m.name)).not.toContain("test_needs_swap");
    expect(() => runMethod(disksKernel(3), "test_needs_swap", { seed: 1, budget: { evals: 10 } })).toThrow(/swap/);
    expect(() => registerMethod({ ...restarts, name: "auto", doc: "docs/methods/dimensions/auto.md" })).toThrow(/auto/);
    expect(new Stop("evals").reason).toBe("evals");
  });
});

describe("offers", () => {
  it("end the run once a finish no longer fits, but always allow the first result", () => {
    registerMethod({
      ...restartsDef(),
      name: "test_offer_often",
      doc: "docs/methods/dimensions/test_offer_often.md",
      run(ctx) {
        for (;;) {
          const s = ctx.kernel.randomStart(ctx.rng);
          relax(ctx.kernel, s, { maxIter: 5 });
          ctx.offer(s);
        }
      },
    });
    // a finish dearer than the whole budget: the first offer still gives a result, then the run ends
    const dear = runMethod({ ...disksKernel(4), finishCost: 5000 }, "test_offer_often", {
      seed: 1,
      budget: { evals: 1000 },
    });
    expect(dear.score).not.toBeNull();
    expect(dear.stopped).toBe("evals");
    expect(dear.evaluations).toBeLessThan(1000 + 2 * 5000 + 50);
    // with room for several, no offer starts without room for its finish and its check
    const fits = runMethod({ ...disksKernel(4), finishCost: 400 }, "test_offer_often", {
      seed: 1,
      budget: { evals: 5000 },
    });
    expect(fits.score).not.toBeNull();
    expect(fits.evaluations).toBeLessThanOrEqual(5000 + 50);
  });

  it("return null for a finish that the server's rule refuses", () => {
    const base = disksKernel(3);
    let refused = 0;
    const k = { ...base, validate: (c: unknown) => (refused++, { valid: false, score: null, reasons: ["refused"] }) };
    const scores: (number | null)[] = [];
    registerMethod({
      ...restartsDef(),
      name: "test_offer_once",
      doc: "docs/methods/dimensions/test_offer_once.md",
      run(ctx) {
        const s = ctx.kernel.randomStart(ctx.rng);
        squeeze(ctx.kernel, s);
        scores.push(ctx.offer(s));
      },
    });
    const r = runMethod(k, "test_offer_once", { seed: 1, budget: { evals: 1e5 } });
    expect(scores).toEqual([null]);
    expect(refused).toBeGreaterThan(0);
    expect(r.score).toBeNull();
  });
});

describe("starts", () => {
  it("are dropped, not fatal, when the kernel throws reading one", () => {
    const k = {
      ...disksKernel(3),
      fromConfig: () => {
        throw new Error("unreadable");
      },
    };
    const r = runMethod(k, "test_restarts", { seed: 1, start: { R: 3, centres: [] }, budget: { evals: 3000 } });
    expect(r.stopped).not.toBe("error");
    expect(r.score).not.toBeNull();
  });
});
