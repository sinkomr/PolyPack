import { describe, expect, it } from "vitest";
import { SCORE_TIE, areaLowerBound, improvesOn } from "@polypack/geometry";
import {
  BONUS_RP,
  FIRST_BONUS,
  FLOOR,
  GAP_WEIGHT,
  G_MIN,
  LEAD_BONUS,
  SIZE_WEIGHT,
  STEP_WEIGHT,
  TIERS,
  costFactor,
  recordPoints,
  shapeWeight,
} from "../src/tighter/points";
import { msPerEval, rulesOf } from "../src/tighter/families";

// The worked examples of design.md §5 (balance/results/points-examples.txt), at F = 1e-9, with the size
// and gap weights of 2026-10-22 (10,000 each) and, since 2026-11-01, a step term of a tenth and flat
// bonuses instead of tier weights, the beat factor and the first-record bonus of 10.
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

  it("reproduces (a), the first record of 33-gons in a 47-gon, P 197: the improvement terms, unpaid for a first record", () => {
    const input = { ...P33, sPrev: 12.524084913326904, sNew: 11.887296419456838, tier: "open" } as const;
    const p = recordPoints(input)!;
    expect(p.nibble).toBeCloseTo(0.871, 3);
    expect(p.size).toBeCloseTo(521.83, 2);
    expect(p.gap).toBeCloseTo(2716.64, 2);
    expect(p.improvement / costFactor(P33)).toBeCloseTo((0.871 + 521.83 + 2716.64) * shapeWeight(33, 47), 1);
    expect(p.bonus).toBeNull();
    // as a first record it pays only the 1,000 RP bonus
    const first = recordPoints({ ...input, bonus: "first" })!;
    expect(first.improvement).toBe(0);
    expect(first.bonusRp).toBe(FIRST_BONUS);
    expect(first.total).toBe(1000);
  });

  it("reproduces (b), one Evolve click, and (d), basin hopping's jump, with a step term of a tenth", () => {
    const k = costFactor(P33);
    const w = shapeWeight(33, 47);
    // (b) paid 37.28 and (d) 2114.18 with a step term of 1 + log10(Δ / F); it is now 0.1 times that
    const decades = (a: number, b: number) => Math.log10((1 - b / a) / 1e-9);
    expect(
      recordPoints({ ...P33, sPrev: 11.887296419456838, sNew: 11.863522, tier: "open" })!.improvement / k,
    ).toBeCloseTo(37.28 - 0.9 * (1 + decades(11.887296419456838, 11.863522)) * w, 1);
    expect(
      recordPoints({ ...P33, sPrev: 11.887296419456838, sNew: 10.834199, tier: "open" })!.improvement / k,
    ).toBeCloseTo(2114.18 - 0.9 * (1 + decades(11.887296419456838, 10.834199)) * w, 1);
  });

  it("pays a flat bonus with no weight, tier or cost factor in it", () => {
    const s = 15.656167;
    for (const tier of TIERS) {
      for (const family of [
        { N: 7, M: 7, P: 197 },
        { N: 100, M: 100, P: 300 },
      ]) {
        const input = { family: "polygon" as const, ...family, sPrev: s, sNew: s * (1 - 5e-4), tier };
        const plain = recordPoints(input)!;
        const lead = recordPoints({ ...input, bonus: "lead" })!;
        // the improvement is the same, the bonus is added whole
        expect(lead.improvement).toBe(plain.improvement);
        expect(lead.total).toBeCloseTo(plain.improvement + LEAD_BONUS, 9);
        expect(lead.bonusRp).toBe(10_000);
        expect(plain.total).toBe(plain.improvement);
      }
    }
    expect(BONUS_RP).toEqual({ first: 1000, lead: 10_000 });
  });

  it("scales pay by the cost of an evaluation: 1 at N+M+P = 85, more for slower problems, 5 ms for spaces", () => {
    expect(costFactor({ family: "polygon", N: 21, M: 24, P: 40 })).toBeCloseTo(1, 12);
    expect(costFactor({ family: "polygon", N: 30, M: 36, P: 200 })).toBeCloseTo(msPerEval(266) / 1.77, 12);
    expect(costFactor({ family: "polygon", N: 100, M: 100, P: 300 })).toBeCloseTo(52.3 / 1.77, 12);
    expect(costFactor({ family: "polygon", N: 4, M: 4, P: 10 })).toBeLessThan(0.2);
    // outside 2D in 2D the factor is worked out the same way, from the cost of the game evaluation
    const sph = { family: "sphere", id: "sphere/0/12", P: 12 } as const;
    expect(costFactor(sph)).toBeCloseTo(rulesOf(sph).evalMs(sph) / 1.77, 12);
    expect(costFactor(sph)).toBeCloseTo(msPerEval(20) / 1.77, 1);
    // the same board and the same step pay in proportion to the factor, nothing else changes
    const a = { family: "polygon", N: 24, M: 30, P: 40, sPrev: 8, sNew: 7.9, tier: "open" } as const;
    const b = { ...a, P: 200 };
    const pa = recordPoints(a)!;
    const pb = recordPoints(b)!;
    expect(pa.improvement / pa.k / pa.w).toBeCloseTo(pa.nibble + pa.size + pa.gap, 9);
    expect(pb.k / pa.k).toBeCloseTo(costFactor(b) / costFactor(a), 12);
  });

  it("pays the same per second of solver time at every size, for the same relative progress", () => {
    // a step of 10 evaluations that cuts 0.1 % at a gap of 23 %, shape weight removed: RP per ms of evaluation
    const perMs = (P: number) => {
      const N = 24;
      const M = 30;
      const sPrev = areaLowerBound(N, M, P) * 1.23;
      const p = recordPoints({ family: "polygon", N, M, P, sPrev, sNew: sPrev * (1 - 0.001), tier: "open" })!;
      return p.improvement / p.w / (10 * msPerEval(N + M + P));
    };
    const rates = [40, 80, 150, 250, 400].map(perMs);
    expect(Math.max(...rates) / Math.min(...rates)).toBeCloseTo(1, 9);
  });

  it("pays the step term a tenth of what it was", () => {
    expect(STEP_WEIGHT).toBe(0.1);
    const s = 7.123456;
    const p = recordPoints({ family: "polygon", N: 7, M: 7, P: 40, sPrev: s, sNew: s * (1 - 1e-3), tier: "batch" })!;
    // Δ = 1e-3 is 6 decades above the floor
    expect(p.nibble).toBeCloseTo(0.1 * 7, 6);
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
        total += recordPoints({
          family: "polygon",
          N: 21,
          M: 24,
          P: 40,
          sPrev: prev,
          sNew: next,
          tier: "open",
        })!.improvement;
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
    // each of mc_compress's nibbles of about 1.2e-6 pays a step term of about 0.4, a tenth of what it was
    expect(mc.steps / 65).toBeGreaterThan(0.4);
    expect(mc.steps / 65).toBeLessThan(0.6);
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
    expect(justAbove.nibble).toBeCloseTo(0.1, 4);
    expect(justAbove.decades).toBeGreaterThanOrEqual(0);
    // the nibble term adds a tenth of a point per decade: 0.1, 0.2, 0.3 at 1e-9, 1e-8, 1e-7 (above the floor)
    expect(recordPoints({ ...base, sNew: s * (1 - 1.0000001e-8) })!.nibble).toBeCloseTo(0.2, 5);
    expect(recordPoints({ ...base, sNew: s * (1 - 1.0000001e-7) })!.nibble).toBeCloseTo(0.3, 5);
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
});

describe("Tighter gap floor", () => {
  const bound = areaLowerBound(24, 30, 40);
  const at = (g: number) => bound * (1 + g);
  const pay = (gPrev: number, gNew: number) =>
    recordPoints({ family: "polygon", N: 24, M: 30, P: 40, sPrev: at(gPrev), sNew: at(gNew), tier: "open" })!;

  it("counts g as at least G_MIN: a board that reaches its bound pays the floored amount", () => {
    expect(G_MIN).toBe(0.01);
    const p = pay(0.2, 1e-9);
    expect(p.gap).toBeCloseTo(GAP_WEIGHT * Math.log(0.2 / G_MIN), 6);
  });

  it("pays a gap above the floor as before, and nothing from the floor to the floor", () => {
    const p = pay(0.2, 0.05);
    expect(p.gap).toBeCloseTo(GAP_WEIGHT * Math.log(0.2 / 0.05), 6);
    const q = pay(0.009, 1e-9);
    expect(q.gap).toBe(0);
    expect(q.size).toBeGreaterThan(0);
  });
});
