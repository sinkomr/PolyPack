/**
 * Drawing of a polyhedra configuration: the container as a wireframe (hidden edges dashed) and the pieces as
 * flat-shaded solids, in an orthographic view that can be turned with the mouse, a finger or the keyboard.
 *
 * Pure parts (sceneOf, renderSVG) build the picture from the problem, the configuration and a view rotation, so a
 * server or a test can use them without a DOM; createPolyhedraView draws on a canvas and handles the input. No
 * external libraries. Painter's algorithm: pieces are drawn back to front by the depth of their centres, each with
 * its front faces only (a convex solid's front faces never overlap each other).
 */
import { quatToR } from "./geom";
import type { PolyhedraProblem } from "./problems";
import { getSolid } from "./solids";
import type { PolyhedraConfig } from "./validate";

export interface DrawPalette {
  background: string;
  /** Front edges of the container. */
  container: string;
  /** Hidden edges of the container. */
  containerHidden: string;
  /** Fill of the container's back faces. */
  containerFill: string;
  /** Edges of the pieces. */
  pieceEdge: string;
  /** Lightness of the pieces' colours, 0 to 100. */
  lightness: number;
  saturation: number;
}

export const LIGHT_PALETTE: DrawPalette = {
  background: "#ffffff",
  container: "#2a2c31",
  containerHidden: "rgba(42,44,49,0.35)",
  containerFill: "rgba(42,44,49,0.04)",
  pieceEdge: "rgba(0,0,0,0.55)",
  lightness: 62,
  saturation: 58,
};

export const DARK_PALETTE: DrawPalette = {
  background: "#1c1f23",
  container: "#d6d8dc",
  containerHidden: "rgba(214,216,220,0.35)",
  containerFill: "rgba(214,216,220,0.05)",
  pieceEdge: "rgba(0,0,0,0.7)",
  lightness: 52,
  saturation: 50,
};

/** A polygon or a line in screen space (x right, y down), with its depth (larger is nearer). */
export interface ScenePolygon {
  pts: [number, number][];
  fill: string | null;
  stroke: string;
  width: number;
  dash: boolean;
  /** Index of the piece, or -1 for the container. */
  piece: number;
  depth: number;
}

export interface SceneOptions {
  /** View rotation as a quaternion [w, x, y, z] (world -> view); default a slightly tilted view. */
  rotation?: [number, number, number, number];
  /** Drawing size in pixels (square); default 400. */
  size?: number;
  /** Zoom factor; default 1 (the container fills about 90 % of the drawing). */
  zoom?: number;
  palette?: DrawPalette;
  /** A piece drawn with a thick outline, or -1. */
  selected?: number;
}

/** The default view: turned 25 degrees about y, then tilted 20 degrees about x. */
export const DEFAULT_ROTATION: [number, number, number, number] = (() => {
  const a = (25 * Math.PI) / 360;
  const b = (-20 * Math.PI) / 360;
  // qx(b) * qy(a)
  const qy = [Math.cos(a), 0, Math.sin(a), 0];
  const qx = [Math.cos(b), Math.sin(b), 0, 0];
  return mulQ(qx as [number, number, number, number], qy as [number, number, number, number]);
})();

