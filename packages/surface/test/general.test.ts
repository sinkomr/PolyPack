/**
 * The solids beyond the Platonic ones: Catalan solids (irregular faces, vertices of two or three
 * kinds), prisms (squares and n-gons) and antiprisms (triangles and n-gons). Structure, frames, the
 * development across edges and the float validator on adversarial configurations.
 */
import { readFileSync } from "node:fs";
import { pieceArea, pieceVertices } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import {
  ALL_SOLID_NAMES,
  ANTIPRISM_NAMES,
  ARCHIMEDEAN_NAMES,
  CATALAN_NAMES,
  PRISM_NAMES,
  type SolidName,
  apply,
  compose,
  enumerateChains,
  faceArea,
  faceDepth,
  faceTo3D,
  faceVertex,
  faceVertices,
  frameVertex,
  getSolid,
  glue,
  inWedge,
  inverse,
  isSolidName,
  pieceParts,
  polygonArea,
  surfaceArea,
  surfaceDistance,
  validate,
} from "../src/index";
import { randomPointOf, rng, walkRayOf } from "./helpers";

const NEW: SolidName[] = [...ARCHIMEDEAN_NAMES, ...CATALAN_NAMES, ...PRISM_NAMES, ...ANTIPRISM_NAMES];
/** A kite, a rhombic, an irregular-pentagon (chiral) and a sharp-vertex Catalan solid, prisms and antiprisms. */
const SAMPLE: SolidName[] = [
  "deltoidal_icositetrahedron",
  "rhombic_dodecahedron",
  "pentagonal_icositetrahedron",
  "triakis_tetrahedron",
  "prism3",
  "prism7",
  "antiprism4",
  "antiprism9",
];

/** Mean edge length of the canonical solid (scale 1). */
function meanEdge(name: SolidName): number {
  const S = getSolid(name);
  let total = 0;
  for (let f = 0; f < S.F; f++)
    for (let k = 0; k < S.sides[f]; k++) {
      const [ax, ay] = faceVertex(S, 1, f, k);
      const [bx, by] = faceVertex(S, 1, f, k + 1);
      total += Math.hypot(bx - ax, by - ay);
    }
  return total / (2 * S.E);
}

