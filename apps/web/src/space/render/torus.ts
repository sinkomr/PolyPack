/**
 * Drawing of a packing on a flat torus (torus/<family>/<N>/<P>), ported from
 * packages/torus/viz/build.ts. Three drawings of the same packing:
 *  - "Tiled plane": copies of the fundamental cell around the central one, which is outlined;
 *    every lattice translate of a piece has the piece's colour;
 *  - "One cell": the fundamental cell alone; the parts of pieces that leave it come back on the
 *    opposite side (drawn lighter), and arrows mark which sides are glued;
 *  - "3D torus": the cell rolled up into a ring in space, drawn with three.js (loaded when the view is
 *    first chosen) on a canvas beside the svg, and turned by drag or the arrow keys. A flat torus cannot
 *    be rolled up in 3D without stretching, so its lengths are not true: the cell's longer side runs round
 *    the ring and the other round the tube (a slanted cell is sheared), and the seams where the cell's sides
 *    are glued are drawn.
 * The layout (torus-layout.ts) reduces the basis first, so a skewed basis draws as fast as any.
 */
import type * as T from "three";
import { DISK_RADIUS, circumradius } from "@polypack/geometry";
import type { SpaceConfig } from "@polypack/spaces";
import { type SearchProblem, torusPackingOf } from "@polypack/spaces/search";
import { SVG_NS, type SpaceRenderer, cssVar, fitCanvas, isDark, onDrag, piecesText } from "./common";
import { torusLayout, torusTexture } from "./torus-layout";

type Three = typeof import("three");
type Quat = [number, number, number, number];
type V2 = readonly [number, number];

/** Drawings made, for clip path ids that differ between drawings on one page. */
let drawings = 0;

/** The 3D torus's texture in pixels: x round the ring, y round the tube. */
const TEX_W = 2048;
const TEX_H = 1024;
/** The tube's radius as a share of the ring's: the cell's side ratio, kept between these so that the ring keeps its hole. */
const TUBE_MIN = 0.22;
const TUBE_MAX = 0.42;
/** The 3D torus's first view: tipped back 1 radian from face on, so that the hole and the tube both show. */
const START: Quat = [Math.sin(-0.5), 0, 0, Math.cos(-0.5)];

const add = (a: V2, B: readonly [V2, V2], m: number, n: number): [number, number] => [
  a[0] + m * B[0][0] + n * B[1][0],
  a[1] + m * B[0][1] + n * B[1][1],
];

/** The parallelogram {s b1 + t b2 : s, t in [s0, s1]} as an SVG path (y flipped). */
function para(B: readonly [V2, V2], s0: number, s1: number): string {
  const c = (
    [
      [s0, s0],
      [s1, s0],
      [s1, s1],
      [s0, s1],
    ] as V2[]
  ).map(([s, t]) => {
    const p = add([0, 0], B, s, t);
    return p[0].toFixed(4) + "," + (-p[1]).toFixed(4);
  });
  return "M" + c.join("L") + "Z";
}

