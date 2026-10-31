/**
 * Vertices of cone angle exactly pi (three triangles meet: the tetrahedron, J7 and J12): the chains
 * around the vertex to the left and to the right have the same development, and the fold energy
 * counts such twins once (chains.ts markTwins, energy.ts diskEnergy).
 */
import { checkKernel } from "@polypack/methods/contract";
import { describe, expect, it } from "vitest";
import { type SolidName, enumerateChains, faceVertex, getSolid, surfaceKernel } from "../src/index";
import { diskEnergy } from "../src/search/energy";

const SOLIDS: SolidName[] = ["tetrahedron", "elongated_triangular_pyramid", "triangular_bipyramid"];

describe("cone angle pi", () => {
  it("marks the twin chains of J12 and leaves the chains themselves unchanged", () => {
    const S = getSolid("triangular_bipyramid");
    const nodes = enumerateChains(S, 1, 4, 0, 0, 3);
    const twins = nodes.filter((n) => n.twin !== undefined);
    expect(twins.length).toBeGreaterThan(0);
    for (const n of twins) {
      const t = nodes[n.twin!];
      expect(t.twin).toBeUndefined();
      expect(t.face).toBe(n.face);
      expect(t.toAnchor.tx).toBeCloseTo(n.toAnchor.tx, 12);
      expect(t.toAnchor.ty).toBeCloseTo(n.toAnchor.ty, 12);
    }
    // the platonic solids with no cone angle of pi have no twins
    const cube = enumerateChains(getSolid("cube"), 1, 0, 0.1, 0.2, 1.5);
    expect(cube.some((n) => n.twin !== undefined)).toBe(false);
  });

  it("passes the kernel contract with no failure on 5 problems x 8 seeds (fold)", () => {
    const problems: [number, number][] = [
      [0, 3],
      [0, 2],
      [3, 2],
      [4, 5],
      [0, 5],
    ];
    const failures: string[] = [];
    for (const solid of SOLIDS)
      for (const [N, P] of problems)
        for (let seed = 1; seed <= 8; seed++) {
          const f = checkKernel(() => surfaceKernel({ solid, N, P, mode: "fold" }), { seed });
          if (f.length) failures.push(`${solid} ${N} ${P} seed ${seed}: ${f[0]}`);
        }
    expect(failures).toEqual([]);
  }, 120_000);

  it("has a disk energy that is continuous for a disk next to a vertex of three triangles", () => {
    for (const name of SOLIDS) {
      const S = getSolid(name);
      // a vertex of cone angle pi: the face angles at it add up to pi
      let f = -1;
      let k = -1;
      for (let a = 0; a < S.F && f < 0; a++)
        for (let b = 0; b < S.sides[a]; b++) {
          const id = S.faces[a][b];
          let sum = 0;
          for (let g = 0; g < S.F; g++) {
            const j = S.faces[g].indexOf(id);
            if (j >= 0) sum += S.corner[g][j];
          }
          if (Math.abs(sum - Math.PI) < 1e-9) {
            f = a;
            k = b;
            break;
          }
        }
      expect(f).toBeGreaterThanOrEqual(0);
      const [ax, ay] = faceVertex(S, 1, f, k);
      let cx = 0;
      let cy = 0;
      for (let b = 0; b < S.sides[f]; b++) {
        const [x, y] = faceVertex(S, 1, f, b);
        cx += x / S.sides[f];
        cy += y / S.sides[f];
      }
      const x0 = ax + 0.3 * (cx - ax);
      const y0 = ay + 0.3 * (cy - ay);
      // move across the line through the vertex; the disk's image in the opposite direction stays on it
      const nx = -(cy - ay);
      const ny = cx - ax;
      const L = Math.hypot(nx, ny);
      const lam = 0.4;
      const es: number[] = [];
      const n = 81;
      for (let i = 0; i < n; i++) {
        const h = (-4e-9 + (8e-9 * i) / (n - 1)) / L;
        es.push(diskEnergy(S, 1, lam, [{ face: f, x: x0 + h * nx, y: y0 + h * ny, theta: 0 }]));
      }
      expect(es[0]).toBeGreaterThan(0.01);
      for (let i = 1; i + 1 < n; i++) expect(Math.abs(es[i - 1] - 2 * es[i] + es[i + 1])).toBeLessThan(1e-12);
    }
  });
});
