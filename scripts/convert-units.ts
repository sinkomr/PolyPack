// The unit change of 2026-10-27: disk and ball pieces have diameter 1 (they had radius 1), and a circle or
// ball container is scored by its diameter (it was scored by its radius). Converts the stored data exactly:
// every factor is 1/2, 1, 2 (lengths) or 1/4, 4 (squared lengths, curvature), all powers of two.
//
//   npx tsx scripts/convert-units.ts            convert data/** in place (refuses if a file already says units: "diameter")
//   npx tsx scripts/convert-units.ts --reverse  convert back (refuses if a file does not say it)
//   npx tsx scripts/convert-units.ts --check    only report what a conversion would touch
//
// What is converted (per record, only where the record has a disk piece N = 0, or a circle container M = 0):
//   data/records.json, data/sources/{packomania,friedman,constructed}.json   the 2D records (scripts/units.ts: rule per (N, M))
//   data/corpus/*.json                                                       the fixtures with a disk or a circle container
//   data/surface/records.json and certificates/*.json.gz                     edge s, scores, centres, bounds; clearances (squared: 1/4)
//   data/sphere/records.json, certification.json                             rho and its bounds; K_cert (x4); angles, quaternions, clearances unchanged
//   data/torus/records.json, certificates/*.json, raw/**.json                 lattice, centres, scores, bounds and literature values
// Already in diameter units when this script was written (verified by --check, never changed here): data/curved
// (disk records archived, circle containers scored by diameter) and data/boundary (balls). data/polyhedra has no disks.
// `display` is recomputed (nearest at 6 decimals from the exact binary64 value, ties to even) wherever it is a rounding of
// a certified score; a printed literature value is converted by exact decimal arithmetic (scripts/units.ts).
// The generated fixtures data/corpus/generated and data/corpus/invalid are not converted: scripts/export-corpus.ts writes them.
// After a forward conversion run, in this order (the texts that quote numbers are re-derived by the repository's own code):
//   npx tsx scripts/export-corpus.ts
//   python3 python/torus/build_records.py --refresh data/torus/records.json --out <dir>   then copy <dir>/records.json over it
//   npx tsx packages/surface/scripts/build-planar-values.ts
// --reverse restores every number exactly (a test of the round trip: the 2D files come back byte for byte, surface/records.json
// up to integral floats that it writes as "-1" and the reverse writes "-1.0"; the torus texts re-derived by --refresh stay).
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  type Loaded,
  F,
  fl,
  isNum,
  readJson,
  sc,
  val,
  writeJson,
} from "./units-json";
import { UNITS_HEADER, convertNote, centreFactor, display6, doubleDecimal, halveDecimal, scalePrinted, scoreFactor, unscalePrinted } from "./units";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const reverse = args.includes("--reverse");
const checkOnly = args.includes("--check");
const dir: 1 | -1 = reverse ? -1 : 1;
/** Length of a disk piece (and a disk-scored container): x 1/2 forward, x 2 back. */
const L = dir === 1 ? 0.5 : 2;
/** Squared lengths. */
const L2 = L * L;
const HEADER = UNITS_HEADER;

const counts: Record<string, number> = {};
const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

const path = (p: string) => join(ROOT, p);
const listJson = (root: string, ext = ".json"): string[] =>
  !existsSync(root)
    ? []
    : readdirSync(root, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listJson(join(root, e.name), ext) : e.name.endsWith(ext) ? [join(root, e.name)] : [],
      );

/** Insert units and units_date after `generated` (or first), or remove them. */
function setHeader(data: any, on: boolean): void {
  if (on) {
    const keys = Object.keys(data);
    const rest: Record<string, unknown> = {};
    for (const k of keys) if (k !== "units" && k !== "units_date") rest[k] = data[k];
    for (const k of keys) delete data[k];
    const at = Math.min(keys.includes("generated") ? 1 : 0, keys.length);
    const entries = Object.entries(rest);
    for (const [k, v] of entries.slice(0, at)) data[k] = v;
    data.units = HEADER.units;
    data.units_date = HEADER.units_date;
    for (const [k, v] of entries.slice(at)) data[k] = v;
  } else {
    delete data.units;
    delete data.units_date;
  }
}
const isConverted = (data: any) => data.units === "diameter";

