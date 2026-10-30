/**
 * Drawing of a 3D in 3D packing (polyhedra/<code>/<P>) with three.js and a depth buffer, so that a nearer piece
 * always covers a farther one, however tightly the solids are packed.
 *
 *  - the pieces: one instanced mesh (one geometry, one matrix and one colour per piece) and their edges merged
 *    into one set of line segments, so that 100 pieces of the largest solids are two draw calls;
 *  - the container: s times the container solid, its faces faint and see-through, its edges drawn;
 *  - views: "Solid" (opaque pieces) and "See-through" (translucent pieces, to see the inner ones);
 *  - drag or the arrow keys turn it about the view's axes; it is drawn only when something changes.
 *
 * three.js (about 600 kB) is loaded with a dynamic import when the first such drawing is made, so the board
 * loads it only in this mode. Without WebGL the drawing says so in a sentence instead.
 */
import type * as T from "three";
import { getProblem, getSolid, type Pose, type Solid } from "@polypack/polyhedra";
import type { SpaceConfig } from "@polypack/spaces";
import { type SpaceRenderer, cssVar, lowerTitle, fitCanvas, isDark, onDrag } from "./common";

type Three = typeof import("three");

/** The view a drawing starts with: turned 25 degrees about y, then tilted 20 degrees about x. */
const START: [number, number, number, number] = (() => {
  const a = (25 * Math.PI) / 360;
  const b = (-20 * Math.PI) / 360;
  // q = qx(b) qy(a), as [x, y, z, w]
  const [cy, sy, cx, sx] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
  return [sx * cy, cx * sy, sx * sy, cx * cy];
})();

/** The faces of a solid as triangles (a fan per face) with the face's normal, scaled by k. */
function solidTriangles(S: Solid, k = 1): { positions: Float32Array; normals: Float32Array } {
  const tri = S.faces.reduce((n, f) => n + f.length - 2, 0);
  const positions = new Float32Array(9 * tri);
  const normals = new Float32Array(9 * tri);
  let o = 0;
  S.faces.forEach((f, fi) => {
    for (let t = 1; t < f.length - 1; t++)
      for (const v of [f[0], f[t], f[t + 1]]) {
        positions.set([k * S.V[3 * v], k * S.V[3 * v + 1], k * S.V[3 * v + 2]], o);
        normals.set([S.N[3 * fi], S.N[3 * fi + 1], S.N[3 * fi + 2]], o);
        o += 3;
      }
  });
  return { positions, normals };
}

/** The rotation of an unnormalised quaternion [w, x, y, z] as a row-major 3x3 matrix (H(q) / |q|^2). */
function rotation(w: number, x: number, y: number, z: number): number[] {
  const m = Math.max(Math.abs(w), Math.abs(x), Math.abs(y), Math.abs(z)) || 1;
  [w, x, y, z] = [w / m, x / m, y / m, z / m];
  const n = w * w + x * x + y * y + z * z;
  return [
    (w * w + x * x - y * y - z * z) / n,
    (2 * (x * y - w * z)) / n,
    (2 * (x * z + w * y)) / n,
    (2 * (x * y + w * z)) / n,
    (w * w - x * x + y * y - z * z) / n,
    (2 * (y * z - w * x)) / n,
    (2 * (x * z - w * y)) / n,
    (2 * (y * z + w * x)) / n,
    (w * w - x * x - y * y + z * z) / n,
  ];
}

/** "11 cubes in a cube of scale 2.881711, drawn in 3D." (P is at least 2, so the title's plural fits.) */
function describeText(title: string, P: number, s: number): string {
  const at = title.lastIndexOf(" in ");
  return `${P} ${lowerTitle(title.slice(0, at))} in ${title.slice(at + 4)} of scale ${s.toFixed(6)}, drawn in 3D.`;
}

