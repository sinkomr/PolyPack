/**
 * Drawing of a packing on the surface of a convex solid (surface/<solid>/<mode>/<N>/<P>: a Platonic, Archimedean,
 * Catalan or Johnson solid, a prism or an antiprism): the solid itself, which turns, or a net of it, flat.
 * Ported from packages/surface/viz/app.ts and the net search of packages/surface/scripts/build-viz.ts.
 * Faces may differ in shape and number of sides; each is drawn from its own frame (faceVertex).
 *
 * A piece is laid out from its centre in its own face and continues across edges onto the next
 * faces (fold mode); pieceParts of packages/surface cuts it into the parts on each face, with the
 * same development code as the validator. Red dots are the vertices of the solid (its cone points).
 */
import { polygonSeparation } from "@polypack/geometry";
import type { SpaceConfig } from "@polypack/spaces";
import {
  IDENTITY,
  type Rigid,
  type SolidName,
  type SurfacePose,
  apply,
  compose,
  faceTo3D,
  faceVertex,
  getSolid,
  glue,
  pieceParts,
} from "@polypack/surface";
import { type SpaceRenderer, cssVar, fitCanvas, onDrag, pieceFill, piecesText } from "./common";

type V3 = [number, number, number];

/** For every face, its parent face and edge in a spanning tree whose unfolding does not overlap. */
function findNet(name: SolidName): number[][] {
  const S = getSolid(name);
  for (let attempt = 0; attempt < 200; attempt++) {
    const T: (Rigid | null)[] = Array(S.F).fill(null);
    const parent: number[][] = Array.from({ length: S.F }, () => [-1, -1]);
    const polys: Float64Array[] = [];
    const poly = (t: Rigid, f: number) => {
      const out = new Float64Array(2 * S.sides[f]);
      for (let k = 0; k < S.sides[f]; k++) {
        const [x, y] = apply(t, ...faceVertex(S, 1, f, k));
        out[2 * k] = x;
        out[2 * k + 1] = y;
      }
      return out;
    };
    T[0] = IDENTITY;
    polys[0] = poly(IDENTITY, 0);
    const order = [0];
    let seed = attempt * 7919 + 17;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let idx = 0; idx < order.length; idx++) {
      const f = order[idx];
      const edges = [...Array(S.sides[f]).keys()];
      if (attempt) edges.sort(() => rnd() - 0.5);
      for (const k of edges) {
        const g = glue(S, 1, f, k);
        if (T[g.face]) continue;
        const t = compose(T[f]!, g.T);
        const p = poly(t, g.face);
        if (polys.some((q) => q && polygonSeparation(p, q).sep < -1e-9)) continue;
        T[g.face] = t;
        polys[g.face] = p;
        parent[g.face] = [f, k];
        order.push(g.face);
      }
    }
    if (order.length === S.F) return parent;
  }
  throw new Error(`no net found for ${name}`);
}

const nets = new Map<SolidName, number[][]>();
const netOf = (name: SolidName) => nets.get(name) ?? nets.set(name, findNet(name)).get(name)!;

/** The rigid motion that lays face f into the plane of the net, for edge s. */
function netTransforms(name: SolidName, s: number): Rigid[] {
  const tree = netOf(name);
  const S = getSolid(name);
  const T: (Rigid | null)[] = Array(S.F).fill(null);
  T[0] = IDENTITY;
  let changed = true;
  while (changed) {
    changed = false;
    tree.forEach(([parent, edge], f) => {
      if (T[f] || parent < 0 || !T[parent]) return;
      T[f] = compose(T[parent]!, glue(S, s, parent, edge).T);
      changed = true;
    });
  }
  return T as Rigid[];
}

function rotate(p: V3, a: number, b: number): V3 {
  // yaw a about z, then pitch b about x
  const x = Math.cos(a) * p[0] - Math.sin(a) * p[1];
  const y = Math.sin(a) * p[0] + Math.cos(a) * p[1];
  const z = p[2];
  return [x, Math.cos(b) * y - Math.sin(b) * z, Math.sin(b) * y + Math.cos(b) * z];
}

interface DrawPart {
  piece: number;
  face: number;
  poly: Float64Array;
}

const START_ROT: [number, number] = [0.6, -0.5];

