// Compares the Rust port of the torus family with its TypeScript source, field by field.
//   node native/tools/torus-compare.mjs DIR      (after torus-ref.mts and the torusdiff example)
//
// Per case and per result (the validator at 1e-9 and 1e-11 as the server calls it, the reasons of
// check() at both, and the validator with no options) it finds one of:
//   identical  every boolean, index, count, string and number is the same (numbers bit for bit);
//   close      the same but for the last digits of numbers: they agree to 1e-6 relative or 1e-12
//              absolute, and messages are equal once each number in them is replaced by a
//              placeholder and those numbers agree likewise (native/PORTING.md);
//   different  anything else: a defect of the port until it is explained.
// The exit code is 1 when anything is different.
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const dec = (v) => (v === "NaN" ? NaN : v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v);

const NUMBER = /-?(?:\d+\.?\d*(?:e[+-]?\d+)?|Infinity)|NaN/g;
const near = (a, b) =>
  Object.is(a, b) || a === b || Math.abs(a - b) <= 1e-12 || Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
const IDENTICAL = 0, CLOSE = 1, DIFFERENT = 2;
const NAMES = ["identical", "close", "different"];
/** IDENTICAL, CLOSE or DIFFERENT; `where` receives the path of the first difference. */
function compare(a, b, path, where) {
  a = dec(a);
  b = dec(b);
  if (typeof a === "number" && typeof b === "number") {
    if (Object.is(a, b) || a === b) return IDENTICAL;
    if (near(a, b)) return CLOSE;
    return (where.different ??= `${path}: ${a} / ${b}`), DIFFERENT;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return IDENTICAL;
    const [na, nb] = [a.match(NUMBER) ?? [], b.match(NUMBER) ?? []];
    if (a.replace(NUMBER, "#") === b.replace(NUMBER, "#") && na.every((x, i) => near(Number(x), Number(nb[i])))) return CLOSE;
    return (where.different ??= `${path}: ${a} / ${b}`), DIFFERENT;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return (where.different ??= `${path}.length: ${a.length} / ${b.length}`), DIFFERENT;
    let worst = IDENTICAL;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, compare(a[i], b[i], `${path}[${i}]`, where));
    return worst;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    let worst = IDENTICAL;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a) || !(k in b)) worst = Math.max(worst, ((where.different ??= `${path}.${k}: missing on one side`), DIFFERENT));
      else worst = Math.max(worst, compare(a[k], b[k], `${path}.${k}`, where));
    }
    return worst;
  }
  if (a === b) return IDENTICAL;
  return (where.different ??= `${path}: ${JSON.stringify(a)} / ${JSON.stringify(b)}`), DIFFERENT;
}

const cases = lines("cases.jsonl");
const ref = lines("ref.jsonl");
const rust = lines("rust.jsonl");
const tt = JSON.parse(readFileSync(`${dir}/ts-times.json`, "utf8"));
const rt = JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8"));
if (ref.length !== cases.length || rust.length !== cases.length) throw new Error("the files do not have the same number of lines");

const FIELDS = ["t9", "t11", "r9", "r11", "v0"];
const stat = () => ({ n: 0, identical: 0, close: 0, different: 0, valid9: 0, valid11: 0, verdict: 0, numbers: 0, maxAbs: 0, ts: 0, rs: 0 });
const byKind = new Map();
const byFamily = new Map();
const byShape = new Map();
const byCount = new Map();
const examples = [];
const reasonsSeen = new Map();
const total = stat();
for (let i = 0; i < cases.length; i++) {
  const [c, a, b] = [cases[i], ref[i], rust[i]];
  if (a.id !== c.id || b.id !== c.id) throw new Error("misaligned");
  const where = {};
  let worst = IDENTICAL;
  for (const f of FIELDS) {
    if (f in a !== f in b) worst = Math.max(worst, ((where.different ??= `${f}: present on one side only`), DIFFERENT));
    else if (f in a) worst = Math.max(worst, compare(a[f], b[f], f, where));
  }
  // the verdict the server gives (the reasons of check() are empty), on its own
  const verdict = a.t9.valid !== b.t9.valid || a.t11.valid !== b.t11.valid || (a.r9.length === 0) !== (b.r9.length === 0) || (a.r11.length === 0) !== (b.r11.length === 0);
  const [ga, gb] = [dec(a.t9.minSep), dec(b.t9.minSep)];
  const abs = Number.isFinite(ga) && Number.isFinite(gb) ? Math.abs(ga - gb) : 0;
  for (const r of [...a.r9, ...a.r11]) {
    const k = r.replace(NUMBER, "#");
    reasonsSeen.set(k, (reasonsSeen.get(k) ?? 0) + 1);
  }
  for (const r of [...a.t9.errors, ...a.t11.errors]) {
    const k = "(validator) " + r.replace(NUMBER, "#");
    reasonsSeen.set(k, (reasonsSeen.get(k) ?? 0) + 1);
  }
  const N = c.N;
  const shape = typeof N !== "number" || !Number.isInteger(N) || (N !== 0 && (N < 3 || N > 100)) ? "N not a shape" : N === 0 ? "N=0 (disks)" : N <= 8 ? "N=3-8" : N <= 30 ? "N=9-30" : "N=31-100";
  const P = c.poses.length;
  const count = P <= 2 ? "P=0-2" : P <= 10 ? "P=3-10" : P <= 100 ? "P=11-100" : "P=101-500";
  for (const [map, key] of [[byKind, c.kind.replace(/^malformed-.*/, "malformed")], [byFamily, c.family], [byShape, shape], [byCount, count], [null, ""]]) {
    const s = map ? (map.get(key) ?? stat()) : total;
    if (map) map.set(key, s);
    s.n++;
    s[NAMES[worst]]++;
    if (a.r9.length === 0) s.valid9++;
    if (a.r11.length === 0) s.valid11++;
    if (verdict) s.verdict++;
    if (abs > 0) s.numbers++;
    s.maxAbs = Math.max(s.maxAbs, abs);
    s.ts += tt[i];
    s.rs += rt[i];
  }
  if (worst === DIFFERENT && examples.length < 25) examples.push(`  case ${c.id} ${c.kind} ${c.family} N=${c.N} P=${P}: ${where.different}`);
}

