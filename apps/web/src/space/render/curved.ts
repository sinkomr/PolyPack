/**
 * Drawing of a packing at constant curvature K (curved/<K>/<N>/<M>/<P>), ported from
 * packages/curved/viz/template.html. The container is centred at the origin O with a horizontal
 * bottom edge; a piece's pose {x, y, theta} puts its centre at geodesic distance sqrt(x^2 + y^2)
 * from O in direction (x, y), turned by theta relative to the frame carried from O.
 *
 * Points are homogeneous vectors v = (v0, v1, v2) with v0^2 + K |(v1, v2)|^2 = 1, in which
 * geodesics are straight lines of the projective chart. Models:
 *  - K < 0: the Poincaré disk (conformal) and the Klein disk (geodesics straight); the unit circle
 *    is the ideal boundary, and for a polygon container the dashed ideal polygon is the largest
 *    container of its shape;
 *  - K > 0: a globe of radius 1/sqrt(K) seen from outside, turned by dragging (or the arrow
 *    keys) about its vertical and horizontal axes, and the gnomonic chart (geodesics straight);
 *  - |K| < 1e-3: the plane.
 */
import type { SpaceConfig } from "@polypack/spaces";
import { SVG_NS, type SpaceRenderer, onDrag, pieceFill, piecesText } from "./common";

type H3 = [number, number, number];
type Pose = { x: number; y: number; theta: number };

// ---- functions uniform in K (series near t = K x^2 = 0) ----
function S(t: number): number {
  if (Math.abs(t) < 1e-8) return 1 - t / 6;
  const r = Math.sqrt(Math.abs(t));
  return t > 0 ? Math.sin(r) / r : Math.sinh(r) / r;
}
function Vf(t: number): number {
  if (Math.abs(t) < 1e-8) return 0.5 - t / 24;
  const r = Math.sqrt(Math.abs(t));
  return t > 0 ? (2 * Math.sin(r / 2) ** 2) / t : (2 * Math.sinh(r / 2) ** 2) / -t;
}
/** cos and sin of a geodesic length at curvature K (cosh, sinh for K < 0, scaled so that sn ~ x). */
const cs = (K: number, x: number) => 1 - K * x * x * Vf(K * x * x);
const sn = (K: number, x: number) => x * S(K * x * x);
function asn(K: number, y: number): number {
  if (K > 0) {
    const r = Math.sqrt(K);
    return Math.asin(Math.max(-1, Math.min(1, r * y))) / r;
  }
  if (K < 0) {
    const r = Math.sqrt(-K);
    return Math.asinh(r * y) / r;
  }
  return y;
}

/** The point v of the standard piece frame moved by the pose (the translation along the geodesic from O). */
function poseApply(K: number, p: Pose, v: H3): H3 {
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  const w0 = v[0];
  const w1 = c * v[1] - s * v[2];
  const w2 = s * v[1] + c * v[2];
  const D2 = p.x * p.x + p.y * p.y;
  const t = K * D2;
  const Sv = S(t);
  const V = Vf(t);
  const C = 1 - K * D2 * V;
  const dot = p.x * w1 + p.y * w2;
  return [C * w0 - K * Sv * dot, Sv * p.x * w0 + w1 - K * V * dot * p.x, Sv * p.y * w0 + w2 - K * V * dot * p.y];
}
const polar = (K: number, r: number, a: number): H3 => [cs(K, r), sn(K, r) * Math.cos(a), sn(K, r) * Math.sin(a)];
function norm(K: number, v: H3): H3 {
  const q = Math.sqrt(v[0] * v[0] + K * (v[1] * v[1] + v[2] * v[2]));
  return [v[0] / q, v[1] / q, v[2] / q];
}
/** A geodesic segment: straight in the projective chart. */
function segment(K: number, a: H3, b: H3, n: number): H3[] {
  const out: H3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(norm(K, [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t]));
  }
  return out;
}