describe("general solids: structure", () => {
  it("lists 49 solids, grouped by family", () => {
    expect(ALL_SOLID_NAMES.length).toBe(49);
    expect(new Set(ALL_SOLID_NAMES).size).toBe(49);
    expect(CATALAN_NAMES.length).toBe(13);
    expect(ARCHIMEDEAN_NAMES.length).toBe(13);
    expect(PRISM_NAMES).toEqual(["prism3", "prism5", "prism6", "prism7", "prism8", "prism9", "prism10", "prism11", "prism12"]);
    expect(ANTIPRISM_NAMES.length).toBe(9);
    for (const n of ALL_SOLID_NAMES) expect(isSolidName(n)).toBe(true);
    expect(isSolidName("prism4")).toBe(false);
    expect(isSolidName("antiprism3")).toBe(false);
    expect(isSolidName("elongated_cube")).toBe(false);
  });

  for (const name of NEW) {
    it(`${name}: closed surface, gluing involution, 3D agreement, cone angles`, () => {
      const S = getSolid(name);
      expect(S.V - S.E + S.F).toBe(2);
      expect(S.uniform).toBe(false);
      const s = 1.37;
      for (let f = 0; f < S.F; f++) {
        expect(S.faces[f][0]).toBe(Math.min(...S.faces[f]));
        // the frame origin (foot of the solid's centre) lies inside the face
        expect(faceDepth(S, 1, f, 0, 0)).toBeGreaterThan(0);
        // counter-clockwise frame, positive area
        expect(faceArea(S, f)).toBeGreaterThan(0);
        // the bottom edge, frame vertex M - 1 to 0, runs along +x
        const M = S.sides[f];
        const [ax, ay] = faceVertex(S, 1, f, M - 1);
        const [bx, by] = faceVertex(S, 1, f, 0);
        expect(Math.abs(ay - by)).toBeLessThan(1e-12);
        expect(bx).toBeGreaterThan(ax);
        for (let k = 0; k < M; k++) {
          const g = glue(S, s, f, k);
          expect(S.adj[g.face][g.edge]).toEqual({ face: f, edge: k });
          const a = apply(g.T, ...faceVertex(S, s, g.face, g.edge));
          const b = faceVertex(S, s, f, k + 1);
          expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-12);
          const c = apply(g.T, ...faceVertex(S, s, g.face, g.edge + 1));
          const d = faceVertex(S, s, f, k);
          expect(Math.hypot(c[0] - d[0], c[1] - d[1])).toBeLessThan(1e-12);
          const back = glue(S, s, g.face, g.edge);
          const id = compose(g.T, back.T);
          expect(Math.abs(id.c - 1) + Math.abs(id.s) + Math.abs(id.tx) + Math.abs(id.ty)).toBeLessThan(1e-12);
          for (const t of [0.25, 0.6]) {
            const x = a[0] + t * (c[0] - a[0]);
            const y = a[1] + t * (c[1] - a[1]);
            const [u, v] = apply(inverse(g.T), x, y);
            const p3 = faceTo3D(S, s, f, x, y);
            const q3 = faceTo3D(S, s, g.face, u, v);
            expect(Math.hypot(p3[0] - q3[0], p3[1] - q3[1], p3[2] - q3[2])).toBeLessThan(1e-12);
          }
        }
        // frame vertices are the 3D vertices
        for (let k = 0; k < M; k++) {
          const [x, y] = faceVertex(S, s, f, k);
          const p = faceTo3D(S, s, f, x, y);
          const q = S.vertices[S.faces[f][k]].map((v) => v * s);
          expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(1e-12);
        }
      }
      // Gauss-Bonnet: the angle defects sum to 4 pi; every cone angle lies in [pi, 2 pi), which the
      // rule that a cone point may lie on a piece's boundary needs (docs/spaces/SURFACE.md, section 1)
      const defect = S.vertexCone.reduce((u, c) => u + 2 * Math.PI - c, 0);
      expect(defect / Math.PI).toBeCloseTo(4, 12);
      for (const c of S.vertexCone) {
        expect(c).toBeGreaterThanOrEqual(Math.PI);
        expect(c).toBeLessThan(2 * Math.PI);
      }
      // the surface area agrees with the 3D faces
      let area3 = 0;
      for (const f of S.faces) {
        const P = f.map((v) => S.vertices[v]);
        const n = [0, 0, 0];
        for (let k = 0; k < P.length; k++) {
          const a = P[k];
          const b = P[(k + 1) % P.length];
          n[0] += a[1] * b[2] - a[2] * b[1];
          n[1] += a[2] * b[0] - a[0] * b[2];
          n[2] += a[0] * b[1] - a[1] * b[0];
        }
        area3 += Math.hypot(n[0], n[1], n[2]) / 2;
      }
      expect(surfaceArea(S, 2) / 4).toBeCloseTo(area3, 12);
    });

    it(`${name}: going once around each vertex rotates by its cone angle`, () => {
      const S = getSolid(name);
      for (let v = 0; v < S.V; v++) {
        const f0 = S.faces.findIndex((f) => f.includes(v));
        const k0 = S.faces[f0].indexOf(v);
        // edge k0 - 1 ends at the vertex; cross it and keep turning the same way around the vertex
        let f = f0;
        let k = (k0 + S.sides[f0] - 1) % S.sides[f0];
        let T = { ang: 0, c: 1, s: 0, tx: 0, ty: 0 };
        let total = S.corner[f0][k0];
        for (let step = 0; step < S.vertexDegree[v]; step++) {
          const g = glue(S, 1, f, k);
          T = compose(T, g.T);
          f = g.face;
          k = (g.edge + S.sides[f] - 1) % S.sides[f];
          if (step < S.vertexDegree[v] - 1) total += S.corner[f][S.faces[f].indexOf(v)];
        }
        expect(f).toBe(f0);
        expect(total).toBeCloseTo(S.vertexCone[v], 12);
        const p = faceVertex(S, 1, f0, k0);
        const img = apply(T, p[0], p[1]);
        expect(Math.hypot(img[0] - p[0], img[1] - p[1])).toBeLessThan(1e-12);
        const turn = ((T.ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const cone = S.vertexCone[v] % (2 * Math.PI);
        expect(Math.min(Math.abs(turn - cone), Math.abs(turn - (2 * Math.PI - cone)))).toBeLessThan(1e-12);
      }
    });
  }

  it("has the Archimedean vertex configurations, with regular unit-edge faces", () => {
    const configurations = [
      [3, 6, 6], [3, 4, 3, 4], [3, 8, 8], [4, 6, 6], [3, 4, 4, 4], [4, 6, 8], [3, 3, 3, 3, 4],
      [3, 5, 3, 5], [3, 10, 10], [5, 6, 6], [3, 4, 5, 4], [4, 6, 10], [3, 3, 3, 3, 5],
    ];
    ARCHIMEDEAN_NAMES.forEach((name, i) => {
      const S = getSolid(name);
      expect(S.family).toBe("archimedean");
      expect(S.regular.every(Boolean)).toBe(true);
      expect(meanEdge(name)).toBeCloseTo(1, 14);
      for (let v = 0; v < S.V; v++) {
        const incident = S.faces.filter((f) => f.includes(v)).map((f) => f.length).sort((a, b) => a - b);
        expect(incident, `${name} vertex ${v}`).toEqual([...configurations[i]].sort((a, b) => a - b));
        const cone = configurations[i].reduce((sum, m) => sum + (m - 2) / m, 0);
        expect(S.vertexCone[v] / Math.PI).toBeCloseTo(cone, 14);
      }
    });
  });

  it("prisms and antiprisms have regular faces in the regular frame; Catalan faces are tangential at the origin", () => {
    for (const name of [...PRISM_NAMES, ...ANTIPRISM_NAMES]) {
      const S = getSolid(name);
      const n = Number(name.replace(/\D/g, ""));
      const counts = new Map<number, number>();
      for (const m of S.sides) counts.set(m, (counts.get(m) ?? 0) + 1);
      if (name.startsWith("prism")) expect([...counts.entries()].sort((a, b) => a[0] - b[0])).toEqual(n < 4 ? [[3, 2], [4, 3]] : [[4, n], [n, 2]]);
      else expect([...counts.entries()].sort((a, b) => a[0] - b[0])).toEqual([[3, 2 * n], [n, 2]]);
      S.faces.forEach((f, fi) => {
        expect(S.regular[fi]).toBe(true);
        for (let k = 0; k < f.length; k++) expect(faceVertex(S, 2, fi, k)).toEqual(frameVertex(f.length, 2, k));
      });
    }
    for (const name of CATALAN_NAMES) {
      const S = getSolid(name);
      const r0 = faceDepth(S, 1, 0, 0, 0);
      S.faces.forEach((f, fi) => {
        expect(S.regular[fi]).toBe(false);
        // every edge line is at the same distance from the origin: the incircle (the midsphere's trace)
        for (let k = 0; k < f.length; k++) {
          const [ax, ay] = faceVertex(S, 1, fi, k);
          const [bx, by] = faceVertex(S, 1, fi, k + 1);
          const d = Math.abs(ax * by - ay * bx) / Math.hypot(bx - ax, by - ay);
          expect(d).toBeCloseTo(r0, 12);
        }
        // the faces are congruent: the same multiset of corner angles
        expect([...S.corner[fi]].sort().map((a) => a.toFixed(10))).toEqual([...S.corner[0]].sort().map((a) => a.toFixed(10)));
      });
    }
  });
});

describe("general solids: development", () => {
  for (const name of SAMPLE) {
    it(`${name}: surface distance is symmetric, at least the 3D chord, and satisfies the triangle inequality`, () => {
      const S = getSolid(name);
      const s = 1 / meanEdge(name);
      const rand = rng(11 + name.length);
      const pts = Array.from({ length: 8 }, () => {
        const face = Math.floor(rand() * S.F);
        const [x, y] = randomPointOf(S, s, face, rand, 1e-3);
        return { face, x, y };
      });
      const reach = 3;
      const D = pts.map((p) => pts.map((q) => surfaceDistance(S, s, p, q, reach)));
      for (let i = 0; i < pts.length; i++)
        for (let j = 0; j < pts.length; j++) {
          if (!Number.isFinite(D[i][j])) continue;
          expect(Math.abs(D[i][j] - D[j][i])).toBeLessThan(1e-9);
          const a = faceTo3D(S, s, pts[i].face, pts[i].x, pts[i].y);
          const b = faceTo3D(S, s, pts[j].face, pts[j].x, pts[j].y);
          expect(D[i][j]).toBeGreaterThanOrEqual(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - 1e-9);
          for (let k = 0; k < pts.length; k++)
            if (Number.isFinite(D[i][k]) && Number.isFinite(D[k][j]) && D[i][k] + D[k][j] <= reach)
              expect(D[i][j]).toBeLessThanOrEqual(D[i][k] + D[k][j] + 1e-9);
        }
    });

    it(`${name}: parts agree with an independent ray walk and partition the piece`, () => {
      const S = getSolid(name);
      const rand = rng(4321 + name.length);
      let tested = 0;
      for (let trial = 0; trial < 60 && tested < 10; trial++) {
        const N = [0, 3, 4, 5, 6, 8][trial % 6];
        const s = (0.9 + 1.5 * rand()) / meanEdge(name);
        const face = Math.floor(rand() * S.F);
        const [x, y] = randomPointOf(S, s, face, rand);
        const pose = { face, x, y, theta: 2 * Math.PI * rand() };
        const R = N === 0 ? 1 : 1 / (2 * Math.sin(Math.PI / N));
        const nodes = enumerateChains(S, s, face, x, y, R);
        const parts = pieceParts(S, s, N, pose, 0, 1, nodes);
        const poly = N === 0 ? null : pieceVertices(N, pose);
        const insidePiece = (qx: number, qy: number, strict: number) => {
          if (!poly) return Math.hypot(qx - x, qy - y) < 1 - strict;
          for (let j = 0; j < N; j++) {
            const ex = poly[2 * ((j + 1) % N)] - poly[2 * j];
            const ey = poly[2 * ((j + 1) % N) + 1] - poly[2 * j + 1];
            if (ex * (qy - poly[2 * j + 1]) - ey * (qx - poly[2 * j]) <= strict) return false;
          }
          return true;
        };
        // pieces with a cone point inside are not developable; skip them
        let coneInside = false;
        for (const node of nodes)
          for (const [fx, fy] of faceVertices(S, s, node.face)) {
            const [vx, vy] = apply(node.toAnchor, fx, fy);
            if (inWedge(node.wedge, x, y, vx, vy, 1e-12) && insidePiece(vx, vy, -1e-9)) coneInside = true;
          }
        if (coneInside) continue;
        tested++;
        const total = parts.reduce((u, p) => u + (p.poly.length >= 6 ? polygonArea(p.poly) : 0), 0);
        const area = N === 0 ? ((96 / 2) * Math.sin((2 * Math.PI) / 96)) / Math.cos(Math.PI / 96) ** 2 : pieceArea(N);
        expect(Math.abs(total - area)).toBeLessThan(1e-9);
        for (let m = 0; m < 30; m++) {
          const r = Math.sqrt(rand()) * 0.999 * R;
          const t = 2 * Math.PI * rand();
          const qx = x + r * Math.cos(t);
          const qy = y + r * Math.sin(t);
          if (!insidePiece(qx, qy, 0)) continue;
          const walked = walkRayOf(S, s, face, x, y, Math.cos(t), Math.sin(t), r);
          if (!walked) continue;
          let found = false;
          for (const part of parts) {
            const node = nodes[part.chain];
            if (node.face !== walked.face || !inWedge(node.wedge, x, y, qx, qy, 1e-12)) continue;
            const [u, v] = apply(inverse(node.toAnchor), qx, qy);
            if (Math.hypot(u - walked.x, v - walked.y) < 1e-8) found = true;
          }
          expect(found).toBe(true);
        }
      }
      expect(tested).toBeGreaterThan(3);
    });
  }
});

describe("test packings and the range of N", () => {
  const fixtures = JSON.parse(
    readFileSync(new URL("../../../python/surface/fixtures/general_packings.json", import.meta.url), "utf8"),
  ).records as { id: string; solid: SolidName; mode: "fold" | "nofold"; N: number; P: number; s: number; pieces: { face: number; x: number; y: number; theta: number }[] }[];

  it("every test packing is valid in its mode, tight, and the folding ones need folding", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(60);
    for (const r of fixtures) {
      const cfg = { solid: r.solid, N: r.N, s: r.s, pieces: r.pieces };
      expect(validate(cfg, r.mode).ok, r.id).toBe(true);
      expect(validate({ ...cfg, s: r.s * (1 - 1e-6) }, r.mode).ok, r.id).toBe(false);
      if (r.mode === "fold") expect(validate(cfg, "nofold").ok, r.id).toBe(false);
      else expect(validate(cfg, "fold").ok, r.id).toBe(true);
    }
    const Ns = new Set(fixtures.map((r) => r.N));
    for (const N of [0, 3, 6, 7, 12, 20, 100]) expect(Ns.has(N)).toBe(true);
  });

  it("parts of many-sided pieces partition the piece and agree with a ray walk", () => {
    for (const name of ["cube", "rhombic_dodecahedron", "prism7", "antiprism5"] as SolidName[]) {
      const S = getSolid(name);
      const rand = rng(77 + name.length);
      for (const N of [7, 12, 20, 100]) {
        const R = 1 / (2 * Math.sin(Math.PI / N));
        let tested = 0;
        for (let trial = 0; trial < 30 && tested < 2; trial++) {
          const s = ((1.2 + rand()) * 2 * R) / meanEdge(name);
          const face = Math.floor(rand() * S.F);
          const [x, y] = randomPointOf(S, s, face, rand);
          const pose = { face, x, y, theta: 2 * Math.PI * rand() };
          if (!validate({ solid: name, N, s, pieces: [pose] }, "fold").ok) continue;
          tested++;
          const nodes = enumerateChains(S, s, face, x, y, R);
          const parts = pieceParts(S, s, N, pose, 0, 1, nodes);
          const total = parts.reduce((u, p) => u + (p.poly.length >= 6 ? polygonArea(p.poly) : 0), 0);
          expect(Math.abs(total / pieceArea(N) - 1)).toBeLessThan(1e-9);
          const poly = pieceVertices(N, pose);
          for (let m = 0; m < 20; m++) {
            const r = Math.sqrt(rand()) * 0.99 * R * Math.cos(Math.PI / N);
            const t = 2 * Math.PI * rand();
            const qx = x + r * Math.cos(t);
            const qy = y + r * Math.sin(t);
            const walked = walkRayOf(S, s, face, x, y, Math.cos(t), Math.sin(t), r);
            if (!walked) continue;
            const found = parts.some((part) => {
              const node = nodes[part.chain];
              if (node.face !== walked.face || !inWedge(node.wedge, x, y, qx, qy, 1e-12)) return false;
              const [u, v] = apply(inverse(node.toAnchor), qx, qy);
              return Math.hypot(u - walked.x, v - walked.y) < 1e-8;
            });
            expect(found, `${name} N=${N}`).toBe(true);
          }
          expect(poly.length).toBe(2 * N);
        }
        expect(tested, `${name} N=${N}`).toBeGreaterThan(0);
      }
    }
  });

  it("a 100-gon packing validates in milliseconds", () => {
    for (const r of fixtures.filter((x) => x.N === 100)) {
      const t = performance.now();
      expect(validate({ solid: r.solid, N: r.N, s: r.s, pieces: r.pieces }, r.mode).ok).toBe(true);
      expect(performance.now() - t).toBeLessThan(2000);
    }
  });
});

