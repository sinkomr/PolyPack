/**
 * Builds the nofold configurations from PolyPack's 2D packings.
 *
 * nofold(H, N, P) = min over k >= ceil(P / F) of s2D(N, M_face, k): place the best k-piece
 * packing of the face polygon on every face and keep P pieces (see docs/spaces/SURFACE).
 *
 * Sources of 2D packings, all re-scored here from their coordinates with @polypack/geometry:
 *  - data/records.json (PolyPack's literature table, with coordinates where it has them);
 *  - /api/atlas tiles of the live site (read-only GETs cached in <apiDir>), which hold the best
 *    drawable packing per P (site entries or literature coordinates).
 *
 * Usage: npx tsx packages/surface/scripts/build-nofold.ts <apiDir> <out.json>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Pose, TOL, autoOrient, enclose, findOverlaps } from "@polypack/geometry";
import { SOLID_NAMES, SurfaceConfig, areaBoundEdge, getSolid, validateNofold } from "../src/index";

const [apiDir, outPath] = process.argv.slice(2);
if (!apiDir || !outPath) throw new Error("usage: build-nofold.ts <apiDir> <out.json>");

const NS = [0, 3, 4, 5, 6, 8];
const KMAX = 8;
const repo = new URL("../../../", import.meta.url);
const records = JSON.parse(readFileSync(new URL("data/records.json", repo), "utf8")).records as any[];

interface Candidate {
  N: number;
  M: number;
  k: number;
  s: number;
  /** poses in the face frame (container at phi = 0 centred at the origin) */
  pieces: Pose[];
  source: Record<string, unknown>;
}

function toFace(N: number, M: number, poses: Pose[], phi0: number): { s: number; pieces: Pose[]; phi: number } {
  const a = enclose(N, poses, M, phi0);
  const b = autoOrient(N, poses, M, phi0);
  const c = b.size < a.size ? b : a;
  const co = Math.cos(-c.phi);
  const si = Math.sin(-c.phi);
  const pieces = poses.map((p) => {
    const dx = p.x - c.cx;
    const dy = p.y - c.cy;
    return { x: co * dx - si * dy, y: si * dx + co * dy, theta: p.theta - c.phi };
  });
  return { s: c.size, pieces, phi: c.phi };
}

const best = new Map<string, Candidate>();
const consider = (cand: Candidate) => {
  // 2D validity at PolyPack's tolerance; the surface certifier decides rigorously later
  if (findOverlaps(cand.N, cand.pieces, TOL).length) return;
  const key = `${cand.N}/${cand.M}/${cand.k}`;
  const old = best.get(key);
  if (!old || cand.s < old.s) best.set(key, cand);
};

for (const N of NS)
  for (const M of [3, 4, 5]) {
    for (const r of records) {
      if (r.N !== N || r.M !== M || r.P > KMAX || !r.pieces) continue;
      const f = toFace(N, M, r.pieces, r.container_phi ?? 0);
      consider({
        N,
        M,
        k: r.P,
        s: f.s,
        pieces: f.pieces,
        source: {
          kind: "literature",
          source_name: r.source_name,
          source_url: r.source_url,
          accessed: r.accessed,
          published_value: r.value,
          status_2d: r.status,
          coordinates_note: r.coordinates_note,
          via: "PolyPack data/records.json (generated 2026-10-20)",
        },
      });
    }
    const atlasFile = `${apiDir}/atlas_${N}_${M}.json`;
    if (existsSync(atlasFile)) {
      const atlas = JSON.parse(readFileSync(atlasFile, "utf8"));
      for (const t of atlas.tiles) {
        if (t.P > KMAX || !t.pieces) continue;
        const f = toFace(N, M, t.pieces, t.container_phi ?? 0);
        const lit = records.find((r) => r.N === N && r.M === M && r.P === t.P);
        consider({
          N,
          M,
          k: t.P,
          s: f.s,
          pieces: f.pieces,
          source:
            t.source === "site"
              ? {
                  kind: "polypack_site",
                  entry_id: t.id,
                  site_score: t.score,
                  verification: t.verification,
                  url: `https://polypack.fly.dev/api/atlas?N=${N}&M=${M}&from=1&to=8`,
                  accessed: "2026-10-24",
                  published_value: lit?.value ?? null,
                  published_source: lit ? `${lit.source_name}, ${lit.source_url}` : null,
                }
              : {
                  kind: "literature",
                  source_name: lit?.source_name,
                  source_url: lit?.source_url,
                  accessed: lit?.accessed,
                  published_value: t.score,
                  via: `PolyPack live site /api/atlas (read 2026-10-24)`,
                },
        });
      }
    }
  }

const out: any[] = [];
for (const name of SOLID_NAMES) {
  const S = getSolid(name);
  for (const N of NS) {
    for (let P = 1; P <= Math.max(4 * S.F, 24); P++) {
      const k0 = Math.ceil(P / S.F);
      let pick: Candidate | undefined;
      for (let k = k0; k <= KMAX; k++) {
        const c = best.get(`${N}/${S.M}/${k}`);
        if (c && (!pick || c.s < pick.s)) pick = c;
      }
      if (!pick) {
        console.log("no 2D packing for", name, N, P);
        continue;
      }
      // pieces in round-robin face order: each face gets ceil(P/F) or floor(P/F) pieces
      const pieces: { face: number; x: number; y: number; theta: number }[] = [];
      for (let idx = 0; idx < pick.k && pieces.length < P; idx++)
        for (let f = 0; f < S.F && pieces.length < P; f++) pieces.push({ face: f, ...pick.pieces[idx] });
      const cfg: SurfaceConfig = { solid: name, N, s: pick.s, pieces };
      const v = validateNofold(cfg);
      if (!v.ok) throw new Error(`${name} ${N} ${P}: ${v.errors.slice(0, 3).join("; ")}`);
      out.push({
        id: `surface/${name}/nofold/${N}/${P}`,
        solid: name,
        mode: "nofold",
        N,
        P,
        s: pick.s,
        pieces,
        k_per_face: pick.k,
        k_min: k0,
        face_packing: pick.source,
        area_bound: areaBoundEdge(name, N, P),
        float_check: { minPairSep: v.minPairSep, minWallSep: v.minWallSep },
      });
    }
  }
}
writeFileSync(outPath, JSON.stringify({ generated: "2026-10-24", records: out }));
console.log("wrote", out.length, "nofold configurations to", outPath);
for (const [key, c] of [...best.entries()].sort()) console.log(key, c.s.toFixed(9), c.source.kind);
