/** One boundary job (runSpaceJob) on this thread: the adapter to searchBoundary. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOUNDARY_ROUND_EVALS, type SpaceJob, checkSpaceConfig, runSpaceJob, SPACE_METHOD } from "../src/search";

const file = JSON.parse(readFileSync(resolve(__dirname, "../../../data/boundary/records.json"), "utf8"));
const record = (id: string) => file.records.find((r: any) => r.id === id);
const grown = (c: any, f: number) => ({ s: c.s * f, pieces: c.pieces.map((q: any) => ({ ...q, u: q.u.map((x: number) => x * f) })) });
const job = (id: string, o: Partial<SpaceJob> = {}): SpaceJob => ({
  space: "boundary",
  id,
  method: SPACE_METHOD.boundary,
  seed: 3,
  budget: { time_s: 60, evals: 20_000 },
  kind: "iterate",
  ...o,
});
const go = { aborted: false, paused: false };

describe("one boundary job", () => {
  it("returns a valid configuration at least as good as an enlarged start, by the server's rule", () => {
    for (const id of ["boundary/tesseract/ball/9", "boundary/tesseract/cube/12"]) {
      const r0 = record(id);
      const start = grown(r0.config, 1.01);
      const rule = { bound: r0.bound.value, certified: r0.score_cert };
      const r = runSpaceJob(job(id, { start, rule }), go);
      expect(r.valid, r.reasons.join("; ")).toBe(true);
      expect(r.score!).toBeLessThan(start.s);
      expect(checkSpaceConfig("boundary", id, r.config, rule)).toMatchObject({ valid: true, score: r.score });
      expect(r.termination).toBe("evals");
      expect(r.evaluations).toBe(20_000);
    }
  });

  it("is reproducible from its seed and evaluation cap, also from no start", () => {
    const fresh = job("boundary/tesseract/cube/12", { kind: "fresh", seed: 1, budget: { time_s: 60, evals: 10_000 } });
    const a = runSpaceJob(fresh, go);
    const b = runSpaceJob(fresh, go);
    expect(a.valid).toBe(true);
    expect(b.config).toEqual(a.config);
    expect(a.score).toBe(b.score);
  });

  it("ends 'bound' at the search's floor: cubes P <= 8 at s = 1", () => {
    const id = "boundary/tesseract/cube/4";
    const r = runSpaceJob(job(id, { start: record(id).config, budget: { time_s: 60 } }), go);
    expect(r.valid).toBe(true);
    expect(r.termination).toBe("bound");
    expect(r.score!).toBeLessThanOrEqual(record(id).score_cert);
  });

  it("stops on its active time, at once when aborted, and refuses a start of another problem", () => {
    const id = "boundary/tesseract/ball/16";
    let t = 0;
    const clock = () => (t += 0.001);
    const timed = runSpaceJob(job(id, { kind: "fresh", budget: { time_s: 0.5 } }), go, clock);
    expect(timed.termination).toBe("time");
    expect(timed.wallTime).toBeGreaterThanOrEqual(0.5);
    const start = record(id).config;
    const aborted = runSpaceJob(job(id, { start, budget: { time_s: 60 } }), { aborted: true, paused: false });
    expect(aborted.termination).toBe("aborted");
    expect(aborted.valid).toBe(true); // the start itself
    expect(runSpaceJob(job("boundary/tesseract/ball/15", { start }), go)).toMatchObject({ valid: false, termination: "error" });
    expect(BOUNDARY_ROUND_EVALS).toBe(300_000);
  });
});
