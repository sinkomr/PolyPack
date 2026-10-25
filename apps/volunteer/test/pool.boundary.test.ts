/**
 * Boundary jobs ("3D on 4D") in the worker pool's real threads: a short job, an abort and a pause,
 * through the flags the pool shares with each thread.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WorkerPool } from "../src/pool";
import type { SpaceJob } from "../src/spaces/run";
import type { Control } from "../src/types";
import { enlarged, recordConfig } from "./spaces-fixtures";

const control = (): Control => ({ aborted: false, paused: false });
// without a start or an evaluation cap, only the time budget or an abort ends this one
const endless = (time_s: number): SpaceJob => ({
  space: "boundary",
  id: "boundary/tesseract/ball/16",
  method: "boundary compression search",
  seed: 1,
  budget: { time_s },
  kind: "fresh",
});

let pool: WorkerPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe("boundary jobs in the worker pool", () => {
  it("runs a real boundary job in a real thread", { timeout: 60_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
    const start = enlarged("boundary", recordConfig("boundary", "boundary/tesseract/ball/9"), 1.01);
    const job: SpaceJob = {
      space: "boundary",
      id: "boundary/tesseract/ball/9",
      method: "boundary compression search",
      seed: 1,
      budget: { time_s: 60, evals: 20_000 },
      kind: "iterate",
      start,
    };
    const r = await pool.runSpaceJob(job, control());
    expect(r.valid, r.reasons.join("; ")).toBe(true);
    expect(r.score!).toBeLessThan((start.s as number) * 0.995);
    expect(r.termination).toBe("evals");
  });

  it("answers an abort within 2 s", { timeout: 60_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
    const c = control();
    const running = pool.runSpaceJob(endless(3600), c);
    await new Promise((r) => setTimeout(r, 1500));
    const t = Date.now();
    c.aborted = true;
    const r = await running;
    expect((Date.now() - t) / 1000).toBeLessThan(2);
    expect(r.termination).toBe("aborted");
    expect(r.valid).toBe(true);
  });

  it("uses no CPU while paused, and does not count the pause", { timeout: 60_000 }, async () => {
    pool = await WorkerPool.create({ size: 1, priority: "normal", tickMs: 20 });
    const t = Date.now();
    const running = pool.runSpaceJob(endless(1.5), control());
    await new Promise((r) => setTimeout(r, 500));
    pool.setPaused(true);
    await new Promise((r) => setTimeout(r, 500));
    const cpu0 = process.cpuUsage();
    await new Promise((r) => setTimeout(r, 2000));
    const cpu = process.cpuUsage(cpu0);
    expect((cpu.user + cpu.system) / 1e6).toBeLessThan(0.4);
    pool.setPaused(false);
    const r = await running;
    const wall = (Date.now() - t) / 1000;
    expect(r.termination).toBe("time");
    expect(wall).toBeGreaterThan(3.5);
    expect(r.wallTime).toBeLessThan(wall - 2);
  });
});
