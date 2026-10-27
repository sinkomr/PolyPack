import { describe, expect, it } from "vitest";
import {
  TORUS_DISK_RADIUS,
  TORUS_MAX_P,
  type TorusFamily,
  torusLatticeStart,
  torusScore,
  validateTorusPacking,
} from "../src";

const tick = () => new Promise((r) => setImmediate(r));

describe("torusLatticeStart", () => {
  it("is deterministic and has the largest P of the domain", () => {
    expect(TORUS_MAX_P).toBe(500);
    const a = torusLatticeStart({ family: "free", N: 5, P: 77 });
    expect(torusLatticeStart({ family: "free", N: 5, P: 77 })).toEqual(a);
    expect(() => torusLatticeStart({ family: "sq", N: 0, P: 501 })).toThrow(RangeError);
    expect(() => torusLatticeStart({ family: "sq", N: 0, P: 0 })).toThrow(RangeError);
  });

  it("is valid at the strict tolerance for every family, shape and many P up to 500", async () => {
    const cases: [TorusFamily, number, number][] = [];
    for (const family of ["sq", "hex", "free"] as const)
      for (const N of [0, 3, 4, 7, 100])
        for (const P of [1, 2, 7, 101, 499, 500]) cases.push([family, N, P]);
    for (const [family, N, P] of cases) {
      const s = torusLatticeStart({ family, N, P });
      expect(s.poses).toHaveLength(P);
      const v = validateTorusPacking(s, { tol: 1e-11 });
      expect(v.valid, `${family}/${N}/${P}: ${v.errors} ${v.minSep}`).toBe(true);
      // the cell is the family's: sq and hex rebuild from L, so the stored lattice must be that exactly
      if (family === "sq") expect(s.lattice.b2).toEqual([0, s.lattice.b1[0]]);
      expect(v.score).toBe(torusScore(family, s.lattice));
      await tick();
    }
  });

  it("leaves disks of radius TORUS_DISK_RADIUS touching within the start's margin", () => {
    for (const family of ["sq", "hex"] as const) {
      const s = torusLatticeStart({ family, N: 0, P: 120 });
      const v = validateTorusPacking(s, { tol: 1e-11 });
      // the closest pair is 2 R (1 + 1e-9) apart
      expect(v.minSep).toBeGreaterThan(0);
      expect(v.minSep).toBeLessThan(2 * TORUS_DISK_RADIUS * 1e-8);
    }
  });

  it("picks a lattice no worse than the single-row placement", () => {
    // Q = P in one row (a = P, d = 1) has a cell P times as long as a piece is wide; the best placement is far smaller
    const s = torusLatticeStart({ family: "sq", N: 0, P: 500 });
    expect(s.lattice.b1[0]).toBeLessThan(45);
    const h = torusLatticeStart({ family: "hex", N: 0, P: 500 });
    expect(torusScore("hex", h.lattice)).toBeLessThan(47);
  });
});
