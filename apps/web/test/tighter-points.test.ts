import { describe, expect, it } from "vitest";
import { SCORE_TIE, areaLowerBound, improvesOn } from "@polypack/geometry";
import {
  BEAT_OTHER_FACTOR,
  FLOOR,
  GAP_WEIGHT,
  SIZE_WEIGHT,
  costFactor,
  gapOf,
  recordPoints,
  shapeWeight,
} from "../src/tighter/points";
import { msPerEval } from "../src/tighter/families";

// The worked examples of design.md §5 (balance/results/points-examples.txt), at F = 1e-9, with the size
// and gap weights of 2026-10-22 (10,000 each, 100 times design.md's): the step term and the bonuses are
// as they were, the size and gap terms 100 times.
const P33 = { family: "polygon", N: 33, M: 47, P: 197 };

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

  it("weighs the size and gap terms 10,000 each", () => {
    expect([SIZE_WEIGHT, GAP_WEIGHT]).toEqual([10_000, 10_000]);
  });

  it("reproduces (a), the first record of 33-gons in a 47-gon, P 197", () => {
    const p = recordPoints({ ...P33, sPrev: 12.524084913326904, sNew: 11.887296419456838, tier: "open", first: true })!;
    expect(p.nibble).toBeCloseTo(8.71, 2);
    expect(p.size).toBeCloseTo(521.83, 2);
    expect(p.gap).toBeCloseTo(2716.64, 2);
    expect(p.bonus).toBe(10);
    expect(p.firstBonus).toBe(true);
    expect(p.total / costFactor(P33)).toBeCloseTo(840.02, 2);
  });

  it("reproduces (b), one Evolve click, and (d), basin hopping's jump", () => {
    const k = costFactor(P33);
    expect(recordPoints({ ...P33, sPrev: 11.887296419456838, sNew: 11.863522, tier: "open" })!.total / k).toBeCloseTo(
      37.28,
      2,
    );
    expect(recordPoints({ ...P33, sPrev: 11.887296419456838, sNew: 10.834199, tier: "open" })!.total / k).toBeCloseTo(
      2114.18,
      2,
    );
  });

  it("reproduces (e), another name's loose record improved by 0.05 %, with the beat factor", () => {
    // (e) is a batch record (c = 10) in the design; the same arithmetic at c = 3 for a loose record
    const s = 15.656167;
    const p = recordPoints({
      family: "polygon",
      N: 7,
      M: 7,
      P: 197,
      sPrev: s,
      sNew: s * (1 - 5e-4),
      tier: "loose",
      beatOther: true,
    })!;
    expect(p.c).toBe(3);
    expect(p.beatBonus).toBe(true);
    // the design's 65.12 had a beat bonus of 5 inside the bracket; the factor now doubles the event instead
    const plain = recordPoints({
      family: "polygon",
      N: 7,
      M: 7,
      P: 197,
      sPrev: s,
      sNew: s * (1 - 5e-4),
      tier: "loose",
    })!;
    expect(p.beat).toBe(BEAT_OTHER_FACTOR);
    expect(p.total).toBeCloseTo(2 * plain.total, 9);
    expect(p.total / 3 / costFactor({ family: "polygon", N: 7, M: 7, P: 197 })).toBeCloseTo(2 * (65.12 - 5), 1);
  });

  it("scales pay by the cost of an evaluation: 1 at N+M+P = 85, more for slower problems, 5 ms for spaces", () => {
    expect(costFactor({ family: "polygon", N: 21, M: 24, P: 40 })).toBeCloseTo(1, 12);
    expect(costFactor({ family: "polygon", N: 30, M: 36, P: 200 })).toBeCloseTo(msPerEval(266) / 1.77, 12);
    expect(costFactor({ family: "polygon", N: 100, M: 100, P: 300 })).toBeCloseTo(52.3 / 1.77, 12);
    expect(costFactor({ family: "polygon", N: 4, M: 4, P: 10 })).toBeLessThan(0.2);
    expect(costFactor({ family: "sphere", id: "sphere/0/12", P: 12 })).toBeCloseTo(5 / 1.77, 12);
    // the same board and the same step pay in proportion to the factor, nothing else changes
    const a = { family: "polygon", N: 24, M: 30, P: 40, sPrev: 8, sNew: 7.9, tier: "open" } as const;
    const b = { ...a, P: 200 };
    const pa = recordPoints(a)!;
    const pb = recordPoints(b)!;
    expect(pa.total / pa.k / pa.w).toBeCloseTo(pa.nibble + pa.size + pa.gap + pa.bonus, 9);
    expect(pb.k / pa.k).toBeCloseTo(costFactor(b) / costFactor(a), 12);
  });

  it("pays the same per second of solver time at every size, for the same relative progress", () => {
    // a step of 10 evaluations that cuts 0.1 % at a gap of 23 %, shape weight removed: RP per ms of evaluation
    const perMs = (P: number) => {
      const N = 24;
      const M = 30;
      const sPrev = areaLowerBound(N, M, P) * 1.23;
      const p = recordPoints({ family: "polygon", N, M, P, sPrev, sNew: sPrev * (1 - 0.001), tier: "open" })!;
      return p.total / p.w / (10 * msPerEval(N + M + P));
    };
    const rates = [40, 80, 150, 250, 400].map(perMs);
    expect(Math.max(...rates) / Math.min(...rates)).toBeCloseTo(1, 9);
  });

  it("pays the beat of a record BEAT_OTHER_FACTOR times, between 1.5 and 2.5", () => {
    const base = { ...P33, sPrev: 12, sNew: 11.9, tier: "batch" } as const;
    const plain = recordPoints(base)!;
    const beat = recordPoints({ ...base, beatOther: true })!;
    expect(beat.total / plain.total).toBeCloseTo(BEAT_OTHER_FACTOR, 12);
    expect(BEAT_OTHER_FACTOR).toBeGreaterThanOrEqual(1.5);
    expect(BEAT_OTHER_FACTOR).toBeLessThanOrEqual(2.5);
    // the caller decides (game.ts beating): every flagged payment pays the factor, however small the step
    const tiny = recordPoints({ ...base, sPrev: 12, sNew: 12 * (1 - 2e-9), beatOther: true })!;
    expect(tiny.beat).toBe(BEAT_OTHER_FACTOR);
  });

  it("pays the size and gap terms by where a run ends, however many steps it takes", () => {
    const s0 = 11.887296419456838;
    const s1 = s0 * (1 - 0.003);
    const one = recordPoints({ ...P33, sPrev: s0, sNew: s1, tier: "open" })!;
    let size = 0;
    let gap = 0;
    let prev = s0;
    for (let i = 1; i <= 50; i++) {
      const next = s0 * (1 - (0.003 * i) / 50);
      const p = recordPoints({ ...P33, sPrev: prev, sNew: next, tier: "open" })!;
      size += p.size;
      gap += p.gap;
      prev = next;
    }
    expect(size).toBeCloseTo(one.size, 6);
    expect(gap).toBeCloseTo(one.gap, 6);
  });

  it("pays for how much smaller a board gets, while every improving step still pays its step term", () => {
    // the shrink_repair report's worked board (21-gons in a 24-gon, 40 pieces, after mc_compress ended):
    // in 1,000 evaluations paid in 10-evaluation clicks, mc_compress improved 65 clicks for 0.008 % in all,
    // shrink_repair 37 clicks for 0.494 %. With weights of 100 mc_compress earned more (204 RP against 159).
    const s0 = 6.332331689937728;
    const run = (clicks: number, cut: number) => {
      let total = 0;
      let steps = 0;
      let prev = s0;
      for (let i = 1; i <= clicks; i++) {
        const next = s0 * (1 - (cut * i) / clicks);
        total += recordPoints({ family: "polygon", N: 21, M: 24, P: 40, sPrev: prev, sNew: next, tier: "open" })!.total;
        steps += recordPoints({
          family: "polygon",
          N: 21,
          M: 24,
          P: 40,
          sPrev: prev,
          sNew: next,
          tier: "open",
        })!.nibble;
        prev = next;
      }
      return { total, steps };
    };
    const mc = run(65, 0.00008);
    const shrink = run(37, 0.00494);
    expect(shrink.total).toBeGreaterThan(2 * mc.total);
    // each of mc_compress's nibbles of about 1.2e-6 still pays its step term of about 4
    expect(mc.steps / 65).toBeGreaterThan(4);
    expect(mc.total).toBeGreaterThan(0.75 * mc.steps * shapeWeight(21, 24));
  });

  it("pays nothing at or below the floor, and one point just above it", () => {
    const s = 15.656167;
    const base = { family: "polygon", N: 7, M: 7, P: 197, sPrev: s, tier: "loose" as const };
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

  it("leaves the beat to the caller: a flagged step pays double even when tiny", () => {
    const s = 7.123456;
    const tiny = recordPoints({
      family: "polygon",
      N: 7,
      M: 7,
      P: 40,
      sPrev: s,
      sNew: s * (1 - 1e-8),
      tier: "loose",
      beatOther: true,
    })!;
    expect(tiny.beatBonus).toBe(true);
    expect(tiny.bonus).toBe(0);
  });
});
