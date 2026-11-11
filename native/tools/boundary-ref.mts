// Cases and reference verdicts for the comparison of the Rust port of the boundary family
// (native/boundary) with its TypeScript source (packages/boundary). See native/PORTING.md.
//
//   node --import tsx native/tools/boundary-ref.mts gen OUTDIR [snapshot.json.gz]   writes OUTDIR/cases.jsonl and extras.jsonl
//   node --import tsx native/tools/boundary-ref.mts run OUTDIR [k/n]                writes OUTDIR/ref.jsonl, ts-times.json, ref-extras.jsonl
//                                                                                (with k/n: shard k of n, files ref.k.jsonl, ts-times.k.json)
//   node --import tsx native/tools/boundary-ref.mts fixtures OUTDIR                 writes native/boundary/tests/fixtures/*.jsonl from OUTDIR
//   then: cargo run --release -p polypack-boundary --example boundarydiff -- OUTDIR/cases.jsonl OUTDIR/rust.jsonl OUTDIR/rust-times.json
//         cargo run --release -p polypack-boundary --example boundarydiff -- --extras OUTDIR/extras.jsonl OUTDIR/rust-extras.jsonl
//         node native/tools/boundary-compare.mjs OUTDIR
//
// A case is {id, group, kind, problem: {polytope, piece, P}, config, opts?, tol?, via?}: it is checked as the server checks it
// (packages/spaces/src/validate.ts, `check`): validateBoundary(problem, config, {tol, maxReasons: 20, maxChains: 1024}), with
// `opts` replacing or adding limits, at the tolerances 1e-9 and 1e-11 (or at the one tolerance `tol`); `via` calls the
// d-cube or the nD validator directly.
//
// Where the cases come from (the generation is deterministic: every random choice comes from seeded mulberry32 streams):
//  - real packings: the research records (data/boundary/records.json), the research prototype's and the search's outputs
//    (data/boundary/sources) and the site's leading entries (the nightly snapshot, when its path is given);
//  - the package's own structured starts for every container and piece (boundaryKernel(problem).seeds: the cell layouts, the
//    cells themselves, the ring cuts, the exact and the sequential layouts), each also shrunk, s and centres together, by
//    bisection to the smallest size the TypeScript validator accepts at 1e-9 ("tight": a contact at the tolerance);
//  - the mutants of PORTING.md of those: a piece moved into another, the size shrunk by 1e-10, 3e-9 and 1e-6 relative, a piece
//    outside its cell, a wrong count, a looser copy, a jittered and turned copy;
//  - constructions for what real packings do not show: centres on a ridge and pieces across a fold, the work limits, the
//    volume bound, the size range, every malformed field;
//  - a hunt: random configurations of one to three pieces of every container and piece, of which one is kept for each
//    sentence the validator gives there (and two valid ones), so that every reason is met on every kind of container;
//  - searches for the reasons that the server's tolerances all but exclude: the band of the ridge snap, the rounding
//    band of the nD hinge test, short geodesic loops at tolerances far above the server's.
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTAINERS,
  CONTAINER_MAX_P,
  CONTAINER_PIECES,
  MAX_S,
  PIECES,
  POLYTOPES,
  POLYTOPE_PIECES,
  ballBounds,
  boundaryCheckMs,
  boundaryDomain,
  boundaryIsHeavy,
  boundaryKernel,
  getND,
  getPolytope,
  highDimShape,
  isNCubeName,
  isNDName,
  ncubeBound,
  ncubeDim,
  ndBound,
  ndBoundKind,
  ndParse,
  parseBoundaryId,
  pieceBounds,
  pieceShape,
  validateBoundary,
  validateNCube,
  validateND,
} from "../../packages/boundary/src/index.ts";
import { MAX_P } from "../../packages/boundary/src/ids.ts";
import { boundaryBound } from "../../packages/boundary/src/kernel-validate.ts";
import { topo } from "../../packages/boundary/src/polytope.ts";
import { mulberry32 } from "../../packages/boundary/src/search/random.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const [mode, outDir, arg3] = process.argv.slice(2);
if (!mode || !outDir) throw new Error("usage: boundary-ref.mts gen|run|fixtures OUTDIR [...]");

type Problem = { polytope: string; piece: string; P: number };
type Piece = { cell: number; u: number[]; q?: number[] };
type Config = { s: number; pieces: Piece[] };
type Case = { id: number; group: string; kind: string; problem: Problem; config: unknown; opts?: Record<string, number>; tol?: number | string; via?: "ncube" | "nd" };

const SERVER = { maxReasons: 20, maxChains: 1024 };
const groupOf = (polytope: string) => (isNCubeName(polytope) ? "ncube" : isNDName(polytope) ? "nd" : "poly4");
const num = (x: unknown): number => (x === "NaN" ? NaN : x === "Infinity" ? Infinity : x === "-Infinity" ? -Infinity : (x as number));
const out = (x: number): number | string => (Number.isFinite(x) ? x : String(x));
/** A reason with its numbers replaced: the sentence it is an instance of. */
const template = (r: string) => r.replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/g, "#");

function check(problem: Problem, config: unknown, tol: number, opts: Record<string, number> = {}, stats?: { steps: number; ops?: number }, via?: "ncube" | "nd") {
  const o = { tol, ...SERVER, ...opts, ...(stats ? { stats } : {}) } as never;
  // `via`: the d-cube or the nD validator called directly, for the two refusals that validateBoundary never lets them give
  if (via === "ncube") return validateNCube(problem as never, config, o);
  if (via === "nd") return validateND(problem as never, config, o);
  return validateBoundary(problem as never, config, o);
}

// ------------------------------------------------------------------------------------------------------------ run

function runCase(c: Case, tol: number) {
  const nd = c.via ? c.via === "nd" : isNDName(c.problem.polytope);
  const stats = { steps: 0, ops: 0 };
  try {
    const v = check(c.problem, c.config, tol, c.opts, nd ? stats : undefined, c.via);
    const r: Record<string, unknown> = { tol: out(tol), ok: v.ok, score: v.score, reasons: v.reasons };
    if (nd) {
      r.steps = stats.steps ?? 0;
      r.ops = stats.ops ?? 0;
    }
    return r;
  } catch (e) {
    return { tol: out(tol), throw: `${(e as Error).name}: ${(e as Error).message}` };
  }
}
const tolsOf = (c: Case): number[] => (c.tol !== undefined ? [num(c.tol)] : [1e-9, 1e-11]);

// ------------------------------------------------------------------------------------------------------------ extras

