/**
 * The torus drawing's layout (apps/web/src/space/render/torus-layout.ts) and the reader of torus
 * configurations: a skewed basis draws as fast as a reduced one, and a degenerate lattice is
 * neither read nor drawn.
 */
import { circumradius } from "@polypack/geometry";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { parseSearchProblem, readSpaceConfig, torusPackingOf } from "@polypack/spaces/search";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TORUS_PIECES, torusLayout } from "../src/space/render/torus-layout";

const index = loadSpacesIndex(resolve(__dirname, "../../.."));

describe("the torus drawing's layout", () => {
  const id = "torus/free/6/30";
  const p = parseSearchProblem(id)! as ReturnType<typeof parseSearchProblem> & { space: "torus" };
  const c = JSON.parse(index.torus!.byId.get(id)!.config!);
  const packing = torusPackingOf(p, c);
  const R = circumradius(6);

  it("draws a basis skewed by b2 + 320 b1 in under 0.5 s, like the reduced one", () => {
    const { b1, b2 } = packing.lattice;
    const skewed = { b1, b2: [b2[0] + 320 * b1[0], b2[1] + 320 * b1[1]] as [number, number] };
    for (const tile of [true, false]) {
      const plain = torusLayout(packing.lattice, packing.poses, R, tile)!;
      const t0 = performance.now();
      const layout = torusLayout(skewed, packing.poses, R, tile)!;
      expect(performance.now() - t0).toBeLessThan(500);
      expect(layout.capped).toBe(false);
      expect(layout.pieces.length).toBeGreaterThanOrEqual(30);
      // the same lattice, drawn in the same reduced cell
      expect(Math.abs(layout.pieces.length - plain.pieces.length)).toBeLessThanOrEqual(plain.pieces.length * 0.05);
      const [r1, r2] = layout.basis;
      expect(r1[0] * r2[1] - r1[1] * r2[0]).toBeGreaterThan(0);
      expect(Math.hypot(...r2)).toBeLessThan(2 * Math.hypot(...b2) + 1);
    }
  });

  it("caps the shapes it draws, and draws nothing for a degenerate lattice", () => {
    const tiny = { b1: [2.1, 0] as [number, number], b2: [0, 1000] as [number, number] };
    const many = Array.from({ length: 49 }, (_, i) => ({ x: 0, y: (i * 1000) / 49, theta: 0 }));
    const layout = torusLayout(tiny, many, 1, true)!;
    expect(layout.pieces.length).toBeLessThanOrEqual(MAX_TORUS_PIECES);
    expect(torusLayout({ b1: [3, 0], b2: [6, 0] }, packing.poses, R, true)).toBeNull();
    expect(torusLayout({ b1: [3, 0], b2: [NaN, 1] }, packing.poses, R, true)).toBeNull();
    expect(torusLayout({ b1: [1e300, 0], b2: [0, 1e300] }, packing.poses, R, true)).toBeNull();
  });

  it("reads only a free basis with a finite determinant other than 0", () => {
    const q = parseSearchProblem("torus/free/0/1")!;
    const read = (b1: number[], b2: number[]) => readSpaceConfig(q, { lattice: { b1, b2 }, poses: [[0, 0, 0]] });
    expect(read([3, 0], [0, 3])).not.toBeNull();
    // left-handed: the same lattice as [3, 0], [0, 3], and what the torus search often returns
    expect(read([3, 0], [0, -3])).not.toBeNull();
    expect(read([3, 0], [6, 0])).toBeNull();
    expect(read([1e300, 0], [0, 1e300])).toBeNull();
    // every free record of the catalogue is read
    for (const r of index.torus!.problems.filter((x) => x.fields.family === "free" && x.config))
      expect(readSpaceConfig(parseSearchProblem(r.id)!, JSON.parse(r.config!)), r.id).not.toBeNull();
  });
});
