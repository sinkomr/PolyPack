/**
 * Viewer for PolyPack surface records: a net of the solid (2D) and the solid itself (3D, drag to
 * turn). Bundled into index.html by scripts/build-viz.ts together with the records.
 * Parts are recomputed here from the stored poses with the same development code as the validator.
 */
import { SolidName, Rigid, apply, compose, faceTo3D, frameVertex, getSolid, glue, pieceParts, IDENTITY } from "../src/index";
import { canonicalize } from "../src/search/energy";

interface VizRecord {
  id: string;
  solid: SolidName;
  mode: "fold" | "nofold";
  N: number;
  P: number;
  s: number;
  d: string; // display score
  b: number; // bound
  k: string; // kind
  m: string; // method
  g?: number; // fold gain vs nofold
  p: number[]; // flat [face, x, y, theta, ...]
}

declare const SURFACE_DATA: { records: VizRecord[]; nets: Record<string, number[][]> };

const $ = (id: string) => document.getElementById(id)!;
const data = SURFACE_DATA;
const byKey = new Map<string, VizRecord>();
for (const r of data.records) byKey.set(`${r.solid}/${r.mode}/${r.N}/${r.P}`, r);

const SOLIDS: SolidName[] = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];
const SHAPES: [number, string][] = [
  [0, "disks"],
  [3, "triangles"],
  [4, "squares"],
  [5, "pentagons"],
  [6, "hexagons"],
  [8, "octagons"],
];

const state = { solid: "cube" as SolidName, N: 4, P: 12, mode: "fold" as "fold" | "nofold", view: "3d" as "3d" | "net", rot: [0.6, -0.5] };

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function pieceColor(i: number, P: number, alpha = 1): string {
  const h = (i * 137.508) % 360;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return `hsla(${h.toFixed(1)}, ${dark ? 55 : 60}%, ${dark ? 58 : 52}%, ${alpha})`;
}

interface DrawPart {
  piece: number;
  face: number;
  poly: Float64Array;
}

const partCache = new Map<string, DrawPart[]>();
function partsOf(r: VizRecord): DrawPart[] {
  const hit = partCache.get(r.id);
  if (hit) return hit;
  const S = getSolid(r.solid);
  const out: DrawPart[] = [];
  for (let i = 0; i < r.P; i++) {
    // canonicalize: a centre stored on an edge may round to just outside its face
    const pose = canonicalize(S, r.s, { face: r.p[4 * i], x: r.p[4 * i + 1], y: r.p[4 * i + 2], theta: r.p[4 * i + 3] });
    for (const part of pieceParts(S, r.s, r.N, pose, i)) if (part.poly.length >= 6) out.push({ piece: i, face: part.face, poly: part.poly });
  }
  partCache.set(r.id, out);
  return out;
}

function netTransforms(solid: SolidName, s: number): Rigid[] {
  // nets[solid][f] = [parent face, parent edge] (-1 for the root): face f is unfolded across that edge
  const tree = data.nets[solid];
  const S = getSolid(solid);
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

function setupCanvas(cv: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function drawNet(r: VizRecord) {
  const cv = $("cv") as HTMLCanvasElement;
  const ctx = setupCanvas(cv);
  const S = getSolid(r.solid);
  const T = netTransforms(r.solid, r.s);
  const faces = T.map((t) => {
    const pts: [number, number][] = [];
    for (let k = 0; k < S.M; k++) pts.push(apply(t, ...frameVertex(S.M, r.s, k)));
    return pts;
  });
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const f of faces) for (const [x, y] of f) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const W = cv.clientWidth, H = cv.clientHeight, pad = 14;
  const sc = Math.min((W - 2 * pad) / (maxx - minx), (H - 2 * pad) / (maxy - miny));
  const X = (x: number) => pad + (x - minx) * sc + (W - 2 * pad - (maxx - minx) * sc) / 2;
  const Y = (y: number) => H - pad - (y - miny) * sc - (H - 2 * pad - (maxy - miny) * sc) / 2;
  ctx.lineJoin = "round";
  for (const f of faces) {
    ctx.beginPath();
    f.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.closePath();
    ctx.fillStyle = css("--face");
    ctx.fill();
  }
  for (const part of partsOf(r)) {
    const t = T[part.face];
    ctx.beginPath();
    for (let i = 0; i < part.poly.length; i += 2) {
      const [x, y] = apply(t, part.poly[i], part.poly[i + 1]);
      i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y));
    }
    ctx.closePath();
    ctx.fillStyle = pieceColor(part.piece, r.P, 0.85);
    ctx.fill();
    ctx.strokeStyle = css("--piece-edge");
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  for (const f of faces) {
    ctx.beginPath();
    f.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.closePath();
    ctx.strokeStyle = css("--edge");
    ctx.lineWidth = 1.2;
    ctx.stroke();
    for (const [x, y] of f) {
      ctx.beginPath();
      ctx.arc(X(x), Y(y), 2.2, 0, 2 * Math.PI);
      ctx.fillStyle = css("--cone");
      ctx.fill();
    }
  }
}

