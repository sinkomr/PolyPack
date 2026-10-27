/**
 * Builds packages/surface/viz/index.html: a standalone viewer (no external scripts) with the
 * records of data/surface/records.json embedded and the drawing code bundled by esbuild.
 *
 * Usage: npx tsx packages/surface/scripts/build-viz.ts [records.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { polygonSeparation } from "@polypack/geometry";
import { SOLID_NAMES, Rigid, apply, compose, frameVertex, getSolid, glue, IDENTITY, surfaceRecordsInSiteUnits } from "../src/index";

const root = new URL("../../../", import.meta.url);
const recPath = process.argv[2] ?? new URL("data/surface/records.json", root).pathname;
const doc = surfaceRecordsInSiteUnits(JSON.parse(readFileSync(recPath, "utf8")));

/** A net: for every face its parent face and edge in a spanning tree whose unfolding does not overlap. */
function net(name: (typeof SOLID_NAMES)[number]): number[][] {
  const S = getSolid(name);
  for (let attempt = 0; attempt < 200; attempt++) {
    const T: (Rigid | null)[] = Array(S.F).fill(null);
    const parent: number[][] = Array.from({ length: S.F }, () => [-1, -1]);
    const polys: Float64Array[] = [];
    const poly = (t: Rigid) => {
      const out = new Float64Array(2 * S.M);
      for (let k = 0; k < S.M; k++) {
        const [x, y] = apply(t, ...frameVertex(S.M, 1, k));
        out[2 * k] = x;
        out[2 * k + 1] = y;
      }
      return out;
    };
    T[0] = IDENTITY;
    polys[0] = poly(IDENTITY);
    const order = [0];
    let seed = attempt * 7919 + 17;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let idx = 0; idx < order.length; idx++) {
      const f = order[idx];
      const edges = [...Array(S.M).keys()];
      if (attempt) edges.sort(() => rnd() - 0.5);
      for (const k of edges) {
        const g = glue(S, 1, f, k);
        if (T[g.face]) continue;
        const t = compose(T[f]!, g.T);
        const p = poly(t);
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

const nets: Record<string, number[][]> = {};
for (const name of SOLID_NAMES) nets[name] = net(name);

const r7 = (x: number) => Number(x.toPrecision(10));
const records = doc.records.map((r: any) => ({
  id: r.id,
  solid: r.solid,
  mode: r.mode,
  N: r.N,
  P: r.P,
  s: r.s,
  d: r.display,
  b: r7(r.bound.value),
  k: r.kind,
  m: r.method,
  g: r.fold_gain !== undefined ? r7(r.fold_gain) : undefined,
  // 10 significant digits are plenty for drawing; the viewer re-anchors centres that round off a face
  p: r.pieces.flatMap((p: any) => [p.face, r7(p.x), r7(p.y), r7(p.theta)]),
}));

const bundle = await build({
  entryPoints: [new URL("../viz/app.ts", import.meta.url).pathname],
  bundle: true,
  format: "iife",
  minify: true,
  write: false,
  target: "es2020",
});
const js = bundle.outputFiles[0].text;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyPack Surface Packings</title>
<style>
:root { --bg: #fbfaf7; --fg: #1d1d1f; --muted: #5f6368; --face: #ece8df; --edge: #3b3b3f; --cone: #b3261e; --piece-edge: rgba(0,0,0,.45); --line: #d9d4c8; --sel: #fff1c9; --link: #1a5fb4; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #16171a; --fg: #ececec; --muted: #a2a5ab; --face: #2a2c31; --edge: #c9cbd0; --cone: #ff8a80; --piece-edge: rgba(255,255,255,.5); --line: #34363c; --sel: #3a3420; --link: #8ab4f8; color-scheme: dark; } }
a { color: var(--link); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.3rem; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 14px; }
.controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin-bottom: 12px; }
.controls label { display: inline-flex; gap: 6px; align-items: center; }
select, input[type=number] { font: inherit; padding: 4px 6px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; }
input[type=number] { width: 5em; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; }
@media (max-width: 760px) { .grid { grid-template-columns: minmax(0, 1fr); } }
canvas { width: 100%; aspect-ratio: 1 / 1; max-height: 70vh; display: block; border: 1px solid var(--line); border-radius: 10px; touch-action: none; background: var(--bg); }
#score { font-size: 1.6rem; font-variant-numeric: tabular-nums; margin: 6px 0; }
#info p { margin: 4px 0; color: var(--muted); }
#info p:first-child { color: var(--fg); }
.tablewrap { max-height: 46vh; overflow: auto; border: 1px solid var(--line); border-radius: 8px; margin-top: 10px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { padding: 3px 8px; text-align: right; border-bottom: 1px solid var(--line); }
th { position: sticky; top: 0; background: var(--bg); }
tr { cursor: pointer; }
tr.sel td { background: var(--sel); }
footer { color: var(--muted); font-size: 13px; margin-top: 16px; }
</style>
</head>
<body>
<main>
<h1>Pieces on the surface of a Platonic solid</h1>
<p class="sub">Smallest edge s for P unit pieces. Every drawn packing is certified; its score is rounded to 6 decimals. Drag the solid to turn it. Red dots are the vertices (cone points).</p>
<div class="controls">
<label>Solid <select id="solid"></select></label>
<label>Pieces <select id="N"></select></label>
<label>P <input id="P" type="number" min="1" step="1"></label>
<span><label><input type="radio" name="mode" id="fold" checked> fold</label> <label><input type="radio" name="mode" id="nofold"> nofold</label></span>
<span><label><input type="radio" name="view" id="v3d" checked> solid</label> <label><input type="radio" name="view" id="vnet"> net</label></span>
</div>
<div class="grid">
<div><canvas id="cv" aria-label="Packing drawing"></canvas></div>
<div><div id="score"></div><div id="info"></div><div class="tablewrap"><table id="table"></table></div><p class="sub">* exact tiling. gain = how much smaller s gets with folding.</p></div>
</div>
<footer>PolyPack surface research build. Data: data/surface/records.json (${records.length} records, generated ${doc.generated}). Method and proofs: docs/spaces/SURFACE.md.</footer>
</main>
<script>const SURFACE_DATA = ${JSON.stringify({ records, nets })};</script>
<script>${js}</script>
</body>
</html>
`;
const out = new URL("../viz/index.html", import.meta.url);
writeFileSync(out, html);
console.log("wrote", out.pathname, (html.length / 1024).toFixed(0), "KiB");
