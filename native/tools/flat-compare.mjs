import { readFileSync } from "node:fs";
const dir = process.argv[2];
const lines = (f) => readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cases = lines("cases.jsonl"), ref = lines("ref.jsonl"), rs = lines("rust.jsonl");
const tt = JSON.parse(readFileSync(`${dir}/ts-times.json`, "utf8")), rt = JSON.parse(readFileSync(`${dir}/rust-times.json`, "utf8"));
const stat = () => ({ n: 0, parse: 0, verdict: 0, reasons: 0, scoreSame: 0, scoreDiff: 0, maxRel: 0, contDiff: 0, strictOk: 0, strictDiff: 0, certDiff: 0, ts: 0, rs: 0, valid: 0 });
const byKind = new Map(), byN = new Map(), byM = new Map(); const ex = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i], a = ref[i], b = rs[i]; if (a.id !== c.id || b.id !== c.id) throw new Error("misaligned");
  for (const [map, key] of [[byKind, c.kind], [byN, "N=" + c.N], [byM, c.M === 0 ? "M=0 (circle)" : c.M <= 6 ? "M=" + c.M : c.M <= 20 ? "M=7-20" : "M=21-100"]]) {
    const s = map.get(key) ?? stat(); map.set(key, s); s.n++;
    if (a.parse_ok !== b.parse_ok || (!a.parse_ok && JSON.stringify(a.errors) !== JSON.stringify(b.errors))) { s.parse++; if (map === byKind && ex.length < 12) ex.push(["parse", c.kind, c.N, c.M, c.P, JSON.stringify(a.errors), JSON.stringify(b.errors)]); }
    if (!a.parse_ok || !b.parse_ok) continue;
    s.ts += tt[i]; s.rs += rt[i];
    if (a.valid !== b.valid) { s.verdict++; if (map === byKind && ex.length < 12) ex.push(["verdict", c.kind, c.N, c.M, c.P, a.valid, b.valid, a.reasons[0], b.reasons[0]]); continue; }
    if (JSON.stringify(a.reasons) !== JSON.stringify(b.reasons)) { s.reasons++; if (map === byKind && ex.length < 12) ex.push(["reasons", c.kind, c.N, c.M, c.P, a.reasons[0], b.reasons[0]]); }
    if (!a.valid) continue; s.valid++;
    if (a.score === b.score) s.scoreSame++; else { s.scoreDiff++; s.maxRel = Math.max(s.maxRel, Math.abs(a.score - b.score) / a.score); }
    if (a.container.cx !== b.container.cx || a.container.cy !== b.container.cy || a.container.phi !== b.container.phi || a.container.M !== b.container.M) s.contDiff++;
    if (a.strict.ok !== b.strict.ok || a.strict.reason !== b.strict.reason) { s.strictDiff++; if (map === byKind && ex.length < 12) ex.push(["strict", c.kind, c.N, c.M, c.P, JSON.stringify(a.strict), JSON.stringify(b.strict)]); } else s.strictOk++;
    if (a.strict.certified !== b.strict.certified) s.certDiff++;
  }
}
const show = (title, map) => { console.log(`\n${title}`); console.log("group".padEnd(18), "cases valid parse≠ verdict≠ reason≠ score= score≠ maxRelDiff centre≠ strict≠ cert≠  TS µs  Rust µs  speedup");
  for (const [k, s] of [...map].sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true })))
    console.log(String(k).padEnd(18), [s.n, s.valid, s.parse, s.verdict, s.reasons, s.scoreSame, s.scoreDiff].map((v) => String(v).padStart(6)).join(" "), s.maxRel.toExponential(1).padStart(9), String(s.contDiff).padStart(7), String(s.strictDiff).padStart(7), String(s.certDiff).padStart(5), (s.ts / s.n / 1e3).toFixed(1).padStart(7), (s.rs / s.n / 1e3).toFixed(1).padStart(8), (s.ts / s.rs).toFixed(2).padStart(8)); };
show("BY KIND", byKind); show("BY PIECE SHAPE", byN); show("BY CONTAINER SHAPE", byM);
console.log("\nexamples of differences:"); for (const e of ex) console.log(" ", e.join(" | "));
