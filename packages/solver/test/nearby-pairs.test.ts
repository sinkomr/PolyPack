import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Pose } from "@polypack/geometry";
import { nearbyPairs } from "../src/methods/penalty/objective";

/** nearbyPairs as it was with nested Maps (origin/main e0eca4c): the order of pairs and of `stopped` calls is the contract. */
function referenceNearbyPairs(poses: readonly Pose[], reach: number, stopped: () => boolean): [number, number][] {
  const grid = new Map<number, Map<number, number[]>>();
  const pairs: [number, number][] = [];
  for (let i = 0; i < poses.length; i++) {
    if (stopped()) return pairs;
    const a = poses[i];
    const ix = Math.floor(a.x / reach);
    const iy = Math.floor(a.y / reach);
    if (!Number.isSafeInteger(ix) || !Number.isSafeInteger(iy)) {
      const all: [number, number][] = [];
      for (let j = 0; j < poses.length; j++) {
        for (let k = j + 1; k < poses.length; k++) {
          if (stopped()) return all;
          if (Math.hypot(poses[j].x - poses[k].x, poses[j].y - poses[k].y) <= reach) all.push([j, k]);
        }
      }
      return all;
    }
    for (let ox = -1; ox <= 1; ox++) {
      if (stopped()) return pairs;
      const column = grid.get(ix + ox);
      if (!column) continue;
      for (let oy = -1; oy <= 1; oy++) {
        if (stopped()) return pairs;
        for (const j of column.get(iy + oy) ?? []) {
          if (Math.hypot(a.x - poses[j].x, a.y - poses[j].y) <= reach) pairs.push([j, i]);
        }
      }
    }
    let column = grid.get(ix);
    if (!column) {
      column = new Map();
      grid.set(ix, column);
    }
    const cell = column.get(iy);
    if (cell) cell.push(i);
    else column.set(iy, [i]);
  }
  return pairs;
}

const coordinate = fc.oneof(
  fc.double({ min: -6, max: 6, noNaN: true }),
  fc.constantFrom(0, -0, 1, -1, 2, 1e15, -1e15, 1e300, NaN, Infinity),
  fc.integer({ min: -8, max: 8 }).map((k) => k * 1.4142135623730951),
);
const posesArb = fc.array(
  fc.record({ x: coordinate, y: coordinate, theta: fc.constant(0) }),
  { minLength: 0, maxLength: 80 },
);

describe("nearbyPairs", () => {
  it("gives the reference's pairs in its order, with the same calls to stopped", () => {
    fc.assert(
      fc.property(
        posesArb,
        fc.constantFrom(1, 1.4142135623730951, 0.3, 2.5, 1e-9),
        fc.integer({ min: 0, max: 400 }),
        (poses, reach, stopAfter) => {
          let a = 0;
          let b = 0;
          const got = nearbyPairs(poses, reach, () => ++a > stopAfter);
          const want = referenceNearbyPairs(poses, reach, () => ++b > stopAfter);
          expect(got).toEqual(want);
          expect(a).toBe(b);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("stays correct when called again from its own stopped callback, and across sizes", () => {
    fc.assert(
      fc.property(posesArb, posesArb, (outer, inner) => {
        const nested: [number, number][][] = [];
        const got = nearbyPairs(outer, 1, () => (nested.push(nearbyPairs(inner, 0.7, () => false)), false));
        expect(got).toEqual(referenceNearbyPairs(outer, 1, () => false));
        const want = referenceNearbyPairs(inner, 0.7, () => false);
        for (const pairs of nested) expect(pairs).toEqual(want);
      }),
      { numRuns: 300 },
    );
  });

  it("decides pairs at exactly the reach as hypot does", () => {
    // a lattice of spacing equal to the reach, rotated so that distances round both ways
    for (const angle of [0, 0.1, Math.PI / 4, 1]) {
      const poses: Pose[] = [];
      for (let i = 0; i < 9; i++)
        for (let j = 0; j < 9; j++)
          poses.push({ x: i * Math.cos(angle) - j * Math.sin(angle), y: i * Math.sin(angle) + j * Math.cos(angle), theta: 0 });
      for (const reach of [1, 1 + 1e-15, 1 - 1e-15, Math.SQRT2])
        expect(nearbyPairs(poses, reach, () => false)).toEqual(referenceNearbyPairs(poses, reach, () => false));
    }
  });
});
