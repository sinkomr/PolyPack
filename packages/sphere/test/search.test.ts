/**
 * The TypeScript sphere search (src/search.ts): budgets, seeding, and that what it returns is
 * valid by the float validator at the rho it states.
 */
import { describe, expect, it } from "vitest";
import { type SphereConfig, searchSphere, validate } from "../src";
import { loadSiteRecords } from "./helpers";

const records: { id: string; N: number; P: number; config: SphereConfig }[] = loadSiteRecords();
const record = (id: string) => records.find((r) => r.id === id)!;
const enlarged = (c: SphereConfig, f: number): SphereConfig => ({ rho: c.rho * f, pieces: c.pieces });

describe.skipIf(records.length === 0)("searchSphere", () => {
  for (const id of ["sphere/0/12", "sphere/3/13", "sphere/6/9"]) {
    it(`from ${id} enlarged by 1 %, returns a valid packing at least as good as the start`, () => {
      const r = record(id);
      const start = enlarged(r.config, 1.01);
      const res = searchSphere({ N: r.N, P: r.P }, { seed: 1, start, maxEvals: 3000 });
      expect(res.config).not.toBeNull();
      expect(res.score).toBe(res.config!.rho);
      expect(res.score).toBeLessThanOrEqual(start.rho);
      // the tight size alone recovers the record (its touching value), to the bisection's precision
      expect(res.score).toBeLessThanOrEqual(r.config.rho * (1 + 1e-12));
      const v = validate({ N: r.N, P: r.P }, res.config!);
      expect(v.valid).toBe(true);
      expect(v.minGap).toBeGreaterThanOrEqual(0);
      expect(res.stopped).toBe("evals");
    });
  }

  it("respects a tiny budget", () => {
    const r = record("sphere/4/20");
    const t = performance.now();
    const res = searchSphere({ N: r.N, P: r.P }, { seed: 3, start: enlarged(r.config, 1.01), maxEvals: 20 });
    expect(res.evaluations).toBeLessThanOrEqual(20);
    expect(res.stopped).toBe("evals");
    expect(performance.now() - t).toBeLessThan(2000);
    if (res.config) expect(validate({ N: r.N, P: r.P }, res.config).valid).toBe(true);
  });

  it("stops when asked to", () => {
    let calls = 0;
    const res = searchSphere({ N: 5, P: 12 }, { seed: 1, shouldStop: () => ++calls > 3 });
    expect(res.stopped).toBe("aborted");
    expect(res.evaluations).toBeLessThan(200);
  });

  it("gives the same result for the same seed", () => {
    const run = (seed: number) => searchSphere({ N: 4, P: 7 }, { seed, maxEvals: 6000 });
    const a = run(7);
    const b = run(7);
    expect(a.config).not.toBeNull();
    expect(b).toEqual(a);
    expect(validate({ N: 4, P: 7 }, a.config!).valid).toBe(true);
  });

  it("finds a valid packing from scratch", () => {
    // six disks of diameter 1: the octahedral code, rho = 2 / pi
    const res = searchSphere({ N: 0, P: 6 }, { seed: 2, maxEvals: 8000 });
    expect(res.config).not.toBeNull();
    expect(validate({ N: 0, P: 6 }, res.config!).valid).toBe(true);
    expect(res.score).toBeLessThan((2 / Math.PI) * 1.01);
  });
});

describe("searchSphere: units", () => {
  // Pinned from the search before the unit change (disks of radius 1), halved: the search works in
  // the piece's angular size, which does not change, so a seed gives the same poses and half the rho.
  it("gives the radius-1 outcomes of a seed, halved, for disks", () => {
    // recorded on Apple Silicon; Linux x64 differs near 1e-11 (last-bit Math differences), so 9 digits
    const six = searchSphere({ N: 0, P: 6 }, { seed: 5, maxEvals: 3000 });
    expect(six.score).toBeCloseTo(1.2732395447356217 / 2, 9);
    // a disk's quaternion carries a spin that differs between platforms, so check validity rather than q
    expect(validate({ N: 0, P: 6 }, six.config!).valid).toBe(true);
    const nine = searchSphere({ N: 0, P: 9 }, { seed: 5, maxEvals: 3000 });
    expect(nine.score).toBeCloseTo(1.6247489461908833 / 2, 9);
    // polygons are unchanged
    expect(searchSphere({ N: 4, P: 7 }, { seed: 5, maxEvals: 3000 }).score).toBeCloseTo(0.9332432371041922, 9);
  });
});
