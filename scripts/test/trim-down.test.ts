import { type LiteratureRecord, evaluate, findOverlaps } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { growByStrip, trimTo } from "../trim-down/lib";

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
      // the server scores the container at the phi sent: the score at the phi returned is the score
      const again = evaluate({ N: 4, M: 4, P, pieces: t.pieces, container_phi: t.container_phi });
      expect(again.score).toBe(t.score);
    }
    // one square is the trivial optimum
    expect(trimTo(4, 4, grid, 0, 1).score).toBeCloseTo(1, 9);
  });
});

describe("growByStrip", () => {
  const { records } = JSON.parse(readFileSync("data/records.json", "utf8")) as { records: LiteratureRecord[] };
  const rec = (N: number, M: number, P: number) => records.find((r) => r.N === N && r.M === M && r.P === P)!;

  it("turns 5 squares in side 2 + 1/sqrt 2 into 10 in side 3 + 1/sqrt 2, the proven value", () => {
    const five = rec(4, 4, 5);
    const g = growByStrip(4, 4, five.pieces!, five.container_phi ?? 0)!;
    expect(g.pieces).toHaveLength(5 + 2 * 2 + 1);
    expect(g.score).toBeCloseTo(3 + Math.SQRT1_2, 9);
    expect(evaluate({ N: 4, M: 4, P: 10, pieces: g.pieces, container_phi: g.container_phi }).valid).toBe(true);
    expect(g.score).toBeLessThanOrEqual(rec(4, 4, 10).value + 1e-9);
  });

  it("adds a strip of 2k + 1 triangles to a triangle of side k, in any orientation", () => {
    const four = rec(3, 3, 4); // the tiling of side 2
    for (const turn of [0, 1, 2.5]) {
      const turned = four.pieces!.map((p) => ({
        x: p.x * Math.cos(turn) - p.y * Math.sin(turn),
        y: p.x * Math.sin(turn) + p.y * Math.cos(turn),
        theta: p.theta + turn,
      }));
      const g = growByStrip(3, 3, turned, turn)!;
      expect(g.pieces).toHaveLength(9);
      expect(g.score).toBeCloseTo(3, 9);
      expect(findOverlaps(3, g.pieces)).toEqual([]);
      // oriented, as the server scores it: at the phi returned
      expect(evaluate({ N: 3, M: 3, P: 9, pieces: g.pieces, container_phi: g.container_phi }).score).toBe(g.score);
    }
  });

  it("refuses pairs whose pieces do not fill a strip", () => {
    expect(growByStrip(0, 4, [{ x: 0, y: 0, theta: 0 }], 0)).toBeNull();
  });
});
