// Compares the Rust port of the flat family with its TypeScript source, field by field, on the
// cases of flat-ref.mts (see there for the three commands):
//   node native/tools/flat-compare.mjs OUTDIR [--examples N]
//
// The rule is native/PORTING.md's. Two answers agree when they have the same structure, the same
// booleans, counts and piece indices, and
//  - every text is equal once each number in it is replaced by a placeholder, and those numbers
//    agree to 1e-6 relative or 1e-12 absolute (a penetration depth is a difference of nearly equal
//    numbers, so it keeps fewer digits than its inputs);
//  - every other number agrees to 1e-12 of its scale: the larger of the two numbers, and at least 1.
// Cases that are identical byte for byte (every number the same double, every text the same
// characters) are counted separately ("ident"); the others that agree are "digits".
//
// Two things are counted apart and listed, not hidden:
//
//  - "scale": a case that fails the rule above only because its coordinates are large is compared
//    again at the scale of its largest coordinate. The centre of a container about pieces at
//    (1e6, 1e6) and (-1e6, -1e6) is a difference of numbers near 1e6, and so is the size of a set
//    of points all near (1e6, -1e6).
//  - "tie": a choice among candidates that are equal to the last digit, which the last digit of a
//    sine then decides. Each is verified from the data, never assumed:
//      * the pair a refusal names ("deepest found is pieces i and j"): accepted when each side's
//        pair is, on both sides, among the overlaps within 1e-12 of the deepest;
//      * the normal a separation kernel returns: accepted when the separations agree and each
//        side's normal, taken as an axis, gives that separation (recomputed here from the vertices);
//      * the orientation auto-orientation returns (autoOrientSet for a set of points, evaluate with
//        autoOrient for a board, which the server never asks for): accepted when the sizes agree
//        and each side's container holds every point of the hull, or every vertex of the board;
//      * a separation compared with a threshold (separationBelow): accepted when both sides'
//        separations are within 1e-12 of the threshold. Leading boards are built with gaps of
//        exactly 1e-11, one of the thresholds asked.
//
// Anything else is a difference ("DIFF"), listed with the path of the field. The exit status is 1
// when there is one outside the kind "json-text", whose cases compare JSON.parse with serde_json
// (the JSON layer of the server, not the port).
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const dir = argv[0];
const exAt = argv.indexOf("--examples");
const maxExamples = exAt >= 0 ? Number(argv[exAt + 1]) : 25;
if (!dir) {
  console.error("usage: flat-compare.mjs OUTDIR [--examples N]");
  process.exit(2);
}
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const NUMBER = /\d+(?:\.\d+)?(?:e[+-]?\d+)?/g;
/** 0 identical, 1 equal up to the last digits of numbers, 2 different; `where` gets the first path that differs. */
function compare(a, b, path, where, stats, scale = 1) {
  if (typeof a === "number" && typeof b === "number") {
    if (Object.is(a, b) || a === b) return 0;
    const d = Math.abs(a - b);
    const rel = d / Math.max(1, Math.abs(a), Math.abs(b), scale);
    if (stats) stats.maxRel = Math.max(stats.maxRel, rel);
    if (rel <= 1e-12) return 1;
    where.push(`${path}: ${a} against ${b}`);
    return 2;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return 0;
    const na = a.match(NUMBER) ?? [];
    const nb = b.match(NUMBER) ?? [];
    const same = a.replace(NUMBER, "#") === b.replace(NUMBER, "#") &&
      na.every((x, i) => Math.abs(x - nb[i]) <= 1e-12 || Math.abs(x - nb[i]) <= 1e-6 * Math.max(Math.abs(x), Math.abs(nb[i])));
    if (same) return 1;
    where.push(`${path}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`);
    return 2;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      where.push(`${path}: ${a.length} entries against ${b.length}`);
      return 2;
    }
    let worst = 0;
    for (let i = 0; i < a.length && worst < 2; i++) worst = Math.max(worst, compare(a[i], b[i], `${path}[${i}]`, where, stats, scale));
    return worst;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    let worst = 0;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a) || !(key in b)) {
        where.push(`${path}.${key}: on one side only`);
        return 2;
      }
      worst = Math.max(worst, compare(a[key], b[key], `${path}.${key}`, where, stats, scale));
      if (worst === 2) return 2;
    }
    return worst;
  }
  if (a === b) return 0;
  where.push(`${path}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`);
  return 2;
}

