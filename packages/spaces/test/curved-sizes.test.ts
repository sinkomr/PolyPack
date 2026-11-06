/** Curved problems at the largest sizes (P = 500, M = 100): the board's search starts, ends in budget and is valid; the check is bounded. */
import { curvedBoundOf } from "@polypack/curved/bound";
import { describe, expect, it } from "vitest";
import { validateSpaceSubmissionAsync } from "../src";
import { runSpaceJob } from "../src/search";

describe("curved at P = 500", () => {
  for (const id of ["curved/-0.0001/4/100/500", "curved/0.0001/0/0/500"])
    it(`searches ${id} within a 1 s budget and returns a valid packing`, () => {
      const [, K, N, M, P] = id.split("/").map(Number);
      const bound = curvedBoundOf(K, N, M, P)!;
      const t = performance.now();
      const r = runSpaceJob(
        { space: "curved", id, seed: 7, budget: { time_s: 1 }, kind: "fresh", rule: { bound, certified: null } },
        { aborted: false, paused: false },
      );
      expect(performance.now() - t).toBeLessThan(2500);
      expect(r.termination).toBe("time");
      expect(r.valid).toBe(true);
      expect(r.score!).toBeGreaterThanOrEqual(bound);
    });
  it("checks 500 coincident 100-gons in a 100-gon in short slices", async () => {
    const id = "curved/-1e-06/100/100/500";
    const bound = curvedBoundOf(-1e-6, 100, 100, 500)!;
    const pieces = Array.from({ length: 500 }, () => ({ x: 0, y: 0, theta: 0 }));
    const v = await validateSpaceSubmissionAsync("curved", id, { size: 100, pieces }, { bound, noRecord: true, maxP: 500 });
    expect(v.valid).toBe(false);
    expect(v.reasons.join(" ")).toContain("overlap");
    // [CALC] about 0.7 s of work, no slice above 25 ms (20 overlapping pairs of 100-gons, then the pairs' reach test)
    expect(v.longestSliceMs).toBeLessThan(50);
  }, 30000);
});
