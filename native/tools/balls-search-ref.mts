// The TypeScript's answers of the balls family's search, for native/balls (crate polypack-balls): the reference
// of tests/search.rs, which the Rust search must match bit for bit (native/PORTING.md).
//
//   node --import tsx native/tools/balls-search-ref.mts [OUTFILE]
//
// OUTFILE defaults to native/balls/tests/fixtures/search-ref.jsonl. The numbers of a search depend on the last bit
// of the sine and cosine of the machine's Node, so the fixture must be written by Node 24 on Linux x86-64, as
// native/tools/LINUX_REFERENCE.md says: bundle the tool and run it in the container with the repository writable,
//
//   export LINUXREF_DIR=<a scratch directory outside the repository>
//   native/tools/linuxref/bundle.sh balls-search-ref
//   LINUXREF_RW=1 native/tools/linuxref/linux.sh ballssearch balls-search-ref
//
// Every case runs on an evaluation budget alone (no clock decides), from a seed:
//  - kind "search": `searchBalls(problem, P, { seed, start, maxEvals })`; the result is its configuration, score,
//    start score, evaluations, hops and why it stopped;
//  - kind "job": `runSpaceJob` of packages/spaces (the shared part of the Auto search: the start read as the
//    server reads it, the candidates checked by the server's rule), with a time budget too long to matter; the
//    result is the job's configuration, score, evaluations and termination.
// Warm starts are made here: the result of a short search of another seed ("polished"), that result with the
// container 40 % too large ("loose"), and one with the pieces pulled together so that they overlap ("crushed").
// A start is written into the case, so the Rust test reads the same one.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBallsProblem, searchBalls, type BallsConfig } from "../../packages/balls/src/index.ts";
import { runSpaceJob, type SpaceJob } from "../../packages/spaces/src/search/run.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const out = process.argv[2] ?? resolve(root, "native/balls/tests/fixtures/search-ref.jsonl");

type Start = BallsConfig | null;
interface Case {
  name: string;
  kind: "search" | "job";
  id: string;
  seed: number;
  evals: number;
  start: Start;
}

const problemOf = (id: string) => {
  const [, code, P] = id.split("/");
  return { problem: getBallsProblem(code)!, P: Number(P) };
};

/** A configuration from a short fresh search. */
function made(id: string, seed: number, evals: number): BallsConfig {
  const { problem, P } = problemOf(id);
  const r = searchBalls(problem, P, { seed, maxEvals: evals });
  if (!r.config) throw new Error(`no configuration for ${id}`);
  return JSON.parse(JSON.stringify(r.config));
}

/** The configuration with the container 40 % too large. */
const loose = (c: BallsConfig): BallsConfig => ({ s: c.s * 1.4, pieces: c.pieces.map((p) => [...p]) });

/** The pieces pulled together by 25 % about the origin: they overlap. */
const crushed = (c: BallsConfig): BallsConfig => ({
  s: c.s,
  pieces: c.pieces.map((p) => [p[0] * 0.75, p[1] * 0.75, p[2] * 0.75, ...p.slice(3)]),
});

const cases: Case[] = [];
// every budget below is multiplied by EVALS_SCALE: long enough for many hops and restarts
const EVALS_SCALE = 3;
const add = (name: string, kind: Case["kind"], id: string, seed: number, evals: number, start: Start = null) =>
  cases.push({ name, kind, id, seed, evals: evals === 0 ? 0 : evals * EVALS_SCALE, start });