/** The largest |coordinate| among the numbers of `v` (poses, flat point lists). */
function coordinateScale(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.abs(v) : 0;
  if (Array.isArray(v)) return v.reduce((m, x) => Math.max(m, coordinateScale(x)), 0);
  if (v && typeof v === "object") return Math.max(coordinateScale(v.x ?? 0), coordinateScale(v.y ?? 0));
  return 0;
}

// ------------------------------------------------------------------ ties, verified from the data
const DEEPEST = /deepest found is pieces (\d+) and (\d+),/;
/**
 * The port's reasons with the pair of the reference's, when the two name different pairs that
 * both sides hold among the overlaps within 1e-12 of the deepest; null when there is no such tie.
 */
function deepestTie(sa, sb) {
  if (!sa || !sb || sa.reasons.length !== sb.reasons.length) return null;
  let out = null;
  sb.reasons.forEach((rb, i) => {
    const ra = sa.reasons[i];
    const ma = DEEPEST.exec(ra);
    const mb = DEEPEST.exec(rb);
    if (!ma || !mb || (ma[1] === mb[1] && ma[2] === mb[2])) return;
    const among = (o, m) => o.deepest.some((p) => p[0] === +m[1] && p[1] === +m[2]);
    if (among(sa.overlaps, ma) && among(sa.overlaps, mb) && among(sb.overlaps, ma) && among(sb.overlaps, mb)) {
      out ??= [...sb.reasons];
      out[i] = rb.replace(DEEPEST, ma[0]);
    }
  });
  return out;
}

function pieceVertices(N, pose, scale) {
  const R = scale / (2 * Math.sin(Math.PI / N));
  return Array.from({ length: N }, (_, k) => {
    const t = pose.theta + Math.PI / 2 + (k * 2 * Math.PI) / N;
    return [pose.x + R * Math.cos(t), pose.y + R * Math.sin(t)];
  });
}
/**
 * The gap of a pair call along the unit direction n, the one in which moving A (for polygonCircle
 * the circle) increases it. The separation is the largest gap over all directions, so a normal
 * whose gap equals the separation is as good as any other.
 */
