// Compares the Rust port of the surface family with the TypeScript reference, field by field.
//   node native/tools/surface-compare.mjs DIR        (after surface-ref.mts and the surfacediff example wrote into DIR)
//
// Verdicts: two verdicts are the same when they have the same form (a result or a thrown error of the same class), the
// same `ok`, the same number of errors, and every message and number equal after each number is replaced by a
// placeholder, the numbers agreeing to 1e-6 relative or 1e-12 absolute (native/PORTING.md). Cases whose two verdicts
// (at 1e-9 and 1e-11) are identical byte for byte are counted separately. Anything else is listed as a difference.
// Also compared: every field of every solid, the domain's info, samples and bounds.
import { existsSync, readFileSync } from "node:fs";

const dir = process.argv[2];
if (!dir) throw new Error("usage: surface-compare.mjs DIR");
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let failures = 0;

// ---- numbers ---------------------------------------------------------------------------------------------------------
const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|NaN|-?Infinity/g;
/** Of the numbers that are not the same double but count as equal: how many, and the largest differences. */
const near = { n: 0, maxAbs: 0, maxRel: 0, maxRelLarge: 0 };
/** Two numbers agree: equal (NaN with NaN), or within 1e-6 relative or 1e-12 absolute. */
function close(a, b) {
  if (Object.is(a, b) || a === b) return true;
  if (Number.isNaN(a) || Number.isNaN(b) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  const d = Math.abs(a - b);
  const rel = d / Math.max(Math.abs(a), Math.abs(b));
  if (d <= 1e-12 || rel <= 1e-6) {
    near.n++;
    near.maxAbs = Math.max(near.maxAbs, d);
    near.maxRel = Math.max(near.maxRel, rel);
    // of numbers that are not tiny (a depth near 0 is a difference of nearly equal numbers and keeps few digits)
    if (Math.abs(a) > 1e-3) near.maxRelLarge = Math.max(near.maxRelLarge, rel);
    return true;
  }
  return false;
}
/** Two texts agree up to the last digits of their numbers. */
function closeText(a, b) {
  if (a === b) return true;
  if (a.replace(NUMBER, "#") !== b.replace(NUMBER, "#")) return false;
  const na = a.match(NUMBER) ?? [];
  const nb = b.match(NUMBER) ?? [];
  return na.length === nb.length && na.every((x, i) => close(Number(x), Number(nb[i])));
}
/** null when the verdicts agree up to the last digits, else what differs. */
function verdictDiff(a, b) {
  if ("throw" in a !== "throw" in b) return "one threw, the other did not";
  if ("throw" in a) {
    if (a.throw !== b.throw) return `thrown class ${a.throw} / ${b.throw}`;
    return closeText(a.message, b.message) ? null : "thrown message";
  }
  if (a.ok !== b.ok) return `ok ${a.ok} / ${b.ok}`;
  if (a.errors.length !== b.errors.length) return `number of errors ${a.errors.length} / ${b.errors.length}`;
  for (let i = 0; i < a.errors.length; i++) if (!closeText(a.errors[i], b.errors[i])) return `error ${i}: ${a.errors[i]} / ${b.errors[i]}`;
  for (const k of ["minPairSep", "minConeSep", "minWallSep"]) if (!closeText(a[k], b[k])) return `${k} ${a[k]} / ${b[k]}`;
  return null;
}

// ---- the cases -------------------------------------------------------------------------------------------------------
/** The JSON of a value with the keys of its objects in alphabetical order (the two sides write them in different orders). */
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const cases = lines("cases.jsonl");
const ref = lines("ref.jsonl");
const rust = lines("rust.jsonl");
const tsTimes = existsSync(`${dir}/ts-times.json`) ? JSON.parse(readFileSync(`${dir}/ts-times.json`, "utf8")) : null;
const rustTimes = JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8"));
if (ref.length !== cases.length || rust.length !== cases.length) throw new Error("the files do not hold the same cases");
const solidFamily = new Map(lines("solids-ref.jsonl").map((s) => [s.name, s.family]));
const stat = () => ({ n: 0, ok9: 0, ok11: 0, threw: 0, same: 0, digits: 0, differ: 0, ts: 0, rs: 0, tsMax: 0, rsMax: 0 });
const tables = { "BY KIND OF CASE": new Map(), "BY FAMILY OF SOLID": new Map(), "BY MODE AND PIECE": new Map(), "BY NUMBER OF PIECES": new Map() };
const pieceOf = (N) => (N === 0 ? "disk" : N <= 8 ? "N=3-8" : N <= 30 ? "N=9-30" : "N=31-100");
const countOf = (P) => (P <= 5 ? "P=1-5" : P <= 20 ? "P=6-20" : P <= 50 ? "P=21-50" : "P=51-100");
const reasons = new Map();
const examples = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const a = ref[i];
  const b = rust[i];
  if (a.id !== c.id || b.id !== c.id) throw new Error("misaligned");
  const identical = canon(a.r) === canon(b.r);
  const diffs = a.r.map((v, t) => verdictDiff(v, b.r[t]));
  const differs = diffs.some((d) => d !== null);
  if (differs) {
    failures++;
    if (examples.length < 25) examples.push(`case ${c.id} ${c.kind} ${c.solid}/${c.mode}/${c.N}/${c.pieces.length} (${c.origin}): ${diffs.map((d, t) => (d ? `tol ${t ? "1e-11" : "1e-9"}: ${d}` : "")).filter(Boolean).join("; ")}`);
  }
  for (const v of a.r) {
    const list = "throw" in v ? [`(throws ${v.throw}) ${v.message}`] : v.errors;
    for (const e of list) {
      const key = e.replace(/chain depth limit reached: .*/, "chain depth limit reached: ... w=#").replace(NUMBER, "#");
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
  const rawN = c.N === "-0" ? 0 : c.N;
  const number = typeof rawN === "number" && Number.isInteger(rawN) && (rawN === 0 || rawN >= 3) ? rawN : null;
  const keys = [
    c.kind,
    solidFamily.get(c.solid) ?? "(unknown solid)",
    // a mode that is not "fold" is nofold for the validator (validate.ts: validate)
    number === null ? "(malformed N)" : `${c.mode === "fold" ? "fold" : "nofold"} ${pieceOf(number)}`,
    countOf(c.pieces.length),
  ];
  Object.values(tables).forEach((map, k) => {
    const s = map.get(keys[k]) ?? stat();
    map.set(keys[k], s);
    s.n++;
    if (a.r[0].ok) s.ok9++;
    if (a.r[1].ok) s.ok11++;
    if ("throw" in a.r[0]) s.threw++;
    if (identical) s.same++;
    else if (!differs) s.digits++;
    else s.differ++;
    if (tsTimes) {
      s.ts += tsTimes[i];
      s.tsMax = Math.max(s.tsMax, tsTimes[i]);
    }
    s.rs += rustTimes[i];
    s.rsMax = Math.max(s.rsMax, rustTimes[i]);
  });
}
const pad = (v, n) => String(v).padStart(n);
const ms = (ns) => (ns / 1e6).toFixed(ns < 1e7 ? 3 : 1);
for (const [title, map] of Object.entries(tables)) {
  console.log(`\n${title}`);
  console.log(`${"group".padEnd(18)} cases valid@1e-9 valid@1e-11 threw identical last-digits DIFFERENT   TS mean ms  Rust mean ms  speedup    TS max ms  Rust max ms`);
  const total = stat();
  const row = (k, s) =>
    console.log(
      `${String(k).padEnd(18)} ${pad(s.n, 5)} ${pad(s.ok9, 10)} ${pad(s.ok11, 11)} ${pad(s.threw, 5)} ${pad(s.same, 9)} ${pad(s.digits, 11)} ${pad(s.differ, 9)} ${pad(tsTimes ? ms(s.ts / s.n) : "-", 12)} ${pad(ms(s.rs / s.n), 13)} ${pad(tsTimes ? (s.ts / s.rs).toFixed(1) : "-", 8)} ${pad(tsTimes ? ms(s.tsMax) : "-", 12)} ${pad(ms(s.rsMax), 12)}`,
    );
  for (const [k, s] of [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true }))) {
    row(k, s);
    for (const f of Object.keys(total)) total[f] = f.endsWith("Max") ? Math.max(total[f], s[f]) : total[f] + s[f];
  }
  row("all", total);
}
console.log(
  `\nnumbers that differ but count as equal: ${near.n}; largest difference ${near.maxAbs.toExponential(2)} absolute, ${near.maxRel.toExponential(2)} relative (${near.maxRelLarge.toExponential(2)} among numbers above 1e-3)`,
);
console.log("\nREASONS IN THE REFERENCE (both tolerances), numbers replaced by #");
for (const [k, n] of [...reasons].sort((x, y) => y[1] - x[1])) console.log(`${pad(n, 7)}  ${k.length > 150 ? k.slice(0, 150) + "..." : k}`);
console.log(`\nDIFFERENCES OF VERDICTS: ${failures}`);
for (const e of examples) console.log("  " + e);

