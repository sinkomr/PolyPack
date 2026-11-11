// Compares the Rust port of the polyhedra family with the TypeScript, case by case and field by field
// (native/PORTING.md, "Comparing a port with its source").
//
//   node native/tools/polyhedra-compare.mjs OUTDIR
//
// OUTDIR holds what native/tools/polyhedra-ref.mts wrote (index.jsonl, ref.jsonl, ts-times.json,
// catalogue-ref.jsonl) and what the example polyhedradiff wrote (rust.jsonl, rust-times.json, catalogue-rust.jsonl).
//
// A case is "identical" when the two answers are the same bytes. Otherwise the answers are compared field by
// field: booleans, counts, indices and the text of every message must be the same; a number (in a field or inside
// a message) may differ by 1e-6 relative or 1e-12 absolute, and the case is then "equal up to digits". Anything
// else is "DIFFERENT" and is printed. The exit status is 1 when a case or a catalogue line is DIFFERENT.
import { readFileSync } from "node:fs";

const dir = process.argv[2];
if (!dir) throw new Error("usage: polyhedra-compare.mjs OUTDIR");
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter((l) => l.length > 0);
const SOLID_FAMILY = new Map();
{
  // the families of the solids by code, from the catalogue the reference wrote
  for (const l of lines("catalogue-ref.jsonl")) {
    if (!l.startsWith('{"k":"solid_names_list"')) continue;
    for (const [, code, family] of JSON.parse(l).v) SOLID_FAMILY.set(code, family);
  }
}