function gapAlong(key, c, n) {
  const dot = (p) => p[0] * n[0] + p[1] * n[1];
  const va = pieceVertices(c.N, c.a, c.scale).map(dot);
  if (key === "polygonCircle") return c.b.x * n[0] + c.b.y * n[1] - Math.max(...va) - 0.5 * c.scale;
  const vb = pieceVertices(c.N, c.b, c.scale).map(dot);
  return Math.min(...va) - Math.max(...vb);
}
/** The keys of a pair call whose normals differ in a verified tie. */
function normalTies(c, a, b) {
  const keys = [];
  if (c.fn !== "pair" || c.N === 0) return keys;
  const tol = 1e-12 * Math.max(1, coordinateScale([c.a, c.b]));
  for (const key of ["piece", "regular", "polygon", "polygonCircle"]) {
    const ka = a[key];
    const kb = b[key];
    if (!ka || !kb || ka.length !== 3 || kb.length !== 3) continue;
    if (compare(ka, kb, key, [], null, tol * 1e12) < 2) continue;
    if (Math.abs(ka[0] - kb[0]) > tol) continue;
    const ga = gapAlong(key, c, [ka[1], ka[2]]);
    const gb = gapAlong(key, c, [kb[1], kb[2]]);
    if (Math.abs(ga - kb[0]) <= 10 * tol && Math.abs(gb - ka[0]) <= 10 * tol) keys.push(key);
  }
  return keys;
}
/** True when the polygon container k holds the points (flat list), each grown by `padding`. */
function holds(k, pts, padding, tol) {
  const apothem = k.size / (2 * Math.tan(Math.PI / k.M));
  for (let j = 0; j < k.M; j++) {
    const ang = k.phi - Math.PI / 2 + (j * 2 * Math.PI) / k.M;
    for (let i = 0; i < pts.length; i += 2)
      if ((pts[i] - k.cx) * Math.cos(ang) + (pts[i + 1] - k.cy) * Math.sin(ang) + padding > apothem + tol) return false;
  }
  return true;
}
/** True when two different polygon containers have the same size and both hold the points. */
function sameSizeBothHold(ka, kb, pts, padding, scale) {
  if (!ka || !kb || ka.M !== kb.M || ka.M < 3) return false;
  const tol = 1e-12 * Math.max(1, scale);
  if (compare(ka, kb, "auto", [], null, tol * 1e12) < 2) return false;
  if (Math.abs(ka.size - kb.size) > tol) return false;
  return holds(ka, pts, padding, 10 * tol) && holds(kb, pts, padding, 10 * tol);
}
/** The orientation tie of a points call: autoOrientSet returned another orientation of the same size. */
function orientationTie(c, a, b) {
  return c.fn === "points" && sameSizeBothHold(a.auto, b.auto, a.hull, c.pad, coordinateScale(c.pts));
}
/** The orientation tie of a board scored with autoOrient. */
function boardOrientationTie(c, a, b) {
  if (!a.auto || !b.auto || !c.body || !Array.isArray(c.body.pieces)) return false;
  const N = c.body.N;
  const pts = [];
  for (const p of c.body.pieces) {
    if (N === 0) pts.push(p.x, p.y);
    else for (const v of pieceVertices(N, { x: p.x, y: p.y, theta: p.theta ?? 0 }, 1)) pts.push(v[0], v[1]);
  }
  return sameSizeBothHold(a.auto.container, b.auto.container, pts, N === 0 ? 0.5 : 0, coordinateScale(c.body.pieces));
}
/** The thresholds of a pair call at which the two sides' separations stand, within 1e-12: `below` may differ there. */
function thresholdTies(c, a, b) {
  const at = [];
  if (c.fn !== "pair") return at;
  const tol = 1e-12 * Math.max(1, coordinateScale([c.a, c.b]));
  c.thresholds.forEach((t, i) => {
    const differs = a.below[i] !== b.below[i] || a.pieceBelow[i] !== b.pieceBelow[i];
    if (differs && Math.abs(a.pair - t) <= tol && Math.abs(b.pair - t) <= tol) at.push(i);
  });
  return at;
}

const scaled = [];
const ties = [];
const pad = (v, n) => String(v).padStart(n);
const us = (ns, n) => (n ? (ns / n / 1e3).toFixed(1) : "-");

// ------------------------------------------------------------------ cases
const cases = lines("cases.jsonl");
const ref = lines("ref.jsonl");
const rust = lines("rust.jsonl");
const tsTimes = JSON.parse(readFileSync(`${dir}/ts-times.json`, "utf8"));
const rsTimes = JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8"));
if (ref.length !== cases.length || rust.length !== cases.length) throw new Error("the three files of cases have different lengths");