// ---------- 2D records ----------

function convert2D(r: any): boolean {
  const sf = dir === 1 ? scoreFactor(r.N, r.M) : 1 / scoreFactor(r.N, r.M);
  const cf = dir === 1 ? centreFactor(r.N) : 1 / centreFactor(r.N);
  const touched = sf !== 1 || cf !== 1 || r.N === 0 || r.M === 0;
  if (r.value !== undefined) r.value = sc(r.value, sf);
  if (r.display !== undefined && sf !== 1) {
    const p = (dir === 1 ? scalePrinted : unscalePrinted)(r.display, r.display_precision, dir === 1 ? sf : 1 / sf);
    r.display = p.display;
    r.display_precision = p.precision;
  }
  if (r.pieces && cf !== 1) for (const p of r.pieces) ((p.x = sc(p.x, cf)), (p.y = sc(p.y, cf)));
  for (const k of ["conversion_note", "coordinates_note", "note"]) if (r[k] !== undefined) r[k] = convertNote(r[k], dir);
  // build-records.ts appends the digits of another source to the note: "More digits (3.4142135624) from ..."; that
  // printed value is the other source's, in the record's unit, so it converts with the record
  if (sf !== 1 && typeof r.conversion_note === "string") {
    r.conversion_note = r.conversion_note.replace(/More digits \(([^)]+)\)/g, (_m: string, shown: string) => {
      const d = dir === 1 ? scalePrinted(shown, 12, sf).display : unscalePrinted(shown, r.display_precision, 1 / sf).display;
      return `More digits (${d})`;
    });
  }
  return touched;
}

function convertRecords2D(file: string): { data: any; l: Loaded } {
  const l = readJson(file);
  for (const r of l.data.records) if (convert2D(r)) bump(`2D ${relative(ROOT, file)}: N=0 or M=0`);
  return { data: l.data, l };
}

/** Where a conversion changes display_precision of a record, constructed.json must follow (build-records checks against it). */
function convertConstructed(file: string, precisionOf: (N: number, M: number, P: number) => number | undefined): Loaded {
  const l = readJson(file);
  for (const c of l.data.constructions) {
    const sf = dir === 1 ? scoreFactor(c.N, c.M) : 1 / scoreFactor(c.N, c.M);
    const cf = dir === 1 ? centreFactor(c.N) : 1 / centreFactor(c.N);
    c.published = sc(c.published, sf);
    c.score = sc(c.score, sf);
    if (cf !== 1) for (const p of c.pieces) ((p.x = sc(p.x, cf)), (p.y = sc(p.y, cf)));
    const prec = precisionOf(c.N, c.M, c.P);
    if (prec !== undefined) c.display_precision = prec;
    if (sf !== 1 || cf !== 1) bump("2D constructions");
  }
  return l;
}

// ---------- surface ----------

/** Python's sig_down(x, 3) in python/surface/cert.py: round a positive lower bound down to 3 significant digits. */
function sigDown3(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return x;
  const e = Math.floor(Math.log10(x)) - 3 + 1;
  let q = Math.floor(x / 10 ** e) * 10 ** e;
  if (!(q <= x)) q -= 10 ** e;
  return Number(q.toPrecision(3));
}
/** A stored certificate clearance, scaled by f (a squared length: 1/4 forward) and, when it shrinks, rounded down again. */
const clearance = (x: number | F, f: number): number | F => {
  const v = val(x) * f;
  const out = f < 1 ? sigDown3(v) : v;
  return x instanceof F ? fl(out) : out;
};

function convertSurfaceRecord(r: any): void {
  r.s = sc(r.s, L);
  r.score_float = sc(r.score_float, L);
  r.score_cert = sc(r.score_cert, L);
  r.display = display6(val(r.score_cert));
  if (isNum(r.nofold_score_cert)) r.nofold_score_cert = sc(r.nofold_score_cert, L);
  for (const p of r.pieces) ((p.x = sc(p.x, L)), (p.y = sc(p.y, L)));
  if (r.bound) for (const k of ["value", "area", "one_piece"]) if (isNum(r.bound[k])) r.bound[k] = sc(r.bound[k], L);
  // the 2D value a nofold record was built from (scripts/units.ts: disks in a polygon, factor 1/2)
  for (const s of r.sources ?? []) if (isNum(s.published_value)) s.published_value = sc(s.published_value, L);
}

