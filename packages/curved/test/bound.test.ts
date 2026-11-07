import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  curvedBound,
  curvedBoundOf,
  curvedMaxP,
  curvedWhyNot,
  makeSpace,
  maxContainerSize,
  pieceExists,
  sideFromApothem,
  tForArea,
} from "../src";

/** curvedBound as it was before curvedFits (bisection for the area, then the limit test): the independent check. */
function bisected(K: number, N: number, M: number, P: number): number | null {
  if (!pieceExists(N, K)) return null;
  const space = makeSpace(K, N, M);
  const size = (t: number) => sideFromApothem(M, K, t);
  let b = size(tForArea(space, P * space.piece.area));
  b = Math.max(b, size(M === 0 ? space.piece.R : space.piece.rho));
  if (M === 0 && P >= 2) b = Math.max(b, size(2 * space.piece.rho));
  return !Number.isFinite(b) || !(b < maxContainerSize(M, K)) ? null : b * (1 - 1e-12);
}

const TILING = [1.225778283313099, -1.1892985685754194, -2.3365290558829845, -3.4413111779836725, -4.50521902808615, -6.519717439579256];
const KS = [-1, -0.5, -0.25, -0.1, -0.01, -0.001, -0.0001, -1e-6, 1e-6, 0.0001, 0.001, 0.01, 0.1, 0.25, 0.5, 1, ...TILING];
const NS = [0, 3, 4, 5, 6, 7, 8, 9, 12, 20, 40, 62, 63, 100];
const MS = [0, 3, 4, 5, 6, 8, 12, 30, 100];

/** The reference: the bound of a Space, null when the piece does not exist. */
function reference(K: number, N: number, M: number, P: number): number | null {
  return pieceExists(N, K) ? curvedBound(makeSpace(K, N, M), P) : null;
}

describe("curvedMaxP", () => {
  it("agrees with curvedBound on a broad sample and at its edges", () => {
    let checked = 0;
    for (const K of KS)
      for (const N of NS)
        for (const M of MS) {
          const max = curvedMaxP(K, N, M, 500);
          const probes = new Set([1, 2, 3, max - 1, max, max + 1, max + 2, 500]);
          for (const P of probes) {
            if (P < 1 || P > 500) continue;
            expect(curvedBoundOf(K, N, M, P) !== null, `${K}/${N}/${M}/${P}`).toBe(P <= max);
            expect(reference(K, N, M, P) !== null, `${K}/${N}/${M}/${P} reference`).toBe(P <= max);
            const old = bisected(K, N, M, P);
            expect(old !== null, `${K}/${N}/${M}/${P} bisected`).toBe(P <= max);
            if (old !== null) expect(reference(K, N, M, P)).toBeCloseTo(old, 9);
            checked++;
          }
        }
    expect(checked).toBeGreaterThan(10000);
  });
  it("is the whole prefix: no P below it is null, and a smaller limit caps it", () => {
    for (const [K, N, M] of [[1, 3, 4], [-1, 5, 6], [0.5, 0, 0], [-0.0001, 4, 100]] as const) {
      const max = curvedMaxP(K, N, M);
      for (let P = 1; P <= Math.min(max, 60); P++) expect(reference(K, N, M, P)).not.toBeNull();
      expect(curvedMaxP(K, N, M, 7)).toBe(Math.min(max, 7));
    }
  });
  it("is 0 where the piece does not exist, and for invalid shapes", () => {
    expect(curvedMaxP(1, 8, 4)).toBe(0);
    expect(curvedMaxP(1, 7, 0)).toBe(0);
    expect(curvedMaxP(1, 4, 101)).toBe(0);
    expect(curvedMaxP(1, 2, 4)).toBe(0);
    expect(curvedMaxP(1, 4, 4, 0)).toBe(0);
  });
  it("matches known cases", () => {
    // a hemisphere at K = 1 has area 2 pi: at most 6 triangles of area about 0.5 ... fewer in a 3-gon container
    expect(curvedMaxP(1, 3, 0)).toBeGreaterThan(5);
    expect(curvedMaxP(-1, 3, 0)).toBe(500);
    expect(curvedMaxP(-1, 3, 3)).toBeLessThan(500);
  });
});

describe("curvedWhyNot", () => {
  it("explains an absent piece, a container too small and the area limit", () => {
    expect(curvedWhyNot(1, 8, 4, 3)).toBe(
      "No unit 8-gon exists at K = 1: its perimeter, 8, is longer than a great circle, 2π/√K ≈ 6.283.",
    );
    const max = curvedMaxP(1, 3, 4);
    expect(curvedWhyNot(1, 3, 4, max)).toBeNull();
    expect(curvedWhyNot(1, 3, 4, max + 1)).toMatch(/holds at most \d+ unit 3-gons?.*area/);
    expect(curvedWhyNot(-1, 100, 3, 1)).toMatch(/cannot hold even one unit 100-gon/);
  });
});

describe("@polypack/curved/bound", () => {
  it("reaches only the light modules: no search, engine, kernel, polish or validator", () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      // value imports and re-exports of relative modules (type-only ones are erased)
      for (const m of text.matchAll(/^(?:import|export)\s(?!type\s)[^;]*?from\s+"(\.[^"]+)"/gms))
        walk(resolve(dirname(file), `${m[1]}.ts`));
    };
    walk(resolve(__dirname, "../src/bound.ts"));
    expect([...seen].map((f) => f.slice(f.lastIndexOf("/") + 1)).sort()).toEqual(["bound.ts", "kfun.ts", "shapes.ts"]);
  });
});