// ---- the solids ------------------------------------------------------------------------------------------------------
if (existsSync(`${dir}/solids-rust.jsonl`)) {
  const a = lines("solids-ref.jsonl");
  const b = lines("solids-rust.jsonl");
  let numbers = 0;
  let bitEqual = 0;
  let maxAbs = 0;
  let other = 0;
  const walk = (x, y, path) => {
    if (typeof x === "number" && typeof y === "number") {
      numbers++;
      if (x === y) bitEqual++;
      else {
        maxAbs = Math.max(maxAbs, Math.abs(x - y));
        if (Number.isInteger(x) || Number.isInteger(y) || Math.abs(x - y) > 1e-12 * Math.max(1, Math.abs(x))) {
          other++;
          if (other < 10) console.log(`  solid field ${path}: ${x} / ${y}`);
        }
      }
    } else if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) x.forEach((v, i) => walk(v, y[i], `${path}[${i}]`));
    else if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) walk(x[k], y[k], `${path}.${k}`);
    } else if (x !== y) {
      other++;
      if (other < 10) console.log(`  solid field ${path}: ${JSON.stringify(x)} / ${JSON.stringify(y)}`);
    }
  };
  if (a.length !== b.length) other++;
  a.forEach((s, i) => walk(s, b[i], s.name));
  console.log(`\nSOLIDS: ${a.length} solids, ${numbers} numbers, ${bitEqual} the same double, ${numbers - bitEqual} different (largest difference ${maxAbs.toExponential(2)}), other differences: ${other}`);
  failures += other;
}