function convertSurface(): Loaded[] {
  const out: Loaded[] = [];
  const rec = readJson(path("data/surface/records.json"));
  for (const r of rec.data.records) if (r.N === 0) (convertSurfaceRecord(r), bump("surface records"));
  rec.data.conventions.units =
    dir === 1 ? "polygon pieces have side 1, disks (N = 0) diameter 1 (radius 1/2)" : "polygon pieces have side 1, disks (N = 0) radius 1";
  setHeader(rec.data, dir === 1);
  out.push(rec);
  writers.push(() => writeJson(path("data/surface/records.json"), rec));
  for (const f of listJson(path("data/surface/certificates"), ".json.gz")) {
    const cert = readJson(f, true);
    let any = false;
    for (const c of Object.values<any>(cert.data)) {
      if (c.N !== 0) continue;
      any = true;
      bump("surface certificates");
      c.s = sc(c.s, L);
      c.score_cert = sc(c.score_cert, L);
      c.display = display6(val(c.score_cert));
      if (c.mode === "fold") {
        for (const row of c.cone ?? []) if (row[1] !== null) row[1] = clearance(row[1], L2);
        for (const row of c.loops ?? []) row[3] = clearance(row[3], L2);
        for (const row of c.pairs ?? []) row[3] = clearance(row[3], L2);
      } else {
        if (isNum(c.wall_clearance_min)) c.wall_clearance_min = clearance(c.wall_clearance_min, L);
        for (const row of c.pairs ?? []) if (row[3] === "dist") row[4] = clearance(row[4], L2);
      }
    }
    if (any) writers.push(() => writeJson(f, cert, true));
  }
  return out;
}

// ---------- sphere ----------

const SPHERE_TEXT: [string, string][] = [
  ["CALC: P caps of angular radius 1/rho have total area <= 4 pi", "CALC: P caps of angular radius 1/(2 rho) (diameter 1) have total area <= 4 pi"],
  ["Fejes Toth 1943 bound on the minimal angle, rho >= 2/theta_FT", "Fejes Toth 1943 bound on the minimal angle, rho >= 1/theta_FT"],
  ["EST: published Tammes optimum, rho >= 2/theta_P", "EST: published Tammes optimum, rho >= 1/theta_P"],
  ["touching along the equator: rho = 2/pi exactly [CALC].", "touching along the equator: rho = 1/pi exactly [CALC]."],
];
function patchText(s: string, pairs: [string, string][]): string {
  for (const [a, b] of pairs) s = dir === 1 ? s.split(a).join(b) : s.split(b).join(a);
  return s;
}
function patchStrings(o: any, pairs: [string, string][]): void {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "string") o[k] = patchText(v, pairs);
    else if (v && typeof v === "object") patchStrings(v, pairs);
  }
}

