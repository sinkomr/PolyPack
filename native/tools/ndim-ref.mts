// The TypeScript side of the comparison of the ndim family (native/PORTING.md): builds the cases and writes the
// reference results of packages/ndim and packages/ndspace as the server calls them, with timings.
//
//   node --import tsx native/tools/ndim-ref.mts OUTDIR --build SNAPSHOT.json.gz     writes OUTDIR/cases.jsonl
//   node --import tsx native/tools/ndim-ref.mts OUTDIR                              writes ref.jsonl and ts-times.json
//   node --import tsx native/tools/ndim-ref.mts OUTDIR --fixtures N FILE            writes N of the cases with their results
//
// then `cargo run --release -p polypack-ndim --example ndimdiff -- OUTDIR` and
// `node native/tools/ndim-compare.mjs OUTDIR`. Building the cases is a run of its own (a few minutes: tight packings
// are made by scaling random ones down to contact with the validator), because it loads polytopes and the first cases
// ask what an unloaded one answers: the results come from a fresh process. --fixtures takes N small cases spread over
// the operations and kinds, with the results of ref.jsonl, and writes them to FILE for `cargo test`
// (native/ndim/tests/fixtures/cases.jsonl).
//
// Cases (one JSON object per line of cases.jsonl, `op` says what both sides do with it):
//   check    a configuration as the server receives it: parseNdConfig, loadNdProblem, then ndCheck (ndCheckSteps run
//            to its end) and the core's validateNd at both tolerances (1e-9 and 1e-11)
//   cap      ndCheckSteps with a given cap, maxErrors and a clock that advances by a fixed amount per reading
//   core     the core's validateNd with options the server does not use (limits, maxPairErrors, deadline, problems
//            that are not well formed or not loaded)
//   id       parseNdId and ndInRange
//   bound    the bounds, the work estimate and the heavy flag of one pair of shapes for every P
//   domain   the domain's info, samples and the constants
//   table    the coordinates of one polytope (a hash of every double) and loadPolytope's errors
//   load     loadNdProblem
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cayleyMatrix,
  getPolytope,
  isLoaded,
  loadPolytope,
  pairSeparation,
  polytopeInfo,
  tightScale,
  validateNd,
  POLYTOPE_CODES,
  type NdValidation,
} from "../../packages/ndim/src/index.ts";
import {
  ND_BALL,
  ND_DIMENSIONS,
  ND_ID_FORM,
  ND_MAX_P,
  ND_P_RANGE,
  ND_SHAPE_NAMES,
  ndCode,
  ndInRange,
  ndShapes,
  parseNdId,
  type NdProblemId,
} from "../../packages/ndspace/src/catalogue.ts";
import { ndBoundEntry, ndLowerBound } from "../../packages/ndspace/src/bounds.ts";
import { ndimDomain } from "../../packages/ndspace/src/domain.ts";
import {
  NDIM_CHECK_MS,
  NDIM_HEAVY_OPS,
  NDIM_MAX_REASONS,
  loadNdProblem,
  ndCheck,
  ndCheckOps,
  ndCheckSteps,
  ndIsHeavy,
  ndProblemOf,
  parseNdConfig,
  type NdConfigShape,
} from "../../packages/ndspace/src/validate.ts";
import { ndKernel } from "../../packages/ndspace/src/kernel.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (name: string): string[] | null => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const n = name === "--fixtures" ? 2 : name === "--build" ? 1 : 0;
  return args.splice(i, n + 1).slice(1);
};
const buildArg = flag("--build");
const fixturesArg = flag("--fixtures");
const [outDir] = args;
const snapshot = buildArg?.[0];
if (!outDir) throw new Error("usage: ndim-ref.mts OUTDIR [--build SNAPSHOT.json.gz | --fixtures N FILE]");

// ---------------------------------------------------------------------------------------------------- helpers
let seed = 20261110;
/** A deterministic stream in [0, 1) (mulberry32). */
const rnd = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
const nParams = (d: number) => (d * (d - 1)) / 2;
type Cfg = { s: number; pieces: number[][] };
type Prob = { d: number; piece: string; container: string; P: number };
type Case = Record<string, unknown> & { id: number; op: string; group: string; kind: string };
const cases: Case[] = [];
const add = (c: Omit<Case, "id">) => cases.push({ id: cases.length, ...c } as Case);
const check = (group: string, kind: string, p: Prob, raw: unknown) =>
  add({ op: "check", group, kind, d: p.d, piece: p.piece, container: p.container, P: p.P, raw });
const copy = (c: Cfg): Cfg => ({ s: c.s, pieces: c.pieces.map((q) => q.slice()) });
const load = async (p: { d: number; piece: string; container: string }) => {
  for (const code of [ndCode(p.d, p.piece), ndCode(p.d, p.container)]) if (code !== ND_BALL) await loadPolytope(code);
};

