// Compares the Rust answers of the ndim family with the TypeScript's, case by case and field by field
// (native/PORTING.md), and prints the tables: node native/tools/ndim-compare.mjs OUTDIR [--all]
//
// OUTDIR holds cases.jsonl, ref.jsonl and ts-times.json (native/tools/ndim-ref.mts) and rust.jsonl and
// rust-times.json (the example ndimdiff of native/ndim). A case is
//   identical  when the two answers are the same in every field (every number is written as its own text on both
//              sides, so this is byte for byte, up to the order of an object's keys);
//   close      when they are the same once each number is replaced by a placeholder (in a message, or a number
//              field) and the numbers agree to 1e-6 relative or 1e-12 absolute;
//   different  otherwise: a defect of the port until it is explained.
// The exit code is 1 when a case is different. --all lists every case that is not identical.
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const listAll = process.argv.includes("--all");
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cases = lines("cases.jsonl");
const ref = lines("ref.jsonl");
const rust = lines("rust.jsonl");
const tsTimes = JSON.parse(readFileSync(`${dir}/ts-times.json`, "utf8"));
const rustTimes = JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8"));
if (ref.length !== cases.length || rust.length !== cases.length) throw new Error("the files do not hold the same cases");

const NUMBER = /-?Infinity|NaN|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;
let numbersCompared = 0;
let numbersDiffering = 0;
let largestRelative = 0;
const closeNumbers = (x, y) => {
  numbersCompared++;
  if (x === y || (Number.isNaN(x) && Number.isNaN(y))) return true;
  numbersDiffering++;
  const ok = Math.abs(x - y) <= 1e-12 || Math.abs(x - y) <= 1e-6 * Math.max(Math.abs(x), Math.abs(y));
  if (ok) largestRelative = Math.max(largestRelative, Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y)));
  return ok;
};
/** "same" | "close" | a path that differs. */
function compare(a, b, path = "") {
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return "same";
    if (a.replace(NUMBER, "#") !== b.replace(NUMBER, "#")) return path || "/";
    const x = (a.match(NUMBER) ?? []).map(Number);
    const y = (b.match(NUMBER) ?? []).map(Number);
    return x.length === y.length && x.every((v, i) => closeNumbers(v, y[i])) ? "close" : path || "/";
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`;
    let out = "same";
    for (let i = 0; i < a.length; i++) {
      const r = compare(a[i], b[i], `${path}[${i}]`);
      if (r === "close") out = "close";
      else if (r !== "same") return r;
    }
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}{keys ${ka.join()} | ${kb.join()}}`;
    let out = "same";
    for (const k of ka) {
      const r = compare(a[k], b[k], `${path}.${k}`);
      if (r === "close") out = "close";
      else if (r !== "same") return r;
    }
    return out;
  }
  return a === b ? "same" : path || "/";
}
const at = (v, path) => {
  let x = v;
  for (const m of path.matchAll(/\.([A-Za-z_]\w*)|\[(\d+)\]/g)) x = x?.[m[1] ?? Number(m[2])];
  return x;
};

