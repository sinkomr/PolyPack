/**
 * Space jobs in the worker pool's real threads. Their searches are synchronous, so stopping and
 * pausing go through the flags the pool shares with each thread (pool.ts, worker.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { WorkerPool } from "../src/pool";
import type { SpaceJob } from "../src/spaces/run";
import type { Control } from "../src/types";
import { ballsTestPacking, enlarged, recordConfig } from "./spaces-fixtures";

const control = (): Control => ({ aborted: false, paused: false });
const sphereJob = (o: Partial<SpaceJob> = {}): SpaceJob => ({
  space: "sphere",
  id: "sphere/3/13",
  method: "sphere basin hopping",
  seed: 1,
  budget: { time_s: 60, evals: 400 },
  kind: "iterate",
  start: enlarged("sphere", recordConfig("sphere", "sphere/3/13"), 1.01),
  ...o,
});
// without a start or an evaluation cap, only the time budget or an abort ends this one
const endless = (time_s: number): SpaceJob => ({
  space: "sphere",
  id: "sphere/0/30",
  method: "sphere basin hopping",
  seed: 1,
  budget: { time_s },
  kind: "fresh",
});

let pool: WorkerPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe("space jobs in the worker pool", () => {
  it("runs a real space job in a real thread", { timeout: 60_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
    const job = sphereJob();
    const r = await pool.runSpaceJob(job, control());
    expect(r.job).toBe(job);
    expect(r.valid).toBe(true);
    expect(r.score!).toBeLessThan((job.start!.rho as number) * 0.995);
    expect(r.termination).toBe("evals");
  });

  it("aborts a running space job through the shared flags", { timeout: 60_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
    const c = control();
    const running = pool.runSpaceJob(endless(3600), c);
    await new Promise((r) => setTimeout(r, 800));
    const t = Date.now();
    c.aborted = true;
    const r = await running;
    expect(r.termination).toBe("aborted");
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("does not count a pause in a space job's time", { timeout: 60_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
    const t = Date.now();
    const running = pool.runSpaceJob(endless(1.5), control());
    await new Promise((r) => setTimeout(r, 300));
    pool.setPaused(true);
    await new Promise((r) => setTimeout(r, 1500));
    pool.setPaused(false);
    const r = await running;
    const wall = (Date.now() - t) / 1000;
    expect(r.termination).toBe("time");
    expect(wall).toBeGreaterThan(2.8);
    // active seconds: the budget, not the wall time with the pause
    expect(r.wallTime).toBeLessThan(wall - 1);
  });

  // Review D2: the largest catalogue problems, whose searches once ran 10 to 23 s without a check.
  // A fresh curved job of seed 3 on curved/-1/3/8/29 spent 21 s in its first restart; a surface
  // job of 2 s on 76 triangles is in its final polish from 1.6 s on. The polyhedra jobs are 100 of
  // the largest solids at the cap P = 100: a soft hop of 100 truncated icosidodecahedra takes about
  // 50 s, and a fresh run of 100 pentagonal hexecontahedra minutes, both polled at every step.
  const largest: [string, SpaceJob][] = [
    [
      "a fresh curved job on curved/-1/3/8/29",
      {
        space: "curved",
        id: "curved/-1/3/8/29",
        method: "curved search",
        seed: 3,
        budget: { time_s: 60 },
        kind: "fresh",
      },
    ],
    [
      "a surface job on surface/icosahedron/fold/3/76 in its final polish",
      {
        space: "surface",
        id: "surface/icosahedron/fold/3/76",
        method: "surface fold search",
        seed: 11,
        budget: { time_s: 2 },
        kind: "iterate",
        start: recordConfig("surface", "surface/icosahedron/fold/3/76"),
      },
    ],
    [
      "a polyhedra job on polyhedra/tidintid/100 from its record",
      {
        space: "polyhedra",
        id: "polyhedra/tidintid/100",
        method: "polyhedra soft-to-rigid search",
        seed: 1,
        budget: { time_s: 60 },
        kind: "iterate",
        start: recordConfig("polyhedra", "polyhedra/tidintid/100"),
      },
    ],
    [
      // the balls space has no records: a test packing of the certifier's tests is the start
      "a balls job on balls/dodinball/100 from a test packing",
      {
        space: "balls",
        id: "balls/dodinball/100",
        method: "balls penalty basin hopping",
        seed: 1,
        budget: { time_s: 60 },
        kind: "iterate",
        start: ballsTestPacking("balls/dodinball/100"),
      },
    ],
    [
      "a fresh balls job on balls/ballinball/100",
      {
        space: "balls",
        id: "balls/ballinball/100",
        method: "balls penalty basin hopping",
        seed: 2,
        budget: { time_s: 60 },
        kind: "fresh",
      },
    ],
    [
      "a fresh polyhedra job on polyhedra/phcinphc/100",
      {
        space: "polyhedra",
        id: "polyhedra/phcinphc/100",
        method: "polyhedra soft-to-rigid search",
        seed: 2,
        budget: { time_s: 60 },
        kind: "fresh",
      },
    ],
  ];
  for (const [what, job] of largest) {
    const at = job.space === "surface" ? 2000 : 3000;
    it(`answers an abort within 2 s: ${what}`, { timeout: 60_000 }, async () => {
      pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
      const c = control();
      const running = pool.runSpaceJob(job, c);
      await new Promise((r) => setTimeout(r, at));
      const t = Date.now();
      c.aborted = true;
      const r = await running;
      expect((Date.now() - t) / 1000).toBeLessThan(2);
      expect(r.termination).toBe("aborted");
    });

    it(`uses no CPU while paused: ${what}`, { timeout: 60_000 }, async () => {
      pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
      const c = control();
      const running = pool.runSpaceJob(job, c);
      await new Promise((r) => setTimeout(r, at));
      pool.setPaused(true);
      // the pause reaches the job within a check or two
      await new Promise((r) => setTimeout(r, 500));
      const cpu0 = process.cpuUsage();
      await new Promise((r) => setTimeout(r, 2000));
      const cpu = process.cpuUsage(cpu0);
      expect((cpu.user + cpu.system) / 1e6).toBeLessThan(0.4);
      pool.setPaused(false);
      // the surface job ends on its 2 s budget; the others are ended here
      if (job.space !== "surface") c.aborted = true;
      const r = await running;
      expect(r.termination).toBe(job.space === "surface" ? "time" : "aborted");
      // active seconds: within the budget and the final stage's 1.5 s, the pause left out
      if (job.space === "surface") expect(r.wallTime).toBeLessThan(2 + 1.5 + 0.5);
    });
  }
});
