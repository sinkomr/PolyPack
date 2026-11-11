// Builds the cases of the comparison of the Rust port of the surface family (native/surface) with
// its TypeScript source (packages/surface), and writes the TypeScript's verdicts and timings.
//
//   node --import tsx native/tools/surface-ref.mts OUTDIR [--snapshot space-surface.json.gz] [--fixtures DIR] [--no-times]
//   cargo run --release -p polypack-surface --example surfacediff -- cases|solids|domain OUTDIR
//   node native/tools/surface-compare.mjs OUTDIR
//
// It writes into OUTDIR:
//   cases.jsonl           one case per line: {id, kind, origin, solid, mode, N, s, pieces, opts}; a number JSON cannot
//                         write is the string "NaN", "Infinity", "-Infinity" or "-0"
//   ref.jsonl             {id, r: [verdict at tol 1e-9, verdict at tol 1e-11]}; a verdict is
//                         {ok, errors, minPairSep, minConeSep, minWallSep} (numbers as String(x)) or
//                         {throw: "ChainLimitError" | "Error", message}
//   ts-times.json         best of five timings of validate at 1e-9 per case, in nanoseconds
//   solids-ref.jsonl      every solid of the family with all its fields (getSolid)
//   domain-probes.json    the ids whose bound is asked and the limits of the samples
//   domain-ref.json       JSON.stringify(surfaceDomain.info) and the bounds of the probes
//   sample-<limit>.ref.txt  surfaceDomain.sample(limit)
//   bounds-ref.f64        surfaceBounds(solid, N, P) (area, one) of every solid, N and P, little-endian doubles
// and with --fixtures DIR the fixtures of `cargo test -p polypack-surface` (cases.jsonl, solids.json, domain.json).
//
// Cases: research records (data/surface/records.json), leading entries of the site (the nightly snapshot), mutants of
// both (a piece moved into another, the solid shrunk by 1e-10, 3e-9 and 1e-6, a piece outside its face, a piece on a
// cone point, malformed fields, a solid far too small, all pieces in one place), random configurations on every solid,
// single pieces on small solids (pieces that wrap onto themselves), the error limit, the chain limit, the chain depth
// limit, scaled pieces, centres exactly on the boundary of their face, and disks on solids about one disk wide. Every case is checked at both tolerances with the server's options (maxErrors 20,
// maxChains 600) unless its `opts` say otherwise.
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import {
  ALL_SOLID_NAMES,
  ChainLimitError,
  SURFACE_MAX_P,
  SURFACE_NS,
  type Mode,
  type SolidName,
  type SurfaceConfig,
  faceDepth,
  faceVertex,
  getSolid,
  surfaceBound,
  surfaceBounds,
  surfaceDomain,
  validate,
  validateAsync,
} from "../../packages/surface/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: surface-ref.mts OUTDIR [--snapshot file.json.gz] [--fixtures DIR] [--no-times]");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const snapshot = flag("--snapshot");
const fixturesDir = flag("--fixtures");
const noTimes = args.includes("--no-times");
mkdirSync(outDir, { recursive: true });

// a fixed generator, so that the cases are the same on every run
let seed = 20261110;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const int = (n: number) => Math.floor(rnd() * n);
const pick = <T,>(list: readonly T[]) => list[int(list.length)];

type Piece = { face: number; x: number; y: number; theta: number };
type Opts = { maxErrors: number | null; maxChains: number | null; scale: number | null };
type Case = { id: number; kind: string; origin: string; solid: string; mode: string; N: number; s: number; pieces: Piece[]; opts: Opts };
const SERVER: Opts = { maxErrors: 20, maxChains: 600, scale: null };
const cases: Case[] = [];
const add = (kind: string, origin: string, solid: string, mode: string, N: number, s: number, pieces: Piece[], opts: Opts = SERVER) =>
  cases.push({ id: cases.length, kind, origin, solid, mode, N, s, pieces: pieces.map((p) => ({ ...p })), opts });

