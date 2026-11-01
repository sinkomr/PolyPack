import { describe, expect, it } from "vitest";
import { getPolytope, isLoaded, loadPolytope, problemErrors, validateNd } from "../src";

// This file never loads 8:421 before the first test, so it sees the on-demand behaviour.
describe("8:421 is loaded on demand", () => {
  it("is refused with a clear reason until loaded", async () => {
    expect(isLoaded("8:421")).toBe(false);
    expect(() => getPolytope("8:421")).toThrow(/await loadPolytope/);
    const p = { d: 8, piece: "8:simplex", container: "8:421" };
    expect(problemErrors(p).join(" ")).toMatch(/loaded on demand/);
    const r = validateNd(p, { s: 2, pieces: [new Array(8 + 28).fill(0)] });
    expect(r.valid).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/loaded on demand/);
    const P = await loadPolytope("8:421");
    expect(P.nF).toBe(19440);
    expect(P.V.length).toBe(240 * 8);
    expect(isLoaded("8:421")).toBe(true);
    expect(getPolytope("8:421")).toBe(P);
    expect(problemErrors(p)).toEqual([]);
    // another call returns the same object
    expect(await loadPolytope("8:421")).toBe(P);
  });
});
