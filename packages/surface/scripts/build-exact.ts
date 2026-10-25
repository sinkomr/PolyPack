/**
 * Exact tilings of Platonic surfaces by unit squares (cube) and unit triangles (tetrahedron,
 * octahedron, icosahedron), the Goldberg–Coxeter / Caspar–Klug constructions.
 *
 * Squares: the face of side s = sqrt(a^2 + b^2) carries the unit square lattice whose basis
 * e1, e2 is rotated so that a e1 + b e2 is the face's bottom edge; every face corner is then a
 * lattice point, and the gluings (rotations by multiples of 90 degrees about corners) map the
 * lattice of one face onto that of its neighbour. The pieces are the lattice cells:
 * P = 6 (a^2 + b^2).
 * Triangles: the same with the triangular lattice, s^2 = h^2 + h k + k^2 (gluings rotate by
 * multiples of 60 degrees, which preserve the tiling by unit triangles): P = F (h^2 + h k + k^2).
 *
 * Hexagons (tetrahedron, octahedron): the hexagonal tiling by unit hexagons descends to the
 * surface when every holonomy (rotation about a cone point by the cone angle) is a symmetry of it
 * and no cone point is a hexagon centre. On the tetrahedron (holonomy 180 degrees) the cone points
 * sit at midpoints of hexagon sides; on the octahedron (holonomy 120 degrees) at hexagon vertices.
 * With T = h^2 + h k + k^2 the face side is s = sqrt(3 T), the side vector h a + k b in the lattice
 * of hexagon centres (spacing sqrt 3) or of one class of hexagon vertices (also spacing sqrt 3).
 * P = 2 T on the tetrahedron and 4 T on the octahedron; both meet the area bound. The tiling is
 * placed in face 0's frame and developed onto every face along a spanning tree of the gluings.
 *
 * Each cell becomes one piece anchored at the face that contains its centre (a centre on an
 * edge is moved 1e-12 into one of its faces, which the certificate's shrink absorbs).
 *
 * Usage: npx tsx packages/surface/scripts/build-exact.ts <out.json>
 */
import { writeFileSync } from "node:fs";
import { Rigid, SolidName, apply, compose, faceTo3D, frameVertex, getSolid, glue, insideFaceDepth, inverse, validateFold, areaBoundEdge, IDENTITY } from "../src/index";

const outPath = process.argv[2];
if (!outPath) throw new Error("usage: build-exact.ts <out.json>");

interface Exact {
  solid: SolidName;
  N: number;
  a: number;
  b: number;
}
const cases: Exact[] = [];
for (const [a, b] of [
  [1, 0],
  [1, 1],
  [2, 0],
  [2, 1],
  [2, 2],
])
  cases.push({ solid: "cube", N: 4, a, b });
for (const solid of ["tetrahedron", "octahedron", "icosahedron"] as SolidName[])
  for (const [h, k] of [
    [1, 0],
    [1, 1],
    [2, 0],
    [2, 1],
    [3, 0],
  ]) {
    if (solid === "icosahedron" && h * h + h * k + k * k > 4) continue;
    cases.push({ solid, N: 3, a: h, b: k });
  }

