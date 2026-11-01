import { describe, expect, it } from "vitest";
import { POLYTOPE_INFO, lowerBound, polytopesOfDimension } from "@polypack/ndim";
import {
  ND_DIMENSIONS,
  ND_MAX_P,
  ND_P_RANGE,
  ND_PROBLEM_COUNT,
  ND_SHAPE_NAMES,
  ndBoundEntry,
  ndInRange,
  ndLowerBound,
  ndPairTitle,
  ndProblemCount,
  ndShapes,
  ndTitle,
  ndimDomain,
  parseNdId,
} from "../src/light";
import { ndProblemOf } from "../src/validate";

describe("the nD in nD catalogue", () => {
  it("names the polytopes of every dimension as the ndim package's catalogue does", () => {
    for (const d of ND_DIMENSIONS) {
      const codes = polytopesOfDimension(d).sort();
      const names = ndShapes(d)
        .filter((n) => n !== "ball")
        .map((n) => `${d}:${n}`)
        .sort();
      expect(names, `${d}D`).toEqual(codes);
    }
    expect(ND_SHAPE_NAMES).toContain("ball");
    expect(new Set(ND_SHAPE_NAMES).size).toBe(ND_SHAPE_NAMES.length);
  });

  it("counts the problems of each dimension: every ordered pair of its shapes times its range of P", () => {
    const counts = Object.fromEntries(ND_DIMENSIONS.map((d) => [d, ndProblemCount(d)]));
    // shapes: 4D 6 polytopes + ball, 5D 4 + 1, 6D 6 + 1, 7D 5 + 1, 8D 5 + 1, 9D and 10D 4 + 1
    expect(counts).toEqual({ 4: 49 * 39, 5: 25 * 31, 6: 49 * 23, 7: 36 * 19, 8: 36 * 19, 9: 25 * 19, 10: 25 * 19 });
    expect(ND_PROBLEM_COUNT).toBe(1911 + 775 + 1127 + 684 + 684 + 475 + 475);
    expect(ndimDomain.info.problems).toBe(ND_PROBLEM_COUNT);
    expect(ND_P_RANGE[4]).toEqual([2, 40]);
    expect(ND_P_RANGE[5]).toEqual([2, 32]);
    expect(ND_P_RANGE[6]).toEqual([2, 24]);
    for (const d of [7, 8, 9, 10]) expect(ND_P_RANGE[d]).toEqual([2, 20]);
    expect(ND_MAX_P).toBe(Math.max(...ND_DIMENSIONS.map((d) => ND_P_RANGE[d][1])));
  });

  it("parses ids in their one written form and refuses the rest", () => {
    expect(parseNdId("ndim/4/cube/ball/12")).toEqual({
      id: "ndim/4/cube/ball/12",
      d: 4,
      piece: "cube",
      container: "ball",
      P: 12,
    });
    expect(parseNdId("ndim/8/421/421/20")).toMatchObject({ d: 8, piece: "421", container: "421", P: 20 });
    for (const bad of [
      "ndim/3/cube/cube/5",
      "ndim/11/cube/cube/5",
      "ndim/04/cube/cube/5",
      "ndim/4/cube/cube/05",
      "ndim/4/cube/cube/+5",
      "ndim/4/demi/cube/5", // no demicube in 4D (it is the 16-cell)
      "ndim/5/24cell/cube/5",
      "ndim/4/cube/cube",
      "ndim/4/cube/cube/5/1",
      "ndim/4/4:cube/cube/5",
      "ndim/4/Cube/cube/5",
      "poly/4/cube/cube/5",
      "ndim/4/cube/cube/",
      "",
      " ndim/4/cube/cube/5",
    ])
      expect(typeof parseNdId(bad), bad).toBe("string");
    expect(typeof parseNdId(5)).toBe("string");
    expect(typeof parseNdId("ndim/4/cube/cube/5".padEnd(200, "x"))).toBe("string");
    // P outside the dimension's range parses; the range is applied apart
    expect(typeof parseNdId("ndim/7/cube/cube/21")).not.toBe("string");
    expect(ndInRange(7, 21)).toBe(false);
    expect(ndInRange(4, 40)).toBe(true);
    expect(ndInRange(4, 41)).toBe(false);
    expect(ndInRange(4, 1)).toBe(false);
    expect(ndInRange(4, 2.5)).toBe(false);
  });

  it("titles problems", () => {
    expect(ndPairTitle("cube", "ortho")).toBe("Hypercubes in an orthoplex");
    expect(ndPairTitle("ball", "421")).toBe("Balls in a 4_21 polytope");
    expect(ndTitle(6, "221", "ball")).toBe("6D: 2_21 polytopes in a ball");
  });

  it("bounds every problem of the domain by the core's bounds (and the circumscribed ball in a ball container)", () => {
    for (const d of ND_DIMENSIONS)
      for (const a of ndShapes(d))
        for (const b of ndShapes(d)) {
          const prob = { d, piece: a, container: b };
          for (const P of [ND_P_RANGE[d][0], ND_P_RANGE[d][1]]) {
            const mine = ndLowerBound(prob, P);
            const core = lowerBound(ndProblemOf(prob), P);
            // never below the core's; above it only by the circumradius bound of a ball container
            expect(mine.value, `${d} ${a} ${b} ${P}`).toBeGreaterThanOrEqual(core.value * (1 - 1e-15));
            if (mine.kind !== "circumradius") expect(mine.value).toBeCloseTo(core.value, 12);
            else {
              expect(b).toBe("ball");
              expect(mine.value).toBeCloseTo(2 * POLYTOPE_INFO.get(`${d}:${a}`)!.circumradius, 12);
            }
            const e = ndBoundEntry(prob, P);
            expect(e.value).toBeLessThan(mine.value);
            expect(e.value).toBeGreaterThan(mine.value * (1 - 1e-11));
            expect(e.label).toMatch(/^(volume|inradius|circumradius) bound; \[CALC\]$/);
          }
        }
  });

  it("bounds a few problems by hand", () => {
    // 2^4 hypercubes tile the hypercube of edge 2: the volume bound is exact
    expect(ndLowerBound({ d: 4, piece: "cube", container: "cube" }, 16).value).toBeCloseTo(2, 12);
    // balls in a ball: a ball of diameter 1 needs s >= 1; two balls need 2
    expect(ndLowerBound({ d: 5, piece: "ball", container: "ball" }, 2).value).toBeGreaterThanOrEqual(1);
    // a unit hypercube in a ball: its diagonal sqrt(d) is the container's diameter
    expect(ndLowerBound({ d: 9, piece: "cube", container: "ball" }, 2).value).toBeCloseTo(3, 12);
  });

  it("builds the domain: bound inside it, undefined outside, a sample of ids", () => {
    const inside = ndimDomain.bound({ fields: { d: 4, piece: "cube", container: "cube" }, P: 16 })!;
    expect(inside.value).toBeCloseTo(2, 9);
    expect(ndimDomain.bound({ fields: { d: 4, piece: "cube", container: "cube" }, P: 41 })).toBeUndefined();
    expect(ndimDomain.bound({ fields: { d: 4, piece: "demi", container: "cube" }, P: 5 })).toBeUndefined();
    expect(ndimDomain.bound({ fields: { d: 11, piece: "cube", container: "cube" }, P: 5 })).toBeUndefined();
    const sample = ndimDomain.sample(500);
    expect(sample).toHaveLength(500);
    expect(new Set(sample).size).toBe(500);
    for (const id of sample) {
      const p = parseNdId(id);
      expect(typeof p, id).not.toBe("string");
      if (typeof p !== "string") expect(ndInRange(p.d, p.P), id).toBe(true);
    }
    // small P first
    expect(sample[0]).toBe("ndim/4/simplex/simplex/2");
    const fields = ndimDomain.info.fields;
    expect(fields.map((f) => f.key)).toEqual(["d", "piece", "container", "P"]);
    expect(fields[3]).toMatchObject({ min: 2, max: 40, dependent: { on: "d" } });
  });
});
