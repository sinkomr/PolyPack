import { describe, expect, it } from "vitest";
import {
  SLICE_CUT,
  SLICE_MISS,
  SLICE_WHOLE,
  SliceScratch,
  ballSection,
  ballSectionRadius,
  packPlanes,
  polygonArea,
  polytopeSection,
  slicePlane,
  stripPositions,
} from "../src/slice";
import { getPolytope } from "./engine";

const poly = getPolytope("tesseract");

describe("slice sections", () => {
  it("cuts a unit ball centred at distance a from the plane in a disk of radius sqrt(1 - a^2)", () => {
    const plane = new Float64Array([0, 0, 1, 0.3]);
    for (const a of [0, 0.2, 0.5, 0.9, 0.999]) {
      for (const sign of [-1, 1]) {
        const q = [0.4, -0.1, 0.3 + sign * a];
        expect(ballSectionRadius(q, plane)).toBeCloseTo(Math.sqrt(1 - a * a), 12);
      }
    }
    expect(ballSectionRadius([0, 0, 1.3], plane)).toBe(-1);
    expect(ballSectionRadius([0, 0, -0.71], plane)).toBe(-1);
  });

  it("draws that disk as a polygon of the right area, cut by the part's half-spaces", () => {
    const sc = new SliceScratch();
    const plane = new Float64Array([1, 0, 0, 0]);
    const free = new Float64Array(0);
    for (const a of [0, 0.3, 0.6]) {
      const n = ballSection(sc, [a, 0, 0], plane, free, 256);
      expect(n).toBe(256);
      expect(polygonArea(sc.out, n)).toBeCloseTo(Math.PI * (1 - a * a), 3);
      for (let i = 0; i < n; i++) expect(sc.out[3 * i]).toBeCloseTo(0, 12);
    }
    // half of it: the half-space y <= 0 through the centre
    const half = packPlanes([{ n: [0, 1, 0], h: 0 }]);
    const n = ballSection(sc, [0.6, 0, 0], plane, half, 256);
    expect(polygonArea(sc.out, n)).toBeCloseTo((Math.PI * 0.64) / 2, 3);
  });

  it("cuts a unit cube in its square through the centre and in a hexagon across the diagonal", () => {
    const sc = new SliceScratch();
    const verts: number[] = [];
    for (let m = 0; m < 8; m++) verts.push(...[0, 1, 2].map((k) => ((m >> k) & 1 ? 0.5 : -0.5)));
    const edges: number[] = [];
    for (let a = 0; a < 8; a++) for (let k = 0; k < 3; k++) if (!((a >> k) & 1)) edges.push(a, a | (1 << k));
    const none = new Float64Array(0);
    let n = polytopeSection(sc, verts, edges, new Float64Array([0, 0, 1, 0.1]), none);
    expect(n).toBe(4);
    expect(polygonArea(sc.out, n)).toBeCloseTo(1, 12);
    const r = 1 / Math.sqrt(3);
    n = polytopeSection(sc, verts, edges, new Float64Array([r, r, r, 0]), none);
    expect(n).toBe(6);
    // regular hexagon with side sqrt(2)/2
    expect(polygonArea(sc.out, n)).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * 0.5, 12);
  });

  it("finds the hyperplane x_k = t in every cell of the tesseract", () => {
    const s = 2;
    const out = new Float64Array(4);
    for (const cell of poly.cells) {
      const i = cell.index >> 1;
      for (const k of [0, 1, 2, 3]) {
        const t = 0.4;
        const r = slicePlane(cell, k, t, s, out);
        if (i === k) {
          expect(r).toBe(SLICE_MISS);
          const sign = cell.index & 1 ? 1 : -1;
          expect(slicePlane(cell, k, (sign * s) / 2, s, out)).toBe(SLICE_WHOLE);
        } else {
          expect(r).toBe(SLICE_CUT);
          // the local axis of x_k, at height t
          const local = [0, 1, 2, 3].filter((j) => j !== i).indexOf(k);
          expect(Math.abs(out[local])).toBeCloseTo(1, 12);
          expect(out[3] * out[local]).toBeCloseTo(t, 12);
        }
      }
    }
  });

  it("spaces the strip's slices evenly, ends included", () => {
    expect(stripPositions(-1, 1, 9)).toEqual([-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]);
  });
});