const out: any[] = [];
for (const c of cases) {
  const S = getSolid(c.solid);
  const sq = c.N === 4;
  // lattice basis before rotation
  const u = [1, 0];
  const v = sq ? [0, 1] : [0.5, Math.sqrt(3) / 2];
  const sx = c.a * u[0] + c.b * v[0];
  const sy = c.a * u[1] + c.b * v[1];
  const s = Math.hypot(sx, sy);
  const alpha = -Math.atan2(sy, sx);
  const rot = (p: number[]) => [Math.cos(alpha) * p[0] - Math.sin(alpha) * p[1], Math.sin(alpha) * p[0] + Math.cos(alpha) * p[1]];
  const e1 = rot(u);
  const e2 = rot(v);
  // lattice origin at a face corner: frame vertex M-1 (lower left for squares and triangles)
  const R = s / (2 * Math.sin(Math.PI / S.M));
  const a0 = -Math.PI / 2 + Math.PI / S.M + (2 * Math.PI * (S.M - 1)) / S.M;
  const ox = R * Math.cos(a0);
  const oy = R * Math.sin(a0);
  // cell centres in lattice coordinates and the piece angle of each cell
  const cells: { x: number; y: number; theta: number }[] = [];
  const span = Math.ceil(2 * s) + 2;
  for (let i = -span; i <= span; i++)
    for (let j = -span; j <= span; j++) {
      if (sq) {
        const x = ox + (i + 0.5) * e1[0] + (j + 0.5) * e2[0];
        const y = oy + (i + 0.5) * e1[1] + (j + 0.5) * e2[1];
        // a square with edges along e1, e2 has its vertices at alpha + 45 + 90 k degrees
        cells.push({ x, y, theta: alpha - Math.PI / 4 });
      } else {
        // up triangle (i, j), (i+1, j), (i, j+1): centroid at +(1/3, 1/3); down: +(2/3, 2/3)
        for (const [d, th] of [
          [1 / 3, alpha],
          [2 / 3, alpha + Math.PI],
        ] as [number, number][]) {
          const x = ox + (i + d) * e1[0] + (j + d) * e2[0];
          const y = oy + (i + d) * e1[1] + (j + d) * e2[1];
          cells.push({ x, y, theta: th });
        }
      }
    }
  const pieces: { face: number; x: number; y: number; theta: number }[] = [];
  const seen: [number, number, number][] = [];
  for (let f = 0; f < S.F; f++)
    for (const cell of cells) {
      const depth = insideFaceDepth(S.M, s, cell.x, cell.y);
      if (depth < -1e-9) continue;
      const p3 = faceTo3D(S, s, f, cell.x, cell.y);
      if (seen.some((q) => Math.hypot(q[0] - p3[0], q[1] - p3[1], q[2] - p3[2]) < 1e-7)) continue;
      seen.push(p3);
      let { x, y } = cell;
      if (depth < 1e-12) {
        // move the centre 1e-12 towards the face centre so that it lies inside its anchor face
        const r = Math.hypot(x, y);
        const t = (r - 2e-12) / r;
        x *= t;
        y *= t;
      }
      pieces.push({ face: f, x, y, theta: cell.theta });
    }
  const P = pieces.length;
  const T = c.a * c.a + c.a * c.b + (sq ? 0 : c.b * c.b);
  const expectP = sq ? 6 * (c.a * c.a + c.b * c.b) : S.F * (c.a * c.a + c.a * c.b + c.b * c.b);
  if (P !== expectP) throw new Error(`${c.solid} ${c.a},${c.b}: ${P} pieces, expected ${expectP} (T=${T})`);
  const val = validateFold({ solid: c.solid, N: c.N, s, pieces });
  if (!val.ok) throw new Error(`${c.solid} ${c.a},${c.b}: ${val.errors.slice(0, 3).join("; ")}`);
  const closed = sq ? `sqrt(${c.a * c.a + c.b * c.b})` : `sqrt(${c.a * c.a + c.a * c.b + c.b * c.b})`;
  out.push({
    id: `surface/${c.solid}/fold/${c.N}/${P}`,
    solid: c.solid,
    mode: "fold",
    N: c.N,
    P,
    s,
    pieces,
    exact: {
      construction: sq ? "Goldberg–Coxeter square tiling" : "Caspar–Klug triangle tiling",
      params: sq ? { a: c.a, b: c.b } : { h: c.a, k: c.b, T: c.a * c.a + c.a * c.b + c.b * c.b },
      s_exact: closed,
      lattice_rotation: alpha,
    },
    area_bound: areaBoundEdge(c.solid, c.N, P),
    float_check: { minPairSep: val.minPairSep, minConeSep: val.minConeSep },
  });
  console.log(c.solid, c.N, P, s.toFixed(9), closed, "area bound", areaBoundEdge(c.solid, c.N, P).toFixed(9), "minSep", val.minPairSep.toExponential(2));
}
// ---- hexagon tilings of the tetrahedron and the octahedron, by development from face 0
for (const solidName of ["tetrahedron", "octahedron"] as SolidName[])
  for (const [h, k] of [
    [1, 0],
    [1, 1],
    [2, 0],
    [2, 1],
  ]) {
    const S = getSolid(solidName);
    const T = h * h + h * k + k * k;
    const P = solidName === "tetrahedron" ? 2 * T : 4 * T;
    if (P > 24) continue;
    const r3 = Math.sqrt(3);
    // lattice of spacing sqrt 3: hexagon centres (tetrahedron) or one class of hexagon vertices (octahedron)
    const a = [r3, 0];
    const b = [r3 / 2, 1.5];
    const sx = h * a[0] + k * b[0];
    const sy = h * a[1] + k * b[1];
    const s = Math.hypot(sx, sy);
    const alpha = -Math.atan2(sy, sx);
    const rot = (p: number[]) => [Math.cos(alpha) * p[0] - Math.sin(alpha) * p[1], Math.sin(alpha) * p[0] + Math.cos(alpha) * p[1]];
    const A = rot(a);
    const B = rot(b);
    const [ox, oy] = frameVertex(S.M, s, S.M - 1); // the lower-left corner, a lattice point
    // Hexagons at angle theta have vertices at theta + 90 + 60 m degrees and neighbouring centres at
    // theta + 60 m; one class of their vertices forms a lattice along the same directions. So with
    // theta = alpha both lattices are A, B. Tetrahedron: the corner is the midpoint between two
    // centres, so the centres are corner + A/2 + lattice. Octahedron: the corner is the vertex at
    // theta + 90 degrees of a hexagon, whose centre is corner - (cos(theta + 90), sin(theta + 90)).
    const theta = alpha;
    const off = solidName === "tetrahedron" ? [A[0] / 2, A[1] / 2] : [Math.sin(alpha), -Math.cos(alpha)];
    // development: transform of every face into face 0's plane along a BFS tree
    const Tf: (Rigid | null)[] = Array(S.F).fill(null);
    Tf[0] = IDENTITY;
    const queue = [0];
    while (queue.length) {
      const f = queue.shift()!;
      for (let e = 0; e < S.M; e++) {
        const g = glue(S, s, f, e);
        if (Tf[g.face]) continue;
        Tf[g.face] = compose(Tf[f]!, g.T);
        queue.push(g.face);
      }
    }
    const pieces: { face: number; x: number; y: number; theta: number }[] = [];
    const seen: [number, number, number][] = [];
    const span = 12;
    for (let f = 0; f < S.F; f++) {
      const back = inverse(Tf[f]!);
      for (let i = -span; i <= span; i++)
        for (let j = -span; j <= span; j++) {
          const px = ox + off[0] + i * A[0] + j * B[0];
          const py = oy + off[1] + i * A[1] + j * B[1];
          let [x, y] = apply(back, px, py);
          const depth = insideFaceDepth(S.M, s, x, y);
          if (depth < -1e-9) continue;
          const p3 = faceTo3D(S, s, f, x, y);
          if (seen.some((q) => Math.hypot(q[0] - p3[0], q[1] - p3[1], q[2] - p3[2]) < 1e-7)) continue;
          seen.push(p3);
          if (depth < 1e-12) {
            const rr = Math.hypot(x, y);
            x *= (rr - 2e-12) / rr;
            y *= (rr - 2e-12) / rr;
          }
          pieces.push({ face: f, x, y, theta: theta + back.ang });
        }
    }
    if (pieces.length !== P) throw new Error(`${solidName} hexagons ${h},${k}: ${pieces.length} pieces, expected ${P}`);
    const val = validateFold({ solid: solidName, N: 6, s, pieces });
    if (!val.ok) throw new Error(`${solidName} hexagons ${h},${k}: ${val.errors.slice(0, 3).join("; ")}`);
    out.push({
      id: `surface/${solidName}/fold/6/${P}`,
      solid: solidName,
      mode: "fold",
      N: 6,
      P,
      s,
      pieces,
      exact: {
        construction: "hexagon tiling",
        params: { h, k, T },
        s_exact: `sqrt(${3 * T})`,
        lattice_rotation: alpha,
      },
      area_bound: areaBoundEdge(solidName, 6, P),
      float_check: { minPairSep: val.minPairSep, minConeSep: val.minConeSep },
    });
    console.log(solidName, 6, P, s.toFixed(9), `sqrt(${3 * T})`, "area bound", areaBoundEdge(solidName, 6, P).toFixed(9), "minSep", val.minPairSep.toExponential(2));
  }
writeFileSync(outPath, JSON.stringify({ generated: "2026-10-24", records: out }));