/** The mutants of a well-formed configuration: `which` picks one family (they rotate over the real packings). */
function mutants(group: string, p: Prob, cfg: Cfg, which: number): void {
  const d = p.d;
  const ball = p.piece === ND_BALL;
  const n = cfg.pieces.length;
  const scaled = (f: number, withCentres: boolean): Cfg => ({
    s: cfg.s * f,
    pieces: cfg.pieces.map((q) => q.map((v, k) => (withCentres && k < d ? v * f : v))),
  });
  switch (which % 14) {
    case 0: {
      if (n < 2) break;
      // piece 1 moved into piece 0
      const c = copy(cfg);
      for (let k = 0; k < d; k++) c.pieces[1][k] = c.pieces[0][k] + (k === 0 ? 0.01 : 0);
      check(group, "overlap", p, c);
      break;
    }
    case 1:
      check(group, "squeeze-1e-10", p, scaled(1 - 1e-10, true));
      check(group, "squeeze-3e-9", p, scaled(1 - 3e-9, true));
      break;
    case 2:
      check(group, "squeeze-1e-6", p, scaled(1 - 1e-6, true));
      break;
    case 3:
      check(group, "shrink-s-1e-10", p, scaled(1 - 1e-10, false));
      check(group, "shrink-s-3e-9", p, scaled(1 - 3e-9, false));
      break;
    case 4:
      check(group, "shrink-s-1e-6", p, scaled(1 - 1e-6, false));
      break;
    case 5: {
      // a piece outside the container
      const c = copy(cfg);
      const i = Math.floor(rnd() * n);
      c.pieces[i][Math.floor(rnd() * d)] += cfg.s * (0.5 + rnd());
      check(group, "outside", p, c);
      break;
    }
    case 6: {
      const c = copy(cfg);
      c.pieces.pop();
      check(group, "count-1", p, c);
      const e = copy(cfg);
      e.pieces.push(e.pieces[0].slice());
      check(group, "count+1", p, e);
      break;
    }
    case 7: {
      if (n < 2) break;
      // a piece exactly on another (every support point ties)
      const c = copy(cfg);
      c.pieces[n - 1] = c.pieces[0].slice();
      check(group, "coincide", p, c);
      break;
    }
    case 8: {
      if (ball) {
        const c = copy(cfg);
        c.pieces[0][0] += 1e-9;
        check(group, "nudge", p, c);
        break;
      }
      // another flip (an even mask: a different rotation), and the flip left out when it is 0
      const c = copy(cfg);
      const m = d + nParams(d);
      const f = c.pieces[0].length > m ? c.pieces[0][m] : 0;
      c.pieces[0][m] = (f ^ 3) & ((1 << d) - 1);
      for (const q of c.pieces) if (q.length > m && q[m] === 0 && rnd() < 0.5) q.pop();
      check(group, "flip", p, c);
      break;
    }
    case 9: {
      // every coordinate moved by up to 2e-9 (around the tolerance)
      const c = copy(cfg);
      for (const q of c.pieces) for (let k = 0; k < d; k++) q[k] += (rnd() - 0.5) * 4e-9;
      check(group, "jitter-2e-9", p, c);
      break;
    }
    case 10:
      check(group, "malformed", p, malformed(p, cfg, Math.floor(rnd() * 1000)));
      break;
    case 11: {
      // grown: looser, still valid
      check(group, "grow-1e-6", p, scaled(1 + 1e-6, true));
      break;
    }
    case 12: {
      if (n < 2) break;
      // two pieces swapped (the same packing), and one turned a little (polytopes)
      const c = copy(cfg);
      [c.pieces[0], c.pieces[n - 1]] = [c.pieces[n - 1], c.pieces[0]];
      if (!ball) c.pieces[0][d] = Math.max(-32, Math.min(32, c.pieces[0][d] + 1e-6));
      check(group, "swap-turn", p, c);
      break;
    }
    case 13:
      check(group, "squeeze-2e-11", p, scaled(1 - 2e-11, true));
      check(group, "shrink-s-1e-3", p, scaled(1 - 1e-3, false));
      break;
  }
}

/** A malformed variant of a configuration (untrusted JSON of every wrong kind the parser names). */
function malformed(p: Prob, cfg: Cfg, k: number): unknown {
  const d = p.d;
  const m = d + nParams(d);
  const ball = p.piece === ND_BALL;
  const c = copy(cfg) as { s: unknown; pieces: unknown[] } & Record<string, unknown>;
  const i = Math.min(cfg.pieces.length - 1, k % 3);
  const pose = () => c.pieces[i] as unknown[];
  const kinds: (() => unknown)[] = [
    () => null,
    () => [cfg.s, cfg.pieces],
    () => "config",
    () => 7,
    () => ({ pieces: cfg.pieces }),
    () => ((c.s = 0), c),
    () => ((c.s = -cfg.s), c),
    () => ((c.s = 1e6 + 1), c),
    () => ((c.s = String(cfg.s)), c),
    () => ((c.s = null), c),
    () => ((c.s = true), c),
    () => ((c.s = [cfg.s]), c),
    () => ({ s: cfg.s }),
    () => ({ s: cfg.s, pieces: {} }),
    () => ({ s: cfg.s, pieces: "poses" }),
    () => ({ s: cfg.s, pieces: null }),
    () => ({ s: "x", pieces: 3 }),
    () => ((c.pieces[i] = "x"), c),
    () => ((c.pieces[i] = null), c),
    () => ((c.pieces[i] = { t: cfg.pieces[i] }), c),
    () => ((c.pieces[i] = 3), c),
    () => ((c.pieces[i] = pose().slice(0, d - 1)), c),
    () => ((c.pieces[i] = [...pose(), 0, 0]), c),
    () => ((c.pieces[i] = ball ? [...pose(), 0] : pose().slice(0, d)), c),
    () => ((pose()[1] = "0"), c),
    () => ((pose()[d - 1] = null), c),
    () => ((pose()[0] = true), c),
    () => ((pose()[2] = [0]), c),
    () => ((pose()[0] = 1e4 + 1), c),
    () => ((pose()[d - 1] = -10000.000000001), c),
    () => ((pose()[0] = 1e4), c), // allowed: exactly the limit
    () => (ball ? ((pose()[0] = -1e4), c) : ((pose()[d] = 32.000001), c)),
    () => (ball ? c : ((pose()[m - 1] = -33), c)),
    () => (ball ? c : ((pose()[d + 1] = 32), c)), // allowed: exactly the limit
    () => (ball ? c : ((pose()[m] = 1), c)), // an odd flip
    () => (ball ? c : ((pose()[m] = 2 ** d), c)),
    () => (ball ? c : ((pose()[m] = -2), c)),
    () => (ball ? c : ((pose()[m] = 0.5), c)),
    () => (ball ? c : ((pose()[m] = "0"), c)),
    () => (ball ? c : ((pose()[m] = null), c)),
    () => (ball ? c : ((pose()[m] = 2 ** d - 1 - (d % 2 ? 1 : 0)), c)), // the largest even mask: allowed
    () => (ball ? c : ((pose()[m] = 7), c)),
    () => ((c.s = 0), (c.pieces = c.pieces.slice(0, -1)), c), // a bad s and a wrong count: the poses are still read
    () => ((c.s = "2"), (c.pieces = [...c.pieces, "x", "y"]), c),
    () => ((c.pieces = c.pieces.map(() => [NaN])), c), // more errors than are listed (NaN is null in JSON)
    () => ((c.pieces = c.pieces.map((q, j) => (j % 2 ? "x" : q))), c),
    () => ((c.extra = { a: 1 }), (c.unit = "edge"), c), // unknown fields are ignored
    () => ((c.pieces = []), c),
    () => ((pose()[0] = 1e300), c),
    () => ((c.s = 1e-300), c),
    () => ((c.s = 1e6), c),
    () => ((c.s = 5e-324), c),
  ];
  return kinds[k % kinds.length]();
}

