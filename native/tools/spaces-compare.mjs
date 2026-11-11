// Compares the Rust port of the spaces layer with the TypeScript, case by case and field by field
// (native/PORTING.md, "Comparing a port with its source").
//
//   node native/tools/spaces-compare.mjs OUTDIR [--verbose]
//
// OUTDIR holds what native/tools/spaces-ref.mts wrote (cases.jsonl, ref.jsonl, ts-times.json,
// aux-cases.jsonl, aux-ref.jsonl, index.ts.jsonl, listing-<space>.ts.json, spaces.ts.json) and what
// the example spacesdiff wrote (rust.jsonl, rust-times.json, aux-rust.jsonl, index.rust.jsonl,
// listing-<space>.rust.json, spaces.rust.json).
//
// A case is "identical" when the two answers are the same bytes. Otherwise the answers are compared
// field by field: booleans, counts, the keys and their order, and the text of every message must be
// the same; a computed number (in a field or inside a message) may differ by 1e-6 relative or 1e-12
// absolute, and the case is then "last digits". A stored configuration (`config`) and an id must be
// the same text: what a configuration states is passed through bit for bit. Anything else is
// "DIFFERENT" and is printed. Three kinds of answer have rules of their own, each counted apart:
//  - "tie": two reasons that name different pieces (or translates) with depths equal to 1e-9
//    relative, when every other field agrees: two pairs equally deep, and the order in which a
//    validator meets them hangs on the last digit of a sine;
//  - "engine's words": a log line whose tail is the JavaScript engine's own message of a JSON
//    syntax error (after "not JSON: " or "records not loaded: "), which the port does not copy;
//  - "timing": the on-demand loader's answers to simultaneous loads (threads in Rust, promises in
//    Node): what is served must be the same; the order of the cache and of the log, the most reads
//    at once and the number of reads of an entry that fails are compared as the timing allows
//    (see `loaderDiffer`).
// The exit status is 1 when anything is DIFFERENT.
import { existsSync, readFileSync } from "node:fs";