/** The kind of a reason: its text without the numbers. */
const reasonKind = (r) =>
  r
    .replace(/^pieces\[\d+\] /, "pieces[i] ")
    .replace(/^pieces \d+ and \d+ /, "pieces i and j ")
    .replace(/^piece \d+ sticks/, "piece i sticks")
    .replace(NUMBER, "#")
    .replace(/\[#, #\]/, "[lo, hi]");

const stat = () => ({ n: 0, identical: 0, close: 0, different: 0, v9: 0, v11: 0, bad: 0, count: 0, timed: 0, ts: 0, rs: 0 });
const tables = { "BY OPERATION AND GROUP": new Map(), "CHECK: BY DIMENSION": new Map(), "CHECK: BY PIECE": new Map(), "CHECK: BY CONTAINER": new Map(), "CHECK: BY KIND": new Map(), "CHECK: BY NUMBER OF PIECES": new Map() };
const reasons = new Map();
const diffs = [];
let flipped = 0;
let flippedRuns = 0;
const total = stat();
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const a = ref[i].answer;
  const b = rust[i].answer;
  if (ref[i].id !== c.id || rust[i].id !== c.id) throw new Error(`misaligned at line ${i + 1}`);
  const r = compare(a, b);
  const verdict = r === "same" ? "identical" : r === "close" ? "close" : "different";
  if (verdict !== "identical")
    diffs.push({ verdict, id: c.id, what: `${c.op}/${c.group}/${c.kind}${c.op === "check" ? ` ${c.d}D ${c.piece} in ${c.container} P=${c.P}` : ""}`, path: r, ts: verdict === "different" ? at(a, r) : undefined, rs: verdict === "different" ? at(b, r) : undefined, a, b });
  const keys = [["BY OPERATION AND GROUP", `${c.op} / ${c.group}`]];
  if (c.op === "check") {
    const m = c.d + (c.d * (c.d - 1)) / 2;
    if (Array.isArray(c.raw?.pieces) && c.raw.pieces.some((q) => Array.isArray(q) && q.length === m + 1 && q[m] > 0)) {
      flipped++;
      if (a.checks) flippedRuns++;
    }
    keys.push(["CHECK: BY DIMENSION", `${c.d}D`], ["CHECK: BY PIECE", c.piece], ["CHECK: BY CONTAINER", c.container], ["CHECK: BY KIND", `${c.group}: ${String(c.kind).replace(/ -?[\de.-]+$/, "")}`]);
    keys.push(["CHECK: BY NUMBER OF PIECES", c.P <= 2 ? "P = 1, 2" : c.P <= 5 ? "P = 3 to 5" : c.P <= 12 ? "P = 6 to 12" : c.P <= 20 ? "P = 13 to 20" : c.P <= 40 ? "P = 21 to 40" : "P above 40"]);
    for (const [t, ck] of (a.checks ?? []).entries())
      for (const text of ck.reasons ?? []) {
        const k = `${t === 0 ? "1e-9 " : "1e-11"}  ${reasonKind(text)}`;
        reasons.set(k, (reasons.get(k) ?? 0) + 1);
      }
    for (const text of a.parse?.errors ?? []) {
      const k = `parse  ${reasonKind(text)}`;
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
  }
  if (c.op === "core" || c.op === "cap")
    for (const text of a.core?.reasons ?? a.reasons ?? []) {
      const k = `${c.op.padEnd(5)}  ${reasonKind(text)}`;
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
  for (const s of [total, ...keys.map(([t, k]) => tables[t].get(k) ?? (tables[t].set(k, stat()), tables[t].get(k)))]) {
    s.n++;
    s[verdict]++;
    if (c.op !== "check") continue;
    if (a.parse && !a.parse.ok) a.parse.malformed ? s.bad++ : s.count++;
    if (a.checks?.[0]?.reasons?.length === 0) s.v9++;
    if (a.checks?.[1]?.reasons?.length === 0) s.v11++;
    if (tsTimes[i] !== null && rustTimes[i] !== null) {
      s.timed++;
      s.ts += tsTimes[i];
      s.rs += rustTimes[i];
    }
  }
}
const num = (v, w) => String(v).padStart(w);
const order = (x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true });
for (const [title, map] of Object.entries(tables)) {
  const check = title.startsWith("CHECK");
  console.log(`\n${title}`);
  console.log("group".padEnd(34), " cases  ident  close  differ" + (check ? "  malformed  count  valid@1e-9  valid@1e-11   TS ms  Rust ms  TS/Rust" : ""));
  for (const [k, s] of [...map].sort(order))
    console.log(
      String(k).padEnd(34),
      num(s.n, 6), num(s.identical, 6), num(s.close, 6), num(s.different, 7),
      check || s.timed
        ? [num(s.bad, 10), num(s.count, 6), num(s.v9, 11), num(s.v11, 12), num(s.timed ? (s.ts / s.timed / 1e6).toFixed(3) : "-", 8), num(s.timed ? (s.rs / s.timed / 1e6).toFixed(3) : "-", 8), num(s.timed ? (s.ts / s.rs).toFixed(1) : "-", 8)].join(" ")
        : "",
    );
}
console.log("\nREASONS GIVEN (by the TypeScript; `parse` are the parser's errors, the others the check's at each tolerance)");
for (const [k, n] of [...reasons].sort((x, y) => x[0].localeCompare(y[0]))) console.log(num(n, 7), " ", k);
console.log(`\ncheck cases with a flipped piece (a flip above 0 in a pose): ${flipped}, of which ${flippedRuns} well formed and checked`);
console.log(`\nALL: ${total.n} cases, ${total.identical} identical, ${total.close} equal up to the last digits of numbers, ${total.different} different`);
console.log(`in the answers that are not identical: ${numbersDiffering} numbers differ of ${numbersCompared} compared there, by at most ${largestRelative.toExponential(1)} relative`);
if (total.timed) console.log(`timed checks: ${total.timed}; mean ${(total.ts / total.timed / 1e6).toFixed(3)} ms in TypeScript, ${(total.rs / total.timed / 1e6).toFixed(3)} ms in Rust; total time ratio ${(total.ts / total.rs).toFixed(1)}`);
const shown = diffs.filter((d) => listAll || d.verdict === "different");
if (shown.length) console.log(`\n${listAll ? "cases that are not identical" : "DIFFERENT"}:`);
for (const d of shown.slice(0, listAll ? 400 : 40)) {
  console.log(`  #${d.id} ${d.verdict} ${d.what}  at ${d.path}`);
  if (d.verdict === "different") console.log(`      TS:   ${JSON.stringify(d.ts)?.slice(0, 400)}\n      Rust: ${JSON.stringify(d.rs)?.slice(0, 400)}`);
  else {
    // the numbers that differ
    const ta = JSON.stringify(d.a).match(NUMBER) ?? [];
    const tb = JSON.stringify(d.b).match(NUMBER) ?? [];
    const pairs = ta.map((v, i) => [v, tb[i]]).filter(([x, y]) => x !== y);
    console.log(`      ${pairs.length} numbers differ, e.g. ${pairs.slice(0, 3).map(([x, y]) => `${x} | ${y}`).join(";  ")}`);
  }
}
process.exit(total.different ? 1 : 0);