/** A random pose: a centre in [-r, r]^d and, for a polytope, Cayley parameters up to `turn` and an even flip. */
function randomPose(d: number, ball: boolean, r: number, turn: number): number[] {
  const q: number[] = [];
  for (let k = 0; k < d; k++) q.push((2 * rnd() - 1) * r);
  if (ball) return q;
  for (let k = 0; k < nParams(d); k++) q.push((2 * rnd() - 1) * turn);
  const kind = rnd();
  if (kind < 0.3) return q; // no flip entry
  if (kind < 0.5) return [...q, 0];
  let f = Math.floor(rnd() * 2 ** d);
  let bits = 0;
  for (let b = f; b; b &= b - 1) bits++;
  if (bits & 1) f ^= 1;
  return [...q, f];
}

// ---------------------------------------------------------------------------------------------- building cases
async function build(): Promise<void> {
  // -- 0. before anything is loaded: the problems whose polytopes are loaded on demand say so
  for (const [d, a, b] of [
    [4, "4:24cell", "4:cube"],
    [4, "4:cube", "4:600cell"],
    [6, "6:221", "6:122"],
    [7, "7:321", "ball"],
    [8, "8:421", "8:421"],
    [8, "ball", "8:421"],
  ] as [number, string, string][])
    add({
      op: "core",
      group: "unloaded",
      kind: "unloaded",
      problem: { d, piece: a, container: b },
      config: { s: 3, pieces: [randomPose(d, a === "ball", 0.1, 0.2), randomPose(d, a === "ball", 0.1, 0.2)] },
      opts: {},
      load: false,
    });
  add({ op: "table", group: "table", kind: "unloaded", code: "4:120cell", load: false });
  add({ op: "table", group: "table", kind: "unloaded", code: "4:cube", load: false });

  // -- 1. tables: every catalogue polytope, and codes that are not in the catalogue
  for (const code of POLYTOPE_CODES) add({ op: "table", group: "table", kind: "table", code, load: true });
  for (const code of ["4:demi", "5:24cell", "8:321", "11:cube", "3:cube", "cube", "", "4:Cube", "4:cube ", "04:cube", "ball", '4:"x"'])
    add({ op: "table", group: "table", kind: "unknown", code, load: true });
  for (const [d, a, b] of [
    [8, "421", "ball"],
    [4, "24cell", "600cell"],
    [5, "24cell", "cube"],
    [9, "cube", "421"],
    [4, "ball", "ball"],
    [12, "cube", "cube"],
    [6, "ortho", "x\ny"],
  ] as [number, string, string][])
    add({ op: "load", group: "load", kind: "load", d, piece: a, container: b });

  // -- 2. ids, bounds and the domain
  const ids: unknown[] = [
    "ndim/4/cube/cube/2", "ndim/10/ball/421/5", "ndim/8/ball/421/5", "ndim/4/demi/cube/3", "ndim/5/demi/ball/32", "ndim/5/demi/ball/33",
    "ndim/4/cube/cube/40", "ndim/4/cube/cube/41", "ndim/4/cube/cube/1", "ndim/4/cube/cube/0", "ndim/4/cube/cube/02", "ndim/04/cube/cube/2",
    "ndim/4/cube/cube/9999", "ndim/4/cube/cube/10000", "ndim/3/cube/cube/2", "ndim/11/cube/cube/2", "ndim/4/cube/cube", "ndim/4/cube/cube/2/",
    "/ndim/4/cube/cube/2", "Ndim/4/cube/cube/2", "ndim/4/Cube/cube/2", "ndim/4/cube/cube/2 ", "ndim/4/cube/cube/+2", "ndim/4/cube/cube/2.0",
    "ndim/4/cube/cube/2e1", "ndim/4.0/cube/cube/2", "ndim/6/221/122/24", "ndim/6/122/221/25", "ndim/7/321/ball/20", "ndim/7/221/ball/20",
    "ndim/4/600cell/120cell/7", "ndim/4/24cell/ball/7", "ndim/9/ortho/simplex/20", "ndim/1000/cube/cube/2", "ndim/9999/cube/cube/2",
    "ndim/4/cube/cube/٢", "ndim/４/cube/cube/2", "polyhedra/cubintet/3", "", "ndim", "ndim////", "ndim/4/ball/ball/2",
    "ndim/4/cube/cube/2" + "/x".repeat(50), "x".repeat(101), "\u{1f600}".repeat(50) + "x", "\u{1f600}".repeat(51), "ndim/4/c\"ube/cube/2",
    42, null, true, ["ndim/4/cube/cube/2"], { id: "ndim/4/cube/cube/2" },
  ];
  for (const value of ids) add({ op: "id", group: "id", kind: "id", value });
  for (const d of ND_DIMENSIONS)
    for (const a of ndShapes(d)) for (const b of ndShapes(d)) add({ op: "bound", group: "bound", kind: "bound", d, piece: a, container: b });
  for (const [d, a, b] of [
    [4, "demi", "cube"],
    [5, "cube", "24cell"],
    [3, "cube", "cube"],
    [11, "ball", "ball"],
    [7, "421", "ball"],
  ] as [number, string, string][])
    add({ op: "bound", group: "bound", kind: "outside", d, piece: a, container: b });
  add({ op: "domain", group: "domain", kind: "domain" });

  // -- 3. the research records (data/ndim/configs: the regular polytopes of 4D to 6D), every one, and mutants
  const dir = join(root, "data", "ndim", "configs");
  let real = 0;
  for (const file of readdirSync(dir).sort()) {
    const m = /^(\d+)-([a-z0-9]+)-([a-z0-9]+)\.jsonl$/.exec(file);
    if (!m) throw new Error(`unexpected file ${file}`);
    const [d, piece, container] = [Number(m[1]), m[2], m[3]];
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { P: number; config: Cfg };
      const p = { d, piece, container, P: r.P };
      check("record", "real", p, r.config);
      // mutants of every third record
      if (real++ % 3 === 0) mutants("record-mutant", p, r.config, Math.floor(real / 3));
    }
  }
  // -- 4. the site's leading entries (the nightly snapshot), every one, with every mutant family in turn
  if (snapshot) {
    let n = 0;
    for await (const line of createInterface({ input: createReadStream(snapshot).pipe(createGunzip()), crlfDelay: Infinity })) {
      if (!line.startsWith('{"problem"')) continue;
      const r = JSON.parse(line.trim().replace(/,$/, "")) as { problem: string; P: number; config: Cfg };
      const id = parseNdId(r.problem);
      if (typeof id === "string") throw new Error(id);
      const p = { d: id.d, piece: id.piece, container: id.container, P: id.P };
      check("site", "real", p, r.config);
      for (let k = 0; k < 4; k++) mutants("site-mutant", p, r.config, n * 4 + k + n);
      n++;
    }
  }
  // -- 5. the package's test packings (every catalogue polytope, grids, pairs at 1.5e-7, adversarial pairs at 1e-9)
  const fixtures = JSON.parse(readFileSync(join(root, "packages", "ndim", "test", "fixtures", "packings.json"), "utf8")) as {
    fixtures: { name: string; problem: { d: number; piece: string; container: string }; config: Cfg }[];
  };
  const shapeOf = (code: string) => (code === "ball" ? "ball" : code.split(":")[1]);
  let fx = 0;
  for (const f of fixtures.fixtures) {
    const p = { d: f.problem.d, piece: shapeOf(f.problem.piece), container: shapeOf(f.problem.container), P: f.config.pieces.length };
    const limit = p.piece === "ball" ? 400 : ND_P_RANGE[p.d][1];
    if (p.P <= limit) {
      check("fixture", "fixture", p, f.config);
      if (p.P <= 32) mutants("fixture-mutant", p, f.config, fx++);
    } else {
      // more pieces than the server checks: refused by the size limit there, checked here with raised limits
      check("fixture", "too-many", p, f.config);
      add({ op: "core", group: "core", kind: "raised-limits", problem: f.problem, config: f.config, opts: { limits: { maxPieces: 128 } }, load: true });
    }
  }

  // -- 6. packings made here for every dimension and every ordered pair of its shapes: a random start of the
  //       search kernel, the same shrunk (overlaps and protrusions), and scaled to contact (tight and valid)
  for (const d of ND_DIMENSIONS) {
    const [lo, hi] = ND_P_RANGE[d];
    for (const piece of ndShapes(d))
      for (const container of ndShapes(d)) {
        await load({ d, piece, container });
        const nV = piece === ND_BALL ? 1 : polytopeInfo(ndCode(d, piece)).nV;
        const big = nV >= 200 || (d >= 8 && piece !== ND_BALL);
        const counts = [lo, 3 + Math.floor(rnd() * 4), hi];
        for (let c = 0; c < counts.length; c++) {
          const p = { d, piece, container, P: counts[c] };
          const k = ndKernel(p);
          const st = k.randomStart(rnd);
          let start: Cfg;
          try {
            start = k.toConfig(st) as Cfg;
          } catch {
            continue;
          }
          check("made", "start", p, start);
          const sh = k.clone(st);
          k.setSize(sh, st.size * (0.45 + 0.4 * rnd()));
          check("made", "shrunk", p, k.toConfig(sh));
          // scaled to contact: the smallest factor at which the validator accepts at tolerance 0 (bisection); the
          // costly problems get it for the small counts only
          const ops = ndCheckOps(p);
          if (ops > 4e8 || (big && c === 2 && rnd() < 0.6)) continue;
          const tight = toContact(p, start, ops > 5e7 ? 20 : 40);
          if (!tight) continue;
          check("made", "tight", p, tight);
          mutants("made-mutant", p, tight, Math.floor(rnd() * 14));
          if (c === 0) mutants("made-mutant", p, tight, Math.floor(rnd() * 14));
        }
      }
  }

  // -- 7. pairs at chosen separations, every polytope: a random pair moved along the line of centres to contact
  //       (by the package's pairSeparation), then by the target; and two copies in the same orientation, face to face
  const targets = [1e-7, 2e-9, 5e-10, 2e-11, 5e-12, 0, -5e-12, -2e-11, -5e-10, -9.9e-10, -1.01e-9, -2e-9, -3.3e-9, -1e-7, -1e-3, -0.2];
  for (const code of POLYTOPE_CODES) {
    const P = await loadPolytope(code);
    const d = P.d;
    const piece = code.split(":")[1];
    const p = { d, piece, container: "ball", P: 2 };
    const core = ndProblemOf(p);
    const heavy = P.nV >= 200 || d >= 8;
    // a random pair
    for (let rep = 0; rep < (heavy ? 1 : 2); rep++) {
      const a = randomPose(d, false, 0, 1.5);
      const b = randomPose(d, false, 0, 1.5);
      const u = Array.from({ length: d }, () => rnd() - 0.5);
      const ul = Math.hypot(...u);
      const at = (t: number) => b.map((v, k) => (k < d ? (u[k] / ul) * t : v));
      let far = 2 * P.circumradius + 0.1;
      let near = 0;
      for (let it = 0; it < 60; it++) {
        const mid = 0.5 * (near + far);
        if (pairSeparation(core, a, at(mid)) > 0) far = mid;
        else near = mid;
      }
      for (const t of heavy ? targets.filter((_, i) => i % 2 === rep % 2 || i > 11) : targets) {
        const pieces = [a, at(far + t)];
        check("pair", `random-pair ${t}`, p, { s: tightScale(core, pieces) + 1e-6, pieces });
      }
    }
    // face to face: the second copy moved along the first facet's normal by twice its offset plus the target
    const base = randomPose(d, false, 0, rnd() < 0.5 ? 0 : 0.7);
    const flipless = base.slice(0, d + nParams(d));
    const R = new Float64Array(d * d);
    {
      // the rotation of the pose, by the package's own reader
      const q = validateNd(core, { s: 100, pieces: [flipless] });
      if (!q.valid) throw new Error("the base pose is not valid");
    }
    R.set(cayleyMatrix(flipless.slice(d), d, 0));
    const n0 = Array.from({ length: d }, (_, i) => {
      let s = 0;
      for (let j = 0; j < d; j++) s += R[i * d + j] * P.N[j];
      return s;
    });
    for (const t of heavy ? targets.filter((_, i) => i % 2 === 0) : targets) {
      const shift = 2 * P.b[0] + t;
      const pieces = [flipless, flipless.map((v, k) => (k < d ? v + n0[k] * shift : v))];
      check("pair", `face-to-face ${t}`, p, { s: tightScale(core, pieces) + 1e-6, pieces });
    }
    // two copies exactly on each other, and nearly
    check("pair", "coincident", p, { s: 2 * P.circumradius + 1, pieces: [flipless, flipless.slice()] });
    check("pair", "coincident", p, { s: 2 * P.circumradius + 1, pieces: [flipless, flipless.map((v, k) => (k === 0 ? v + 1e-9 : v))] });
  }

  // -- 8. random configurations of random problems (most overlap or stick out), and malformed ones of every kind
  for (let r = 0; r < 420; r++) {
    const d = pick(ND_DIMENSIONS);
    const piece = pick(ndShapes(d));
    const container = pick(ndShapes(d));
    await load({ d, piece, container });
    const ball = piece === ND_BALL;
    const nV = ball ? 1 : polytopeInfo(ndCode(d, piece)).nV;
    const top = ND_P_RANGE[d][1];
    const P = nV >= 200 || d >= 8 ? 2 + Math.floor(rnd() * 3) : 2 + Math.floor(rnd() * rnd() * (top - 1));
    const rc = ball ? 0.5 : polytopeInfo(ndCode(d, piece)).circumradius;
    const spread = rc * (0.6 + 2.2 * rnd()) * Math.pow(P, 1 / d);
    const pieces = Array.from({ length: P }, () => randomPose(d, ball, spread, rnd() < 0.2 ? 32 : 1.2));
    const core = ndProblemOf({ d, piece, container });
    const s = tightScale(core, pieces) * (rnd() < 0.5 ? 1 + 1e-7 : 0.7 + 0.5 * rnd());
    check("random", "random", { d, piece, container, P }, { s, pieces });
  }
  for (let r = 0; r < 320; r++) {
    const d = pick(ND_DIMENSIONS);
    const piece = pick(ndShapes(d).filter((x) => x === ND_BALL || polytopeInfo(ndCode(d, x)).nV < 200));
    const container = pick(["cube", "ball", "simplex"]);
    const P = 2 + Math.floor(rnd() * 5);
    const ball = piece === ND_BALL;
    const pieces = Array.from({ length: P }, () => randomPose(d, ball, 3, 1));
    check("malformed", "malformed", { d, piece, container, P }, malformed({ d, piece, container, P }, { s: 20, pieces }, r));
  }

  // -- 9. the work cap, the error caps and the core's options
  for (const d of ND_DIMENSIONS)
    for (const kind of ["ball", "cube"]) {
      // the grid of the package's tests: P pieces of the 2 x ... x 2 grid, a hair apart
      const P = Math.min(2 ** d, ND_P_RANGE[d][1]);
      const gap = 1e-7;
      const pieces: number[][] = [];
      for (let k = 0; k < P; k++) {
        const t = Array.from({ length: d }, (_, i) => (((k >> i) & 1) - 0.5) * (1 + gap));
        pieces.push(kind === "ball" ? t : [...t, ...new Array(nParams(d)).fill(0), 0]);
      }
      const p = { d, piece: kind, container: "cube", P };
      const config = { s: 2 + 2 * gap, pieces };
      check("cap", "grid", p, config);
      for (const [capMs, tick, maxErrors] of [
        [5, 1, 20],
        [5, 0.3, 5],
        [0, 1, 5],
        [1e9, 1, 5],
        [40.5, 0.7, 5],
        [8000, 250, 5],
      ])
        add({ op: "cap", group: "cap", kind: "cap", ...p, config, tol: 1e-9, maxErrors, capMs, tick });
      // piled up: every piece at the origin
      const piled = { s: 2, pieces: pieces.map((q) => q.map((v, k) => (k < d ? 0 : v))) };
      for (const maxErrors of [0, 1, 2, 5, 20])
        add({ op: "cap", group: "cap", kind: "max-errors", ...p, config: piled, tol: 1e-9, maxErrors, capMs: 1e9, tick: 1 });
      add({ op: "cap", group: "cap", kind: "max-errors", ...p, config, tol: 1e-9, maxErrors: 0, capMs: 1e9, tick: 1 });
      const core = ndProblemOf(p);
      for (const opts of [
        {},
        { maxErrors: 3 },
        { maxPairErrors: 1 },
        { maxPairErrors: 7, maxErrors: 9 },
        { tol: 0 },
        { tol: 1e-6 },
        { deadline: 0 },
        { limits: { maxPieces: 3 } },
        { limits: { maxPieces: 1e9, maxVertexWork: 100, maxWallWork: 50 } },
        { limits: { maxVertexWork: 1e12, maxWallWork: 1e12 } },
      ]) {
        add({ op: "core", group: "core", kind: "options", problem: core, config, opts, load: true });
        add({ op: "core", group: "core", kind: "options", problem: core, config: piled, opts, load: true });
      }
    }
  // problems that are not well formed, sizes above the limits
  const two = (d: number, ball: boolean) => ({ s: 30, pieces: [randomPose(d, ball, 3, 1), randomPose(d, ball, 3, 1)] });
  for (const problem of [
    { d: 3, piece: "4:cube", container: "4:cube" },
    { d: 11, piece: "ball", container: "ball" },
    { d: 4, piece: "5:cube", container: "4:cube" },
    { d: 5, piece: "5:cube", container: "4:24cell" },
    { d: 5, piece: "5:nope", container: "sphere" },
    { d: 4, piece: "4:demi", container: 'a"b' },
    { d: 6, piece: "ball", container: "6:421" },
  ])
    add({ op: "core", group: "core", kind: "bad-problem", problem, config: two(problem.d, problem.piece === "ball"), opts: {}, load: true });
  for (const [code, cont, n, limits] of [
    ["4:120cell", "4:600cell", 41, {}],
    ["4:120cell", "4:600cell", 209, {}],
    ["4:120cell", "ball", 250, { maxPieces: 256 }],
    ["4:120cell", "4:600cell", 256, { maxPieces: 1000, maxVertexWork: 1e9 }],
    ["8:421", "8:421", 43, { maxPieces: 64 }],
    ["8:421", "8:421", 21, {}],
    ["10:cube", "10:ortho", 60, { maxPieces: 64 }],
    ["ball", "10:ortho", 401, {}],
    ["ball", "ball", 1025, { maxPieces: 5000 }],
    ["ball", "ball", 1024, { maxPieces: 5000 }],
    ["5:simplex", "5:cube", 33, {}],
    ["5:simplex", "5:cube", 32, {}],
  ] as [string, string, number, Record<string, number>][]) {
    const d = code === "ball" ? (cont === "ball" ? 4 : Number(cont.split(":")[0])) : Number(code.split(":")[0]);
    const ball = code === "ball";
    const rc = ball ? 0.5 : polytopeInfo(code).circumradius;
    const pieces = Array.from({ length: n }, (_, i) => {
      const q = randomPose(d, ball, 0, 0.5);
      q[0] = (i % 16) * 2.5 * rc;
      q[1] = Math.floor(i / 16) * 2.5 * rc;
      return q;
    });
    add({ op: "core", group: "core", kind: "size-limits", problem: { d, piece: code, container: cont }, config: { s: 400, pieces }, opts: { limits }, load: true });
    if (code !== "ball" || n <= 9999) {
      const shape = (c: string) => (c === "ball" ? c : c.split(":")[1]);
      check("cap", "size-limits", { d, piece: shape(code), container: shape(cont), P: n }, { s: 400, pieces });
    }
  }
  // shapes that the dimension does not have (the server's id parser refuses them first): the polytope does not load
  for (const [d, a, b] of [
    [5, "24cell", "cube"],
    [9, "cube", "421"],
    [4, "demi", "demi"],
    [7, "ball", "221"],
  ] as [number, string, string][])
    check("cap", "no-such-shape", { d, piece: a, container: b, P: 2 }, two(d, a === "ball"));
  // configurations that are not well formed, given to the core itself (the server's parser refuses them first)
  for (const d of [4, 7, 10])
    for (const ball of [false, true]) {
      const problem = { d, piece: ball ? "ball" : `${d}:simplex`, container: `${d}:cube` };
      const m = d + nParams(d);
      const good = () => Array.from({ length: 6 }, () => randomPose(d, ball, 2, 1).slice(0, ball ? d : m));
      const variants: [Record<string, unknown>, Cfg][] = [
        [{}, { s: 30, pieces: [] }],
        [{}, { s: 0, pieces: [] }],
        [{}, { s: 0, pieces: good() }],
        [{}, { s: -3, pieces: good() }],
        [{}, { s: 1e6 + 1, pieces: good() }],
        [{}, { s: 1e6, pieces: good() }],
        [{}, { s: 30, pieces: good().map((q, i) => (i % 2 ? q.slice(0, d - 1) : q)) }],
        [{}, { s: 30, pieces: good().map((q, i) => (i === 3 ? [...q, 0, 0, 0] : q)) }],
        [{}, { s: 30, pieces: good().map((q, i) => (i === 1 ? q.map((v, k) => (k === 0 ? 10001 : v)) : q)) }],
        [{}, { s: -1, pieces: good().map((q, i) => (i === 5 ? q.map((v, k) => (k === d - 1 ? -1e4 - 1e-9 : v)) : q)) }],
        [{}, { s: 30, pieces: Array.from({ length: 30 }, () => [1, 2]) }],
        [{ maxErrors: 2 }, { s: 30, pieces: Array.from({ length: 30 }, () => [1, 2]) }],
        [{ maxErrors: 2, limits: { maxPieces: 4 } }, { s: -30, pieces: Array.from({ length: 30 }, () => [1, 2]) }],
      ];
      if (!ball)
        variants.push(
          [{}, { s: 30, pieces: good().map((q, i) => (i === 2 ? q.map((v, k) => (k === d ? 32.5 : v)) : q)) }],
          [{}, { s: 30, pieces: good().map((q, i) => (i === 2 ? q.map((v, k) => (k === m - 1 ? -32 : v)) : q)) }],
          [{}, { s: 30, pieces: good().map((q, i) => [...q, [1, 2 ** d, -2, 0.5, 3, 2 ** d - 1][i]]) }],
          [{}, { s: 30, pieces: good().map((q, i) => [...q, [0, 3, 5, 6, 9, 10][i]]) }],
        );
      for (const [opts, config] of variants) add({ op: "core", group: "core", kind: "bad-config", problem, config, opts, load: true });
    }

  // -- 10. pairs whose overlap is the tolerance itself, to the last digits: two copies face to face, overlapping by
  //        exactly 1e-9 or 1e-11 in exact arithmetic, in several orientations. The depth found is the tolerance up
  //        to rounding, so the certified bounds fall on either side of it: accepted, refused as an overlap, or
  //        "could not be shown to be separated" (the bounds straddle the tolerance).
  for (const code of POLYTOPE_CODES) {
    const P = await loadPolytope(code);
    const d = P.d;
    const p = { d, piece: code.split(":")[1], container: "ball", P: 2 };
    const core = ndProblemOf(p);
    const heavy = P.nV >= 200 || d >= 8;
    for (let rep = 0; rep < (heavy ? 1 : 3); rep++) {
      const base = randomPose(d, false, 0.3, 0.2 + 0.6 * rnd()).slice(0, d + nParams(d));
      const R = cayleyMatrix(base.slice(d), d, 0);
      const f = Math.floor(rnd() * P.nF);
      const n0 = Array.from({ length: d }, (_, i) => {
        let s = 0;
        for (let j = 0; j < d; j++) s += R[i * d + j] * P.N[f * d + j];
        return s;
      });
      for (const t of [-1e-9, -1e-11]) {
        const shift = 2 * P.b[f] + t;
        const pieces = [base, base.map((v, k) => (k < d ? v + n0[k] * shift : v))];
        check("pair", `at-tolerance ${t}`, p, { s: tightScale(core, pieces) + 1e-6, pieces });
      }
    }
  }
}