const show = (title, map) => {
  console.log(`\n${title}`);
  console.log("group".padEnd(26), " cases valid@1e-9 valid@1e-11 identical  close different verdict≠ minSep≠ maxAbsDiff    TS µs  Rust µs speedup");
  const rows = [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true }));
  for (const [k, s] of [...rows, ["all", total]])
    console.log(
      String(k).padEnd(26),
      String(s.n).padStart(6), String(s.valid9).padStart(10), String(s.valid11).padStart(11), String(s.identical).padStart(9), String(s.close).padStart(6), String(s.different).padStart(9),
      String(s.verdict).padStart(8), String(s.numbers).padStart(7), s.maxAbs.toExponential(1).padStart(10),
      (s.ts / s.n / 1e3).toFixed(1).padStart(9), (s.rs / s.n / 1e3).toFixed(1).padStart(8), (s.ts / s.rs).toFixed(1).padStart(7),
    );
};
show("BY KIND OF CASE", byKind);
show("BY FAMILY", byFamily);
show("BY PIECE", byShape);
show("BY NUMBER OF PIECES", byCount);

// the package's other functions
const aux = lines("aux-cases.jsonl");
const auxRef = lines("aux-ref.jsonl");
const auxRust = lines("aux-rust.jsonl");
const byFn = new Map();
const flat = (v) => (Array.isArray(v) ? v.flat(3) : [v]);
for (let i = 0; i < aux.length; i++) {
  const s = byFn.get(aux[i].fn) ?? { n: 0, values: 0, same: 0, identical: 0, close: 0, different: 0 };
  byFn.set(aux[i].fn, s);
  const where = {};
  const worst = compare(auxRef[i].result, auxRust[i].result, aux[i].fn, where);
  s.n++;
  if (["areaScoreBound", "radii", "separationOf"].includes(aux[i].fn)) {
    const [x, y] = [flat(auxRef[i].result), flat(auxRust[i].result)];
    s.values += x.length;
    s.same += x.filter((v, k) => Object.is(dec(v), dec(y[k]))).length;
  } else {
    s.values++;
    if (worst === IDENTICAL) s.same++;
  }
  s[NAMES[worst]]++;
  if (aux[i].fn === "validateWith")
    for (const r of auxRef[i].result.errors) {
      const k = "(validator, other options) " + r.replace(NUMBER, "#");
      reasonsSeen.set(k, (reasonsSeen.get(k) ?? 0) + 1);
    }
  if (worst === DIFFERENT && examples.length < 40) examples.push(`  aux ${aux[i].id} ${JSON.stringify(aux[i]).slice(0, 200)}: ${where.different}`);
}
console.log("\nREASONS IN THE REFERENCE (numbers replaced by #), with how often: of check(), and of the validator called alone");
for (const [k, n] of [...reasonsSeen].sort((x, y) => y[1] - x[1])) console.log(String(n).padStart(7), k);

console.log("\nOTHER FUNCTIONS ON THEIR OWN INPUTS");
console.log("function".padEnd(22), " cases identical  close different   results same bits");
for (const [k, s] of byFn) console.log(k.padEnd(22), String(s.n).padStart(6), String(s.identical).padStart(9), String(s.close).padStart(6), String(s.different).padStart(9), String(s.values).padStart(9), String(s.same).padStart(9));

console.log(`\n${total.n} cases: ${total.identical} identical, ${total.close} equal up to the last digits of numbers, ${total.different} different`);
if (examples.length) console.log("\nDIFFERENCES\n" + examples.join("\n"));
const auxDifferent = [...byFn.values()].reduce((n, s) => n + s.different, 0);
process.exit(total.different || auxDifferent ? 1 : 0);