export function polyhedraRenderer(
  code: string,
  P: number,
): SpaceRenderer & { frameTime(): number | null; measureFrames(n: number): number | null } {
  const problem = getProblem(code);
  if (!problem) throw new Error(`unknown polyhedra problem ${code}`);
  const pieceSolid = getSolid(problem.piece);
  const containerSolid = getSolid(problem.container);
  const cv = document.createElement("canvas");
  let view: "solid" | "clear" = "solid";
  let config: { s: number; pieces: Pose[] } | null = null;
  let THREE: Three | null = null;
  let failed = false;
  let destroyed = false;
  /** True while the browser has taken the WebGL context away (three.js restores it when it comes back). */
  let lost = false;
  let lastFrame: number | null = null;

  // the three.js objects, made once three.js has loaded
  let gl: T.WebGLRenderer | null = null;
  let scene: T.Scene | null = null;
  let camera: T.PerspectiveCamera | null = null;
  let root: T.Group | null = null;
  let pieceGeometry: T.BufferGeometry | null = null;
  let pieceMaterial: T.MeshLambertMaterial | null = null;
  let edgeMaterial: T.LineBasicMaterial | null = null;
  let boxFaceMaterial: T.MeshBasicMaterial | null = null;
  let boxEdgeMaterial: T.LineBasicMaterial | null = null;
  let built: T.Object3D[] = [];
  let builtFor: unknown = null;
  let builtDark: boolean | null = null;
  let quat: [number, number, number, number] = [...START];

  function disposeBuilt() {
    for (const o of built) {
      root?.remove(o);
      const g = (o as T.Mesh).geometry;
      // the piece geometry is shared by every drawing of this renderer
      if (g && g !== pieceGeometry) g.dispose();
      (o as T.InstancedMesh).dispose?.();
    }
    built = [];
    builtFor = null;
  }

  function setup(T3: Three) {
    try {
      gl = new T3.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    } catch {
      failed = true;
      return;
    }
    gl.setClearColor(0x000000, 0);
    scene = new T3.Scene();
    camera = new T3.PerspectiveCamera(30, 1, 0.01, 1e4);
    // the light turns with the viewer: from the upper left, in front
    camera.add(new T3.AmbientLight(0xffffff, 1.4));
    const sun = new T3.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-0.45, 0.6, 0.66);
    camera.add(sun);
    scene.add(camera);
    root = new T3.Group();
    scene.add(root);
    const { positions, normals } = solidTriangles(pieceSolid);
    pieceGeometry = new T3.BufferGeometry();
    pieceGeometry.setAttribute("position", new T3.BufferAttribute(positions, 3));
    pieceGeometry.setAttribute("normal", new T3.BufferAttribute(normals, 3));
    // the faces sit a little behind their edges in the depth buffer, so that every edge shows
    pieceMaterial = new T3.MeshLambertMaterial({
      color: 0xffffff,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    edgeMaterial = new T3.LineBasicMaterial({ transparent: true });
    boxFaceMaterial = new T3.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: T3.DoubleSide,
    });
    boxEdgeMaterial = new T3.LineBasicMaterial({ transparent: true });
  }

  /** The scene of the current configuration, made again only when the configuration or the scheme changes. */
  function build(T3: Three) {
    if (!config || !root || !pieceGeometry) return;
    const dark = isDark();
    if (builtFor === config && builtDark === dark) return;
    disposeBuilt();
    const { s, pieces } = config;
    // the pieces: one instanced mesh
    const mesh = new T3.InstancedMesh(pieceGeometry, pieceMaterial!, pieces.length);
    const m = new T3.Matrix4();
    const q = new T3.Quaternion();
    const pos = new T3.Vector3();
    const one = new T3.Vector3(1, 1, 1);
    const colour = new T3.Color();
    pieces.forEach((p, i) => {
      q.set(p[4], p[5], p[6], p[3]).normalize();
      m.compose(pos.set(p[0], p[1], p[2]), q, one);
      mesh.setMatrixAt(i, m);
      // the hues of the other drawings: 137.5 degrees apart
      colour.setHSL(((i * 137.508) % 360) / 360, dark ? 0.45 : 0.55, dark ? 0.52 : 0.62, T3.SRGBColorSpace);
      mesh.setColorAt(i, colour);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // their edges, merged into one set of segments
    const E = pieceSolid.edges.length;
    const lines = new Float32Array(pieces.length * E * 6);
    let o = 0;
    for (const p of pieces) {
      const R = rotation(p[3], p[4], p[5], p[6]);
      for (const [a, b] of pieceSolid.edges)
        for (const v of [a, b]) {
          const x = pieceSolid.V[3 * v];
          const y = pieceSolid.V[3 * v + 1];
          const z = pieceSolid.V[3 * v + 2];
          lines[o++] = p[0] + R[0] * x + R[1] * y + R[2] * z;
          lines[o++] = p[1] + R[3] * x + R[4] * y + R[5] * z;
          lines[o++] = p[2] + R[6] * x + R[7] * y + R[8] * z;
        }
    }
    const edgeGeometry = new T3.BufferGeometry();
    edgeGeometry.setAttribute("position", new T3.BufferAttribute(lines, 3));
    const edges = new T3.LineSegments(edgeGeometry, edgeMaterial!);
    // the container: faint faces and its edges
    const box = solidTriangles(containerSolid, s);
    const boxGeometry = new T3.BufferGeometry();
    boxGeometry.setAttribute("position", new T3.BufferAttribute(box.positions, 3));
    const boxFaces = new T3.Mesh(boxGeometry, boxFaceMaterial!);
    boxFaces.renderOrder = 2;
    const boxLines = new Float32Array(containerSolid.edges.length * 6);
    containerSolid.edges.forEach(([a, b], k) => {
      boxLines.set(
        [
          s * containerSolid.V[3 * a],
          s * containerSolid.V[3 * a + 1],
          s * containerSolid.V[3 * a + 2],
          s * containerSolid.V[3 * b],
          s * containerSolid.V[3 * b + 1],
          s * containerSolid.V[3 * b + 2],
        ],
        6 * k,
      );
    });
    const boxEdgeGeometry = new T3.BufferGeometry();
    boxEdgeGeometry.setAttribute("position", new T3.BufferAttribute(boxLines, 3));
    const boxEdges = new T3.LineSegments(boxEdgeGeometry, boxEdgeMaterial!);
    built = [mesh, edges, boxFaces, boxEdges];
    root.add(...built);
    builtFor = config;
    builtDark = dark;
  }

  /** Colours from the page (style.css) and the view's transparency. */
  function style(T3: Three) {
    const dark = isDark();
    const edge = new T3.Color(cssVar("--space-edge") || (dark ? "#c9cbd0" : "#3b3b3f"));
    edgeMaterial!.color.copy(edge);
    edgeMaterial!.opacity = view === "clear" ? 0.35 : dark ? 0.55 : 0.5;
    boxEdgeMaterial!.color.copy(edge);
    boxEdgeMaterial!.opacity = 0.9;
    boxFaceMaterial!.color.set(cssVar("--space-face") || (dark ? "#2a2c31" : "#ece8df"));
    boxFaceMaterial!.opacity = dark ? 0.1 : 0.16;
    const clear = view === "clear";
    if (pieceMaterial!.transparent !== clear) {
      pieceMaterial!.transparent = clear;
      pieceMaterial!.depthWrite = !clear;
      pieceMaterial!.needsUpdate = true;
    }
    pieceMaterial!.opacity = clear ? 0.4 : 1;
  }

  function sayNoWebGL() {
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = cssVar("--muted") || "#666";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "center";
    const lines = [
      "This drawing needs WebGL, which this browser does not offer.",
      "The values and the search work without it.",
    ];
    lines.forEach((t, k) => ctx.fillText(t, w / 2, h / 2 + (k - 0.5) * 20, w - 16));
  }

  function render() {
    if (destroyed) return;
    if (failed) {
      sayNoWebGL();
      return;
    }
    const T3 = THREE;
    if (!T3 || !gl || !scene || !camera || !root || !config || lost) return;
    build(T3);
    style(T3);
    const w = Math.max(1, cv.clientWidth);
    const h = Math.max(1, cv.clientHeight);
    gl.setPixelRatio(window.devicePixelRatio || 1);
    gl.setSize(w, h, false);
    // the whole container in view, whatever its turn: a sphere of its circumradius
    const r = config.s * containerSolid.circumradius;
    const fov = (camera.fov * Math.PI) / 180;
    const fit = Math.min(1, w / h);
    const d = (1.12 * r) / Math.sin(Math.atan(Math.tan(fov / 2) * fit));
    camera.aspect = w / h;
    camera.near = Math.max(1e-3, d - 2 * r);
    camera.far = d + 2 * r;
    camera.position.set(0, 0, d);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    root.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    const t0 = performance.now();
    gl.render(scene, camera);
    lastFrame = performance.now() - t0;
  }

  // three.js arrives once, for every drawing of this kind
  void import("three")
    .then((T3) => {
      if (destroyed) return;
      THREE = T3;
      setup(T3);
      render();
    })
    .catch(() => {
      failed = true;
      render();
    });

  /** Turns the view by angles about the view's y axis (dx) and x axis (dy). */
  function turn(dx: number, dy: number) {
    const h1 = dx / 2;
    const h2 = dy / 2;
    // [x, y, z, w]: about y by dx, then about x by dy, both in the view's frame
    const qy: [number, number, number, number] = [0, Math.sin(h1), 0, Math.cos(h1)];
    const qx: [number, number, number, number] = [Math.sin(h2), 0, 0, Math.cos(h2)];
    const mul = (a: number[], b: number[]): [number, number, number, number] => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    quat = mul(qx, mul(qy, quat));
    const n = Math.hypot(...quat);
    quat = quat.map((v) => v / n) as [number, number, number, number];
    render();
  }

  // A lost context (the GPU reset, or too many contexts) is waited out: three.js asks the browser to
  // restore it and sets itself up again, and the scene is then drawn anew.
  const onLost = () => {
    if (destroyed) return;
    lost = true;
  };
  const onRestored = () => {
    if (destroyed) return;
    lost = false;
    builtFor = null;
    render();
  };
  cv.addEventListener("webglcontextlost", onLost);
  cv.addEventListener("webglcontextrestored", onRestored);

  const off = onDrag(cv, (dx, dy) => {
    if (config && !failed) turn(dx * 0.01, dy * 0.01);
  });

  return {
    element: cv,
    releaseOnLeave: true,
    views: [
      { key: "solid", label: "Solid" },
      { key: "clear", label: "See-through" },
    ],
    get view() {
      return view;
    },
    setView(key) {
      view = key === "clear" ? "clear" : "solid";
      render();
    },
    draw(c: SpaceConfig) {
      config = { s: c.s as number, pieces: c.pieces as Pose[] };
      render();
    },
    redraw: render,
    canTurn: () => !failed && !lost && config !== null,
    turn,
    reset() {
      quat = [...START];
      render();
    },
    describe: () =>
      failed
        ? "This drawing needs WebGL, which this browser does not offer."
        : lost
          ? "The browser has taken this drawing's graphics context away; it is drawn again when the context comes back."
          : config
            ? describeText(problem.title, P, config.s)
            : "No packing to draw.",
    destroy() {
      destroyed = true;
      off();
      cv.removeEventListener("webglcontextlost", onLost);
      cv.removeEventListener("webglcontextrestored", onRestored);
      disposeBuilt();
      pieceGeometry?.dispose();
      pieceMaterial?.dispose();
      edgeMaterial?.dispose();
      boxFaceMaterial?.dispose();
      boxEdgeMaterial?.dispose();
      if (gl) {
        gl.dispose();
        gl.forceContextLoss();
      }
      gl = null;
      scene = null;
    },
    /** Milliseconds the last frame took to submit (for measurements). */
    frameTime: () => lastFrame,
    /**
     * Draws n frames, each turned a little and read back (one pixel, which waits until the GPU has drawn the
     * frame), and returns the mean milliseconds per frame (for measurements; null before three.js has loaded
     * or without WebGL).
     */
    measureFrames(n: number) {
      if (!gl || failed || !config) return null;
      const ctx = gl.getContext();
      const pixel = new Uint8Array(4);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        turn(0.01, 0.004);
        ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, pixel);
      }
      return (performance.now() - t0) / n;
    },
  };
}
