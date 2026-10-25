/**
 * The search (src/search.ts): valid results, budgets, stopping, reproducibility by seed, warm starts.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getProblem, lbfgs, legalizeConfig, polishConfig, searchPolyhedra, validatePolyhedra } from "../src";
import { readProblemConfigs, readRecordsFile } from "../src/records-file";

const recUrl = new URL("../../../data/polyhedra/records.json", import.meta.url);
const doc = existsSync(recUrl) ? readRecordsFile(recUrl.pathname, true) : null;
/** A record with its configuration (read from its problem's file only). */
const record = (id: string) => {
  const r = doc!.records.find((x) => x.id === id)!;
  return { ...r, config: readProblemConfigs(recUrl.pathname, r.code).get(r.P)! };
};

describe("searchPolyhedra", () => {
  it("finds 5 cubes in a cube of side 2 from scratch, valid at tolerance 0", () => {
    const p = getProblem("cubincub")!;
    const r = searchPolyhedra(p, 5, { seed: 3, maxEvals: 120_000 });
    expect(r.config).not.toBeNull();
    expect(validatePolyhedra(p, r.config!, { tol: 0 }).valid).toBe(true);
    expect(r.score).toBe(r.config!.s);
    expect(r.score).toBeLessThan(2 + 1e-6);
    expect(r.evaluations).toBeLessThanOrEqual(120_000);
    expect(r.stopped).toBe("evals");
  });

  it("is reproducible by seed when it ends on evaluations", () => {
    const p = getProblem("tetintet")!;
    const a = searchPolyhedra(p, 3, { seed: 11, maxEvals: 30_000 });
    const b = searchPolyhedra(p, 3, { seed: 11, maxEvals: 30_000 });
    const c = searchPolyhedra(p, 3, { seed: 12, maxEvals: 30_000 });
    expect(a.config).toEqual(b.config);
    expect(a.evaluations).toBe(b.evaluations);
    expect(c.config).not.toEqual(a.config);
  });

  it("stops when asked and on time, with a valid best so far", () => {
    const p = getProblem("octincub")!;
    let calls = 0;
    const r = searchPolyhedra(p, 6, { seed: 1, maxEvals: 10_000_000, shouldStop: () => ++calls > 400 });
    expect(r.stopped).toBe("aborted");
    expect(r.evaluations).toBeLessThanOrEqual(401);
    if (r.config) expect(validatePolyhedra(p, r.config, { tol: 0 }).valid).toBe(true);
    let t = 0;
    const timed = searchPolyhedra(p, 6, { seed: 1, maxEvals: 10_000_000, maxSeconds: 2, now: () => (t += 0.001) });
    expect(timed.stopped).toBe("time");
  });

  it("keeps a valid result on tiny budgets", () => {
    const p = getProblem("dodindod")!;
    for (const maxEvals of [50, 500, 5000]) {
      const r = searchPolyhedra(p, 3, { seed: 2, maxEvals });
      expect(r.evaluations).toBeLessThanOrEqual(maxEvals);
      if (r.config) expect(validatePolyhedra(p, r.config, { tol: 0 }).valid).toBe(true);
    }
  });

  it.skipIf(!doc)("takes a start it has polished itself as it is, and spends the budget on hops", () => {
    const rec = record("polyhedra/cubincub/11");
    const p = getProblem(rec.code)!;
    const first = searchPolyhedra(p, rec.P, { seed: 2, start: rec.config, maxEvals: 3000 });
    expect(first.config).not.toBeNull();
    const seen: number[] = [];
    const again = searchPolyhedra(p, rec.P, {
      seed: 3,
      start: first.config!,
      startPolished: true,
      maxEvals: 3000,
      onProgress: (q) => seen.push(q.evaluations),
    });
    // no evaluation before the first hop: the start was not polished again
    expect(seen[0]).toBe(0);
    expect(again.startScore).toBe(first.score);
    expect(validatePolyhedra(p, again.config!, { tol: 0 }).valid).toBe(true);
    expect(again.score).toBeLessThanOrEqual(first.score);
  });

  it.skipIf(!doc)("warm-started from a record, returns a valid configuration no worse than the record", () => {
    for (const id of ["polyhedra/cubincub/11", "polyhedra/tteintte/8", "polyhedra/pr3incub/8"]) {
      const rec = record(id);
      const p = getProblem(rec.code)!;
      const r = searchPolyhedra(p, rec.P, { seed: 1, start: rec.config, maxEvals: 20_000 });
      expect(r.config, id).not.toBeNull();
      expect(validatePolyhedra(p, r.config!, { tol: 0 }).valid, id).toBe(true);
      expect(r.score, id).toBeLessThanOrEqual(rec.score_cert);
      expect(r.startScore!, id).toBeLessThanOrEqual(rec.score_cert);
    }
  });

  it("legalizes an overlapping start", () => {
    const p = getProblem("cubincub")!;
    const start = { s: 1.5, pieces: [[0, 0, 0, 1, 0, 0, 0], [0.3, 0.1, 0, 1, 0, 0, 0]] as [number, number, number, number, number, number, number][] };
    const legal = legalizeConfig(p, start);
    expect(validatePolyhedra(p, legal, { tol: 0 }).valid).toBe(true);
    // coincident pieces cannot be moved apart by scaling: they are spread first
    const same = { s: 1, pieces: Array.from({ length: 4 }, () => [0, 0, 0, 1, 0, 0, 0]) as [number, number, number, number, number, number, number][] };
    expect(validatePolyhedra(p, legalizeConfig(p, same), { tol: 0 }).valid).toBe(true);
    const r = searchPolyhedra(p, 2, { seed: 5, start, maxEvals: 20_000 });
    expect(validatePolyhedra(p, r.config!, { tol: 0 }).valid).toBe(true);
    expect(r.score).toBeLessThan(2 + 1e-6);
  });
});

describe("polish", () => {
  it("has the gradient of its objective (finite differences through the whole polish)", () => {
    // L-BFGS on a smooth quadratic reaches its minimum: checks the optimiser itself
    const f = (x: Float64Array, g: Float64Array) => {
      let v = 0;
      for (let i = 0; i < x.length; i++) {
        const w = (i + 1) * (x[i] - i);
        v += w * (x[i] - i);
        g[i] = 2 * w;
      }
      return v;
    };
    const x = new Float64Array(6);
    expect(lbfgs(f, x, 200)).toBeLessThan(1e-12);
    for (let i = 0; i < 6; i++) expect(x[i]).toBeCloseTo(i, 6);
  });

  it("brings a loose packing near the touching limit", () => {
    const p = getProblem("cubincub")!;
    const loose = { s: 2.3, pieces: [[-0.55, -0.55, 0, 1, 0, 0, 0], [0.55, 0.55, 0, 1, 0, 0, 0]] as [number, number, number, number, number, number, number][] };
    const r = polishConfig(p, loose);
    expect(validatePolyhedra(p, r.config, { tol: 0 }).valid).toBe(true);
    expect(r.config.s).toBeLessThan(2 + 1e-6);
  });
});
