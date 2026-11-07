/**
 * Cases for the cross-check of the native validator against the TypeScript one (the server's).
 * Each line of the output is {id, config, rule, ts}: a configuration, a rule, and the TypeScript
 * verdicts (checkSpaceConfig) and gaps (validate of packages/curved at 1e-9).
 *
 *   npx tsx native/curved/tools/xcheck-gen.ts OUT.jsonl [EXTRA_DIR ...]
 *
 * Bases: the research records (data/curved/records.json) and configurations in EXTRA_DIR (files
 * <id with _>-<seed>.json, e.g. the native job's outputs). Variants of each base, around the
 * tolerances 1e-9 and 1e-11: the base itself (touching), the container shrunk, one piece moved
 * toward its nearest neighbour or toward the nearest wall, all poses jittered, a piece turned. Then
 * random configurations, coordinates near the work bounds, centres at the open hemisphere's edge,
 * and malformed configurations. Every case is checked with a loose rule, the strict rule (no
 * research record), a certified size just above the size (strict check) and a lower bound.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@polypack/curved";
import { checkSpaceConfig, parseSearchProblem } from "@polypack/spaces/search";

type Pose = { x: number; y: number; theta: number };
type Config = { size: number; pieces: Pose[] };
type Rule = { bound: number | null; certified: number | null; noRecord?: boolean };

const out = process.argv[2];
if (!out) throw new Error("usage: xcheck-gen.ts OUT.jsonl [EXTRA_DIR ...]");
const repo = new URL("../../../", import.meta.url).pathname;

// mulberry32, seeded: the cases are the same on every run
let state = 12345;
const rnd = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-300)) * Math.cos(2 * Math.PI * rnd());

const bases: { id: string; config: Config }[] = [];
const records = JSON.parse(readFileSync(join(repo, "data/curved/records.json"), "utf8")).records as {
  id: string;
  config?: Config;
}[];
for (const r of records) if (r.config && parseSearchProblem(r.id)) bases.push({ id: r.id, config: r.config });
for (const dir of process.argv.slice(3)) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const m = /^(curved_.+)-(\d+)\.json$/.exec(name);
    if (!m) continue;
    bases.push({ id: m[1].replaceAll("_", "/"), config: JSON.parse(readFileSync(join(dir, name), "utf8")) });
  }
}

const lines: string[] = [];
const num = (v: number) => (Number.isFinite(v) ? v : null);
function emit(id: string, config: Config, kind: string) {
  const p = parseSearchProblem(id)!;
  const rules: [string, Rule][] = [
    ["loose", { bound: null, certified: null }],
    ["strict", { bound: null, certified: null, noRecord: true }],
    ["certified", { bound: null, certified: config.size * (1 + 3e-9) }],
    ["bound", { bound: config.size * (1 + 5e-10), certified: null }],
  ];
  let gaps: { minGap: number; minPairGap: number; minContainerGap: number } | null = null;
  try {
    const v = validate({ N: p.N, M: p.M, P: p.P }, p.K, config);
    gaps = { minGap: v.minGap, minPairGap: v.minPairGap, minContainerGap: v.minContainerGap };
  } catch {
    gaps = null;
  }
  for (const [name, rule] of rules) {
    const c = checkSpaceConfig("curved", id, config, rule);
    lines.push(
      JSON.stringify({
        id,
        kind,
        ruleName: name,
        config,
        rule,
        ts: {
          valid: c.valid,
          reason: c.reasons[0] ?? null,
          ...(gaps && name === "loose"
            ? { minGap: num(gaps.minGap), minPairGap: num(gaps.minPairGap), minContainerGap: num(gaps.minContainerGap) }
            : {}),
        },
      }),
    );
  }
}

const copy = (c: Config): Config => ({ size: c.size, pieces: c.pieces.map((q) => ({ ...q })) });
const deltas = [0, 1e-13, 1e-12, 5e-12, 9e-12, 1.1e-11, 2e-11, 1e-10, 5e-10, 9e-10, 1.1e-9, 2e-9, 1e-8];
for (const { id, config } of bases) {
  emit(id, config, "base");
  for (const d of deltas.slice(1)) {
    const c = copy(config);
    c.size *= 1 - d;
    emit(id, c, `shrink ${d}`);
  }
  const P = config.pieces.length;
  if (P >= 2) {
    // one piece toward its nearest neighbour (in exponential coordinates)
    const i = Math.floor(rnd() * P);
    let j = -1;
    let best = Infinity;
    for (let q = 0; q < P; q++) {
      if (q === i) continue;
      const d = Math.hypot(config.pieces[q].x - config.pieces[i].x, config.pieces[q].y - config.pieces[i].y);
      if (d < best) {
        best = d;
        j = q;
      }
    }
    for (const d of deltas.slice(1)) {
      const c = copy(config);
      const ux = (config.pieces[j].x - config.pieces[i].x) / best;
      const uy = (config.pieces[j].y - config.pieces[i].y) / best;
      c.pieces[i].x += d * ux;
      c.pieces[i].y += d * uy;
      emit(id, c, `toward ${d}`);
    }
  }
  {
    // the outermost piece outward
    let i = 0;
    for (let q = 1; q < P; q++)
      if (Math.hypot(config.pieces[q].x, config.pieces[q].y) > Math.hypot(config.pieces[i].x, config.pieces[i].y)) i = q;
    const r = Math.hypot(config.pieces[i].x, config.pieces[i].y) || 1;
    for (const d of deltas.slice(1)) {
      const c = copy(config);
      c.pieces[i].x += (d * config.pieces[i].x) / r;
      c.pieces[i].y += (d * config.pieces[i].y) / r;
      emit(id, c, `outward ${d}`);
    }
  }
  for (const s of [1e-12, 1e-11, 1e-10, 1e-9]) {
    const c = copy(config);
    for (const q of c.pieces) {
      q.x += s * gauss();
      q.y += s * gauss();
      q.theta += s * gauss();
    }
    emit(id, c, `jitter ${s}`);
  }
  for (const a of [1e-10, 1e-9, 1e-3]) {
    const c = copy(config);
    c.pieces[Math.floor(rnd() * P)].theta += a;
    emit(id, c, `turn ${a}`);
  }
}

// random configurations of small problems, coordinates near the bounds, hemisphere edges
const shapes = [0, 3, 4, 5, 6, 8, 12];
const ks = [-6.519717439579256, -1, -0.25, -0.01, -1e-6, 1e-6, 0.0001, 0.01, 0.1, 0.5, 1, 1.225778283313099];
const kText = (K: number) => {
  if (Number.isInteger(K)) return String(K);
  const [mant, exp] = K.toExponential().split("e");
  const e = Number(exp);
  if (e >= -4 && e < 16) return String(K);
  return `${mant}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
};
for (let n = 0; n < 600; n++) {
  const K = ks[Math.floor(rnd() * ks.length)];
  const N = shapes[Math.floor(rnd() * shapes.length)];
  const M = shapes[Math.floor(rnd() * shapes.length)];
  const P = 1 + Math.floor(rnd() * 6);
  const id = `curved/${kText(K)}/${N}/${M}/${P}`;
  if (!parseSearchProblem(id)) continue;
  const scale = [0.5, 2, 5, 50, 9000][Math.floor(rnd() * 5)];
  const size = scale * (0.5 + rnd());
  const pieces = Array.from({ length: P }, () => ({
    x: (rnd() - 0.5) * scale,
    y: (rnd() - 0.5) * scale,
    theta: (rnd() - 0.5) * 20,
  }));
  emit(id, { size, pieces }, `random ${scale}`);
}
for (const K of [0.01, 0.1, 0.5, 1, 1.225778283313099]) {
  // centres at the open hemisphere's edge (pi / (2 sqrt K)), in a disk container of almost the limit
  const lim = Math.PI / (2 * Math.sqrt(K));
  for (const f of [1 - 1e-6, 1 - 1e-15, 1 - 2.220446049250313e-16, 1, 1 + 1e-16]) {
    const id = `curved/${kText(K)}/0/0/1`;
    if (!parseSearchProblem(id)) continue;
    emit(id, { size: (Math.PI / Math.sqrt(K)) * (1 - 1e-12), pieces: [{ x: lim * f, y: 0, theta: 0 }] }, `edge ${f}`);
    emit(id, { size: (Math.PI / Math.sqrt(K)) * f, pieces: [{ x: 0, y: 0, theta: 0 }] }, `size edge ${f}`);
  }
}
// malformed or out of bounds
const base = bases[0];
for (const bad of [
  { size: -1, pieces: base.config.pieces },
  { size: 0, pieces: base.config.pieces },
  { size: 2e6, pieces: base.config.pieces },
  { size: base.config.size, pieces: base.config.pieces.slice(1) },
  { size: base.config.size, pieces: base.config.pieces.map((q, i) => (i ? q : { ...q, x: 2e4 })) },
  { size: base.config.size, pieces: base.config.pieces.map((q, i) => (i ? q : { ...q, theta: -1.5e4 })) },
  { size: base.config.size, pieces: base.config.pieces.map((q, i) => (i ? q : { ...q, x: 9999 })) },
]) emit(base.id, bad as Config, "malformed");

writeFileSync(out, lines.join("\n") + "\n");
console.log(JSON.stringify({ bases: bases.length, cases: lines.length }));
