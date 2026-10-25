/**
 * Builds packages/polyhedra/viz/index.html: a standalone viewer (no external scripts) with the records of
 * data/polyhedra/records.json embedded at display precision and the drawing code bundled by esbuild.
 *
 * Usage: npx tsx packages/polyhedra/scripts/build-viz.ts [records.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("../../../", import.meta.url);
const recPath = process.argv[2] ?? new URL("data/polyhedra/records.json", root).pathname;
const doc = JSON.parse(readFileSync(recPath, "utf8"));

// 5 significant digits are plenty for drawing (the full-precision poses are in the records file)
const r5 = (x: number) => Number(x.toPrecision(5));
const records: Record<string, unknown[]> = {};
for (const r of doc.records) {
  (records[r.code] ??= []).push({
    n: r.P,
    s: r.score_cert,
    d: r.display,
    b: r.bound.value,
    w: r.wiki.s_full,
    f: r.found_by,
    ...(r.certificate_refined_by ? { cr: r.certificate_refined_by } : {}),
    ...(r.found_by === "PolyPack research" && r.method ? { m: r.method } : {}),
    src: r.source,
    lit: (r.literature ?? []).map((l: { value: number; source: string; url?: string; precision?: number }) => ({
      v: l.value,
      s: l.source,
      ...(l.url ? { u: l.url } : {}),
      ...(l.precision ? { q: l.precision } : {}),
    })),
    p: r.config.pieces.flat().map(r5),
  });
}

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
<title>PolyPack 3D in 3D</title>
<style>
:root { --bg: #fbfaf7; --fg: #1d1d1b; --muted: #6b6a66; --line: #d9d6cf; --panel: #ffffff; --accent: #2b6cb0; --sel: #fff4d6; --good: #2f855a; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #15171a; --fg: #e8e6e1; --muted: #9b9a95; --line: #33363b; --panel: #1c1f23; --accent: #7fb3f0; --sel: #3a3322; --good: #68d391; color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #15171a; --fg: #e8e6e1; --muted: #9b9a95; --line: #33363b; --panel: #1c1f23; --accent: #7fb3f0; --sel: #3a3322; --good: #68d391; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.35rem; margin: 0 0 4px; }
p.lede { margin: 0 0 14px; color: var(--muted); max-width: 72ch; }
.layout { display: flex; gap: 18px; flex-wrap: wrap; align-items: flex-start; }
.viewer { flex: 1 1 420px; min-width: 0; }
.side { flex: 1 1 380px; min-width: 0; }
.controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
button, select { font: inherit; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; max-width: 100%; }
button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
canvas { width: 100%; aspect-ratio: 1 / 1; max-height: 75vh; display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; touch-action: none; }
a { color: var(--accent); }
.big { font-size: 1.4rem; font-variant-numeric: tabular-nums; }
#info p { margin: 4px 0; }
.muted { color: var(--muted); font-size: 0.88rem; }
.notes { margin: 4px 0 0; padding-left: 18px; font-size: 0.88rem; color: var(--muted); }
.better { color: var(--good); }
.tablewrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); max-height: 50vh; margin-top: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 0.86rem; font-variant-numeric: tabular-nums; }
th, td { padding: 3px 8px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line); }
th { position: sticky; top: 0; background: var(--panel); }
tbody tr { cursor: pointer; }
tbody tr.sel { background: var(--sel); }
footer { margin-top: 18px; font-size: 0.82rem; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>3D in 3D: polyhedra packed in polyhedra</h1>
<p class="lede">P equal solids in the smallest scaled copy s C of a container solid. Every configuration here is proven valid by an exact certifier at its certified s, shown rounded to 6 decimals. Drag to turn, wheel or pinch to zoom, double click to reset.</p>
<div class="layout">
<section class="viewer">
<div class="controls">
<select id="problem" aria-label="Problem"></select>
<label>P <select id="n" aria-label="Number of pieces"></select></label>
<button id="spin" aria-pressed="true">Spin</button>
<button id="theme">Theme: auto</button>
</div>
<canvas id="cv" aria-label="Packing drawing; arrow keys turn it"></canvas>
</section>
<section class="side">
<div id="info"></div>
<div class="tablewrap"><table id="table"></table></div>
</section>
</div>
<footer>PolyPack 3D in 3D build. Data: data/polyhedra/records.json (${doc.records.length} records, generated ${doc.generated}), from polyhedrainpolyhedra.wiki (alejandrozu/platonic-packing, MIT) and the sources each record cites; see docs/spaces/POLYHEDRA.md and THIRD_PARTY_NOTICES.md.</footer>
</main>
<script>const POLYHEDRA_DATA = ${JSON.stringify({ generated: doc.generated, records })};</script>
<script>${js}</script>
</body>
</html>
`;
const out = new URL("../viz/index.html", import.meta.url).pathname;
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1e6).toFixed(2)} MB, ${doc.records.length} records)`);