function pieceOutline(K: number, N: number, pose: Pose): H3[] {
  if (N === 0) {
    const pts: H3[] = [];
    for (let i = 0; i < 96; i++) pts.push(poseApply(K, pose, polar(K, 1, (2 * Math.PI * i) / 96)));
    return pts;
  }
  // circumradius R of a regular N-gon of geodesic side 1: sn(R) sin(pi/N) = sn(1/2)
  const R = asn(K, sn(K, 0.5) / Math.sin(Math.PI / N));
  const vs: H3[] = [];
  for (let k = 0; k < N; k++) vs.push(poseApply(K, pose, polar(K, R, Math.PI / 2 + (2 * Math.PI * k) / N)));
  let pts: H3[] = [];
  for (let k = 0; k < N; k++) pts = pts.concat(segment(K, vs[k], vs[(k + 1) % N], 24).slice(0, -1));
  return pts;
}

function containerOutline(K: number, M: number, size: number, ideal: boolean): H3[] {
  if (M === 0) {
    const pts: H3[] = [];
    for (let i = 0; i < 160; i++) pts.push(polar(K, size, (2 * Math.PI * i) / 160));
    return pts;
  }
  const vs: H3[] = [];
  if (ideal) {
    // ideal vertices sit on the boundary of the Klein disk (chart radius 1/sqrt(-K)); pulled in slightly
    const k = 0.9999995 / Math.sqrt(-K);
    for (let j = 0; j < M; j++) {
      const a = -Math.PI / 2 + Math.PI / M + (2 * Math.PI * j) / M;
      vs.push([1, k * Math.cos(a), k * Math.sin(a)]);
    }
  } else {
    const R = asn(K, sn(K, size / 2) / Math.sin(Math.PI / M));
    for (let k = 0; k < M; k++) vs.push(polar(K, R, -Math.PI / 2 + Math.PI / M + (2 * Math.PI * k) / M));
  }
  let pts: H3[] = [];
  for (let j = 0; j < M; j++) pts = pts.concat(segment(K, vs[j], vs[(j + 1) % M], ideal ? 200 : 64).slice(0, -1));
  return pts;
}

interface Model {
  label: string;
  ok: (K: number) => boolean;
  /** To the plane; a third coordinate z < 0 marks the far side of the globe. */
  map: (K: number, v: H3, tilt: number, spin: number) => [number, number, number?];
  /** True when the model fills the unit disk; otherwise the drawing is scaled to the container. */
  unit: boolean;
}

const MODELS: Record<string, Model> = {
  flat: { label: "Plane", ok: (K) => Math.abs(K) < 1e-3, map: (_K, v) => [v[1] / v[0], v[2] / v[0]], unit: false },
  poincare: {
    label: "Poincaré disk",
    ok: (K) => K < 0,
    map: (K, v) => {
      const k = Math.sqrt(-K);
      const q = Math.sqrt(Math.max(1e-300, v[0] * v[0] + K * (v[1] * v[1] + v[2] * v[2])));
      const x0 = v[0] / q;
      return [(k * v[1]) / q / (1 + x0), (k * v[2]) / q / (1 + x0)];
    },
    unit: true,
  },
  klein: {
    label: "Klein disk",
    ok: (K) => K < 0,
    map: (K, v) => {
      const k = Math.sqrt(-K);
      return [(k * v[1]) / v[0], (k * v[2]) / v[0]];
    },
    unit: true,
  },
  globe: {
    label: "Globe",
    ok: (K) => K > 0,
    map: (K, v, tilt, spin) => {
      const k = Math.sqrt(K);
      const u = norm(K, v);
      // X0 points at the viewer: spin turns about the screen's vertical axis, then tilt about its horizontal one
      const cp = Math.cos(spin);
      const sp = Math.sin(spin);
      const X = [u[0] * cp + k * u[1] * sp, k * u[1] * cp - u[0] * sp, k * u[2]];
      const ct = Math.cos(tilt);
      const st = Math.sin(tilt);
      return [X[1], X[2] * ct - X[0] * st, X[2] * st + X[0] * ct];
    },
    unit: true,
  },
  gnomonic: { label: "Gnomonic chart", ok: (K) => K > 0, map: (_K, v) => [v[1] / v[0], v[2] / v[0]], unit: false },
};

