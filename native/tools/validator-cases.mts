// Cases for the validator cross-check of native/flat against the server's rule.
//
//   npx tsx native/tools/validator-cases.mts [COUNT_PER_SHAPE] [SEED] > cases.jsonl
//   cargo run --release -p polypack-flat --example xcheck < cases.jsonl
//
// Each line is one configuration with the reference's verdicts: parseConfig, evaluate as
// POST /api/submit applies it (maxOverlaps 20, stopWhenInvalid), the smallest pair separation,
// the strict check (no penetration above 1e-12, widened far from the origin) and strictVerify.
// Families: loose random packings, contact pairs and triples found by bisection, separations at
// and around -1e-9, -1e-12 and 0 to the last bits, identical and coincident poses, coordinates
// near and beyond 1e6, enormous angles, wrong piece counts, and dense lattices up to P = 500.
import {
  MAX_COORD,
  TOL,
  boundingRadius,
  evaluate,
  findOverlaps,
  pairSeparation,
  parseConfig,
  strictVerify,
  type PackingConfig,
  type Pose,
} from "../../packages/geometry/src/index.ts";

const COUNT = Number(process.argv[2] ?? 6);
let state = Number(process.argv[3] ?? 1) >>> 0;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SHAPES = [0, ...Array.from({ length: 98 }, (_, i) => i + 3)];
const CONTAINERS = [0, 3, 4, 5, 6, 7, 8, 12, 17, 50, 100];

function strictTolerance(pieces: readonly Pose[]): number {
  let reach = 0;
  for (const p of pieces) reach = Math.max(reach, Math.abs(p.x), Math.abs(p.y));
  return 1e-12 + 4 * Number.EPSILON * reach;
}

function minSeparation(N: number, pieces: readonly Pose[]): number | null {
  let best = Infinity;
  const reach = 2 * boundingRadius(N);
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i];
      const b = pieces[j];
      if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > reach * reach) continue;
      best = Math.min(best, pairSeparation(N, a, b));
    }
  return Number.isFinite(best) ? best : null;
}

function emit(family: string, config: PackingConfig, declaredP = config.P) {
  const body = { ...config, P: declaredP };
  const parsed = parseConfig(body);
  const out: Record<string, unknown> = { family, N: config.N, M: config.M, P: declaredP, pieces: config.pieces, container_phi: config.container_phi };
  out.parse_ok = parsed.ok;
  if (parsed.ok) {
    const e = evaluate(parsed.config, { maxOverlaps: 20, stopWhenInvalid: true });
    out.valid = e.valid;
    out.score = e.valid ? e.score : null;
    out.min_sep = minSeparation(config.N, config.pieces);
    out.strict = e.valid && findOverlaps(config.N, config.pieces, strictTolerance(config.pieces)).length === 0;
    if (e.valid && e.container) out.strict_verify = strictVerify(config.N, config.pieces, e.container).ok;
  }
  console.log(JSON.stringify(out));
}

/** Loose valid packing: pieces on a jittered grid with a random gap. */
function loose(N: number, M: number, P: number, gap: number): PackingConfig {
  const width = Math.ceil(Math.sqrt(P));
  const pitch = 2 * boundingRadius(N) + gap;
  const pieces = Array.from({ length: P }, (_, i) => ({
    x: pitch * (i % width) + (random() - 0.5) * gap * 0.9,
    y: pitch * Math.floor(i / width) + (random() - 0.5) * gap * 0.9,
    theta: N === 0 ? 0 : 2 * Math.PI * random(),
  }));
  return { N, M, P, pieces, container_phi: 2 * Math.PI * random() };
}

