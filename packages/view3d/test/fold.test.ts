import { describe, expect, it } from "vitest";
import { Folder, INNER_RATIO, foldAlignment } from "../src/fold";
import { applyAffine } from "../src/math";
import { defaultNet, getPolytope, toAmbient } from "./engine";

const poly = getPolytope("tesseract");
const net = defaultNet(poly);

describe("folding the net", () => {
  for (const s of [1, 1.5, 2.2205956562383804]) {
    it(`lands every cell on its cell of the tesseract at full fold (s = ${s})`, () => {
      const folder = new Folder(poly, net, s);
      folder.update(1);
      const Q = foldAlignment(poly, net, s);
      for (const cell of poly.cells) {
        // the cell's corners and an interior point
        for (const v of [...cell.vertices, [0.1, -0.2, 0.3]]) {
          const u = v.map((x) => x * s);
          const folded = applyAffine(Q, folder.point4(cell.index, u));
          const truth = toAmbient(poly, cell.index, u, s);
          for (let k = 0; k < 4; k++) expect(folded[k]).toBeCloseTo(truth[k], 10);
        }
      }
    });
  }

  it("lies flat in the net at fold 0 and is drawn at the net's own size", () => {
    const s = 1.7;
    const folder = new Folder(poly, net, s);
    folder.update(0);
    for (const p of net) {
      for (const v of poly.cells[p.cell].vertices) {
        const u = v.map((x) => x * s);
        const z = folder.point4(p.cell, u);
        const flat = applyAffine(p.place, u, s);
        expect(z[3]).toBeCloseTo(0, 12);
        for (let k = 0; k < 3; k++) expect(z[k]).toBeCloseTo(flat[k], 12);
        const seen = folder.project(p.cell, u);
        for (let k = 0; k < 3; k++) expect(seen[k]).toBeCloseTo(flat[k], 12);
      }
    }
  });

  it("keeps every cell an isometric copy while folding", () => {
    const s = 2;
    const folder = new Folder(poly, net, s);
    for (const f of [0.25, 0.5, 0.8]) {
      folder.update(f);
      for (const cell of poly.cells) {
        const a = folder.point4(cell.index, [0, 0, 0]);
        for (const e of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
          const b = folder.point4(cell.index, e);
          expect(Math.hypot(...b.map((x, k) => x - a[k]))).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it("sees the root as the outer cell and the opposite cell smaller at full fold", () => {
    const s = 1;
    const folder = new Folder(poly, net, s);
    folder.update(1);
    const size = (cell: number) => {
      const a = folder.project(cell, [-s / 2, 0, 0]);
      const b = folder.project(cell, [s / 2, 0, 0]);
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    };
    const root = folder.root;
    const opposite = root ^ 1;
    expect(size(root)).toBeCloseTo(s, 12);
    expect(size(opposite)).toBeCloseTo(s * INNER_RATIO, 6);
    // every projected point stays in front of the eye
    for (const cell of poly.cells) {
      for (const v of cell.vertices) expect(folder.point4(cell.index, v)[3]).toBeGreaterThan(-folder.E);
    }
  });
});
