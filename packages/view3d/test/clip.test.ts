import { describe, expect, it } from "vitest";
import { cellFaces, cellPlanes, partMesh, type PieceShape } from "../src/clip";
import { invert4 } from "../src/math";
import { getPolytope } from "./engine";

const poly = getPolytope("tesseract");
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Volume of a closed triangle soup (divergence theorem), and its total area. */
function measure(pos: Float32Array): { volume: number; area: number } {
  let v = 0;
  let a = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.slice(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
    a += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }
  return { volume: v, area: a };
}

describe("clipped parts", () => {
  const ball: PieceShape = { kind: "ball" };
  const cube: PieceShape = {
    kind: "polytope",
    vertices: Array.from({ length: 8 }, (_, m) => [0, 1, 2].map((k) => ((m >> k) & 1 ? 0.5 : -0.5))),
    faces: [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]],
  };

  it("keeps a ball inside its cell whole, and closes a cut ball with its cut face", () => {
    const s = 3;
    const planes = cellPlanes(poly.cells[0], s);
    const whole = partMesh(ball, { A: I3, b: [0, 0, 0] }, planes)!;
    expect(whole.surfaceCount).toBe(whole.positions.length / 3);
    expect(measure(whole.positions).volume).toBeCloseTo((4 / 3) * Math.PI, 1);
    // centre on the face x = s/2: half a ball, closed by a disk
    const half = partMesh(ball, { A: I3, b: [s / 2, 0, 0] }, planes)!;
    expect(half.surfaceCount).toBeLessThan(half.positions.length / 3);
    const m = measure(half.positions);
    expect(m.volume).toBeCloseTo((2 / 3) * Math.PI, 1);
    const cut = measure(half.positions.slice(half.surfaceCount * 3));
    expect(cut.area).toBeCloseTo(Math.PI, 2);
    // beyond the cell: nothing
    expect(partMesh(ball, { A: I3, b: [s / 2 + 1, 0, 0] }, planes)).toBeNull();
  });

  it("clips a cube exactly and outlines its edges", () => {
    const s = 1.25;
    const planes = cellPlanes(poly.cells[3], s);
    // a cube sticking 0.2 out of the +x face: 0.8 of it is here
    const p = partMesh(cube, { A: I3, b: [s / 2 - 0.3, 0, 0] }, planes)!;
    expect(measure(p.positions).volume).toBeCloseTo(0.8, 6);
    expect(p.lines.length / 6).toBe(12);
    // flush with a face: no cut face
    const flush = partMesh(cube, { A: I3, b: [s / 2 - 0.5, 0, 0] }, planes)!;
    expect(flush.surfaceCount).toBe(flush.positions.length / 3);
    expect(measure(flush.positions).volume).toBeCloseTo(1, 6);
  });

  it("orients every triangle outwards, also under a reflection", () => {
    const s = 2;
    const planes = cellPlanes(poly.cells[5], s);
    const mirror = { A: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], b: [0.9, 0.2, 0] };
    for (const shape of [ball, cube]) {
      const p = partMesh(shape, mirror, planes)!;
      expect(measure(p.positions).volume).toBeGreaterThan(0);
    }
  });

  it("gives the cell its six square faces", () => {
    const faces = cellFaces(poly.cells[2], 2);
    expect(faces).toHaveLength(6);
    for (const f of faces) expect(f.pts).toHaveLength(4);
  });

  it("inverts 4x4 matrices", () => {
    const m = [2, 0, 1, 0, 0, 1, 0, 3, 1, 0, 1, 0, 0, 2, 0, 1];
    const inv = new Float64Array(16);
    expect(invert4(m, inv)).toBe(true);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let t = 0;
        for (let k = 0; k < 4; k++) t += m[i * 4 + k] * inv[k * 4 + j];
        expect(t).toBeCloseTo(i === j ? 1 : 0, 12);
      }
    }
  });
});