export function torusRenderer(problem: SearchProblem & { space: "torus" }): SpaceRenderer {
  const { N, P, family } = problem;
  const R = N === 0 ? DISK_RADIUS : circumradius(N);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const clipId = `torus-clip-${++drawings}`;
  let view = "tile";
  let packing: ReturnType<typeof torusPackingOf> | null = null;
  let score = 0;
  /** Why the lattice is not drawn, or null. */
  let refused: string | null = null;

  // one hue per orbit; ghosts (outside the cell in the one-cell view) lighter
  const fill = (i: number, ghost: boolean) => {
    const h = ((i * 360) / P + 20) % 360;
    const l = isDark() ? (ghost ? 30 : 48) : ghost ? 78 : 58;
    return `hsl(${h.toFixed(1)} 62% ${l}% / ${ghost ? 0.55 : 0.92})`;
  };
  const piece = (x: number, y: number, th: number, color: string, sw: string) => {
    if (N === 0)
      return `<circle cx="${x.toFixed(4)}" cy="${(-y).toFixed(4)}" r="${DISK_RADIUS}" fill="${color}" stroke="var(--panel)" stroke-width="${sw}"/>`;
    const pts: string[] = [];
    for (let k = 0; k < N; k++) {
      const a = th + Math.PI / 2 + (2 * Math.PI * k) / N;
      pts.push((x + R * Math.cos(a)).toFixed(4) + "," + (-(y + R * Math.sin(a))).toFixed(4));
    }
    return `<polygon points="${pts.join(" ")}" fill="${color}" stroke="var(--panel)" stroke-width="${sw}"/>`;
  };

  // the 3D torus: made when the view is first chosen, given back by destroy()
  let cv: HTMLCanvasElement | null = null;
  let THREE: Three | null = null;
  let failed = false;
  let lost = false;
  let destroyed = false;
  let gl: T.WebGLRenderer | null = null;
  let scene: T.Scene | null = null;
  let camera: T.PerspectiveCamera | null = null;
  let mesh: T.Mesh | null = null;
  let material: T.MeshLambertMaterial | null = null;
  let texture: T.CanvasTexture | null = null;
  let paint: HTMLCanvasElement | null = null;
  let tubeRadius = TUBE_MAX;
  let builtFor: unknown = null;
  let builtDark: boolean | null = null;
  let quat: Quat = [...START];
  let offDrag: (() => void) | null = null;
  const shows3d = () => view === "3d" && packing !== null && refused === null;

  function setup(T3: Three) {
    try {
      gl = new T3.WebGLRenderer({ canvas: cv!, antialias: true, alpha: true });
    } catch {
      failed = true;
      return;
    }
    gl.setClearColor(0x000000, 0);
    scene = new T3.Scene();
    camera = new T3.PerspectiveCamera(30, 1, 0.01, 100);
    // the light turns with the viewer: from the upper left, in front
    camera.add(new T3.AmbientLight(0xffffff, 1.4));
    const sun = new T3.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-0.45, 0.6, 0.66);
    camera.add(sun);
    scene.add(camera);
    paint = document.createElement("canvas");
    paint.width = TEX_W;
    paint.height = TEX_H;
    texture = new T3.CanvasTexture(paint);
    texture.colorSpace = T3.SRGBColorSpace;
    texture.anisotropy = gl.capabilities.getMaxAnisotropy();
    material = new T3.MeshLambertMaterial({ map: texture });
  }

  /** Paints the cell into the texture: every piece and its eight neighbouring translates, then the seams. */
  function paintCell(B: readonly [V2, V2]) {
    const ctx = paint!.getContext("2d")!;
    const { ring, tube, m } = torusTexture(B, TEX_W, TEX_H);
    const dark = isDark();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar("--space-face") || (dark ? "#2a2c31" : "#ece8df");
    ctx.fillRect(0, 0, TEX_W, TEX_H);
    ctx.setTransform(...m);
    const det = ring[0] * tube[1] - ring[1] * tube[0];
    // about one and a half pixels in the plane's units (the map stretches unevenly)
    ctx.lineWidth = 1.5 * Math.sqrt(det / (TEX_W * TEX_H));
    ctx.strokeStyle = cssVar("--panel") || (dark ? "#1d1f23" : "#ffffff");
    packing!.poses.forEach((q, i) => {
      // the centre on (ring, tube), brought into the cell; a reduced cell is wider than a piece, so the
      // neighbouring translates hold every part that leaves it
      let s = (q.x * tube[1] - q.y * tube[0]) / det;
      let t = (ring[0] * q.y - ring[1] * q.x) / det;
      s -= Math.floor(s);
      t -= Math.floor(t);
      ctx.fillStyle = fill(i, false);
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++) {
          const x = (s + a) * ring[0] + (t + b) * tube[0];
          const y = (s + a) * ring[1] + (t + b) * tube[1];
          ctx.beginPath();
          if (N === 0) ctx.arc(x, y, DISK_RADIUS, 0, 2 * Math.PI);
          else
            for (let k = 0; k < N; k++) {
              const ang = q.theta + Math.PI / 2 + (2 * Math.PI * k) / N;
              ctx.lineTo(x + R * Math.cos(ang), y + R * Math.sin(ang));
            }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
    });
    // the seams: the texture's edges, where the cell's opposite sides are glued
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = cssVar("--accent") || "#b4532a";
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, TEX_W, TEX_H);
    return { ring, tube };
  }

  /** The ring of the current packing, made again only when the packing or the scheme changes. */
  function build(T3: Three) {
    const dark = isDark();
    if (builtFor === packing && builtDark === dark) return;
    const layout = torusLayout(packing!.lattice, [], R, false);
    if (typeof layout === "string") return;
    const { ring, tube } = paintCell(layout.basis);
    texture!.needsUpdate = true;
    const r = Math.min(TUBE_MAX, Math.max(TUBE_MIN, Math.hypot(...tube) / Math.hypot(...ring)));
    if (!mesh || r !== tubeRadius) {
      if (mesh) {
        scene!.remove(mesh);
        mesh.geometry.dispose();
      }
      tubeRadius = r;
      mesh = new T3.Mesh(new T3.TorusGeometry(1, r, 64, 256), material!);
      scene!.add(mesh);
    }
    builtFor = packing;
    builtDark = dark;
  }

  function sayNoWebGL() {
    const { ctx, w, h } = fitCanvas(cv!);
    ctx.fillStyle = cssVar("--muted") || "#666";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "center";
    const lines = [
      "This drawing needs WebGL, which this browser does not offer.",
      "The values and the search work without it.",
    ];
    lines.forEach((t, k) => ctx.fillText(t, w / 2, h / 2 + (k - 0.5) * 20, w - 16));
  }

  function render3d() {
    if (!cv || destroyed) return;
    if (failed) {
      sayNoWebGL();
      return;
    }
    const T3 = THREE;
    if (!T3 || !gl || !scene || !camera || !shows3d() || lost) return;
    build(T3);
    if (!mesh) return;
    const w = Math.max(1, cv.clientWidth);
    const h = Math.max(1, cv.clientHeight);
    gl.setPixelRatio(window.devicePixelRatio || 1);
    gl.setSize(w, h, false);
    // the whole ring in view, whatever its turn: a sphere of radius 1 + r
    const rad = 1 + tubeRadius;
    const fov = (camera.fov * Math.PI) / 180;
    const fit = Math.min(1, w / h);
    const d = (1.12 * rad) / Math.sin(Math.atan(Math.tan(fov / 2) * fit));
    camera.aspect = w / h;
    camera.near = Math.max(1e-3, d - 2 * rad);
    camera.far = d + 2 * rad;
    camera.position.set(0, 0, d);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    mesh.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    gl.render(scene, camera);
    // frames drawn, for the browser tests
    cv.dataset.frames = String(Number(cv.dataset.frames ?? 0) + 1);
  }

  const onLost = () => {
    if (destroyed) return;
    lost = true;
  };
  const onRestored = () => {
    if (destroyed) return;
    lost = false;
    builtFor = null;
    render3d();
  };

  /** The canvas of the 3D torus beside the svg, and three.js, the first time the view is chosen. */
  function make3d() {
    if (cv) return;
    cv = document.createElement("canvas");
    svg.after(cv);
    cv.addEventListener("webglcontextlost", onLost);
    cv.addEventListener("webglcontextrestored", onRestored);
    offDrag = onDrag(cv, (dx, dy) => {
      if (shows3d() && !failed) turn(dx * 0.01, dy * 0.01);
    });
    void import("three")
      .then((T3) => {
        if (destroyed) return;
        THREE = T3;
        setup(T3);
        redraw();
      })
      .catch(() => {
        failed = true;
        redraw();
      });
  }

  /** Turns the ring by angles about the view's y axis (dx) and x axis (dy). */
  function turn(dx: number, dy: number) {
    const h1 = dx / 2;
    const h2 = dy / 2;
    const qy: Quat = [0, Math.sin(h1), 0, Math.cos(h1)];
    const qx: Quat = [Math.sin(h2), 0, 0, Math.cos(h2)];
    const mul = (a: number[], b: number[]): Quat => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    quat = mul(qx, mul(qy, quat));
    const n = Math.hypot(...quat);
    quat = quat.map((v) => v / n) as Quat;
    render3d();
  }

  function redraw() {
    // the 3D torus on its canvas, or the svg (which also says why a lattice is not drawn)
    const three = shows3d();
    svg.style.display = three ? "none" : "";
    if (cv) cv.style.display = three ? "" : "none";
    if (three) {
      render3d();
      return;
    }
    const layout = packing && !refused ? torusLayout(packing.lattice, packing.poses, R, view === "tile") : refused;
    if (layout === null) {
      svg.replaceChildren();
      return;
    }
    if (typeof layout === "string") {
      // a lattice that cannot be drawn says why, in the drawing
      svg.setAttribute("viewBox", "0 0 800 100");
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", "400");
      text.setAttribute("y", "50");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", "var(--text)");
      text.setAttribute("font-size", "14");
      text.textContent = layout;
      svg.replaceChildren(text);
      return;
    }
    const B = layout.basis;
    const tile = view === "tile";
    const { x0, x1, y0, y1 } = layout;
    const pad = tile ? 0 : R * 0.15 + 0.3;
    const vb = [x0 - pad, -y1 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
    const sw = (vb[2] / 600).toFixed(4);
    const clip = tile
      ? `M${x0.toFixed(4)},${(-y1).toFixed(4)}H${x1.toFixed(4)}V${(-y0).toFixed(4)}H${x0.toFixed(4)}Z`
      : para(B, 0, 1);
    let s = `<defs><clipPath id="${clipId}"><path d="${clip}"/></clipPath></defs>`;
    let body = "";
    for (const q of layout.pieces) body += piece(q.x, q.y, q.theta, fill(q.orbit, q.ghost), sw);
    let cells = "";
    for (const o of layout.cells)
      cells += `<path d="${para(B, 0, 1)}" transform="translate(${o[0].toFixed(4)} ${(-o[1]).toFixed(4)})" fill="none" stroke="var(--text)" stroke-opacity="0.3" stroke-width="${sw}"/>`;
    s += `<g clip-path="url(#${clipId})">${body}${cells}</g>`;
    s += `<path d="${para(B, 0, 1)}" fill="none" stroke="var(--text)" stroke-width="${(3 * Number(sw)).toFixed(4)}"/>`;
    if (!tile) {
      // one arrow on the b1 sides, two on the b2 sides: opposite sides are glued
      const h = 0.12 * Math.min(Math.hypot(...B[0]), Math.hypot(...B[1]));
      const arrow = (p0: V2, v: V2, k: number) => {
        let out = "";
        const len = Math.hypot(v[0], v[1]);
        const ux = v[0] / len;
        const uy = v[1] / len;
        for (let q = 0; q < k; q++) {
          const f = 0.5 + (q - (k - 1) / 2) * 0.05;
          const x = p0[0] + f * v[0];
          const y = p0[1] + f * v[1];
          out += `<path d="M${(x - h * ux - h * 0.6 * uy).toFixed(4)},${(-(y - h * uy + h * 0.6 * ux)).toFixed(4)}L${x.toFixed(4)},${(-y).toFixed(4)}L${(x - h * ux + h * 0.6 * uy).toFixed(4)},${(-(y - h * uy - h * 0.6 * ux)).toFixed(4)}" fill="none" stroke="var(--accent)" stroke-width="${(3 * Number(sw)).toFixed(4)}"/>`;
        }
        return out;
      };
      s += arrow([0, 0], B[0], 1) + arrow(B[1], B[0], 1) + arrow([0, 0], B[1], 2) + arrow(B[0], B[1], 2);
    }
    svg.setAttribute("viewBox", vb.map((v) => v.toFixed(4)).join(" "));
    // only numbers and fixed strings go into the markup
    svg.innerHTML = s;
  }

  return {
    element: svg,
    // once the 3D torus holds a WebGL context, the board gives it back while it shows another kind
    get releaseOnLeave() {
      return gl !== null;
    },
    views: [
      { key: "tile", label: "Tiled plane" },
      { key: "cell", label: "One cell" },
      { key: "3d", label: "3D torus" },
    ],
    get view() {
      return view;
    },
    setView(key) {
      view = key === "cell" || key === "3d" ? key : "tile";
      if (view === "3d") make3d();
      redraw();
    },
    draw(c: SpaceConfig) {
      packing = torusPackingOf(problem, c);
      const l = packing.lattice;
      score =
        family === "free" ? Math.sqrt(Math.abs(l.b1[0] * l.b2[1] - l.b1[1] * l.b2[0])) : Math.hypot(l.b1[0], l.b1[1]);
      // a lattice that cannot be drawn (degenerate, far too small) is said so instead
      const check = torusLayout(packing.lattice, [], R, false);
      refused = typeof check === "string" ? check : null;
      redraw();
    },
    redraw,
    canTurn: () => shows3d() && !failed && !lost,
    turn,
    reset() {
      quat = [...START];
      render3d();
    },
    describe() {
      if (!packing) return "No packing to draw.";
      if (refused) return refused;
      if (view === "3d" && failed) return "This drawing needs WebGL, which this browser does not offer.";
      if (view === "3d" && lost)
        return "The browser has taken this drawing's graphics context away; it is drawn again when the context comes back.";
      const torus =
        family === "sq"
          ? "a square torus of side"
          : family === "hex"
            ? "a hexagonal torus of side"
            : "a torus of cell √area";
      const how =
        view === "tile"
          ? "drawn as the tiled plane"
          : view === "cell"
            ? "drawn as one cell"
            : "drawn as a 3D torus, the cell rolled up into a ring (which stretches its lengths)";
      return `${piecesText(N, P)} on ${torus} ${score.toFixed(6)}, ${how}.`;
    },
    destroy() {
      destroyed = true;
      offDrag?.();
      cv?.removeEventListener("webglcontextlost", onLost);
      cv?.removeEventListener("webglcontextrestored", onRestored);
      mesh?.geometry.dispose();
      material?.dispose();
      texture?.dispose();
      if (gl) {
        gl.dispose();
        gl.forceContextLoss();
      }
      gl = null;
      scene = null;
      cv?.remove();
      svg.remove();
    },
  };
}
