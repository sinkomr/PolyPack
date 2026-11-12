// Compares the Rust port of the sphere family with its TypeScript source, field by field.
//   node native/tools/sphere-compare.mjs DIR      (after sphere-ref.mts and the spherediff example)
//
// Per case and per result (the validator at 1e-9 and 1e-11 as the server calls it, the reasons of
// check() at both, and the validator with no options) it finds one of:
//   identical  every boolean, index, count, string and number is the same (numbers bit for bit);
//   close      the same but for the last digits of numbers: they agree to 1e-6 relative or 1e-12
//              absolute, and messages are equal once each number in them is replaced by a
//              placeholder and those numbers agree likewise (native/PORTING.md);
//   tie        close, except that the two sides chose differently among equals, which this tool
//              verifies: the worst pair is another pair whose gap is the same to the tolerance
//              above on both sides (the server's sentence then names that pair), or the normal of
//              a separating plane is another plane whose margin, computed here from the case, is
//              the same to 1e-12 (the server does not use the normal);
//   different  anything else: a defect of the port until it is explained.
// The exit code is 1 when anything is different.
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const dec = (v) => (v === "NaN" ? NaN : v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v);

const NUMBER = /-?(?:\d+\.?\d*(?:e[+-]?\d+)?|Infinity)|NaN/g;
const near = (a, b) =>
  Object.is(a, b) || a === b || Math.abs(a - b) <= 1e-12 || Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
const IDENTICAL = 0, CLOSE = 1, TIE = 2, DIFFERENT = 3;
const NAMES = ["identical", "close", "tie", "different"];
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

// ---- the geometry needed to verify a tie between planes (packages/sphere/src/geometry.ts) --------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function placedVertices(N, rho, q) {
  const [w, x, y, z] = q;
  const n = w * w + x * x + y * y + z * z;
  const M = [
    [(w * w + x * x - y * y - z * z) / n, (2 * (x * y - w * z)) / n, (2 * (x * z + w * y)) / n],
    [(2 * (x * y + w * z)) / n, (w * w - x * x + y * y - z * z) / n, (2 * (y * z - w * x)) / n],
    [(2 * (x * z - w * y)) / n, (2 * (y * z + w * x)) / n, (w * w - x * x - y * y + z * z) / n],
  ];
  const R = Math.asin(Math.sin(1 / rho / 2) / Math.sin(Math.PI / N));
  return Array.from({ length: N }, (_, k) => {
    const phi = Math.PI / 2 + (2 * Math.PI * k) / N;
    const v = [Math.sin(R) * Math.cos(phi), Math.sin(R) * Math.sin(phi), Math.cos(R)];
    return [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
  });
}
/** The margin of the plane with normal n between pieces i and j of a case: min(min n.a, min -n.b). */
function margin(c, i, j, n) {
  const A = placedVertices(c.N, c.config.rho, c.config.pieces[i].q);
  const B = placedVertices(c.N, c.config.rho, c.config.pieces[j].q);
  return Math.min(...A.map((a) => dot(n, a)), ...B.map((b) => -dot(n, b)));
}

