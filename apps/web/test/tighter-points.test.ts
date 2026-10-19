import { describe, expect, it } from "vitest";
import { SCORE_TIE, improvesOn } from "@polypack/geometry";
import { FLOOR, gapOf, recordPoints, shapeWeight } from "../src/tighter/points";

// The worked examples of design.md §5 (balance/results/points-examples.txt), at F = 1e-9.
const P33 = { N: 33, M: 47, P: 197 };

describe("Tighter record points", () => {
  it("uses the server's tie tolerance as the floor", () => {
    expect(FLOOR).toBe(SCORE_TIE);
    expect(FLOOR).toBe(1e-9);
  });

  it("weights near-circular shapes by (20/N)(20/M)", () => {
    expect(shapeWeight(4, 7)).toBe(1);
    expect(shapeWeight(0, 20)).toBe(1);
    expect(shapeWeight(33, 47)).toBeCloseTo(0.2579, 4);
    expect(shapeWeight(100, 100)).toBeCloseTo(0.04, 12);
  });

  it("reproduces (a), the first record of 33-gons in a 47-gon, P 197", () => {
    const p = recordPoints({ ...P33, sPrev: 12.524084913326904, sNew: 11.887296419456838, tier: "open", first: true })!;
    expect(p.nibble).toBeCloseTo(8.71, 2);
    expect(p.size).toBeCloseTo(5.22, 2);
    expect(p.gap).toBeCloseTo(27.17, 2);
    expect(p.bonus).toBe(10);
    expect(p.firstBonus).toBe(true);
    expect(p.total).toBeCloseTo(13.18, 2);
  });

  it("reproduces (b), one Evolve click, and (d), basin hopping's jump", () => {
    expect(recordPoints({ ...P33, sPrev: 11.887296419456838, sNew: 11.863522, tier: "open" })!.total).toBeCloseTo(
      2.24,
      2,
    );
    expect(recordPoints({ ...P33, sPrev: 11.887296419456838, sNew: 10.834199, tier: "open" })!.total).toBeCloseTo(
      23.43,
      2,
    );
  });

  it("reproduces (e), another name's loose record improved by 0.05 %, with the beat bonus", () => {
    // (e) is a batch record (c = 10) in the design; the same arithmetic at c = 3 for a loose record
    const s = 15.656167;
    const p = recordPoints({ N: 7, M: 7, P: 197, sPrev: s, sNew: s * (1 - 5e-4), tier: "loose", beatOther: true })!;
    expect(p.c).toBe(3);
    expect(p.beatBonus).toBe(true);
    expect(p.total / 3).toBeCloseTo(12.23, 2);
  });

  it("pays nothing at or below the floor, and one point just above it", () => {
    const s = 15.656167;
    const base = { N: 7, M: 7, P: 197, sPrev: s, tier: "loose" as const };
    for (const d of [0, 1e-12, 1e-10, 5e-10, 1e-9]) {
      // exactly at the floor is a tie: not counted, as on the server
      expect(recordPoints({ ...base, sNew: s * (1 - d) })).toBeNull();
      expect(improvesOn(s * (1 - d), s)).toBe(false);
    }
    const justAbove = recordPoints({ ...base, sNew: s * (1 - 1.0001e-9) })!;
    expect(justAbove).not.toBeNull();
    expect(improvesOn(s * (1 - 1.0001e-9), s)).toBe(true);
    expect(justAbove.nibble).toBeCloseTo(1, 3);
    expect(justAbove.decades).toBeGreaterThanOrEqual(0);
    // the nibble term adds one point per decade: (f') 1, 2, 3 at 1e-9, 1e-8, 1e-7 (above the floor)
    expect(recordPoints({ ...base, sNew: s * (1 - 1.0000001e-8) })!.nibble).toBeCloseTo(2, 5);
    expect(recordPoints({ ...base, sNew: s * (1 - 1.0000001e-7) })!.nibble).toBeCloseTo(3, 5);
  });

  it("counts exactly the improvements the server makes leader, around the floor", () => {
    const s = 11.887296419456838;
    for (let k = -50; k <= 50; k++) {
      const sNew = s * (1 - SCORE_TIE) + k * Number.EPSILON * s;
      expect(recordPoints({ ...P33, sPrev: s, sNew, tier: "open" }) !== null).toBe(improvesOn(sNew, s));
    }
  });

  it("refuses a worse or equal score and nonsense input", () => {
    expect(recordPoints({ ...P33, sPrev: 11, sNew: 11.5, tier: "open" })).toBeNull();
    expect(recordPoints({ ...P33, sPrev: 11, sNew: 11, tier: "open" })).toBeNull();
    expect(recordPoints({ ...P33, sPrev: 11, sNew: NaN, tier: "open" })).toBeNull();
    expect(recordPoints({ ...P33, sPrev: Infinity, sNew: 11, tier: "open" })).toBeNull();
    expect(recordPoints({ ...P33, sPrev: 11, sNew: -1, tier: "open" })).toBeNull();
  });

  it("pays the first-record bonus only when the gap beats the floor's by 10 %", () => {
    const b = gapOf(33, 47, 197, 12.524084913326904);
    // a new score whose gap is 95 % of the floor's: no bonus
    const sMid = (1 + 0.95 * b) * (12.524084913326904 / (1 + b));
    expect(recordPoints({ ...P33, sPrev: 12.524084913326904, sNew: sMid, tier: "open", first: true })!.firstBonus).toBe(
      false,
    );
  });

  it("pays the beat bonus only when the change is visible at 6 decimals", () => {
    const s = 7.123456;
    const tiny = recordPoints({ N: 7, M: 7, P: 40, sPrev: s, sNew: s * (1 - 1e-8), tier: "loose", beatOther: true })!;
    expect(tiny.beatBonus).toBe(false);
    expect(tiny.bonus).toBe(0);
  });
});
