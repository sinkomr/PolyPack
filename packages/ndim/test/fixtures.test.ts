/**
 * The test packings of python/ndim/make_fixtures.py, validated in floating point. The exact certifier
 * (python/ndim/test_ndim.py) answers the same questions on the same file; `expect.valid0` is what the validator must say at
 * tolerance 0, `expect.exact` what the exact certifier says with clearance 0.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadPolytope, validateNd, type NdConfig, type NdProblem } from "../src";

interface Fixture {
  name: string;
  problem: NdProblem;
  config: NdConfig;
  slow: boolean;
  expect: { exact: boolean; exact_clearance: boolean; valid0: boolean };
}

const doc = JSON.parse(readFileSync(new URL("./fixtures/packings.json", import.meta.url), "utf8")) as {
  fixtures: Fixture[];
};

beforeAll(async () => {
  await loadPolytope("8:421");
});

describe("test packings", () => {
  it("has the fixtures", () => {
    expect(doc.fixtures.length).toBeGreaterThan(80);
    expect(new Set(doc.fixtures.map((f) => f.name)).size).toBe(doc.fixtures.length);
  });
  for (const f of doc.fixtures) {
    it(`${f.name}: valid at tolerance 0 is ${f.expect.valid0}`, () => {
      const r = validateNd(f.problem, f.config, { tol: 0, limits: { maxPieces: 128 } });
      expect(r.reasons.slice(0, 3)).toEqual(f.expect.valid0 ? [] : r.reasons.slice(0, 3));
      expect(r.valid).toBe(f.expect.valid0);
      expect(r.score).toBe(f.expect.valid0 ? f.config.s : null);
    });
  }
});
