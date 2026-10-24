/**
 * The optional shouldStop of the contact-LP polish (slp.ts), which it also polls inside an
 * iteration (per piece of the derivatives, in the simplex, per trial step).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSolid, validateFold } from "../src/index";
import { simplex, slpPolish } from "../src/search/slp";

const records = JSON.parse(
  readFileSync(new URL("../../../data/surface/records.json", import.meta.url), "utf8"),
).records;
/** A record on the unit solid: pieces scaled by lam = 1/s, as the search works. */
function unit(id: string) {
  const r = records.find((x: { id: string }) => x.id === id);
  return {
    solid: getSolid(r.solid),
    N: r.N as number,
    lam: 1 / r.s,
    poses: r.pieces.map((p: { face: number; x: number; y: number; theta: number }) => ({
      ...p,
      x: p.x / r.s,
      y: p.y / r.s,
    })),
  };
}

describe("slpPolish shouldStop", () => {
  it("leaves the polish unchanged when it never fires", () => {
    const u = unit("surface/cube/fold/3/7");
    const shrunk = u.lam * 0.98;
    const a = slpPolish(u.solid, u.N, shrunk, u.poses, { iterations: 15 });
    const b = slpPolish(u.solid, u.N, shrunk, u.poses, { iterations: 15, shouldStop: () => false });
    expect(b).toEqual(a);
    expect(a.lam).toBeGreaterThan(shrunk);
  });

  it("stops inside an iteration and returns the last accepted packing, still valid", () => {
    const u = unit("surface/icosahedron/fold/3/40");
    const shrunk = u.lam * 0.99;
    for (const after of [1, 5, 40, 400]) {
      let polls = 0;
      const r = slpPolish(u.solid, u.N, shrunk, u.poses, { iterations: 50, shouldStop: () => ++polls > after });
      expect(r.lam).toBeGreaterThanOrEqual(shrunk);
      const s = 1 / r.lam;
      const cfg = { solid: u.solid.name, N: u.N, s, pieces: r.poses.map((p) => ({ ...p, x: p.x * s, y: p.y * s })) };
      expect(validateFold(cfg, { tol: 1e-10 }).ok).toBe(true);
    }
  });

  it("gives up a simplex when told to", () => {
    // maximise the sum of 20 variables, each at most 1: one pivot per variable
    const n = 20;
    const A = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, j) => (j === r ? 1 : 0)));
    const b = new Array(n).fill(1);
    const c = new Array(n).fill(1);
    expect(simplex(A, b, c)).toEqual(new Array(n).fill(1));
    expect(simplex(A, b, c, 5000, () => false)).toEqual(new Array(n).fill(1));
    let polls = 0;
    expect(simplex(A, b, c, 5000, () => ++polls >= 2)).toBeNull();
    // polled every 8 pivots
    expect(polls).toBe(2);
  });
});