export function surfaceRenderer(solid: SolidName, N: number, P: number, mode: "fold" | "nofold"): SpaceRenderer {
  const cv = document.createElement("canvas");
  const S = getSolid(solid);
  let view = "solid";
  let rot: [number, number] = [...START_ROT];
  let s = 1;
  let parts: DrawPart[] = [];
  let drawn = false;

  function drawNet(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const T = netTransforms(solid, s);
    const faces = T.map((t, f) => {
      const pts: [number, number][] = [];
      for (let k = 0; k < S.sides[f]; k++) pts.push(apply(t, ...faceVertex(S, s, f, k)));
      return pts;
    });
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const f of faces)
      for (const [x, y] of f) {
        minx = Math.min(minx, x);
        maxx = Math.max(maxx, x);
        miny = Math.min(miny, y);
        maxy = Math.max(maxy, y);
      }
    const pad = 14;
    const sc = Math.min((W - 2 * pad) / (maxx - minx), (H - 2 * pad) / (maxy - miny));
    const X = (x: number) => pad + (x - minx) * sc + (W - 2 * pad - (maxx - minx) * sc) / 2;
    const Y = (y: number) => H - pad - (y - miny) * sc - (H - 2 * pad - (maxy - miny) * sc) / 2;
    const facePath = (f: [number, number][]) => {
      ctx.beginPath();
      f.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.closePath();
    };
    ctx.lineJoin = "round";
    for (const f of faces) {
      facePath(f);
      ctx.fillStyle = cssVar("--space-face");
      ctx.fill();
    }
    const stroke = cssVar("--space-piece-edge");
    for (const part of parts) {
      const t = T[part.face];
      ctx.beginPath();
      for (let i = 0; i < part.poly.length; i += 2) {
        const [x, y] = apply(t, part.poly[i], part.poly[i + 1]);
        if (i) ctx.lineTo(X(x), Y(y));
        else ctx.moveTo(X(x), Y(y));
      }
      ctx.closePath();
      ctx.fillStyle = pieceFill(part.piece, 0.85);
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    const edge = cssVar("--space-edge");
    const cone = cssVar("--space-cone");
    for (const f of faces) {
      facePath(f);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      for (const [x, y] of f) {
        ctx.beginPath();
        ctx.arc(X(x), Y(y), 2.2, 0, 2 * Math.PI);
        ctx.fillStyle = cone;
        ctx.fill();
      }
    }
  }

  function draw3D(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const rad = s * Math.max(...S.vertices.map((v) => Math.hypot(...v)));
    const sc = (0.42 * Math.min(W, H)) / rad;
    const [a, b] = rot;
    const proj = (p: V3): [number, number] => {
      const q = rotate(p, a, b);
      // weak perspective, the camera on -y
      const f = 1 / (1 + q[1] / (6 * rad));
      return [W / 2 + q[0] * sc * f, H / 2 - q[2] * sc * f];
    };
    const faces = S.faces.map((ids, f) => {
      const P3 = ids.map((v) => S.vertices[v].map((c) => c * s) as V3);
      const c: V3 = [0, 0, 0];
      for (const p of P3) for (let t = 0; t < 3; t++) c[t] += p[t] / ids.length;
      const n = rotate(c, a, b);
      // facing the camera (on -y): the outward normal, which on an irregular face need not point
      // along the centroid, has a negative y component
      const u = P3[1].map((x, t) => x - P3[0][t]);
      const w = P3[2].map((x, t) => x - P3[1][t]);
      const nrm = rotate([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], a, b);
      return { f, P3, depth: n[1], facing: nrm[1] < 0 };
    });
    faces.sort((u, v) => v.depth - u.depth);
    const faceColor = cssVar("--space-face");
    const edge = cssVar("--space-edge");
    const cone = cssVar("--space-cone");
    const stroke = cssVar("--space-piece-edge");
    const outline = (P3: V3[]) => {
      ctx.beginPath();
      P3.forEach((p, i) => {
        const [x, y] = proj(p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    };
    for (const face of faces) {
      if (!face.facing) continue;
      const shade = 0.55 + 0.45 * Math.min(1, -face.depth / rad);
      outline(face.P3);
      ctx.fillStyle = faceColor;
      ctx.fill();
      for (const part of parts) {
        if (part.face !== face.f) continue;
        ctx.beginPath();
        for (let i = 0; i < part.poly.length; i += 2) {
          const [x, y] = proj(faceTo3D(S, s, face.f, part.poly[i], part.poly[i + 1]));
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.globalAlpha = 0.45 + 0.5 * shade;
        ctx.fillStyle = pieceFill(part.piece, 0.9);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
      outline(face.P3);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      for (const p of face.P3) {
        const [x, y] = proj(p);
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, 2 * Math.PI);
        ctx.fillStyle = cone;
        ctx.fill();
      }
    }
  }

  function redraw() {
    const { ctx, w, h } = fitCanvas(cv);
    if (!drawn) return;
    if (view === "net") drawNet(ctx, w, h);
    else draw3D(ctx, w, h);
  }

  const stopDrag = onDrag(cv, (dx, dy) => {
    if (view !== "solid") return;
    rot = [rot[0] + dx * 0.01, Math.max(-1.5, Math.min(1.5, rot[1] + dy * 0.01))];
    redraw();
  });

  return {
    element: cv,
    views: [
      { key: "solid", label: "Solid" },
      { key: "net", label: "Net" },
    ],
    get view() {
      return view;
    },
    setView(key) {
      view = key === "net" ? "net" : "solid";
      redraw();
    },
    draw(c: SpaceConfig) {
      const cfg = c as unknown as { s: number; pieces: SurfacePose[] };
      s = cfg.s;
      parts = [];
      cfg.pieces.forEach((pose, i) => {
        for (const part of pieceParts(S, s, N, pose, i))
          if (part.poly.length >= 6) parts.push({ piece: i, face: part.face, poly: part.poly });
      });
      drawn = true;
      redraw();
    },
    redraw,
    canTurn: () => view === "solid",
    turn(dx, dy) {
      if (view !== "solid") return;
      rot = [rot[0] + dx, Math.max(-1.5, Math.min(1.5, rot[1] + dy))];
      redraw();
    },
    reset() {
      rot = [...START_ROT];
      redraw();
    },
    describe() {
      return drawn
        ? `${piecesText(N, P)} on a ${S.title} of ${S.family === "catalan" ? "scale" : "edge"} ${s.toFixed(6)}, ${mode === "fold" ? "folding over edges" : "each in one face"}; ${view === "net" ? "drawn as a net" : "drawn as the solid"}.`
        : "No packing to draw.";
    },
    destroy() {
      stopDrag();
      cv.remove();
    },
  };
}