describe("general solids: float validator, adversarial", () => {
  const cfg = (solid: SolidName, N: number, s: number, pieces: { face: number; x: number; y: number; theta: number }[]) => ({ solid, N, s, pieces });

  it("nofold: a piece crossing an edge of its face is rejected; moved inside, accepted", () => {
    for (const name of ["deltoidal_icositetrahedron", "rhombic_dodecahedron", "prism5", "antiprism6"] as SolidName[]) {
      const S = getSolid(name);
      const s = 4 / meanEdge(name);
      // a square centred on the midpoint of edge 0 of face 0
      const [ax, ay] = faceVertex(S, s, 0, 0);
      const [bx, by] = faceVertex(S, s, 0, 1);
      const mid = { face: 0, x: (ax + bx) / 2, y: (ay + by) / 2, theta: 0.3 };
      const v = validate(cfg(name, 4, s, [mid]), "nofold");
      expect(v.ok).toBe(false);
      expect(v.errors[0]).toMatch(/leaves face 0/);
      expect(validate(cfg(name, 4, s, [{ face: 0, x: 0, y: 0, theta: 0.3 }]), "nofold").ok).toBe(true);
      // a disk through the edge too
      expect(validate(cfg(name, 0, s, [{ ...mid, theta: 0 }]), "nofold").ok).toBe(false);
    }
  });

  it("fold: two pieces on neighbouring faces that overlap across the shared edge are rejected", () => {
    for (const name of ["deltoidal_icositetrahedron", "rhombic_dodecahedron", "prism5", "antiprism6"] as SolidName[]) {
      const S = getSolid(name);
      const s = 5 / meanEdge(name);
      const [ax, ay] = faceVertex(S, s, 0, 0);
      const [bx, by] = faceVertex(S, s, 0, 1);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      // a point 0.3 inside face 0 from the edge midpoint, and its mirror image 0.3 inside the neighbour
      const L = Math.hypot(bx - ax, by - ay);
      const nx = -(by - ay) / L;
      const ny = (bx - ax) / L;
      const p = { face: 0, x: mx + 0.3 * nx, y: my + 0.3 * ny, theta: 0 };
      const g = glue(S, s, 0, 0);
      const [qx, qy] = apply(inverse(g.T), mx - 0.3 * nx, my - 0.3 * ny);
      const q = { face: g.face, x: qx, y: qy, theta: 0 };
      for (const N of [0, 3, 6]) {
        const v = validate(cfg(name, N, s, [p, q]), "fold");
        expect(v.ok).toBe(false);
        expect(v.errors.join(" ")).toMatch(/overlap/);
        // nofold sees two pieces leaving their faces, never an overlap of pieces on different faces
        expect(validate(cfg(name, N, s, [p, q]), "nofold").errors.join(" ")).not.toMatch(/overlap/);
      }
      // far apart on the same two faces: no overlap
      const p2 = { face: 0, x: 0, y: 0, theta: 0 };
      const q2 = { face: g.face, x: 0, y: 0, theta: 0 };
      expect(validate(cfg(name, 0, s, [p2, q2]), "fold").ok).toBe(true);
    }
  });

  it("fold: a piece over a vertex is rejected at every kind of vertex, even the sharpest; touching it is allowed", () => {
    for (const name of ["triakis_tetrahedron", "deltoidal_icositetrahedron", "rhombic_dodecahedron", "prism3", "antiprism4", ...ARCHIMEDEAN_NAMES] as SolidName[]) {
      const S = getSolid(name);
      const s = 3 / meanEdge(name);
      // each kind of vertex: distinct cone angles
      const kinds = new Map<string, number>();
      S.vertexCone.forEach((c, v) => kinds.set(c.toFixed(9), v));
      for (const v of kinds.values()) {
        const f = S.faces.findIndex((face) => face.includes(v));
        const k = S.faces[f].indexOf(v);
        const [vx, vy] = faceVertex(S, s, f, k);
        // the centre 0.5 from the vertex towards the face's origin: a unit disk (or hexagon) covers the vertex
        const L = Math.hypot(vx, vy);
        for (const N of [0, 6]) {
          // a disk has radius 1/2 (diameter 1), a hexagon circumradius 1: the centre is half the piece's radius from the vertex
          const d = N === 0 ? 0.25 : 0.5;
          const c = { face: f, x: vx * (1 - d / L), y: vy * (1 - d / L), theta: 0.2 };
          const r = validate(cfg(name, N, s, [c]), "fold");
          expect(r.ok).toBe(false);
          expect(r.errors[0]).toMatch(/cone point/);
        }
        // a disk whose boundary passes through the vertex (distance exactly its radius 1/2): touching, allowed
        const t = { face: f, x: vx * (1 - 0.5 / L), y: vy * (1 - 0.5 / L), theta: 0 };
        expect(validate(cfg(name, 0, s, [t]), "fold").ok).toBe(true);
      }
    }
  });

  it("fold: a disk wrapping around a small solid overlaps itself or covers a vertex, never passes", () => {
    for (const name of ["prism3", "antiprism4", "rhombic_dodecahedron"] as SolidName[]) {
      const S = getSolid(name);
      for (const s of [0.25, 0.4, 0.6].map((k) => k / meanEdge(name))) { // disks of diameter 1: half the radius-1 sizes
        const r = validate(cfg(name, 0, s, [{ face: 0, x: 0, y: 0, theta: 0 }]), "fold");
        // the one-piece bound: some corner of the face is within its corner radius, so a disk this big covers one
        expect(r.ok).toBe(false);
      }
      expect(S.F).toBeGreaterThan(4);
    }
  });

  it("rejects malformed input", () => {
    const good = { face: 0, x: 0, y: 0, theta: 0 };
    expect(validate({ solid: "prism4" as SolidName, N: 0, s: 3, pieces: [good] }, "fold").errors[0]).toMatch(/unknown solid/);
    expect(validate(cfg("prism5", 0, 3, [{ ...good, face: 7 }]), "fold").ok).toBe(false);
    expect(validate(cfg("prism5", 0, 3, [{ ...good, face: -1 }]), "nofold").ok).toBe(false);
    expect(validate(cfg("antiprism5", 0, 3, [{ ...good, x: NaN }]), "fold").ok).toBe(false);
    expect(validate(cfg("rhombic_dodecahedron", 2, 3, [good]), "fold").ok).toBe(false);
    expect(validate(cfg("rhombic_dodecahedron", 0, -1, [good]), "fold").ok).toBe(false);
    expect(validate(cfg("rhombic_dodecahedron", 0, 3, []), "fold").ok).toBe(false);
    // a centre outside its anchor face
    expect(validate(cfg("rhombic_dodecahedron", 0, 6, [{ ...good, x: 100 }]), "fold").errors[0]).toMatch(/outside its face/);
  });
});