const NUMBER = /-?(?:\d+\.?\d*(?:e[-+]?\d+)?|Infinity)|NaN/g;
/** Two numbers agree: the same value, or within 1e-6 relative or 1e-12 absolute. */
function near(a, b) {
  if (Object.is(a, b) || a === b) return true;
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  const d = Math.abs(a - b);
  return d <= 1e-12 || d <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
}
/** Two texts are the same after each number is replaced by a placeholder, and their numbers agree. */
function textNear(a, b) {
  if (a === b) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.replace(NUMBER, "#") !== b.replace(NUMBER, "#")) return false;
  const x = a.match(NUMBER) ?? [];
  const y = b.match(NUMBER) ?? [];
  // whole numbers (indices, counts, the digits of a hash) must be the same; the tolerance is for computed lengths
  const whole = /^-?\d+$/;
  return x.length === y.length && x.every((v, i) => (whole.test(v) && whole.test(y[i]) ? v === y[i] : near(Number(v), Number(y[i]))));
}
/** Deep comparison with the tolerance above on strings that hold numbers; returns the path of the first difference. */
function differ(a, b, path = "") {
  if (a === b) return null;
  if (typeof a === "string" && typeof b === "string") return textNear(a, b) ? null : `${path}: ${JSON.stringify(a)} | ${JSON.stringify(b)}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: ${a.length} items | ${b.length} items`;
    for (let i = 0; i < a.length; i++) {
      const d = differ(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join() !== kb.join()) return `${path}: fields ${ka.join()} | ${kb.join()}`;
    for (const k of ka) {
      const d = differ(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} | ${JSON.stringify(b)}`;
}

const index = lines("index.jsonl").map((l) => JSON.parse(l));
const ref = lines("ref.jsonl");
const rust = lines("rust.jsonl");
const tsTimes = JSON.parse(readFileSync(`${dir}/ts-times.json`, "utf8"));
const rsTimes = JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8"));
if (ref.length !== index.length || rust.length !== index.length) throw new Error(`misaligned: ${index.length} cases, ${ref.length} reference answers, ${rust.length} Rust answers`);

const familyOf = (code, which) => {
  for (let i = code.indexOf("in", 1); i !== -1; i = code.indexOf("in", i + 1)) {
    const p = SOLID_FAMILY.get(code.slice(0, i));
    const c = SOLID_FAMILY.get(code.slice(i + 2));
    if (p && c) return which === 0 ? p : c;
  }
  return "?";
};
const bucket = (n) => (n === null ? "no pieces" : n <= 10 ? "P 0-10" : n <= 50 ? "P 11-50" : n <= 100 ? "P 51-100" : n <= 200 ? "P 101-200" : n <= 400 ? "P 201-400" : "P 401-500");
const stat = () => ({ n: 0, same: 0, digits: 0, different: 0, parsed: 0, malformed: 0, valid9: 0, valid11: 0, timed: 0, ts: 0, rs: 0, tsMax: 0, rsMax: 0 });
const tables = { kind: new Map(), piece: new Map(), container: new Map(), pieces: new Map(), timing: new Map() };
const total = stat();
const examples = [];
const reasons = new Map();
const codes = new Set();
const pieceSolids = new Set();
const containerSolids = new Set();

for (let i = 0; i < index.length; i++) {
  const c = index[i];
  const a = ref[i];
  const b = rust[i];
  let verdict = "same";
  let why = null;
  const A = JSON.parse(a);
  if (a !== b) {
    const B = JSON.parse(b);
    if (A.id !== c.id || B.id !== c.id) throw new Error(`misaligned at line ${i + 1}`);
    why = differ(A, B);
    verdict = why ? "different" : "digits";
    if (why && examples.length < 40) examples.push(`case ${c.id} (${c.kind}, ${c.code}, P ${c.P}, ${c.n} pieces) ${why}`);
  }
  codes.add(c.code);
  const pf = familyOf(c.code, 0);
  const cf = familyOf(c.code, 1);
  pieceSolids.add(c.code.slice(0, c.code.lastIndexOf("in")));
  const groups = [
    [tables.kind, c.kind],
    [tables.piece, `piece: ${pf}`],
    [tables.container, `container: ${cf}`],
    [tables.pieces, bucket(c.n)],
    [tables.timing, `${pf}, ${bucket(c.n)}`],
    [null, null],
  ];
  for (const [map, key] of groups) {
    const s = map ? (map.get(key) ?? map.set(key, stat()).get(key)) : total;
    s.n++;
    s[verdict]++;
    if (A.parse?.ok) s.parsed++;
    else if (A.parse?.malformed) s.malformed++;
    if (A.v?.[0]?.valid) s.valid9++;
    if (A.v?.[1]?.valid) s.valid11++;
    if (tsTimes[i] !== null && rsTimes[i] !== null) {
      s.timed++;
      s.ts += tsTimes[i];
      s.rs += rsTimes[i];
      s.tsMax = Math.max(s.tsMax, tsTimes[i]);
      s.rsMax = Math.max(s.rsMax, rsTimes[i]);
    }
  }
  if ((tsTimes[i] === null) !== (rsTimes[i] === null)) examples.push(`case ${c.id}: timed on one side only`);
  // the reasons seen, with their numbers and indices replaced
  const seen = [...(A.parse?.errors ?? []), ...(A.v ?? []).flatMap((v) => v.errors ?? []), ...(A.v ?? []).filter((v) => v.threw).map((v) => `THREW ${v.threw}`)];
  for (const e of seen) {
    const k = e.replace(/\[\d+\]/g, "[i]").replace(/pieces? \d+( and \d+)?/g, (m) => m.replace(/\d+/g, "i")).replace(/expected \d+ pieces for this problem, got \d+/, "expected P pieces for this problem, got n").replace(/by -?[\d.e+-]+$/, "by X");
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
}

const us = (ns) => (ns / 1e3).toFixed(ns < 1e5 ? 2 : 0);
function show(title, map, timing = false) {
  console.log(`\n${title}`);
  if (timing) console.log(`${"group".padEnd(34)} ${"cases".padStart(6)} ${"TS mean us".padStart(11)} ${"Rust mean us".padStart(12)} ${"TS max us".padStart(10)} ${"Rust max us".padStart(11)} ${"TS/Rust".padStart(8)}`);
  else console.log(`${"group".padEnd(26)} ${"cases".padStart(6)} ${"identical".padStart(9)} ${"digits".padStart(6)} ${"DIFFERENT".padStart(9)} ${"parsed".padStart(6)} ${"malformed".padStart(9)} ${"valid 1e-9".padStart(10)} ${"valid 1e-11".padStart(11)}`);
  const rows = [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true }));
  for (const [k, s] of rows) {
    if (timing) {
      if (s.timed === 0) continue;
      console.log(`${String(k).padEnd(34)} ${String(s.timed).padStart(6)} ${us(s.ts / s.timed).padStart(11)} ${us(s.rs / s.timed).padStart(12)} ${us(s.tsMax).padStart(10)} ${us(s.rsMax).padStart(11)} ${(s.ts / s.rs).toFixed(1).padStart(8)}`);
    } else console.log(`${String(k).padEnd(26)} ${[s.n, s.same, s.digits, s.different, s.parsed, s.malformed, s.valid9, s.valid11].map((v, j) => String(v).padStart([6, 9, 6, 9, 6, 9, 10, 11][j])).join(" ")}`);
  }
}
show("BY KIND OF CASE", tables.kind);
show("BY PIECE FAMILY", tables.piece);
show("BY CONTAINER FAMILY", tables.container);
show("BY NUMBER OF PIECES", tables.pieces);
show("TOTAL", new Map([["all cases", total]]));
console.log(`\n${codes.size} problem codes; pieces of ${pieceSolids.size} solids`);
console.log("\nREASONS THE REFERENCE GAVE (numbers and indices replaced)");
for (const [k, n] of [...reasons].sort((x, y) => y[1] - x[1])) console.log(`${String(n).padStart(8)}  ${k}`);
show("TIMINGS BY KIND OF CASE (validate at 1e-9 on the parsed configuration, best of five per case)", tables.kind, true);
show("TIMINGS BY PIECE FAMILY AND NUMBER OF PIECES", tables.timing, true);
show("TIMINGS, ALL", new Map([["all timed cases", total]]), true);

// the catalogue
const catRef = lines("catalogue-ref.jsonl");
const catRust = lines("catalogue-rust.jsonl");
if (catRef.length !== catRust.length) throw new Error(`catalogue: ${catRef.length} reference lines, ${catRust.length} Rust lines`);
const cat = new Map();
let catDifferent = 0;
for (let i = 0; i < catRef.length; i++) {
  const A = JSON.parse(catRef[i]);
  const head = A.k.split("/")[0];
  const s = cat.get(head) ?? cat.set(head, { n: 0, same: 0, digits: 0, different: 0 }).get(head);
  s.n++;
  if (catRef[i] === catRust[i]) s.same++;
  else {
    const why = differ(A, JSON.parse(catRust[i]));
    if (why) {
      s.different++;
      catDifferent++;
      if (examples.length < 60) examples.push(`catalogue ${A.k.slice(0, 80)} ${why.slice(0, 600)}`);
    } else s.digits++;
  }
}
console.log(`\nCATALOGUE, DOMAIN AND BOUNDS\n${"lines".padEnd(22)} ${"count".padStart(6)} ${"identical".padStart(9)} ${"digits".padStart(6)} ${"DIFFERENT".padStart(9)}`);
for (const [k, s] of cat) console.log(`${k.padEnd(22)} ${[s.n, s.same, s.digits, s.different].map((v, j) => String(v).padStart([6, 9, 6, 9][j])).join(" ")}`);

console.log(`\n${total.n} cases: ${total.same} identical byte for byte, ${total.digits} equal up to the last digits of numbers, ${total.different} DIFFERENT`);
console.log(`${catRef.length} catalogue lines: ${catDifferent} DIFFERENT`);
if (examples.length) {
  console.log("\nDIFFERENCES");
  for (const e of examples) console.log(`  ${e}`);
}
process.exit(total.different || catDifferent ? 1 : 0);
