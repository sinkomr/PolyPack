/**
 * Constructed starts for tetrahedra in a ball, P <= 20: tetrahedra with a common vertex at the centre, one in the cone
 * over each face of a regular icosahedron centred there [CALC]. Seen from the centre, a face's vertices lie 37.38
 * degrees from its middle, and a regular tetrahedron's edges from its apex 35.26 degrees from its axis; so a
 * tetrahedron with its apex at the centre, its axis through the face's middle and its edges turned toward the face's
 * vertices lies inside that face's cone, and the cones of different faces do not overlap. Every vertex is then at
 * most 1 from the centre: P <= 20 tetrahedra fit in the unit ball (up to the clearance).
 *
 * Each construction (the first P faces in a fixed order) is a start of searchBalls (legalized and polished), and an
 * improvement is appended to <out>/tetinball.jsonl with the chain [{seed, evals, start: "cones", faces: P}].
 *   npx tsx scripts/construct.ts --out <dir> [--evals 30000] [--seed 5]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BallsConfig, getBallsProblem, searchBalls, validateBalls } from "../src";
import { conePoses } from "./cones";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const out = args.get("out")!;
const evals = Number(args.get("evals") ?? 30000);
const seed0 = Number(args.get("seed") ?? 5);
const problem = getBallsProblem("tetinball")!;
const file = join(out, "tetinball.jsonl");
const best = new Map<number, number>();
if (existsSync(file))
  for (const line of readFileSync(file, "utf8").split("\n"))
    if (line.trim()) {
      const r = JSON.parse(line);
      best.set(r.P, Math.min(best.get(r.P) ?? Infinity, r.score));
    }
for (let P = 2; P <= 20; P++) {
  const start: BallsConfig = { s: 1, pieces: conePoses(P) };
  // the construction itself, scaled a hair apart by the search's legalization, is the start
  const seed = seed0 * 1000 + P;
  const r = searchBalls(problem, P, { seed, maxEvals: evals, start, hops: "holes" });
  const was = best.get(P) ?? Infinity;
  if (r.config && validateBalls(problem, r.config, { tol: 0 }).valid && r.score < was * (1 - 1e-13)) {
    best.set(P, r.score);
    const chain = [{ seed, evals, start: "cones", faces: P, hops: "holes" }];
    appendFileSync(file, JSON.stringify({ code: "tetinball", P, score: r.score, config: r.config, chain, at: new Date().toISOString() }) + "\n");
  }
  console.log(`tetinball P=${P}: start ${r.startScore}, result ${r.score} (was ${was})`);
}