/** The distance along direction u at which pairSeparation(a, b(t)) crosses `target`, to the last bit. */
function crossing(N: number, a: Pose, theta: number, ux: number, uy: number, target: number): number {
  let lo = 0;
  let hi = 4 * boundingRadius(N) + 1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    const s = pairSeparation(N, a, { x: a.x + mid * ux, y: a.y + mid * uy, theta });
    if (s < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Two pieces at separation `target` (and neighbouring doubles), around an offset origin. */
function edgePair(N: number, M: number, target: number, ulps: number, offset: number): PackingConfig {
  const a = { x: offset * (2 * random() - 1), y: offset * (2 * random() - 1), theta: N === 0 ? 0 : 2 * Math.PI * random() };
  const angle = 2 * Math.PI * random();
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const theta = N === 0 ? 0 : 2 * Math.PI * random();
  let t = crossing(N, a, theta, ux, uy, target);
  for (let k = 0; k < Math.abs(ulps); k++) t = ulps > 0 ? nextUp(t) : nextDown(t);
  return { N, M, P: 2, pieces: [a, { x: a.x + t * ux, y: a.y + t * uy, theta }], container_phi: 0 };
}

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
function nextUp(x: number): number {
  f64[0] = x;
  u64[0] += x >= 0 ? 1n : -1n;
  return f64[0];
}
function nextDown(x: number): number {
  f64[0] = x;
  u64[0] += x > 0 ? -1n : 1n;
  return f64[0];
}

/** A dense lattice of P pieces at contact (squares and hexagons tile; others at their spacing). */
function lattice(N: number, M: number, P: number, squeeze: number): PackingConfig {
  const width = Math.ceil(Math.sqrt(P));
  const theta = N === 0 ? 0 : N % 2 === 0 ? Math.PI / N : 0;
  const origin = { x: 0, y: 0, theta };
  const dx = crossing(N, origin, theta, 1, 0, 0) * squeeze;
  const dy = crossing(N, origin, theta, 0, 1, 0) * squeeze;
  const pieces = Array.from({ length: P }, (_, i) => ({ x: dx * (i % width), y: dy * Math.floor(i / width), theta }));
  return { N, M, P, pieces, container_phi: 0 };
}

for (const N of SHAPES) {
  for (let c = 0; c < COUNT; c++) {
    const M = CONTAINERS[Math.floor(random() * CONTAINERS.length)];
    const P = 1 + Math.floor(random() * 40);
    emit("loose", loose(N, M, P, 0.05 + random()));
    emit("touching", edgePair(N, M, 0, Math.floor(random() * 7) - 3, 3));
    emit("tol-edge", edgePair(N, M, -TOL, Math.floor(random() * 9) - 4, 3));
    emit("strict-edge", edgePair(N, M, -1e-12, Math.floor(random() * 9) - 4, 3));
    emit("gap-1e-12", edgePair(N, M, 1e-12, 0, 3));
    emit("pen-1e-12", edgePair(N, M, -1e-12 * (0.5 + random()), 0, 3));
    emit("pen-near-tol", edgePair(N, M, -TOL * (1 + (random() - 0.5) * 1e-6), 0, 3));
    emit("large-coord", edgePair(N, M, (random() - 0.5) * 2e-9, 0, 4e5 + 5e5 * random()));
    const a = { x: random(), y: random(), theta: N === 0 ? 0 : random() * 7 };
    emit("identical", { N, M, P: 2, pieces: [a, { ...a }], container_phi: 0 });
    emit("coincident", { N, M, P: 2, pieces: [a, { ...a, theta: a.theta + 0.3 }], container_phi: 0 });
    emit("huge-angle", edgePair(N, M, (random() - 0.5) * 4e-9, 0, 3));
    const big = { ...edgePair(N, M, 1e-6, 0, 1) };
    big.pieces = big.pieces.map((p) => ({ ...p, theta: p.theta + 1e6 * (random() - 0.5) }));
    emit("huge-angle-2", big);
    // the client reduces angles to one symmetry period before its check: the same cases, reduced
    const reduce = (x: number, period: number) => ((x % period) + period) % period;
    for (const c of [big, edgePair(N, M, -TOL, Math.floor(random() * 9) - 4, 3)]) {
      emit("canonical", {
        ...c,
        pieces: c.pieces.map((p) => ({ ...p, theta: N === 0 ? 0 : reduce(p.theta, (2 * Math.PI) / N) })),
        container_phi: M === 0 ? 0 : reduce(c.container_phi, (2 * Math.PI) / M),
      });
    }
    if (c === 0) {
      const lim = loose(N, M, 3, 0.5);
      lim.pieces[0].x = MAX_COORD * (random() < 0.5 ? 1 : -1);
      emit("coord-limit", lim);
      lim.pieces[0].x = nextUp(Math.abs(lim.pieces[0].x)) * Math.sign(lim.pieces[0].x);
      emit("coord-over", lim);
      emit("wrong-count", loose(N, M, 4, 0.5), 5);
    }
  }
  const P = 50 + Math.floor(random() * 451);
  emit("lattice", lattice(N, CONTAINERS[Math.floor(random() * CONTAINERS.length)], P, 1));
  emit("lattice-tight", lattice(N, CONTAINERS[Math.floor(random() * CONTAINERS.length)], P, 1 - 1e-10 * random()));
}