/** One result of the validator (t9, t11 or v0) of the two sides. `tie` is set to what was verified. */
function compareResult(c, a, b, path, where, tie) {
  let worst = IDENTICAL;
  for (const k of ["valid", "strictlyValid", "minGap", "errors", "npairs", "kinds"]) worst = Math.max(worst, compare(a[k], b[k], `${path}.${k}`, where));
  // pairs by their place in the list; a pair kept on one side only is one within 1e-9 of that side's smallest gap
  const [pa, pb] = [new Map(a.pairs.map((p) => [p[0], p])), new Map(b.pairs.map((p) => [p[0], p]))];
  for (const [at, p] of pa) {
    const q = pb.get(at);
    if (!q) {
      if (!(dec(p[4]) <= dec(a.minGap) + 2e-9)) worst = Math.max(worst, ((where.different ??= `${path}.pairs: pair ${at} is on one side only`), DIFFERENT));
      continue;
    }
    worst = Math.max(worst, compare(p.slice(1, 5), q.slice(1, 5), `${path}.pairs[at ${at}]`, where));
    const normals = compare(p[5], q[5], `${path}.pairs[at ${at}].normal`, {});
    if (normals === DIFFERENT) {
      // another plane: a tie when its margin is the same
      const [ma, mb] = [margin(c, p[1], p[2], p[5].map(dec)), margin(c, p[1], p[2], q[5].map(dec))];
      if (Math.abs(ma - mb) <= 1e-12) {
        tie.normal = true;
        worst = Math.max(worst, TIE);
      } else worst = Math.max(worst, ((where.different ??= `${path}.pairs[at ${at}].normal: margins ${ma} / ${mb}`), DIFFERENT));
    } else worst = Math.max(worst, normals);
  }
  for (const [at, q] of pb) if (!pa.has(at) && !(dec(q[4]) <= dec(b.minGap) + 2e-9)) worst = Math.max(worst, ((where.different ??= `${path}.pairs: pair ${at} is on one side only`), DIFFERENT));
  // the worst pair: the same, or another pair with the same gap on both sides
  const [wa, wb] = [a.worstPair, b.worstPair];
  if (JSON.stringify(wa) !== JSON.stringify(wb)) {
    const gapOf = (pairs, w) => dec(pairs.find((p) => p[1] === w?.[0] && p[2] === w?.[1])?.[4]);
    const [inA, inB] = [gapOf(a.pairs, wb), gapOf(b.pairs, wa)];
    if (wa && wb && near(inA, dec(a.minGap)) && near(inB, dec(b.minGap))) {
      tie.worstPair = true;
      worst = Math.max(worst, TIE);
    } else worst = Math.max(worst, ((where.different ??= `${path}.worstPair: ${JSON.stringify(wa)} / ${JSON.stringify(wb)}, gaps ${inA} / ${inB}`), DIFFERENT));
  }
  return worst;
}
/** The reasons of check() of the two sides, given the results they come from. */
function compareReasons(a, b, ra, rb, path, where, tie) {
  const plain = compare(ra, rb, path, {});
  if (plain !== DIFFERENT) return plain;
  // the overlap sentence names the worst pair: with a verified tie it names the other pair, with the same depth
  const parts = (r) => (r.length === 1 ? /^pieces (\d+) and (\d+) overlap by (.+)$/.exec(r[0]) : null);
  const [xa, xb] = [parts(ra), parts(rb)];
  const names = (x, v) => x && v.worstPair && Number(x[1]) === v.worstPair[0] && Number(x[2]) === v.worstPair[1];
  if (tie.worstPair && names(xa, a) && names(xb, b) && near(Number(xa[3]), Number(xb[3]))) {
    tie.sentence = true;
    return TIE;
  }
  return (where.different ??= `${path}: ${JSON.stringify(ra)} / ${JSON.stringify(rb)}`), DIFFERENT;
}

const cases = lines("cases.jsonl");
const ref = lines("ref.jsonl");
const rust = lines("rust.jsonl");
const tt = JSON.parse(readFileSync(`${dir}/ts-times.json`, "utf8"));
const rt = JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8"));
if (ref.length !== cases.length || rust.length !== cases.length) throw new Error("the files do not have the same number of lines");

const stat = () => ({ n: 0, identical: 0, close: 0, tie: 0, different: 0, valid9: 0, valid11: 0, verdict: 0, numbers: 0, maxAbs: 0, ts: 0, rs: 0 });
const byKind = new Map();
const byShape = new Map();
const byCount = new Map();
const examples = [];
const ties = [];
const reasonsSeen = new Map();
const total = stat();
const tieCount = { worstPair: 0, sentence: 0, normalOnly: 0 };
for (let i = 0; i < cases.length; i++) {
  const [c, a, b] = [cases[i], ref[i], rust[i]];
  if (a.id !== c.id || b.id !== c.id) throw new Error("misaligned");
  const where = {};
  const tie = {};
  let worst = IDENTICAL;
  for (const [f, r] of [["t9", "r9"], ["t11", "r11"], ["v0", null]]) {
    if (f in a !== f in b) worst = Math.max(worst, ((where.different ??= `${f}: present on one side only`), DIFFERENT));
    if (!(f in a) || !(f in b)) continue;
    const t = {};
    worst = Math.max(worst, compareResult(c, a[f], b[f], f, where, t));
    if (r) worst = Math.max(worst, compareReasons(a[f], b[f], a[r], b[r], r, where, t));
    Object.assign(tie, t);
  }
  if (worst === TIE) {
    if (tie.worstPair) tieCount.worstPair++;
    if (tie.sentence) tieCount.sentence++;
    if (!tie.worstPair) tieCount.normalOnly++;
    ties.push(`  case ${c.id} ${c.kind} N=${c.N} P=${c.P}: ${tie.worstPair ? `worst pair ${JSON.stringify(a.t9.worstPair)} / ${JSON.stringify(b.t9.worstPair)}${tie.sentence ? `, sentence "${(a.r9[0] ?? a.r11[0])}" / "${(b.r9[0] ?? b.r11[0])}"` : " (valid: no sentence)"}` : "normal of a plane"}`);
  }
  // the verdict the server gives, on its own
  const verdict = a.t9.valid !== b.t9.valid || a.t11.valid !== b.t11.valid || (a.r9.length === 0) !== (b.r9.length === 0) || (a.r11.length === 0) !== (b.r11.length === 0);
  const [ga, gb] = [dec(a.t9.minGap), dec(b.t9.minGap)];
  const abs = Number.isFinite(ga) && Number.isFinite(gb) ? Math.abs(ga - gb) : 0;
  for (const r of [...a.r9, ...a.r11]) {
    const k = r.replace(NUMBER, "#");
    reasonsSeen.set(k, (reasonsSeen.get(k) ?? 0) + 1);
  }
  const N = c.N;
  const shape = typeof N !== "number" || !Number.isInteger(N) || (N !== 0 && (N < 3 || N > 100)) ? "N not a shape" : N === 0 ? "N=0 (caps)" : N <= 8 ? "N=3-8 (all planes)" : N <= 30 ? "N=9-30 (hull)" : "N=31-100 (hull)";
  const P = c.config.pieces.length;
  const count = P <= 2 ? "P=0-2" : P <= 10 ? "P=3-10" : P <= 40 ? "P=11-40" : "P=41-100";
  for (const [map, key] of [[byKind, c.kind.replace(/^malformed-.*/, "malformed")], [byShape, shape], [byCount, count], [null, ""]]) {
    const s = map ? (map.get(key) ?? stat()) : total;
    if (map) map.set(key, s);
    s.n++;
    s[NAMES[worst]]++;
    if (a.t9.valid) s.valid9++;
    if (a.t11.valid) s.valid11++;
    if (verdict) s.verdict++;
    if (abs > 0) s.numbers++;
    s.maxAbs = Math.max(s.maxAbs, abs);
    s.ts += tt[i];
    s.rs += rt[i];
  }
  if (worst === DIFFERENT && examples.length < 25) examples.push(`  case ${c.id} ${c.kind} N=${c.N} P=${c.P}: ${where.different}`);
}