function extra(q: Record<string, unknown>): unknown {
  const s = (k: string) => q[k] as string;
  const n = (k: string) => num(q[k]);
  switch (q.fn) {
    case "parseBoundaryId":
      return parseBoundaryId(s("arg"));
    case "bound":
      return boundaryDomain.bound({ fields: { polytope: s("polytope"), piece: s("piece") }, P: n("P") }) ?? null;
    case "checkMs":
      return { ms: boundaryCheckMs({ polytope: s("polytope"), piece: s("piece"), P: n("P") } as never), heavy: boundaryIsHeavy({ polytope: s("polytope"), piece: s("piece"), P: n("P") } as never) };
    case "highDimShape": {
      const h = highDimShape(s("name"));
      return h ? { cells: h.cells, dimU: h.dimU } : null;
    }
    case "cells":
      try {
        return getPolytope(s("name") as never).cells.length;
      } catch (e) {
        return { throw: (e as Error).message };
      }
    case "domainInfo":
      return JSON.stringify(boundaryDomain.info);
    case "sample":
      return boundaryDomain.sample(n("limit"));
    case "ballBounds":
      return ballBounds(s("polytope") as never, n("P"));
    case "pieceBounds":
      return pieceBounds(s("polytope") as never, s("piece") as never, n("P"));
    case "boundaryBound":
      return boundaryBound(s("piece") as never, n("P"));
    case "ncubeBound":
      return ncubeBound(n("d"), s("piece") as never, n("P"));
    case "ndBound": {
      const p = ndParse(s("polytope"))!;
      return { value: ndBound(p.family, p.d, n("P")), kind: ndBoundKind(p.family, p.d, n("P")) };
    }
    case "constants":
      return { MAX_S, MAX_P, CONTAINERS, PIECES, POLYTOPES, CONTAINER_PIECES: CONTAINERS.map((c) => CONTAINER_PIECES[c]), CONTAINER_MAX_P: CONTAINERS.map((c) => CONTAINER_MAX_P[c]) };
    case "polytope":
    case "polytopeBuilt": {
      const p = getPolytope(s("name") as never);
      const t = topo(p);
      return { name: p.name, d: p.d, vertices: p.vertices, cells: p.cells.map((c, i) => ({ index: c.index, normal: c.normal, origin: c.origin, frame: c.frame, vertices: c.vertices, hinges: c.hinges, facets: c.facets, vertexIds: c.vertexIds, hingeDihedral: t.cells[i].hingeDihedral })), hingeAngle: p.hingeAngle, edges: p.edges, edgeAngles: p.edgeAngles };
    }
    case "piece":
    case "pieceBuilt":
      return pieceShape(s("name") as never);
    default:
      return { throw: `unknown extra ${String(q.fn)}` };
  }
}

function genExtras(): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = [];
  const add = (q: Record<string, unknown>) => list.push({ id: list.length, ...q });
  add({ fn: "constants" });
  add({ fn: "domainInfo" });
  for (const limit of [0, 1, 7, 100, 5000, 1e9]) add({ fn: "sample", limit });
  for (const name of [...POLYTOPES, "5cube", "nope", ""]) add({ fn: "cells", name });
  for (const name of [...CONTAINERS, "4cube", "11cube", "11simplex", "4demicube", "cube", "tesseract ", "5Cube", ""]) add({ fn: "highDimShape", name });
  // the id parser: every container and piece once, then every way an id can be wrong
  for (const c of CONTAINERS) for (const p of PIECES) add({ fn: "parseBoundaryId", arg: `boundary/${c}/${p}/${1 + ((c.length * 7 + p.length) % 24)}` });
  for (const arg of [
    "boundary/tesseract/ball/9", "boundary/tesseract/ball/9999", "boundary/tesseract/ball/10000", "boundary/tesseract/ball/0", "boundary/tesseract/ball/01", "boundary/tesseract/ball/+1",
    "boundary/tesseract/ball/-1", "boundary/tesseract/ball/1.0", "boundary/tesseract/ball/1e3", "boundary/tesseract/ball/", "boundary/tesseract/ball/ 9", "boundary/tesseract/ball/9\n",
    "boundary/tesseract/ball", "boundary/tesseract/ball/9/1", "Boundary/tesseract/ball/9", "surface/tesseract/ball/9", "boundary//ball/9", "boundary/Tesseract/ball/9", "boundary/tesseract/Ball/9",
    "boundary/tesseract/sphere/9", "boundary/8cell/ball/9", "boundary/5cube/tetrahedron/3", "boundary/9simplex/cube/3", "boundary/10demicube/icosahedron/24", "boundary/tesseract/ball/١", "", "/", "///",
    "boundary/tesseract/ball/400", "boundary/7cube/cube/400", "boundary/11cube/ball/1", "boundary/4simplex/ball/1",
  ])
    add({ fn: "parseBoundaryId", arg });
  // the domain's bounds, the cost estimates and the two-bound tables, over the whole domain and a little beyond it
  for (const polytope of CONTAINERS)
    for (const piece of PIECES) {
      const maxP = CONTAINER_MAX_P[polytope];
      const Ps = maxP <= 24 ? Array.from({ length: maxP + 2 }, (_, i) => i) : [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 160, 161, 233, 377, 384, 385, 399, 400, 401];
      for (const P of Ps) {
        add({ fn: "bound", polytope, piece, P });
        if (CONTAINER_PIECES[polytope].includes(piece as never) && P >= 1) add({ fn: "checkMs", polytope, piece, P });
      }
    }
  for (const q of [{ polytope: "tesseract", piece: "ball", P: 2.5 }, { polytope: "tesseract", piece: "ball", P: "NaN" }, { polytope: "nope", piece: "ball", P: 1 }, { polytope: "tesseract", piece: "nope", P: 1 }, { polytope: "5cube", piece: "tetrahedron", P: 1 }])
    add({ fn: "bound", ...q });
  for (const polytope of POLYTOPES)
    for (let P = 1; P <= 64; P++) {
      add({ fn: "ballBounds", polytope, P });
      for (const piece of POLYTOPE_PIECES) add({ fn: "pieceBounds", polytope, piece, P });
    }
  for (const piece of ["ball", "cube"]) for (let P = 1; P <= 64; P++) add({ fn: "boundaryBound", piece, P });
  for (let d = 5; d <= 10; d++) for (const piece of ["ball", "cube"]) for (const P of [1, 2, 3, 4, 5, 7, 10, 16, 31, 64, 100, 160, 255, 384, 400]) add({ fn: "ncubeBound", d, piece, P });
  for (const polytope of CONTAINERS) if (isNDName(polytope)) for (let P = 1; P <= 24; P++) add({ fn: "ndBound", polytope, P });
  for (const name of POLYTOPES) {
    add({ fn: "polytope", name });
    add({ fn: "polytopeBuilt", name });
  }
  for (const name of POLYTOPE_PIECES) {
    add({ fn: "piece", name });
    add({ fn: "pieceBuilt", name });
  }
  return list;
}

// ------------------------------------------------------------------------------------------------------------ gen

const scale = (c: Config, k: number): Config => ({ s: c.s * k, pieces: c.pieces.map((p) => ({ ...p, u: p.u.map((x) => x * k) })) });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
function randomQ(r: () => number): number[] {
  const q = [gauss(r), gauss(r), gauss(r), gauss(r)];
  const n = Math.hypot(...q);
  return q.map((x) => x / n);
}
/** Do the pieces of this problem take a free rotation? */
const turns = (p: Problem) => groupOf(p.polytope) === "poly4" && p.piece !== "ball" && !(p.polytope === "tesseract" && p.piece === "cube");

