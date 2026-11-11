// Compares the Rust port of packages/curved with its TypeScript source, field by field, on the
// cases of curved-ref.mts (native/PORTING.md):
//   node native/tools/curved-compare.mjs OUTDIR [--examples 30]
// reads cases.jsonl, ref.jsonl, ts-times.json (curved-ref.mts), rust.jsonl, rust-times.json,
// rust-times-server.json (the curveddiff example) and bound-ref.jsonl, bound-rust.jsonl.
//
// A case is three runs of the validator (tol 1e-9 and 1e-11 with maxErrors 20, and the default
// options) and the server's reasons at both tolerances. Every case falls in one class:
//   identical   every field of every run has the same text (a number's text is String(x), so the same double);
//   digits      the same verdicts, counts, reasons and contacts, and every pair of numbers agrees to 1e-6
//               relative or 1e-12 absolute (the rule of PORTING.md; a number inside a message too);
//   zero-sign   as digits, but `strictlyValid` (smallest gap > 0, which the server does not read) differs
//               where the smallest gap is zero to 1e-12: its sign is the last bit of a sine;
//   tie         as digits, but a contact's witness (which edge and vertex give the separation) differs
//               where two candidates agree to 1e-12, or a contact is listed on one side only with its gap
//               within 1e-12 of the contact tolerance;
//   coarse      the numbers differ by more than the rule allows, but by less than the float check itself
//               resolves for this configuration: 2^-52 (1 + mag)^2 times COARSE, mag the largest lifted
//               coordinate of the pieces (ref.jsonl; at K < 0 it grows as cosh(sqrt(-K) d) with the
//               distance d from O). A verdict may differ there, when the gap is that close to the tolerance;
//   other       anything else: a defect of the port until explained. The exit status is 1 if there is one.
// A number written in another form (1e-7 as 0.0000001) is "other": two texts that differ and hold the same doubles.
// Nothing is dropped: each class is counted, and the tables show the verdicts that differ in every class.
import { existsSync, readFileSync } from "node:fs";

const dir = process.argv[2];
if (!dir) throw new Error("usage: curved-compare.mjs OUTDIR");
const nExamples = process.argv.includes("--examples") ? Number(process.argv[process.argv.indexOf("--examples") + 1]) : 16;
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cases = lines("cases.jsonl");
const ref = lines("ref.jsonl");
const rust = lines("rust.jsonl");
const tsTimes = JSON.parse(readFileSync(`${dir}/ts-times.json`, "utf8"));
const rsTimes = JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8"));
const rsServer = existsSync(`${dir}/rust-times-server.json`) ? JSON.parse(readFileSync(`${dir}/rust-times-server.json`, "utf8")) : rsTimes;
if (ref.length !== cases.length || rust.length !== cases.length) throw new Error(`misaligned: ${cases.length} cases, ${ref.length} ref, ${rust.length} rust`);

/** How many times its own resolution a difference of the float check may be and still be called coarse. */
const COARSE = 64;
const num = (s) => (s === "-0" ? -0 : Number(s));
/** The rule of PORTING.md for two computed numbers. */
const close = (a, b) => Object.is(a, b) || a === b || Math.abs(a - b) <= 1e-12 || Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
const NUMBER = /-?(?:\d+\.?\d*(?:e[-+]?\d+)?|Infinity)|NaN/g;
/** A message with its numbers taken out: [text with #, the numbers]. */
const split = (text) => [text.replace(NUMBER, "#"), (text.match(NUMBER) ?? []).map(Number)];

/**
 * Compares two results of one run into `out`: `hard` the fields that differ in kind, each with its type
 * ("verdict": valid, strictlyValid or the number of reasons; "contacts": which contacts are listed; "text": a
 * message), `soft` the numbers outside the rule with their absolute difference, `zero` and `tie` the two named kinds.
 */
