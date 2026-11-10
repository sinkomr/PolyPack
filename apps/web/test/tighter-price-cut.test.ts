import { describe, expect, it } from "vitest";
import {
  TAPER_FROM,
  TAPER_TO,
  UPGRADES,
  autoLevelPrice,
  costOf,
  headStartGives,
  isCardSlice,
  listPrice,
  owning,
  slicePrice,
  taperedPrice,
  upgrade,
  type UpgradeId,
} from "../src/tighter/upgrades";
import { RESET_MIN } from "../src/tighter/points";
import { resetThreshold } from "../src/tighter/standing";

// The price cut of 2026-11-09: Standing 5x cheaper, every other record-point price tapered (upgrades.ts)
describe("Tighter taperedPrice", () => {
  it("leaves prices up to 200,000 alone, takes the geometric mean up to 5,000,000 and a fifth above", () => {
    expect([TAPER_FROM, TAPER_TO]).toEqual([200_000, 5_000_000]);
    expect(taperedPrice(40)).toBe(40);
    expect(taperedPrice(200_000)).toBe(200_000);
    expect(taperedPrice(1_800_000)).toBeCloseTo(Math.sqrt(2e5 * 1.8e6), 6);
    expect(taperedPrice(5_000_000)).toBe(1_000_000);
    expect(taperedPrice(24_000_000)).toBe(4_800_000);
    expect(taperedPrice(Infinity)).toBe(Infinity);
  });

  it("is continuous at 200,000 and at 5,000,000", () => {
    expect(taperedPrice(200_000.001)).toBeCloseTo(200_000, 3);
    expect(taperedPrice(4_999_999.99)).toBeCloseTo(1_000_000, 2);
    expect(taperedPrice(5_000_000)).toBeCloseTo(Math.sqrt(2e5 * 5e6), 6);
  });

  it("never decreases, so no card becomes cheaper than one that cost less before", () => {
    let last = 0;
    for (let p = 1; p < 1e12; p *= 1.013) {
      const t = taperedPrice(p);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });
});

describe("Tighter costOf after the price cut", () => {
  const o = (ids: UpgradeId[] = [], levels = {}, resets = 0) =>
    owning(ids, levels, null, [], [], resets, ["2-in-2", "2-on-3", "3-in-3"]);

  it("leaves a plain card up to 200,000 as it was and tapers the dearer ones", () => {
    expect(costOf(o(), "rent")).toBe(upgrade("rent").cost);
    expect(upgrade("rent").cost).toBeLessThanOrEqual(200_000);
    expect(costOf(o(), "ring80")).toBe(Math.round(Math.sqrt(2e5 * 1_200_000)));
    expect(costOf(o(), "ring80")).toBe(489_898);
    expect(costOf(o(), "ringAll")).toBe(4_800_000);
  });

  it("tapers each level of a levelled card from its own list price", () => {
    const l = (n: number) =>
      costOf(o(n ? ["lanes2", "continuous", "lanesx"] : ["lanes2", "continuous"], { lanesx: n }), "lanesx");
    expect(l(0)).toBe(Math.round(taperedPrice(480_000)));
    expect(l(4)).toBe(Math.round(taperedPrice(480_000 * 2.2 ** 4)));
    expect(l(9)).toBe(Math.round((480_000 * 2.2 ** 9) / 5));
    expect(l(9)).toBeGreaterThan(l(8)!);
  });

  it("tapers Faster auto-eval's levels, and first cuts a level past 200,000", () => {
    const at = (n: number) => costOf(o(n ? ["auto1", "autox"] : ["auto1"], { autox: n }), "autox")!;
    expect(at(0)).toBe(Math.round(autoLevelPrice(0)));
    const first = Array.from({ length: 400 }, (_, n) => n).find((n) => autoLevelPrice(n) > TAPER_FROM)!;
    expect(first).toBeGreaterThan(0);
    expect(at(first - 1)).toBe(Math.round(autoLevelPrice(first - 1)));
    expect(at(first)).toBeLessThan(Math.round(autoLevelPrice(first)));
    expect(at(first)).toBe(Math.round(taperedPrice(autoLevelPrice(first))));
    const high = 250;
    expect(autoLevelPrice(high)).toBeGreaterThan(TAPER_TO);
    expect(at(high)).toBe(Math.round(autoLevelPrice(high) / 5));
  });

  it("applies Quick study after the taper", () => {
    const studied = owning(["study"], { study: 2 });
    expect(costOf(studied, "ring80")).toBe(Math.round(Math.sqrt(2e5 * 1_200_000) * 0.81));
    expect(costOf(studied, "ringAll")).toBe(Math.round(4_800_000 * 0.81));
  });

  it("prices Standing at 200,000,000 and five times that after each reset, with no taper or discount", () => {
    expect(RESET_MIN).toBe(200_000_000);
    expect(costOf(o(), "standing")).toBe(200_000_000);
    expect(costOf(o([], {}, 1), "standing")).toBe(1_000_000_000);
    expect(costOf(o([], {}, 1), "standing")).toBe(resetThreshold(1));
    expect(costOf(owning(["study"], { study: 3 }), "standing")).toBe(200_000_000);
  });

  it("prices a slice card from the cheaper threshold without a second cut", () => {
    expect(costOf(o(), "curved")).toBe(60_000_000);
    expect(costOf(o(), "curved")).toBe(slicePrice("curved", 0));
    expect(listPrice("curved")).toBe(upgrade("curved").cost);
    expect(costOf(o([], {}, 1), "surf-prisms")).toBe(2_000_000);
  });

  it("charges what listPrice lists, before Quick study, for every card paid in record points", () => {
    for (const u of UPGRADES) {
      if (u.currency === "standing" || u.id === "standing" || isCardSlice(u.id) || u.levels?.max === Infinity) continue;
      expect(costOf(o(), u.id), u.id).toBe(Math.round(listPrice(u.id)));
    }
  });
});

describe("Tighter Head start after the price cut", () => {
  it("counts the tapered prices, so level 2 also gives Ring 50 and Published", () => {
    const ids = headStartGives(2).ids;
    expect(ids).toContain("ring50");
    expect(ids).toContain("published");
    expect(headStartGives(1).ids).not.toContain("ring50");
    expect(listPrice("ring50")).toBeLessThanOrEqual(1_000_000);
    expect(upgrade("ring50").cost).toBeGreaterThan(1_000_000);
  });
});
