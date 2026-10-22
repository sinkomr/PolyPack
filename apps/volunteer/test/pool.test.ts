/**
 * The worker pool. Real solver jobs end on an evaluation cap or by completing, with a time budget
 * that is only a ceiling, so that their outcome does not depend on the machine's speed. The pause,
 * abort and watchdog rules are checked with scripted threads, which answer only to messages.
 */
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerPool, defaultRespawnDelayMs, defaultWatchdogSeconds } from "../src/pool";
import type { Control, Job } from "../src/types";

const control = (): Control => ({ aborted: false, paused: false });
const tiny: Job = {
  problem: { N: 4, M: 4, P: 3 },
  method: "asc",
  seed: 1,
  budget: { time_s: 300, evals: 20_000 },
  kind: "fresh",
};
// a problem that asc works on until its budget ends: only an abort ends this one in time
const endless: Job = {
  problem: { N: 5, M: 5, P: 20 },
  method: "asc",
  seed: 1,
  budget: { time_s: 3600 },
  kind: "fresh",
};

/** A thread that answers a job only when told to resume or abort; its answer lists the messages it saw. */
const SCRIPTED = `
const { parentPort } = require("node:worker_threads");
let seen = [];
let id = null;
parentPort.on("message", (m) => {
  if (m.type === "run") { id = m.id; seen = []; }
  seen.push(m.type);
  if (m.type === "resume" || m.type === "abort")
    parentPort.postMessage({ type: "result", id, result: { score: null, valid: false, strict: false,
      evaluations: 0, wallTime: 0, termination: "scripted", reasons: seen.slice() } });
});`;
/** A thread that answers every job at once. */
const ANSWERS = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (m) => {
  if (m.type === "run") parentPort.postMessage({ type: "result", id: m.id, result: { score: null, valid: false,
    strict: false, evaluations: 0, wallTime: 0, termination: "scripted", reasons: [] } });
});`;
const thread = (code: string) => () => new Worker(code, { eval: true });

let pool: WorkerPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe("the worker pool", () => {
  it("has the watchdog limit of the contract, and a respawn backoff up to 60 s", () => {
    expect(defaultWatchdogSeconds({ ...tiny, budget: { time_s: 30 } })).toBe(150);
    expect([1, 2, 3, 8, 20].map(defaultRespawnDelayMs)).toEqual([500, 1000, 2000, 60_000, 60_000]);
  });

  // Real solver work in a real thread: building the thread bundle and one evaluation-capped job.
  it("runs a real job in a real thread", { timeout: 60_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal" });
    const r = await pool.runJob(tiny, control());
    expect(r.job).toBe(tiny); // the engine's own object comes back
    expect(r.valid).toBe(true);
    expect(r.strict).toBe(true);
    expect(r.score).toBeCloseTo(2, 6);
    expect(r.best?.pieces).toHaveLength(3);
    expect(["completed", "evals"]).toContain(r.termination);
  });

  // Real solver work: a job of an hour that only the abort can end within the test's timeout.
  it(
    "aborts a running job, and resolves an unknown method as an error, never rejecting",
    { timeout: 60_000 },
    async () => {
      pool = await WorkerPool.create({ size: 1, priority: "normal" });
      const c = control();
      const running = pool.runJob(endless, c);
      setTimeout(() => (c.aborted = true), 300);
      expect((await running).termination).toBe("aborted");

      expect((await pool.runJob(tiny, { aborted: true, paused: false })).termination).toBe("aborted");
      const bad = await pool.runJob({ ...tiny, method: "no-such-method" }, control());
      expect(bad.termination).toBe("error");
      expect(bad.reasons[0]).toMatch(/no-such-method/);
    },
  );

  it(
    "pauses: queued jobs wait, and the running job's thread is told to pause and resume",
    { timeout: 10_000 },
    async () => {
      pool = await WorkerPool.create({ size: 1, priority: "normal", spawn: thread(SCRIPTED) });
      const running = pool.runJob(tiny, control());
      pool.setPaused(true);
      const queued = pool.runJob({ ...tiny, seed: 2 }, control());
      expect(pool.stats()).toMatchObject({ lanes: 1, busy: 0, paused: 1, queued: 1 });
      pool.setPaused(false);
      expect((await running).reasons).toEqual(["run", "pause", "resume"]);
      // the queued job started only after the resume, and was never paused
      expect(pool.stats()).toMatchObject({ busy: 1, paused: 0, queued: 0 });
      pool.stop();
      expect((await queued).reasons).toEqual(["run", "abort"]);
    },
  );

  it("forwards a job's own abort to its thread", { timeout: 10_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", spawn: thread(SCRIPTED), tickMs: 5 });
    const c = control();
    const running = pool.runJob(tiny, c);
    c.aborted = true;
    expect((await running).reasons).toEqual(["run", "abort"]);
  });

  // Real solver work: a job of 1 s of active time, paused for 2 s from its start. Its own wall time,
  // measured in the thread from the job's start, is then about 3 s; unpaused it would be about 1 s.
  // The thread is warmed up first, so that its start-up does not eat into the pause.
  it("stops a real job's clock while it is paused", { timeout: 60_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
    expect((await pool.runJob(tiny, control())).valid).toBe(true);
    const running = pool.runJob({ ...endless, budget: { time_s: 1 } }, control());
    pool.setPaused(true);
    await new Promise((r) => setTimeout(r, 2000));
    pool.setPaused(false);
    const r = await running;
    expect(r.termination).toBe("time");
    expect(r.wallTime).toBeGreaterThan(2);
  });

  it("replaces a thread that never answers, and the job resolves as crashed", { timeout: 10_000 }, async () => {
    let spawned = 0;
    pool = await WorkerPool.create({
      size: 1,
      priority: "normal",
      tickMs: 10,
      watchdogSeconds: () => 0.2,
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
      respawnDelayMs: () => 1,
      spawn: thread("require('node:worker_threads').parentPort.on('message', () => { throw new Error('boom') })"),
    });
    const r = await pool.runJob(tiny, control());
    expect(r.termination).toBe("crashed");
    expect(r.reasons[0]).toMatch(/boom/);
  });

  // Fix 7: a thread that dies as it starts is not started again in a tight loop forever.
  it(
    "backs off between restarts, and gives up when threads keep dying before any job",
    { timeout: 10_000 },
    async () => {
      const logs: string[] = [];
      const fatal: string[] = [];
      const delays: number[] = [];
      let spawned = 0;
      pool = await WorkerPool.create({
        size: 1,
        priority: "normal",
        log: (m) => logs.push(m),
        onFatal: (m) => fatal.push(m),
        respawnDelayMs: (failures) => {
          delays.push(failures);
          return 5;
        },
        spawn: () => {
          spawned++;
          return new Worker("process.exit(1)", { eval: true });
        },
      });
      // the first job goes to the first thread, and dies with it
      const r = await pool.runJob(tiny, control());
      expect(r.termination).toBe("crashed");
      expect(r.reasons[0]).toMatch(/exited with code 1/);
      while (fatal.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fatal[0]).toMatch(/stopped 5 times before finishing any job/);
      expect(spawned).toBe(5);
      expect(delays).toEqual([1, 2, 3, 4]); // the backoff grows with each death in a row
      expect(logs.filter((l) => /exited with code 1; starting a new one in/.test(l))).toHaveLength(4);
      expect(pool.failure).toMatch(/stopped 5 times/);
      expect((await pool.runJob(tiny, control())).termination).toBe("crashed");
    },
  );

  it("keeps restarting a thread that dies after jobs have finished", { timeout: 10_000 }, async () => {
    const fatal: string[] = [];
    const logs: string[] = [];
    pool = await WorkerPool.create({
      size: 1,
      priority: "normal",
      log: (m) => logs.push(m),
      onFatal: (m) => fatal.push(m),
      respawnDelayMs: () => 1,
      // answers a job, then dies
      spawn: thread(`
        const { parentPort } = require("node:worker_threads");
        parentPort.on("message", (m) => {
          if (m.type !== "run") return;
          parentPort.postMessage({ type: "result", id: m.id, result: { score: null, valid: false, strict: false,
            evaluations: 0, wallTime: 0, termination: "scripted", reasons: [] } });
          setTimeout(() => process.exit(1), 5);
        });`),
    });
    const deaths = () => logs.filter((l) => /exited with code 1/.test(l)).length;
    // each job goes to a live thread: the next one starts once the pool has seen the last thread die
    for (let i = 0; i < 8; i++) {
      expect((await pool.runJob(tiny, control())).termination).toBe("scripted");
      while (deaths() <= i) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fatal).toEqual([]);
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

  it("serves many jobs on few threads in order", { timeout: 10_000 }, async () => {
    pool = await WorkerPool.create({ size: 2, priority: "normal", spawn: thread(ANSWERS) });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, seed) => pool!.runJob({ ...tiny, seed }, control())),
    );
    expect(results.map((r) => r.job.seed)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
