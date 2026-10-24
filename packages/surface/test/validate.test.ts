import { describe, expect, it } from "vitest";
import {
  SOLID_NAMES,
  dedupe,
  enumerateChains,
  faceApothem,
  faceTo3D,
  frameVertex,
  getSolid,
  pieceParts,
  validateFold,
  validateNofold,
  areaBoundEdge,
} from "../src/index";
import { boundingRadius, pieceVertices } from "@polypack/geometry";
import { randomFacePoint, rng, walkRay } from "./helpers";

const one = (solid: any, N: number, s: number, x: number, y: number, theta = 0, face = 0) =>
  validateFold({ solid, N, s, pieces: [{ face, x, y, theta }] });

describe("fold validator", () => {
  for (const name of SOLID_NAMES) {
    const S = getSolid(name);
    const s0 = 2 * Math.sin(Math.PI / S.M); // face circumradius 1: a unit disk at the centre touches the face's vertices
    it(`${name}: a disk at a face centre needs s >= 2 sin(pi/M) (cone point exactly on the boundary is allowed)`, () => {
      expect(one(name, 0, s0 * (1 - 1e-6), 0, 0).ok).toBe(false);
      expect(one(name, 0, s0 * (1 + 1e-12), 0, 0).ok).toBe(true);
      expect(one(name, 0, s0 * (1 + 1e-6), 0, 0).ok).toBe(true);
    });

    it(`${name}: disks on two adjacent faces overlap across the edge exactly when the centres are closer than 2`, () => {
      // adjacent face centres are 2 * apothem apart through the shared edge
      const sTouch = 2 * Math.tan(Math.PI / S.M);
      const s = Math.max(sTouch, s0) * 1.0000001;
      const g = S.adj[0][0].face;
      const sep = 2 * faceApothem(S.M, s);
      const cfg = { solid: name, N: 0, s, pieces: [{ face: 0, x: 0, y: 0, theta: 0 }, { face: g, x: 0, y: 0, theta: 0 }] };
      const v = validateFold(cfg);
      expect(v.ok).toBe(sep >= 2 - 1e-9);
      // push the second disk towards the first by 0.01: shared edge k = 0 of face 0 has outward normal angle 2 pi/M - pi/2
      const a = (2 * Math.PI) / S.M - Math.PI / 2;
      const near = { ...cfg, s: sTouch * 1.0000001 };
      if (s0 <= sTouch) {
        expect(validateFold(near).ok).toBe(true);
        const moved = { ...near, pieces: [{ face: 0, x: 0.01 * Math.cos(a), y: 0.01 * Math.sin(a), theta: 0 }, near.pieces[1]] };
        const w = validateFold(moved);
        expect(w.ok).toBe(false);
        expect(w.errors.join(" ")).toMatch(/overlap/);
      }
    });

    it(`${name}: the polygon tiling of one piece per face is valid at s = 1 (triangles or the face polygon itself)`, () => {
      // the face polygon as a piece: a regular M-gon with vertex k at -pi/2 + pi/M + 2 pi k/M, i.e. theta = pi/M - pi
      const theta = Math.PI / S.M - Math.PI;
      const pieces = Array.from({ length: S.F }, (_, f) => ({ face: f, x: 0, y: 0, theta }));
      expect(validateFold({ solid: name, N: S.M, s: 1, pieces }).ok).toBe(true);
      expect(validateNofold({ solid: name, N: S.M, s: 1, pieces }).ok).toBe(true);
      const v = validateFold({ solid: name, N: S.M, s: 0.999, pieces });
      expect(v.ok).toBe(false);
      expect(v.errors.join(" ")).toMatch(/cone point/);
      expect(areaBoundEdge(name, S.M, S.F)).toBeCloseTo(1, 12);
    });
  }

  it("one-piece replicas: closed-form placements on faces whose covered regions do not overlap", () => {
    // squares on opposite cube faces at s = 1/sqrt 2, triangles on opposite octahedron faces at s = 1/2
    const sq = Math.SQRT1_2 * (1 + 1e-12);
    const thSq = -Math.PI + Math.PI / 4 - Math.PI / 4;
    const cube = getSolid("cube");
    const opposite = [...Array(6).keys()].find((f) => !cube.faces[f].some((v) => cube.faces[0].includes(v)))!;
    expect(validateFold({ solid: "cube", N: 4, s: sq, pieces: [{ face: 0, x: 0, y: 0, theta: thSq }, { face: opposite, x: 0, y: 0, theta: thSq }] }, { tol: 1e-12 }).ok).toBe(true);
    // adjacent faces overlap
    expect(validateFold({ solid: "cube", N: 4, s: sq, pieces: [{ face: 0, x: 0, y: 0, theta: thSq }, { face: cube.adj[0][0].face, x: 0, y: 0, theta: thSq }] }, { tol: 1e-12 }).ok).toBe(false);
    const oct = getSolid("octahedron");
    const thTri = -Math.PI + Math.PI / 3 - Math.PI / 3;
    const far = [...Array(8).keys()].find((f) => !oct.faces[f].some((v) => oct.faces[0].includes(v)))!;
    expect(validateFold({ solid: "octahedron", N: 3, s: 0.5 * (1 + 1e-12), pieces: [{ face: 0, x: 0, y: 0, theta: thTri }, { face: far, x: 0, y: 0, theta: thTri }] }, { tol: 1e-12 }).ok).toBe(true);
    expect(validateFold({ solid: "octahedron", N: 3, s: 0.5 * (1 - 1e-6), pieces: [{ face: 0, x: 0, y: 0, theta: thTri }] }).ok).toBe(false);
  });

  it("tetrahedron: a single disk is limited at s = sqrt(3) by both its vertices and the loop through a vertex", () => {
    const v = one("tetrahedron", 0, Math.sqrt(3) * (1 + 1e-6), 0, 0);
    expect(v.ok).toBe(true);
    expect(v.minConeSep).toBeCloseTo(1e-6, 8);
    expect(v.minPairSep).toBeCloseTo(2e-6, 8);
  });

  it("a square with a corner exactly at a cube vertex is valid; pushed over the vertex it is not", () => {
    const s = 2;
    // axis-aligned unit square (theta = pi/4) with its corner at the face corner (-1, -1)
    expect(one("cube", 4, s, -0.5, -0.5, Math.PI / 4).ok).toBe(true);
    const v = one("cube", 4, s, -0.5 - 1e-3, -0.5 - 1e-3, Math.PI / 4);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/cone point/);
  });

  it("a disk next to a cube vertex crosses all three edges at that vertex and stays valid", () => {
    const s = 3;
    // centre on the face diagonal at distance 1 + 1e-6 from the corner (1.5, 1.5)
    const d = (1 + 1e-6) / Math.SQRT2;
    const x = 1.5 - d;
    const S = getSolid("cube");
    const parts = pieceParts(S, s, 0, { face: 0, x, y: x, theta: 0 }, 0).filter((p) => p.poly.length >= 6);
    expect(new Set(parts.map((p) => p.face)).size).toBe(3);
    expect(one("cube", 0, s, x, x).ok).toBe(true);
    expect(one("cube", 0, s, x + 2e-6, x + 2e-6).ok).toBe(false);
  });

  it("a piece containing a cone point is rejected and, on a small solid, also wraps onto itself", () => {
    // a hexagon centred on a tetrahedron vertex region: s = 1.2, centre near frame vertex 1 of face 0
    const S = getSolid("tetrahedron");
    const s = 1.2;
    const [vx, vy] = frameVertex(S.M, s, 1);
    const v = one("tetrahedron", 6, s, 0.7 * vx, 0.7 * vy, 0.1);
    expect(v.ok).toBe(false);
    const text = v.errors.join(" ");
    expect(text).toMatch(/cone point/);
    expect(text).toMatch(/overlaps itself/);
  });

  it("rejects malformed input", () => {
    const base = { solid: "cube" as const, N: 4, s: 2, pieces: [{ face: 0, x: 0, y: 0, theta: 0 }] };
    expect(validateFold({ ...base, solid: "sphere" as any }).ok).toBe(false);
    expect(validateFold({ ...base, N: 2 }).ok).toBe(false);
    expect(validateFold({ ...base, s: NaN }).ok).toBe(false);
    expect(validateFold({ ...base, s: -1 }).ok).toBe(false);
    expect(validateFold({ ...base, pieces: [{ face: 6, x: 0, y: 0, theta: 0 }] }).ok).toBe(false);
    expect(validateFold({ ...base, pieces: [{ face: 0, x: Infinity, y: 0, theta: 0 }] }).ok).toBe(false);
    expect(validateFold({ ...base, pieces: [{ face: 0, x: 1.5, y: 0, theta: 0 }] }).errors.join(" ")).toMatch(/outside its face/);
    expect(validateFold({ ...base, pieces: [] }).ok).toBe(false);
  });

  it("overlap by 1e-8 across an edge is caught, touching is accepted", () => {
    // two unit squares on adjacent cube faces, each touching the shared edge from its own side
    const s = 3;
    const S = getSolid("cube");
    const g = S.adj[0][0];
    // edge 0 of face 0 is the right edge x = s/2; in face g the same edge is edge g.edge
    const ag = (2 * Math.PI * (g.edge + 1)) / 4 - Math.PI / 2;
    const ap = faceApothem(4, s);
    const pA = { face: 0, x: ap - 0.5, y: 0, theta: Math.PI / 4 };
    const pB = { face: g.face, x: (ap - 0.5) * Math.cos(ag), y: (ap - 0.5) * Math.sin(ag), theta: Math.PI / 4 };
    expect(validateFold({ solid: "cube", N: 4, s, pieces: [pA, pB] }, { tol: 1e-12 }).ok).toBe(true);
    const pA2 = { ...pA, x: pA.x + 1e-8 };
    const v = validateFold({ solid: "cube", N: 4, s, pieces: [pA2, pB] }, { tol: 1e-12 });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/overlap on face/);
  });

  it("without cone points inside, sampled points of a piece never develop onto each other (injectivity)", () => {
    // Monte Carlo check of the embedding condition with the independent ray walk
    const rand = rng(99);
    for (const name of ["tetrahedron", "cube", "octahedron"] as const) {
      const S = getSolid(name);
      let checked = 0;
      for (let t = 0; t < 400 && checked < 6; t++) {
        const N = [0, 4, 6][t % 3];
        const s = 1.4 + rand();
        const face = Math.floor(rand() * S.F);
        const [x, y] = randomFacePoint(S, s, rand);
        const pose = { face, x, y, theta: rand() * 6 };
        const v = validateFold({ solid: name, N, s, pieces: [pose] });
        if (v.minConeSep < 0.01) continue;
        checked++;
        expect(v.minPairSep).toBeGreaterThan(-1e-9);
        const R = boundingRadius(N);
        const pts: [number, number, number][] = [];
        const own: [number, number][] = [];
        const poly = N ? pieceVertices(N, pose) : null;
        for (let m = 0; m < 300; m++) {
          const r = Math.sqrt(rand()) * R * 0.98;
          const a = 2 * Math.PI * rand();
          const qx = x + r * Math.cos(a);
          const qy = y + r * Math.sin(a);
          if (poly) {
            let inside = true;
            for (let j = 0; j < N; j++) {
              const ex = poly[2 * ((j + 1) % N)] - poly[2 * j];
              const ey = poly[2 * ((j + 1) % N) + 1] - poly[2 * j + 1];
              if (ex * (qy - poly[2 * j + 1]) - ey * (qx - poly[2 * j]) < 0.02) inside = false;
            }
            if (!inside) continue;
          }
          const w = walkRay(S, s, face, x, y, Math.cos(a), Math.sin(a), r);
          if (!w) continue;
          pts.push(faceTo3D(S, s, w.face, w.x, w.y));
          own.push([qx, qy]);
        }
        for (let i = 0; i < pts.length; i++)
          for (let j = i + 1; j < pts.length; j++) {
            const planar = Math.hypot(own[i][0] - own[j][0], own[i][1] - own[j][1]);
            const spatial = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]);
            // two points far apart in the piece must not land on the same surface point
            if (planar > 0.2) expect(spatial).toBeGreaterThan(1e-6);
          }
      }
      expect(checked).toBeGreaterThan(2);
    }
  });

  it("clipping never leaves zero-length edges (regression: duplicate vertex hid an overlap)", () => {
    expect(Array.from(dedupe([0.5, -0.5, 0.49, -0.47, 0.45, -0.5, 0.5, -0.5]))).toEqual([0.5, -0.5, 0.49, -0.47, 0.45, -0.5]);
    expect(dedupe([0, 0, 0, 0, 1, 1]).length).toBe(0);
    const rand = rng(5);
    const S = getSolid("cube");
    for (let t = 0; t < 300; t++) {
      const s = 1 + rand();
      const [x, y] = randomFacePoint(S, s, rand);
      for (const part of pieceParts(S, s, 4, { face: 0, x, y, theta: rand() * 6 }, 0)) {
        const n = part.poly.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          expect(Math.hypot(part.poly[2 * j] - part.poly[2 * i], part.poly[2 * j + 1] - part.poly[2 * i + 1])).toBeGreaterThan(0);
        }
      }
    }
  });

  it("chain enumeration stays finite on every solid even for large reach", () => {
    for (const name of SOLID_NAMES) {
      const S = getSolid(name);
      const nodes = enumerateChains(S, 1, 0, 0.01, 0.02, 4);
      expect(nodes.length).toBeGreaterThan(10);
      expect(nodes.length).toBeLessThan(2000);
    }
  });
});