function compareRun(a, b, out) {
  const hard = (type, text) => out.hard.push({ type, text });
  for (const key of ["valid", "nErrors"]) if (a[key] !== b[key]) hard("verdict", `${key}: ${a[key]} | ${b[key]} (smallest gap ${a.minGap} | ${b.minGap})`);
  if (a.strictlyValid !== b.strictlyValid) {
    if (a.valid === b.valid && Math.abs(num(a.minGap)) <= 1e-12 && Math.abs(num(b.minGap)) <= 1e-12) out.zero = true;
    else hard("verdict", `strictlyValid: ${a.strictlyValid} | ${b.strictlyValid} (smallest gap ${a.minGap} | ${b.minGap})`);
  }
  for (const key of ["score", "tightSize", "minGap", "minPairGap", "minContainerGap"]) {
    if (a[key] === b[key]) continue;
    out.exact = false;
    const [x, y] = [num(a[key]), num(b[key])];
    // two texts of one double: the number is written in another form, which the rule does not allow
    if (Object.is(x, y)) hard("format", `${key}: ${a[key]} | ${b[key]}`);
    else if (!close(x, y)) out.soft.push([key, Math.abs(x - y), a[key], b[key]]);
  }
  compareTexts(a.errors, b.errors, "errors", out, a.nErrors !== b.nErrors);
  if (a.nContacts !== b.nContacts) {
    // a contact on one side only: a tie when some gap is within 1e-12 of the contact tolerance 1e-7
    out.exact = false;
    if ([...a.contacts, ...b.contacts].some((c) => Math.abs(num(c[5]) - 1e-7) <= 1e-12)) out.tie = true;
    else hard("contacts", `nContacts: ${a.nContacts} | ${b.nContacts}`);
  } else
    for (let i = 0; i < a.contacts.length; i++) {
      const [p, q] = [a.contacts[i], b.contacts[i]];
      if (JSON.stringify(p) === JSON.stringify(q)) continue;
      out.exact = false;
      const where = [0, 1, 2, 3].every((k) => p[k] === q[k]);
      const witness = [4, 6, 7, 8].every((k) => p[k] === q[k]);
      const gaps = close(num(p[5]), num(q[5]));
      if (!where) hard("contacts", `contact ${i}: ${JSON.stringify(p)} | ${JSON.stringify(q)}`);
      else if (!gaps) out.soft.push([`contact ${i} gap`, Math.abs(num(p[5]) - num(q[5])), p[5], q[5]]);
      else if (!witness) out.tie = true;
    }
}
/** Two lists of messages; `counted` when their different lengths are already a difference of the verdict. */
function compareTexts(a, b, name, out, counted = false) {
  if (a.length !== b.length) {
    out.exact = false;
    return void out.hard.push({ type: counted ? "verdict" : "reasons", text: `${name}: ${a.length} | ${b.length}: ${JSON.stringify(a.slice(0, 2))} | ${JSON.stringify(b.slice(0, 2))}` });
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    out.exact = false;
    const [ta, na] = split(a[i]);
    const [tb, nb] = split(b[i]);
    if (ta !== tb || na.length !== nb.length) out.hard.push({ type: "text", text: `${name}[${i}]: ${a[i]} | ${b[i]}` });
    // the same numbers in another text: a number is written in another form (1e-7 as 0.0000001, say)
    else if (na.every((x, k) => Object.is(x, nb[k]))) out.hard.push({ type: "format", text: `${name}[${i}]: ${a[i]} | ${b[i]}` });
    else na.forEach((x, k) => close(x, nb[k]) || out.soft.push([`${name}[${i}]`, Math.abs(x - nb[k]), a[i], b[i]]));
  }
}
const RUNS = ["tol 1e-9", "tol 1e-11", "default"];
function classify(i) {
  const [a, b] = [ref[i], rust[i]];
  if (a.id !== cases[i].id || b.id !== cases[i].id) throw new Error("misaligned ids");
  const out = { exact: true, hard: [], soft: [], zero: false, tie: false };
  a.runs.forEach((r, k) => {
    const before = out.hard.length;
    compareRun(r, b.runs[k], out);
    for (let h = before; h < out.hard.length; h++) out.hard[h].text = `${RUNS[k]}: ${out.hard[h].text}`;
  });
  // the server's reasons follow the validator's verdict: a list of another length is the verdict's difference again
  a.check.forEach((r, k) => compareTexts(r, b.check[k], `check ${RUNS[k]}`, out, a.runs[k].valid !== b.runs[k].valid || a.runs[k].nErrors !== b.runs[k].nErrors));
  if (out.hard.length) out.exact = false;
  // the float check's own resolution for this configuration
  const mag = a.mag === null ? null : Number(a.mag);
  const noise = mag === null ? 0 : 2 ** -52 * (1 + mag) ** 2;
  const worst = out.soft.reduce((m, s) => Math.max(m, s[1]), 0);
  let cls;
  if (out.exact && !out.zero && !out.tie) cls = "identical";
  else if (!out.hard.length && !out.soft.length) cls = out.zero ? "zero-sign" : out.tie ? "tie" : "digits";
  else if (mag !== null && !(worst > COARSE * noise) && out.hard.every((h) => h.type === "verdict" || h.type === "contacts") && verdictsWithin(a, b, COARSE * noise)) cls = "coarse";
  else cls = "other";
  return { cls, out, noise, worst };
}
/**
 * True when every difference of kind between the two sides is one that a gap moved by `slack` explains: a verdict
 * with a gap that close to its tolerance (or to 0, for strictlyValid), a contact with a gap that close to 1e-7.
 */
