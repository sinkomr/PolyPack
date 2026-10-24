/**
 * One-piece replica constructions (fold track).
 *
 * For each solid and shape, take the best one-piece placement: the closed form where the one-piece
 * lower bound s = 2 sin(pi/M) r_in(N) is attained (disks, and polygons with N a multiple of M,
 * centred on a face with the face's corners at the midpoints of its sides), and the best P = 1
 * search result. A rotation or reflection of the solid maps a placement on one face to any face
 * (the symmetry group acts transitively on flags), so the variants are
 *   (face g, R(2 pi k / M) (x, y), theta + 2 pi k / M) for every face g and k = 0..M-1,
 *   and the same for the mirrored placement (-x, y, -theta).
 * Two variants are compatible when the two-piece packing is valid (their covered regions do not
 * overlap); any set of pairwise compatible variants is a packing, because fold validity is a
 * condition on single pieces plus pairs. A maximum clique of the compatibility graph (exact
 * Bron–Kerbosch search; at most 2 F M variants) gives packings of every P up to its size at the
 * one-piece value. The candidates are certified by python/surface/run_cert.py like all others.
 *
 * Usage: npx tsx packages/surface/scripts/build-replicas.ts <out.json> <search.jsonl> [more.jsonl ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inradius } from "@polypack/geometry";
import { SOLID_NAMES, SolidName, SurfacePose, getSolid, insideFaceDepth, validateFold } from "../src/index";

const [outPath, ...searchFiles] = process.argv.slice(2);
if (!outPath) throw new Error("usage: build-replicas.ts <out.json> <search.jsonl> ...");

const NS = [0, 3, 4, 5, 6, 8];
const bestP1 = new Map<string, { s: number; pose: SurfacePose; label: string }>();
for (const f of searchFiles)
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.P !== 1) continue;
    const key = `${r.solid}/${r.N}`;
    if (!bestP1.has(key) || r.s < bestP1.get(key)!.s) bestP1.set(key, { s: r.s, pose: r.pieces[0], label: `search P=1 (${r.label}, seed ${r.seed})` });
  }

/** Smallest float >= x. */
const up = (x: number) => {
  const b = new Float64Array([x]);
  const u = new BigInt64Array(b.buffer);
  u[0] += 1n;
  return b[0];
};

interface Base {
  s: number;
  pose: SurfacePose;
  label: string;
  closed?: string;
}

function variants(M: number, F: number, N: number, p: SurfacePose): SurfacePose[] {
  const out: SurfacePose[] = [];
  const sym = N === 0 ? Infinity : (2 * Math.PI) / N;
  const same = (a: SurfacePose, b: SurfacePose) => {
    if (a.face !== b.face || Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.y - b.y) > 1e-9) return false;
    if (N === 0) return true;
    const d = (((a.theta - b.theta) % sym) + sym) % sym;
    return d < 1e-9 || sym - d < 1e-9;
  };
  for (const mirror of [false, true]) {
    const x0 = mirror ? -p.x : p.x;
    const th0 = mirror ? -p.theta : p.theta;
    for (let g = 0; g < F; g++)
      for (let k = 0; k < M; k++) {
        const a = (2 * Math.PI * k) / M;
        const q = { face: g, x: Math.cos(a) * x0 - Math.sin(a) * p.y, y: Math.sin(a) * x0 + Math.cos(a) * p.y, theta: th0 + a };
        if (!out.some((r) => same(r, q))) out.push(q);
      }
  }
  return out;
}

/** Maximum clique (Bron–Kerbosch with pivoting), adjacency as boolean rows. */
function maxClique(adj: boolean[][]): number[] {
  let best: number[] = [];
  const n = adj.length;
  const rec = (R: number[], Pset: number[], X: number[]) => {
    if (!Pset.length && !X.length) {
      if (R.length > best.length) best = R.slice();
      return;
    }
    if (R.length + Pset.length <= best.length) return;
    let pivot = -1;
    let most = -1;
    for (const u of [...Pset, ...X]) {
      let c = 0;
      for (const v of Pset) if (adj[u][v]) c++;
      if (c > most) {
        most = c;
        pivot = u;
      }
    }
    for (const v of Pset.filter((v) => !adj[pivot][v])) {
      rec(
        [...R, v],
        Pset.filter((w) => adj[v][w]),
        X.filter((w) => adj[v][w]),
      );
      Pset = Pset.filter((w) => w !== v);
      X = [...X, v];
    }
  };
  rec([], [...Array(n).keys()], []);
  return best;
}

const out: any[] = [];
for (const solidName of SOLID_NAMES) {
  const S = getSolid(solidName);
  for (const N of NS) {
    const bases: Base[] = [];
    if (N === 0 || N % S.M === 0) {
      const r = N === 0 ? 1 : inradius(N);
      const sExact = 2 * Math.sin(Math.PI / S.M) * r;
      // edge 0's outward normal of the piece points at the face's frame vertex 0
      const theta = N === 0 ? 0 : -Math.PI + Math.PI / S.M - Math.PI / N;
      const closed = N === 0 ? `2 sin(pi/${S.M})` : `2 sin(pi/${S.M}) * r_in(${N})`;
      bases.push({ s: up(up(sExact)), pose: { face: 0, x: 0, y: 0, theta }, label: "closed-form one-piece placement", closed });
    }
    const p1 = bestP1.get(`${solidName}/${N}`);
    if (p1) bases.push({ s: p1.s, pose: p1.pose, label: p1.label });
    for (const base of bases) {
      const single = validateFold({ solid: solidName, N, s: base.s, pieces: [base.pose] }, { tol: 1e-10 });
      if (!single.ok) {
        console.log(solidName, N, base.label, "one-piece placement invalid:", single.errors[0]);
        continue;
      }
      const V = variants(S.M, S.F, N, base.pose).filter((q) => insideFaceDepth(S.M, base.s, q.x, q.y) >= -1e-12);
      const adj = V.map(() => V.map(() => false));
      for (let i = 0; i < V.length; i++)
        for (let j = i + 1; j < V.length; j++) {
          const v = validateFold({ solid: solidName, N, s: base.s, pieces: [V[i], V[j]] }, { tol: 1e-10 });
          adj[i][j] = adj[j][i] = v.ok;
        }
      const C = maxClique(adj);
      const pieces = C.map((i) => V[i]);
      const all = validateFold({ solid: solidName, N, s: base.s, pieces }, { tol: 1e-10 });
      console.log(solidName, N, base.label, "s =", base.s.toFixed(12), "variants", V.length, "max clique", C.length, all.ok ? "valid" : all.errors[0]);
      if (!all.ok) continue;
      for (let P = base.closed ? 1 : 2; P <= C.length; P++) {
        out.push({
          id: `surface/${solidName}/fold/${N}/${P}#replica${base.closed ? "-closed" : ""}`,
          solid: solidName,
          mode: "fold",
          N,
          P,
          s: base.s,
          pieces: pieces.slice(0, P),
          kind: "replica",
          provenance: {
            base: base.label,
            closed_form: base.closed ?? null,
            faces: pieces.slice(0, P).map((p) => p.face),
            clique_size: C.length,
            note: "copies of one one-piece placement on faces whose covered regions do not overlap (maximum clique of the compatibility graph)",
          },
        });
      }
    }
  }
}
writeFileSync(outPath, JSON.stringify({ generated: "2026-10-24", records: out }));
console.log("wrote", out.length, "replica candidates");
