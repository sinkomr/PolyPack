/**
 * Drawing of a whole-sphere packing (sphere/<N>/<P>): a globe that turns, with the far side seen
 * faintly through it, or a map of the two hemispheres facing and facing away from the viewer
 * (azimuthal equal-area). Ported from packages/sphere/viz/template.html.
 *
 * Pieces live on the unit sphere with angular size 1/rho: a disk of radius 1 on the sphere of
 * radius rho is a cap of angular radius 1/rho, a polygon of side 1 has vertices at angular
 * circumradius R with sin(1/(2 rho)) = sin R sin(pi/N). A piece is the standard piece at the north
 * pole turned by its quaternion q (v -> q v q*).
 */
import type { SpaceConfig } from "@polypack/spaces";
import { type SpaceRenderer, cssVar, fitCanvas, onDrag, pieceFill, piecesText } from "./common";

type V3 = [number, number, number];
type M3 = [V3, V3, V3];
type Quat = [number, number, number, number];

function qmat(q: Quat): M3 {
  const [w, x, y, z] = q;
  const n = w * w + x * x + y * y + z * z;
  return [
    [(w * w + x * x - y * y - z * z) / n, (2 * (x * y - w * z)) / n, (2 * (x * z + w * y)) / n],
    [(2 * (x * y + w * z)) / n, (w * w - x * x + y * y - z * z) / n, (2 * (y * z - w * x)) / n],
    [(2 * (x * z - w * y)) / n, (2 * (y * z + w * x)) / n, (w * w - x * x - y * y + z * z) / n],
  ];
}
const mv = (M: M3, v: V3): V3 => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
];
const mm = (A: M3, B: M3): M3 =>
  A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]) as V3) as M3;

/** Rotation by t about the axis ax. */
function rotAxis(ax: V3, t: number): M3 {
  const n = Math.hypot(...ax) || 1;
  const [x, y, z] = [ax[0] / n, ax[1] / n, ax[2] / n];
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

const START_VIEW: M3 = rotAxis([1, 0, 0], -0.5);

/** The boundary of a piece sampled on the unit sphere (world coordinates). */
function boundary(N: number, rho: number, q: Quat): V3[] {
  const M = qmat(q);
  const a = 1 / rho;
  const pts: V3[] = [];
  if (N === 0) {
    const n = 96;
    for (let k = 0; k < n; k++) {
      const t = (2 * Math.PI * k) / n;
      pts.push(mv(M, [Math.sin(a) * Math.cos(t), Math.sin(a) * Math.sin(t), Math.cos(a)]));
    }
    return pts;
  }
  const R = Math.asin(Math.min(1, Math.sin(a / 2) / Math.sin(Math.PI / N)));
  const V: V3[] = [];
  for (let k = 0; k < N; k++) {
    const p = Math.PI / 2 + (2 * Math.PI * k) / N;
    V.push([Math.sin(R) * Math.cos(p), Math.sin(R) * Math.sin(p), Math.cos(R)]);
  }
  const seg = Math.max(6, Math.ceil(48 / N));
  for (let k = 0; k < N; k++) {
    const A = V[k];
    const B = V[(k + 1) % N];
    const om = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
    // slerp: the edge is a geodesic
    for (let s = 0; s < seg; s++) {
      const t = s / seg;
      const sa = Math.sin((1 - t) * om) / Math.sin(om);
      const sb = Math.sin(t * om) / Math.sin(om);
      pts.push(mv(M, [sa * A[0] + sb * B[0], sa * A[1] + sb * B[1], sa * A[2] + sb * B[2]]));
    }
  }
  return pts;
}

/**
 * A closed loop of unit vectors (camera space) clipped to the hemisphere s z >= 0. The boundary
 * part on the rim is the shorter arc of the great circle z = 0 between the exit and entry points
 * (a convex piece lies in an open hemisphere, so it meets the rim in one arc shorter than pi).
 */
function clipHemi(pts: V3[], s: number): V3[] {
  const n = pts.length;
  let any = false;
  let all = true;
  for (const p of pts) {
    if (s * p[2] >= 0) any = true;
    else all = false;
  }
  if (!any) return [];
  if (all) return pts;
  const out: { p: V3; kind?: "exit" | "entry" }[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const zp = s * p[2];
    const zq = s * q[2];
    if (zp >= 0) out.push({ p });
    if (zp >= 0 !== zq >= 0) {
      const t = zp / (zp - zq);
      const x: V3 = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), 0];
      const m = Math.hypot(x[0], x[1]) || 1;
      out.push({ p: [x[0] / m, x[1] / m, 0], kind: zp >= 0 ? "exit" : "entry" });
    }
  }
  const res: V3[] = [];
  for (let i = 0; i < out.length; i++) {
    res.push(out[i].p);
    if (out[i].kind === "exit") {
      const e = out[i].p;
      const f = out[(i + 1) % out.length].p;
      const a0 = Math.atan2(e[1], e[0]);
      let d = Math.atan2(f[1], f[0]) - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const m = Math.max(2, Math.ceil(Math.abs(d) / 0.05));
      for (let k = 1; k < m; k++) res.push([Math.cos(a0 + (d * k) / m), Math.sin(a0 + (d * k) / m), 0]);
    }
  }
  return res;
}