/**
 * The configuration scaled (centres and container together) by the smallest factor at which the validator accepts it at
 * tolerance 0, by bisection: a valid packing with a contact. Null when no factor up to 64 is valid.
 */
function toContact(p: Prob, cfg: Cfg, rounds: number): Cfg | null {
  const d = p.d;
  const at = (f: number): Cfg => ({ s: cfg.s * f, pieces: cfg.pieces.map((q) => q.map((v, k) => (k < d ? v * f : v))) });
  const ok = (f: number) => ndCheck(p, at(f), 0, 1).length === 0;
  let hi = 1;
  while (!ok(hi)) {
    hi *= 1.6;
    if (hi > 64) return null;
  }
  let lo = hi;
  for (let k = 0; k < 12 && ok(lo); k++) {
    hi = lo;
    lo *= 0.7;
  }
  if (lo === hi || ok(lo)) return at(hi);
  for (let k = 0; k < rounds && hi - lo > 1e-13 * hi; k++) {
    const mid = 0.5 * (lo + hi);
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return at(hi);
}

// ------------------------------------------------------------------------------------------------- the results
/** A number as text: every double has its own (JSON has no Infinity). */
const N = (x: number | null | undefined): string | null => (x === null || x === undefined ? null : String(x));
const validation = (v: NdValidation) => ({
  valid: v.valid,
  score: N(v.score),
  reasons: v.reasons,
  minWallGap: N(v.minWallGap),
  minPairSep: N(v.minPairSep),
  worstPair: v.worstPair,
  pairsTested: v.pairsTested,
});
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** FNV-1a (64 bits) of the bytes of the doubles, little-endian: equal for equal arrays, bit for bit. */
function hash(a: Float64Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i])) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
}
const TOLS = [1e-9, 1e-11];