const show = (title, map) => {
  console.log(`\n${title}`);
  console.log("group".padEnd(22), " cases valid@1e-9 valid@1e-11 identical  close    tie different verdict≠ minGap≠ maxAbsDiff    TS µs  Rust µs speedup");
  const rows = [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true }));
  for (const [k, s] of [...rows, ["all", total]])
    console.log(
      String(k).padEnd(22),
      String(s.n).padStart(6), String(s.valid9).padStart(10), String(s.valid11).padStart(11), String(s.identical).padStart(9), String(s.close).padStart(6), String(s.tie).padStart(6), String(s.different).padStart(9),
      String(s.verdict).padStart(8), String(s.numbers).padStart(7), s.maxAbs.toExponential(1).padStart(10),
      (s.ts / s.n / 1e3).toFixed(1).padStart(9), (s.rs / s.n / 1e3).toFixed(1).padStart(8), (s.ts / s.rs).toFixed(1).padStart(7),
    );
};
show("BY KIND OF CASE", byKind);
show("BY PIECE", byShape);
show("BY NUMBER OF PIECES", byCount);

console.log("\nREASONS OF check() IN THE REFERENCE (numbers replaced by #), with how often");
for (const [k, n] of [...reasonsSeen].sort((x, y) => y[1] - x[1])) console.log(String(n).padStart(7), k);

// the package's other functions
const aux = lines("aux-cases.jsonl");
const auxRef = lines("aux-ref.jsonl");
const auxRust = lines("aux-rust.jsonl");
const byFn = new Map();
for (let i = 0; i < aux.length; i++) {
  const s = byFn.get(aux[i].fn) ?? { n: 0, values: 0, same: 0, identical: 0, close: 0, different: 0 };
  byFn.set(aux[i].fn, s);
  const where = {};
  const worst = compare(auxRef[i].result, auxRust[i].result, aux[i].fn, where);
  s.n++;
  if (Array.isArray(auxRef[i].result) && typeof dec(auxRef[i].result[0]) === "number") {
    s.values += auxRef[i].result.length;
    s.same += auxRef[i].result.filter((x, k) => Object.is(dec(x), dec(auxRust[i].result[k]))).length;
  } else {
    s.values++;
    if (worst === IDENTICAL) s.same++;
  }
  s[NAMES[worst]]++;
  if (worst === DIFFERENT && examples.length < 40) examples.push(`  aux ${aux[i].id} ${aux[i].fn} N=${aux[i].N}: ${where.different}`);
}
console.log("\nOTHER FUNCTIONS ON THEIR OWN INPUTS");
console.log("function".padEnd(22), " cases identical  close different   numbers same bits");
for (const [k, s] of byFn) console.log(k.padEnd(22), String(s.n).padStart(6), String(s.identical).padStart(9), String(s.close).padStart(6), String(s.different).padStart(9), String(s.values).padStart(9), String(s.same).padStart(9));

console.log(`\n${total.n} cases: ${total.identical} identical, ${total.close} equal up to the last digits of numbers, ${total.tie} ties, ${total.different} different`);
console.log(`ties: ${tieCount.worstPair} name another worst pair with the same gap (${tieCount.sentence} of them invalid, so the server's sentence names that pair), ${tieCount.normalOnly} differ only in the normal of a plane with the same margin`);
if (ties.length) console.log("\nTIES\n" + ties.join("\n"));
if (examples.length) console.log("\nDIFFERENCES\n" + examples.join("\n"));
const auxDifferent = [...byFn.values()].reduce((n, s) => n + s.different, 0);
process.exit(total.different || auxDifferent ? 1 : 0);
