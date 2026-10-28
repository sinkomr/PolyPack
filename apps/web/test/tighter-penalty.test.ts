import { describe, expect, it } from "vitest";
import { MAX_METHOD_PARAMS_BYTES, findFreeSpot, parseProvenance, utf8Length } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { MethodRegistry, registry as solverRegistry, run } from "@polypack/solver";
import type { MethodDefinition, Result, RunOptions } from "@polypack/solver";
import { plain } from "../src/tighter/how";
import { methodGame } from "../src/tighter/methods";
import {
  CYCLE_TOLERANCE,
  SETTLE_EVALS,
  SQUEEZE,
  SQUEEZE_INTERVAL,
  SQUEEZE_SOLVES,
} from "../src/tighter/methods/penalty-settings";
import { gamePenaltyMethod, squeezeMethod } from "../src/tighter/methods/penalty-run";
import type { RunView } from "../src/tighter/methods/types";
import { METHODS } from "../src/tighter/methods/worker";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import type { RunState } from "../src/tighter/open-run";
import { presetParams } from "../src/tighter/presets";
import { submissionBody } from "../src/tighter/submission";
import { UPGRADES } from "../src/tighter/upgrades";

// penalty in the game (penalty-run.ts): a squeeze that scores every 10th L-BFGS step, then a settle
// with mc_compress, in turn, while the "penalty" basin_hopping calls stays the solver's own.

const problem = { family: "polygon" as const, N: 21, M: 24, P: 12 };

/** Load all, then 40 evaluations of mc_compress: a compacted board, as a player has it. */
const board: Promise<PackingConfig> = (async () => {
  const pieces: Pose[] = [];
  for (let k = 0; k < problem.P; k++) pieces.push(findFreeSpot(problem.N, pieces, 0, 0));
  const r = new OpenRun({
    problem,
    method: "mc_compress",
    params: { sweepsPerEvaluation: 10 },
    budget: { evals: 5000 },
    seed: 1,
    start: { ...problem, pieces, container_phi: 0 },
  });
  const s = await r.step(40);
  await r.close();
  return s.best!;
})();

/** Every number of a packing as its 64 bits, so that equal means equal to the bit (−0 included). */
function bits(c: PackingConfig | null | undefined): string[] {
  const view = new DataView(new ArrayBuffer(8));
  const hex = (x: number) => {
    view.setFloat64(0, x);
    return view.getBigUint64(0).toString(16);
  };
  return (c?.pieces ?? []).flatMap((p) => [hex(p.x), hex(p.y), hex(p.theta)]);
}

/** A run of the game's definitions (the worker's list), without the open run around it. */
function gameRun(
  p: { N: number; M: number; P: number },
  options: RunOptions,
  wrap: (d: MethodDefinition) => MethodDefinition = (d) => d,
): Promise<Result> {
  const registry = new MethodRegistry();
  for (const d of METHODS) registry.register(wrap(d));
  return registry.run(p, options);
}

/** The open run stepped `by` evaluations at a time until it ends, with every state seen. */
async function stepped(r: OpenRun, by: number, most = 20_000): Promise<RunState[]> {
  const seen = [await r.step(0)];
  while (!seen.at(-1)!.ended && seen.length < most) seen.push(await r.step(by));
  return seen;
}

const view = (over: Partial<RunView>): RunView => ({
  evaluations: 0,
  budget: 100_000,
  params: {},
  last: null,
  runBest: null,
  found: null,
  startScore: null,
  problemBest: null,
  ...over,
});

