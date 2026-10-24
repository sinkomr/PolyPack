/**
 * Fold search driver. Appends one JSON line per finished problem to <out.jsonl> and skips
 * problems already there (checkpointing), so it can be stopped and restarted.
 *
 * Usage:
 *   npx tsx packages/surface/scripts/search.ts --out OUT.jsonl --solids cube,tetrahedron --N 0,3,4,6
 *     --P 1-24 [--seed 1] [--starts 4] [--hops 12] [--warm warm.json] [--seconds 120] [--order asc|desc]
 * warm.json: {"records": [{solid, N, P, s, pieces, id}]} (nofold or exact configurations, or
 * earlier fold results); every one with the same (solid, N, P) is used as a warm start, and the
 * best fold result of P+1 (minus one piece) and of P-1 (plus one piece) when present in OUT.jsonl.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SolidName, SurfacePose, getSolid } from "../src/index";
import { Start, mulberry32, randomPose, searchProblem } from "../src/search/search";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const out = args.get("out")!;
const solids = (args.get("solids") ?? "cube").split(",") as SolidName[];
const Ns = (args.get("N") ?? "0").split(",").map(Number);
const [p0, p1] = (args.get("P") ?? "1-24").split("-").map(Number);
const seed = Number(args.get("seed") ?? 1);
const starts = Number(args.get("starts") ?? 4);
const hops = Number(args.get("hops") ?? 12);
const seconds = Number(args.get("seconds") ?? 120);
const order = args.get("order") ?? "asc";
// more random starts for small P, where one compression is cheap: starts * ceil(smallScale / P)
const smallScale = Number(args.get("small-scale") ?? 1);
const warmFile = args.get("warm");

const warmRecs: any[] = warmFile ? JSON.parse(readFileSync(warmFile, "utf8")).records : [];
const done = new Map<string, any>();
if (existsSync(out))
  for (const line of readFileSync(out, "utf8").split("\n"))
    if (line.trim()) {
      const r = JSON.parse(line);
      const key = `${r.solid}/${r.N}/${r.P}`;
      if (!done.has(key) || r.s < done.get(key).s) done.set(key, r);
    }

const toStart = (label: string, rec: { s: number; pieces: SurfacePose[] }): Start => ({
  label,
  lam: 1 / rec.s,
  poses: rec.pieces.map((p) => ({ face: p.face, x: p.x / rec.s, y: p.y / rec.s, theta: p.theta })),
});

const Ps: number[] = [];
for (let P = p0; P <= p1; P++) Ps.push(P);
if (order === "desc") Ps.reverse();

for (const solidName of solids) {
  const S = getSolid(solidName);
  for (const N of Ns)
    for (const P of Ps) {
      const key = `${solidName}/${N}/${P}`;
      if (done.has(key) && done.get(key).seed === seed) continue;
      const warm: Start[] = [];
      for (const r of warmRecs) if (r.solid === solidName && r.N === N && r.P === P) warm.push(toStart(r.id ?? "warm", r));
      const rand = mulberry32(seed * 7919 + P);
      const up = done.get(`${solidName}/${N}/${P + 1}`);
      if (up) {
        // record + 1, minus one piece (two choices)
        for (let t = 0; t < 2; t++) {
          const st = toStart(`from P+1 (${up.s.toFixed(6)})`, up);
          st.poses.splice(Math.floor(rand() * st.poses.length), 1);
          warm.push(st);
        }
      }
      const down = done.get(`${solidName}/${N}/${P - 1}`);
      if (down) {
        const st = toStart(`from P-1 (${down.s.toFixed(6)})`, down);
        st.lam *= 0.95;
        st.poses.push(randomPose(S, rand));
        warm.push(st);
      }
      const t0 = Date.now();
      let res: ReturnType<typeof searchProblem> = null;
      try {
        res = searchProblem(S, N, P, {
          seed: seed * 1000003 + P * 101 + N,
          randomStarts: starts * Math.max(1, Math.ceil(smallScale / P)),
          hops,
          warm,
          deadline: t0 + seconds * 1000,
        });
      } catch (e) {
        console.log(key, "search error:", String(e).slice(0, 200));
      }
      const secs = (Date.now() - t0) / 1000;
      if (!res) {
        console.log(key, "no result", secs.toFixed(1));
        continue;
      }
      const s = 1 / res.lam;
      const rec = {
        solid: solidName,
        N,
        P,
        s,
        pieces: res.poses.map((p) => ({ face: p.face, x: p.x * s, y: p.y * s, theta: p.theta })),
        label: res.label,
        seed,
        starts: starts * Math.max(1, Math.ceil(smallScale / P)),
        hops,
        seconds_budget: seconds,
        seconds: secs,
        warm: warm.map((w) => w.label),
      };
      appendFileSync(out, JSON.stringify(rec) + "\n");
      if (!done.has(key) || s < done.get(key).s) done.set(key, rec);
      console.log(key, s.toFixed(9), res.label, secs.toFixed(1) + "s");
    }
}
