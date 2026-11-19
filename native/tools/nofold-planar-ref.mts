// The TypeScript side of the tests of native/surface/src/nofold_planar.rs: the conversion between a
// nofold surface problem on a Platonic solid and the planar problem of its fullest face
// (packages/spaces/src/search/nofold.ts), and a few searches run as apps/web/src/space/nofold-round.ts
// runs them (basin hopping on the face, budgeted by evaluations, the result copied onto every face).
//
//   node --import tsx native/tools/nofold-planar-ref.mts native/surface/tests/fixtures
//
// writes nofold_planar_convert.jsonl and nofold_planar_search.jsonl there. Numbers are the shortest
// text of each double (JSON.stringify), which serde_json reads back bit for bit.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "../../packages/solver/src/index.ts";
import { faceProblem, piecesPerFace, surfaceFromFace, type NofoldProblem } from "../../packages/spaces/src/search/nofold.ts";
import { checkSpaceConfig, parseSearchProblem } from "../../packages/spaces/src/search/model.ts";
import { NOFOLD_AUTO } from "../../packages/spaces/src/search/methods.ts";

const dir = resolve(process.argv[2] ?? "native/surface/tests/fixtures");
const problem = (id: string) => parseSearchProblem(id) as NofoldProblem;

/** The job of nofold-round.ts: basin hopping on the face, from the start's fullest face. */
async function search(id: string, seed: number, evals: number, start?: any) {
  const p = problem(id);
  const face = faceProblem(p, start);
  const r = await run(face.problem, {
    method: NOFOLD_AUTO,
    budget: { evals, time_s: 1e9 },
    seed,
    ...(face.known ? { start: face.known.config } : {}),
  });
  const config = r.valid && r.strict && r.best ? surfaceFromFace(p, r.best) : null;
  const check = config ? checkSpaceConfig("surface", id, config) : null;
  return { face, r, config, check };
}

const convert: any[] = [];
const searches: any[] = [];

const ids = [
  "surface/cube/nofold/4/9",
  "surface/cube/nofold/0/7",
  "surface/tetrahedron/nofold/0/9",
  "surface/tetrahedron/nofold/3/5",
  "surface/octahedron/nofold/4/20",
  "surface/dodecahedron/nofold/5/14",
  "surface/dodecahedron/nofold/0/30",
  "surface/icosahedron/nofold/3/45",
  "surface/icosahedron/nofold/6/21",
  "surface/cube/nofold/7/13",
];

for (const id of ids) {
  const p = problem(id);
  // a fresh face problem
  const fresh = faceProblem(p);
  convert.push({ kind: "face", id, start: null, k: piecesPerFace(p), problem: fresh.problem, areaBound: fresh.areaBound, known: null });
  // a short search, whose face is converted to a surface configuration and back
  const s = await search(id, 7, 400);
  if (s.r.best && s.config) {
    convert.push({
      kind: "surface",
      id,
      face: { N: s.r.best.N, M: s.r.best.M, P: s.r.best.P, container_phi: s.r.best.container_phi, pieces: s.r.best.pieces },
      config: s.config,
    });
    const back = faceProblem(p, s.config as any);
    convert.push({
      kind: "face",
      id,
      start: s.config,
      k: piecesPerFace(p, s.config as any),
      problem: back.problem,
      areaBound: back.areaBound,
      known: back.known ? { pieces: back.known.config.pieces, score: back.known.score } : null,
    });
    // the start with the pieces of one face dropped onto others: the fullest face changes or is not full
    const moved = { s: (s.config as any).s, pieces: (s.config as any).pieces.map((q: any, i: number) => ({ ...q, face: i % 2 })) };
    const m = faceProblem(p, moved as any);
    convert.push({
      kind: "face",
      id,
      start: moved,
      k: piecesPerFace(p, moved as any),
      problem: m.problem,
      areaBound: m.areaBound,
      known: m.known ? { pieces: m.known.config.pieces, score: m.known.score } : null,
    });
  }
}

// a face packing with a rotated container, and one for a wrong shape (surfaceFromFace answers null)
{
  const id = "surface/cube/nofold/4/9";
  const p = problem(id);
  const s = await search(id, 3, 300);
  const face = s.r.best!;
  const turned = { ...face, container_phi: 0.3 };
  const c = surfaceFromFace(p, turned);
  convert.push({
    kind: "surface",
    id,
    face: { N: turned.N, M: turned.M, P: turned.P, container_phi: turned.container_phi, pieces: turned.pieces },
    config: c,
  });
  const wrongM = { ...face, M: 3 };
  convert.push({
    kind: "surface",
    id,
    face: { N: wrongM.N, M: wrongM.M, P: wrongM.P, container_phi: wrongM.container_phi, pieces: wrongM.pieces },
    config: surfaceFromFace(p, wrongM),
  });
  // too few faces for P: a face of one piece on a cube with P = 9
  const one = { ...face, P: 1, pieces: face.pieces.slice(0, 1) };
  convert.push({
    kind: "surface",
    id,
    face: { N: one.N, M: one.M, P: one.P, container_phi: one.container_phi, pieces: one.pieces },
    config: surfaceFromFace(p, one),
  });
}

// evaluation-budgeted searches, fresh and warm
const jobs: [string, number, number, boolean][] = [
  ["surface/cube/nofold/4/9", 1, 600, false],
  ["surface/cube/nofold/4/9", 2, 600, true],
  ["surface/tetrahedron/nofold/0/9", 1, 500, false],
  ["surface/dodecahedron/nofold/5/14", 1, 500, false],
  ["surface/octahedron/nofold/4/20", 5, 500, false],
  ["surface/icosahedron/nofold/3/45", 1, 400, true],
  ["surface/cube/nofold/0/7", 11, 800, false],
];
for (const [id, seed, evals, warm] of jobs) {
  let start: any;
  if (warm) {
    const s0 = await search(id, 100 + seed, 300);
    start = s0.config ?? undefined;
  }
  const s = await search(id, seed, evals, start);
  searches.push({
    id,
    seed,
    evals,
    start: start ?? null,
    evaluations: s.r.evaluations,
    termination: s.r.termination,
    faceScore: s.r.score,
    strict: s.r.strict,
    valid: s.r.valid,
    config: s.config,
    score: s.check?.valid ? s.check.score : null,
  });
  console.error(id, seed, evals, warm, s.r.evaluations, s.r.termination, s.r.score, s.check?.score);
}

const lines = (rows: any[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(`${dir}/nofold_planar_convert.jsonl`, lines(convert));
writeFileSync(`${dir}/nofold_planar_search.jsonl`, lines(searches));
console.error(`${convert.length} conversion cases, ${searches.length} searches`);
