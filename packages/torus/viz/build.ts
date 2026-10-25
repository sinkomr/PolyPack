/**
 * Build the standalone torus viewer from data/torus/records.json.
 *
 *   npx tsx packages/torus/viz/build.ts
 *
 * Writes packages/torus/viz/index.html: one self-contained page (inline SVG, no external
 * scripts) with the certified records embedded. Two drawings of the same packing:
 *   - "Tiled plane": 3 x 3 copies of the fundamental cell, the central cell outlined,
 *     pieces coloured by orbit (all lattice translates of one piece share a colour);
 *   - "One cell": the fundamental cell alone with wrap-around ghosts (the parts of pieces
 *     that leave the cell re-enter on the opposite side, drawn lighter), identified edges
 *     marked with arrows.
 * Contacts (|separation| <= 1e-7 in floats) can be overlaid as segments between centres.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { circumradius, pieceArea } from "@polypack/geometry";
import { TorusRecordsFile, recordPacking, validateTorusPacking } from "../src";

const root = new URL("../../../", import.meta.url);
// optional arguments: input records file and output html (defaults: the repository paths)
const input = process.argv[2] ?? new URL("data/torus/records.json", root);
const output = process.argv[3] ?? new URL("packages/torus/viz/index.html", root);
const file = JSON.parse(readFileSync(input, "utf8")) as TorusRecordsFile;

interface VizRecord {
  id: string;
  f: string;
  N: number;
  P: number;
  d: string;
  sf: number;
  sc: number;
  dens: number;
  bound: number;
  boundLabel: string;
  b1: [number, number];
  b2: [number, number];
  poses: [number, number, number][];
  contacts: [number, number, number, number][];
  eps: number;
  notes: string;
  lit: string[];
  exact: string;
}

const recs: VizRecord[] = file.records.map((r) => {
  const p = recordPacking(r);
  const v = validateTorusPacking(p, { contactTol: 1e-7 });
  const round = (x: number) => Number(x.toPrecision(12));
  return {
    id: r.problem,
    f: r.family,
    N: r.N,
    P: r.P,
    d: r.display,
    sf: r.score_float,
    sc: r.score_cert,
    dens: r.density,
    bound: r.bound.value,
    boundLabel: r.bound.label,
    b1: [round(p.lattice.b1[0]), round(p.lattice.b1[1])],
    b2: [round(p.lattice.b2[0]), round(p.lattice.b2[1])],
    poses: p.poses.map((q) => [round(q.x), round(q.y), round(q.theta)]),
    contacts: v.contacts.map((c) => [c.i, c.j, c.m, c.n]),
    eps: r.eps,
    notes: r.notes ?? "",
    lit: (r.literature ?? []).map(
      (l) => `${l.status.replace("_", " ")}: ${l.value === null ? "no value" : l.value.toFixed(6)} (${l.short})${l.note ? "; " + l.note : ""}`,
    ),
    exact: r.exact ? `${r.exact.expr} = ${r.exact.value.toPrecision(15)}` : "",
  };
});

// sanity: every record must be float-valid before it is drawn
for (const r of file.records) {
  if (!validateTorusPacking(recordPacking(r)).valid) throw new Error(`invalid record ${r.problem}`);
}
// circumradius / area tables for the page
const shapes = [...new Set(recs.map((r) => r.N))].sort((a, b) => a - b);
const shapeInfo = Object.fromEntries(shapes.map((N) => [N, { R: N === 0 ? 1 : circumradius(N), A: pieceArea(N) }]));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Torus Packings</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1d1f; --muted:#6b6b70; --line:#d8d6d0; --cell:#1d1d1f; --panel:#ffffff; --accent:#2f6fdb; --good:#1f8a4c; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#141416; --fg:#ececef; --muted:#9a9aa2; --line:#33333a; --cell:#ececef; --panel:#1c1c20; --accent:#7aa7ff; --good:#5fd08e; } }
:root[data-theme="dark"] { --bg:#141416; --fg:#ececef; --muted:#9a9aa2; --line:#33333a; --cell:#ececef; --panel:#1c1c20; --accent:#7aa7ff; --good:#5fd08e; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.35rem; margin: 0 0 4px; }
p.lede { color: var(--muted); margin: 0 0 14px; max-width: 70ch; }
.controls { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; margin-bottom:12px; }
.seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.seg button { background:transparent; color:var(--fg); border:0; padding:6px 10px; font:inherit; cursor:pointer; }
.seg button[aria-pressed="true"] { background:var(--accent); color:#fff; }
select, label { font:inherit; color:var(--fg); }
select { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:4px 6px; }
.layout { display:grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap:16px; }
@media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; }
svg.draw { width:100%; height:auto; display:block; }
dl { display:grid; grid-template-columns: max-content 1fr; gap:4px 12px; margin:0; }
dt { color:var(--muted); }
dd { margin:0; font-variant-numeric: tabular-nums; overflow-wrap:anywhere; }
.tablewrap { overflow-x:auto; margin-top:16px; }
table { border-collapse:collapse; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { border:1px solid var(--line); padding:3px 6px; text-align:right; white-space:nowrap; }
td.sel { outline:2px solid var(--accent); outline-offset:-2px; }
td.atbound { color: var(--good); font-weight:600; }
td { cursor:pointer; }
small, .muted { color:var(--muted); }
</style>
</head>
<body>
<main>
<h1>PolyPack pieces on flat tori</h1>
<p class="lede">P congruent pieces (disks of radius 1, regular polygons of side 1) packed on a square torus, a hexagonal torus or a torus with any lattice. Pieces may touch; interiors of all pieces and their lattice translates are disjoint. Every score is certified with interval arithmetic and shown rounded to 6 decimals. Green: equal to a lower bound.</p>
<div class="controls">
  <div class="seg" id="fam" role="group" aria-label="torus family"></div>
  <label>Shape <select id="shape"></select></label>
  <label>P <select id="P"></select></label>
  <div class="seg" id="view" role="group" aria-label="drawing">
    <button data-v="tile" aria-pressed="true">Tiled plane</button><button data-v="cell" aria-pressed="false">One cell</button>
  </div>
  <label><input type="checkbox" id="contacts"> contacts</label>
</div>
<div class="layout">
  <div class="card"><svg class="draw" id="svg" role="img" aria-label="packing drawing"></svg></div>
  <div class="card"><dl id="info"></dl></div>
</div>
<div class="tablewrap card"><table id="table"></table></div>
<p class="muted"><small>Generated ${file.generated} from data/torus/records.json. Problem ids torus/&lt;family&gt;/&lt;N&gt;/&lt;P&gt;. Scores: side L (square, hexagonal), square root of the cell area (free lattice). Certificates: data/torus/certificates/.</small></p>
</main>
<script type="application/json" id="data">${JSON.stringify({ recs, shapeInfo }).replace(/</g, "\\u003c")}</script>
<script>
(() => {
  const { recs, shapeInfo } = JSON.parse(document.getElementById("data").textContent);
  const FAM = { sq: "Square torus", hex: "Hexagonal torus", free: "Free lattice" };
  const SHAPE = (N) => N === 0 ? "disks" : ({3:"triangles",4:"squares",5:"pentagons",6:"hexagons",7:"heptagons",8:"octagons"}[N] || N + "-gons");
  const byId = new Map(recs.map((r) => [r.id, r]));
  const state = { f: "sq", N: 0, P: 5, view: "tile", contacts: false };
  try { Object.assign(state, JSON.parse(localStorage.getItem("torus-viz") || "{}")); } catch (e) {}
  const save = () => { try { localStorage.setItem("torus-viz", JSON.stringify(state)); } catch (e) {} };
  const famEl = document.getElementById("fam"), shapeEl = document.getElementById("shape"), PEl = document.getElementById("P");
  for (const f of Object.keys(FAM)) {
    const b = document.createElement("button"); b.textContent = FAM[f]; b.dataset.f = f;
    b.onclick = () => { state.f = f; render(); }; famEl.appendChild(b);
  }
  const Ns = [...new Set(recs.map((r) => r.N))].sort((a, b) => a - b);
  for (const N of Ns) { const o = document.createElement("option"); o.value = N; o.textContent = SHAPE(N) + " (N = " + N + ")"; shapeEl.appendChild(o); }
  shapeEl.onchange = () => { state.N = +shapeEl.value; render(); };
  PEl.onchange = () => { state.P = +PEl.value; render(); };
  for (const b of document.querySelectorAll("#view button")) b.onclick = () => { state.view = b.dataset.v; render(); };
  const cEl = document.getElementById("contacts");
  cEl.onchange = () => { state.contacts = cEl.checked; render(); };

  const hue = (i, P) => (i * 360 / P + 20) % 360;
  const fill = (i, P, ghost) => "hsl(" + hue(i, P) + " 62% " + (ghost ? "78%" : "58%") + " / " + (ghost ? 0.55 : 0.92) + ")";
  function outline(N, x, y, th) {
    if (N === 0) return null;
    const R = shapeInfo[N].R, pts = [];
    for (let k = 0; k < N; k++) { const a = th + Math.PI / 2 + 2 * Math.PI * k / N; pts.push((x + R * Math.cos(a)).toFixed(4) + "," + (-(y + R * Math.sin(a))).toFixed(4)); }
    return pts.join(" ");
  }
  function piece(N, x, y, th, color, strokeW) {
    if (N === 0) return '<circle cx="' + x.toFixed(4) + '" cy="' + (-y).toFixed(4) + '" r="1" fill="' + color + '" stroke="var(--bg)" stroke-width="' + strokeW + '"/>';
    return '<polygon points="' + outline(N, x, y, th) + '" fill="' + color + '" stroke="var(--bg)" stroke-width="' + strokeW + '"/>';
  }
  const add = (a, b, m, n) => [a[0] + m * b[0][0] + n * b[1][0], a[1] + m * b[0][1] + n * b[1][1]];
  function para(B, s0, s1) {
    // parallelogram {s b1 + t b2 : s, t in [s0, s1]} as an SVG path (y flipped)
    const c = [[s0, s0], [s1, s0], [s1, s1], [s0, s1]].map(([s, t]) => { const p = add([0, 0], B, s, t); return p[0].toFixed(4) + "," + (-p[1]).toFixed(4); });
    return "M" + c.join("L") + "Z";
  }
  function draw(r) {
    const B = [r.b1, r.b2], N = r.N, P = r.P, R = shapeInfo[N].R;
    const tile = state.view === "tile";
    // central cell bounding box (y up)
    const cc = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([s, t]) => add([0, 0], B, s, t));
    let x0 = Math.min(...cc.map((c) => c[0])), x1 = Math.max(...cc.map((c) => c[0]));
    let y0 = Math.min(...cc.map((c) => c[1])), y1 = Math.max(...cc.map((c) => c[1]));
    // tiled view: a rectangular window around the cell; one-cell view: the cell itself
    const grow = tile ? Math.max(1.6 * R, 0.45 * Math.max(x1 - x0, y1 - y0)) : 0;
    x0 -= grow; x1 += grow; y0 -= grow; y1 += grow;
    const pad = tile ? 0 : R * 0.15 + 0.3;
    const vb = [x0 - pad, -y1 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
    const sw = (vb[2] / 600).toFixed(4);
    const clipPath = tile
      ? "M" + x0.toFixed(4) + "," + (-y1).toFixed(4) + "H" + x1.toFixed(4) + "V" + (-y0).toFixed(4) + "H" + x0.toFixed(4) + "Z"
      : para(B, 0, 1);
    let s = '<defs><clipPath id="clip"><path d="' + clipPath + '"/></clipPath></defs>';
    // piece centres reduced to the fundamental cell (fractional coordinates in [0, 1))
    const det = B[0][0] * B[1][1] - B[0][1] * B[1][0];
    const cen = r.poses.map(([x, y, t]) => {
      let a = (x * B[1][1] - y * B[1][0]) / det, b = (B[0][0] * y - B[0][1] * x) / det;
      a -= Math.floor(a); b -= Math.floor(b);
      return [add([0, 0], B, a, b), t];
    });
    // all lattice translates whose bounding disk meets the window
    const K = 2 + Math.ceil(Math.max(x1 - x0, y1 - y0) / Math.min(Math.abs(det) / Math.hypot(...B[0]), Math.abs(det) / Math.hypot(...B[1])));
    const hit = (p) => p[0] + R > x0 && p[0] - R < x1 && p[1] + R > y0 && p[1] - R < y1;
    let body = "", cells = "";
    for (let m = -K; m <= K; m++) for (let n = -K; n <= K; n++) {
      const central = m === 0 && n === 0;
      cen.forEach(([c, t], i) => {
        const p = add(c, B, m, n);
        if (hit(p)) body += piece(N, p[0], p[1], t, fill(i, P, !tile && !central), sw);
      });
      const o = add([0, 0], B, m, n);
      if (tile && !central && o[0] + Math.abs(B[0][0]) + Math.abs(B[1][0]) > x0 - 1 && o[0] - Math.abs(B[0][0]) - Math.abs(B[1][0]) < x1 + 1 && o[1] + Math.abs(B[0][1]) + Math.abs(B[1][1]) > y0 - 1 && o[1] - Math.abs(B[0][1]) - Math.abs(B[1][1]) < y1 + 1)
        cells += '<path d="' + para(B, 0, 1) + '" transform="translate(' + o[0].toFixed(4) + ' ' + (-o[1]).toFixed(4) + ')" fill="none" stroke="var(--cell)" stroke-opacity="0.3" stroke-width="' + sw + '"/>';
    }
    s += '<g clip-path="url(#clip)">' + body + cells;
    if (state.contacts) {
      for (const [i, j, m, n] of r.contacts) {
        // contact between piece i and piece j + m b1 + n b2, drawn from every visible copy of i
        for (let a = -K; a <= K; a++) for (let b = -K; b <= K; b++) {
          const p = add(cen[i][0], B, a, b);
          if (!hit(p)) continue;
          // the contact partner of copy (a, b) of i: the copy of j displaced by the stored vector
          const d = [r.poses[j][0] - r.poses[i][0], r.poses[j][1] - r.poses[i][1]];
          const q = add([p[0] + d[0], p[1] + d[1]], B, m, n);
          s += '<line x1="' + p[0].toFixed(4) + '" y1="' + (-p[1]).toFixed(4) + '" x2="' + q[0].toFixed(4) + '" y2="' + (-q[1]).toFixed(4) + '" stroke="var(--fg)" stroke-width="' + (2 * sw) + '" stroke-opacity="0.75"/>';
        }
      }
    }
    s += "</g>";
    s += '<path d="' + para(B, 0, 1) + '" fill="none" stroke="var(--cell)" stroke-width="' + (3 * sw) + '"/>';
    if (!tile) {
      // arrows: one on the b1 sides, two on the b2 sides (opposite sides are identified)
      const arrow = (p0, v, k) => {
        let out = "";
        const len = Math.hypot(v[0], v[1]), ux = v[0] / len, uy = v[1] / len, h = 0.12 * Math.min(Math.hypot(...B[0]), Math.hypot(...B[1]));
        for (let q = 0; q < k; q++) {
          const f = 0.5 + (q - (k - 1) / 2) * 0.05, x = p0[0] + f * v[0], y = p0[1] + f * v[1];
          out += '<path d="M' + (x - h * ux - h * 0.6 * uy).toFixed(4) + "," + (-(y - h * uy + h * 0.6 * ux)).toFixed(4) + "L" + x.toFixed(4) + "," + (-y).toFixed(4) + "L" + (x - h * ux + h * 0.6 * uy).toFixed(4) + "," + (-(y - h * uy - h * 0.6 * ux)).toFixed(4) + '" fill="none" stroke="var(--accent)" stroke-width="' + (3 * sw) + '"/>';
        }
        return out;
      };
      s += arrow([0, 0], B[0], 1) + arrow(B[1], B[0], 1) + arrow([0, 0], B[1], 2) + arrow(B[0], B[1], 2);
    }
    const svg = document.getElementById("svg");
    svg.setAttribute("viewBox", vb.map((v) => v.toFixed(4)).join(" "));
    svg.innerHTML = s;
    svg.setAttribute("aria-label", r.id + ", " + (tile ? "tiled plane" : "one cell with wrap-around ghosts"));
  }
  function info(r) {
    const gap = (r.sf - r.bound) / r.bound;
    const rows = [
      ["Problem", r.id],
      ["Torus", FAM[r.f] + ", " + r.P + " " + SHAPE(r.N)],
      ["Score (certified)", r.d + (r.f === "free" ? "  (sqrt of cell area)" : "  (side L)")],
      ["score_float", r.sf.toPrecision(15)],
      ["score_cert", r.sc.toPrecision(15)],
      ["Shrink eps", r.eps.toExponential(0)],
      ["Density", r.dens.toFixed(6)],
      ["Lower bound", r.bound.toFixed(6) + " (" + r.boundLabel + ")"],
      ["Gap to bound", gap <= 1e-12 ? "0 (equal)" : (100 * gap).toFixed(3) + " %"],
      ...(r.exact ? [["Exact value", r.exact]] : []),
      ["Basis", "b1 = (" + r.b1.map((v) => v.toFixed(6)).join(", ") + "), b2 = (" + r.b2.map((v) => v.toFixed(6)).join(", ") + ")"],
      ["Contacts", String(r.contacts.length)],
    ];
    for (const l of r.lit) rows.push(["Literature", l]);
    if (r.notes) rows.push(["Notes", r.notes]);
    document.getElementById("info").innerHTML = rows.map(([k, v]) => "<dt>" + k + "</dt><dd>" + String(v).replace(/</g, "&lt;") + "</dd>").join("");
  }
  function table() {
    const Ps = [...new Set(recs.filter((r) => r.f === state.f).map((r) => r.P))].sort((a, b) => a - b);
    let h = "<thead><tr><th>" + FAM[state.f] + "</th>" + Ps.map((P) => "<th>P=" + P + "</th>").join("") + "</tr></thead><tbody>";
    for (const N of Ns) {
      h += "<tr><th>" + SHAPE(N) + "</th>";
      for (const P of Ps) {
        const r = byId.get("torus/" + state.f + "/" + N + "/" + P);
        if (!r) { h += "<td></td>"; continue; }
        const cls = [(N === state.N && P === state.P) ? "sel" : "", (r.sf - r.bound) / r.bound <= 1e-12 ? "atbound" : ""].join(" ");
        h += '<td class="' + cls + '" data-n="' + N + '" data-p="' + P + '" title="density ' + r.dens.toFixed(4) + '">' + r.d + "</td>";
      }
      h += "</tr>";
    }
    const t = document.getElementById("table");
    t.innerHTML = h + "</tbody>";
    for (const td of t.querySelectorAll("td[data-n]")) td.onclick = () => { state.N = +td.dataset.n; state.P = +td.dataset.p; render(); };
  }
  function render() {
    for (const b of famEl.children) b.setAttribute("aria-pressed", String(b.dataset.f === state.f));
    for (const b of document.querySelectorAll("#view button")) b.setAttribute("aria-pressed", String(b.dataset.v === state.view));
    const Ps = [...new Set(recs.filter((r) => r.f === state.f && r.N === state.N).map((r) => r.P))].sort((a, b) => a - b);
    if (!Ps.includes(state.P)) state.P = Ps[0];
    PEl.innerHTML = Ps.map((P) => '<option value="' + P + '">' + P + "</option>").join("");
    PEl.value = state.P; shapeEl.value = state.N; cEl.checked = state.contacts;
    const r = byId.get("torus/" + state.f + "/" + state.N + "/" + state.P);
    if (r) { draw(r); info(r); }
    table(); save();
  }
  render();
})();
</script>
</body>
</html>
`;
writeFileSync(output, html);
console.log(`wrote ${String(output)} with ${recs.length} records`);