/** The smallest scale (of s and the centres together) at which the validator accepts the configuration at 1e-9, by bisection. */
function tighten(problem: Problem, config: Config): Config | null {
  if (!check(problem, config, 1e-9).ok) return null;
  let hi = 1;
  let lo = 0.5;
  for (let i = 0; i < 12 && check(problem, scale(config, lo), 1e-9).ok; i++) {
    hi = lo;
    lo /= 2;
  }
  const t0 = performance.now();
  for (let i = 0; i < 60 && hi - lo > 1e-13 * hi && performance.now() - t0 < 3000; i++) {
    const mid = (lo + hi) / 2;
    if (check(problem, scale(config, mid), 1e-9).ok) hi = mid;
    else lo = mid;
  }
  return scale(config, hi);
}

/** A random point of a cell at edge s, as local coordinates: a random convex combination of the cell's vertices. */
function randomPoint(polytope: string, cell: number, s: number, r: () => number): number[] {
  const sharp = 0.3 + 3 * r();
  if (isNCubeName(polytope)) {
    const n = ncubeDim(polytope) - 1;
    const k = r() < 0.3 ? 1 : r();
    return Array.from({ length: n }, () => (2 * r() - 1) * (s / 2) * k);
  }
  if (isNDName(polytope)) {
    const C = getND(polytope as never);
    const cl = C.cell(cell);
    const x = new Float64Array(C.D);
    let total = 0;
    for (const v of C.vertices(s)) {
      let d = -s * cl.h;
      for (let j = 0; j < C.D; j++) d += cl.n[j] * v[j];
      if (Math.abs(d) > 1e-9 * s) continue;
      const w = r() ** sharp;
      total += w;
      for (let j = 0; j < C.D; j++) x[j] += w * v[j];
    }
    for (let j = 0; j < C.D; j++) x[j] /= total;
    return Array.from(C.toLocal(cell, x, s));
  }
  const c = getPolytope(polytope as never).cells[cell];
  const u = [0, 0, 0];
  let total = 0;
  for (const v of c.vertices) {
    const w = r() ** sharp;
    total += w;
    for (let k = 0; k < 3; k++) u[k] += w * v[k];
  }
  return u.map((x) => (x * s) / total);
}
const cellCount = (polytope: string) => highDimShape(polytope)?.cells ?? getPolytope(polytope as never).cells.length;
const dimU = (polytope: string) => highDimShape(polytope)?.dimU ?? 3;
const lowerBound = (p: Problem) => boundaryDomain.bound({ fields: { polytope: p.polytope, piece: p.piece }, P: Math.min(p.P, CONTAINER_MAX_P[p.polytope as never]) })?.value ?? 1;