async function reference(c: Case): Promise<Record<string, unknown>> {
  switch (c.op) {
    case "check": {
      const p = { d: c.d, piece: c.piece, container: c.container, P: c.P } as NdProblemId;
      let parsed;
      try {
        parsed = parseNdConfig(p, JSON.parse(JSON.stringify(c.raw)));
      } catch (e) {
        return { thrown: message(e) };
      }
      if (!parsed.ok) return { parse: { ok: false, malformed: parsed.malformed, errors: parsed.errors } };
      const out: Record<string, unknown> = {
        parse: { ok: true, score: N(parsed.score), s: N(parsed.config.s), pieces: parsed.config.pieces.map((q) => q.map(N)) },
      };
      try {
        await loadNdProblem(p);
      } catch (e) {
        out.load = message(e);
        return out;
      }
      out.checks = TOLS.map((tol) => {
        try {
          return {
            reasons: ndCheck(p, parsed.config, tol, NDIM_MAX_REASONS),
            core: validation(validateNd(ndProblemOf(p), parsed.config, { tol, maxErrors: NDIM_MAX_REASONS })),
          };
        } catch (e) {
          return { thrown: message(e) };
        }
      });
      return out;
    }
    case "cap": {
      const p = { d: c.d, piece: c.piece, container: c.container, P: c.P } as NdProblemId;
      await loadNdProblem(p);
      let t = 0;
      const tick = c.tick as number;
      const steps = ndCheckSteps(p, c.config as NdConfigShape, c.tol as number, c.maxErrors as number, c.capMs as number, () => {
        const v = t;
        t += tick;
        return v;
      });
      let yields = 0;
      for (;;) {
        const r = steps.next();
        if (r.done) return { reasons: r.value, yields };
        yields++;
      }
    }
    case "core": {
      const problem = c.problem as { d: number; piece: string; container: string };
      if (c.load)
        for (const code of [problem.piece, problem.container]) {
          try {
            if (code !== "ball") await loadPolytope(code);
          } catch {
            // an unknown code: the validator says so
          }
        }
      const o = c.opts as Record<string, unknown>;
      try {
        return { core: validation(validateNd(problem, c.config as Cfg, o)) };
      } catch (e) {
        return { thrown: message(e) };
      }
    }
    case "id": {
      const r = parseNdId(c.value);
      if (typeof r === "string") return { error: r };
      return { id: r.id, d: r.d, piece: r.piece, container: r.container, P: r.P, inRange: ndInRange(r.d, r.P) };
    }
    case "bound": {
      const { d, piece, container } = c as unknown as { d: number; piece: string; container: string };
      const rows: unknown[] = [];
      for (let P = 1; P <= ND_MAX_P + 1; P++) {
        const id = { d, piece, container, P };
        const dom = ndimDomain.bound({ fields: { d, piece, container, P }, P });
        let lower: unknown;
        try {
          const b = ndLowerBound(id, P);
          const e = ndBoundEntry(id, P);
          lower = { value: N(b.value), kind: b.kind, entry: N(e.value), label: e.label };
        } catch (e) {
          lower = { thrown: message(e) };
        }
        rows.push({
          P,
          inRange: ndInRange(d, P),
          domain: dom === undefined ? null : { value: N(dom.value), label: dom.label },
          lower,
          ops: N(ndCheckOps(id)),
          heavy: ndIsHeavy(id),
        });
      }
      return { rows };
    }
    case "domain":
      return {
        info: JSON.stringify(ndimDomain.info),
        samples: [0, 1, 7, 50, 245, 246, 1000, 7000].map((n) => ndimDomain.sample(n)),
        constants: { ND_MAX_P, NDIM_MAX_REASONS, NDIM_CHECK_MS, NDIM_HEAVY_OPS, ND_ID_FORM, ND_SHAPE_NAMES, ND_BALL },
        codes: POLYTOPE_CODES,
      };
    case "table": {
      const code = c.code as string;
      const out: Record<string, unknown> = { loadedBefore: isLoaded(code) };
      if (!c.load) {
        try {
          getPolytope(code);
          out.get = "ok";
        } catch (e) {
          out.get = message(e);
        }
        return out;
      }
      try {
        const P = await loadPolytope(code);
        out.polytope = {
          code: P.code, d: P.d, name: P.name, title: P.title, nV: P.nV, nE: P.nE, nF: P.nF,
          inradius: N(P.inradius), circumradius: N(P.circumradius), volume: N(P.volume),
          V: hash(P.V), N: hash(P.N), b: hash(P.b), lengths: [P.V.length, P.N.length, P.b.length],
        };
        out.loadedAfter = isLoaded(code);
      } catch (e) {
        out.thrown = message(e);
      }
      return out;
    }
    case "load": {
      try {
        await loadNdProblem(c as unknown as NdProblemId);
        return { ok: true };
      } catch (e) {
        return { thrown: message(e) };
      }
    }
  }
  throw new Error(`unknown op ${c.op}`);
}

