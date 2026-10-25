import { describe, expect, it } from "vitest";
import { POLYTOPES, PIECES, formatBoundaryId, getPolytope, parseBoundaryId, standardPiece, toAmbient } from "../src/index";

describe("problem ids", () => {
  it("parses and formats the one written form", () => {
    expect(parseBoundaryId("boundary/tesseract/ball/9")).toEqual({ polytope: "tesseract", piece: "ball", P: 9 });
    expect(parseBoundaryId("boundary/tesseract/cube/9999")).toEqual({ polytope: "tesseract", piece: "cube", P: 9999 });
    for (const polytope of POLYTOPES)
      for (const piece of PIECES)
        for (const P of [1, 7, 10, 123, 9999]) {
          const id = formatBoundaryId({ polytope, piece, P });
          expect(id).toBe(`boundary/${polytope}/${piece}/${P}`);
          expect(parseBoundaryId(id)).toEqual({ polytope, piece, P });
        }
  });

  it("rejects every other form with a plain sentence", () => {
    for (const bad of [
      "boundary/tesseract/ball/09",
      "boundary/tesseract/ball/0",
      "boundary/tesseract/ball/10000",
      "boundary/tesseract/ball/-1",
      "boundary/tesseract/ball/+1",
      "boundary/tesseract/ball/1.0",
      "boundary/tesseract/ball/1e1",
      "boundary/tesseract/ball/ 1",
      "boundary/tesseract/ball/",
      "boundary/Tesseract/ball/1",
      "boundary/tesseract/Ball/1",
      "boundary/tesseract/sphere/1",
      "boundary/5-cell/ball/1",
      "Boundary/tesseract/ball/1",
      "boundary/tesseract/ball/1/",
      "/boundary/tesseract/ball/1",
      "boundary//tesseract/ball/1",
      "surface/cube/fold/4/12",
      "",
    ]) {
      const r = parseBoundaryId(bad);
      expect(typeof r, bad).toBe("string");
      expect(r as string).toMatch(/\.$/);
    }
    expect(() => formatBoundaryId({ polytope: "tesseract", piece: "ball", P: 0 })).toThrow();
    expect(() => formatBoundaryId({ polytope: "tesseract", piece: "ball", P: 2.5 })).toThrow();
  });
});

describe("standard pieces", () => {
  it("ball and unit cube [-1/2, 1/2]^3 with outward counter-clockwise faces", () => {
    expect(standardPiece("ball", 4)).toEqual({ kind: "ball" });
    const c = standardPiece("cube", 4);
    if (c.kind !== "polytope") throw new Error("cube is a polytope piece");
    expect(c.vertices.length).toBe(8);
    for (const v of c.vertices) for (const x of v) expect(Math.abs(x)).toBe(0.5);
    expect(c.faces.length).toBe(6);
    for (const f of c.faces) {
      expect(f.length).toBe(4);
      const [a, b, d] = f.map((i) => c.vertices[i]);
      const e1 = b.map((x, k) => x - a[k]);
      const e2 = d.map((x, k) => x - a[k]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const centre = f.reduce((acc, i) => acc.map((x, k) => x + c.vertices[i][k] / 4), [0, 0, 0]);
      expect(n[0] * centre[0] + n[1] * centre[1] + n[2] * centre[2]).toBeGreaterThan(0);
    }
    expect(() => standardPiece("cube", 5)).toThrow();
  });

  it("toAmbient maps local coordinates to the boundary in R^4", () => {
    const T = getPolytope("tesseract");
    // cell 5 is x2 = +s/2 with local axes x0, x1, x3
    expect(toAmbient(T, 5, [0.1, -0.2, 0.3], 2)).toEqual([0.1, -0.2, 1, 0.3]);
    expect(toAmbient(T, 0, [0, 0, 0], 1)).toEqual([-0.5, 0, 0, 0]);
  });
});
