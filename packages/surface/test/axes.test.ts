/**
 * Separating axes of the fold check. Clipping can leave a part a side about 1e-15 long whose
 * computed direction is arbitrary; an axis taken from that side cuts a sliver off the part, and a
 * second piece poking into the sliver was called apart from it (the earlier rule accepted
 * surface/octahedron/fold/3/2 below). The parts now carry the exact
 * half-planes they were cut from, and the check takes its axes from them (parts.ts
 * partSeparation). These tests pin that down against an overlap measure that uses no clipped
 * polygon at all.
 */
import { boundingRadius, inradius, polygonSeparation } from "@polypack/geometry";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type SolidName,
  type Solid,
  type SurfacePose,
  SOLID_NAMES,
  apply,
  applyDir,
  faceApothem,
  frameVertex,
  getSolid,
  glue,
  inverse,
  partSeparation,
  pieceChains,
  pieceParts,
  validateFold,
} from "../src/index";
import { canonicalize } from "../src/search/energy";
import { rng } from "./helpers";

/**
 * Depth of the point (x, y) of face f inside the developed piece (negative: outside), from the
 * pose's own side lines, the wedge rays of the chains that reach face f, and the face's edges.
 */
function exactDepth(S: Solid, N: number, s: number, p: SurfacePose, f: number, x: number, y: number, nodes = pieceChains(S, s, N, p, 1, 200)): number {
  const rin = inradius(N);
  const M = S.M;
  const ap = faceApothem(M, s);
  let face = Infinity;
  for (let j = 0; j < M; j++) {
    const a = (2 * Math.PI * (j + 1)) / M - Math.PI / 2;
    face = Math.min(face, ap - (x * Math.cos(a) + y * Math.sin(a)));
  }
  let best = -Infinity;
  for (const node of nodes) {
    if (node.face !== f) continue;
    const [u, v] = apply(node.toAnchor, x, y);
    let d = face;
    for (let j = 0; j < N; j++) {
      const a = p.theta + Math.PI / 2 + Math.PI / N + (2 * Math.PI * j) / N;
      d = Math.min(d, rin - ((u - p.x) * Math.cos(a) + (v - p.y) * Math.sin(a)));
    }
    if (node.wedge) {
      const W = node.wedge;
      d = Math.min(d, W.lx * (v - p.y) - W.ly * (u - p.x), (u - p.x) * W.hy - (v - p.y) * W.hx);
    }
    best = Math.max(best, d);
  }
  return best;
}

/**
 * A pose whose centre may lie off its face, developed along the segment from the face's centre
 * (its frame origin) across the edges it crosses: the placement a piece reaching over a vertex has.
 */
function unfoldFromCentre(S: Solid, s: number, p: SurfacePose): SurfacePose {
  const M = S.M;
  const ap = faceApothem(M, s);
  let { face, theta } = p;
  let [ox, oy, dx, dy] = [0, 0, p.x, p.y];
  let entry = -1;
  for (let step = 0; step < 1000; step++) {
    let tau = Infinity;
    let k = -1;
    for (let j = 0; j < M; j++) {
      if (j === entry) continue;
      const a = (2 * Math.PI * (j + 1)) / M - Math.PI / 2;
      const nd = Math.cos(a) * dx + Math.sin(a) * dy;
      if (!(nd > 0)) continue;
      const tj = (ap - Math.cos(a) * ox - Math.sin(a) * oy) / nd;
      if (tj < tau) [tau, k] = [tj, j];
    }
    if (k < 0 || tau >= 1) return { face, x: ox + dx, y: oy + dy, theta };
    // the gluing maps the neighbour's frame into this one; its inverse takes the crossing there
    const g = glue(S, s, face, k);
    const T = inverse(g.T);
    [ox, oy] = apply(T, ox + tau * dx, oy + tau * dy);
    [dx, dy] = applyDir(T, (1 - tau) * dx, (1 - tau) * dy);
    theta += T.ang;
    face = g.face;
    entry = g.edge;
  }
  throw new Error("unfoldFromCentre: too many faces");
}

