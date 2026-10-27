// Compares the data before and after the unit change (scripts/convert-units.ts) record by record and reports
// the exact factor of each quantity: 1/2, 1 or 2 for lengths, 1/4 for squared lengths, 4 for K, and 1 for
// statuses, citations and everything else that must not change.
//
//   npx tsx scripts/check-units-conversion.ts [git ref of the radius-1 data, default HEAD]
//
// It only reads (git show <ref>:<path>), and exits non-zero when any record departs from its rule.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { centreFactor, scoreFactor } from "./units";

const REF = process.argv[2] ?? "HEAD";
const GIT = "/Library/Developer/CommandLineTools/usr/bin/git";
const show = (path: string): Buffer => execFileSync(GIT, ["show", `${REF}:${path}`], { maxBuffer: 1 << 30 });
const oldJson = (path: string, gz = false) => JSON.parse((gz ? gunzipSync(show(path)) : show(path)).toString("utf8"));
const newJson = (path: string, gz = false) => JSON.parse((gz ? gunzipSync(readFileSync(path)) : readFileSync(path)).toString("utf8"));
const problems: string[] = [];
const fail = (what: string) => problems.length < 40 && problems.push(what);
const num = (x: any) => Number(x);

/** new = old * f exactly (binary64), for numbers, and recursively for lists of numbers. */
function same(a: any, b: any, f: number, where: string): void {
  if (a === undefined && b === undefined) return;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return void fail(`${where}: shapes differ`);
    a.forEach((x, i) => same(x, b[i], f, `${where}[${i}]`));
  } else if (typeof a === "number") {
    if (num(b) !== a * f) fail(`${where}: ${a} * ${f} != ${b}`);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${where}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
const unchanged = (a: any, b: any, where: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${where}: not unchanged`);
};

const table: [string, number, string][] = [];

// ---------- 2D ----------
{
  const o = oldJson("data/records.json").records as any[];
  const n = newJson("data/records.json").records as any[];
  if (o.length !== n.length) fail(`2D: ${o.length} records became ${n.length}`);
  const factors = new Map<string, number>();
  o.forEach((a, i) => {
    const b = n[i];
    const id = `${a.N}/${a.M}/${a.P}`;
    if (a.N !== b.N || a.M !== b.M || a.P !== b.P) return void fail(`2D ${id}: order or key differs`);
    const f = scoreFactor(a.N, a.M);
    const c = centreFactor(a.N);
    same(a.value, b.value, f, `2D ${id} value`);
    a.pieces?.forEach((p: any, k: number) => (same(p.x, b.pieces[k].x, c, `2D ${id} x`), same(p.y, b.pieces[k].y, c, `2D ${id} y`), unchanged(p.theta, b.pieces[k].theta, `2D ${id} theta`)));
    for (const k of ["status", "source_name", "source_url", "picture_url", "accessed", "citation", "container_phi", "display_precision"]) unchanged(a[k], b[k], `2D ${id} ${k}`);
    if (!(a.N === 0 || a.M === 0)) unchanged(a, b, `2D ${id}`);
    const key = a.N === 0 ? (a.M === 0 ? "disks in a circle (x1)" : "disks in a polygon (x1/2)") : a.M === 0 ? "polygons in a circle (x2)" : "polygon in polygon (x1)";
    factors.set(key, (factors.get(key) ?? 0) + 1);
  });
  for (const [k, v] of factors) table.push(["2D data/records.json", v, k]);
}

// ---------- surface ----------
{
  const o = oldJson("data/surface/records.json").records as any[];
  const n = newJson("data/surface/records.json").records as any[];
  let disks = 0;
  o.forEach((a, i) => {
    const b = n[i];
    if (a.id !== b.id) return void fail(`surface ${a.id}: order differs`);
    if (a.N !== 0) return unchanged(a, b, `surface ${a.id}`);
    disks++;
    for (const k of ["s", "score_float", "score_cert", "nofold_score_cert"]) same(a[k], b[k], 0.5, `surface ${a.id} ${k}`);
    a.pieces.forEach((p: any, k: number) => (same(p.x, b.pieces[k].x, 0.5, `surface ${a.id} x`), same(p.y, b.pieces[k].y, 0.5, `surface ${a.id} y`), unchanged([p.face, p.theta], [b.pieces[k].face, b.pieces[k].theta], `surface ${a.id} face/theta`)));
    for (const k of ["value", "area", "one_piece"]) same(a.bound?.[k], b.bound?.[k], 0.5, `surface ${a.id} bound.${k}`);
    for (const k of ["status", "eps", "gap_rel", "gap_to_bound", "fold_gain", "method", "kind", "seed", "budget", "warm_starts", "derived_from", "certificate"]) unchanged(a[k], b[k], `surface ${a.id} ${k}`);
    (a.sources ?? []).forEach((s: any, k: number) => (same(s.published_value, b.sources[k].published_value, 0.5, `surface ${a.id} published_value`), unchanged({ ...s, published_value: 0 }, { ...b.sources[k], published_value: 0 }, `surface ${a.id} source`)));
    if (b.display !== undefined && Number(b.display) !== Number(b.score_cert.toFixed(6))) fail(`surface ${a.id}: display ${b.display} for ${b.score_cert}`);
  });
  table.push(["surface/records.json", disks, "disk records (x1/2)"]);
  table.push(["surface/records.json", o.length - disks, "polygon records (unchanged)"]);
}

// ---------- sphere ----------
{
  const o = oldJson("data/sphere/records.json").records as any[];
  const n = newJson("data/sphere/records.json").records as any[];
  let disks = 0;
  o.forEach((a, i) => {
    const b = n[i];
    if (a.id !== b.id) return void fail(`sphere ${a.id}: order differs`);
    if (a.N !== 0) return unchanged(a, b, `sphere ${a.id}`);
    disks++;
    for (const k of ["score_float", "score_cert"]) same(a[k], b[k], 0.5, `sphere ${a.id} ${k}`);
    same(a.K_cert, b.K_cert, 4, `sphere ${a.id} K_cert`);
    same(a.config.rho, b.config.rho, 0.5, `sphere ${a.id} rho`);
    unchanged(a.config.pieces, b.config.pieces, `sphere ${a.id} poses`);
    same(a.bound.value, b.bound.value, 0.5, `sphere ${a.id} bound`);
    a.bounds.forEach((x: any, k: number) => same(x.value, b.bounds[k].value, 0.5, `sphere ${a.id} bounds[${k}]`));
    same(a.literature?.rho, b.literature?.rho, 0.5, `sphere ${a.id} literature.rho`);
    for (const k of ["status", "gap_rel", "density_float", "bound_gap_rel", "certificate", "method", "seed", "budget"]) unchanged(a[k], b[k], `sphere ${a.id} ${k}`);
    unchanged(a.literature && { ...a.literature, rho: 0 }, b.literature && { ...b.literature, rho: 0 }, `sphere ${a.id} literature`);
  });
  table.push(["sphere/records.json", disks, "disk records (rho x1/2, K x4)"]);
  table.push(["sphere/records.json", o.length - disks, "polygon records (unchanged)"]);
}

// ---------- torus ----------
{
  const o = oldJson("data/torus/records.json").records as any[];
  const n = newJson("data/torus/records.json").records as any[];
  let disks = 0;
  o.forEach((a, i) => {
    const b = n[i];
    if (a.problem !== b.problem) return void fail(`torus ${a.problem}: order differs`);
    if (a.N !== 0) return unchanged(a, b, `torus ${a.problem}`);
    disks++;
    for (const k of ["score_float", "score_cert"]) same(a[k], b[k], 0.5, `torus ${a.problem} ${k}`);
    const la = a.configuration.lattice;
    same(la.L ?? [...la.b1, ...la.b2], b.configuration.lattice.L ?? [...b.configuration.lattice.b1, ...b.configuration.lattice.b2], 0.5, `torus ${a.problem} lattice`);
    a.configuration.poses.forEach((p: number[], k: number) => (same([p[0], p[1]], [b.configuration.poses[k][0], b.configuration.poses[k][1]], 0.5, `torus ${a.problem} pose`), unchanged(p[2], b.configuration.poses[k][2], `torus ${a.problem} theta`)));
    same(a.bound.value, b.bound.value, 0.5, `torus ${a.problem} bound`);
    same(a.exact?.value, b.exact?.value, 0.5, `torus ${a.problem} exact`);
    a.literature.forEach((l: any, k: number) => same(l.value, b.literature[k].value, 0.5, `torus ${a.problem} literature[${k}]`));
    for (const k of ["status", "density", "eps", "certificate", "method", "seed", "budget", "search_label"]) unchanged(a[k], b[k], `torus ${a.problem} ${k}`);
    // the citation (status, short name, source, url, doi, date) is unchanged; a note or proof text that quotes an L is re-derived
    // by python/torus/build_records.py --refresh from the converted table (python/torus/literature_torus.py)
    const cite = (l: any) => ({ status: l.status, short: l.short, source: l.source, url: l.url, accessed: l.accessed, doi: l.doi });
    a.literature.forEach((l: any, k: number) => unchanged(cite(l), cite(b.literature[k]), `torus ${a.problem} literature[${k}] citation`));
  });
  table.push(["torus/records.json", disks, "disk records (x1/2)"]);
  table.push(["torus/records.json", o.length - disks, "polygon records (unchanged)"]);
}

// ---------- the files converted by their own parts ----------
for (const f of ["data/curved/records.json", "data/boundary/records.json"]) {
  const n = newJson(f);
  if (n.units !== "diameter") fail(`${f}: header does not say units: diameter`);
  table.push([f, n.records.length, `records, header says units ${n.units}`]);
}

for (const [file, count, what] of table) console.log(`${file.padEnd(26)} ${String(count).padStart(5)}  ${what}`);
if (problems.length) {
  console.error(`\n${problems.length}${problems.length >= 40 ? "+" : ""} departures:\n` + problems.join("\n"));
  process.exit(1);
}
console.log("\nevery record is old * the factor of its rule, exactly; statuses and citations are unchanged");