// ---- real packings -------------------------------------------------------------------------------------------------
type Real = { id: string; solid: SolidName; mode: Mode; N: number; s: number; pieces: Piece[] };
const reals: Real[] = [];
const records = JSON.parse(readFileSync(resolve(root, "data/surface/records.json"), "utf8")).records as any[];
records.forEach((r, i) => {
  // every second record: 1,019 of the 2,038, every solid, mode and shape of the tables
  if (i % 2 === 0) reals.push({ id: "record:" + r.id, solid: r.solid, mode: r.mode, N: r.N, s: r.s, pieces: r.pieces });
});
const nRecords = reals.length;
if (snapshot) {
  const bySolid = new Map<string, any[]>();
  for await (const line of createInterface({ input: createReadStream(snapshot).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (!line.startsWith('{"problem"')) continue;
    const r = JSON.parse(line.trim().replace(/,$/, ""));
    const [, solid] = r.problem.split("/");
    if (!bySolid.has(solid)) bySolid.set(solid, []);
    bySolid.get(solid)!.push(r);
  }
  for (const solid of ALL_SOLID_NAMES) {
    const list = bySolid.get(solid) ?? [];
    const parts = (r: any) => r.problem.split("/") as string[];
    const take = (r: any) => {
      const [, , mode, N] = parts(r);
      reals.push({ id: "site:" + r.problem, solid, mode: mode as Mode, N: Number(N), s: r.config.s, pieces: r.config.pieces });
    };
    // every nofold entry (there are few), and of the fold ones about ten per solid spread over N and P, with the disks'
    // smallest and largest P
    const nofold = list.filter((r) => parts(r)[2] === "nofold");
    const fold = list.filter((r) => parts(r)[2] === "fold").sort((a, b) => Number(parts(a)[3]) - Number(parts(b)[3]) || a.P - b.P);
    nofold.forEach(take);
    const step = Math.max(1, Math.ceil(fold.length / 10));
    const chosen = new Set<any>();
    fold.forEach((r, i) => {
      if (i % step === step >> 1) chosen.add(r);
    });
    const disks = fold.filter((r) => parts(r)[3] === "0");
    if (disks.length) {
      chosen.add(disks[0]);
      chosen.add(disks[disks.length - 1]);
    }
    fold.filter((r) => chosen.has(r)).forEach(take);
  }
}
const nSite = reals.length - nRecords;

const MALFORMED: [string, (c: Real) => Partial<Case>][] = [
  ["N=2", () => ({ N: 2 })],
  ["N=3.5", () => ({ N: 3.5 })],
  ["N=-4", () => ({ N: -4 })],
  ["N=NaN", () => ({ N: NaN })],
  ["s=0", () => ({ s: 0 })],
  ["s=-1", () => ({ s: -1 })],
  ["s=NaN", () => ({ s: NaN })],
  ["s=Infinity", () => ({ s: Infinity })],
  ["no pieces", () => ({ pieces: [] })],
  ["unknown solid", () => ({ solid: "hypercube" })],
  ["unknown solid, bad N, bad s", () => ({ solid: "Cube", N: 1, s: -2 })],
  ["bad N, s and pieces", () => ({ N: 1, s: 0, pieces: [] })],
  ["face=-1", (c) => ({ pieces: c.pieces.map((p, i) => (i === 0 ? { ...p, face: -1 } : p)) })],
  ["face=F", (c) => ({ pieces: c.pieces.map((p, i) => (i === c.pieces.length - 1 ? { ...p, face: getSolid(c.solid).F } : p)) })],
  ["face=1.5", (c) => ({ pieces: c.pieces.map((p, i) => (i === 0 ? { ...p, face: 1.5 } : p)) })],
  ["face=NaN", (c) => ({ pieces: c.pieces.map((p, i) => (i === 0 ? { ...p, face: NaN } : p)) })],
  ["x=NaN", (c) => ({ pieces: c.pieces.map((p, i) => (i === 0 ? { ...p, x: NaN } : p)) })],
  ["y=Infinity", (c) => ({ pieces: c.pieces.map((p, i) => (i === 0 ? { ...p, y: Infinity } : p)) })],
  ["theta=-Infinity", (c) => ({ pieces: c.pieces.map((p) => ({ ...p, theta: -Infinity })) })],
  ["bad face and bad x", (c) => ({ pieces: c.pieces.map((p, i) => (i % 2 ? { ...p, x: NaN } : { ...p, face: 1e9 })) })],
  // not malformed for the validator: a mode that is not "fold" is nofold, and -0 is 0
  ["mode=folded", () => ({ mode: "folded" as Mode })],
  ["mode empty", () => ({ mode: "" as Mode })],
  ["face=-0", (c) => ({ pieces: c.pieces.map((p) => ({ ...p, face: p.face === 0 ? -0 : p.face })) })],
  ["N=-0 for disks", (c) => ({ N: c.N === 0 ? -0 : c.N })],
];

reals.forEach((c, index) => {
  const real = c.id.startsWith("record") ? "record" : "site";
  add(real, c.id, c.solid, c.mode, c.N, c.s, c.pieces);
  const P = c.pieces.length;
  const scaled = (f: number): Piece[] => c.pieces.map((p) => ({ ...p, x: p.x * f, y: p.y * f }));
  const S = getSolid(c.solid);
  switch (index % 8) {
    case 0:
      if (P >= 2)
        add("overlap", c.id, c.solid, c.mode, c.N, c.s, c.pieces.map((p, i) => (i === 1 ? { ...p, face: c.pieces[0].face, x: c.pieces[0].x + 0.01, y: c.pieces[0].y } : p)));
      break;
    case 1:
      // the same configuration on a solid smaller by eps: inside the tolerance and at it
      add("shrink-1e-10", c.id, c.solid, c.mode, c.N, c.s * (1 - 1e-10), scaled(1 - 1e-10));
      add("shrink-3e-9", c.id, c.solid, c.mode, c.N, c.s * (1 - 3e-9), scaled(1 - 3e-9));
      break;
    case 2:
      add("shrink-1e-6", c.id, c.solid, c.mode, c.N, c.s * (1 - 1e-6), scaled(1 - 1e-6));
      break;
    case 3: {
      // a piece's centre outside its face: just outside, far outside, or at the largest coordinate the server accepts
      const how = (index >> 3) % 3;
      const k = int(P);
      const [vx, vy] = faceVertex(S, c.s, c.pieces[k].face, 0);
      add("outside", c.id, c.solid, c.mode, c.N, c.s, c.pieces.map((p, i) => (i !== k ? p : how === 0 ? { ...p, x: vx * 1.02, y: vy * 1.02 } : how === 1 ? { ...p, x: p.x + 3 * c.s } : { ...p, x: 1e6, y: -1e6 })));
      break;
    }
    case 4: {
      // a piece's centre close to a corner of its face: a cone point inside the piece (fold), the piece out of its face (nofold)
      const k = int(P);
      const [vx, vy] = faceVertex(S, c.s, c.pieces[k].face, int(S.sides[c.pieces[k].face]));
      const pull = pick([0.999, 0.95, 0.8]);
      add("corner", c.id, c.solid, c.mode, c.N, c.s, c.pieces.map((p, i) => (i === k ? { ...p, x: vx * pull, y: vy * pull } : p)));
      break;
    }
    case 5: {
      const [what, change] = MALFORMED[(index >> 3) % MALFORMED.length];
      const m = { ...c, ...change(c) } as Real;
      add("malformed", `${c.id} (${what})`, m.solid, m.mode, m.N, m.s, m.pieces);
      break;
    }
    case 6: {
      // a solid far too small for its pieces: many overlaps, and in fold mode the chain limit
      const f = pick([0.5, 0.3, 0.15, 0.08, 0.04, 0.01]);
      add("tiny-solid", c.id, c.solid, c.mode, c.N, c.s * f, scaled(f));
      break;
    }
    case 7:
      // every piece where the first one is: more overlaps than the error limit
      if (P >= 2) add("coincident", c.id, c.solid, c.mode, c.N, c.s, c.pieces.map(() => ({ ...c.pieces[0] })));
      break;
  }
});

// ---- random configurations -----------------------------------------------------------------------------------------
const randomN = () => {
  const u = rnd();
  return u < 0.3 ? 0 : u < 0.7 ? 3 + int(6) : 9 + int(92);
};
const randomPoint = (solid: SolidName, s: number, face: number, inside: boolean): [number, number] => {
  const S = getSolid(solid);
  let R = 0;
  for (let k = 0; k < S.sides[face]; k++) R = Math.max(R, Math.hypot(...faceVertex(S, s, face, k)));
  for (let tries = 0; ; tries++) {
    const x = (2 * rnd() - 1) * R;
    const y = (2 * rnd() - 1) * R;
    if (!inside || tries > 200 || faceDepth(S, s, face, x, y) >= 0) return [x, y];
  }
};
for (let i = 0; i < 1500; i++) {
  // the first 141 take the solids in turn, so that every solid has a random case
  const solid = i < ALL_SOLID_NAMES.length ? ALL_SOLID_NAMES[i] : pick(ALL_SOLID_NAMES);
  const S = getSolid(solid);
  const mode = rnd() < 0.7 ? "fold" : "nofold";
  const N = randomN();
  const u = rnd();
  const P = u < 0.4 ? 1 + int(5) : u < 0.8 ? 6 + int(25) : 31 + int(70);
  const s = surfaceBound(solid, N, P).value * pick([0.6, 0.9, 1, 1.2, 1.6, 2.5, 5]);
  // one configuration in twenty has centres anywhere in the faces' bounding squares (some outside their faces)
  const inside = rnd() >= 0.05;
  const wild = rnd() < 0.05;
  const pieces: Piece[] = [];
  for (let k = 0; k < P; k++) {
    const face = int(S.F);
    const [x, y] = randomPoint(solid, s, face, inside);
    pieces.push({ face, x, y, theta: wild ? (2 * rnd() - 1) * 1e6 : (2 * rnd() - 1) * Math.PI });
  }
  add("random", `random ${i}`, solid, mode, N, s, pieces);
}
// few pieces spread over the faces of a large solid: mostly valid configurations
for (let i = 0; i < 500; i++) {
  const solid = pick(ALL_SOLID_NAMES);
  const S = getSolid(solid);
  const mode = rnd() < 0.5 ? "fold" : "nofold";
  const N = randomN();
  const P = 1 + int(Math.min(S.F, 12));
  const one = surfaceBounds(solid, N, P).one;
  const s = Math.max(surfaceBound(solid, N, P).value, one) * pick([1.5, 2.5, 4, 8, 1e3]);
  const faces = Array.from({ length: S.F }, (_, f) => f);
  const pieces: Piece[] = [];
  for (let k = 0; k < P; k++) {
    const face = faces.splice(int(faces.length), 1)[0];
    pieces.push({ face, x: (rnd() - 0.5) * 0.02 * s, y: (rnd() - 0.5) * 0.02 * s, theta: (2 * rnd() - 1) * Math.PI });
  }
  add("spread", `spread ${i}`, solid, mode, N, s, pieces);
}
// one or two pieces on a solid about as small as a piece allows: cone points, pieces and disks that wrap onto themselves
for (let i = 0; i < 600; i++) {
  const solid = i < ALL_SOLID_NAMES.length ? ALL_SOLID_NAMES[i] : pick(ALL_SOLID_NAMES);
  const S = getSolid(solid);
  const N = randomN();
  const P = 1 + int(2);
  const s = surfaceBounds(solid, N, 1).one * pick([0.35, 0.5, 0.7, 0.85, 1, 1.15, 1.5]);
  const pieces: Piece[] = [];
  for (let k = 0; k < P; k++) {
    const face = int(S.F);
    const [x, y] = rnd() < 0.3 ? [0, 0] : randomPoint(solid, s, face, true);
    pieces.push({ face, x, y, theta: (2 * rnd() - 1) * Math.PI });
  }
  add("small-solid", `small ${i}`, solid, "fold", N, s, pieces);
}

// ---- limits --------------------------------------------------------------------------------------------------------
// the error limit: many pieces in one place (pairs) or on corners of their faces (cone points, walls), at the server's
// limit of 20, at 1 and at the validator's own default of 50
for (const solid of ["cube", "icosahedron", "truncated_icosahedron", "rhombic_dodecahedron", "prism7", "snub_disphenoid"] as SolidName[])
  for (const mode of ["fold", "nofold"])
    for (const N of [0, 4, 17, 100])
      for (const maxErrors of [1, 20, null]) {
        const S = getSolid(solid);
        const P = pick([30, 60, 100]);
        const s = surfaceBound(solid, N, P).value * 2;
        const face = int(S.F);
        const [x, y] = randomPoint(solid, s, face, true);
        add("error-limit", `coincident P=${P} maxErrors=${maxErrors}`, solid, mode, N, s, Array.from({ length: P }, () => ({ face, x, y, theta: 0.2 })), { maxErrors, maxChains: 600, scale: null });
        const corners: Piece[] = Array.from({ length: P }, (_, k) => {
          const f = k % S.F;
          const [vx, vy] = faceVertex(S, s, f, k % S.sides[f]);
          return { face: f, x: vx * 0.97, y: vy * 0.97, theta: k };
        });
        add("error-limit", `corners P=${P} maxErrors=${maxErrors}`, solid, mode, N, s, corners, { maxErrors, maxChains: 600, scale: null });
      }
// the chain limit at other limits than the server's, and the chain depth limit (no chain limit, a solid 30 to 50
// times too small: a ray crosses 80 edges)
for (const solid of ["tetrahedron", "octahedron", "icosahedron", "snub_cube", "triakis_tetrahedron", "square_pyramid"] as SolidName[])
  for (const N of [0, 3, 6]) {
    const S = getSolid(solid);
    const one = surfaceBounds(solid, N, 1).one;
    const piece = (s: number): Piece[] => [{ face: int(S.F), x: 0.01 * s, y: 0.02 * s, theta: 0.3 }];
    add("chain-depth", "no chain limit, s = 0.02 of the one-piece bound", solid, "fold", N, one * 0.02, piece(one * 0.02), { maxErrors: 20, maxChains: null, scale: null });
    add("chain-limit", "maxChains 5000, s = 0.1 of the one-piece bound", solid, "fold", N, one * 0.1, piece(one * 0.1), { maxErrors: 20, maxChains: 5000, scale: null });
    add("chain-limit", "maxChains 50, s = 0.3 of the one-piece bound", solid, "fold", N, one * 0.3, piece(one * 0.3), { maxErrors: 20, maxChains: 50, scale: null });
    add("chain-limit", "maxChains 1, s = the one-piece bound", solid, "fold", N, one, piece(one), { maxErrors: 20, maxChains: 1, scale: null });
    add("chain-limit", "maxChains 600, second piece far too large", solid, "fold", N, one * 0.05, [...piece(one * 0.05), ...piece(one * 0.05)], SERVER);
  }
// scaled pieces (the validator's `scale`, which the server leaves at 1)
reals.forEach((c, index) => {
  if (index % 40 !== 7) return;
  for (const scale of [0.999, 0.5, 1.001]) add("scale", `${c.id} scale ${scale}`, c.solid, c.mode, c.N, c.s, c.pieces, { maxErrors: 20, maxChains: 600, scale });
});

// centres exactly on the boundary of their face: at a corner, at the middle of an edge, anywhere on an edge (the wedge
// over an edge through the centre is a half-plane, and the edge-line test of the chains is at its slack)
for (let i = 0; i < 400; i++) {
  const solid = i < ALL_SOLID_NAMES.length ? ALL_SOLID_NAMES[i] : pick(ALL_SOLID_NAMES);
  const S = getSolid(solid);
  const mode = rnd() < 0.75 ? "fold" : "nofold";
  const N = randomN();
  const P = 1 + int(3);
  const s = Math.max(surfaceBound(solid, N, P).value, surfaceBounds(solid, N, P).one) * pick([1, 1.5, 3, 10]);
  const pieces: Piece[] = [];
  for (let k = 0; k < P; k++) {
    const face = int(S.F);
    const e = int(S.sides[face]);
    const [ax, ay] = faceVertex(S, s, face, e);
    const [bx, by] = faceVertex(S, s, face, e + 1);
    const t = pick([0, 0.5, 0.5, rnd(), 1]);
    pieces.push({ face, x: ax + t * (bx - ax), y: ay + t * (by - ay), theta: (2 * rnd() - 1) * Math.PI });
  }
  add("on-boundary", `boundary ${i}`, solid, mode, N, s, pieces);
}
// disks whose images lie on the boundary rays of their wedges: at a vertex of cone angle pi (the tetrahedron's, three
// triangles) a disk's image through the vertex is on the ray both twin chains share, and the disk check tests it with
// tolerance 0. Centres at the centre of a face, on its axes of symmetry and anywhere, on solids about one disk wide.
for (let i = 0; i < 400; i++) {
  const solid = i % 4 < 2 ? "tetrahedron" : pick(["octahedron", "triakis_tetrahedron", "square_pyramid", "triangular_bipyramid", "prism3", "cube", "snub_disphenoid"] as SolidName[]);
  const S = getSolid(solid);
  const P = 1 + int(4);
  const s = surfaceBounds(solid, 0, 1).one * pick([0.6, 0.8, 1, 1.0000001, 1.2, 1.6, 2, 2.5]);
  const pieces: Piece[] = [];
  for (let k = 0; k < P; k++) {
    const face = int(S.F);
    const [vx, vy] = faceVertex(S, s, face, int(S.sides[face]));
    const u = rnd();
    const [x, y] = u < 0.25 ? [0, 0] : u < 0.6 ? [vx * (0.9 * rnd() - 0.45), vy * (0.9 * rnd() - 0.45)] : randomPoint(solid, s, face, true);
    pieces.push({ face, x, y, theta: 0 });
  }
  add("disk-images", `images ${i}`, solid, "fold", 0, s, pieces);
}

// ---- the cases and the TypeScript's verdicts -------------------------------------------------------------------------
const encode = (_: string, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : Object.is(v, -0) ? "-0" : v);
writeFileSync(`${outDir}/cases.jsonl`, cases.map((c) => JSON.stringify(c, encode)).join("\n") + "\n");
const optsOf = (c: Case, tol: number) => ({
  tol,
  ...(c.opts.maxErrors === null ? {} : { maxErrors: c.opts.maxErrors }),
  ...(c.opts.maxChains === null ? {} : { maxChains: c.opts.maxChains }),
  ...(c.opts.scale === null ? {} : { scale: c.opts.scale }),
});
const cfgOf = (c: Case): SurfaceConfig => ({ solid: c.solid as SolidName, N: c.N, s: c.s, pieces: c.pieces });
type Verdict = { ok: boolean; errors: string[]; minPairSep: string; minConeSep: string; minWallSep: string } | { throw: string; message: string };
const thrown = (e: unknown): Verdict => ({ throw: e instanceof ChainLimitError ? "ChainLimitError" : "Error", message: e instanceof Error ? e.message : String(e) });
const shown = (v: { ok: boolean; errors: string[]; minPairSep: number; minConeSep: number; minWallSep: number }): Verdict => ({
  ok: v.ok,
  errors: v.errors,
  minPairSep: String(v.minPairSep),
  minConeSep: String(v.minConeSep),
  minWallSep: String(v.minWallSep),
});
const verdict = (c: Case, tol: number): Verdict => {
  try {
    return shown(validate(cfgOf(c), c.mode as Mode, optsOf(c, tol)));
  } catch (e) {
    return thrown(e);
  }
};
const TOLS = [1e-9, 1e-11];
const ref = cases.map((c) => ({ id: c.id, r: TOLS.map((tol) => verdict(c, tol)) }));
writeFileSync(`${outDir}/ref.jsonl`, ref.map((r) => JSON.stringify(r)).join("\n") + "\n");

// validateAsync (what the server calls) gives what validate gives: checked on every seventh case, in slices of 1 ms
let asyncChecked = 0;
let asyncDiffers = 0;
for (const c of cases) {
  if (c.id % 7) continue;
  for (let t = 0; t < TOLS.length; t++) {
    let v: Verdict;
    try {
      v = shown(await validateAsync(cfgOf(c), c.mode as Mode, { ...optsOf(c, TOLS[t]), sliceMs: 1 }));
    } catch (e) {
      v = thrown(e);
    }
    asyncChecked++;
    if (JSON.stringify(v) !== JSON.stringify(ref[c.id].r[t])) {
      asyncDiffers++;
      console.error(`validateAsync differs from validate on case ${c.id} (${c.kind})`);
    }
  }
}

if (!noTimes) {
  const best = new Float64Array(cases.length).fill(Infinity);
  let sink = 0;
  for (let pass = 0; pass < 5; pass++)
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const cfg = cfgOf(c);
      const o = optsOf(c, 1e-9);
      const t = process.hrtime.bigint();
      try {
        sink += validate(cfg, c.mode as Mode, o).errors.length;
      } catch {
        sink++;
      }
      const d = Number(process.hrtime.bigint() - t);
      if (d < best[i]) best[i] = d;
    }
  writeFileSync(`${outDir}/ts-times.json`, JSON.stringify(Array.from(best)));
  if (sink < 0) console.log(sink);
}

// ---- the solids ------------------------------------------------------------------------------------------------------
const plain = (_: string, v: unknown) => (v instanceof Float64Array ? Array.from(v) : v);
const solids = ALL_SOLID_NAMES.map((name) => JSON.parse(JSON.stringify(getSolid(name), plain)));
writeFileSync(`${outDir}/solids-ref.jsonl`, solids.map((s) => JSON.stringify(s)).join("\n") + "\n");

// ---- the domain ------------------------------------------------------------------------------------------------------
type Probe = { solid: string; mode: string; N: number; P: number };
const probes: Probe[] = [];
for (const solid of ALL_SOLID_NAMES) for (const N of [0, 3, 5, 7, 8, 9, 50, 100]) for (const P of [1, 2, 7, 24, 100]) probes.push({ solid, mode: P % 2 ? "fold" : "nofold", N, P });
for (const [solid, mode, N, P] of [
  ["cube", "fold", 1, 5],
  ["cube", "fold", 2, 5],
  ["cube", "fold", 101, 5],
  ["cube", "fold", 3.5, 5],
  ["cube", "fold", -3, 5],
  ["cube", "fold", NaN, 5],
  ["cube", "fold", 4, 0],
  ["cube", "fold", 4, 101],
  ["cube", "fold", 4, 2.5],
  ["cube", "fold", 4, Infinity],
  ["cube", "folded", 4, 5],
  ["cube", "", 4, 5],
  ["Cube", "fold", 4, 5],
  ["hypercube", "nofold", 0, 1],
  ["", "fold", 0, 1],
] as [string, string, number, number][])
  probes.push({ solid, mode, N, P });
const sampleLimits = [0, 1, 7, 500, 5000, 200000];
writeFileSync(`${outDir}/domain-probes.json`, JSON.stringify({ bounds: probes, samples: sampleLimits }, encode));
const boundOf = (p: Probe) => {
  const b = surfaceDomain.bound({ fields: { solid: p.solid, mode: p.mode, N: p.N }, P: p.P });
  return b ? { value: String(b.value), label: b.label } : null;
};
const info = JSON.stringify(surfaceDomain.info);
writeFileSync(`${outDir}/domain-ref.json`, JSON.stringify({ info, bounds: probes.map(boundOf) }));
for (const limit of sampleLimits) writeFileSync(`${outDir}/sample-${limit}.ref.txt`, surfaceDomain.sample(limit).join("\n") + "\n");
const all = new Float64Array(ALL_SOLID_NAMES.length * SURFACE_NS.length * SURFACE_MAX_P * 2);
let at = 0;
for (const solid of ALL_SOLID_NAMES)
  for (const N of SURFACE_NS)
    for (let P = 1; P <= SURFACE_MAX_P; P++) {
      const b = surfaceBounds(solid, N, P);
      all[at++] = b.area;
      all[at++] = b.one;
    }
writeFileSync(`${outDir}/bounds-ref.f64`, Buffer.from(all.buffer));

// ---- fixtures for cargo test -----------------------------------------------------------------------------------------
if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  // cases: of each kind, mode and piece type the first small one, and the first small case of every reason
  const reasonKey = (v: Verdict) => ("throw" in v ? [`throw ${v.throw}: ${v.message.replace(/\d+(\.\d+)?/g, "#").slice(0, 30)}`] : v.errors.map((e) => e.replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/g, "#")));
  const seen = new Set<string>();
  const chosen: number[] = [];
  for (const c of cases) {
    if (c.pieces.length > 12) continue;
    const keys = [`${c.kind}|${c.mode}|${c.N === 0 ? "disk" : "polygon"}`, ...ref[c.id].r.flatMap(reasonKey).map((k) => "reason|" + k)];
    if (keys.every((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    chosen.push(c.id);
  }
  // one valid packing of each family of solids in each mode, of at most 20 pieces
  const families = new Set<string>();
  for (const c of cases) {
    if ((c.kind !== "site" && c.kind !== "record") || c.pieces.length > 20 || chosen.includes(c.id)) continue;
    const key = `${getSolid(c.solid as SolidName).family}|${c.mode}|${c.N === 0 ? "disk" : "polygon"}`;
    if (families.has(key)) continue;
    families.add(key);
    chosen.push(c.id);
  }
  chosen.sort((a, b) => a - b);
  writeFileSync(`${fixturesDir}/cases.jsonl`, chosen.map((id) => JSON.stringify({ ...cases[id], r: ref[id].r }, encode)).join("\n") + "\n");
  // solids: the numbers that fix each solid's surface, as counts, hashes of the lists of whole numbers and sums
  const hash = (list: number[]) => {
    let h = 0x811c9dc5;
    for (const v of list) h = Math.imul(h ^ v, 0x01000193) >>> 0;
    return h;
  };
  const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
  const summary = ALL_SOLID_NAMES.map((name) => {
    const S = getSolid(name);
    return {
      name,
      family: S.family,
      title: S.title,
      M: S.M,
      F: S.F,
      V: S.V,
      E: S.E,
      degree: Number.isNaN(S.degree) ? null : S.degree,
      coneAngle: Number.isNaN(S.coneAngle) ? null : S.coneAngle,
      uniform: S.uniform,
      regular: S.regular.filter(Boolean).length,
      faces: hash(S.faces.flat()),
      adj: hash(S.adj.flat().flatMap((r) => [r.face, r.edge])),
      unitFaces: sum(S.unitFaces.flatMap((u) => Array.from(u, Math.abs))),
      corner: sum(S.corner.flat()),
      edgeAngle: sum(S.edgeAngle.flat()),
      vertexCone: sum(S.vertexCone),
    };
  });
  writeFileSync(`${fixturesDir}/solids.json`, "[\n" + summary.map((s) => JSON.stringify(s)).join(",\n") + "\n]\n");
  const fixtureProbes = probes.filter((_, i) => i % 97 === 0 || i >= probes.length - 15);
  writeFileSync(
    `${fixturesDir}/domain.json`,
    JSON.stringify({ info, sample: surfaceDomain.sample(60), probes: fixtureProbes, bounds: fixtureProbes.map(boundOf) }, encode) + "\n",
  );
  console.log(`fixtures: ${chosen.length} cases, ${summary.length} solids, ${fixtureProbes.length} bounds`);
}

const kinds = new Map<string, number>();
for (const c of cases) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
console.log(`${cases.length} cases (${nRecords} research records, ${nSite} site entries): ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")}`);
console.log(`validateAsync against validate: ${asyncChecked} verdicts, ${asyncDiffers} different`);
console.log(`solids ${solids.length}, bound probes ${probes.length}, bounds ${all.length / 2}`);
