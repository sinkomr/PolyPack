/**
 * Runs the search on records of data/polyhedra/records.json and saves every result that beats the record's
 * certified s by more than 1e-5 relative (the margin of python/polyhedra/build_records.py), with the wiki's
 * clearance of 1e-7 between pieces and from the walls, for build_records.py --search to certify and include.
 *
 * Usage: npx tsx packages/polyhedra/scripts/improve.ts <out dir> <evals> [--fresh] [--shard k/m] [--ids-file f] [id ...]
 *   without ids: every record; --shard k/m takes every m-th record from the k-th (for parallel runs);
 *   --fresh also runs a search from scratch (seed 1) besides the warm start from the record (seed 1).
 * Each saved file: {id, code, P, s_full, pieces, method, start, seed, evals, record_s, date}.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getProblem, searchPolyhedra, validatePolyhedra } from "../src/index";

const args = process.argv.slice(2);
const out = args[0];
const evals = Number(args[1]);
const fresh = args.includes("--fresh");
const shardArg = args.indexOf("--shard");
const [k, m] = shardArg >= 0 ? args[shardArg + 1].split("/").map(Number) : [0, 1];
const rest = args.slice(2);
const idsFile = rest.indexOf("--ids-file");
const ids = [
  ...rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--shard" && rest[i - 1] !== "--ids-file"),
  ...(idsFile >= 0 ? readFileSync(rest[idsFile + 1], "utf8").split(/\s+/).filter(Boolean) : []),
];
mkdirSync(out, { recursive: true });
const doc = JSON.parse(readFileSync(new URL("../../../data/polyhedra/records.json", import.meta.url), "utf8"));
const records = (ids.length ? doc.records.filter((r: { id: string }) => ids.includes(r.id)) : doc.records).filter(
  (_: unknown, i: number) => i % m === k,
);
const MARGIN = 1e-5;
let found = 0;
const t0 = performance.now();
for (const [i, r] of records.entries()) {
  const p = getProblem(r.code)!;
  console.log(`[${i + 1}/${records.length}] ${r.id} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  for (const start of fresh ? (["warm", "fresh"] as const) : (["warm"] as const)) {
    const res = searchPolyhedra(p, r.P, {
      seed: 1,
      maxEvals: evals,
      clearance: 1e-7,
      start: start === "warm" ? r.config : undefined,
    });
    if (!res.config || !(res.score < r.score_cert * (1 - MARGIN))) continue;
    const v = validatePolyhedra(p, res.config, { tol: 0 });
    if (!v.valid || v.minPairSep < 0.99e-7 || v.minWallGap < 0.99e-7) continue;
    found++;
    const file = `${out}/${r.code}_n${String(r.P).padStart(2, "0")}_${start}.json`;
    writeFileSync(
      file,
      JSON.stringify({
        id: r.id,
        code: r.code,
        P: r.P,
        s_full: res.config.s,
        pieces: res.config.pieces,
        method: `PolyPack polyhedra search (packages/polyhedra/src/search.ts): ${start === "warm" ? "polish and hops from the wiki's record" : "soft-to-rigid run from random balls, polish and hops"}, seed 1, ${evals} evaluations, clearance 1e-7`,
        start,
        seed: 1,
        evals,
        record_s: r.score_cert,
        record_file: r.origin.file,
        date: new Date().toISOString().slice(0, 10),
      }),
    );
    console.log(`${r.id} ${start}: ${res.score} < ${r.score_cert} (${((1 - res.score / r.score_cert) * 100).toFixed(3)} %)`);
  }
}
console.log(`done: ${records.length} records, ${found} improvements, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
