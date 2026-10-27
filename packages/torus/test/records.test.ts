import { describe, expect, it } from "vitest";
import { areaOf, cellArea, certifiedPacking, displayScore, recordPacking, torusScore, validateTorusPacking } from "../src";
import { loadSiteRecords } from "./helpers";

// data/torus/records.json is written by python/torus/build_records.py after the interval
// certifier (python/torus/certify_torus.py) has proven every entry. These float checks are an
// independent second opinion with separate code: they must agree with the certificates.
const file = loadSiteRecords();

describe("displayScore", () => {
  it("rounds the exact binary value to the nearest at 6 decimals", () => {
    expect(displayScore(2.000000000002)).toBe("2.000000");
    expect(displayScore(1.0000000000001)).toBe("1.000000");
    expect(displayScore(2.4166164921352)).toBe("2.416616");
    // 2.4166165 as a double is 2.41661649999999994...: just below the tie
    expect(displayScore(2.4166165)).toBe("2.416616");
    expect(displayScore(2.41661650000001)).toBe("2.416617");
    expect(displayScore(7.190416372301467)).toBe("7.190416");
    expect(displayScore(0)).toBe("0.000000");
    expect(displayScore(1e-9)).toBe("0.000000");
  });

  it("sends exact binary ties to even, like Python's ROUND_HALF_EVEN", () => {
    expect(displayScore(0.0078125)).toBe("0.007812");
    expect(displayScore(1.0078125)).toBe("1.007812");
    expect(displayScore(1.0234375)).toBe("1.023438");
  });

  it("is within half a unit of the 6th decimal", () => {
    for (const x of [1.861209718204199, 3.86370330515627, 15.99263899386, 0.80592744886766]) {
      expect(Math.abs(Number(displayScore(x)) - x)).toBeLessThanOrEqual(5e-7 + 1e-15);
    }
  });
});

describe.skipIf(!file)("data/torus/records.json", () => {
  const records = file?.records ?? [];

  it("has one record per problem id with consistent fields", () => {
    const ids = records.map((r) => r.problem);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of records) {
      expect(r.problem).toBe(`torus/${r.family}/${r.N}/${r.P}`);
      expect(r.configuration.poses.length).toBe(r.P);
      expect(["best_known", "proven"]).toContain(r.status);
      expect(r.score_cert).toBeGreaterThan(r.score_float);
      // shrink trick: score_cert - score_float is tiny (target <= 1e-9 relative)
      expect((r.score_cert - r.score_float) / r.score_float).toBeLessThanOrEqual(1e-9);
      // display: score_cert rounded to the nearest at 6 decimals (exact binary value, ties to even)
      expect(r.display).toBe(displayScore(r.score_cert));
      expect(r.score_float).toBeGreaterThanOrEqual(r.bound.value * (1 - 1e-12));
    }
  });

  it("is proven only through a published proof of the exact case that the record attains", () => {
    for (const r of records) {
      for (const l of r.literature ?? [])
        if (l.status === "proven" && typeof l.value === "number") expect(r.score_cert).toBeGreaterThanOrEqual(l.value);
      const proofs = (r.literature ?? []).filter(
        (l) =>
          l.status === "proven" &&
          typeof l.proof === "string" &&
          l.proof.trim() !== "" &&
          typeof l.doi === "string" &&
          /^10\.\d{4,9}\/\S+$/.test(l.doi) &&
          typeof l.value === "number" &&
          l.value <= r.score_cert &&
          r.score_cert <= l.value * (1 + 2e-9),
      );
      expect(r.status === "proven", r.problem).toBe(proofs.length > 0);
    }
    const loeschian = [1, 3, 4, 7, 9, 12, 13, 16, 19, 21, 25, 27, 28, 31, 36, 37, 39, 43, 48, 49];
    const sums = [1, 2, 4, 5, 8, 9, 10, 13, 16, 17, 18, 20, 25, 26, 29, 32, 34, 36, 37, 40, 41, 45, 49];
    const expected = [
      ...[2, 3, 4, 6, 7, 8].map((P) => `torus/sq/0/${P}`),
      ...[2, ...loeschian].map((P) => `torus/hex/0/${P}`),
      ...sums.map((P) => `torus/sq/4/${P}`),
      // one piece on a free torus is a lattice packing: the densest lattice packings of disks and triangles
      "torus/free/0/1",
      "torus/free/3/1",
    ];
    expect(records.filter((r) => r.status === "proven").map((r) => r.problem).sort()).toEqual(expected.sort());
  });

  it("stores the score and density of its own configuration", () => {
    for (const r of records) {
      const p = recordPacking(r);
      expect(torusScore(r.family, p.lattice)).toBeCloseTo(r.score_float, 12);
      expect((r.P * areaOf(r.N)) / cellArea(p.lattice)).toBeCloseTo(r.density, 12);
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