export function sphereRenderer(N: number, P: number): SpaceRenderer {
  const cv = document.createElement("canvas");
  let view = "globe";
  let Rv: M3 = START_VIEW;
  let config: { rho: number; pieces: { q: Quat }[] } | null = null;
  let shapes: V3[][] = [];
  let centres: V3[] = [];

  const path = (ctx: CanvasRenderingContext2D, pts: V3[], proj: (p: V3) => [number, number]) => {
    ctx.beginPath();
    pts.forEach((p, k) => {
      const [x, y] = proj(p);
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
  };

  function drawGlobe(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const r = Math.min(W, H) * 0.46;
    const cx = W / 2;
    const cy = H / 2;
    const proj = (p: V3): [number, number] => [cx + r * p[0], cy - r * p[1]];
    const cs = shapes.map((s) => s.map((p) => mv(Rv, p)));
    const cc = centres.map((p) => mv(Rv, p));
    const edge = cssVar("--muted");
    // the far hemisphere, faint, seen through the globe
    ctx.lineWidth = 1.2;
    cs.forEach((s0, i) => {
      const s = clipHemi(s0, -1);
      if (!s.length) return;
      path(ctx, s, proj);
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = pieceFill(i);
      ctx.fill();
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = edge;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    });
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
    g.addColorStop(0, cssVar("--panel"));
    g.addColorStop(1, cssVar("--space-globe"));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = g;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // the near hemisphere, back to front by the depth of the centre
    const text = cssVar("--text");
    const order = cs
      .map((_, i) => i)
      .filter((i) => cs[i].some((p) => p[2] >= 0))
      .sort((a, b) => cc[a][2] - cc[b][2]);
    for (const i of order) {
      path(ctx, clipHemi(cs[i], 1), proj);
      ctx.globalAlpha = 0.55 + 0.45 * Math.max(0, cc[i][2]);
      ctx.fillStyle = pieceFill(i);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = text;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      if (cc[i][2] > 0.2 && P <= 40) {
        const [x, y] = proj(cc[i]);
        ctx.fillStyle = text;
        ctx.font = `${Math.max(9, Math.round(r * 0.045))}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.globalAlpha = 0.7;
        ctx.fillText(String(i + 1), x, y);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawMap(ctx: CanvasRenderingContext2D, W: number, H: number) {
    // two azimuthal equal-area hemispheres: the near (z > 0) and far (z < 0) halves
    const twoRows = W < H * 1.2;
    const r = (twoRows ? Math.min(W / 2, H / 4) : Math.min(W / 4, H / 2)) * 0.86;
    const discs = twoRows
      ? [
          { cx: W / 2, cy: H * 0.25, s: 1, label: "near hemisphere" },
          { cx: W / 2, cy: H * 0.73, s: -1, label: "far hemisphere, seen from behind" },
        ]
      : [
          { cx: W * 0.25, cy: H / 2 - r * 0.06, s: 1, label: "near hemisphere" },
          { cx: W * 0.75, cy: H / 2 - r * 0.06, s: -1, label: "far hemisphere, seen from behind" },
        ];
    const text = cssVar("--text");
    for (const d of discs) {
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, r, 0, 2 * Math.PI);
      ctx.fillStyle = cssVar("--space-globe");
      ctx.fill();
      ctx.strokeStyle = cssVar("--muted");
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = cssVar("--muted");
      ctx.font = `${Math.max(10, Math.round(r * 0.07))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(d.label, d.cx, d.cy + r + Math.max(12, r * 0.1));
      const proj = (p: V3): [number, number] => {
        let x = p[0];
        let z = p[2];
        const y = p[1];
        // the far half is seen from behind, so it is not mirrored
        if (d.s < 0) {
          x = -x;
          z = -z;
        }
        // equal-area about +z: radius 2 sin(dist/2), scaled so that the rim (dist = pi/2) is r
        const dist = Math.acos(Math.max(-1, Math.min(1, z)));
        const rr = Math.min(Math.SQRT2, 2 * Math.sin(Math.min(dist, Math.PI / 2) / 2)) / Math.SQRT2;
        const n = Math.hypot(x, y) || 1;
        return [d.cx + (r * rr * x) / n, d.cy - (r * rr * y) / n];
      };
      ctx.save();
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, r, 0, 2 * Math.PI);
      ctx.clip();
      shapes.forEach((s0, i) => {
        const s = clipHemi(
          s0.map((p) => mv(Rv, p)),
          d.s,
        );
        if (!s.length) return;
        path(ctx, s, proj);
        ctx.fillStyle = pieceFill(i, 0.85);
        ctx.fill();
        ctx.strokeStyle = text;
        ctx.lineWidth = 1.1;
        ctx.stroke();
      });
      ctx.restore();
    }
  }

  function redraw() {
    const { ctx, w, h } = fitCanvas(cv);
    if (!config) return;
    if (view === "globe") drawGlobe(ctx, w, h);
    else drawMap(ctx, w, h);
  }

  const stopDrag = onDrag(cv, (dx, dy) => {
    const sc = 3 / Math.max(1, cv.getBoundingClientRect().width);
    Rv = mm(rotAxis([dy, dx, 0], Math.hypot(dx, dy) * sc), Rv);
    redraw();
  });

  return {
    element: cv,
    views: [
      { key: "globe", label: "Globe" },
      { key: "map", label: "Two hemispheres" },
    ],
    get view() {
      return view;
    },
    setView(key) {
      view = key === "map" ? "map" : "globe";
      redraw();
    },
    draw(c: SpaceConfig) {
      config = c as unknown as { rho: number; pieces: { q: Quat }[] };
      shapes = config.pieces.map((p) => boundary(N, config!.rho, p.q));
      centres = config.pieces.map((p) => mv(qmat(p.q), [0, 0, 1]));
      redraw();
    },
    redraw,
    canTurn: () => true,
    turn(dx, dy) {
      Rv = mm(rotAxis([dy, dx, 0], Math.hypot(dx, dy)), Rv);
      redraw();
    },
    reset() {
      Rv = START_VIEW;
      redraw();
    },
    describe() {
      return config
        ? `${piecesText(N, P)} on a sphere of radius ${config.rho.toFixed(6)}, ${view === "globe" ? "drawn as a globe" : "drawn as two hemispheres"}.`
        : "No packing to draw.";
    },
    destroy() {
      stopDrag();
      cv.remove();
    },
  };
}