export function mulQ(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** Colour of piece i of n: hues spread by the golden angle. */
export function pieceHue(i: number): number {
  return (i * 137.50776405) % 360;
}

const LIGHT_DIR = (() => {
  const v = [-0.45, 0.6, 0.66];
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
})();

/** The scene of a configuration: polygons in drawing order (back to front). */
export function sceneOf(problem: PolyhedraProblem, config: PolyhedraConfig | null, opts: SceneOptions = {}): ScenePolygon[] {
  const size = opts.size ?? 400;
  const pal = opts.palette ?? LIGHT_PALETTE;
  const Rv = quatToR(...(opts.rotation ?? DEFAULT_ROTATION));
  const P = getSolid(problem.piece);
  const C = getSolid(problem.container);
  const s = config && config.s > 0 && Number.isFinite(config.s) ? config.s : 1;
  const reach = s * C.circumradius;
  const k = ((0.45 * size) / reach) * (opts.zoom ?? 1);
  const view = (x: number, y: number, z: number): [number, number, number] => [
    Rv[0] * x + Rv[1] * y + Rv[2] * z,
    Rv[3] * x + Rv[4] * y + Rv[5] * z,
    Rv[6] * x + Rv[7] * y + Rv[8] * z,
  ];
  const screen = (v: [number, number, number]): [number, number] => [size / 2 + k * v[0], size / 2 - k * v[1]];
  const out: ScenePolygon[] = [];
  // container: faces facing away are "back"; an edge is hidden when both of its faces are
  const CV: [number, number, number][] = [];
  for (let i = 0; i < C.nv; i++) CV.push(view(s * C.V[3 * i], s * C.V[3 * i + 1], s * C.V[3 * i + 2]));
  const front = C.faces.map((_, f) => view(C.N[3 * f], C.N[3 * f + 1], C.N[3 * f + 2])[2] > 0);
  const hidden: ScenePolygon[] = [];
  const shown: ScenePolygon[] = [];
  C.faces.forEach((f, fi) => {
    if (!front[fi]) out.push({ pts: f.map((v) => screen(CV[v])), fill: pal.containerFill, stroke: "transparent", width: 0, dash: false, piece: -1, depth: -Infinity });
  });
  C.edges.forEach(([a, b], e) => {
    const [f1, f2] = C.edgeFaces[e];
    const line: ScenePolygon = {
      pts: [screen(CV[a]), screen(CV[b])],
      fill: null,
      stroke: front[f1] || front[f2] ? pal.container : pal.containerHidden,
      width: front[f1] || front[f2] ? 1.6 : 1,
      dash: !(front[f1] || front[f2]),
      piece: -1,
      depth: (CV[a][2] + CV[b][2]) / 2,
    };
    (front[f1] || front[f2] ? shown : hidden).push(line);
  });
  out.push(...hidden);
  // pieces, back to front by the depth of their centres
  const pieces = (config?.pieces ?? []).map((p, i) => ({ p, i, z: view(p[0], p[1], p[2])[2] }));
  pieces.sort((a, b) => a.z - b.z);
  for (const { p, i, z } of pieces) {
    let R: Float64Array;
    try {
      R = quatToR(p[3], p[4], p[5], p[6]);
    } catch {
      continue;
    }
    const X: [number, number, number][] = [];
    for (let v = 0; v < P.nv; v++) {
      const a = P.V[3 * v];
      const b = P.V[3 * v + 1];
      const c = P.V[3 * v + 2];
      X.push(
        view(
          p[0] + R[0] * a + R[1] * b + R[2] * c,
          p[1] + R[3] * a + R[4] * b + R[5] * c,
          p[2] + R[6] * a + R[7] * b + R[8] * c,
        ),
      );
    }
    const hue = pieceHue(i);
    P.faces.forEach((f, fi) => {
      const a = P.N[3 * fi];
      const b = P.N[3 * fi + 1];
      const c = P.N[3 * fi + 2];
      const n = view(R[0] * a + R[1] * b + R[2] * c, R[3] * a + R[4] * b + R[5] * c, R[6] * a + R[7] * b + R[8] * c);
      if (n[2] <= 0) return;
      const lam = 0.55 + 0.45 * Math.max(0, n[0] * LIGHT_DIR[0] + n[1] * LIGHT_DIR[1] + n[2] * LIGHT_DIR[2]);
      const light = Math.round(pal.lightness * lam * 10) / 10;
      out.push({
        pts: f.map((v) => screen(X[v])),
        fill: `hsl(${hue.toFixed(1)} ${pal.saturation}% ${light}%)`,
        stroke: pal.pieceEdge,
        width: i === opts.selected ? 2.5 : 0.8,
        dash: false,
        piece: i,
        depth: z,
      });
    });
  }
  out.push(...shown);
  return out;
}

/** The scene as a standalone SVG document. */
export function renderSVG(problem: PolyhedraProblem, config: PolyhedraConfig | null, opts: SceneOptions = {}): string {
  const size = opts.size ?? 400;
  const pal = opts.palette ?? LIGHT_PALETTE;
  const r = (x: number) => Math.round(x * 100) / 100;
  const parts = sceneOf(problem, config, opts).map((q) => {
    const d = q.pts.map(([x, y], i) => `${i ? "L" : "M"}${r(x)} ${r(y)}`).join("") + (q.fill ? "Z" : "");
    return `<path d="${d}" fill="${q.fill ?? "none"}" stroke="${q.stroke}" stroke-width="${q.width}"${q.dash ? ' stroke-dasharray="4 3"' : ""} stroke-linejoin="round"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="100%" height="100%" fill="${pal.background}"/>${parts.join("")}</svg>`;
}

/** True when (x, y) lies inside the convex polygon. */
function inside(pts: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign && Math.sign(c) !== sign) return false;
      sign = Math.sign(c);
    }
  }
  return true;
}

export interface PolyhedraView {
  setConfig(problem: PolyhedraProblem, config: PolyhedraConfig | null): void;
  setPalette(palette: DrawPalette): void;
  setRotation(q: [number, number, number, number]): void;
  getRotation(): [number, number, number, number];
  setSelected(i: number): void;
  /** The piece drawn at canvas point (x, y) in CSS pixels, or -1. */
  pick(x: number, y: number): number;
  /** Turns slowly until the user drags (true) or stops (false). */
  setSpin(on: boolean): void;
  /** Redraws at the canvas' current CSS size. */
  redraw(): void;
  destroy(): void;
}

export interface ViewOptions {
  palette?: DrawPalette;
  rotation?: [number, number, number, number];
  spin?: boolean;
  /** Called when the user clicks a piece (or -1 for none). */
  onPick?: (i: number) => void;
}