const FIELDS = ["parse", "provenance", "server", "full", "tight", "strict", "lit", "auto"];
const CLASSES = ["identical", "close", "different", "tie"];
const newStat = () => ({
  n: 0, identical: 0, close: 0, tie: 0, different: 0, scaled: 0, parsed: 0, valid: 0, invalid: 0, verdict: 0,
  reasons: 0, reasonsSame: 0, reasonsClose: 0, reasonsTie: 0, reasonsDiff: 0, scoreSame: 0, scoreClose: 0, scoreDiff: 0, maxRel: 0,
  field: Object.fromEntries(FIELDS.map((f) => [f, [0, 0, 0]])),
  evalN: 0, evalTs: 0, evalRs: 0, strictN: 0, strictTs: 0, strictRs: 0, parseN: 0, parseTs: 0, parseRs: 0,
});
const byKind = new Map();
const byN = new Map();
const byM = new Map();
const total = newStat();
const examples = [];
let failures = 0;
const groupM = (M) => (M === null ? "(none)" : M === 0 ? "M=0 (circle)" : !Number.isInteger(M) || M < 3 || M > 100 ? "M not a shape" : M <= 6 ? `M=${M}` : M <= 12 ? "M=7-12" : M <= 30 ? "M=13-30" : "M=31-100");
const groupN = (N) => (N === null ? "(none)" : [0, 3, 4, 6, 37, 50, 67, 100].includes(N) ? `N=${N}` : !Number.isInteger(N) || N < 3 || N > 100 ? "N not a shape" : "N other");

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const a = ref[i];
  let b = rust[i];
  if (a.id !== c.id || b.id !== c.id) throw new Error("misaligned at line " + (i + 1));
  const groups = [total, [byKind, c.kind], [byN, groupN(c.N)], [byM, groupM(c.M)]].map((g) => {
    if (!Array.isArray(g)) return g;
    if (!g[0].has(g[1])) g[0].set(g[1], newStat());
    return g[0].get(g[1]);
  });
  // a refusal that names another pair of the same depth
  let tie = false;
  let serverTie = false;
  for (const f of ["server", "full"]) {
    const reasons = deepestTie(a[f], b[f]);
    if (!reasons) continue;
    ties.push(`  case ${c.id} (${c.kind}, N=${c.N} M=${c.M}) ${f}: ${JSON.stringify(a[f].reasons.at(-1))} against ${JSON.stringify(b[f].reasons.at(-1))}; equally deep: ${a[f].overlaps.deepest.map((p) => `${p[0]}-${p[1]} ${p[2]}`).join(", ")}`);
    b = { ...b, [f]: { ...b[f], reasons } };
    tie = true;
    if (f === "server") serverTie = true;
  }
  if (boardOrientationTie(c, a, b)) {
    ties.push(`  case ${c.id} (${c.kind}, N=${c.N} M=${c.M}) auto: phi ${a.auto.container.phi} against ${b.auto.container.phi}, size ${a.auto.container.size} against ${b.auto.container.size}`);
    b = { ...b, auto: a.auto };
    tie = true;
  }
  let where = [];
  let maxRel = { maxRel: 0 };
  let worst = 0;
  let fieldWorst = {};
  let usedScale = false;
  const fields = (scale) => {
    where = [];
    maxRel = { maxRel: 0 };
    worst = 0;
    fieldWorst = {};
    for (const f of FIELDS) {
      if (!(f in a) && !(f in b)) continue;
      fieldWorst[f] = !(f in a) || !(f in b) ? (where.push(`${f}: on one side only`), 2) : compare(a[f], b[f], f, where, maxRel, scale);
      worst = Math.max(worst, fieldWorst[f]);
    }
  };
  if (a.json_ok !== b.json_ok) {
    worst = 2;
    where.push(`json_ok: ${a.json_ok} against ${b.json_ok}`);
  } else {
    fields(1);
    const scale = worst === 2 && c.body && Array.isArray(c.body.pieces) ? coordinateScale(c.body.pieces) : 1;
    if (scale > 1) {
      const first = where[0];
      const raw = maxRel;
      fields(scale);
      maxRel = raw;
      if (worst < 2) {
        usedScale = true;
        scaled.push(`  case ${c.id} (${c.kind}, N=${c.N} M=${c.M}), coordinates up to ${scale}: ${first}`);
      }
    }
  }
  const evaluated = a.server && b.server;
  const reasonsClass = evaluated ? compare(a.server.reasons, b.server.reasons, "server.reasons", []) : null;
  const scoreClass = evaluated && a.server.score !== null && b.server.score !== null ? compare(a.server.score, b.server.score, "score", []) : null;
  const cls = worst === 2 ? "different" : tie ? "tie" : CLASSES[worst];
  for (const s of groups) {
    s.n++;
    s[cls]++;
    if (usedScale) s.scaled++;
    if (worst < 2 && !usedScale) s.maxRel = Math.max(s.maxRel, maxRel.maxRel);
    for (const f in fieldWorst) s.field[f][fieldWorst[f]]++;
    if (evaluated) {
      s.parsed++;
      if (a.server.valid !== b.server.valid) s.verdict++;
      if (a.server.valid) s.valid++;
      else s.invalid++;
      if (a.server.reasons.length) {
        s.reasons++;
        s[reasonsClass === 2 ? "reasonsDiff" : serverTie ? "reasonsTie" : ["reasonsSame", "reasonsClose"][reasonsClass]]++;
      }
      if (scoreClass !== null) s[["scoreSame", "scoreClose", "scoreDiff"][scoreClass]]++;
    }
    for (const [key, name] of [["parse", "parse"], ["evaluate", "eval"], ["strict", "strict"]]) {
      const t = tsTimes[key][i];
      const r = rsTimes[key][i];
      if (t !== null && r !== null) {
        s[name + "N"]++;
        s[name + "Ts"] += t;
        s[name + "Rs"] += r;
      }
    }
  }
  if (worst === 2) {
    if (c.kind !== "json-text") failures++;
    if (examples.length < maxExamples || c.kind === "json-text")
      examples.push(`  case ${c.id} (${c.kind}${c.N !== null ? `, N=${c.N} M=${c.M}` : ""}): ${where[0]}${c.text !== undefined ? `   text: ${c.text.slice(0, 70)}` : ""}`);
  }
}

