/**
 * The compute sweep behind the research records: for each problem and P, rounds of searchBalls, each with its own
 * seed and evaluation budget (so each round is reproducible from its start, seed and budget), the first from a
 * new start and the later ones from the best so far (startPolished) or, one in four, from a new start again, until
 * the problem's time is used. Every improvement is appended to <out>/<code>.jsonl with the chain of rounds that led
 * to it, so that a sweep that is stopped keeps what it found and a new sweep resumes from it.
 *
 *   npx tsx scripts/sweep.ts --codes ballinball,ballincub --P 2-100 --out <dir> [--evals 100000] [--seconds 30,45,70]
 *     [--seed 20261025]
 *
 * --seconds a,b,c: time of a problem for P <= 30, P <= 60 and above (the rounds' sizes do not depend on it).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BallsConfig, getBallsProblem, searchBalls, validateBalls } from "../src";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const codes = (args.get("codes") ?? "ballinball").split(",");
const [p0, p1] = (args.get("P") ?? "2-100").split("-").map(Number);
const out = args.get("out")!;
const evals = Number(args.get("evals") ?? 100000);
const seconds = (args.get("seconds") ?? "30,45,70").split(",").map(Number);
const base = Number(args.get("seed") ?? 20261025);
mkdirSync(out, { recursive: true });

/** mixSeed of packages/spaces (MurmurHash3's finaliser over a golden-ratio step). */
function mix(a: number, b: number): number {
  let h = ((a >>> 0) ^ Math.imul((b >>> 0) + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * One round of a chain: the first starts fresh, each later one from the result of the round before it
 * (startPolished), so replaying the chain in order reproduces the configuration.
 */
interface Round {
  seed: number;
  evals: number;
  start: "fresh" | "previous";
  /** The balls' hops of searchBalls; absent in the first sweep's rounds, which used "plain". */
  hops?: "holes";
}
interface Row {
  code: string;
  P: number;
  score: number;
  config: BallsConfig;
  chain: Round[];
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

for (let P = p0; P <= p1; P++)
  for (const code of codes) {
    const problem = getBallsProblem(code)!;
    const prior = readBest(code).get(P);
    const limit = P <= 30 ? seconds[0] : P <= 60 ? seconds[1] : seconds[2];
    const t0 = performance.now();
    let best: { score: number; config: BallsConfig; chain: Round[] } | null = prior
      ? { score: prior.score, config: prior.config, chain: prior.chain }
      : null;
    const startScore = best?.score ?? Infinity;
    let k = 0;
    while ((performance.now() - t0) / 1000 < limit) {
      const seed = mix(base, mix(P * 131 + codes.indexOf(code), k));
      const fresh = !best || (k > 0 && mix(seed, 7) % 4 === 0);
      const r = searchBalls(problem, P, {
        seed,
        maxEvals: evals,
        ...(fresh ? {} : { start: best!.config, startPolished: true }),
        hops: "holes",
      });
      const round: Round = { seed, evals, start: fresh ? "fresh" : "previous", hops: "holes" };
      const chain = fresh ? [round] : [...best!.chain, round];
      if (r.config && validateBalls(problem, r.config, { tol: 0 }).valid && (!best || r.score < best.score * (1 - 1e-13))) {
        best = { score: r.score, config: r.config, chain };
        const row: Row = { code, P, score: r.score, config: r.config, chain, at: new Date().toISOString() };
        appendFileSync(join(out, `${code}.jsonl`), JSON.stringify(row) + "\n");
      }
      k++;
    }
    console.log(
      `${code} P=${P} rounds=${k} best=${best?.score} (was ${startScore}) ${((performance.now() - t0) / 1000).toFixed(0)} s`,
    );
  }
