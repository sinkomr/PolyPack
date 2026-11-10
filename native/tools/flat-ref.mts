// Builds test cases from real leading packings (nightly snapshot) plus mutants, and writes the
// reference verdicts of main's TypeScript rule exactly as POST /api/submit applies it.
//   node --import tsx native/tools/flat-ref.mts OUTDIR STEP file.json.gz...   (then the serverdiff example, then flat-compare.mjs OUTDIR)
import { createReadStream, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { evaluate, parseConfig, strictVerify } from "../../packages/geometry/src/index.ts";
const [outDir, stepArg, ...files] = process.argv.slice(2);
const step = Number(stepArg);
let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
type P = { x: number; y: number; theta: number };
const cases: { id: number; kind: string; N: number; M: number; P: number; pieces: P[]; container_phi: number }[] = [];
let id = 0, real = 0;
for (const f of files) {
  let N = 0, M = 0, seen = 0;
  for await (const line of createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity })) {
    const mN = /^\{"format":\d+,"N":(\d+)/.exec(line); if (mN) N = +mN[1];
    const mM = /"M":(\d+),"records"/.exec(line); if (mM) M = +mM[1];
    if (!line.startsWith('{"P":')) continue;
    if (seen++ % step !== 0) continue;
    let text = line.trim().replace(/,$/, ""); let r: any = null;
    for (let k = 0; k < 4 && !r; k++) { try { r = JSON.parse(text); } catch { text = text.slice(0, -1); } }
    if (!r) throw new Error("unreadable record in " + f);
    const pieces: P[] = r.pieces.map((p: number[]) => ({ x: p[0], y: p[1], theta: p[2] ?? 0 }));
    const phi = r.container_phi ?? 0;
    const add = (kind: string, pc: P[], P = r.P, cphi = phi) => cases.push({ id: id++, kind, N, M, P, pieces: pc, container_phi: cphi });
    add("real", pieces);
    const k = real++ % 5;
    if (k === 0 && pieces.length >= 2) add("overlap", pieces.map((p, i) => (i === 1 ? { x: pieces[0].x + 0.01, y: pieces[0].y, theta: p.theta } : p)));
    if (k === 1) { add("squeeze-1e-10", pieces.map((p) => ({ ...p, x: p.x * (1 - 1e-10), y: p.y * (1 - 1e-10) }))); add("squeeze-3e-9", pieces.map((p) => ({ ...p, x: p.x * (1 - 3e-9), y: p.y * (1 - 3e-9) }))); }
    if (k === 2) add("turned-container", pieces, r.P, rnd() * 6.283185307179586 - 3.1);
    if (k === 3) add("wrong-count", pieces, r.P + 1);
    if (k === 4) add("squeeze-1e-6", pieces.map((p) => ({ ...p, x: p.x * (1 - 1e-6), y: p.y * (1 - 1e-6) })));
  }
}
writeFileSync(`${outDir}/cases.jsonl`, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
const out: string[] = []; const parsed: (ReturnType<typeof parseConfig> & { ok: true })["config"][] = [];
for (const c of cases) {
  const p = parseConfig(JSON.parse(JSON.stringify(c)));
  if (!p.ok) { out.push(JSON.stringify({ id: c.id, parse_ok: false, errors: p.errors })); parsed.push(null as any); continue; }
  parsed.push(p.config);
  const e = evaluate(p.config, { maxOverlaps: 20, stopWhenInvalid: true });
  const k = e.valid ? e.container : null;
  const st = k ? strictVerify(p.config.N, p.config.pieces, k) : null;
  out.push(JSON.stringify({ id: c.id, parse_ok: true, valid: e.valid, reasons: e.reasons, score: k ? k.size : null,
    container: k ? { M: k.M, cx: k.cx, cy: k.cy, phi: k.phi, size: k.size } : null,
    strict: st ? { ok: st.ok, certified: st.certifiedSize, reason: st.reason ?? null } : null }));
}
writeFileSync(`${outDir}/ref.jsonl`, out.join("\n") + "\n");
// timing: evaluate as the server calls it, best of 5 passes per case
const best = new Float64Array(cases.length).fill(Infinity);
for (let pass = 0; pass < 5; pass++) for (let i = 0; i < cases.length; i++) { if (!parsed[i]) continue; const t = process.hrtime.bigint(); evaluate(parsed[i], { maxOverlaps: 20, stopWhenInvalid: true }); const d = Number(process.hrtime.bigint() - t); if (d < best[i]) best[i] = d; }
writeFileSync(`${outDir}/ts-times.json`, JSON.stringify(Array.from(best, (v) => (Number.isFinite(v) ? v : null))));
console.log(`${cases.length} cases (${real} real boards) written`);