/** A turnable view on a canvas element: drag or arrow keys turn it, the wheel or a pinch zooms, a double click resets. */
export function createPolyhedraView(canvas: HTMLCanvasElement, opts: ViewOptions = {}): PolyhedraView {
  let problem: PolyhedraProblem | null = null;
  let config: PolyhedraConfig | null = null;
  let palette = opts.palette ?? LIGHT_PALETTE;
  let rot: [number, number, number, number] = opts.rotation ?? DEFAULT_ROTATION;
  let zoom = 1;
  let selected = -1;
  let spin = opts.spin ?? false;
  let scene: ScenePolygon[] = [];
  let cssSize = 0;
  let frame = 0;
  let last = 0;
  const ctx = canvas.getContext("2d");
  if (!canvas.hasAttribute("tabindex")) canvas.tabIndex = 0;

  const turn = (ax: number, ay: number, az: number, angle: number) => {
    const l = Math.hypot(ax, ay, az);
    if (!(l > 0) || !angle) return;
    const h = angle / 2;
    const q: [number, number, number, number] = [Math.cos(h), (Math.sin(h) * ax) / l, (Math.sin(h) * ay) / l, (Math.sin(h) * az) / l];
    rot = mulQ(q, rot);
    const m = Math.hypot(...rot);
    rot = rot.map((x) => x / m) as [number, number, number, number];
  };

  const draw = () => {
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    cssSize = Math.max(1, Math.min(rect.width || canvas.width, rect.height || rect.width || canvas.height));
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const px = Math.round(cssSize * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, cssSize, cssSize);
    if (!problem) return;
    scene = sceneOf(problem, config, { rotation: rot, size: cssSize, zoom, palette, selected });
    ctx.lineJoin = "round";
    for (const q of scene) {
      ctx.beginPath();
      q.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (q.fill) {
        ctx.closePath();
        ctx.fillStyle = q.fill;
        ctx.fill();
      }
      if (q.width > 0) {
        ctx.setLineDash(q.dash ? [4, 3] : []);
        ctx.strokeStyle = q.stroke;
        ctx.lineWidth = q.width;
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  };

  const tick = (t: number) => {
    frame = 0;
    if (spin) {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
      turn(0, 1, 0, 0.35 * dt);
      last = t;
      draw();
      frame = requestAnimationFrame(tick);
    } else last = 0;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const redraw = () => {
    if (spin) schedule();
    else draw();
  };

  // pointer input: one pointer turns, two pinch
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  let moved = false;
  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onMove = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
    if (pointers.size === 1) {
      spin = false;
      // screen y points down; dragging right turns about the view's y axis
      turn(dy, dx, 0, Math.hypot(dx, dy) * 0.01);
      draw();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0) zoom = Math.min(8, Math.max(0.3, (zoom * d) / pinch));
      pinch = d;
      draw();
    }
  };
  const onUp = (e: PointerEvent) => {
    if (pointers.size === 1 && !moved && opts.onPick) {
      const r = canvas.getBoundingClientRect();
      opts.onPick(view.pick(e.clientX - r.left, e.clientY - r.top));
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoom = Math.min(8, Math.max(0.3, zoom * Math.exp(-e.deltaY * 0.0015)));
    draw();
  };
  const onDbl = () => {
    rot = opts.rotation ?? DEFAULT_ROTATION;
    zoom = 1;
    draw();
  };
  const onKey = (e: KeyboardEvent) => {
    const step = 0.12;
    const keys: Record<string, [number, number, number]> = {
      ArrowLeft: [0, -1, 0],
      ArrowRight: [0, 1, 0],
      ArrowUp: [-1, 0, 0],
      ArrowDown: [1, 0, 0],
    };
    if (keys[e.key]) {
      e.preventDefault();
      spin = false;
      turn(...keys[e.key], step);
      draw();
    } else if (e.key === "+" || e.key === "=") {
      zoom = Math.min(8, zoom * 1.15);
      draw();
    } else if (e.key === "-") {
      zoom = Math.max(0.3, zoom / 1.15);
      draw();
    } else if (e.key === "0") onDbl();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDbl);
  canvas.addEventListener("keydown", onKey);
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => redraw()) : null;
  ro?.observe(canvas);

  const view: PolyhedraView = {
    setConfig(p, c) {
      problem = p;
      config = c;
      redraw();
    },
    setPalette(p) {
      palette = p;
      redraw();
    },
    setRotation(q) {
      const m = Math.hypot(...q);
      if (m > 0) rot = q.map((x) => x / m) as [number, number, number, number];
      redraw();
    },
    getRotation: () => [...rot] as [number, number, number, number],
    setSelected(i) {
      selected = i;
      redraw();
    },
    pick(x, y) {
      for (let k = scene.length - 1; k >= 0; k--) {
        const q = scene[k];
        if (q.piece >= 0 && q.fill && inside(q.pts, x, y)) return q.piece;
      }
      return -1;
    },
    setSpin(on) {
      spin = on;
      redraw();
    },
    redraw,
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("keydown", onKey);
    },
  };
  return view;
}
