/**
 * Replays the chain of rounds of a record or a sweep row and compares the result with its stored configuration:
 *   npx tsx scripts/replay.ts <file.jsonl> <P>
 *   npx tsx scripts/replay.ts --record <balls id>        (from data/balls/records.json)
 * Each round is a run of searchBalls with its seed and evaluation budget, started from
 *  - "fresh": nothing;
 *  - "previous": the previous round's result, taken as it is (startPolished);
 *  - "subset": the previous round's result (a packing of one more piece) with piece `remove` taken out, polished;
 *  - "grow": the previous round's result (one piece fewer) with the piece `add` put in, polished;
 *  - "cones": the construction of scripts/construct.ts with `faces` tetrahedra, polished.
 * A round's hops are its `hops` field, or "plain" (the first sweep's) without one. The piece count of each round
 * follows from the chain read backwards: before a "subset" round there was one piece more, before a "grow" one less.
 */
import { readFileSync } from "node:fs";
import { type BallsConfig, getBallsProblem, searchBalls } from "../src";
import { conePoses } from "./cones";

type Round = { seed: number; evals: number; start: string; hops?: "holes"; remove?: number; add?: number[]; faces?: number };

const argv = process.argv.slice(2);
let row: { code: string; P: number; config: BallsConfig; chain: Round[] };
if (argv[0] === "--record") {
  const id = argv[1];
  const root = new URL("../../../data/balls/", import.meta.url).pathname;
  const doc = JSON.parse(readFileSync(`${root}records.json`, "utf8"));
  const r = doc.records.find((x: { id: string }) => x.id === id);
  const file = readFileSync(`${root}configs/${r.code}.jsonl`);
  const config = JSON.parse(file.subarray(r.config_at[0], r.config_at[0] + r.config_at[1]).toString("utf8")).config;
  row = { code: r.code, P: r.P, config, chain: r.origin.chain };
} else {
  const P = Number(argv[1]);
  const rows = readFileSync(argv[0], "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => r.P === P);
  row = rows.reduce((a, b) => (b.score < a.score ? b : a));
}
const problem = getBallsProblem(row.code)!;
// the piece count of each round, from the end
const counts: number[] = [];
let n = row.P;
for (let k = row.chain.length - 1; k >= 0; k--) {
  counts[k] = n;
  if (row.chain[k].start === "subset") n += 1;
  else if (row.chain[k].start === "grow") n -= 1;
}
let c: BallsConfig | undefined;
row.chain.forEach((round, k) => {
  const P = counts[k];
  const hops = round.hops ?? "plain";
  let start: BallsConfig | undefined;
  let startPolished = false;
  if (round.start === "previous") {
    start = c;
    startPolished = true;
  } else if (round.start === "subset") start = { s: c!.s, pieces: c!.pieces.filter((_, i) => i !== round.remove) };
  else if (round.start === "grow") start = { s: c!.s, pieces: [...c!.pieces, round.add!] };
  else if (round.start === "cones") start = { s: 1, pieces: conePoses(round.faces!) };
  const r = searchBalls(problem, P, { seed: round.seed, maxEvals: round.evals, hops, ...(start ? { start, startPolished } : {}) });
  c = r.config!;
});
const same = JSON.stringify(c) === JSON.stringify(row.config);
console.log(`${row.code} P=${row.P}: ${row.chain.length} rounds replayed, ${same ? "identical" : "DIFFERENT"} (${c!.s} vs ${row.config.s})`);
process.exit(same ? 0 : 1);