const showCases = (title, map) => {
  console.log(`\n${title}`);
  console.log(`${"group".padEnd(17)}  cases  ident digits  scale    tie   DIFF | valid invalid verdict≠ | reasons  ident digits    tie   DIFF | score:ident digits   DIFF  maxRelDiff`);
  for (const [k, s] of [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true })))
    console.log(
      String(k).padEnd(17), pad(s.n, 6), pad(s.identical, 6), pad(s.close - s.scaled, 6), pad(s.scaled, 6), pad(s.tie, 6), pad(s.different, 6), "|", pad(s.valid, 5), pad(s.invalid, 7), pad(s.verdict, 8), "|",
      pad(s.reasons, 7), pad(s.reasonsSame, 6), pad(s.reasonsClose, 6), pad(s.reasonsTie, 6), pad(s.reasonsDiff, 6), "|", pad(s.scoreSame, 11), pad(s.scoreClose, 6), pad(s.scoreDiff, 6), pad(s.maxRel.toExponential(1), 11),
    );
};
const showTimes = (title, map) => {
  console.log(`\n${title} (mean of the best of five per case, in microseconds; preliminary: the machine is shared)`);
  console.log(`${"group".padEnd(17)}  cases | evaluate: TS    Rust  TS/Rust | strictVerify: n     TS    Rust  TS/Rust | parseConfig: TS   Rust  TS/Rust`);
  for (const [k, s] of [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true })))
    console.log(
      String(k).padEnd(17), pad(s.evalN, 6), "|", pad(us(s.evalTs, s.evalN), 12), pad(us(s.evalRs, s.evalN), 7), pad(s.evalRs ? (s.evalTs / s.evalRs).toFixed(2) : "-", 8), "|",
      pad(s.strictN, 15), pad(us(s.strictTs, s.strictN), 6), pad(us(s.strictRs, s.strictN), 7), pad(s.strictRs ? (s.strictTs / s.strictRs).toFixed(2) : "-", 8), "|",
      pad(us(s.parseTs, s.parseN), 14), pad(us(s.parseRs, s.parseN), 6), pad(s.parseRs ? (s.parseTs / s.parseRs).toFixed(2) : "-", 8),
    );
};
console.log(`CASES (bodies of POST /api/submit): ${total.n}`);
console.log("ident: every field the same bytes; digits: equal up to the last digits of numbers; scale: so at the scale of the coordinates;");
console.log("tie: a verified tie, otherwise equal; DIFF: anything else. maxRelDiff: the largest difference of a number, relative to its scale (ident, digits and tie).");
showCases("BY KIND", byKind);
showCases("BY PIECE SHAPE", byN);
showCases("BY CONTAINER SHAPE", byM);
showCases("ALL", new Map([["all", total]]));
console.log("\nBY FIELD (identical / last digits / DIFF; a tie counts as it compares once the tie is set aside)");
for (const f of FIELDS) console.log(`  ${f.padEnd(11)} ${total.field[f].map((v) => pad(v, 6)).join(" ")}`);
showTimes("TIMINGS BY KIND", byKind);
showTimes("TIMINGS BY PIECE SHAPE", byN);
showTimes("TIMINGS BY CONTAINER SHAPE", byM);
showTimes("TIMINGS, ALL", new Map([["all", total]]));

