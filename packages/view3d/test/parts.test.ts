import { describe, expect, it } from "vitest";
import { cellPlanes, icosphere, partMesh, toPlane } from "../src/clip";
import { FIXTURES } from "../demo/fixtures";
import { getPolytope, pieceParts, standardPiece } from "./engine";

/** Volume of a closed triangle soup (divergence theorem). */
function volume(pos: Float32Array): number {
  let v = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.subarray(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

const poly = getPolytope("tesseract");

describe("drawn parts of the engine's pieces", () => {
  // the parts of a piece partition it: their clipped meshes add up to the whole piece
  for (const fx of FIXTURES) {
    it(`add up to whole pieces: ${fx.label}`, () => {
      const shape = standardPiece(fx.piece, poly.d);
      const parts = pieceParts(poly, fx.piece, fx.config);
      const total = new Array<number>(fx.config.pieces.length).fill(0);
      for (const p of parts) {
        const planes = [...cellPlanes(poly.cells[p.cell], fx.config.s), ...p.clip.map((h) => toPlane(h))];
        const m = partMesh(shape, p.place, planes);
        if (m) total[p.piece] += volume(m.positions);
      }
      // A ball is drawn as the icosphere of detail 4, its cut faces as exact 96-gons: where they meet
      // the surface leaves gaps of 0.2% of the volume. One part missing or counted twice would be
      // 5% or more (a cap of the ball beyond a cell face at s = sqrt 2). Cubes are exact.
      const whole = fx.piece === "ball" ? volume(Float32Array.from(icosphere(4))) : 1;
      const tol = fx.piece === "ball" ? 5e-3 : 2e-4;
      for (const t of total) expect(Math.abs(t - whole) / whole).toBeLessThan(tol);
    });
  }
});