describe("Tighter's penalty definitions", () => {
  it("register the game's penalty under the solver's name, with the squeeze beside it", () => {
    const names = METHODS.map((d) => d.name);
    expect(names.filter((n) => n === "penalty")).toEqual(["penalty"]);
    expect(names).toContain(SQUEEZE);
    expect(METHODS.find((d) => d.name === "penalty")).toBe(gamePenaltyMethod);
    // at its defaults, the solver's own parameters with the game's three at their neutral values
    const solver = solverRegistry.list().find((m) => m.name === "penalty")!.defaults;
    expect(resolvedParams("penalty", {})).toEqual({
      ...solver,
      evaluationInterval: 1,
      settleEvals: 0,
      cycleTolerance: CYCLE_TOLERANCE,
    });
    expect(resolvedParams(SQUEEZE, {})).toEqual({ ...solver, evaluationInterval: 1 });
    // the texts' "10 solves" is the solver's own outerIterations
    expect(solver.outerIterations).toBe(SQUEEZE_SOLVES);
    expect(squeezeMethod.schema.properties!.settleEvals).toBeUndefined();
  });

  it("run as the solver's own penalty at their defaults, to the bit, also in an open run stepped by clicks", async () => {
    const start = await board;
    const options = { method: "penalty", params: { innerIterations: 30 }, budget: { evals: 5000 }, seed: 2, start };
    const solver = await run(problem, { ...options, finalPolish: false });
    const game = await gameRun(problem, { ...options, finalPolish: false });
    expect(game.evaluations).toBe(solver.evaluations);
    expect(game.score).toBe(solver.score);
    expect(bits(game.best)).toEqual(bits(solver.best));
    // 10 solves of 30 steps, every step scored and each solve's last twice, after the start
    expect(solver.evaluations).toBe(1 + 10 * 31);
    // the game's open run, paused between steps of 7
    const r = new OpenRun({ problem, ...options });
    const seen = await stepped(r, 7);
    const end = seen.at(-1)!;
    expect(end).toMatchObject({ ended: true, closed: false, evaluations: solver.evaluations, score: solver.score });
    expect(bits(end.best)).toEqual(bits(solver.best));
  });

  it("keep basin_hopping's penalty solves the solver's own, to the bit", async () => {
    // a small problem, where basin_hopping makes several penalty solves in 400 evaluations
    const small = { family: "polygon" as const, N: 4, M: 4, P: 9 };
    const pieces: Pose[] = [];
    for (let k = 0; k < small.P; k++) pieces.push(findFreeSpot(small.N, pieces, 0, 0));
    const start: PackingConfig = { ...small, pieces, container_phi: 0 };
    const options = {
      method: "basin_hopping",
      params: { seedEvals: 1, poolLimit: 0 },
      budget: { evals: 400 },
      seed: 2,
      start,
      finalPolish: false,
    };
    const solves: Record<string, unknown>[] = [];
    const game = await gameRun(small, options, (d) =>
      d.name === "penalty"
        ? {
            ...d,
            execute: (ctx) => {
              solves.push(ctx.params);
              return d.execute(ctx);
            },
          }
        : d,
    );
    const solver = await run(small, options);
    // the solves went through the game's definition, with the parameters basin_hopping passes
    expect(solves.length).toBeGreaterThanOrEqual(2);
    for (const p of solves) expect(p).toMatchObject({ evaluationInterval: 1, settleEvals: 0 });
    expect(game.evaluations).toBe(solver.evaluations);
    expect(game.score).toBe(solver.score);
    expect(bits(game.best)).toEqual(bits(solver.best));
    expect(game.trace.map(([, s]) => s)).toEqual(solver.trace.map(([, s]) => s));
    expect(game.stages.map(({ wallTime: _, ...s }) => s)).toEqual(solver.stages.map(({ wallTime: _, ...s }) => s));
    // and in the game's open run, paused between steps of 3
    const r = new OpenRun({ problem: small, ...options });
    const end = (await stepped(r, 3)).at(-1)!;
    expect(end).toMatchObject({ ended: true, evaluations: solver.evaluations, score: solver.score });
    expect(bits(end.best)).toEqual(bits(solver.best));
  });

  it("copy the solver's penalty in the squeeze: at an interval of 1 it is the solver's, to the bit", async () => {
    const start = await board;
    const options = { params: { innerIterations: 30 }, budget: { evals: 5000 }, seed: 3, start, finalPolish: false };
    const solver = await run(problem, { ...options, method: "penalty" });
    const squeeze = await gameRun(problem, { ...options, method: SQUEEZE });
    expect(squeeze.evaluations).toBe(solver.evaluations);
    expect(squeeze.score).toBe(solver.score);
    expect(bits(squeeze.best)).toEqual(bits(solver.best));
    expect(squeeze.trace.map(([, s]) => s)).toEqual(solver.trace.map(([, s]) => s));
  });

  it("score every 10th step in a squeeze: the same last packing in a tenth of the evaluations", async () => {
    const start = await board;
    const request = { problem, method: "penalty", budget: { evals: 5000 }, seed: 2, start };
    const every = (await stepped(new OpenRun({ ...request, params: { innerIterations: 30 } }), 50)).at(-1)!;
    const tenth = (
      await stepped(
        new OpenRun({ ...request, params: { innerIterations: 30, evaluationInterval: SQUEEZE_INTERVAL } }),
        1,
      )
    ).at(-1)!;
    expect(tenth.ended && !tenth.closed).toBe(true);
    // the start, then at most 3 scorings a solve (steps 10, 20 and 30), the last step not twice
    expect(tenth.evaluations).toBeLessThanOrEqual(1 + 10 * 3);
    expect(tenth.evaluations).toBeGreaterThan(10);
    // the L-BFGS path does not depend on the scoring: the same last packing, scored the same
    expect(tenth.last).toBe(every.last);
    // and nearly the same best, which every intermediate scoring can only lower
    expect(tenth.score!).toBeGreaterThanOrEqual(every.score!);
    expect(tenth.score!).toBeLessThanOrEqual(every.score! * (1 + 1e-6));
  });

  it("squeeze and settle in turn, one evaluation a step, until a cycle gains less than its tolerance", async () => {
    const start = await board;
    const tolerance = 1e-4;
    const params = { ...presetParams("penalty", 0), innerIterations: 30, settleEvals: 60, cycleTolerance: tolerance };
    const request = { problem, method: "penalty", params, budget: { evals: 5000 }, seed: 2, start };
    const seen = await stepped(new OpenRun(request), 1, 5000);
    const end = seen.at(-1)!;
    expect(end).toMatchObject({ ended: true, closed: false });
    expect(end.error).toBeUndefined();
    // it ended by its own rule, well before its budget
    expect(end.evaluations).toBeLessThan(request.budget.evals);
    const before: number[] = [];
    const after: number[] = [];
    const order: string[] = [];
    for (let i = 1; i < seen.length; i++) {
      const [a, b] = [seen[i - 1], seen[i]];
      // exactly one evaluation a step, across the squeeze and settle boundaries too
      if (!b.ended) expect(b.evaluations).toBe(a.evaluations + 1);
      // the board never grows
      expect(b.score!).toBeLessThanOrEqual(a.score!);
      const stage = b.stage ? `${b.stage.method}#${b.stage.count}` : "";
      if (stage && stage !== order.at(-1)) {
        order.push(stage);
        // a squeeze starts from the run's best: the best before it, and the best after the settle before it
        if (b.stage!.method === SQUEEZE) {
          if (b.stage!.count > 1) after.push(a.score!);
          before.push(a.score!);
        }
      }
    }
    after.push(seen.at(-2)!.score!);
    // squeeze 1, settle 1, squeeze 2, settle 2, …, ending with a settle
    expect(order.length).toBeGreaterThanOrEqual(2);
    order.forEach((s, i) => expect(s).toBe(`${i % 2 ? "mc_compress" : SQUEEZE}#${Math.floor(i / 2) + 1}`));
    expect(order.length % 2).toBe(0);
    // every cycle but the last shrank the best by more than the tolerance, and the last did not
    expect(after.length).toBe(before.length);
    for (let n = 0; n < before.length - 1; n++) expect(after[n]).toBeLessThan(before[n] * (1 - tolerance));
    expect(after.at(-1)!).toBeGreaterThanOrEqual(before.at(-1)! * (1 - tolerance));
    // the same run in one step: pausing between evaluations changes nothing
    const once = await new OpenRun(request).step(request.budget.evals);
    expect(once).toMatchObject({ ended: true, evaluations: end.evaluations, score: end.score });
    expect(bits(once.best)).toEqual(bits(end.best));
  });
});