// ----------------------------------------------------------------------------------------------------- main
const casesPath = join(outDir, "cases.jsonl");
if (buildArg) {
  const t0 = performance.now();
  await build();
  writeFileSync(casesPath, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`${cases.length} cases built in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(0);
}
if (!existsSync(casesPath)) throw new Error(`${casesPath} is missing: build the cases first (--build)`);
for (const line of readFileSync(casesPath, "utf8").split("\n")) if (line) cases.push(JSON.parse(line));
console.log(`${cases.length} cases read from ${casesPath}`);
if (fixturesArg) {
  // small cases spread over the operations and kinds, with the TypeScript's results of the last run
  const results = readFileSync(join(outDir, "ref.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; answer: unknown });
  if (results.length !== cases.length) throw new Error("ref.jsonl is not of these cases: run the reference first");
  const want = Number(fixturesArg[0]);
  // by operation and group, then by kind: each round takes one case of every group, of another kind each time
  const groups = new Map<string, Map<string, number[]>>();
  cases.forEach((c, i) => {
    // not the cases that depend on what was loaded before them, nor the large ones
    if (JSON.stringify(c).length + JSON.stringify(results[i]).length > 9000 || c.group === "unloaded" || (c.op === "table" && !c.load)) return;
    const g = `${c.op}/${c.group}`;
    const kinds = groups.get(g) ?? new Map<string, number[]>();
    groups.set(g, kinds);
    const kind = String(c.kind).split(" ")[0];
    kinds.set(kind, [...(kinds.get(kind) ?? []), i]);
  });
  const chosen: number[] = [];
  for (let round = 0; chosen.length < want && round < 200; round++) {
    let g = 0;
    for (const kinds of groups.values()) {
      if (chosen.length >= want) break;
      const lists = [...kinds.values()];
      const list = lists[(round + 3 * g++) % lists.length];
      // spread over the list: another part of it each time (the cases of a kind go dimension by dimension)
      const i = list[Math.floor(((0.35 + (round + g) * 0.6180339887) % 1) * list.length)];
      if (!chosen.includes(i)) chosen.push(i);
    }
  }
  // and every kind of reason the TypeScript gave anywhere: the smallest case that has one not yet among the chosen
  const NUMBER = /-?Infinity|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;
  const reasonsOf = (i: number): string[] => {
    const a = results[i].answer as {
      checks?: { reasons?: string[] }[];
      parse?: { errors?: string[] };
      core?: { reasons: string[] };
      reasons?: string[];
      thrown?: string;
      load?: string;
    };
    const all = [...(a.checks ?? []).flatMap((c) => c.reasons ?? []), ...(a.parse?.errors ?? []), ...(a.core?.reasons ?? []), ...(a.reasons ?? [])];
    if (a.thrown) all.push(`thrown: ${a.thrown}`);
    if (a.load) all.push(`load: ${a.load}`);
    return all.map((r) => r.replace(NUMBER, "#"));
  };
  const usable = [...groups.values()].flatMap((kinds) => [...kinds.values()].flat()).sort((x, y) => JSON.stringify(cases[x]).length - JSON.stringify(cases[y]).length);
  const have = new Set(chosen.flatMap(reasonsOf));
  let added = 0;
  for (const i of usable) {
    const fresh = reasonsOf(i).filter((r) => !have.has(r));
    if (!fresh.length) continue;
    for (const r of fresh) have.add(r);
    chosen.push(i);
    added++;
  }
  console.log(`${added} cases added for the reasons the others did not give; ${have.size} kinds of reasons in all`);
  chosen.sort((a, b) => a - b);
  const lines = chosen.map((i) => JSON.stringify({ case: cases[i], ref: results[i].answer }));
  writeFileSync(fixturesArg[1], lines.join("\n") + "\n");
  // the domain's answer is too long for a fixture (its samples): what /api/spaces says of the domain goes beside them
  writeFileSync(join(dirname(fixturesArg[1]), "domain-info.json"), JSON.stringify(ndimDomain.info) + "\n");
  console.log(`${lines.length} fixtures of ${groups.size} groups written to ${fixturesArg[1]} (${lines.join("\n").length} bytes), and domain-info.json`);
  process.exit(0);
}
const ref: string[] = [];
const results: Record<string, unknown>[] = [];
const t1 = performance.now();
for (const c of cases) {
  // through JSON, as the Rust side reads the case
  const r = await reference(JSON.parse(JSON.stringify(c)));
  results.push(r);
  ref.push(JSON.stringify({ id: c.id, answer: r }));
}
writeFileSync(join(outDir, "ref.jsonl"), ref.join("\n") + "\n");
console.log(`reference results in ${((performance.now() - t1) / 1000).toFixed(0)} s`);

// timing: the check as the server calls it (ndCheckSteps to its end at 1e-9, NDIM_MAX_REASONS), best of 5 passes
const best: (number | null)[] = cases.map(() => null);
const parsedOf = (c: Case) => {
  if (c.op !== "check") return null;
  const p = { d: c.d, piece: c.piece, container: c.container, P: c.P } as NdProblemId;
  const r = parseNdConfig(p, c.raw);
  return r.ok ? { p, config: r.config } : null;
};
for (let pass = 0; pass < 5; pass++)
  for (let i = 0; i < cases.length; i++) {
    const q = parsedOf(cases[i]);
    if (!q) continue;
    const t = process.hrtime.bigint();
    ndCheck(q.p, q.config, 1e-9, NDIM_MAX_REASONS);
    const dt = Number(process.hrtime.bigint() - t);
    if (best[i] === null || dt < (best[i] as number)) best[i] = dt;
  }
writeFileSync(join(outDir, "ts-times.json"), JSON.stringify(best));
console.log(`timings in ${((performance.now() - t1) / 1000).toFixed(0)} s (with the results)`);
