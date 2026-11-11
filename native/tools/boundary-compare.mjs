// Compares the Rust port of the boundary family with its TypeScript source, run by run and field by field.
//   node native/tools/boundary-compare.mjs OUTDIR        (after boundary-ref.mts gen and run, and the boundarydiff example)
// A run is one case at one tolerance. Two runs are
//   identical    when their JSON is the same text (verdict, score, every reason, and for the nD containers the work used);
//   last digits  when they differ only in numbers inside the reasons, which agree to 1e-6 relative or 1e-12 absolute
//                (native/PORTING.md: a penetration depth is a difference of nearly equal numbers);
//   and anything else is a difference of the port: another verdict, another list of reasons, another thrown error, another
//   score, or (nD) another count of search steps or multiply-adds, which shows the search took another path.
// The exit code is 1 when there is a difference of the last kind in the cases, or any in the extras other than the two
// rebuilt tables (the polytopes and pieces rebuilt by the ported builders are compared with the TypeScript's up to rounding).
import { existsSync, readFileSync, readdirSync } from "node:fs";
const dir = process.argv[2];
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cases = lines("cases.jsonl");
const merge = (prefix, ext) => readdirSync(dir).filter((f) => new RegExp(`^${prefix}(\\.\\d+)?\\.${ext}$`).test(f));
const ref = new Map();
for (const f of merge("ref", "jsonl")) for (const r of lines(f)) ref.set(r.id, r.runs);
const rust = new Map(lines("rust.jsonl").map((r) => [r.id, r.runs]));
const tsTimes = new Map();
for (const f of merge("ts-times", "json")) for (const r of JSON.parse(readFileSync(`${dir}/${f}`, "utf8"))) tsTimes.set(r.id, r.t);
const rsTimes = existsSync(`${dir}/rust-times.json`) ? new Map(JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8")).map((r) => [r.id, r.t])) : new Map();

const NUMBER = /-?\d+(\.\d+)?(e[-+]?\d+)?/g;
const template = (r) => r.replace(NUMBER, "#");
const close = (x, y) => x === y || Math.abs(x - y) <= 1e-12 || Math.abs(x - y) <= 1e-6 * Math.max(Math.abs(x), Math.abs(y));
/** "same", "digits" or the name of the first field that differs. */
function classify(a, b) {
  // the same text once the fields are written in one order (the two sides' JSON writers order an object's keys differently)
  const text = (r) => JSON.stringify([r.tol, r.throw ?? null, r.ok ?? null, r.score ?? null, r.reasons ?? null, r.steps ?? null, r.ops ?? null]);
  if (text(a) === text(b)) return "same";
  if ((a.throw === undefined) !== (b.throw === undefined) || a.throw !== b.throw) return "throw";
  if (a.ok !== b.ok) return "verdict";
  if (a.score !== b.score) return "score";
  if (a.reasons.length !== b.reasons.length) return "reasons";
  for (let i = 0; i < a.reasons.length; i++) {
    if (template(a.reasons[i]) !== template(b.reasons[i])) return "reasons";
    const x = a.reasons[i].match(NUMBER) ?? [];
    const y = b.reasons[i].match(NUMBER) ?? [];
    for (let k = 0; k < x.length; k++) if (!close(Number(x[k]), Number(y[k]))) return "reasons";
  }
  if (a.steps !== b.steps || a.ops !== b.ops) return "work";
  return "digits";
}

const stat = () => ({ runs: 0, same: 0, digits: 0, work: 0, verdict: 0, reasons: 0, throw: 0, score: 0, valid: 0, ts: 0, rs: 0, timed: 0 });
const VALID = "TIMINGS OF VALID PACKINGS BY KIND OF PROBLEM (the whole check runs; best of five per run)";
const tables = { "BY GROUP": new Map(), "BY CONTAINER": new Map(), "BY PIECE": new Map(), "BY KIND OF CASE": new Map(), "BY TOLERANCE": new Map(), "TIMINGS BY KIND OF PROBLEM (best of five per run)": new Map(), [VALID]: new Map() };
const reasonsSeen = new Map();
const examples = [];
const pBand = (P) => (P <= 2 ? "P 1-2" : P <= 8 ? "P 3-8" : P <= 24 ? "P 9-24" : P <= 100 ? "P 25-100" : "P 101-400");
let missing = 0;
for (const c of cases) {
  const a = ref.get(c.id);
  const b = rust.get(c.id);
  if (!a || !b) {
    missing++;
    continue;
  }
  const kind = c.kind.replace(/^(tight2?|tight-alone|record|prototype|search|site|beyond-catalogue):/, "").replace(/^(tight2?|tight-alone|record|prototype|search|site|beyond-catalogue)$/, "real or tight").replace(/^(malformed|limit|ridge|fold|tol|snap-band|rounding-band|hunt):.*/, "$1").replace(/^seed.*/, "seed");
  for (let k = 0; k < a.length; k++) {
    const cls = classify(a[k], b[k]);
    const keys = [
      ["BY GROUP", c.group],
      ["BY CONTAINER", c.group === "poly4" ? c.problem.polytope : c.problem.polytope.replace(/^\d+/, "d-") + " d=" + (c.problem.polytope.match(/^\d+/)?.[0] ?? "?")],
      ["BY PIECE", `${c.group} ${c.problem.piece}`],
      ["BY KIND OF CASE", kind],
      ["BY TOLERANCE", String(a[k].tol)],
      ["TIMINGS BY KIND OF PROBLEM (best of five per run)", `${c.group === "poly4" ? c.problem.polytope : c.problem.polytope.replace(/^\d+/, "d-")} ${c.problem.piece === "ball" ? "ball" : c.group === "poly4" ? "solid" : "cube"} ${pBand(c.problem.P)}`],
    ];
    if (a[k].ok) keys.push([VALID, keys[5][1]]);
    for (const [t, key] of keys) {
      const s = tables[t].get(key) ?? stat();
      tables[t].set(key, s);
      s.runs++;
      if (cls === "same") s.same++;
      else s[cls]++;
      if (a[k].ok) s.valid++;
      const tt = tsTimes.get(c.id)?.[k];
      const rt = rsTimes.get(c.id)?.[k];
      if (tt !== undefined && rt !== undefined) {
        s.ts += tt;
        s.rs += rt;
        s.timed++;
      }
    }
    for (const r of a[k].reasons ?? []) {
      const key = `${c.group}: ${template(r)}`;
      reasonsSeen.set(key, (reasonsSeen.get(key) ?? 0) + 1);
    }
    if (a[k].throw) reasonsSeen.set(`${c.group}: (throws) ${template(a[k].throw)}`, (reasonsSeen.get(`${c.group}: (throws) ${template(a[k].throw)}`) ?? 0) + 1);
    if (cls !== "same" && cls !== "digits" && examples.length < 40) examples.push({ id: c.id, kind: c.kind, problem: c.problem, tol: a[k].tol, cls, ts: a[k], rust: b[k] });
    if (cls === "digits" && examples.filter((e) => e.cls === "digits").length < 6) examples.push({ id: c.id, kind: c.kind, problem: c.problem, tol: a[k].tol, cls, ts: a[k].reasons?.find((r, i) => r !== b[k].reasons[i]), rust: b[k].reasons?.find((r, i) => r !== a[k].reasons[i]) });
  }
}
const pad = (v, n) => String(v).padStart(n);
let bad = 0;
for (const [title, map] of Object.entries(tables)) {
  console.log(`\n${title}`);
  console.log("".padEnd(34), "  runs valid identical digits work≠ verdict≠ reasons≠ throw≠ score≠     TS µs   Rust µs speedup");
  for (const [k, s] of [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true }))) {
    console.log(String(k).padEnd(34), pad(s.runs, 6), pad(s.valid, 5), pad(s.same, 9), pad(s.digits, 6), pad(s.work, 5), pad(s.verdict, 8), pad(s.reasons, 8), pad(s.throw, 6), pad(s.score, 6), pad(s.timed ? (s.ts / s.timed / 1e3).toFixed(1) : "-", 9), pad(s.timed ? (s.rs / s.timed / 1e3).toFixed(1) : "-", 9), pad(s.timed ? (s.ts / s.rs).toFixed(1) : "-", 7));
    if (title === "BY GROUP") bad += s.work + s.verdict + s.reasons + s.throw + s.score;
  }
}
console.log(`\nREASONS MET (sentence, with its numbers replaced; runs of the TypeScript in which it appears)`);
for (const [k, n] of [...reasonsSeen].sort((x, y) => x[0].localeCompare(y[0]))) console.log(pad(n, 6), k);
console.log(`\ncases: ${cases.length}${missing ? `, ${missing} WITHOUT A RESULT ON ONE SIDE` : ""}`);
if (examples.length) console.log("\nexamples of differences:");
for (const e of examples) console.log(JSON.stringify(e).slice(0, 1500));

