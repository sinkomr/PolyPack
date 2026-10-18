import { evaluate, findOverlaps } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import { trimTo } from "../trim-down/lib";

// a 3 x 3 grid of unit squares (theta pi/4 puts an unrotated square's sides on the axes)
const grid = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3), theta: Math.PI / 4 }));

describe("trimTo", () => {
  it("returns P pieces from the donor in a container no larger, and valid", () => {
    const donor = evaluate({ N: 4, M: 4, P: 9, pieces: grid, container_phi: 0 }, { autoOrient: true }).score!;
    expect(donor).toBeCloseTo(3, 9);
    for (const P of [8, 5, 4, 1]) {
      const t = trimTo(4, 4, grid, 0, P);
      expect(t.pieces).toHaveLength(P);
      expect(t.score).toBeLessThanOrEqual(donor + 1e-12);
      expect(findOverlaps(4, t.pieces)).toEqual([]);
      for (const p of t.pieces) expect(grid).toContainEqual(p);
      const again = evaluate({ N: 4, M: 4, P, pieces: t.pieces, container_phi: t.container_phi });
      expect(again.score).toBeCloseTo(t.score, 9);
    }
    // one square is the trivial optimum
    expect(trimTo(4, 4, grid, 0, 1).score).toBeCloseTo(1, 9);
  });
});