function convertSphere(): void {
  const rec = readJson(path("data/sphere/records.json"));
  const halve = (b: any) => b && isNum(b.value) && (b.value = sc(b.value, L));
  for (const r of rec.data.records) {
    if (r.N !== 0) continue;
    bump("sphere records");
    r.score_float = sc(r.score_float, L);
    r.score_cert = sc(r.score_cert, L);
    r.display = display6(val(r.score_cert));
    // K = 1/rho^2: four times larger when rho halves
    if (isNum(r.K_cert)) r.K_cert = sc(r.K_cert, 1 / L2);
    r.config.rho = sc(r.config.rho, L);
    halve(r.bound);
    for (const b of r.bounds ?? []) halve(b);
    if (r.literature && isNum(r.literature.rho)) r.literature.rho = sc(r.literature.rho, L);
    // angles, quaternions, densities, relative gaps and the certificate (clearances are cosines) do not change
    patchStrings(r, SPHERE_TEXT);
  }
  const c = rec.data.conventions;
  c.problem_id = patchText(c.problem_id, [["N = 0 disks of geodesic radius 1", "N = 0 disks of geodesic diameter 1 (radius 1/2)"]]);
  c.units =
    dir === 1
      ? "lengths in units of the piece (side 1 / disk diameter 1); poses on the unit sphere"
      : "lengths in units of the piece (side 1 / disk radius 1); poses on the unit sphere";
  setHeader(rec.data, dir === 1);
  writers.push(() => writeJson(path("data/sphere/records.json"), rec));
  const cert = readJson(path("data/sphere/certification.json"));
  for (const r of cert.data.results) if (/^sphere\/0\//.test(r.id)) ((r.rho_cert = sc(r.rho_cert, L)), bump("sphere certification rows"));
  setHeader(cert.data, dir === 1);
  writers.push(() => writeJson(path("data/sphere/certification.json"), cert));
}

// ---------- torus ----------

function convertTorus(): void {
  const rec = readJson(path("data/torus/records.json"));
  for (const r of rec.data.records) {
    if (r.N !== 0) continue;
    bump("torus records");
    r.score_float = sc(r.score_float, L);
    r.score_cert = sc(r.score_cert, L);
    r.display = display6(val(r.score_cert));
    const lat = r.configuration.lattice;
    if ("L" in lat) lat.L = sc(lat.L, L);
    else for (const b of [lat.b1, lat.b2]) ((b[0] = sc(b[0], L)), (b[1] = sc(b[1], L)));
    for (const p of r.configuration.poses) ((p[0] = sc(p[0], L)), (p[1] = sc(p[1], L)));
    r.bound.value = sc(r.bound.value, L);
    if (r.exact) r.exact.value = sc(r.exact.value, L);
    for (const l of r.literature ?? []) if (isNum(l.value)) l.value = sc(l.value, L);
    if (typeof r.min_clearance_shrunk === "string") r.min_clearance_shrunk = (dir === 1 ? halveDecimal : doubleDecimal)(r.min_clearance_shrunk);
  }
  const c = rec.data.conventions;
  c.pieces = c.pieces.replace(dir === 1 ? "N = 0: disk of radius 1" : "N = 0: disk of diameter 1 (radius 1/2)", dir === 1 ? "N = 0: disk of diameter 1 (radius 1/2)" : "N = 0: disk of radius 1");
  c.units = dir === 1 ? "polygon side 1, disk diameter 1" : "polygon side 1, disk radius 1";
  setHeader(rec.data, dir === 1);
  writers.push(() => writeJson(path("data/torus/records.json"), rec));
  for (const f of listJson(path("data/torus/certificates"))) {
    const cert = readJson(f);
    if (cert.data.N !== 0) continue;
    bump("torus certificates");
    const d = cert.data;
    const half = dir === 1 ? halveDecimal : doubleDecimal;
    d.score_cert_upper = half(d.score_cert_upper);
    d.score_upper_float = sc(d.score_upper_float, L);
    if (isNum(d.score_cert_checked)) d.score_cert_checked = sc(d.score_cert_checked, L);
    d.min_clearance_lb = half(d.min_clearance_lb);
    writers.push(() => writeJson(f, cert));
  }
  for (const f of listJson(path("data/torus/raw"))) {
    const raw = readJson(f);
    if (raw.data.N !== 0) continue;
    bump("torus raw files");
    const d = raw.data;
    d.score = sc(d.score, L);
    d.params = d.params.map((x: any) => sc(x, L));
    d.basis = d.basis.map((v: any[]) => v.map((x) => sc(x, L)));
    d.poses = d.poses.map(([x, y, t]: any[]) => [sc(x, L), sc(y, L), t]);
    if (isNum(d.min_sep)) d.min_sep = sc(d.min_sep, L);
    writers.push(() => writeJson(f, raw));
  }
}

// ---------- corpus ----------

function convertCorpus(): void {
  for (const f of readdirSync(path("data/corpus")).filter((n) => n.endsWith(".json"))) {
    const file = path(`data/corpus/${f}`);
    const l = readJson(file);
    const cfg = l.data.config;
    if (!(cfg.N === 0 || cfg.M === 0)) continue;
    if (isConverted(l.data) === (dir === 1)) throw new Error(`${f}: already ${dir === 1 ? "converted" : "in radius units"}`);
    const sf = dir === 1 ? scoreFactor(cfg.N, cfg.M) : 1 / scoreFactor(cfg.N, cfg.M);
    const cf = dir === 1 ? centreFactor(cfg.N) : 1 / centreFactor(cfg.N);
    for (const p of cfg.pieces) ((p.x = sc(p.x, cf)), (p.y = sc(p.y, cf)));
    for (const k of ["expected_score", "oriented_score"]) if (isNum(l.data[k])) l.data[k] = sc(l.data[k], sf);
    if (dir === 1) l.data.units = "diameter";
    else delete l.data.units;
    bump("corpus fixtures");
    writers.push(() => writeJson(file, l));
  }
}

// ---------- verification of the files that were converted by their own parts ----------

function checkConvertedElsewhere(): void {
  for (const f of ["data/curved/records.json", "data/boundary/records.json"]) {
    const l = readJson(path(f));
    if (dir === 1 && l.data.units !== "diameter") throw new Error(`${f} should already say units: "diameter"`);
  }
}

// ---------- main ----------

const writers: (() => void)[] = [];

function main(): void {
  // refuse to run twice: every file with a header must be in the state the direction expects
  const recordsHeader = readJson(path("data/records.json")).data;
  for (const f of [
    "data/records.json",
    "data/surface/records.json",
    "data/sphere/records.json",
    "data/torus/records.json",
    "data/sources/packomania.json",
    "data/sources/friedman.json",
  ]) {
    const h = readJson(path(f)).data;
    if (isConverted(h) === (dir === 1)) {
      throw new Error(
        `${f} ${dir === 1 ? 'already says units: "diameter"; refusing to convert twice' : 'does not say units: "diameter"; nothing to reverse'}`,
      );
    }
  }
  checkConvertedElsewhere();

  // 2D: records.json and the sources; the precisions of constructed.json follow the records
  const oldRecords = recordsHeader.records as any[];
  const keyOf = (N: number, M: number, P: number) => `${N}/${M}/${P}`;
  const precisionBy = new Map<string, number>();
  for (const r of oldRecords) {
    const sf = dir === 1 ? scoreFactor(r.N, r.M) : 1 / scoreFactor(r.N, r.M);
    const p = (dir === 1 ? scalePrinted : unscalePrinted)(r.display, r.display_precision, dir === 1 ? sf : 1 / sf);
    precisionBy.set(keyOf(r.N, r.M, r.P), p.precision);
  }
  for (const f of ["data/records.json", "data/sources/packomania.json", "data/sources/friedman.json"]) {
    const { data, l } = convertRecords2D(path(f));
    setHeader(data, dir === 1);
    writers.push(() => writeJson(path(f), l));
  }
  for (const f of readdirSync(path("data/sources")).filter((n) => n.endsWith(".json"))) {
    if (["data/sources/packomania.json", "data/sources/friedman.json", "data/sources/constructed.json"].some((x) => x.endsWith(f))) continue;
    const l = readJson(path(`data/sources/${f}`));
    const hit = (l.data.records ?? []).filter((r: any) => r.N === 0 || r.M === 0);
    if (hit.length) throw new Error(`data/sources/${f} has ${hit.length} records with a disk or a circle container; convert-units.ts does not know them`);
  }
  const constructed = convertConstructed(path("data/sources/constructed.json"), (N, M, P) => precisionBy.get(keyOf(N, M, P)));
  setHeader(constructed.data, dir === 1);
  writers.push(() => writeJson(path("data/sources/constructed.json"), constructed));

  convertCorpus();
  convertSurface();
  convertSphere();
  convertTorus();

  console.log(JSON.stringify(counts, null, 1));
  if (checkOnly) return;
  for (const w of writers) w();
  console.log(`${dir === 1 ? "converted to" : "restored"} ${dir === 1 ? "diameter" : "radius"} units`);
}
main();