describe("Tighter's penalty settings and texts", () => {
  it("squeeze every 10th step, repair by expansion and settle with mc_compress at every tuning level", () => {
    const steps = [undefined, 300, 400, 600];
    for (let l = 0; l <= 3; l++) {
      const p = presetParams("penalty", l);
      expect(p).toMatchObject({ evaluationInterval: 10, restoration: "expand", settleEvals: 1000 });
      expect(p.innerIterations).toBe(steps[l]);
      // a squeeze's evaluations are at most I + 1 only when I is a whole number of intervals
      const I = (resolvedParams("penalty", p).innerIterations as number) / SQUEEZE_INTERVAL;
      expect(Number.isInteger(I)).toBe(true);
    }
  });

  it("record the game's parameters with a board, which the server's provenance check accepts", () => {
    const params = resolvedParams("penalty", presetParams("penalty", 3));
    expect(params).toMatchObject({ evaluationInterval: 10, settleEvals: 1000, cycleTolerance: CYCLE_TOLERANCE });
    expect(utf8Length(JSON.stringify(params))).toBeLessThanOrEqual(MAX_METHOD_PARAMS_BYTES);
    const pieces: Pose[] = [];
    for (let k = 0; k < problem.P; k++) pieces.push(findFreeSpot(problem.N, pieces, 0, 0));
    const body = submissionBody({ ...problem, pieces, container_phi: 0 }, "test", {
      method: "penalty",
      params,
      seed: 7,
      budget: { evals: 1234 },
    });
    expect(body.method_params).toEqual(params);
    const parsed = parseProvenance(
      body,
      solverRegistry.list().map((m) => m.name),
    );
    expect(parsed.ok).toBe(true);
  });

  it("explain the squeeze and the settle with the numbers of the settings", () => {
    const card = UPGRADES.find((u) => u.id === "penalty")!;
    expect(card.effect).toMatch(/mc_compress between squeezes/);
    const text = [...(card.how.text as string[]), card.how.note ?? "", ...(card.how.math ?? []), ...(card.how.vars ?? []).flat()]
      .map(plain)
      .join("\n");
    expect(text).toContain(`After every ${SQUEEZE_INTERVAL}th step`);
    expect(text).toContain(`${SQUEEZE_SOLVES} solves`);
    expect(text).toContain(`at most ${SETTLE_EVALS.toLocaleString("en-US")} evaluations`);
    expect(text).toContain("10⁻⁶");
    expect(text).toContain("evaluations per squeeze ≤ I + 1");
    expect(text).toContain("the run ends when safter ≥ sbefore × (1 − 10−6)");
    expect(text).not.toMatch(/pushes the pieces apart|per run ≈/);
    // every variable of the formulas is defined
    for (const v of ["F", "s", "k", "gk", "λk", "w", "I", "sbefore", "safter"])
      expect((card.how.vars ?? []).map(([s]) => plain(s))).toContain(v);
  });

  it("word the tuning card for longer solves, from level 0 at the card's settings", () => {
    const tune = UPGRADES.find((u) => u.id === "tunePenalty")!;
    expect(tune.effect).toBe(methodGame("penalty").tuneEffect);
    expect(tune.how.math).toEqual(["<code>innerIterations</code> = 200, 300, 400, 600"]);
    const text = (tune.how.text as string[]).join(" ");
    expect(text).toContain("Level 0 is the settings on penalty's card.");
    expect(text).toContain("up to 1.5 times as long");
    expect(text).not.toMatch(/at least as much per evaluation/);
    expect(tune.how.vars).toEqual([
      ["<code>innerIterations</code>", "L-BFGS steps at most per solve (a squeeze makes 10 solves), at levels 0 to 3"],
    ]);
  });

  it("show the run's squeeze or settle, and why it ended", () => {
    const g = methodGame("penalty");
    expect(g.runNote!(view({}))).toBe("");
    expect(g.runNote!(view({ stage: { method: SQUEEZE, count: 2, at: 1203 } }))).toBe(" · squeeze 2");
    expect(g.runNote!(view({ stage: { method: "mc_compress", count: 2, at: 1404 } }))).toBe(
      " · settle 2 with mc_compress",
    );
    expect(g.endedText!(view({ evaluations: 3608, stage: { method: "mc_compress", count: 3, at: 2609 } }), "T")).toBe(
      "The penalty run on T ended after 3,608 evaluations, because squeeze 3 and the settle after it shrank the side by less than 10⁻⁶ (relative).",
    );
    // a run its budget ended keeps the shared sentence
    expect(
      g.endedText!(view({ evaluations: 100_000, stage: { method: SQUEEZE, count: 9, at: 99_000 } }), "T"),
    ).toBeNull();
    expect(g.runEnds).toContain("mc_compress");
  });
});
