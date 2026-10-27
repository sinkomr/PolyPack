/**
 * The TypeScript torus search (src/search.ts): budgets, seeding, and that what it returns is valid
 * by the float validator at the score it states.
 */
import { describe, expect, it } from "vitest";
import {
  recordPacking,
  scalePacking,
  searchTorus,
  torusScore,
  validateTorusPacking,
} from "../src";
import { loadSiteRecords } from "./helpers";

const file = loadSiteRecords();
const record = (id: string) => file!.records.find((r) => r.problem === id)!;

describe.skipIf(!file)("searchTorus", () => {
  for (const id of ["torus/sq/0/7", "torus/hex/5/8", "torus/free/3/6"]) {
    it(`from ${id} enlarged by 1 %, returns a valid packing at least as good as the start`, () => {
      const r = record(id);
      const start = scalePacking(recordPacking(r), 1.01);
      const res = searchTorus({ family: r.family, N: r.N, P: r.P }, { seed: 1, start, maxEvals: 3000 });
      expect(res.packing).not.toBeNull();
      expect(res.score).toBe(torusScore(r.family, res.packing!.lattice));
      expect(res.score).toBeLessThanOrEqual(torusScore(r.family, start.lattice));
      expect(res.score).toBeLessThanOrEqual(r.score_float * (1 + 1e-12));
      const v = validateTorusPacking(res.packing!);
      expect(v.valid).toBe(true);
      expect(v.minSep).toBeGreaterThanOrEqual(0);
      if (r.family !== "free") {
        // sq and hex lattices are exactly the ones their L describes
        expect(res.packing!.lattice.b1[1]).toBe(0);
        expect(res.packing!.lattice.b2[0]).toBe(r.family === "sq" ? 0 : res.packing!.lattice.b1[0] / 2);
      }
    });
  }

  it("respects a tiny budget", () => {
    const r = record("torus/sq/8/12");
    const t = performance.now();
    const res = searchTorus(
      { family: r.family, N: r.N, P: r.P },
      { seed: 3, start: scalePacking(recordPacking(r), 1.01), maxEvals: 20 },
    );
    expect(res.evaluations).toBeLessThanOrEqual(20);
    expect(res.stopped).toBe("evals");
    expect(performance.now() - t).toBeLessThan(2000);
    if (res.packing) expect(validateTorusPacking(res.packing).valid).toBe(true);
  });

  it("stops when asked to", () => {
    let calls = 0;
    const res = searchTorus({ family: "free", N: 5, P: 6 }, { seed: 1, shouldStop: () => ++calls > 3 });
    expect(res.stopped).toBe("aborted");
    expect(res.evaluations).toBeLessThan(200);
  });

  it("gives the same result for the same seed", () => {
    const run = (seed: number) => searchTorus({ family: "free", N: 4, P: 3 }, { seed, maxEvals: 4000 });
    const a = run(5);
    const b = run(5);
    expect(a.packing).not.toBeNull();
    expect(b).toEqual(a);
    expect(validateTorusPacking(a.packing!).valid).toBe(true);
  });

  it("finds a valid packing from scratch", () => {
    // four disks on the square torus: the square lattice, L = 4
    const res = searchTorus({ family: "sq", N: 0, P: 4 }, { seed: 2, maxEvals: 6000 });
    expect(res.packing).not.toBeNull();
    expect(validateTorusPacking(res.packing!).valid).toBe(true);
    expect(res.score).toBeLessThan(4 * 1.02);
  });
});

describe("searchTorus: units", () => {
  // Pinned from the search before the unit change (disks of radius 1), halved: the search runs
  // its radius-1 trajectory on the scaled problem and converts exactly, so a seed is unchanged.
  it("gives the radius-1 outcomes of a seed, halved, for disks", () => {
    const sq = searchTorus({ family: "sq", N: 0, P: 3 }, { seed: 3, maxEvals: 4000 });
    expect(sq.score).toBeCloseTo(3.863703316476379 / 2, 9);
    expect(sq.packing!.lattice.b1[0]).toBe(sq.score);
    expect(validateTorusPacking(sq.packing!, { tol: 0 }).valid).toBe(true);
    const free = searchTorus({ family: "free", N: 0, P: 4 }, { seed: 3, maxEvals: 4000 });
    expect(free.score).toBeCloseTo(3.722419440144221 / 2, 9);
  });

  it("scales a start of disks in and the log out", () => {
    const lines: string[] = [];
    const start = { family: "sq" as const, N: 0, lattice: { b1: [3, 0] as const, b2: [0, 3] as const }, poses: [{ x: 0, y: 0, theta: 0 }, { x: 1.5, y: 1.5, theta: 0 }] };
    const r = searchTorus({ family: "sq", N: 0, P: 2 }, { seed: 1, start, maxEvals: 600, log: (m) => lines.push(m) });
    // two disks of diameter 1 need L >= sqrt(2) on a square torus (the diagonal pair)
    expect(r.startScore).toBeLessThanOrEqual(3);
    expect(r.score).toBeGreaterThanOrEqual(Math.SQRT2 * (1 - 1e-9));
    expect(lines[0]).toBe(`start: score ${r.startScore}`);
  });
});
