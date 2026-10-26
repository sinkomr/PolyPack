/**
 * What the records' clearance costs: each record's centres scaled about the origin until the nearest pair touches
 * (balls: by 2 / d_min; solids: by bisection on the validator's measured separation), the turns kept, and the
 * container fitted tight around them (tightSize; a cube's balls centred first); then 1 - s0 / s, s the record's size.
 *   npx tsx scripts/clearance-cost.ts [data/balls]
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BallsConfig, getBallsProblem, legalizeBalls, tightSize, validateBalls } from "../src";

const dir = resolve(process.argv[2] ?? new URL("../../../data/balls", import.meta.url).pathname);
const doc = JSON.parse(readFileSync(join(dir, "records.json"), "utf8")) as {
  records: { id: string; code: string; config_at: [number, number] }[];
};
const files = new Map<string, Buffer>();
const costs: { id: string; cost: number }[] = [];
for (const r of doc.records) {
  if (!files.has(r.code)) files.set(r.code, readFileSync(join(dir, "configs", `${r.code}.jsonl`)));
  const [o, n] = r.config_at;
  const c = JSON.parse(files.get(r.code)!.subarray(o, o + n).toString("utf8")).config as BallsConfig;
  const problem = getBallsProblem(r.code)!;
  const scaled = (k: number) => c.pieces.map((p) => [p[0] * k, p[1] * k, p[2] * k, ...p.slice(3)]);
  const sep = (k: number) => validateBalls(problem, { s: 1e5, pieces: scaled(k) }, { tol: 1 }).minPairSep;
  let lo = 1 - 1e-6;
  let hi = 1;
  for (let t = 0; t < 60; t++) {
    const mid = (lo + hi) / 2;
    if (sep(mid) >= 0) hi = mid;
    else lo = mid;
  }
  const s0 =
    problem.piece === "ball"
      ? legalizeBalls(problem, scaled(hi) as [number, number, number][], 0, 0).s
      : tightSize(problem, scaled(hi));
  costs.push({ id: r.id, cost: 1 - s0 / c.s });
}
costs.sort((a, b) => a.cost - b.cost);
const q = (f: number) => costs[Math.min(costs.length - 1, Math.floor(f * costs.length))];
console.log(
  `${costs.length} records: clearance cost 1 - s0 / s from ${costs[0].cost.toExponential(2)} to ${costs[costs.length - 1].cost.toExponential(2)} (${costs[costs.length - 1].id}), median ${q(0.5).cost.toExponential(2)}`,
);
for (const code of new Set(doc.records.map((r) => r.code))) {
  const mine = costs.filter((c) => c.id.split("/")[1] === code);
  console.log(`  ${code}: at most ${Math.max(...mine.map((c) => c.cost)).toExponential(2)}`);
}
