/**
 * The near-contact cases of python/balls/fixtures/crosscheck.json (scripts/gen-crosscheck.ts): their stored gaps are
 * still what the validator measures, so that the certifier's test (python/balls/test_certify.py, which proves the
 * separated ones and refuses the overlapping ones) checks the validator of today.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type BallsConfig, getBallsProblem, validateBalls } from "../src";

const fixture = JSON.parse(
  readFileSync(new URL("../../../python/balls/fixtures/crosscheck.json", import.meta.url), "utf8"),
) as { cases: { code: string; what: string; config: BallsConfig; gap: number }[] };

describe("the validator on the cross-check cases", () => {
  it("measures the stored gaps, and passes at tolerance 0 only the separated cases", () => {
    expect(fixture.cases.length).toBe(140);
    for (const c of fixture.cases) {
      const problem = getBallsProblem(c.code)!;
      const v = validateBalls(problem, c.config, { tol: 1 });
      const gap = c.what.startsWith("pair") ? v.minPairSep : v.minWallGap;
      expect(Math.abs(gap - c.gap), `${c.code} ${c.what}`).toBeLessThan(1e-15);
      // at tolerance 0 only the separated cases pass
      expect(validateBalls(problem, c.config, { tol: 0 }).valid, `${c.code} ${c.what}`).toBe(c.gap >= 0);
    }
  });
});
