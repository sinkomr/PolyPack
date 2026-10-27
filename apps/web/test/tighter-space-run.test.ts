import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { checkSpaceConfig, parseSearchProblem, spaceKernel } from "@polypack/spaces/search";
import { createRunHost } from "../src/tighter/run-host";
import type { HostReply } from "../src/tighter/run-host";
import { Lane } from "../src/tighter/lanes";
import type { OpenRunRequest } from "../src/tighter/open-run";
import { SpaceRunControl } from "../src/tighter/space-control";
import { SpaceRun, spaceStart } from "../src/tighter/space-run";
import type { SpaceRunRequest, SpaceRunState } from "../src/tighter/space-run-types";

// A space run is one generic method on a kernel that stays open between clicks: these tests check
// that it does what it is allowed and no more, that holds and closes work through the shared
// control, and that pausing changes nothing in a seeded run. Under Node the run's own thread can
// be driven from the poll's callback, which runs on it just before it blocks.

const SPHERE = "sphere/0/9";
const FOLD = "surface/cube/fold/3/6";
const BALLS = "balls/ballinball/6";

const request = (
  family: SpaceRunRequest["family"],
  id: string,
  over: Partial<SpaceRunRequest> = {},
): SpaceRunRequest => ({
  family,
  id,
  method: "mc_compress",
  params: {},
  budget: { evals: 30 },
  unit: 20,
  seed: 4,
  start: null,
  ...over,
});

/** Runs to its end, allowing `size(n)` game evaluations at the nth pause (0 ends the run); returns the pauses' states. */
function drive(req: SpaceRunRequest, size: (n: number) => number) {
  const control = new SpaceRunControl();
  const pauses: { target: number; state: SpaceRunState }[] = [];
  let total = 0;
  const allow = () => {
    const k = size(pauses.length);
    if (k <= 0) control.abort();
    else control.allow((total += k) * req.unit);
  };
  const run = new SpaceRun(req, control, {
    progress: () => undefined,
    stepped: (target, state) => {
      if (state.ended) return;
      pauses.push({ target, state });
      allow();
    },
  });
  allow();
  return { final: run.run(), pauses };
}

