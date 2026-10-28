import { describe, expect, it } from "vitest";
import { rulesOf } from "../src/tighter/families";
import {
  FRONTIER,
  ProblemKey,
  SpaceKey,
  familyDimension,
  isPolygon,
  keyOf,
  parseKey,
  poly,
  problemTitle,
} from "../src/tighter/frontier";
import { density, followed, newGame, newProblem } from "../src/tighter/game";
import { recordPoints } from "../src/tighter/points";
import { bucketOf, passes, priorPerEval } from "../src/tighter/rank";
import {
  RESET_MIN,
  dimensionOpenedBy,
  normalizeStanding,
  resetThreshold,
  ruleAllowsProblem,
  standingGain,
} from "../src/tighter/standing";
import { methodsFor } from "../src/tighter/upgrades";

const T0 = 1_700_000_000_000;
const sphere: SpaceKey = { family: "sphere", id: "sphere/0/12", P: 12 };

describe("Tighter problem keys", () => {
  it("name a polygon problem N/M/P and a space problem by its catalogue id", () => {
    expect(keyOf(poly(24, 30, 60))).toBe("24/30/60");
    expect(keyOf(sphere)).toBe("sphere/0/12");
    expect(keyOf({ family: "surface", id: "surface/cube/fold/7/20", P: 20 })).toBe("surface/cube/fold/7/20");
    for (const p of FRONTIER.slice(0, 50)) expect(parseKey(keyOf(p))).toEqual(p);
  });

  it("read both kinds back, the piece count of a space problem from its last segment", () => {
    expect(parseKey("24/30/60")).toEqual({ family: "polygon", N: 24, M: 30, P: 60 });
    expect(parseKey("sphere/0/12")).toEqual(sphere);
    expect(parseKey("surface/cube/fold/7/20")).toEqual({ family: "surface", id: "surface/cube/fold/7/20", P: 20 });
    expect(parseKey("polyhedra/abc/30")).toEqual({ family: "polyhedra", id: "polyhedra/abc/30", P: 30 });
    expect(parseKey("balls/3/9")).toMatchObject({ family: "balls", P: 9 });
  });

  it("reject anything else", () => {
    for (const bad of [
      "",
      "24/30",
      "24/30/x",
      "-1/3/4",
      "1/2/3/4",
      "polygon/1/2",
      "cube/0/12",
      "sphere",
      "sphere/0/x",
      "sphere/0/",
    ])
      expect(parseKey(bad)).toBeNull();
  });

  it("tell the polygon family from the others, and put each family in its dimension", () => {
    expect(isPolygon(poly(3, 4, 5))).toBe(true);
    expect(isPolygon(sphere)).toBe(false);
    expect(familyDimension("polygon")).toBe("2-in-2");
    expect(familyDimension("curved")).toBe("2-in-2");
    for (const f of ["surface", "sphere", "torus"] as const) expect(familyDimension(f)).toBe("2-on-3");
    for (const f of ["polyhedra", "balls"] as const) expect(familyDimension(f)).toBe("3-in-3");
  });
});

describe("Tighter family rules", () => {
  it("give a polygon problem its title, score word, weight and bound", () => {
    const r = rulesOf(poly(60, 0, 80));
    expect(r.family).toBe("polygon");
    expect(r.dimension).toBe("2-in-2");
    expect(r.title(poly(60, 47, 80))).toBe(problemTitle(poly(60, 47, 80)));
    expect(r.scoreWord(poly(60, 0, 80))).toBe("diameter");
    expect(r.scoreWord(poly(60, 47, 80))).toBe("side");
    expect(r.weight(poly(40, 40, 80))).toBeCloseTo(0.25, 12);
    expect(r.bound(poly(24, 30, 60))!).toBeGreaterThan(0);
  });

  it("give every space family its rules", () => {
    expect(rulesOf(sphere).family).toBe("sphere");
    expect(rulesOf(sphere).dimension).toBe("2-on-3");
    expect(rulesOf({ family: "polyhedra", id: "polyhedra/cubintet/12", P: 12 }).dimension).toBe("3-in-3");
  });
});