async function gen(snapshot?: string) {
  const cases: Case[] = [];
  const add = (kind: string, problem: Problem, config: unknown, extra: Partial<Case> = {}) => {
    cases.push({ id: cases.length, group: extra.via ?? groupOf(problem.polytope), kind, problem: { ...problem }, config: clone(config), ...extra });
  };
  let turn = 0;
  /** A valid packing and its mutants (PORTING.md); which mutants a packing gets rotates, so that every kind meets every container. */
  const family = (label: string, problem: Problem, base: Config, r: () => number, all = false) => {
    const k = turn++ % 3;
    const P = base.pieces.length;
    add(label, problem, base);
    if (all || k === 0) {
      add(`${label}:squeeze-1e-10`, problem, scale(base, 1 - 1e-10));
      add(`${label}:squeeze-3e-9`, problem, scale(base, 1 - 3e-9));
      add(`${label}:squeeze-1e-6`, problem, scale(base, 1 - 1e-6));
    }
    if (all || k === 1) {
      if (P >= 2) {
        const c = clone(base);
        c.pieces[1] = { ...c.pieces[1], cell: c.pieces[0].cell, u: c.pieces[0].u.map((x, i) => (i === 0 ? x + 0.01 : x)) };
        add(`${label}:overlap`, problem, c);
      }
      const o = clone(base);
      o.pieces[0].u = o.pieces[0].u.map((x, i) => (i === 0 ? x + 2 * base.s : x));
      add(`${label}:outside`, problem, o);
      add(`${label}:loose`, problem, scale(base, 1.3));
    }
    if (all || k === 2) {
      add(`${label}:wrong-count`, { ...problem, P: P + 1 }, base);
      if (P >= 2) add(`${label}:wrong-count`, problem, { s: base.s, pieces: base.pieces.slice(0, -1) });
      const j = clone(base);
      for (const p of j.pieces) {
        p.u = p.u.map((x) => x + 0.05 * (2 * r() - 1));
        if (problem.piece !== "ball" && groupOf(problem.polytope) === "poly4") p.q = randomQ(r);
      }
      add(`${label}:jitter`, problem, j);
    }
  };

  // ---- real packings
  const records = JSON.parse(readFileSync(join(repo, "data/boundary/records.json"), "utf8")).records as { polytope: string; piece: string; P: number; config: Config }[];
  const rr = mulberry32(11);
  for (const rec of records) family("record", { polytope: rec.polytope, piece: rec.piece, P: rec.P }, rec.config, rr, true);
  const round2 = JSON.parse(readFileSync(join(repo, "data/boundary/sources/research_round2.json"), "utf8"));
  for (const [piece, key] of [["ball", "balls"], ["cube", "cubes"]] as const)
    for (const e of Object.values(round2[key] ?? {}) as { P: number; s: number; cells: number[]; U: number[][] }[])
      family("prototype", { polytope: "tesseract", piece, P: e.P }, { s: e.s, pieces: e.cells.map((cell, i) => ({ cell, u: e.U[i] })) }, rr);
  const search = JSON.parse(readFileSync(join(repo, "data/boundary/sources/search_2026-10-25.json"), "utf8"));
  for (const e of Object.values(search.runs ?? {}) as { piece: string; P: number; config: Config }[]) if (e.config) family("search", { polytope: "tesseract", piece: e.piece, P: e.P }, e.config, rr);
  if (snapshot) {
    for await (const line of createInterface({ input: createReadStream(snapshot).pipe(createGunzip()), crlfDelay: Infinity })) {
      if (!line.startsWith('{"problem"')) continue;
      const rec = JSON.parse(line.trim().replace(/,$/, "")) as { problem: string; config: Config };
      const p = parseBoundaryId(rec.problem);
      if (typeof p === "string") throw new Error(`snapshot: ${p}`);
      family("site", p, rec.config, rr, true);
    }
  }

  // ---- the package's structured starts, and each shrunk to the smallest size the validator accepts
  const plan = (polytope: string, piece: string): number[] => {
    const max = CONTAINER_MAX_P[polytope as never];
    if (isNCubeName(polytope)) return [1, 2, 9, 33, max];
    if (isNDName(polytope)) return [1, 2, 6, max];
    return polytope === "tesseract" ? [1, 3, 8, max] : [1, 2, 7, max];
  };
  for (const polytope of CONTAINERS)
    for (const piece of CONTAINER_PIECES[polytope]) {
      for (const P of plan(polytope, piece)) {
        const problem = { polytope, piece, P };
        const r = mulberry32(1000 + cases.length);
        const k = boundaryKernel(problem as never);
        // two starts for the smallest and the largest P (the cells themselves or the rings, then a sequential or a cell layout), one otherwise
        const states = k.seeds!(r, P === 1 || P === CONTAINER_MAX_P[polytope as never] ? 2 : 1);
        states.forEach((st, i) => {
          const config = k.toConfig(st) as Config;
          const tight = tighten(problem, config);
          if (!tight) add("seed:not-valid", problem, config);
          else {
            add("seed", problem, config);
            family(i === 0 ? "tight" : "tight2", problem, tight, r);
          }
        });
      }
    }
  // P above the catalogue's (the validator has its own limits): the tesseract's kernel goes to 64
  for (const piece of ["ball", "cube"]) {
    const problem = { polytope: "tesseract", piece, P: 64 };
    const k = boundaryKernel(problem as never);
    const config = k.toConfig(k.seeds!(mulberry32(64), 1)[0]) as Config;
    family("beyond-catalogue", problem, tighten(problem, config) ?? config, mulberry32(65));
  }

  // ---- the hunt: one random configuration for every sentence the validator gives on every container and piece
  for (const polytope of CONTAINERS)
    for (const piece of CONTAINER_PIECES[polytope]) {
      const r = mulberry32(5000 + cases.length);
      const seen = new Map<string, number>();
      const C = cellCount(polytope);
      const t0 = performance.now();
      const heavy = polytope === "120cell" || /^(6|7|8|9|10)demicube$/.test(polytope);
      for (let trial = 0; trial < (heavy ? 150 : 400) && performance.now() - t0 < 6000; trial++) {
        const P = 1 + Math.floor(3 * r() * r());
        const problem = { polytope, piece, P };
        const s = lowerBound(problem) * (0.85 + 2.2 * r() * r());
        // the pieces share one or two cells half of the time, so that they meet
        const few = r() < 0.5 ? [Math.floor(r() * C), Math.floor(r() * C)] : null;
        const config: Config = {
          s,
          pieces: Array.from({ length: P }, () => {
            const cell = few ? few[Math.floor(r() * 2)] : Math.floor(r() * C);
            const p: Piece = { cell, u: randomPoint(polytope, cell, s, r) };
            if (turns(problem) && r() < 0.8) p.q = randomQ(r);
            return p;
          }),
        };
        const v = check(problem, config, 1e-9);
        const keys = v.ok ? ["valid"] : v.reasons.map(template);
        let wanted = false;
        for (const key of new Set(keys)) {
          const n = seen.get(key) ?? 0;
          if (n < (key === "valid" ? 2 : 1)) {
            seen.set(key, n + 1);
            wanted = true;
          }
        }
        if (wanted) add("hunt", problem, config);
      }
    }

  // ---- reasons that the server's tolerances all but exclude, met where they can be
  // (a) A solid of the shape of its container's cells, about the size of a cell: it reaches the edges of the neighbouring cells
  //     while its own cell's edges stay outside it ("... beyond its anchor cell").
  for (const [polytope, piece] of [["5cell", "tetrahedron"], ["16cell", "tetrahedron"], ["600cell", "tetrahedron"], ["tesseract", "cube"], ["24cell", "octahedron"], ["120cell", "dodecahedron"]]) {
    const r = mulberry32(6000 + cases.length);
    const seen = new Set<string>();
    const C = cellCount(polytope);
    for (let trial = 0; trial < 300; trial++) {
      const problem = { polytope, piece, P: 1 };
      const s = 1 + 0.25 * r() * r();
      const cell = Math.floor(r() * C);
      const config: Config = { s, pieces: [{ cell, u: [0, 1, 2].map(() => 0.3 * (2 * r() - 1) * r()) }] };
      const v = check(problem, config, 1e-9);
      const keys = v.ok ? ["valid"] : v.reasons.map(template);
      if (keys.some((k) => !seen.has(k))) add("hunt:cell-shaped", problem, config);
      keys.forEach((k) => seen.add(k));
    }
  }
  // (b) The band of the ridge snap. A centre within the snap distance of a ridge is moved onto it, and the checks made from
  //     the moved centre charge the move to the tolerance: a ball whose distance from an edge of its own cell lies between the
  //     plain and the charged threshold passes the first test and fails the second ("... along the boundary"), and a solid with
  //     an edge that deep inside it likewise ("... beyond its anchor cell"). The band is about 1e-14 wide: it is found by
  //     bisection on the distance of the centre from an edge of its ridge, once for each tolerance.
  for (const polytope of POLYTOPES) {
    const poly = getPolytope(polytope);
    const s = 8;
    const c = poly.cells[1];
    const f = c.facets[2];
    const at = (i: number) => c.vertices[f.vertices[i]].map((x) => x * s);
    const mid = [0, 1, 2].map((k) => (at(0)[k] + at(1)[k]) / 2);
    const centroid = [0, 1, 2].map((k) => (s * f.vertices.reduce((a, v) => a + c.vertices[v][k], 0)) / f.vertices.length);
    const reach = Math.hypot(...centroid.map((x, k) => x - mid[k]));
    const dir = centroid.map((x, k) => (x - mid[k]) / reach);
    for (const piece of CONTAINER_PIECES[polytope]) {
      const problem = { polytope, piece, P: 1 };
      const r = mulberry32(6500 + cases.length);
      const q = turns(problem) ? { q: randomQ(r) } : {};
      for (const tol of [1e-9, 1e-11]) {
        // the snap distance in site units (chains.ts ridgeSnap; the ball code works on lengths x 2)
        const w = piece === "ball" ? 2 : 1;
        const snap = Math.max(2 ** -52 * Math.max(1, w * s), Math.min(1e-14 * Math.max(1, w * s), (w * tol) / 10)) / w;
        const config = (t: number): Config => ({ s, pieces: [{ cell: 1, u: mid.map((x, k) => x + t * dir[k] - 0.4 * snap * f.inside.n[k]), ...q }] });
        const where = (t: number): "deep" | "band" | "shallow" => {
          const v = check(problem, config(t), tol);
          const first = v.reasons[0] ?? "";
          if (/along the boundary|beyond its anchor cell/.test(first)) return "band";
          return /from an edge of the|passing through its interior/.test(first) ? "deep" : "shallow";
        };
        let lo = piece === "ball" ? 0.05 : 0;
        let hi = reach;
        if (where(lo) !== "deep" || where(hi) !== "shallow") continue;
        for (let i = 0; i < 200; i++) {
          const t = (lo + hi) / 2;
          const side = where(t);
          if (side === "band") {
            add(`snap-band:tol-${tol}`, problem, config(t));
            break;
          }
          if (side === "deep") lo = t;
          else hi = t;
        }
      }
    }
  }
  // (c) Tolerances far above the server's (0.4, 0.45): a ball may then sit close enough to an edge for a short geodesic loop
  //     round it to exist (the 5-cell, the simplices), and the d-cubes' loop search, which the server's tolerances all but
  //     skip, runs until its work limit.
  for (const polytope of CONTAINERS) {
    const r = mulberry32(6800 + cases.length);
    const C = cellCount(polytope);
    const seen = new Set<string>();
    const problem = { polytope, piece: "ball", P: 1 };
    const b = lowerBound(problem);
    const t0 = performance.now();
    for (let trial = 0; trial < 1500 && performance.now() - t0 < 4000; trial++) {
      const tol = trial % 2 ? 0.4 : 0.45;
      const s = isNCubeName(polytope) ? 0.405 + 0.03 * r() : b * (0.35 + 1.2 * r());
      const cell = Math.floor(r() * C);
      const config: Config = { s, pieces: [{ cell, u: randomPoint(polytope, cell, s, r) }] };
      const v = check(problem, config, tol);
      for (const reason of v.reasons) {
        const key = `${tol} ${template(reason)}`;
        if (!/overlaps itself|work limit|along the boundary|over a ridge/.test(reason) || seen.has(key)) continue;
        seen.add(key);
        add("big-tolerance", problem, config, { tol });
      }
    }
  }
  // (e) The nD validator tests a ball against the hinges of its own cell first and then along its chains, with one threshold:
  //     the second test can fail alone only by rounding, when the distance to a hinge, computed again from a neighbouring
  //     cell, comes out one unit in the last place lower. Found by bisection along a segment from a point too near a hinge to
  //     the cell's centre, then among the neighbouring doubles ("... along a path over a ridge").
  const nextDouble = (x: number, k: number) => {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, x);
    b.setBigUint64(0, b.getBigUint64(0) + BigInt(k));
    return b.getFloat64(0);
  };
  for (const polytope of CONTAINERS) {
    if (!isNDName(polytope)) continue;
    const C = getND(polytope);
    const problem = { polytope, piece: "ball", P: 1 };
    const s = lowerBound(problem) * 2.5;
    for (const tol of [1e-9, 1e-11]) {
      const r = mulberry32(6850 + cases.length);
      const t0 = performance.now();
      let found = false;
      while (!found && performance.now() - t0 < 5000) {
        const cell = Math.floor(r() * C.C);
        const from = randomPoint(polytope, cell, s, r);
        const config = (t: number): Config => ({ s, pieces: [{ cell, u: from.map((x) => x * (1 - t)) }] });
        const where = (t: number) => {
          const v = check(problem, config(t), tol);
          const first = v.reasons[0] ?? "";
          return /over a ridge/.test(first) ? "band" : /from a \(d-3\)-face/.test(first) ? "deep" : v.ok ? "shallow" : "other";
        };
        if (where(0) !== "deep" || where(1) !== "shallow") continue;
        let lo = 0;
        let hi = 1;
        let at = NaN;
        for (let i = 0; i < 80 && Number.isNaN(at); i++) {
          const t = (lo + hi) / 2;
          if (t === lo || t === hi) break;
          const side = where(t);
          if (side === "band") at = t;
          else if (side === "deep") lo = t;
          else hi = t;
        }
        for (let k = -30; k <= 30 && Number.isNaN(at); k++) if (where(nextDouble(hi, k)) === "band") at = nextDouble(hi, k);
        if (!Number.isNaN(at)) {
          add(`rounding-band:tol-${tol}`, problem, config(at));
          // and its neighbours on both sides, which fall on either side of the threshold
          add(`rounding-band:tol-${tol}`, problem, config(nextDouble(at, 3)));
          add(`rounding-band:tol-${tol}`, problem, config(nextDouble(at, -3)));
          found = true;
        }
      }
    }
  }
  // (d) One solid alone, turned at random and shrunk until it no longer fits: what stops it is an edge or its own other side
  //     round an edge ("... overlaps itself in cell"), on the two containers whose edges have the least angle round them.
  for (const polytope of ["5cell", "16cell"])
    for (const piece of POLYTOPE_PIECES) {
      const problem = { polytope, piece, P: 1 };
      const r = mulberry32(6900 + cases.length);
      const k = boundaryKernel(problem as never);
      for (const st of k.seeds!(r, 4).slice(1)) {
        const tight = tighten(problem, k.toConfig(st) as Config);
        if (tight) family("tight-alone", problem, tight, r, true);
      }
    }

  // ---- centres on a ridge and pieces across a fold
  for (const polytope of POLYTOPES) {
    const poly = getPolytope(polytope);
    const r = mulberry32(7000 + cases.length);
    for (const s of [2.5, 1.2]) {
      const cell = Math.floor(r() * poly.cells.length);
      const c = poly.cells[cell];
      const fi = Math.floor(r() * c.facets.length);
      const f = c.facets[fi];
      const m = [0, 1, 2].map((k) => (s * f.vertices.reduce((a, v) => a + c.vertices[v][k], 0)) / f.vertices.length);
      const n = f.inside.n;
      /** The point at `depth` inside the cell from the ridge's centre (negative: beyond the ridge), and the same point seen from the neighbour. */
      const at = (depth: number): number[] => m.map((x, k) => x - depth * n[k]);
      const across = (y: number[]): number[] => f.toNeighbor.A.map((row, i) => row[0] * y[0] + row[1] * y[1] + row[2] * y[2] + s * f.toNeighbor.b[i]);
      for (const piece of CONTAINER_PIECES[polytope]) {
        const q = () => (turns({ polytope, piece, P: 1 }) ? { q: randomQ(r) } : {});
        // one piece with its centre on the ridge, and within the snap distances of it
        for (const depth of [0, 1e-15, 1e-12, 1e-10, 0.2]) add(`ridge:depth-${depth}`, { polytope, piece, P: 1 }, { s, pieces: [{ cell, u: at(depth), ...q() }] });
        // two pieces that face each other across the ridge: at one point, overlapping, touching (balls) and apart
        for (const depth of [0, 0.3, 0.5, 0.5 + 1e-10, 0.5 - 1e-10, 0.9])
          add(`fold:pair-${depth}`, { polytope, piece, P: 2 }, { s, pieces: [{ cell, u: at(depth), ...q() }, { cell: f.neighbor, u: across(at(-depth)), ...q() }] });
      }
    }
  }
  for (const polytope of CONTAINERS) {
    if (!isNCubeName(polytope)) continue;
    const d = ncubeDim(polytope);
    const n = d - 1;
    for (const s of [2.5, 1.2]) {
      const h = s / 2;
      // cell (0, +) and its neighbour (1, +): local axis 0 of cell 1 is x_0, local axis 0 of cell 3 is x_0... the point x_0 = h, x_1 = h - depth
      // of cell 1 (local u_0 = x_1) faces the point x_1 = h, x_0 = h - depth of cell 3 (local u_0 = x_0) across their ridge
      const u = (depth: number) => Array.from({ length: n }, (_, k) => (k === 0 ? h - depth : 0));
      for (const piece of ["ball", "cube"]) {
        for (const depth of [0, 1e-12, 0.2, 0.5]) add(`ridge:depth-${depth}`, { polytope, piece, P: 1 }, { s, pieces: [{ cell: 1, u: u(depth) }] });
        for (const depth of [0, 0.3, 0.5, 0.5 + 1e-10, 0.5 - 1e-10, 0.9]) add(`fold:pair-${depth}`, { polytope, piece, P: 2 }, { s, pieces: [{ cell: 1, u: u(depth) }, { cell: 3, u: u(depth) }] });
      }
      // cubes: one crossing a face with a second cube where its slab lands in the neighbour, and one crossing two faces
      add("fold:cube-slab", { polytope, piece: "cube", P: 2 }, { s, pieces: [{ cell: 1, u: u(0.2) }, { cell: 3, u: Array.from({ length: n }, (_, k) => (k === 0 ? h - 0.6 : 0)) }] });
      add("fold:cube-two-axes", { polytope, piece: "cube", P: 1 }, { s, pieces: [{ cell: 1, u: Array.from({ length: n }, (_, k) => (k < 2 ? h - 0.3 : 0)) }] });
    }
    // the loop search runs only below s = 1/sqrt 2, where one ball still passes the clearance rule at 1e-9
    for (const s of [Math.SQRT1_2, 0.7071067805, 0.70710678, 0.7071067]) add("loops", { polytope, piece: "ball", P: 1 }, { s, pieces: [{ cell: 0, u: new Array(n).fill(0) }] });
  }
  for (const polytope of CONTAINERS) {
    if (!isNDName(polytope)) continue;
    const C = getND(polytope);
    const r = mulberry32(9000 + cases.length);
    for (const mult of [3, 1.3]) {
      const s = lowerBound({ polytope, piece: "ball", P: 2 }) * mult;
      for (const cell of [0, C.C - 1]) {
        const cl = C.cell(cell);
        const k = Math.floor(r() * cl.nbr.length);
        const g = cl.nbr[k];
        const gl = C.cell(g);
        const x = Array.from(C.ridgePoint(cell, g), (v) => v * s);
        /** The unit direction in the hyperplane of cell a that points away from its neighbour b's side of their ridge. */
        const inward = (a: typeof cl, b: typeof cl): number[] => {
          let dot = 0;
          for (let j = 0; j < C.D; j++) dot += a.n[j] * b.n[j];
          const nu = Array.from(b.n, (v, j) => v - dot * a.n[j]);
          const len = Math.hypot(...nu);
          return nu.map((v) => -v / len);
        };
        const inC = inward(cl, gl);
        const inG = inward(gl, cl);
        const uC = (depth: number) => Array.from(C.toLocal(cell, x.map((v, j) => v + depth * inC[j]), s));
        const uG = (depth: number) => Array.from(C.toLocal(g, x.map((v, j) => v + depth * inG[j]), s));
        for (const depth of [0, 1e-15, 1e-12, 1e-10, 0.2]) add(`ridge:depth-${depth}`, { polytope, piece: "ball", P: 1 }, { s, pieces: [{ cell, u: uC(depth) }] });
        for (const depth of [0, 0.3, 0.5, 0.5 + 1e-10, 0.5 - 1e-10, 0.9]) add(`fold:pair-${depth}`, { polytope, piece: "ball", P: 2 }, { s, pieces: [{ cell, u: uC(depth) }, { cell: g, u: uG(depth) }] });
      }
    }
  }

  // ---- the limits on the work, the volume bound and the size range
  const first = (kind: string, polytope: string, piece: string, minP = 1) => cases.find((c) => c.kind === kind && c.problem.polytope === polytope && c.problem.piece === piece && c.problem.P >= minP);
  for (const polytope of POLYTOPES)
    for (const piece of CONTAINER_PIECES[polytope]) {
      const c = first("tight", polytope, piece, 2) ?? first("tight", polytope, piece);
      if (!c) continue;
      const config = c.config as Config;
      // the chain limit: a piece may cross at most maxChains chains of cells (the server's 1024 is beyond what pieces that pass the edge tests reach)
      for (const maxChains of [1, 2, 7, 40]) add(`limit:maxChains-${maxChains}`, c.problem, config, { opts: { maxChains } });
      add("limit:maxChains-default", c.problem, config, { opts: { maxChains: 4096 } });
      // the reasons' limit, on a crowd, and the limit on the tests of pairs of parts
      const crowd = clone(config);
      crowd.pieces.forEach((p, i) => {
        if (i === 0) return;
        p.cell = crowd.pieces[0].cell;
        p.u = crowd.pieces[0].u.map((x, k) => (k === i % 3 ? x + 0.02 * i : x));
      });
      for (const maxReasons of [1, 3, 0, 2.7]) add(`limit:maxReasons-${maxReasons}`, c.problem, crowd, { opts: { maxReasons } });
      if (piece !== "ball") for (const maxPairs of [0, 1, 5]) add(`limit:maxPairs-${maxPairs}`, c.problem, crowd, { opts: { maxPairs } });
    }
  for (const polytope of CONTAINERS) {
    if (isNCubeName(polytope)) {
      const c = first("tight", polytope, "ball", 30)!;
      for (const maxWork of [1, 30, 1000, 0.5]) add(`limit:maxWork-${maxWork}`, c.problem, c.config, { opts: { maxWork } });
      for (const maxReasons of [1, 3]) add(`limit:maxReasons-${maxReasons}`, c.problem, scale(c.config as Config, 0.9), { opts: { maxReasons } });
      // a crowd that passes the clearance rule: every ball at the centre of a cell, far more of them than cells
      const d = ncubeDim(polytope);
      const P = polytope === "5cube" ? 160 : 384;
      add("crowd", { polytope, piece: "ball", P }, { s: 0.7071067805, pieces: Array.from({ length: P }, (_, i) => ({ cell: i % (2 * d), u: new Array(d - 1).fill(0) })) });
    }
    if (isNDName(polytope)) {
      const c = first("tight", polytope, "ball", 6)!;
      for (const maxWork of [1, 20, 300]) add(`limit:maxWork-${maxWork}`, c.problem, c.config, { opts: { maxWork } });
      for (const maxOps of [1, 5000, 200000]) add(`limit:maxOps-${maxOps}`, c.problem, c.config, { opts: { maxOps } });
      for (const maxReasons of [1, 3]) add(`limit:maxReasons-${maxReasons}`, c.problem, scale(c.config as Config, 0.9), { opts: { maxReasons } });
      // the natural limits: balls at facet centres at the one-ball edge, where every hinge of the cell ties
      const one = first("seed", polytope, "ball")!;
      const C = getND(polytope);
      for (const P of [2, 6]) add("crowd", { polytope, piece: "ball", P }, { s: (one.config as Config).s, pieces: Array.from({ length: P }, (_, i) => ({ cell: (i * 7) % C.C, u: new Array(C.n).fill(0) })) });
    }
  }
  for (const polytope of CONTAINERS)
    for (const piece of CONTAINER_PIECES[polytope]) {
      const C = cellCount(polytope);
      const n = dimU(polytope);
      const centre = (P: number, s: number): Config => ({ s, pieces: Array.from({ length: P }, (_, i) => ({ cell: i % C, u: new Array(n).fill(0) })) });
      const max = CONTAINER_MAX_P[polytope as never];
      // the volume bound refuses a container too small for its pieces before any geometry
      const b = lowerBound({ polytope, piece, P: max });
      add("volume", { polytope, piece, P: max }, centre(max, 0.3 * b));
      add("volume", { polytope, piece, P: max }, centre(max, 0.05));
      add("volume", { polytope, piece, P: 1 }, centre(1, 1e-3));
      // the size range: s up to MAX_S = 1e4
      for (const s of [1e4, 1e4 * (1 + 1e-12), 9999.5, 1e-300, 5e-324]) add("size", { polytope, piece, P: 1 }, centre(1, s));
      add("size", { polytope, piece, P: 2 }, { s: 1e4, pieces: [{ cell: 0, u: new Array(n).fill(0) }, { cell: 0, u: Array.from({ length: n }, (_, k) => (k === 0 ? 1 : 0)) }] });
    }

  // ---- malformed input: every field, on one problem of each kind
  const bad: [string, (c: Config, p: Problem) => unknown, ((p: Problem) => Problem)?][] = [
    ["config-null", () => null], ["config-array", (c) => [c]], ["config-number", () => 3], ["config-string", () => "s"], ["config-empty", () => ({})],
    ["s-missing", (c) => ({ pieces: c.pieces })], ["s-null", (c) => ({ ...c, s: null })], ["s-string", (c) => ({ ...c, s: String(c.s) })], ["s-zero", (c) => ({ ...c, s: 0 })],
    ["s-negative", (c) => ({ ...c, s: -c.s })], ["s-huge", (c) => ({ ...c, s: 1e9 })], ["s-array", (c) => ({ ...c, s: [c.s] })], ["s-bool", (c) => ({ ...c, s: true })],
    ["pieces-missing", (c) => ({ s: c.s })], ["pieces-object", (c) => ({ s: c.s, pieces: { 0: c.pieces[0], length: 1 } })], ["pieces-null", (c) => ({ s: c.s, pieces: null })],
    ["pieces-empty", (c) => ({ s: c.s, pieces: [] })], ["pieces-and-s", () => ({ s: "x", pieces: 7 })], ["s-bad-and-count", (c) => ({ s: -1, pieces: [...c.pieces, c.pieces[0]] })],
    ["piece-null", (c) => ({ ...c, pieces: c.pieces.map((p, i) => (i ? p : null)) })], ["piece-array", (c) => ({ ...c, pieces: c.pieces.map((p, i) => (i ? p : [p.cell, p.u])) })],
    ["piece-number", (c) => ({ ...c, pieces: c.pieces.map((p, i) => (i ? p : 5)) })], ["piece-empty", (c) => ({ ...c, pieces: c.pieces.map((p, i) => (i ? p : {})) })],
    ["cell-missing", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ u: p.u })) })], ["cell-fraction", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, cell: p.cell + 0.5 })) })],
    ["cell-negative", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, cell: -1 })) })], ["cell-too-large", (c, p) => ({ ...c, pieces: c.pieces.map((x) => ({ ...x, cell: cellCount(p.polytope) })) })],
    ["cell-string", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, cell: String(p.cell) })) })], ["cell-huge", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, cell: 1e300 })) })],
    ["cell-last", (c, p) => ({ ...c, pieces: c.pieces.map((x) => ({ ...x, cell: cellCount(p.polytope) - 1 })) })],
    ["u-missing", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ cell: p.cell })) })], ["u-short", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, u: p.u.slice(1) })) })],
    ["u-long", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, u: [...p.u, 0] })) })], ["u-null-entry", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, u: p.u.map((x, i) => (i ? x : null)) })) })],
    ["u-string-entry", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, u: p.u.map(String) })) })], ["u-object", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, u: { 0: 0, 1: 0, 2: 0 } })) })],
    ["u-huge", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, u: p.u.map(() => 1e308) })) })], ["u-outside", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, u: p.u.map(() => c.s) })) })],
    ["u-just-outside", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, u: p.u.map((x, i) => (i ? 0 : c.s / 2 + 5e-10)) })) })],
    ["q-null", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: null })) })], ["q-identity", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [1, 0, 0, 0] })) })],
    ["q-short", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [1, 0, 0] })) })], ["q-string", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: "1,0,0,0" })) })],
    ["q-null-entry", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [1, 0, 0, null] })) })], ["q-not-unit", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [1.001, 0, 0, 0] })) })],
    ["q-zero", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [0, 0, 0, 0] })) })], ["q-nearly-unit", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [1 + 5e-10, 0, 0, 0] })) })],
    ["q-just-not-unit", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [1 + 2e-9, 0, 0, 0] })) })], ["q-quarter-turn", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [Math.SQRT1_2, Math.SQRT1_2, 0, 0] })) })],
    ["q-third-turn", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [0.5, 0.5, 0.5, 0.5] })) })], ["q-turned", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [Math.cos(0.3), Math.sin(0.3), 0, 0] })) })],
    ["q-barely-turned", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [Math.cos(2e-10), Math.sin(2e-10), 0, 0] })) })], ["q-turned-1e-8", (c) => ({ ...c, pieces: c.pieces.map((p) => ({ ...p, q: [Math.cos(1e-8), Math.sin(1e-8), 0, 0] })) })],
    ["extra-fields", (c) => ({ ...c, note: "x", pieces: c.pieces.map((p) => ({ ...p, colour: "red" })) })], ["many-wrong", (c) => ({ ...c, pieces: Array.from({ length: c.pieces.length }, () => 0) })],
    ["P-zero", (c) => c, (p) => ({ ...p, P: 0 })], ["P-fraction", (c) => c, (p) => ({ ...p, P: p.P + 0.5 })], ["P-negative", (c) => c, (p) => ({ ...p, P: -p.P })], ["P-too-large", (c) => c, (p) => ({ ...p, P: 10000 })],
    ["P-largest", (c) => c, (p) => ({ ...p, P: 9999 })], ["piece-unknown", (c) => c, (p) => ({ ...p, piece: "sphere" })], ["piece-other", (c) => c, (p) => ({ ...p, piece: p.piece === "icosahedron" ? "ball" : "icosahedron" })],
    ["piece-cube", (c) => c, (p) => ({ ...p, piece: "cube" })], ["polytope-unknown", (c) => c, (p) => ({ ...p, polytope: "8cell" })], ["polytope-and-piece-unknown", (c) => c, (p) => ({ polytope: "", piece: "", P: 1.5 })],
  ];
  for (const [polytope, piece] of [["tesseract", "ball"], ["tesseract", "cube"], ["5cell", "tetrahedron"], ["600cell", "icosahedron"], ["24cell", "cube"], ["5cube", "ball"], ["8cube", "cube"], ["5simplex", "ball"], ["7orthoplex", "ball"], ["6demicube", "ball"]]) {
    const c = first("seed", polytope, piece, 2)!;
    for (const [name, f, g] of bad) add(`malformed:${name}`, g ? g(c.problem) : c.problem, f(clone(c.config as Config), c.problem));
    // a full list of wrong pieces: more reasons than the limit
    const many = { s: (c.config as Config).s, pieces: Array.from({ length: 30 }, () => ({ cell: -1, u: [] })) };
    add("malformed:many-pieces", { ...c.problem, P: 30 }, many);
    add("malformed:many-pieces", { ...c.problem, P: 30 }, many, { opts: { maxReasons: 100 } });
    // a tolerance that is no tolerance: the 4-polytopes' and the d-cubes' validators throw, the nD one falls back to 1e-9
    for (const tol of [-1, "NaN", "Infinity", 0, 1e-3]) add(`tol:${tol}`, c.problem, c.config, { tol });
  }

  // ---- the d-cube and the nD validators called directly: the refusals that validateBoundary never lets them give
  {
    const cube = first("seed", "5cube", "ball", 2)!;
    const simplex = first("seed", "5simplex", "ball", 2)!;
    add("direct", { ...cube.problem, polytope: "tesseract" }, cube.config, { via: "ncube" });
    add("direct", { ...cube.problem, polytope: "5simplex" }, cube.config, { via: "ncube" });
    add("direct", { ...cube.problem, piece: "tetrahedron" }, cube.config, { via: "ncube" });
    add("direct", { ...cube.problem, P: 2.5 }, cube.config, { via: "ncube" });
    add("direct", cube.problem, cube.config, { via: "ncube" });
    add("direct", { ...simplex.problem, polytope: "5cube" }, simplex.config, { via: "nd" });
    add("direct", { ...simplex.problem, polytope: "tesseract" }, simplex.config, { via: "nd" });
    add("direct", { ...simplex.problem, piece: "cube" }, simplex.config, { via: "nd" });
    add("direct", simplex.problem, simplex.config, { via: "nd" });
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(outDir, "extras.jsonl"), genExtras().map((c) => JSON.stringify(c)).join("\n") + "\n");
  const by = new Map<string, number>();
  for (const c of cases) by.set(c.group, (by.get(c.group) ?? 0) + 1);
  console.log(`${cases.length} cases written:`, Object.fromEntries(by));
}