describe("Tighter space runs", () => {
  it("do exactly the evaluations a step allows, to at most one charge over", () => {
    const unit = 20;
    const req = request("sphere", SPHERE, { unit, budget: { evals: 40 } });
    const k = spaceKernel(parseSearchProblem(SPHERE)!)!;
    const charge = k.finishCost + (k.validateCost ?? k.finishCost) + (k.gradCost ?? 1);
    const { final, pauses } = drive(req, () => 3);
    expect(pauses.length).toBeGreaterThan(3);
    pauses.forEach((p, i) => {
      expect(p.target).toBe(3 * (i + 1));
      // kernel evaluations done: at least what was allowed, and not more than a charge beyond it
      expect(p.state.evaluations).toBeGreaterThanOrEqual(p.target);
      expect(p.state.evaluations * unit).toBeLessThanOrEqual(p.target * unit + charge + unit);
      expect(p.state.ended).toBe(false);
    });
    expect(final.ended).toBe(true);
    expect(final.closed).toBe(false);
    expect(final.error).toBeUndefined();
  });

  it("ends when closed, with the best so far, valid and strict", () => {
    const req = request("sphere", SPHERE, { budget: { evals: 10_000 } });
    const { final, pauses } = drive(req, (n) => (n < 4 ? 5 : 0));
    expect(pauses.length).toBe(4);
    expect(final.ended).toBe(true);
    expect(final.closed).toBe(true);
    expect(final.evaluations).toBeLessThan(10_000);
    expect(final.best).not.toBeNull();
    const c = checkSpaceConfig("sphere", SPHERE, final.best, { noRecord: true });
    expect(c.valid).toBe(true);
    expect(c.score).toBe(final.score);
  });

  it("stop at a hold: nothing is done while held, and a close still ends the run", async () => {
    const req = request("sphere", SPHERE, { budget: { evals: 10_000 } });
    const control = new SpaceRunControl();
    control.allow(1000 * req.unit);
    control.hold(true);
    // another thread ends the run after 150 ms (it works on the control's memory directly)
    const helper = new Worker(
      `const { workerData: b } = require("node:worker_threads");
       const a = new Int32Array(b);
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
       Atomics.store(a, 1, 1); Atomics.add(a, 3, 1); Atomics.notify(a, 3);`,
      { eval: true, workerData: control.buffer },
    );
    const t = performance.now();
    const run = new SpaceRun(req, control, { progress: () => undefined, stepped: () => undefined });
    const final = run.run();
    const ms = performance.now() - t;
    await helper.terminate();
    expect(ms).toBeGreaterThanOrEqual(100);
    expect(final.evaluations).toBe(0);
    expect(final.closed).toBe(true);
    expect(final.ended).toBe(true);
  });

  it.each([
    ["sphere", SPHERE],
    ["surface", FOLD],
  ] as const)("stepped one at a time end where larger steps do, on %s", (family, id) => {
    const start = spaceStart({ family, id, seed: 7 });
    expect(start.ok).toBe(true);
    const req = request(family, id, {
      budget: { evals: 25 },
      unit: 10,
      start: start.ok ? start.config : null,
    });
    const one = drive(req, () => 1);
    const big = drive(req, () => 7);
    expect(one.pauses.length).toBeGreaterThan(big.pauses.length);
    expect(one.final.score).toBe(big.final.score);
    expect(one.final.best).toEqual(big.final.best);
    expect(one.final.evaluations).toBe(big.final.evaluations);
    expect(one.final.found).toBe(big.final.found);
    // never worse than the start
    if (start.ok) expect(one.final.score).toBeLessThanOrEqual(start.score);
  });

  it("report the start as the first best, and the latest and best finds", () => {
    const start = spaceStart({ family: "sphere", id: SPHERE, seed: 3 });
    if (!start.ok) throw new Error(start.message);
    const req = request("sphere", SPHERE, { start: start.config, budget: { evals: 20 } });
    const control = new SpaceRunControl();
    const run = new SpaceRun(req, control, { progress: () => undefined, stepped: () => undefined });
    const s0 = run.state();
    expect(s0.score).toBe(start.score);
    expect(s0.best).toEqual(start.config);
    expect(s0.evaluations).toBe(0);
    expect(s0.found).toBeNull();
    control.allow(20 * req.unit);
    const final = run.run();
    expect(final.ended).toBe(true);
    expect(final.last).not.toBeNull();
    if (final.found !== null) expect(final.found).toBeGreaterThanOrEqual(final.score!);
  });

  it("refuse what they cannot run", () => {
    const sink = { progress: () => undefined, stepped: () => undefined };
    const c = new SpaceRunControl();
    expect(() => new SpaceRun(request("sphere", "sphere/0/9", { method: "auto" }), c, sink)).toThrow();
    expect(() => new SpaceRun(request("sphere", "torus/sq/0/9"), c, sink)).toThrow();
    expect(() => new SpaceRun(request("sphere", SPHERE, { method: "nope" }), c, sink)).toThrow();
    expect(() => new SpaceRun(request("sphere", SPHERE, { unit: 0 }), c, sink)).toThrow();
  });

  it("make a strict valid start on a sphere, a ball and a folded surface problem", () => {
    for (const [family, id] of [
      ["sphere", SPHERE],
      ["balls", BALLS],
      ["surface", FOLD],
    ] as const) {
      const a = spaceStart({ family, id, seed: 1 });
      expect(a.ok, id).toBe(true);
      if (!a.ok) continue;
      const c = checkSpaceConfig(parseSearchProblem(id)!.space, id, a.config, { noRecord: true });
      expect(c.valid, id).toBe(true);
      expect(c.score, id).toBe(a.score);
    }
    expect(spaceStart({ family: "sphere", id: "nonsense", seed: 1 }).ok).toBe(false);
  });
});