describe("Tighter polygon-only paths given a space problem", () => {
  it("throw 'not yet' where a polygon's N and M are needed", () => {
    expect(() => problemTitle(sphere)).toThrow("not yet");
    expect(() => density(sphere, 2)).toThrow("not yet: density for sphere");
  });

  it("are handled by the rank, the filters and the points", () => {
    expect(bucketOf({ ...sphere, tier: "open" })).toBe("open|sphere|r6");
    expect(priorPerEval({ ...sphere, tier: "open", weakness: null })).toBeGreaterThan(0);
    // the shape filters are polygon shapes, so a space problem passes them
    expect(passes({ pieces: [3], containers: null, minP: 1, maxP: 500, tiers: null }, sphere)).toBe(true);
    expect(passes({ pieces: null, containers: null, minP: 1, maxP: 5, tiers: null }, sphere)).toBe(false);
    expect(recordPoints({ ...sphere, bound: 1, sPrev: 2, sNew: 1.5, tier: "open" })!.total).toBeGreaterThan(0);
  });

  it("pass under a cycle rule that reads N and M, which covers polygon problems only", () => {
    const s = normalizeStanding({}, T0);
    expect(ruleAllowsProblem(s, sphere)).toBe(true);
    expect(ruleAllowsProblem({ ...s, rule: "circles" }, sphere)).toBe(true);
    expect(ruleAllowsProblem({ ...s, rule: "small" }, sphere)).toBe(true);
  });

  it("are skipped by the live feed, which follows polygon problems only", () => {
    const g = newGame(T0, 1);
    g.queue.push(newProblem(poly(24, 30, 60), "open", T0), newProblem(sphere, "open", T0));
    expect(followed(g)).toEqual([poly(24, 30, 60)]);
  });

  it("carry the server's bound on a space problem, and none on a polygon one", () => {
    expect(newProblem(sphere, "open", T0)).toMatchObject({
      family: "sphere",
      id: "sphere/0/12",
      key: "sphere/0/12",
      bound: null,
    });
    const p: ProblemKey = poly(24, 30, 60);
    expect(newProblem(p, "open", T0)).toMatchObject({ family: "polygon", N: 24, bound: null });
  });
});

describe("Tighter standing across dimensions", () => {
  it("open the first dimension by default, and read a saved list in the table's order", () => {
    expect(normalizeStanding({}, T0).dimensions).toEqual(["2-in-2"]);
    expect(normalizeStanding({ dimensions: ["3-in-3", "2-on-3", "x", "3-in-3"] }, T0).dimensions).toEqual([
      "2-in-2",
      "2-on-3",
      "3-in-3",
    ]);
  });

  it("open 2 on 3 at the first reset and 3 in 3 at the second", () => {
    expect(dimensionOpenedBy(0)).toBeNull();
    expect(dimensionOpenedBy(1)).toBe("2-on-3");
    expect(dimensionOpenedBy(2)).toBe("3-in-3");
    expect(dimensionOpenedBy(3)).toBeNull();
  });

  it("ask 5 times the record points of the cycle before, and take the threshold in the gain", () => {
    expect([0, 1, 2, 3].map(resetThreshold)).toEqual([1e9, 5e9, 2.5e10, 1.25e11]);
    expect(resetThreshold(0)).toBe(RESET_MIN);
    expect(standingGain(RESET_MIN)).toBe(standingGain(RESET_MIN, resetThreshold(0)));
    expect(standingGain(RESET_MIN, 2 * RESET_MIN)).toBe(0);
  });
});

describe("Tighter methods per family", () => {
  it("are today's list for polygons and none for the other families", () => {
    expect(methodsFor("polygon")).toContain("mc_compress");
    expect(methodsFor("polygon")).toHaveLength(9);
    for (const f of ["curved", "surface", "sphere", "torus", "polyhedra", "balls"] as const)
      expect(methodsFor(f)).toEqual([]);
  });
});
