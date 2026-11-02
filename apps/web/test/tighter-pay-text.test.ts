import { describe, expect, it } from "vitest";
import {
  bonusRow,
  factor,
  improvementShares,
  multiplierOf,
  multiplierRow,
  payDetail,
  sharesText,
} from "../src/tighter/pay-text";

const base = { shape: 1, cost: 2.1, standing: 1, collections: 1, rules: 1 };

describe("pay text", () => {
  it("formats factors", () => {
    expect(factor(2)).toBe("2");
    expect(factor(2.1)).toBe("2.1");
    expect(factor(1.05)).toBe("1.05");
    expect(factor(1.5)).toBe("1.5");
  });
  it("lists shape and cost always, the rest only when not 1", () => {
    expect(multiplierRow(base)).toBe("Pays × 1.0 shape × 2.1 cost");
    const all = { ...base, standing: 2, collections: 1.05, rules: 1.5 };
    expect(multiplierRow(all)).toBe("Pays × 1.0 shape × 2.1 cost × 2 standing × 1.05 collections × 1.5 rules");
    expect(multiplierOf(all)).toBeCloseTo(3.15);
  });
  it("words the bonus row", () => {
    expect(bonusRow("lead", false)).toBe("10,000 RP bonus if you take the lead");
    expect(bonusRow("first", false)).toBe("1,000 RP bonus for the first record");
    expect(bonusRow("lead", true)).toBe("Bonus paid this cycle");
  });
  it("shares add up to one and sort largest first", () => {
    const s = improvementShares({ nibble: 3, size: 17, gap: 80, improvement: 5 })!;
    expect(s.step + s.size + s.gap).toBeCloseTo(1);
    expect(sharesText(s)).toBe("gap 80 %, size 17 %, step 3 %");
  });
  it("has no shares for a first record", () => {
    expect(improvementShares({ nibble: 1, size: 1, gap: 1, improvement: 0 })).toBeNull();
  });
  it("says under 1 % for a tiny share", () => {
    expect(sharesText({ step: 0.001, size: 0.2, gap: 0.799 })).toContain("step under 1 %");
  });
  it("details a payment with a bonus and a multiplier", () => {
    const text = payDetail({
      nibble: 3,
      size: 17,
      gap: 80,
      improvement: 5,
      bonus: "lead",
      bonusRp: 10000,
      multiplier: 4,
    }).join(" ");
    expect(text).toContain("gap 80 %, size 17 %, step 3 %");
    expect(text).toContain("multiplied by 4");
    expect(text).toContain("10,000 RP bonus for taking the lead");
  });
  it("details a first record as only the bonus", () => {
    const t = payDetail({ nibble: 1, size: 1, gap: 1, improvement: 0, bonus: "first", bonusRp: 1000, multiplier: 2 });
    expect(t.join(" ")).toContain("only a 1,000 RP bonus");
  });
});
