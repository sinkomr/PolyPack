/**
 * The second stage of the compute sweep: a packing of P + 1 pieces less one piece is a packing of P pieces, often a
 * good start. For P from the top down, the best of P + 1 (as the sweep files hold it, improvements of this run
 * included) is started from with one piece removed and polished (the pieces nearest the container's boundary first, then others
 * in a seeded order), each start a round of searchBalls (legalized, polished, hops). An improvement is appended to
 * <out>/<code>.jsonl with its chain: the chain of the P + 1 packing, then the round {seed, evals, start: "subset",
 * remove: i}.
 *
 * With --grow, the other way: for P from the bottom up, the best of P - 1 with one piece added just outside its
 * container, at a direction drawn by the seed (and, for a solid, a turn drawn by the seed), legalized and polished;
 * its round is {seed, evals, start: "grow", add: [x, y, z, ...]}.
 *
 *   npx tsx scripts/subsets.ts --codes ballinball --P 2-100 --out <dir> [--tries 4] [--evals 60000] [--seed 7] [--grow 1]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSolid } from "@polypack/polyhedra";
import { type BallsConfig, getBallsProblem, searchBalls, validateBalls } from "../src";
import { mulberry32, randomQuaternion } from "../src/random";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const codes = (args.get("codes") ?? "ballinball").split(",");
const [p0, p1] = (args.get("P") ?? "2-100").split("-").map(Number);
const out = args.get("out")!;
const tries = Number(args.get("tries") ?? 4);
const evals = Number(args.get("evals") ?? 60000);
const base = Number(args.get("seed") ?? 7);
const grow = args.get("grow") === "1";

function mix(a: number, b: number): number {
  let h = ((a >>> 0) ^ Math.imul((b >>> 0) + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

type Step = Record<string, unknown>;
interface Row {
  code: string;
  P: number;
  score: number;
  config: BallsConfig;
  chain: Step[];
  at: string;
}

function readBest(code: string): Map<number, Row> {
  const file = join(out, `${code}.jsonl`);
  const best = new Map<number, Row>();
  if (!existsSync(file)) return best;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Row;
    const b = best.get(r.P);
    if (!b || r.score < b.score) best.set(r.P, r);
  }
  return best;
}

for (const code of codes) {
  const problem = getBallsProblem(code)!;
  const best = readBest(code);
  // a piece's reach from the origin in the container's norm, to remove the outermost first
  const reach = (p: number[]) =>
    problem.piece !== "ball"
      ? Math.hypot(p[0], p[1], p[2]) + getSolid(problem.piece).circumradius
      : problem.container === "ball"
        ? Math.hypot(p[0], p[1], p[2])
        : Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  if (grow) {
    for (let P = p0 + 1; P <= p1; P++) {
      const down = best.get(P - 1);
      if (!down) continue;
      const t0 = performance.now();
      const was = best.get(P)?.score ?? Infinity;
      for (let t = 0; t < tries; t++) {
        const seed = mix(base, mix(P * 991 + codes.indexOf(code), t));
        const rng = mulberry32(seed);
        // a direction uniform on the sphere, and for a solid a uniform turn
        const u = 2 * rng() - 1;
        const ph = 2 * Math.PI * rng();
        const q = Math.sqrt(1 - u * u);
        const r = problem.piece === "ball" ? down.config.s : down.config.s + getSolid(problem.piece).circumradius;
        const add = [r * q * Math.cos(ph), r * q * Math.sin(ph), r * u, ...(problem.piece === "ball" ? [] : randomQuaternion(rng))];
        const start: BallsConfig = { s: down.config.s, pieces: [...down.config.pieces, add] };
        const res = searchBalls(problem, P, { seed, maxEvals: evals, start, hops: "holes" });
        const cur = best.get(P);
        if (res.config && validateBalls(problem, res.config, { tol: 0 }).valid && (!cur || res.score < cur.score * (1 - 1e-13))) {
          const chain: Step[] = [...down.chain, { seed, evals, start: "grow", add, hops: "holes" }];
          const row: Row = { code, P, score: res.score, config: res.config, chain, at: new Date().toISOString() };
          best.set(P, row);
          appendFileSync(join(out, `${code}.jsonl`), JSON.stringify(row) + "\n");
        }
      }
      const now = best.get(P)?.score ?? Infinity;
      console.log(`${code} P=${P} from ${P - 1}: ${now < was ? `improved ${was} -> ${now}` : `kept ${was}`} ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    }
    continue;
  }
  for (let P = p1 - 1; P >= p0; P--) {
    const up = best.get(P + 1);
    if (!up) continue;
    const t0 = performance.now();
    const order = up.config.pieces.map((p, i) => ({ i, r: reach(p) })).sort((a, b) => b.r - a.r);
    const was = best.get(P)?.score ?? Infinity;
    for (let t = 0; t < Math.min(tries, P + 1); t++) {
      // the two outermost pieces, then pieces drawn by the seed
      const remove = t < 2 ? order[t].i : mix(base, mix(P, t)) % (P + 1);
      const start: BallsConfig = { s: up.config.s, pieces: up.config.pieces.filter((_, i) => i !== remove) };
      const seed = mix(base, mix(P * 977 + codes.indexOf(code), t));
      const r = searchBalls(problem, P, { seed, maxEvals: evals, start, hops: "holes" });
      const cur = best.get(P);
      if (r.config && validateBalls(problem, r.config, { tol: 0 }).valid && (!cur || r.score < cur.score * (1 - 1e-13))) {
        // a round from the P + 1 packing less piece `remove`, polished first (not startPolished)
        const chain: Step[] = [...up.chain, { seed, evals, start: "subset", remove, hops: "holes" }];
        const row: Row = { code, P, score: r.score, config: r.config, chain, at: new Date().toISOString() };
        best.set(P, row);
        appendFileSync(join(out, `${code}.jsonl`), JSON.stringify(row) + "\n");
      }
    }
    const now = best.get(P)?.score ?? Infinity;
    console.log(
      `${code} P=${P} from ${P + 1}: ${now < was ? `improved ${was} -> ${now}` : `kept ${was}`} ${((performance.now() - t0) / 1000).toFixed(0)} s`,
    );
  }
}