/** The deepest point common to two pieces found by sampling b's parts: min of the two depths, maximised. */
function sampledOverlap(S: Solid, N: number, s: number, a: SurfacePose, b: SurfacePose, grid = 6): number {
  let depth = -Infinity;
  const na = pieceChains(S, s, N, a, 1, 200);
  const nb = pieceChains(S, s, N, b, 1, 200);
  for (const q of pieceParts(S, s, N, b, 1, 1, nb)) {
    const n = q.poly.length / 2;
    if (n < 3) continue;
    let mx = 0;
    let my = 0;
    for (let k = 0; k < n; k++) {
      mx += q.poly[2 * k] / n;
      my += q.poly[2 * k + 1] / n;
    }
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      for (let i = 0; i <= grid; i++)
        for (let j = 0; i + j <= grid; j++) {
          // barycentric samples of the triangle (centroid, corner k, corner k + 1)
          const wa = i / grid;
          const wb = j / grid;
          const wc = 1 - wa - wb;
          const x = wc * mx + wa * q.poly[2 * k] + wb * q.poly[2 * k2];
          const y = wc * my + wa * q.poly[2 * k + 1] + wb * q.poly[2 * k2 + 1];
          depth = Math.max(depth, Math.min(exactDepth(S, N, s, a, q.face, x, y, na), exactDepth(S, N, s, b, q.face, x, y, nb)));
        }
    }
  }
  return depth;
}

/** The smallest separation of two pieces' parts with the axes taken from the clipped sides (the old check). */
function clippedAxesSeparation(S: Solid, N: number, s: number, a: SurfacePose, b: SurfacePose): number {
  const A = pieceParts(S, s, N, a, 0).filter((q) => q.poly.length >= 6);
  const B = pieceParts(S, s, N, b, 1).filter((q) => q.poly.length >= 6);
  let sep = Infinity;
  for (const p of A) for (const q of B) if (p.face === q.face) sep = Math.min(sep, polygonSeparation(p.poly, q.poly).sep);
  return sep;
}

/** A configuration the earlier rule accepted: piece 0 has a corner on the top vertex of face 2, piece 1 pokes 7.9e-4 into it. */
const REPRO = {
  s: 2.397897003428079,
  pieces: [
    { face: 2, x: -0.021725557453399342, y: 0.807485119891262, theta: -0.037638655618227324 },
    { face: 0, x: -0.377819306807985, y: -0.14616605356121634, theta: -3.1792313092080215 },
  ],
};
/** The same pieces on an edge larger by a factor 1 + 9.14e-4 (+1e-9), where they are apart; python/surface/cert.py certifies it at eps 1e-12. */
const NEAR = {
  s: 2.40008894492685,
  pieces: [
    { face: 2, x: -0.02174541700153588, y: 0.8082232500700809, theta: -0.037638655618227324 },
    { face: 0, x: -0.37816467519388536, y: -0.14629966540444997, theta: -3.1792313092080215 },
  ],
};
/** 1e-6 (relative) below that edge, where they overlap by about 4e-7; the certifier rejects it. */
const FAR = {
  s: 2.400086542437817,
  pieces: [
    { face: 2, x: -0.021745395234373466, y: 0.8082224410386077, theta: -0.037638655618227324 },
    { face: 0, x: -0.37816429665104556, y: -0.14629951895848492, theta: -3.1792313092080215 },
  ],
};

/** Poses whose parts have a clipped side whose computed normal cuts the part (found by probing corners on vertices and sides along edges). */
const SLIVERS: { solid: SolidName; N: number; s: number; pose: SurfacePose }[] = [
  { solid: "octahedron", N: 3, s: 2.397897003428079, pose: REPRO.pieces[0] },
  {
    solid: "octahedron",
    N: 8,
    s: 1.0897611038293689,
    pose: { face: 0, x: -7.101261994069014e-16, y: 0.6285446927816212, theta: 2.3402759987347066 },
  },
  {
    solid: "icosahedron",
    N: 3,
    s: 3.183875062712468,
    pose: { face: 13, x: 1.2945370354429382, y: -0.42424570496473957, theta: 7.871522069533558 },
  },
  {
    solid: "octahedron",
    N: 8,
    s: 2.266766514838673,
    pose: { face: 7, x: -0.08214150599148118, y: -0.6189308604091064, theta: -1.8713410038584815 },
  },
  {
    solid: "dodecahedron",
    N: 8,
    s: 2.003830260108225,
    pose: { face: 4, x: 0.7379348084222851, y: -0.3646970585735645, theta: 2.833077107913249 },
  },
];