// ------------------------------------------------------------------------------------------------------------ extras
if (existsSync(`${dir}/rust-extras.jsonl`)) {
  const extras = lines("extras.jsonl");
  const ea = new Map(lines("ref-extras.jsonl").map((r) => [r.id, r.out]));
  const eb = new Map(lines("rust-extras.jsonl").map((r) => [r.id, r.out]));
  /** Deep comparison: structure (keys, lengths, texts, integers of the topology) and the numbers apart. */
  const deep = (x, y, acc) => {
    if (typeof x === "number" && typeof y === "number") {
      acc.numbers++;
      if (x !== y) {
        acc.differ++;
        acc.maxAbs = Math.max(acc.maxAbs, Math.abs(x - y));
        acc.maxRel = Math.max(acc.maxRel, Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y)));
      }
    } else if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) x.forEach((v, i) => deep(v, y[i], acc));
    else if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y) && Object.keys(x).join() === Object.keys(y).join()) for (const k of Object.keys(x)) deep(x[k], y[k], acc);
    else if (x !== y) acc.structure++;
    return acc;
  };
  const byFn = new Map();
  const shown = [];
  for (const q of extras) {
    const s = byFn.get(q.fn) ?? { n: 0, same: 0, numbers: 0, differ: 0, maxAbs: 0, maxRel: 0, structure: 0 };
    byFn.set(q.fn, s);
    s.n++;
    let x = ea.get(q.id);
    let y = eb.get(q.id);
    // the domain's description is compared as text: the same fields in the same order
    if (q.fn === "domainInfo") y = JSON.stringify(JSON.parse(y));
    const acc = deep(x, y, { numbers: 0, differ: 0, maxAbs: 0, maxRel: 0, structure: 0 });
    if (!acc.differ && !acc.structure) s.same++;
    else if (shown.length < 12 && !/Built$/.test(q.fn)) shown.push([JSON.stringify(q), JSON.stringify(x).slice(0, 300), JSON.stringify(y).slice(0, 300)]);
    s.numbers += acc.numbers;
    s.differ += acc.differ;
    s.structure += acc.structure;
    s.maxAbs = Math.max(s.maxAbs, acc.maxAbs);
    s.maxRel = Math.max(s.maxRel, acc.maxRel);
    if ((acc.differ || acc.structure) && !/Built$/.test(q.fn)) bad++;
    if (acc.structure && /Built$/.test(q.fn)) bad++;
  }
  console.log("\nTHE OTHER FUNCTIONS THE SERVER USES (calls, identical results; numbers compared, numbers that differ, largest difference)");
  console.log("".padEnd(18), " calls identical   numbers   differ   max abs   max rel structure≠");
  for (const [k, s] of byFn) console.log(k.padEnd(18), pad(s.n, 6), pad(s.same, 9), pad(s.numbers, 9), pad(s.differ, 8), pad(s.maxAbs.toExponential(1), 9), pad(s.maxRel.toExponential(1), 9), pad(s.structure, 10));
  for (const e of shown) console.log("  differs:", e.join(" | "));
}
console.log(bad ? `\n${bad} DIFFERENCES TO EXPLAIN` : "\nno difference beyond the last digits of numbers");
process.exit(bad ? 1 : 0);