type V3 = [number, number, number];
function rotate(p: V3, a: number, b: number): V3 {
  // yaw a about z, then pitch b about x
  const x = Math.cos(a) * p[0] - Math.sin(a) * p[1];
  const y = Math.sin(a) * p[0] + Math.cos(a) * p[1];
  const z = p[2];
  return [x, Math.cos(b) * y - Math.sin(b) * z, Math.sin(b) * y + Math.cos(b) * z];
}

function draw3D(r: VizRecord) {
  const cv = $("cv") as HTMLCanvasElement;
  const ctx = setupCanvas(cv);
  const S = getSolid(r.solid);
  const W = cv.clientWidth, H = cv.clientHeight;
  const rad = r.s * Math.max(...S.vertices.map((v) => Math.hypot(...v)));
  const sc = (0.42 * Math.min(W, H)) / rad;
  const [a, b] = state.rot;
  const proj = (p: V3): [number, number, number] => {
    const q = rotate(p, a, b);
    // weak perspective, camera on -y
    const f = 1 / (1 + q[1] / (6 * rad));
    return [W / 2 + q[0] * sc * f, H / 2 - q[2] * sc * f, q[1]];
  };
  const parts = partsOf(r);
  const faces = S.faces.map((ids, f) => {
    const P3 = ids.map((v) => S.vertices[v].map((c) => c * r.s) as V3);
    const c: V3 = [0, 0, 0];
    for (const p of P3) for (let t = 0; t < 3; t++) c[t] += p[t] / ids.length;
    const n = rotate(c, a, b);
    return { f, P3, depth: n[1], facing: n[1] < 0 };
  });
  faces.sort((u, v) => v.depth - u.depth);
  for (const face of faces) {
    if (!face.facing) continue;
    const shade = 0.55 + 0.45 * Math.min(1, -rotate(face.P3.reduce((u, p) => [u[0] + p[0], u[1] + p[1], u[2] + p[2]] as V3, [0, 0, 0]), a, b)[1] / (face.P3.length * rad));
    ctx.beginPath();
    face.P3.forEach((p, i) => {
      const [x, y] = proj(p);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = css("--face");
    ctx.fill();
    for (const part of parts) {
      if (part.face !== face.f) continue;
      ctx.beginPath();
      for (let i = 0; i < part.poly.length; i += 2) {
        const [x, y] = proj(faceTo3D(S, r.s, face.f, part.poly[i], part.poly[i + 1]));
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.globalAlpha = 0.45 + 0.5 * shade;
      ctx.fillStyle = pieceColor(part.piece, r.P, 0.9);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = css("--piece-edge");
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    ctx.beginPath();
    face.P3.forEach((p, i) => {
      const [x, y] = proj(p);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = css("--edge");
    ctx.lineWidth = 1.3;
    ctx.stroke();
    for (const p of face.P3) {
      const [x, y] = proj(p);
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, 2 * Math.PI);
      ctx.fillStyle = css("--cone");
      ctx.fill();
    }
  }
}

function current(): VizRecord | undefined {
  return byKey.get(`${state.solid}/${state.mode}/${state.N}/${state.P}`);
}

function render() {
  const r = current();
  const info = $("info");
  if (!r) {
    info.textContent = "No record for this choice.";
    const cv = $("cv") as HTMLCanvasElement;
    setupCanvas(cv);
    return;
  }
  const other = byKey.get(`${state.solid}/${state.mode === "fold" ? "nofold" : "fold"}/${state.N}/${state.P}`);
  const name = SHAPES.find(([n]) => n === state.N)?.[1] ?? `N=${state.N}`;
  $("score").textContent = `s = ${r.d}`;
  info.innerHTML = "";
  const lines = [
    `${r.P} ${name} on the ${r.solid}, ${r.mode === "fold" ? "folding allowed" : "no folding"}`,
    other ? `${other.mode}: s = ${other.d}` + (r.mode === "fold" && r.g !== undefined && r.g > 1e-9 ? ` (folding saves ${(100 * r.g).toFixed(2)}%)` : "") : "",
    `lower bound ${r.b.toFixed(6)}`,
    r.m,
  ];
  for (const l of lines) {
    if (!l) continue;
    const p = document.createElement("p");
    p.textContent = l;
    info.appendChild(p);
  }
  if (state.view === "net") drawNet(r);
  else draw3D(r);
  renderTable();
}

function renderTable() {
  const tb = $("table");
  tb.innerHTML = "";
  const S = getSolid(state.solid);
  const head = document.createElement("tr");
  for (const h of ["P", "fold", "nofold", "gain", "bound"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  tb.appendChild(head);
  for (let P = 1; P <= 4 * S.F; P++) {
    const f = byKey.get(`${state.solid}/fold/${state.N}/${P}`);
    const n = byKey.get(`${state.solid}/nofold/${state.N}/${P}`);
    if (!f && !n) continue;
    const tr = document.createElement("tr");
    if (P === state.P) tr.className = "sel";
    tr.onclick = () => {
      state.P = P;
      ($("P") as HTMLInputElement).value = String(P);
      render();
    };
    const cells = [String(P), f ? f.d + (f.k === "exact" ? " *" : "") : "", n ? n.d : "", f && f.g !== undefined && f.g > 1e-9 ? `${(100 * f.g).toFixed(1)}%` : "", (f ?? n)!.b.toFixed(4)];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
}

function init() {
  const solidSel = $("solid") as HTMLSelectElement;
  for (const s of SOLIDS) solidSel.add(new Option(s, s));
  const nSel = $("N") as HTMLSelectElement;
  for (const [n, label] of SHAPES) nSel.add(new Option(label, String(n)));
  solidSel.value = state.solid;
  nSel.value = String(state.N);
  const Pin = $("P") as HTMLInputElement;
  Pin.value = String(state.P);
  const clampP = () => {
    const S = getSolid(state.solid);
    const max = 4 * S.F + 40;
    state.P = Math.max(1, Math.min(max, state.P));
    Pin.max = String(max);
    Pin.value = String(state.P);
  };
  solidSel.onchange = () => {
    state.solid = solidSel.value as SolidName;
    clampP();
    render();
  };
  nSel.onchange = () => {
    state.N = Number(nSel.value);
    render();
  };
  Pin.oninput = () => {
    state.P = Number(Pin.value) || 1;
    render();
  };
  for (const id of ["fold", "nofold"]) ($(id) as HTMLInputElement).onchange = () => {
    state.mode = id as "fold" | "nofold";
    render();
  };
  for (const id of ["v3d", "vnet"]) ($(id) as HTMLInputElement).onchange = () => {
    state.view = id === "v3d" ? "3d" : "net";
    render();
  };
  const cv = $("cv") as HTMLCanvasElement;
  let drag: [number, number] | null = null;
  cv.onpointerdown = (e) => {
    drag = [e.clientX, e.clientY];
    cv.setPointerCapture(e.pointerId);
  };
  cv.onpointermove = (e) => {
    if (!drag || state.view !== "3d") return;
    state.rot[0] += (e.clientX - drag[0]) * 0.01;
    state.rot[1] = Math.max(-1.5, Math.min(1.5, state.rot[1] + (e.clientY - drag[1]) * 0.01));
    drag = [e.clientX, e.clientY];
    const r = current();
    if (r) draw3D(r);
  };
  cv.onpointerup = () => (drag = null);
  let spin = true;
  cv.addEventListener("pointerdown", () => (spin = false));
  const tick = () => {
    if (spin && state.view === "3d" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      state.rot[0] += 0.004;
      const r = current();
      if (r) draw3D(r);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.addEventListener("resize", render);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    partCache.clear();
    render();
  });
  render();
}

init();