/** Second pieces tried per sliver. */
const TRIES = 30;

describe("separating axes of the fold check", () => {
  it("rejects the overlap the clipped-side axes accepted", () => {
    const S = getSolid("octahedron");
    for (const tol of [1e-9, 0]) {
      const v = validateFold({ solid: "octahedron", N: 3, ...REPRO }, { tol });
      expect(v.ok).toBe(false);
      expect(v.errors[0]).toMatch(/^pieces 0 and 1 overlap on face 2 \(depth 0\.00079091858/);
    }
    // a point of face 2 deep inside both pieces, by their side lines, wedge rays and face edges:
    // piece 1's corner, moved back along piece 0's side normal by half its depth
    const d = 0.0007909185819621745;
    const x = 0.37294667931813286 + 0.5 * d * 0.8842269254564273;
    const y = 0.676675535566987 + 0.5 * d * 0.46705753853018367;
    expect(exactDepth(S, 3, REPRO.s, REPRO.pieces[0], 2, x, y)).toBeGreaterThan(3.9e-4);
    expect(exactDepth(S, 3, REPRO.s, REPRO.pieces[1], 2, x, y)).toBeGreaterThan(1.9e-4);
    // the clipped sides' axes call them apart
    expect(clippedAxesSeparation(S, 3, REPRO.s, REPRO.pieces[0], REPRO.pieces[1])).toBeGreaterThan(0);
  });

  it("keeps the same pieces valid once they are apart, as the certifier does", () => {
    expect(validateFold({ solid: "octahedron", N: 3, ...NEAR }, { tol: 0 }).ok).toBe(true);
    // the same pair listed the other way round: the check must take both parts' cuts
    const swapped = { ...NEAR, pieces: [...NEAR.pieces].reverse() };
    expect(validateFold({ solid: "octahedron", N: 3, ...swapped }, { tol: 0 }).ok).toBe(true);
    const far = validateFold({ solid: "octahedron", N: 3, ...FAR }, { tol: 0 });
    expect(far.ok).toBe(false);
    expect(-far.minPairSep).toBeGreaterThan(1e-7);
    expect(-far.minPairSep).toBeLessThan(1e-6);
  });

  it("gives every part half-planes that hold it, with every side of the part on one of them", () => {
    const rand = rng(41);
    const poses: { S: Solid; N: number; s: number; p: SurfacePose }[] = SLIVERS.map((c) => ({ S: getSolid(c.solid), N: c.N, s: c.s, p: c.pose }));
    // corners on vertices and on edges, sides along edges and through vertices, on every solid
    for (let t = 0; t < 300; t++) {
      const S = getSolid(SOLID_NAMES[t % 5]);
      const N = [3, 4, 5, 6, 8][Math.floor(rand() * 5)];
      const s = 1 + 2 * rand();
      const k = Math.floor(rand() * S.M);
      const [ax, ay] = frameVertex(S.M, s, k);
      const [bx, by] = frameVertex(S.M, s, k + 1);
      const R = boundingRadius(N);
      const rin = inradius(N);
      const kind = t % 3;
      let p: SurfacePose;
      if (kind < 2) {
        // a corner at a vertex (kind 0) or on an edge (kind 1)
        const f = kind === 0 ? 0 : rand();
        const X = [ax + f * (bx - ax), ay + f * (by - ay)];
        const phi = 2 * Math.PI * rand();
        p = { face: Math.floor(rand() * S.F), x: X[0] - R * Math.cos(phi), y: X[1] - R * Math.sin(phi), theta: phi - Math.PI / 2 };
      } else {
        // a side through a vertex
        const a = 2 * Math.PI * rand();
        const w = (rand() - 0.5) * 2 * R * Math.sin(Math.PI / N);
        p = { face: Math.floor(rand() * S.F), x: ax - rin * Math.cos(a) + w * Math.sin(a), y: ay - rin * Math.sin(a) - w * Math.cos(a), theta: a - Math.PI / 2 - Math.PI / N };
      }
      const q = canonicalize(S, s, p);
      if (Math.hypot(q.x, q.y) > faceApothem(S.M, s)) continue;
      poses.push({ S, N, s, p: q });
    }
    let parts = 0;
    for (const { S, N, s, p } of poses) {
      let list;
      try {
        list = pieceParts(S, s, N, p, 0, 1, pieceChains(S, s, N, p, 1, 200));
      } catch {
        continue;
      }
      for (const part of list) {
        const q = part.poly;
        const n = q.length / 2;
        if (n < 3) continue;
        parts++;
        const { nx, ny, b } = part.cuts;
        const scale = Math.max(1, s);
        for (let i = 0; i < n; i++) {
          // inside every half-plane
          for (let h = 0; h < b.length; h++) expect(nx[h] * q[2 * i] + ny[h] * q[2 * i + 1] - b[h]).toBeLessThan(1e-12 * scale);
          // the side from corner i to i + 1 lies on some half-plane's line
          const j = (i + 1) % n;
          let on = false;
          for (let h = 0; h < b.length && !on; h++)
            on =
              Math.abs(nx[h] * q[2 * i] + ny[h] * q[2 * i + 1] - b[h]) < 1e-9 * scale &&
              Math.abs(nx[h] * q[2 * j] + ny[h] * q[2 * j + 1] - b[h]) < 1e-9 * scale;
          expect(on).toBe(true);
        }
      }
    }
    expect(parts).toBeGreaterThan(500);
  });

  it("rejects every second piece that pokes into a sliver the clipped-side axes cut off", () => {
    const rand = rng(9);
    let pokes = 0;
    let oldAccepted = 0;
    for (const c of SLIVERS) {
      const S = getSolid(c.solid);
      const { N, s, pose: p1 } = c;
      const R = boundingRadius(N);
      // the clipped sides whose computed normal cuts the part, with the piece side the sliver lies along
      const targets: { f: number; v: number[]; u: number[]; w: number[]; corner: number[] }[] = [];
      for (const part of pieceParts(S, s, N, p1, 0, 1, pieceChains(S, s, N, p1, 1, 200))) {
        const q = part.poly;
        const n = q.length / 2;
        if (n < 3) continue;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const len = Math.hypot(q[2 * j] - q[2 * i], q[2 * j + 1] - q[2 * i + 1]);
          const u = [(q[2 * j + 1] - q[2 * i + 1]) / len, -(q[2 * j] - q[2 * i]) / len];
          let viol = -Infinity;
          let w = -1;
          for (let m = 0; m < n; m++) {
            const d = (q[2 * m] - q[2 * i]) * u[0] + (q[2 * m + 1] - q[2 * i + 1]) * u[1];
            if (d > viol) {
              viol = d;
              w = m;
            }
          }
          if (!(viol > 1e-6)) continue;
          const corner = (w + n - 1) % n === j || (w + n - 1) % n === i ? (w + n - 1) % n : (w + 1) % n;
          targets.push({ f: part.face, v: [q[2 * i], q[2 * i + 1]], u, w: [q[2 * w], q[2 * w + 1]], corner: [q[2 * corner], q[2 * corner + 1]] });
        }
      }
      expect(targets.length, c.solid).toBeGreaterThan(0);
      for (const T of targets)
        for (let t = 0; t < TRIES; t++) {
          // a point of the piece side from the sliver's corner, pushed into the sliver by part of its thickness
          const dx = T.w[0] - T.corner[0];
          const dy = T.w[1] - T.corner[1];
          const L = Math.hypot(dx, dy);
          let nout = [dy / L, -dx / L];
          if (nout[0] * T.u[0] + nout[1] * T.u[1] < 0) nout = [-nout[0], -nout[1]];
          const f = 0.3 + 0.65 * rand();
          const P0 = [T.corner[0] + f * dx, T.corner[1] + f * dy];
          const thick = (P0[0] - T.v[0]) * T.u[0] + (P0[1] - T.v[1]) * T.u[1];
          const delta = thick * (0.2 + 0.6 * rand());
          const tip = [P0[0] - delta * nout[0], P0[1] - delta * nout[1]];
          // the second piece's corner at the tip, pointing into the first piece
          const ang = Math.atan2(-nout[1], -nout[0]) + (rand() - 0.5) * 0.8;
          const p2 = unfoldFromCentre(S, s, { face: T.f, x: tip[0] - R * Math.cos(ang), y: tip[1] - R * Math.sin(ang), theta: ang - Math.PI / 2 });
          // independent overlap: points on the second piece's axis just behind its tip, and samples of its parts
          let depth = -Infinity;
          for (let k = 1; k <= 8; k++) {
            const X = [tip[0] - (k / 8) * delta * Math.cos(ang), tip[1] - (k / 8) * delta * Math.sin(ang)];
            depth = Math.max(depth, Math.min(exactDepth(S, N, s, p1, T.f, X[0], X[1]), exactDepth(S, N, s, p2, T.f, X[0], X[1])));
          }
          depth = Math.max(depth, sampledOverlap(S, N, s, p1, p2, 4));
          if (!(depth > 1e-7)) continue;
          pokes++;
          const v = validateFold({ solid: c.solid, N, s, pieces: [p1, p2] }, { tol: 1e-9, maxChains: 200 });
          expect(v.ok, JSON.stringify({ solid: c.solid, N, s, pieces: [p1, p2], depth })).toBe(false);
          if (clippedAxesSeparation(S, N, s, p1, p2) > -1e-9) {
            oldAccepted++;
            // what the old axes missed is now an overlap at least as deep as the independent one
            expect(v.errors[0]).toMatch(/^pieces 0 and 1 overlap/);
            expect(-v.minPairSep).toBeGreaterThanOrEqual(depth * (1 - 1e-9));
          }
        }
    }
    expect(pokes).toBeGreaterThan(30);
    // the clipped-side axes missed some of these overlaps
    expect(oldAccepted).toBeGreaterThan(0);
  });

  it("keeps the exact tilings valid: corners on the vertices, sides along the edges and through the vertices", () => {
    const records: { id: string; solid: SolidName; N: number; s: number; eps: string; pieces: SurfacePose[] }[] = JSON.parse(
      readFileSync(new URL("../../../data/surface/records.json", import.meta.url), "utf8"),
    ).records;
    const ids = [
      "surface/tetrahedron/fold/3/16",
      "surface/tetrahedron/fold/6/6",
      "surface/tetrahedron/fold/6/14",
      "surface/cube/fold/4/30",
      "surface/cube/fold/4/48",
      "surface/octahedron/fold/3/32",
      "surface/octahedron/fold/6/4",
      "surface/octahedron/fold/6/16",
      "surface/icosahedron/fold/3/60",
      "surface/icosahedron/fold/3/80",
    ];
    for (const id of ids) {
      const r = records.find((x) => x.id === id)!;
      expect(validateFold({ solid: r.solid, N: r.N, s: r.s, pieces: r.pieces }, { tol: 1e-9, maxChains: 200 }).ok, id).toBe(true);
      // the certificate's statement: pieces shrunk by 1 - eps are strictly apart, so unit pieces on the edge s / (1 - eps) pass at tolerance 0
      const lam = 1 - Number(r.eps);
      const pieces = r.pieces.map((p) => ({ ...p, x: p.x / lam, y: p.y / lam }));
      expect(validateFold({ solid: r.solid, N: r.N, s: r.s / lam, pieces }, { tol: 0 }).ok, id).toBe(true);
    }
  });

  it("measures overlapping parts by their separating-axis depth, as the clipped polygons do when their sides are long", () => {
    // two squares on one cube face, overlapping by 0.1 along x: no clipping, so both measures agree
    const S = getSolid("cube");
    const a = pieceParts(S, 3, 4, { face: 0, x: -0.45, y: 0, theta: Math.PI / 4 }, 0)[0];
    const b = pieceParts(S, 3, 4, { face: 0, x: 0.45, y: 0.2, theta: Math.PI / 4 }, 1)[0];
    expect(partSeparation(a, b)).toBeCloseTo(-0.1, 12);
    expect(partSeparation(a, b)).toBeCloseTo(polygonSeparation(a.poly, b.poly).sep, 12);
    // apart by 0.2
    const c = pieceParts(S, 3, 4, { face: 0, x: 0.75, y: 0.2, theta: Math.PI / 4 }, 1)[0];
    expect(partSeparation(a, c)).toBeCloseTo(0.2, 12);
  });
});