describe("nofold validator", () => {
  it("accepts pieces inside their faces and rejects a piece leaving its face by 1e-8", () => {
    const s = 2;
    const ok = validateNofold({ solid: "cube", N: 0, s, pieces: [{ face: 0, x: 0, y: 0, theta: 0 }] }, { tol: 1e-12 });
    expect(ok.ok).toBe(true);
    const bad = validateNofold({ solid: "cube", N: 0, s, pieces: [{ face: 0, x: 1e-8, y: 0, theta: 0 }] }, { tol: 1e-12 });
    expect(bad.ok).toBe(false);
  });

  it("pieces on different faces never interact; on one face they must be disjoint", () => {
    const s = 2;
    const p = [
      { face: 0, x: 0, y: 0, theta: 0 },
      { face: 1, x: 0, y: 0, theta: 0 },
    ];
    expect(validateNofold({ solid: "cube", N: 0, s, pieces: p }).ok).toBe(true);
    const q = [
      { face: 0, x: -1, y: 0, theta: 0 },
      { face: 0, x: 1, y: 0, theta: 0 },
    ];
    expect(validateNofold({ solid: "cube", N: 0, s: 4, pieces: q }).ok).toBe(true);
    const r = [
      { face: 0, x: -0.99, y: 0, theta: 0 },
      { face: 0, x: 0.99, y: 0, theta: 0 },
    ];
    expect(validateNofold({ solid: "cube", N: 0, s: 4, pieces: r }).ok).toBe(false);
  });
});