// fresh searches: balls in a ball, a cube, other solids; solids in a ball
add("ball-in-ball P1", "search", "balls/ballinball/1", 11, 600);
add("ball-in-ball P2", "search", "balls/ballinball/2", 12, 1500);
add("ball-in-ball P7", "search", "balls/ballinball/7", 13, 4000);
add("ball-in-ball P20", "search", "balls/ballinball/20", 14, 6000);
add("ball-in-ball P40", "search", "balls/ballinball/40", 15, 6000);
add("ball-in-ball P75", "search", "balls/ballinball/75", 16, 4000);
add("ball-in-cube P5", "search", "balls/ballincub/5", 21, 4000);
add("ball-in-cube P14", "search", "balls/ballincub/14", 22, 6000);
add("ball-in-tetrahedron P6", "search", "balls/ballintet/6", 31, 4000);
add("ball-in-pentakis-dodecahedron P9", "search", "balls/ballinpkd/9", 32, 5000);
add("ball-in-7-gonal-prism P12", "search", "balls/ballinpr7l3/12", 33, 5000);
add("ball-in-pentagonal-bipyramid P8", "search", "balls/ballinbp5/8", 34, 5000);
add("tetrahedron-in-ball P4", "search", "balls/tetinball/4", 41, 3000);
add("cube-in-ball P5", "search", "balls/cubinball/5", 42, 4000);
add("cube-in-ball P9", "search", "balls/cubinball/9", 43, 4000);
add("cube-in-ball P12", "search", "balls/cubinball/12", 44, 4000);
add("octahedron-in-ball P4", "search", "balls/octinball/4", 45, 3000);
add("dodecahedron-in-ball P3", "search", "balls/dodinball/3", 46, 3000);
add("icosahedron-in-ball P4", "search", "balls/icoinball/4", 47, 3000);
add("truncated-tetrahedron-in-ball P3", "search", "balls/tteinball/3", 48, 3000);
add("triangular-prism-in-ball P5", "search", "balls/pr3inball/5", 49, 3000);
add("icosahedron-in-ball P8", "search", "balls/icoinball/8", 50, 4000);

// warm starts: polished, loose and crushed
for (const [name, id, seed, evals] of [
  ["ball-in-ball P8", "balls/ballinball/8", 61, 3000],
  ["ball-in-cube P9", "balls/ballincub/9", 62, 3000],
  ["ball-in-octahedron P7", "balls/ballinoct/7", 63, 3000],
  ["cube-in-ball P6", "balls/cubinball/6", 64, 3000],
  ["tetrahedron-in-ball P5", "balls/tetinball/5", 65, 3000],
  ["dodecahedron-in-ball P4", "balls/dodinball/4", 66, 3000],
] as [string, string, number, number][]) {
  const base = made(id, seed + 100, 2500);
  add(`${name} warm polished`, "search", id, seed, evals, base);
  add(`${name} warm loose`, "search", id, seed + 1, evals, loose(base));
  add(`${name} warm crushed`, "search", id, seed + 2, evals, crushed(base));
}

// the Auto job (runSpaceJob), fresh and warm
add("job ball-in-ball P6", "job", "balls/ballinball/6", 71, 3000);
add("job ball-in-cube P8 warm", "job", "balls/ballincub/8", 72, 2500, made("balls/ballincub/8", 172, 2000));
add("job ball-in-tetrahedron P5", "job", "balls/ballintet/5", 73, 3000);
add("job cube-in-ball P4", "job", "balls/cubinball/4", 74, 3000);
add("job icosahedron-in-ball P3 warm", "job", "balls/icoinball/3", 75, 2500, made("balls/icoinball/3", 175, 2000));
add("job ball-in-ball P12 zero budget", "job", "balls/ballinball/12", 76, 0, made("balls/ballinball/12", 176, 2000));

const lines: string[] = [];
for (const c of cases) {
  const { problem, P } = problemOf(c.id);
  let result: Record<string, unknown>;
  if (c.kind === "search") {
    const r = searchBalls(problem, P, { seed: c.seed, maxEvals: c.evals, ...(c.start ? { start: c.start } : {}) });
    result = {
      config: r.config,
      score: r.config ? r.score : null,
      start_score: r.startScore,
      evaluations: r.evaluations,
      hops: r.hops,
      stopped: r.stopped,
    };
  } else {
    const job: SpaceJob = {
      space: "balls",
      id: c.id,
      seed: c.seed,
      budget: { time_s: 1e9, evals: c.evals },
      kind: c.start ? "warm" : "fresh",
      ...(c.start ? { start: c.start as unknown as SpaceJob["start"] } : {}),
    };
    const r = runSpaceJob(job, { aborted: false, paused: false });
    result = {
      config: r.config ?? null,
      score: r.score,
      evaluations: r.evaluations,
      termination: r.termination,
      valid: r.valid,
    };
  }
  lines.push(JSON.stringify({ ...c, result }));
  console.error(`${c.name}: ${c.kind} score ${result.score} evals ${result.evaluations}`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.error(`${lines.length} cases written to ${out}`);
