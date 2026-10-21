import { describe, expect, it } from "vitest";
import { MAX_ARMS, choose, normalizeBandit, observe, posterior } from "../src/tighter/bandit";
import { mulberry32 } from "../src/tighter/dealer";

const generator = (seed: number) => {
  let k = 0;
  return () => mulberry32((seed + Math.imul(k++, 0x9e3779b1)) >>> 0);
};

describe("Tighter bandit", () => {
  it("keeps a running mean and variance per arm", () => {
    const b = {};
    for (const x of [1, 2, 3, 4]) observe(b, "a", x);
    expect(b).toEqual({ a: { n: 4, mean: 2.5, m2: 5 } });
    observe(b, "a", Number.NaN);
    expect((b as Record<string, { n: number }>).a.n).toBe(4);
  });

  it("starts from the prior and moves to the data as observations come", () => {
    const b = {};
    const prior = { mean: 0, sd: 1 };
    expect(posterior(b, "a", prior)).toEqual(prior);
    for (let i = 0; i < 50; i++) observe(b, "a", 10 + (i % 2 ? 0.1 : -0.1));
    const p = posterior(b, "a", prior);
    expect(p.mean).toBeGreaterThan(9.9);
    expect(p.sd).toBeLessThan(0.05);
  });

  it("chooses the arm that pays, while still trying arms it knows little about", () => {
    const b = {};
    const rand = generator(7);
    const prior = () => ({ mean: 1, sd: 1 });
    for (let i = 0; i < 30; i++) {
      observe(b, "good", 2 + 0.1 * Math.sin(i));
      observe(b, "bad", 0.5 + 0.1 * Math.cos(i));
    }
    const picks = { good: 0, bad: 0, new: 0 } as Record<string, number>;
    for (let i = 0; i < 400; i++) picks[choose(b, ["good", "bad", "new"], prior, rand)!]++;
    expect(picks.good).toBeGreaterThan(picks.bad);
    expect(picks.new).toBeGreaterThan(0);
    expect(picks.bad).toBeLessThan(10);
    expect(choose(b, [], prior, rand)).toBeNull();
  });

  it("reads only well-formed arms from a save, and forgets the least observed past its limit", () => {
    expect(normalizeBandit({ a: { n: 2, mean: 1, m2: 0.5 }, b: { n: -1, mean: 0, m2: 0 }, c: "x" })).toEqual({
      a: { n: 2, mean: 1, m2: 0.5 },
    });
    expect(normalizeBandit([1])).toEqual({});
    const b = {};
    for (let i = 0; i <= MAX_ARMS; i++) observe(b, `k${i}`, 1);
    observe(b, "k0", 1);
    expect(Object.keys(b).length).toBe(MAX_ARMS);
    expect(b).toHaveProperty("k0");
  });
});