function verdictsWithin(a, b, slack) {
  return a.runs.every((r, k) => {
    const s = b.runs[k];
    const tol = k === 1 ? 1e-11 : 1e-9;
    const near = (g, at) => Math.abs(num(g) - at) <= slack;
    const gaps = [r.minGap, r.minPairGap, r.minContainerGap, s.minGap, s.minPairGap, s.minContainerGap];
    if ((r.valid !== s.valid || r.nErrors !== s.nErrors) && !gaps.some((g) => near(g, -tol))) return false;
    if (r.strictlyValid !== s.strictlyValid && r.valid === s.valid && !gaps.some((g) => near(g, 0))) return false;
    if (r.nContacts !== s.nContacts && !(slack >= 1e-12)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// tables

const CLASSES = ["identical", "digits", "zero-sign", "tie", "coarse", "other"];
const stat = () => ({ n: 0, cls: Object.fromEntries(CLASSES.map((c) => [c, 0])), valid9: 0, verdict: 0, reasons: 0, ts: 0, rs: 0, rsServer: 0 });
const MENU = [-1, -0.5, -0.25, -0.1, -0.01, -0.001, -0.0001, -1e-6, 1e-6, 0.0001, 0.001, 0.01, 0.1, 0.25, 0.5, 1];
const TILING = [-6.519717439579256, -4.50521902808615, -3.4413111779836725, -2.3365290558829845, -1.1892985685754194, 1.225778283313099];
const kOf = (c) => (typeof c.K === "number" ? c.K : c.K === "-0" ? -0 : Number(c.K));
const groups = {
  "BY KIND OF CASE": (c) => c.kind,
  "BY SOURCE OF THE CONFIGURATION": (c) => c.base,
  "BY CURVATURE": (c) => {
    const K = kOf(c);
    if (TILING.includes(K)) return `tiling ${K}`;
    if (MENU.includes(K)) return `menu ${K}`;
    if (K === 0) return "K = 0 (sweep)";
    if (!Number.isFinite(K)) return "not finite";
    return K > 0 ? "other K > 0" : "other K < 0";
  },
  "BY PIECE AND CONTAINER": (c) => `${c.N === 0 ? "disks" : c.N <= 6 ? "3-6-gons" : c.N <= 20 ? "7-20-gons" : "21-100-gons"} in a ${c.M === 0 ? "disk" : "polygon"}`,
  "BY NUMBER OF PIECES": (c) => (c.P <= 10 ? "P 0-10" : c.P <= 50 ? "P 11-50" : c.P <= 100 ? "P 51-100" : c.P <= 300 ? "P 101-300" : "P 301-500"),
};
const tables = Object.fromEntries(Object.keys(groups).map((g) => [g, new Map()]));
const total = stat();
const examples = [];
const reasonKinds = new Map();
let worstCoarse = 0;
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const { cls, out, noise, worst } = classify(i);
  const [a, b] = [ref[i], rust[i]];
  const verdict = a.runs.some((r, k) => r.valid !== b.runs[k].valid);
  const reasons = a.check.some((r, k) => r.length !== b.check[k].length || r.some((t, j) => split(t)[0] !== split(b.check[k][j])[0]));
  const add = (s) => {
    s.n++;
    s.cls[cls]++;
    if (a.runs[0].valid) s.valid9++;
    if (verdict) s.verdict++;
    if (reasons) s.reasons++;
    s.ts += tsTimes[i];
    s.rs += rsTimes[i];
    s.rsServer += rsServer[i];
  };
  add(total);
  for (const [g, key] of Object.entries(groups)) {
    const k = key(c);
    if (!tables[g].has(k)) tables[g].set(k, stat());
    add(tables[g].get(k));
  }
  // the reasons the TypeScript gives, with their numbers taken out, and whether the port gives the same
  for (const [k, list] of a.check.entries())
    for (const [j, text] of list.entries()) {
      const key = split(text)[0];
      const e = reasonKinds.get(key) ?? { n: 0, same: 0 };
      e.n++;
      if (b.check[k][j] !== undefined && split(b.check[k][j])[0] === key) e.same++;
      reasonKinds.set(key, e);
    }
  for (const [k, r] of a.runs.entries())
    for (const [j, text] of r.errors.entries()) {
      const key = "validator: " + split(text)[0];
      const e = reasonKinds.get(key) ?? { n: 0, same: 0 };
      e.n++;
      if (b.runs[k].errors[j] !== undefined && split(b.runs[k].errors[j])[0] === split(text)[0]) e.same++;
      reasonKinds.set(key, e);
    }
  if (cls === "coarse") worstCoarse = Math.max(worstCoarse, worst / noise);
  if (cls === "other" || cls === "coarse" || cls === "tie")
    examples.push({ cls, i, c, hard: out.hard, soft: out.soft, noise, worst });
}
const pad = (v, n) => String(v).padStart(n);
function show(title, map) {
  console.log(`\n${title}`);
  console.log("group".padEnd(30), " cases  valid identical digits zero-sign    tie coarse  other verdict≠ reason≠    TS µs  Rust µs  ratio");
  const rows = [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true }));
  for (const [k, s] of rows)
    console.log(
      String(k).padEnd(30), pad(s.n, 6), pad(s.valid9, 6), pad(s.cls.identical, 9), pad(s.cls.digits, 6), pad(s.cls["zero-sign"], 9), pad(s.cls.tie, 6),
      pad(s.cls.coarse, 6), pad(s.cls.other, 6), pad(s.verdict, 8), pad(s.reasons, 7), pad((s.ts / s.n / 1e3).toFixed(1), 8), pad((s.rs / s.n / 1e3).toFixed(1), 8),
      pad((s.ts / s.rs).toFixed(2), 6),
    );
}
for (const [g, map] of Object.entries(tables)) show(g, map);
show("ALL", new Map([["all cases", total]]));
console.log(`\nRust without the list of contacts (what the server reads): ${(total.rsServer / total.n / 1e3).toFixed(1)} µs a case, ${(total.ts / total.rsServer).toFixed(2)} times the TypeScript's speed`);

console.log("\nREASONS (numbers taken out): given by the TypeScript, and the same from the port");
for (const [k, e] of [...reasonKinds].sort((x, y) => x[0].localeCompare(y[0]))) console.log(pad(e.n, 7), pad(e.same, 7), " ", k);

if (examples.length) {
  console.log(`\nCASES THAT ARE NOT IDENTICAL, DIGITS OR ZERO-SIGN (${examples.length}; the first ${Math.min(nExamples, examples.length)} of each class)`);
  for (const cls of ["other", "coarse", "tie"]) {
    const list = examples.filter((e) => e.cls === cls);
    if (!list.length) continue;
    console.log(`\n ${cls}: ${list.length}`);
    for (const e of list.slice(0, nExamples)) {
      console.log(`  #${e.c.id} ${e.c.kind} (${e.c.base}) K=${e.c.K} N=${e.c.N} M=${e.c.M} P=${e.c.P}  resolution ${e.noise.toExponential(1)}  largest difference ${e.worst.toExponential(1)}`);
      for (const h of e.hard.slice(0, 3)) console.log("     " + h.text.slice(0, 260));
      for (const s of e.soft.slice(0, 3)) console.log(`     ${s[0]}: ${String(s[2]).slice(0, 110)} | ${String(s[3]).slice(0, 110)}`);
    }
  }
  if (worstCoarse) console.log(`\n largest coarse difference: ${worstCoarse.toExponential(1)} times the float check's resolution 2^-52 (1 + mag)^2`);
}

// ---------------------------------------------------------------------------------------------
// bounds and the domain

let boundOther = 0;
if (existsSync(`${dir}/bound-ref.jsonl`) && existsSync(`${dir}/bound-rust.jsonl`)) {
  const a = readFileSync(`${dir}/bound-ref.jsonl`, "utf8").trim().split("\n");
  const b = readFileSync(`${dir}/bound-rust.jsonl`, "utf8").trim().split("\n");
  if (a.length !== b.length) throw new Error(`bound lines: ${a.length} | ${b.length}`);
  const s = { lines: a.length, same: 0, maxP: 0, exists: 0, whyNot: 0, whyNotText: 0, boundKind: 0, bounds: 0, boundSame: 0, boundRel: 0, circ: 0, circSame: 0, circRel: 0, whyNots: 0, maxPs: 0, boundCoarse: 0, boundCoarseRatio: 0, boundCoarseRel: 0 };
  const shown = [];
  const coarseShown = [];
  const note = (text) => shown.length < nExamples && shown.push(text);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) {
      // the same text (serde_json writes an object's keys in alphabetical order, as the reference tool does here)
      s.same++;
      const x = JSON.parse(a[i]);
      s.maxPs++;
      for (const p of x.ps) (p[2] !== null && s.whyNots++, p[1] !== "skip" && (s.bounds++, s.boundSame++));
      (s.circ += x.circ.length), (s.circSame += x.circ.length);
      continue;
    }
    const [x, y] = [JSON.parse(a[i]), JSON.parse(b[i])];
    const where = `K=${x.K} N=${x.N} M=${x.M} limit=${x.limit}`;
    let same = true;
    s.maxPs++;
    if (x.maxP !== y.maxP) (s.maxP++, (same = false), note(`maxP ${where}: ${x.maxP} | ${y.maxP}`));
    if (x.exists !== y.exists) (s.exists++, (same = false), note(`exists ${where}: ${x.exists} | ${y.exists}`));
    x.ps.forEach((p, k) => {
      const q = y.ps[k];
      if (p[2] !== null || q[2] !== null) s.whyNots++;
      if (p[2] !== q[2]) {
        same = false;
        if (p[2] === null || q[2] === null || split(p[2])[0] !== split(q[2])[0] || !split(p[2])[1].every((v, j) => close(v, split(q[2])[1][j]))) (s.whyNot++, note(`whyNot ${where} P=${p[0]}: ${p[2]} | ${q[2]}`));
        else s.whyNotText++;
      }
      if (p[1] === "skip" && q[1] === "skip") return;
      s.bounds++;
      if (p[1] === q[1]) return void s.boundSame++;
      same = false;
      if (p[1] === null || q[1] === null || p[1] === "skip" || q[1] === "skip") return void (s.boundKind++, note(`bound ${where} P=${p[0]}: ${p[1]} | ${q[1]}`));
      const rel = Math.abs(Number(p[1]) - Number(q[1])) / Math.abs(Number(p[1]));
      s.boundRel = Math.max(s.boundRel, rel);
      if (rel <= 1e-12) return;
      // A polygon container at K < 0 near the ideal polygon: its side is (2 / r) atanh(a), r = sqrt(-K), with a
      // near 1, so a relative error e of a (one unit in the last place of a sinh) is e sinh(2x) / (2x) in the side,
      // x = r side / 2. A difference below COARSE times that is counted apart, with its size; anything else is a defect.
      const K = kOf(x);
      const half = (Math.sqrt(-K) * Number(p[1])) / 2;
      const cond = K < 0 && x.M > 0 ? Math.sinh(2 * half) / (2 * half) : 1;
      if (rel <= COARSE * 2 ** -52 * cond) {
        s.boundCoarse++;
        s.boundCoarseRatio = Math.max(s.boundCoarseRatio, rel / (2 ** -52 * cond));
        s.boundCoarseRel = Math.max(s.boundCoarseRel, rel);
        coarseShown.length < nExamples && coarseShown.push(`${where} P=${p[0]}: ${p[1]} | ${q[1]} (relative ${rel.toExponential(1)}, condition ${cond.toExponential(1)})`);
      } else (s.boundKind++, note(`bound ${where} P=${p[0]}: ${p[1]} | ${q[1]}`));
    });
    x.circ.forEach((p, k) => {
      const q = y.circ[k];
      s.circ++;
      if (p[1] === q[1]) return void s.circSame++;
      same = false;
      const [u, v] = [num(p[1]), num(q[1])];
      const rel = Math.abs(u - v) / Math.abs(u);
      s.circRel = Math.max(s.circRel, Number.isFinite(rel) ? rel : Infinity);
      if (!(rel <= 1e-12)) (boundOther++, note(`circumradius ${where} s=${p[0]}: ${p[1]} | ${q[1]}`));
    });
    if (same) s.same++;
  }
  boundOther += s.maxP + s.exists + s.whyNot + s.boundKind;
  console.log("\nBOUNDS AND THE DOMAIN (curvedMaxP, pieceExists, curvedBoundOf, curvedWhyNot, containerCircumradius)");
  console.log(` lines ${s.lines}, identical ${s.same}`);
  console.log(` curvedMaxP: ${s.maxPs} values, ${s.maxP} different; pieceExists: ${s.exists} different`);
  console.log(` curvedBoundOf: ${s.bounds} values, ${s.boundSame} the same double, ${s.bounds - s.boundSame - s.boundKind - s.boundCoarse} within 1e-12 relative, ${s.boundCoarse} coarse (see below), ${s.boundKind} otherwise (one side null, or farther)`);
  if (s.boundCoarse) {
    console.log(`   coarse: a polygon container at K < 0 so near the ideal polygon that its side, (2/r) atanh(a) with a near 1, turns one unit in the`);
    console.log(`   last place of a (a sinh) into up to ${s.boundCoarseRel.toExponential(1)} relative; the largest is ${s.boundCoarseRatio.toFixed(2)} times 2^-52 sinh(2x)/(2x), x = r side/2`);
    for (const t of coarseShown) console.log("     " + t);
  }
  console.log(` curvedWhyNot: ${s.whyNots} sentences, ${s.whyNotText} that differ in the digits of a number only, ${s.whyNot} that differ otherwise`);
  console.log(` containerCircumradius: ${s.circ} values, ${s.circSame} the same double, largest relative difference of the others ${s.circRel.toExponential(1)}`);
  for (const t of shown) console.log("   " + t.slice(0, 300));
}

const bad = total.cls.other + boundOther;
console.log(`\n${cases.length} cases: ${CLASSES.map((c) => `${total.cls[c]} ${c}`).join(", ")}; verdicts that differ ${total.verdict}; bound differences ${boundOther}`);
process.exit(bad ? 1 : 0);
