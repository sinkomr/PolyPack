import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerPool, defaultWatchdogSeconds } from "../src/pool";
import type { Control, Job } from "../src/types";

const control = (): Control => ({ aborted: false, paused: false });
const tiny: Job = { problem: { N: 4, M: 4, P: 3 }, method: "asc", seed: 1, budget: { time_s: 2 }, kind: "fresh" };
// a problem that asc works on for its whole budget (tiny problems finish in well under a second)
const long = (time_s: number): Job => ({
  problem: { N: 5, M: 5, P: 20 },
  method: "asc",
  seed: 1,
  budget: { time_s },
  kind: "fresh",
});

let pool: WorkerPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe("the worker pool", () => {
  it("has the watchdog limit of the contract", () => {
    expect(defaultWatchdogSeconds(long(30))).toBe(150);
  });

  // Real solver work in real threads: building the thread bundle and the run take a few seconds.
  it("runs a real job in a real thread", { timeout: 30_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal" });
    const r = await pool.runJob(tiny, control());
    expect(r.job).toBe(tiny); // the engine's own object comes back
    expect(r.valid).toBe(true);
    expect(r.strict).toBe(true);
    expect(r.score).toBeCloseTo(2, 6);
    expect(r.best?.pieces).toHaveLength(3);
    expect(r.termination).toBe("completed");
  });

  // Real solver work: one 30 s job aborted after half a second, then two short ones on one lane.
  it(
    "aborts a running job, and resolves an unknown method as an error, never rejecting",
    { timeout: 30_000 },
    async () => {
      pool = await WorkerPool.create({ size: 1, priority: "normal" });
      const c = control();
      const started = performance.now();
      const running = pool.runJob(long(30), c);
      setTimeout(() => (c.aborted = true), 500);
      const r = await running;
      expect(r.termination).toBe("aborted");
      expect(performance.now() - started).toBeLessThan(5000);
      expect(r.valid).toBe(true); // its best so far

      const queuedAborted = { aborted: true, paused: false };
      expect((await pool.runJob(tiny, queuedAborted)).termination).toBe("aborted");
      const bad = await pool.runJob({ ...tiny, method: "no-such-method" }, control());
      expect(bad.termination).toBe("error");
      expect(bad.reasons[0]).toMatch(/no-such-method/);
    },
  );

  // Real solver work: a 1 s job paused for 1.5 s must take at least 2.5 s and still end on time.
  it("pauses: queued jobs wait and running jobs stop their clock", { timeout: 30_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
    const started = performance.now();
    const running = pool.runJob(long(1), control());
    await new Promise((r) => setTimeout(r, 300));
    pool.setPaused(true);
    let queuedDone = false;
    const queued = pool.runJob(tiny, control()).then((r) => ((queuedDone = true), r));
    expect(pool.stats()).toMatchObject({ lanes: 1, busy: 0, paused: 1, queued: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(queuedDone).toBe(false);
    pool.setPaused(false);
    const r = await running;
    expect(r.termination).toBe("time");
    expect(performance.now() - started).toBeGreaterThan(2500);
    expect((await queued).valid).toBe(true);
    expect(pool.stats()).toMatchObject({ busy: 0, paused: 0, idle: 1, queued: 0 });
  });

  it("replaces a thread that never answers, and the job resolves as crashed", { timeout: 10_000 }, async () => {
    let spawned = 0;
    pool = await WorkerPool.create({
      size: 1,
      priority: "normal",
      tickMs: 10,
      watchdogSeconds: () => 0.2,
      // a thread that takes jobs and never answers
      spawn: () => {
        spawned++;
        return new Worker("require('node:worker_threads').parentPort.on('message', () => {})", { eval: true });
      },
    });
    const r = await pool.runJob(tiny, control());
    expect(r.termination).toBe("crashed");
    expect(r.reasons[0]).toMatch(/no answer within/);
    expect(spawned).toBe(2);
  });

  it("replaces a thread that dies, and the job resolves as crashed", { timeout: 10_000 }, async () => {
    pool = await WorkerPool.create({
      size: 1,
      priority: "normal",
      spawn: () =>
        new Worker("require('node:worker_threads').parentPort.on('message', () => { throw new Error('boom') })", {
          eval: true,
        }),
    });
    const r = await pool.runJob(tiny, control());
    expect(r.termination).toBe("crashed");
    expect(r.reasons[0]).toMatch(/boom/);
  });

  it("ends queued and running jobs as aborted when it stops or closes", { timeout: 10_000 }, async () => {
    pool = await WorkerPool.create({
      size: 1,
      priority: "normal",
      spawn: () => new Worker("require('node:worker_threads').parentPort.on('message', () => {})", { eval: true }),
    });
    const first = pool.runJob(tiny, control());
    const second = pool.runJob(tiny, control());
    pool.stop();
    expect((await second).termination).toBe("aborted");
    expect((await pool.runJob(tiny, control())).termination).toBe("aborted");
    await pool.close();
    expect((await first).termination).toBe("aborted");
  });
});