describe("Tighter space runs and their finishes", () => {
  it("report every finish whose cost was counted, stepped one game evaluation at a time", () => {
    // a ball packing's finish costs 1144 kernel evaluations: 57 game evaluations of 20
    const unit = 20;
    const k = spaceKernel(parseSearchProblem(BALLS)!)!;
    expect(k.finishCost).toBeGreaterThan(10 * unit);
    const req = request("balls", BALLS, { budget: { evals: 150 }, unit, seed: 3 });
    const one = drive(req, () => 1);
    const free = drive(req, () => 10_000);
    expect(one.pauses.length).toBeGreaterThan(20);
    let best = Infinity;
    for (const p of one.pauses) {
      // a pause is never inside a finish: once the evaluations of a finish are counted, its result is in the state
      if (p.state.evaluations * unit >= k.finishCost) expect(p.state.last).not.toBeNull();
      if (p.state.score !== null) {
        expect(p.state.score).toBeLessThanOrEqual(best);
        best = p.state.score;
      }
    }
    expect(one.final.score).toBe(free.final.score);
    expect(one.final.best).toEqual(free.final.best);
    expect(one.final.evaluations).toBe(free.final.evaluations);
    expect(one.final.found).toBe(free.final.found);
  });

  it("end, not block, when allowed exactly their budget", () => {
    const req = request("sphere", SPHERE, { budget: { evals: 30 }, unit: 20 });
    const { final, pauses } = drive(req, () => 30);
    expect(pauses).toHaveLength(0);
    expect(final.ended).toBe(true);
    expect(final.closed).toBe(false);
    expect(final.error).toBeUndefined();
  });
});

describe("Tighter lanes closed while opening", () => {
  class FakeWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    postMessage() {}
    terminate() {}
  }
  const realWorker = (globalThis as { Worker?: unknown }).Worker;
  const realIsolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = realIsolated;
  });

  it("answer the opening as closed and open again", async () => {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    const lane = new Lane(0);
    const space = request("sphere", SPHERE);
    const first = lane.openSpace(space);
    expect(lane.pending).toBe(1);
    void lane.close();
    expect(await first).toEqual({ ok: false, message: "closed while opening" });
    expect(lane.pending).toBe(0);
    // the next open is a new opening, not refused as "a run is being opened"
    void lane.openSpace(space);
    expect(lane.pending).toBe(1);
    void lane.close();
    const polygon = lane.openRun({} as OpenRunRequest);
    void lane.close();
    expect(await polygon).toEqual({ ok: false, message: "closed while opening" });
    void lane.openRun({} as OpenRunRequest);
    expect(lane.pending).toBe(1);
    lane.terminate();
  });
});

describe("Tighter space runs in the run host", () => {
  it("open, step through the shared control, answer each pause, and close", () => {
    const replies: HostReply[] = [];
    const control = new SpaceRunControl();
    const host = createRunHost((r) => {
      // (progress, at most ten times a second, is not what this checks)
      if (r.type !== "progress") replies.push(r);
      if (r.type === "opened") control.allow(5 * 20);
      // the run is paused at 5 game evaluations: end it
      if (r.type === "space-stepped" && !r.state.ended) control.abort();
    });
    host.handle({
      type: "open-space",
      id: 1,
      request: request("sphere", SPHERE, { budget: { evals: 500 } }),
      control: control.buffer,
    });
    expect(replies.map((r) => r.type)).toEqual(["opened", "space-stepped", "space-stepped"]);
    const stepped = replies[1] as Extract<HostReply, { type: "space-stepped" }>;
    expect(stepped.target).toBe(5);
    expect(stepped.state.kind).toBe("space");
    const ended = replies[2] as Extract<HostReply, { type: "space-stepped" }>;
    expect(ended.target).toBe(Infinity);
    expect(ended.state.closed).toBe(true);
    host.handle({ type: "close", id: 1 });
    const closed = replies[3] as Extract<HostReply, { type: "closed" }>;
    expect(closed.type).toBe("closed");
    expect(closed.state.ended).toBe(true);
  });

  it("answer a refused open with an error, and a start request with a start", () => {
    const replies: HostReply[] = [];
    const host = createRunHost((r) => replies.push(r));
    host.handle({
      type: "open-space",
      id: 2,
      request: request("sphere", "sphere/zzz"),
      control: new SpaceRunControl().buffer,
    });
    expect(replies[0].type).toBe("error");
    host.handle({ type: "space-start", id: 3, request: { family: "sphere", id: SPHERE, seed: 2 } });
    const started = replies[1] as Extract<HostReply, { type: "started" }>;
    expect(started.type).toBe("started");
    expect(started.answer.ok).toBe(true);
  });
});
