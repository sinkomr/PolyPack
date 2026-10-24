/**
 * Contact-LP polish of finished search results: reads JSON lines (search.ts output), polishes
 * the best result per problem with slpPolish and appends the polished packings to <out.jsonl>.
 *
 * Usage: npx tsx packages/surface/scripts/polish.ts <out.jsonl> <in.jsonl> [more.jsonl ...]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SolidName, getSolid, validateFold } from "../src/index";
import { slpPolish } from "../src/search/slp";

const [out, ...inputs] = process.argv.slice(2);
const best = new Map<string, any>();
for (const f of inputs)
  for (const line of readFileSync(f, "utf8").split("\n"))
    if (line.trim()) {
      const r = JSON.parse(line);
      const k = `${r.solid}/${r.N}/${r.P}`;
      if (!best.has(k) || r.s < best.get(k).s) best.set(k, r);
    }
const done = new Set<string>();
if (existsSync(out)) for (const line of readFileSync(out, "utf8").split("\n")) if (line.trim()) { const r = JSON.parse(line); done.add(`${r.solid}/${r.N}/${r.P}`); }
for (const [k, r] of best) {
  if (done.has(k)) continue;
  const S = getSolid(r.solid as SolidName);
  const lam = 1 / r.s;
  const poses = r.pieces.map((p: any) => ({ face: p.face, x: p.x * lam, y: p.y * lam, theta: p.theta }));
  const t0 = Date.now();
  let res;
  try {
    res = slpPolish(S, r.N, lam, poses, { iterations: 150 });
  } catch (e) {
    console.log(k, "polish error", String(e).slice(0, 120));
    continue;
  }
  const s = 1 / res.lam;
  const pieces = res.poses.map((p) => ({ face: p.face, x: p.x * s, y: p.y * s, theta: p.theta }));
  const v = validateFold({ solid: r.solid, N: r.N, s, pieces }, { tol: 1e-10 });
  if (!v.ok || s > r.s) {
    console.log(k, "kept", r.s, v.ok ? "" : v.errors[0]);
    continue;
  }
  appendFileSync(out, JSON.stringify({ ...r, s, pieces, label: `${r.label}+slp`, polish_seconds: (Date.now() - t0) / 1000, s_before_polish: r.s }) + "\n");
  console.log(k, r.s.toFixed(10), "->", s.toFixed(10), ((Date.now() - t0) / 1000).toFixed(1) + "s");
}
