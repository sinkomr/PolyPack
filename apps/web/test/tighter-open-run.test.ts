import { describe, expect, it } from "vitest";
import { evaluate, findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { run } from "@polypack/solver";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import type { OpenRunRequest } from "../src/tighter/open-run";
import { createRunHost } from "../src/tighter/run-host";
import type { HostReply } from "../src/tighter/run-host";

// A click is one evaluation of a run that stays open: these tests check that the open run does
// exactly the evaluations it is allowed, and that pausing it between clicks changes nothing.

const problem = { N: 21, M: 24, P: 40 };

function loadAll(): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < problem.P; k++) pieces.push(findFreeSpot(problem.N, pieces, 0, 0));
  return { ...problem, pieces, container_phi: 0 };
}

const request = (over: Partial<OpenRunRequest> = {}): OpenRunRequest => ({
  problem,
  method: "mc_compress",
  params: {},
  budget: { evals: 5000 },
  seed: 1,
  start: loadAll(),
  ...over,
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Tighter open runs", () => {
  it("score the start when they open: the run's first evaluation", async () => {
    const req = request();
    const r = new OpenRun(req);
    const s = await r.step(0);
    expect(s.evaluations).toBe(1);
    expect(s.ended).toBe(false);
    // the start, with the container at its best angle, as the server scores it
    expect(s.score).toBe(evaluate(req.start, { autoOrient: true }).score);
    expect(s.best!.pieces).toEqual(req.start.pieces);
    await r.close();
  });

  it("do exactly the evaluations they are allowed, and pausing between them changes nothing", async () => {
    const req = request();
    const r = new OpenRun(req);
    let s = await r.step(100);
    expect(s.evaluations).toBe(101);
    const compact = s.score!;
    for (let i = 1; i <= 50; i++) {
      const before = s.score!;
      s = await r.step(1);
      expect(s.evaluations).toBe(101 + i);
      // the side never grows
      expect(s.score!).toBeLessThanOrEqual(before);
    }
    expect(s.score!).toBeLessThan(compact);
    // paused: nothing runs ahead of the clicks
    await tick(40);
    expect(r.state().evaluations).toBe(151);
    const closed = await r.close();
    expect(closed).toMatchObject({ ended: true, closed: true, evaluations: 151 });
    // the same run, closed at the same count: the same packing to the last bit
    const replay = await run(problem, {
      method: "mc_compress",
      start: req.start,
      seed: 1,
      budget: { evals: 151 },
      finalPolish: false,
    });
    expect(replay.evaluations).toBe(151);
    expect(closed.best!.pieces).toEqual(replay.best!.pieces);
    expect(closed.score).toBe(replay.score);
  });

  it("answer at once once they have ended by themselves", async () => {
    const r = new OpenRun(request({ budget: { evals: 30 } }));
    const s = await r.step(100);
    expect(s).toMatchObject({ ended: true, closed: false, evaluations: 30 });
    expect(s.best).not.toBeNull();
    const again = await r.step(5);
    expect(again).toMatchObject({ ended: true, evaluations: 30 });
    expect(again.score).toBe(s.score);
  });

  it("end when closed, and take no more steps", async () => {
    const r = new OpenRun(request());
    await r.step(3);
    const s = await r.close();
    expect(s).toMatchObject({ ended: true, closed: true, evaluations: 4 });
    expect(await r.step(10)).toMatchObject({ ended: true, evaluations: 4 });
  });

  it("report a run that ended by itself as not closed, even when it is closed afterwards", async () => {
    // a budget of 3: the start and two evaluations, then the run ends by itself
    const r = new OpenRun(request({ budget: { evals: 3 } }));
    const s = await r.step(10);
    expect(s.ended).toBe(true);
    expect(s.closed).toBe(false);
    expect((await r.close()).closed).toBe(false);
    const c = new OpenRun(request());
    await c.step(5);
    expect((await c.close()).closed).toBe(true);
  });

  it("record the method's parameters as the solver resolves them", () => {
    const p = resolvedParams("mc_compress", { sweepsPerEvaluation: 5 });
    expect(p).toMatchObject({ sweepsPerEvaluation: 5, translationStep: 0.15, shrinkFraction: 0.01 });
    expect(resolvedParams("basin_hopping", {})).toMatchObject({ localEvals: 150 });
    expect(() => resolvedParams("warp", {})).toThrow(/unknown method/);
    const r = new OpenRun(request({ params: { sweepsPerEvaluation: 2 } }));
    expect(r.params).toMatchObject({ sweepsPerEvaluation: 2, rotationStep: 0.15 });
    void r.close();
  });
});

describe("Tighter run host", () => {
  function host() {
    const replies: HostReply[] = [];
    const waiting: { test: (r: HostReply) => boolean; resolve: (r: HostReply) => void }[] = [];
    const h = createRunHost((reply) => {
      replies.push(reply);
      for (const w of [...waiting])
        if (w.test(reply)) {
          waiting.splice(waiting.indexOf(w), 1);
          w.resolve(reply);
        }
    });
    const next = (test: (r: HostReply) => boolean) =>
      new Promise<HostReply>((resolve) => {
        const seen = replies.find(test);
        if (seen) resolve(seen);
        else waiting.push({ test, resolve });
      });
    return { h, next };
  }

  it("opens, steps and closes a run, and answers a step for no open run with an error", async () => {
    const { h, next } = host();
    h.handle({ type: "open", id: 1, request: request() });
    const opened = await next((r) => r.type === "opened");
    expect(opened).toMatchObject({ type: "opened", id: 1, state: { evaluations: 1, ended: false } });
    expect(opened.type === "opened" && opened.params).toMatchObject({ sweepsPerEvaluation: 10 });
    h.handle({ type: "step", id: 1, step: 7, evals: 3 });
    const stepped = await next((r) => r.type === "stepped");
    expect(stepped).toMatchObject({ type: "stepped", id: 1, step: 7, state: { evaluations: 4 } });
    expect(stepped.type === "stepped" && stepped.ms).toBeGreaterThanOrEqual(0);
    h.handle({ type: "step", id: 99, step: 8, evals: 1 });
    expect(await next((r) => r.type === "error" && r.id === 99)).toMatchObject({ type: "error", id: 99, step: 8 });
    h.handle({ type: "close", id: 1 });
    expect(await next((r) => r.type === "closed")).toMatchObject({
      type: "closed",
      id: 1,
      state: { ended: true, closed: true, evaluations: 4 },
    });
    // the run is gone: its steps are errors now
    h.handle({ type: "step", id: 1, step: 9, evals: 1 });
    expect(await next((r) => r.type === "error" && r.id === 1)).toMatchObject({ step: 9 });
  });

  it("closes the run it held when another opens", async () => {
    const { h, next } = host();
    h.handle({ type: "open", id: 1, request: request() });
    await next((r) => r.type === "opened" && r.id === 1);
    h.handle({ type: "open", id: 2, request: request({ seed: 2 }) });
    expect(await next((r) => r.type === "opened" && r.id === 2)).toMatchObject({ state: { evaluations: 1 } });
    h.handle({ type: "step", id: 1, step: 1, evals: 1 });
    expect(await next((r) => r.type === "error" && r.id === 1)).toMatchObject({ step: 1 });
    h.handle({ type: "close", id: 2 });
    await next((r) => r.type === "closed" && r.id === 2);
  });

  it("reports a run that cannot start", async () => {
    const { h, next } = host();
    h.handle({ type: "open", id: 3, request: request({ method: "warp" }) });
    expect(await next((r) => r.id === 3)).toMatchObject({ type: "error", id: 3 });
  });
});
