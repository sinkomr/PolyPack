import { describe, expect, it } from "vitest";
import {
  SOLID_NAMES,
  apply,
  enumerateChains,
  faceTo3D,
  getSolid,
  inWedge,
  inverse,
  pieceParts,
  polygonArea,
  surfaceDistance,
} from "../src/index";
import { pieceArea, pieceVertices } from "@polypack/geometry";
import { randomFacePoint, rng, walkRay } from "./helpers";

describe("chains and development", () => {
  it("a small reach from the centre stays on the face", () => {
    const S = getSolid("cube");
    expect(enumerateChains(S, 2, 0, 0, 0, 0.9).length).toBe(1);
    expect(enumerateChains(S, 2, 0, 0, 0, 1.01).length).toBe(5);
  });

  it("exact surface distances: cube and tetrahedron", () => {
    const cube = getSolid("cube");
    const d = (f: number) => surfaceDistance(cube, 1, { face: 0, x: 0, y: 0 }, { face: f, x: 0, y: 0 }, 3);
    const ds = [0, 1, 2, 3, 4, 5].map(d).sort((a, b) => a - b);
    expect(ds[0]).toBe(0);
    for (const v of ds.slice(1, 5)) expect(v).toBeCloseTo(1, 12);
    expect(ds[5]).toBeCloseTo(2, 12);
    // tetrahedron: adjacent face centres are 2 * inradius = s / sqrt(3) apart
    const tet = getSolid("tetrahedron");
    expect(surfaceDistance(tet, 1, { face: 0, x: 0, y: 0 }, { face: 1, x: 0, y: 0 }, 2)).toBeCloseTo(1 / Math.sqrt(3), 12);
  });

  for (const name of SOLID_NAMES) {
    it(`${name}: surface distance is symmetric, at least the 3D chord, and satisfies the triangle inequality`, () => {
      const S = getSolid(name);
      const s = 1;
      const rand = rng(7 + name.length);
      const pts = Array.from({ length: 9 }, () => {
        const face = Math.floor(rand() * S.F);
        const [x, y] = randomFacePoint(S, s, rand, 1e-3);
        return { face, x, y };
      });
      const reach = 4;
      const D = pts.map((p) => pts.map((q) => surfaceDistance(S, s, p, q, reach)));
      for (let i = 0; i < pts.length; i++)
        for (let j = 0; j < pts.length; j++) {
          expect(Math.abs(D[i][j] - D[j][i])).toBeLessThan(1e-9);
          const a = faceTo3D(S, s, pts[i].face, pts[i].x, pts[i].y);
          const b = faceTo3D(S, s, pts[j].face, pts[j].x, pts[j].y);
          expect(D[i][j]).toBeGreaterThanOrEqual(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - 1e-9);
          for (let k = 0; k < pts.length; k++) expect(D[i][j]).toBeLessThanOrEqual(D[i][k] + D[k][j] + 1e-9);
        }
    });

    it(`${name}: parts agree with an independent ray walk and partition the piece`, () => {
      const S = getSolid(name);
      const rand = rng(1234 + name.length);
      let tested = 0;
      for (let trial = 0; trial < 40 && tested < 12; trial++) {
        const N = [0, 3, 4, 5, 6, 8][trial % 6];
        const s = 1.3 + 2 * rand();
        const face = Math.floor(rand() * S.F);
        const [x, y] = randomFacePoint(S, s, rand);
        const pose = { face, x, y, theta: 2 * Math.PI * rand() };
        const parts = pieceParts(S, s, N, pose, 0);
        // pieces that contain a cone point are not developable; skip them
        const nodes = enumerateChains(S, s, face, x, y, N === 0 ? 1 : 1 / (2 * Math.sin(Math.PI / N)));
        let coneInside = false;
        for (const node of nodes)
          for (let k = 0; k < S.M; k++) {
            const R = S.M;
            const a = -Math.PI / 2 + Math.PI / R + (2 * Math.PI * k) / R;
            const Rf = s / (2 * Math.sin(Math.PI / R));
            const [vx, vy] = apply(node.toAnchor, Rf * Math.cos(a), Rf * Math.sin(a));
            if (!inWedge(node.wedge, x, y, vx, vy, 1e-12)) continue;
            const poly = N === 0 ? null : pieceVertices(N, pose);
            let inside: boolean;
            if (!poly) inside = Math.hypot(vx - x, vy - y) < 1;
            else {
              inside = true;
              for (let j = 0; j < N; j++) {
                const ex = poly[2 * ((j + 1) % N)] - poly[2 * j];
                const ey = poly[2 * ((j + 1) % N) + 1] - poly[2 * j + 1];
                if (ex * (vy - poly[2 * j + 1]) - ey * (vx - poly[2 * j]) <= 1e-9) inside = false;
              }
            }
            if (inside) coneInside = true;
          }
        if (coneInside) continue;
        tested++;
        // area: the parts partition the (drawn) piece
        const total = parts.reduce((u, p) => u + (p.poly.length >= 6 ? polygonArea(p.poly) : 0), 0);
        const area = N === 0 ? (96 / 2) * Math.sin((2 * Math.PI) / 96) / Math.cos(Math.PI / 96) ** 2 : pieceArea(N);
        expect(Math.abs(total - area)).toBeLessThan(1e-9);
        // sample points of the piece: walking the ray lands where the part's map says
        for (let m = 0; m < 30; m++) {
          const r = Math.sqrt(rand()) * (N === 0 ? 0.999 : 0.999 / (2 * Math.sin(Math.PI / N)));
          const t = 2 * Math.PI * rand();
          const qx = x + r * Math.cos(t);
          const qy = y + r * Math.sin(t);
          if (N > 0) {
            const poly = pieceVertices(N, pose);
            let inside = true;
            for (let j = 0; j < N; j++) {
              const ex = poly[2 * ((j + 1) % N)] - poly[2 * j];
              const ey = poly[2 * ((j + 1) % N) + 1] - poly[2 * j + 1];
              if (ex * (qy - poly[2 * j + 1]) - ey * (qx - poly[2 * j]) < 0) inside = false;
            }
            if (!inside) continue;
          }
          const walked = walkRay(S, s, face, x, y, Math.cos(t), Math.sin(t), r);
          if (!walked) continue;
          // find the part whose chain (wedge + unfolded face) contains q in the anchor frame
          let found = false;
          for (const part of parts) {
            const node = nodes[part.chain];
            if (!node) continue;
            const back = inverse(part.chain === 0 ? { ang: 0, c: 1, s: 0, tx: 0, ty: 0 } : nodes[part.chain].toAnchor);
            const [u, v] = apply(back, qx, qy);
            if (node.face !== walked.face) continue;
            if (!inWedge(node.wedge, x, y, qx, qy, 1e-12)) continue;
            if (Math.hypot(u - walked.x, v - walked.y) < 1e-8) found = true;
          }
          expect(found).toBe(true);
        }
      }
      expect(tested).toBeGreaterThan(3);
    });
  }
});