// ---- the domain ------------------------------------------------------------------------------------------------------
if (existsSync(`${dir}/domain-rust.json`)) {
  const a = JSON.parse(readFileSync(`${dir}/domain-ref.json`, "utf8"));
  const b = JSON.parse(readFileSync(`${dir}/domain-rust.json`, "utf8"));
  const probes = JSON.parse(readFileSync(`${dir}/domain-probes.json`, "utf8"));
  const infoSame = a.info === b.info;
  if (!infoSame) failures++;
  let same = 0;
  let digits = 0;
  let differ = 0;
  let outside = 0;
  a.bounds.forEach((x, i) => {
    const y = b.bounds[i];
    if (x === null) outside++;
    if (canon(x) === canon(y)) same++;
    else if (x && y && x.label === y.label && close(Number(x.value), Number(y.value))) digits++;
    else {
      differ++;
      if (differ < 10) console.log(`  bound of ${JSON.stringify(probes.bounds[i])}: ${JSON.stringify(x)} / ${JSON.stringify(y)}`);
    }
  });
  failures += differ;
  let samples = 0;
  for (const limit of probes.samples) {
    const x = readFileSync(`${dir}/sample-${limit}.ref.txt`, "utf8");
    const y = readFileSync(`${dir}/sample-${limit}.rust.txt`, "utf8");
    if (x === y) samples++;
    else {
      failures++;
      console.log(`  sample(${limit}) differs`);
    }
  }
  const fa = new Float64Array(new Uint8Array(readFileSync(`${dir}/bounds-ref.f64`)).buffer);
  const fb = new Float64Array(new Uint8Array(readFileSync(`${dir}/bounds-rust.f64`)).buffer);
  let bits = 0;
  let worst = 0;
  if (fa.length !== fb.length) failures++;
  for (let i = 0; i < fa.length; i++) {
    if (fa[i] === fb[i]) bits++;
    else worst = Math.max(worst, Math.abs(fa[i] - fb[i]) / Math.abs(fa[i]));
  }
  if (worst > 1e-12) failures++;
  console.log(
    `\nDOMAIN: info ${infoSame ? "identical" : "DIFFERENT"} (${a.info.length} characters); bounds of ${a.bounds.length} ids (${outside} outside the domain): ${same} identical, ${digits} equal up to the last digits, ${differ} different; samples identical: ${samples} of ${probes.samples.length}; ` +
      `surfaceBounds of every solid, N and P: ${fa.length} numbers, ${bits} the same double, ${fa.length - bits} different (largest relative difference ${worst.toExponential(2)})`,
  );
}
console.log(failures ? `\nFAILED: ${failures} differences` : "\nno difference beyond the last digits of numbers");
process.exit(failures ? 1 : 0);