describe("separation along the half-planes a part was cut from", () => {
  it("rejects the overlap that a near-zero clipped edge once hid (surface/octahedron/fold/3/2)", () => {
    // reported 2026-10-26: a 2.5e-15 edge of a clipped part, with a tilted normal, "separated" two
    // overlapping parts when the axes came from the clipped polygons; the certifier rejects it too
    const cfg = {
      solid: "octahedron" as SolidName,
      N: 3,
      s: 2.397897003428079,
      pieces: [
        { face: 2, x: -0.021725557453399342, y: 0.807485119891262, theta: -0.037638655618227324 },
        { face: 0, x: -0.377819306807985, y: -0.14616605356121634, theta: -3.1792313092080215 },
      ],
    };
    const v = validate(cfg, "fold");
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/overlap/);
  });

  it("agrees with the polygon separation on whole pieces", async () => {
    const { polygonSeparation } = await import("@polypack/geometry");
    const { partSeparation, pieceOutline } = await import("../src/parts");
    const rand = rng(5);
    for (let t = 0; t < 300; t++) {
      const N = [3, 4, 7, 20][t % 4];
      const a = pieceOutline(N, { face: 0, x: 0, y: 0, theta: rand() * 7 });
      const b = pieceOutline(N, { face: 0, x: (rand() - 0.5) * 3, y: (rand() - 0.5) * 3, theta: rand() * 7 });
      const s1 = polygonSeparation(a.poly, b.poly).sep;
      const s2 = partSeparation({ poly: a.poly, cuts: a }, { poly: b.poly, cuts: b });
      expect(Math.abs(s1 - s2)).toBeLessThan(1e-12);
    }
  });
});