// ------------------------------------------------------------------------------------------------------------ main

const readLines = <T>(file: string): T[] => readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

if (mode === "gen") await gen(arg3);
else if (mode === "run") {
  const all = readLines<Case>(join(outDir, "cases.jsonl"));
  const [k, n] = arg3 ? arg3.split("/").map(Number) : [0, 1];
  const cases = all.filter((_, i) => i % n === k);
  const tag = arg3 ? `.${k}` : "";
  // the polytopes are built on first use: outside the timings, as the server's first check pays it once
  for (const name of POLYTOPES) getPolytope(name);
  const lines: string[] = [];
  const best: number[][] = [];
  for (const c of cases) {
    const runs = [];
    const times = [];
    for (const tol of tolsOf(c)) {
      const t = process.hrtime.bigint();
      runs.push(runCase(c, tol));
      times.push(Number(process.hrtime.bigint() - t));
    }
    lines.push(JSON.stringify({ id: c.id, runs }));
    best.push(times);
  }
  writeFileSync(join(outDir, `ref${tag}.jsonl`), lines.join("\n") + "\n");
  // timing: the validator as the server calls it, best of five passes per run (the first pass is the one above)
  for (let pass = 0; pass < 4; pass++)
    cases.forEach((c, i) =>
      tolsOf(c).forEach((tol, j) => {
        const stats = { steps: 0, ops: 0 };
        const nd = c.via ? c.via === "nd" : isNDName(c.problem.polytope);
        const t = process.hrtime.bigint();
        try {
          check(c.problem, c.config, tol, c.opts, nd ? stats : undefined, c.via);
        } catch {
          // a thrown tolerance: timed like any other run
        }
        const d = Number(process.hrtime.bigint() - t);
        if (d < best[i][j]) best[i][j] = d;
      }),
    );
  writeFileSync(join(outDir, `ts-times${tag}.json`), JSON.stringify(cases.map((c, i) => ({ id: c.id, t: best[i] }))));
  if (k === 0) {
    const extras = readLines<Record<string, unknown>>(join(outDir, "extras.jsonl"));
    writeFileSync(join(outDir, "ref-extras.jsonl"), extras.map((q) => JSON.stringify({ id: q.id, out: extra(q) ?? null }, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v))).join("\n") + "\n");
  }
  console.log(`${cases.length} cases checked${arg3 ? ` (shard ${arg3})` : ""}`);
} else if (mode === "fixtures") {
  // Cases with the TypeScript's verdicts, for `cargo test` without Node: the first small case of every kind of every group
  // (for the 4-polytopes, of balls and of solids), every fourth of the malformed ones, and a sample of the extras without
  // the tables.
  const cases = readLines<Case>(join(outDir, "cases.jsonl"));
  const ref = new Map(readLines<{ id: number; runs: unknown[] }>(join(outDir, "ref.jsonl")).map((r) => [r.id, r.runs]));
  const dir = join(repo, "native/boundary/tests/fixtures");
  mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();
  const picked: string[] = [];
  let bytes = 0;
  let malformed = 0;
  for (const c of cases) {
    const kind = /^(ridge|fold|limit|snap-band|rounding-band|tol|hunt)/.test(c.kind) ? c.kind.replace(/[:-]?-?\d+(\.\d+)?(e-?\d+)?$/, "") : c.kind;
    const key = `${c.group}|${kind}|${c.group === "poly4" ? (c.problem.piece === "ball" ? "ball" : "solid") : ""}`;
    const line = JSON.stringify({ ...c, runs: ref.get(c.id) });
    if (seen.has(key) || line.length > 4000 || !ref.has(c.id)) continue;
    seen.add(key);
    if (c.kind.startsWith("malformed:") && malformed++ % 4 !== 0) continue;
    picked.push(line);
    bytes += line.length;
  }
  writeFileSync(join(dir, "cases.jsonl"), picked.join("\n") + "\n");
  const extras = readLines<Record<string, unknown>>(join(outDir, "extras.jsonl"));
  const refExtras = new Map(readLines<{ id: number; out: unknown }>(join(outDir, "ref-extras.jsonl")).map((r) => [r.id, r.out]));
  const count = new Map<string, number>();
  const small = extras
    .filter((q) => {
      const fn = q.fn as string;
      if (["polytope", "polytopeBuilt", "piece", "pieceBuilt"].includes(fn)) return false;
      const n = count.get(fn) ?? 0;
      count.set(fn, n + 1);
      // the long lists (the bounds of the whole domain) are sampled; the short ones are kept whole
      return ["bound", "checkMs", "ballBounds", "pieceBounds", "ncubeBound", "ndBound", "boundaryBound"].includes(fn) ? n % 13 === 0 : true;
    })
    .filter((q) => JSON.stringify(refExtras.get(q.id as number)).length < 5000)
    .map((q) => JSON.stringify({ ...q, out: refExtras.get(q.id as number) }));
  writeFileSync(join(dir, "extras.jsonl"), small.join("\n") + "\n");
  console.log(`${picked.length} cases (${bytes} bytes) and ${small.length} extras (${small.join("").length} bytes) written to ${dir}`);
} else throw new Error(`unknown mode ${mode}`);