const dir = process.argv[2];
const verbose = process.argv.includes("--verbose");
if (!dir) throw new Error("usage: spaces-compare.mjs OUTDIR [--verbose]");
const read = (f) => readFileSync(`${dir}/${f}`, "utf8");
const lines = (f) => read(f).split("\n").filter((l) => l.length > 0);

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
  if (a.replace(NUMBER, "#") !== b.replace(NUMBER, "#")) return false;
  const x = a.match(NUMBER) ?? [];
  const y = b.match(NUMBER) ?? [];
  // whole numbers (indices, counts) must be the same; the tolerance is for computed lengths
  const whole = /^-?\d+$/;
  return x.length === y.length && x.every((v, i) => (whole.test(v) && whole.test(y[i]) ? v === y[i] : near(Number(v), Number(y[i]))));
}
/** Fields whose text is passed through and must be the same bytes. */
const EXACT = new Set(["config", "id", "formatted", "text", "served", "ids", "cached", "byId", "summary_exact"]);
const ENGINE = /^(.*(?:not JSON: |records not loaded: ))(?!E[A-Z]+: )/;
let notes = { engine: 0 };
/** Deep comparison with the tolerance above; returns the path of the first difference. */
function differ(a, b, path = "", key = "") {
  if (a === b) return null;
  if (typeof a === "string" && typeof b === "string") {
    if (EXACT.has(key)) return `${path}: ${clip(a)} | ${clip(b)}`;
    if (textNear(a, b)) return null;
    const ea = ENGINE.exec(a);
    const eb = ENGINE.exec(b);
    if (ea && eb && ea[1] === eb[1]) {
      notes.engine++;
      return null;
    }
    return `${path}: ${clip(a)} | ${clip(b)}`;
  }
  if (typeof a === "number" && typeof b === "number") return near(a, b) && !EXACT.has(key) ? null : `${path}: ${a} | ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: ${a.length} items | ${b.length} items`;
    for (let i = 0; i < a.length; i++) {
      const d = differ(a[i], b[i], `${path}[${i}]`, key);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join() !== kb.join()) return `${path}: fields ${ka.join()} | ${kb.join()}`;
    for (const k of ka) {
      const d = differ(a[k], b[k], `${path}.${k}`, k);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${clip(JSON.stringify(a))} | ${clip(JSON.stringify(b))}`;
}
function clip(s) {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t.length > 300 ? `${JSON.stringify(t.slice(0, 300))}... (${t.length} characters)` : JSON.stringify(t);
}

/**
 * A tie: the two verdicts agree in everything but their reasons, the reasons are as many, and each
 * pair of reasons is the same sentence about other pieces with numbers that agree to 1e-9 relative
 * (the depth of the overlap), or the same reason in another place of the list.
 */
function isTie(A, B) {
  for (const which of ["sync", "async"]) {
    const a = A[which];
    const b = B[which];
    if (differ({ ...a, reasons: null }, { ...b, reasons: null })) return false;
    if (a.reasons.length !== b.reasons.length) return false;
    const depths = (r) => (r.match(NUMBER) ?? []).filter((v) => !/^-?\d+$/.test(v)).map(Number);
    const shape = (r) => r.replace(NUMBER, "#");
    for (let i = 0; i < a.reasons.length; i++) {
      const x = a.reasons[i];
      const y = b.reasons[i];
      if (textNear(x, y)) continue;
      if (shape(x) !== shape(y)) return false;
      const dx = depths(x);
      const dy = depths(y);
      if (!dx.length || dx.length !== dy.length) return false;
      if (!dx.every((v, k) => Math.abs(v - dy[k]) <= 1e-9 * Math.max(Math.abs(v), Math.abs(dy[k]), 1e-3))) return false;
    }
  }
  return true;
}

const stat = () => ({ n: 0, same: 0, digits: 0, tie: 0, different: 0, valid: 0, invalid: 0, malformed: 0, strict: 0 });
const row = (name, s) =>
  `${name.padEnd(34)} ${String(s.n).padStart(6)} ${String(s.same).padStart(9)} ${String(s.digits).padStart(11)} ${String(s.tie).padStart(5)} ${String(s.different).padStart(10)}`;
const head = (name) => `${name.padEnd(34)} ${"cases".padStart(6)} ${"identical".padStart(9)} ${"last digits".padStart(11)} ${"ties".padStart(5)} ${"DIFFERENT".padStart(10)}`;
let failed = false;
const examples = [];
const show = (text) => {
  failed = true;
  if (examples.length < (verbose ? 400 : 40)) examples.push(text);
};

// ---- main cases ------------------------------------------------------------------------------
{
  const cases = lines("cases.jsonl");
  const ref = lines("ref.jsonl");
  const rust = lines("rust.jsonl");
  if (ref.length !== cases.length || rust.length !== cases.length) throw new Error(`misaligned: ${cases.length} cases, ${ref.length} reference answers, ${rust.length} Rust answers`);
  const bySpace = new Map();
  const byKind = new Map();
  const total = stat();
  const group = (kind) =>
    kind.startsWith("bad:") || kind.startsWith("missing:") || kind.startsWith("lattice=") || kind.startsWith("q=")
      ? "malformed: a value at each place"
      : /^(many-errors|size-wrong|no-list|extra-fields|base)/.test(kind)
        ? "malformed: many errors, extra fields"
        : kind.startsWith("id-")
          ? "ids that are not the space's"
          : kind.startsWith("shrink-")
            ? "mutant: size shrunk"
            : kind.startsWith("below-bound") || kind === "unbounded" || kind === "grow-1e-9"
              ? "mutant: size at the bound"
              : /^(overlap|outside|one-fewer|one-more|maxP-below|no-options)/.test(kind)
                ? "mutant: pieces moved, counts"
                : kind.startsWith("work-limit")
                  ? "work limits"
                  : kind;
  const kinds = [];
  for (let i = 0; i < cases.length; i++) {
    const c = JSON.parse(cases[i]);
    const A = JSON.parse(ref[i]);
    let verdict = "same";
    if (ref[i] !== rust[i]) {
      const B = JSON.parse(rust[i]);
      if (A.id !== c.id || B.id !== c.id) throw new Error(`misaligned at line ${i + 1}`);
      const why = differ(A, B);
      verdict = !why ? "digits" : isTie(A, B) && !differ(A.parse, B.parse) ? "tie" : "different";
      if (verdict === "different") show(`case ${c.id} (${c.space}, ${c.kind}, ${c.problem}) ${why}`);
      if (verdict === "tie" && verbose) console.log(`tie: case ${c.id} (${c.space}, ${c.kind}, ${c.problem})\n  ts   ${JSON.stringify(A.sync.reasons)}\n  rust ${JSON.stringify(B.sync.reasons)}`);
    }
    // the reference's two verdicts agree, unless a polytope of the ndim space was not loaded yet
    const g = group(c.kind);
    if (!kinds.includes(g)) kinds.push(g);
    for (const [table, key] of [[bySpace, c.space], [byKind, g], [null, null]]) {
      let s = total;
      if (table) {
        if (!table.has(key)) table.set(key, stat());
        s = table.get(key);
      }
      s.n++;
      s[verdict]++;
      if (A.async.valid) s.valid++;
      else if (A.async.malformed) s.malformed++;
      else s.invalid++;
      if (A.async.reasons[0]?.includes("only within the float tolerance")) s.strict++;
    }
  }
  console.log("validateSpaceSubmission, its Async variant and parseSpaceConfig");
  console.log(head("by space"));
  for (const [k, s] of bySpace) console.log(row(k, s));
  console.log(row("all", total));
  console.log("");
  console.log(head("by kind of case"));
  for (const k of kinds) console.log(row(k, byKind.get(k)));
  console.log("");
  console.log(`${"verdicts of the reference".padEnd(34)} ${"cases".padStart(6)} ${"valid".padStart(9)} ${"invalid".padStart(11)} ${"malformed".padStart(10)} ${"strict".padStart(8)}`);
  for (const [k, s] of [...bySpace, ["all", total]])
    console.log(`${k.padEnd(34)} ${String(s.n).padStart(6)} ${String(s.valid).padStart(9)} ${String(s.invalid).padStart(11)} ${String(s.malformed).padStart(10)} ${String(s.strict).padStart(8)}`);
  console.log("(strict: refused by the strict check at 1e-11 after passing at 1e-9)");
  console.log("");

  // timings
  if (existsSync(`${dir}/rust-times.json`) && existsSync(`${dir}/ts-times.json`)) {
    const ts = JSON.parse(read("ts-times.json"));
    const rs = JSON.parse(read("rust-times.json"));
    const t = new Map();
    for (let i = 0; i < cases.length; i++) {
      const c = JSON.parse(cases[i]);
      const what = c.kind === "entry" || c.kind === "record" || c.kind === "record-strict" ? "real packings" : "every other case";
      for (const key of [`${c.space}: ${what}`, `all: ${what}`]) {
        if (!t.has(key)) t.set(key, { n: 0, ts: 0, rs: 0, tsMax: 0, rsMax: 0 });
        const s = t.get(key);
        s.n++;
        s.ts += ts[i];
        s.rs += rs[i];
        s.tsMax = Math.max(s.tsMax, ts[i]);
        s.rsMax = Math.max(s.rsMax, rs[i]);
      }
    }
    const ms = (ns) => (ns / 1e6).toFixed(ns < 1e5 ? 4 : 3);
    console.log("validateSpaceSubmission, best of five per case (milliseconds)");
    console.log(`${"".padEnd(30)} ${"cases".padStart(6)} ${"TS mean".padStart(10)} ${"Rust mean".padStart(10)} ${"TS max".padStart(10)} ${"Rust max".padStart(10)} ${"ratio".padStart(7)}`);
    const order = (k) => (k.endsWith("real packings") ? 0 : 100) + (k.startsWith("all") ? 50 : 0);
    for (const key of [...t.keys()].sort((a, b) => order(a) - order(b))) {
      const s = t.get(key);
      console.log(
        `${key.padEnd(30)} ${String(s.n).padStart(6)} ${ms(s.ts / s.n).padStart(10)} ${ms(s.rs / s.n).padStart(10)} ${ms(s.tsMax).padStart(10)} ${ms(s.rsMax).padStart(10)} ${(s.ts / s.rs).toFixed(1).padStart(7)}`,
      );
    }
    console.log("");
  }
}

// ---- the index of data/, the listings, GET /api/spaces ---------------------------------------
{
  const a = lines("index.ts.jsonl");
  const b = lines("index.rust.jsonl");
  const s = stat();
  if (a.length !== b.length) show(`index: ${a.length} lines | ${b.length} lines`);
  else
    for (let i = 0; i < a.length; i++) {
      s.n++;
      if (a[i] === b[i]) s.same++;
      else {
        const why = differ(JSON.parse(a[i]), JSON.parse(b[i]));
        if (why) {
          s.different++;
          show(`index line ${i + 1}: ${why}`);
        } else s.digits++;
      }
    }
  console.log(head("the repository's data/"));
  console.log(row("loadSpacesIndex: log, entries", s));
  const files = ["spaces", ...JSON.parse(a[0]).log.map((m) => /^\[spaces\] ([a-z]+):/.exec(m)?.[1]).filter(Boolean).map((sp) => `listing-${sp}`)];
  for (const f of files) {
    const x = read(`${f}.ts.json`);
    const y = existsSync(`${dir}/${f}.rust.json`) ? read(`${f}.rust.json`) : "";
    const t = stat();
    t.n = 1;
    if (x === y) t.same = 1;
    else {
      const why = y ? differ(JSON.parse(x), JSON.parse(y)) : "no Rust file";
      if (why) {
        t.different = 1;
        show(`${f}: ${why}`);
      } else t.digits = 1;
    }
    console.log(row(`${f}.json (${x.length} bytes)`, t));
  }
  console.log("");
}

// ---- auxiliary cases -------------------------------------------------------------------------
/** The loader's answers: the same, as far as the timing of simultaneous loads lets them be. */
function loaderDiffer(c, A, B) {
  if (differ(A.skipped, B.skipped)) return differ(A.skipped, B.skipped, ".skipped");
  if (A.steps.length !== B.steps.length) return `.steps: ${A.steps.length} | ${B.steps.length}`;
  let parallel = false;
  // loads of one step that ask for the same entry, when its read fails: one read in Node, one or more with threads
  let slack = 0;
  for (let k = 0; k < A.steps.length; k++) {
    const ids = c.steps[k];
    const x = A.steps[k];
    const y = B.steps[k];
    const d = differ(x.served, y.served, `.steps[${k}].served`, "served");
    if (d) return d;
    if (ids.length > 1) {
      parallel = true;
      const failed = new Set(ids.filter((id, i) => x.served[i] === null));
      for (const id of failed) slack += ids.filter((v) => v === id).length - 1;
    }
    if (parallel) {
      if (differ([...x.cached].sort(), [...y.cached].sort(), "", "cached") && x.stats.bytes === y.stats.bytes) return `.steps[${k}].cached (as sets): ${clip(x.cached)} | ${clip(y.cached)}`;
      if (y.stats.peakAtOnce > c.atOnce) return `.steps[${k}]: ${y.stats.peakAtOnce} reads at once, above ${c.atOnce}`;
      if (y.stats.reads < x.stats.reads || y.stats.reads > x.stats.reads + slack) return `.steps[${k}].stats.reads: ${x.stats.reads} | ${y.stats.reads}`;
    } else {
      const e = differ({ cached: x.cached, stats: x.stats }, { cached: y.cached, stats: y.stats }, `.steps[${k}]`);
      if (e) return e;
    }
  }
  if (!parallel) return differ(A.log, B.log, ".log");
  // the log of simultaneous loads: the same lines, in any order, a failed read's line once per read
  const x = [...new Set(A.log)].sort();
  const y = [...new Set(B.log)].sort();
  return differ(x, y, ".log (as sets)");
}
{
  const cases = lines("aux-cases.jsonl");
  const ref = lines("aux-ref.jsonl");
  const rust = lines("aux-rust.jsonl");
  if (ref.length !== cases.length || rust.length !== cases.length) throw new Error(`misaligned: ${cases.length} auxiliary cases, ${ref.length} | ${rust.length}`);
  const byKind = new Map();
  let timing = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = JSON.parse(cases[i]);
    const key = c.kind === "id" || c.kind === "domain-bound" || c.kind === "problem" || c.kind === "catalogue" || c.kind === "domain-sample" ? `${c.kind}: ${c.space}` : c.kind;
    if (!byKind.has(key)) byKind.set(key, stat());
    const s = byKind.get(key);
    s.n++;
    if (ref[i] === rust[i]) {
      s.same++;
      continue;
    }
    const A = JSON.parse(ref[i]);
    const B = JSON.parse(rust[i]);
    const before = notes.engine;
    const why = c.kind === "loader" ? loaderDiffer(c, A.result, B.result) : differ(A, B);
    if (why) {
      s.different++;
      show(`auxiliary case ${c.id} (${key}${c.value !== undefined ? `, ${JSON.stringify(c.value)}` : ""}${c.name ? `, ${c.name}` : ""}) ${why}`);
    } else if (c.kind === "loader" && c.steps.some((ids) => ids.length > 1)) {
      timing++;
      s.timing = (s.timing ?? 0) + 1;
    } else if (notes.engine > before) s.engine = (s.engine ?? 0) + 1;
    else s.digits++;
  }
  console.log(head("auxiliary cases"));
  for (const [k, s] of byKind)
    console.log(row(k, s) + (s.engine ? `   (${s.engine} with the engine's words)` : "") + (s.timing ? `   (${s.timing} equal as far as the timing allows)` : ""));
  console.log("");
  console.log(`loader scenarios with simultaneous loads, equal as far as their timing allows: ${timing}`);
  console.log(`log lines that end in the JavaScript engine's own words for a JSON syntax error: ${notes.engine}`);
}

if (examples.length) {
  console.log("");
  console.log("DIFFERENT:");
  for (const e of examples) console.log("  " + e);
}
process.exit(failed ? 1 : 0);
