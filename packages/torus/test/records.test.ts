import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pieceArea } from "@polypack/geometry";
import { TorusRecordsFile, cellArea, certifiedPacking, recordPacking, torusScore, validateTorusPacking } from "../src";

// data/torus/records.json is written by python/torus/build_records.py after the interval
// certifier (python/torus/certify_torus.py) has proven every entry. These float checks are an
// independent second opinion with separate code: they must agree with the certificates.
const url = new URL("../../../data/torus/records.json", import.meta.url);
const file: TorusRecordsFile | undefined = existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : undefined;

describe.skipIf(!file)("data/torus/records.json", () => {
  const records = file?.records ?? [];

  it("has one record per problem id with consistent fields", () => {
    const ids = records.map((r) => r.problem);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of records) {
      expect(r.problem).toBe(`torus/${r.family}/${r.N}/${r.P}`);
      expect(r.configuration.poses.length).toBe(r.P);
      expect(r.status).not.toBe("proven");
      expect(r.score_cert).toBeGreaterThan(r.score_float);
      // shrink trick: score_cert - score_float is tiny (target <= 1e-9 relative)
      expect((r.score_cert - r.score_float) / r.score_float).toBeLessThanOrEqual(1e-9);
      expect(Number(r.display)).toBeGreaterThanOrEqual(r.score_cert);
      expect(Number(r.display) - r.score_cert).toBeLessThan(1e-6 + 1e-12);
      expect(r.score_float).toBeGreaterThanOrEqual(r.bound.value * (1 - 1e-12));
    }
  });

  it("stores the score and density of its own configuration", () => {
    for (const r of records) {
      const p = recordPacking(r);
      expect(torusScore(r.family, p.lattice)).toBeCloseTo(r.score_float, 12);
      expect((r.P * pieceArea(r.N)) / cellArea(p.lattice)).toBeCloseTo(r.density, 12);
    }
  });

  it("every stored configuration is valid at the shared tolerance", () => {
    const bad = records.filter((r) => !validateTorusPacking(recordPacking(r)).valid).map((r) => r.problem);
    expect(bad).toEqual([]);
  });

  it("every shrunk configuration is strictly valid in floats (the certified claim)", () => {
    const bad = records
      .filter((r) => {
        const v = validateTorusPacking(recordPacking(r), { tol: 0, scale: 1 - r.eps });
        return !(v.valid && v.minSep > 0);
      })
      .map((r) => r.problem);
    expect(bad).toEqual([]);
  });

  it("the packing scaled to score_cert has no float overlap", () => {
    const bad = records.filter((r) => validateTorusPacking(certifiedPacking(r), { tol: 1e-12 }).valid !== true).map((r) => r.problem);
    expect(bad).toEqual([]);
  });

  it("free-lattice scores never exceed the sq or hex score of the same (N, P)", () => {
    const key = (r: { N: number; P: number }) => `${r.N}/${r.P}`;
    const free = new Map(records.filter((r) => r.family === "free").map((r) => [key(r), r]));
    for (const r of records) {
      const f = free.get(key(r));
      if (!f || r.family === "free") continue;
      // a sq/hex packing is a free-lattice packing with cell area L^2 or L^2 sqrt(3)/2
      const asFree = r.family === "sq" ? r.score_float : r.score_float * Math.sqrt(Math.sqrt(3) / 2);
      expect(f.score_float).toBeLessThanOrEqual(asFree * (1 + 1e-9));
    }
  });
});
