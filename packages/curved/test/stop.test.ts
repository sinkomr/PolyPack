/**
 * The optional shouldStop of the search (search.ts), L-BFGS (optim.ts) and the polish (polish.ts):
 * without a stop that fires the search is unchanged, and a stop ends it within one inner step.
 */
import { describe, expect, it } from "vitest";
import { lbfgs, makeSpace, polish, search, validate } from "../src";

describe("shouldStop", () => {
  it("leaves a seeded search unchanged when it never fires", () => {
    const space = makeSpace(-1, 3, 4);
    const a = search(space, 3, { seed: 5, restarts: 1, hops: 2 });
    const b = search(space, 3, { seed: 5, restarts: 1, hops: 2, shouldStop: () => false });
    expect(a.found).toBe(true);
    expect(b).toEqual(a);
  });

  it("ends a search inside its first restart, returning what it has", () => {
    const space = makeSpace(-1, 3, 8);
    let polls = 0;
    const t = performance.now();
    const r = search(space, 29, { seed: 3, restarts: 1, hops: 0, lbfgsIter: 150, shouldStop: () => ++polls > 200 });
    expect(performance.now() - t).toBeLessThan(5000);
    expect(r.restartsDone).toBe(1);
    // polled many times inside the one restart
    expect(polls).toBeGreaterThan(200);
    if (r.config) expect(validate({ N: 3, M: 8, P: 29 }, -1, r.config).valid).toBe(true);
  });

  it("stops L-BFGS and the polish at their next iteration", () => {
    let calls = 0;
    const f = (x: Float64Array, g: Float64Array) => {
      calls++;
      g[0] = 2 * (x[0] - 3);
      return (x[0] - 3) ** 2;
    };
    const r = lbfgs(f, Float64Array.from([0]), { maxIter: 100, shouldStop: () => true });
    expect(r.iterations).toBe(0);
    expect(calls).toBe(1);
    const space = makeSpace(-1, 3, 4);
    const found = search(space, 3, { seed: 2, restarts: 1, hops: 0 });
    const p = polish(space, found.config!.pieces, undefined, { shouldStop: () => true });
    expect(p.iterations).toBe(0);
  });
});