// ------------------------------------------------------------------ calls
const calls = lines("calls.jsonl");
const callsRef = lines("calls-ref.jsonl");
const callsRust = lines("calls-rust.jsonl");
if (callsRef.length !== calls.length || callsRust.length !== calls.length) throw new Error("the three files of calls have different lengths");
const byFn = new Map();
for (let i = 0; i < calls.length; i++) {
  const c = calls[i];
  const a = callsRef[i];
  let b = callsRust[i];
  if (a.id !== c.id || b.id !== c.id) throw new Error("misaligned call at line " + (i + 1));
  if (!byFn.has(c.fn)) byFn.set(c.fn, { n: 0, counts: [0, 0, 0], scaled: 0, tie: 0, maxRel: 0 });
  const s = byFn.get(c.fn);
  let tie = false;
  for (const key of normalTies(c, a, b)) {
    ties.push(`  call ${c.id} (pair, N=${c.N}) ${key}: normal (${a[key][1]}, ${a[key][2]}) against (${b[key][1]}, ${b[key][2]}), separation ${a[key][0]} against ${b[key][0]}`);
    b = { ...b, [key]: [b[key][0], a[key][1], a[key][2]] };
    tie = true;
  }
  const at = thresholdTies(c, a, b);
  if (at.length) {
    ties.push(`  call ${c.id} (pair, N=${c.N}) below: separation ${a.pair} against ${b.pair} at the threshold ${at.map((i) => c.thresholds[i]).join(", ")}`);
    const below = [...b.below];
    const pieceBelow = [...b.pieceBelow];
    for (const i of at) (below[i] = a.below[i]), (pieceBelow[i] = a.pieceBelow[i]);
    b = { ...b, below, pieceBelow };
    tie = true;
  }
  if (orientationTie(c, a, b)) {
    ties.push(`  call ${c.id} (points, M=${c.M}, ${c.pts.length / 2} points) auto: phi ${a.auto.phi} against ${b.auto.phi}, size ${a.auto.size} against ${b.auto.size}`);
    b = { ...b, auto: a.auto };
    tie = true;
  }
  let where = [];
  const stats = { maxRel: 0 };
  let worst = compare(a, b, c.fn, where, stats);
  const scale = worst === 2 ? coordinateScale([c.pts ?? 0, c.a ?? 0, c.b ?? 0, c.pose ?? 0]) : 1;
  let usedScale = false;
  if (scale > 1) {
    const first = where[0];
    where = [];
    worst = compare(a, b, c.fn, where, null, scale);
    if (worst < 2) {
      usedScale = true;
      scaled.push(`  call ${c.id}, coordinates up to ${scale}: ${first}`);
    }
  }
  s.n++;
  if (worst === 2) s.counts[2]++;
  else if (tie) s.tie++;
  else if (usedScale) s.scaled++;
  else s.counts[worst]++;
  if (worst < 2 && !usedScale) s.maxRel = Math.max(s.maxRel, stats.maxRel);
  if (worst === 2) {
    failures++;
    if (examples.length < 2 * maxExamples) examples.push(`  call ${c.id}: ${where[0]}`);
  }
}
console.log(`\nCALLS (single functions): ${calls.length}`);
console.log(`${"function".padEnd(14)}  calls  ident digits  scale    tie   DIFF  maxRelDiff`);
for (const [k, s] of byFn) console.log(k.padEnd(14), pad(s.n, 6), pad(s.counts[0], 6), pad(s.counts[1], 6), pad(s.scaled, 6), pad(s.tie, 6), pad(s.counts[2], 6), pad(s.maxRel.toExponential(1), 11));

console.log(`\nEQUAL AT THE SCALE OF THE COORDINATES ONLY ("scale"): ${scaled.length}`);
for (const e of scaled.slice(0, maxExamples)) console.log(e);
console.log(`\nVERIFIED TIES ("tie"): ${ties.length}`);
for (const e of ties.slice(0, maxExamples)) console.log(e.length > 420 ? e.slice(0, 420) + " ..." : e);
console.log(`\nDIFFERENCES: ${failures} outside the JSON layer${examples.length ? "; examples:" : ""}`);
for (const e of examples) console.log(e);
process.exit(failures ? 1 : 0);
