import { describe, expect, it } from "vitest";
import { PackingConfig, evaluate } from "@polypack/geometry";
import { MethodContext, MethodRegistry, SubRunResult } from "../src/index";

// two unit-diameter disks; the container diameter is gap + 1
const circles = (gap: number): PackingConfig => ({
  N: 0,
  M: 0,
  P: 2,
  pieces: [
    { x: -gap / 2, y: 0, theta: 0 },
    { x: gap / 2, y: 0, theta: 0 },
  ],
  container_phi: 0,
});
const schema = { type: "object" as const, properties: {}, additionalProperties: false as const };

/** A registry with a parent method whose body is supplied per test, and two child methods. */
function setup(body: (ctx: MethodContext) => Promise<void>) {
  const methods = new MethodRegistry();
  methods.register({
    name: "widen",
    schema,
    defaults: {},
    doc: "docs/methods/widen.md",
    // evaluates a configuration that is valid but worse than its start
    async execute(ctx) {
      await ctx.evaluate(circles(3));
    },
  });
  methods.register({
    name: "fail",
    schema,
    defaults: {},
    doc: "docs/methods/fail.md",
    async execute(ctx) {
      await ctx.evaluate(circles(1.2));
      throw new Error("child broke");
    },
  });
  methods.register({ name: "parent", schema, defaults: {}, doc: "docs/methods/parent.md", execute: body });
  return methods;
}
const problem = { N: 0, M: 0, P: 2 };
const options = { method: "parent", budget: { evals: 50 }, seed: 1, finalPolish: false };

describe("sub-runs", () => {
  it("report what the sub-run itself found, separately from the best of the run", async () => {
    let sub: SubRunResult | undefined;
    const methods = setup(async (ctx) => {
      await ctx.evaluate(circles(1));
      // start the child from a looser configuration, as a perturbation step would
      sub = await ctx.run("widen", {}, { start: circles(2), evals: 10 });
    });
    const result = await methods.run(problem, options);
    expect(result.score).toBeCloseTo(2, 12);
    expect(sub!.score).toBeCloseTo(2, 12);
    // the child saw r = 3 (its start, gap 2) and r = 4; its own best is its start
    expect(sub!.foundScore).toBeCloseTo(3, 12);
    expect(evaluate(sub!.found!).score).toBeCloseTo(3, 12);
    expect(sub!.evaluations).toBe(2);
  });

  it("a failing sub-run is reported to its caller and does not end the parent", async () => {
    let sub: SubRunResult | undefined;
    let continued = false;
    const methods = setup(async (ctx) => {
      sub = await ctx.run("fail", {}, { start: circles(1.5), evals: 10 });
      continued = (await ctx.evaluate(circles(1))) !== undefined;
    });
    const result = await methods.run(problem, options);
    expect(sub!.termination).toBe("error");
    expect(sub!.reasons).toEqual(["child broke"]);
    expect(sub!.foundScore).toBeCloseTo(2.2, 12);
    expect(continued).toBe(true);
    expect(result.termination).toBe("completed");
    expect(result.reasons).toEqual([]);
    expect(result.score).toBeCloseTo(2, 12);
  });

  it("remaining() reports the budget left, inside a sub-run slice too", async () => {
    const seen: number[] = [];
    const methods = new MethodRegistry();
    methods.register({
      name: "probe",
      schema,
      defaults: {},
      doc: "docs/methods/probe.md",
      async execute(ctx) {
        seen.push(ctx.remaining().evals);
      },
    });
    methods.register({
      name: "parent",
      schema,
      defaults: {},
      doc: "docs/methods/parent.md",
      async execute(ctx) {
        seen.push(ctx.remaining().evals);
        await ctx.evaluate(circles(1));
        seen.push(ctx.remaining().evals);
        // the slice start costs one evaluation, leaving 4 of the 5 for the child
        await ctx.run("probe", {}, { start: circles(2), evals: 5 });
        seen.push(ctx.remaining().evals);
        expect(ctx.remaining().time_s).toBe(Infinity);
      },
    });
    const result = await methods.run(problem, options);
    expect(result.termination).toBe("completed");
    expect(seen).toEqual([50, 49, 4, 48]);
  });
});

describe("strict results", () => {
  // two unit circles 5e-10 too close: valid for the server, but only thanks to the tolerance
  const leaning = circles(1 - 2.5e-10);

  it("a start inside the validity tolerance does not block an honest result", async () => {
    const methods = new MethodRegistry();
    methods.register({
      name: "honest",
      schema,
      defaults: {},
      doc: "docs/methods/honest.md",
      async execute(ctx) {
        await ctx.evaluate(circles(1));
        // a later tolerance-band candidate with a lower score must not take over again
        await ctx.evaluate(circles(1 - 4e-10));
      },
    });
    const result = await methods.run(problem, {
      method: "honest",
      start: leaning,
      budget: { evals: 10 },
      seed: 1,
      finalPolish: false,
    });
    expect(result.strict).toBe(true);
    expect(result.score).toBe(2);
    expect(result.best!.pieces[1].x).toBe(0.5);
    expect(result.reasons).toEqual([]);
  });

  it("a tolerance-band start is still returned when nothing strict is found, and is flagged", async () => {
    const { run } = await import("../src/index");
    const result = await run(problem, {
      method: "identity",
      start: leaning,
      budget: { evals: 3 },
      seed: 1,
      finalPolish: false,
    });
    expect(result.valid).toBe(true);
    expect(result.strict).toBe(false);
    expect(result.score).toBeLessThan(2);
    expect(result.reasons.join(" ")).toContain("validity tolerance");
  });

  it("the final polish turns a tolerance-band start into a strict result", async () => {
    const { run } = await import("../src/index");
    const result = await run(problem, { method: "identity", start: leaning, budget: { evals: 200 }, seed: 1 });
    expect(result.strict).toBe(true);
    expect(result.score!).toBeGreaterThanOrEqual(2);
    expect(result.score!).toBeLessThan(2 + 1e-9);
  });
});

describe("strict tolerance far from the origin", () => {
  it("grows with the coordinates but stays far below the validity tolerance", async () => {
    const { strictTolerance } = await import("../src/index");
    expect(strictTolerance(circles(1))).toBeLessThan(1.1e-12);
    const far = { ...circles(1), pieces: circles(1).pieces.map((p) => ({ ...p, x: p.x + 6e5 })) };
    expect(strictTolerance(far)).toBeGreaterThan(1e-10);
    expect(strictTolerance(far)).toBeLessThan(1e-9);
  });
});
