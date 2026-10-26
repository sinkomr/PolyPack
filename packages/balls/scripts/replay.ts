/**
 * Replays the chain of rounds of a sweep row and compares the result with the stored configuration:
 *   npx tsx scripts/replay.ts <file.jsonl> <P> [hops]
 * Each round's hops are its own `hops` field, or "plain" (the first sweep's) when it has none. Rows whose chain has a
 * "subset" round need the P + 1 row's result; this replays only chains of "fresh" and "previous" rounds.
 */
import { readFileSync } from "node:fs";
import { type BallsConfig, getBallsProblem, searchBalls } from "../src";

const [file, Ps] = process.argv.slice(2);
const P = Number(Ps);
const rows = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((r) => r.P === P);
const row = rows.reduce((a, b) => (b.score < a.score ? b : a));
const problem = getBallsProblem(row.code)!;
let c: BallsConfig | undefined;
for (const round of row.chain) {
  if (round.start === "subset") throw new Error("a subset round: replay the P + 1 row first");
  const r = searchBalls(problem, P, {
    seed: round.seed,
    maxEvals: round.evals,
    ...(round.start === "previous" ? { start: c, startPolished: true } : {}),
    hops: round.hops ?? "plain",
  });
  c = r.config!;
}
const same = JSON.stringify(c) === JSON.stringify(row.config);
console.log(`${row.code} P=${P}: ${row.chain.length} rounds replayed, ${same ? "identical" : "DIFFERENT"} (${c!.s} vs ${row.score})`);
process.exit(same ? 0 : 1);