const pathOf = (pts: [number, number, number?][]) =>
  "M" + pts.map((p) => p[0].toFixed(5) + "," + (-p[1]).toFixed(5)).join("L") + "Z";

export function curvedRenderer(K: number, N: number, M: number, P: number): SpaceRenderer {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "-1.08 -1.08 2.16 2.16");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const views = Object.entries(MODELS)
    .filter(([, m]) => m.ok(K))
    .map(([key, m]) => ({ key, label: m.label }));
  let view = views[0].key;
  let tilt = 0;
  let spin = 0;
  const MAX_TILT = (80 * Math.PI) / 180;
  const turnBy = (dx: number, dy: number) => {
    spin = (spin + dx) % (2 * Math.PI);
    tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, tilt + dy));
  };
  let config: { size: number; pieces: Pose[] } | null = null;

  function redraw() {
    if (!config) {
      svg.replaceChildren();
      return;
    }
    const m = MODELS[view];
    const map = (v: H3) => m.map(K, v, tilt, spin);
    const cont = containerOutline(K, M, config.size, false).map(map);
    const pieces = config.pieces.map((p) => pieceOutline(K, N, p).map(map));
    let scale = 1;
    if (!m.unit) {
      let ext = 0;
      for (const p of cont) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
      scale = 1 / ext;
    }
    const sc = (pts: [number, number, number?][]) =>
      pts.map((p) => [p[0] * scale, p[1] * scale, p[2]] as [number, number, number?]);
    let html = "";
    if (m.unit) html += `<circle cx="0" cy="0" r="1" fill="none" stroke="var(--space-ideal)" stroke-width="0.004"/>`;
    if (K < 0 && M > 0 && m.unit)
      html += `<path d="${pathOf(containerOutline(K, M, 0, true).map(map))}" fill="none" stroke="var(--space-ideal)" stroke-width="0.004" stroke-dasharray="0.02 0.015"/>`;
    html += `<path d="${pathOf(sc(cont))}" fill="none" stroke="var(--container)" stroke-width="0.008"/>`;
    pieces.forEach((pp, i) => {
      const q = sc(pp);
      const far = view === "globe" && q.some((p) => (p[2] ?? 0) < 0);
      html += `<path d="${pathOf(q)}" fill="${pieceFill(i, 0.75)}" stroke="var(--piece-stroke)" stroke-width="0.005"${far ? ' opacity="0.35"' : ""}/>`;
    });
    // only numbers and fixed strings go into the markup
    svg.innerHTML = html;
  }

  const stopDrag = onDrag(svg, (dx, dy) => {
    if (view !== "globe") return;
    turnBy(dx * 0.01, dy * 0.01);
    redraw();
  });

  return {
    element: svg,
    views,
    get view() {
      return view;
    },
    setView(key) {
      if (views.some((v) => v.key === key)) view = key;
      redraw();
    },
    draw(c: SpaceConfig) {
      config = c as unknown as { size: number; pieces: Pose[] };
      redraw();
    },
    redraw,
    canTurn: () => view === "globe",
    turn(dx, dy) {
      if (view !== "globe") return;
      turnBy(dx, dy);
      redraw();
    },
    reset() {
      tilt = 0;
      spin = 0;
      redraw();
    },
    describe() {
      if (!config) return "No packing to draw.";
      const where = K < 0 ? "the hyperbolic plane" : K > 0 ? "a sphere" : "the plane";
      const box =
        M === 0 ? `a disk of radius ${config.size.toFixed(6)}` : `a regular ${M}-gon of side ${config.size.toFixed(6)}`;
      return `${piecesText(N, P)} in ${box} on ${where} of curvature ${K}, drawn in the ${MODELS[view].label.toLowerCase()}.`;
    },
    destroy() {
      stopDrag();
      svg.remove();
    },
  };
}
