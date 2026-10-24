import { pieceArea } from "@polypack/geometry";
import { SurfacePose } from "../parts";
import { Solid, faceApothem, surfaceArea } from "../solids";
import { validateFold } from "../validate";
import { Packing, compress, compressPenalty, finalize } from "./optimize";
import { slpPolish } from "./slp";

/** Seeded generator (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomPose(solid: Solid, rand: () => number): SurfacePose {
  const ap = faceApothem(solid.M, 1);
  const face = Math.floor(rand() * solid.F);
  for (;;) {
    const x = (2 * rand() - 1) * ap * 1.3;
    const y = (2 * rand() - 1) * ap * 1.3;
    let inside = true;
    for (let j = 0; j < solid.M; j++) {
      const a = (2 * Math.PI * (j + 1)) / solid.M - Math.PI / 2;
      if (x * Math.cos(a) + y * Math.sin(a) > ap) inside = false;
    }
    if (inside) return { face, x, y, theta: 2 * Math.PI * rand() };
  }
}

/** Largest piece scale allowed by area on the unit solid. */
export function areaScale(solid: Solid, N: number, P: number): number {
  return Math.sqrt(surfaceArea(solid, 1) / (P * pieceArea(N)));
}

export interface Start {
  label: string;
  lam: number;
  poses: SurfacePose[];
}

export interface SearchLog {
  label: string;
  lam: number;
}

export interface SearchOptions {
  seed: number;
  randomStarts: number;
  hops: number;
  warm: Start[];
  maxIter?: number;
  log?: (msg: string) => void;
  deadline?: number;
}

export interface SearchResult {
  lam: number;
  poses: SurfacePose[];
  label: string;
  history: SearchLog[];
  evals: number;
}

function perturb(solid: Solid, poses: SurfacePose[], rand: () => number, lam: number): SurfacePose[] {
  const out = poses.map((p) => ({ ...p }));
  const kind = rand();
  const k = 1 + Math.floor(rand() * Math.min(3, out.length));
  for (let t = 0; t < k; t++) {
    const i = Math.floor(rand() * out.length);
    if (kind < 0.35) out[i] = randomPose(solid, rand);
    else {
      const r = (0.15 + 0.5 * rand()) * lam;
      const a = 2 * Math.PI * rand();
      out[i] = { ...out[i], x: out[i].x + r * Math.cos(a), y: out[i].y + r * Math.sin(a), theta: out[i].theta + (rand() - 0.5) * 1.5 };
    }
  }
  if (kind > 0.85) {
    // small global jiggle
    for (const p of out) {
      p.x += (rand() - 0.5) * 0.05 * lam;
      p.y += (rand() - 0.5) * 0.05 * lam;
      p.theta += (rand() - 0.5) * 0.1;
    }
  }
  return out;
}

/** Disks: geometric growth with fixed-scale relaxation; polygons: penalty with the scale as a variable. */
function runCompress(pk: Packing, N: number, lam0: number, maxIter: number | undefined, stop: () => boolean) {
  return N === 0 ? compress(pk, lam0, { maxIter, shouldStop: stop }) : compressPenalty(pk, lam0, { maxIter: maxIter ?? 300, shouldStop: stop });
}

/** Search one problem: compress every start, then basin-hop from the best. Deterministic for a seed. */
export function searchProblem(solid: Solid, N: number, P: number, opts: SearchOptions): SearchResult | null {
  const rand = mulberry32(opts.seed);
  const la = areaScale(solid, N, P);
  const log = opts.log ?? (() => {});
  const history: SearchLog[] = [];
  let best: SearchResult | null = null;
  let evals = 0;
  const stop = () => opts.deadline !== undefined && Date.now() > opts.deadline;
  const take = (label: string, lam: number, poses: SurfacePose[]) => {
    history.push({ label, lam });
    if (!best || lam > best.lam) {
      best = { lam, poses: poses.map((p) => ({ ...p })), label, history, evals };
      log(`  ${label}: s = ${(1 / lam).toFixed(7)}`);
    }
  };
  const starts: Start[] = [...opts.warm];
  for (let k = 0; k < opts.randomStarts; k++) {
    starts.push({ label: `random#${k}`, lam: 0.55 * la, poses: Array.from({ length: P }, () => randomPose(solid, rand)) });
  }
  for (const st of starts) {
    if (stop()) break;
    const pk = new Packing(solid, N, st.lam, st.poses);
    const r = runCompress(pk, N, st.lam, opts.maxIter, stop);
    evals += pk.evals;
    if (r) take(st.label, r.lam, r.poses);
  }
  if (!best) return null;
  for (let h = 0; h < opts.hops; h++) {
    if (stop()) break;
    const b: SearchResult = best;
    const start = perturb(solid, b.poses, rand, b.lam);
    const lam0 = b.lam * 0.97;
    const pk = new Packing(solid, N, lam0, start);
    const r = runCompress(pk, N, lam0, opts.maxIter, stop);
    evals += pk.evals;
    if (r) take(`${b.label}+hop${h}`, r.lam, r.poses);
  }
  const fin: SearchResult = best;
  // tighten to (near) zero overlap, then contact-LP polish (which keeps validity), then check
  const pk = new Packing(solid, N, fin.lam, fin.poses);
  const f0 = finalize(pk, fin.lam, fin.poses);
  const pol = slpPolish(solid, N, f0.lam, f0.poses, { iterations: 120 });
  log(`  slp polish: s = ${(1 / pol.lam).toFixed(10)} (${pol.iterations} iterations)`);
  const f = pol.lam >= f0.lam ? { lam: pol.lam, poses: pol.poses, energy: 0 } : f0;
  const poses = f.poses.map((p) => ({ face: p.face, x: p.x / f.lam, y: p.y / f.lam, theta: p.theta }));
  const v = validateFold({ solid: solid.name, N, s: 1 / f.lam, pieces: poses }, { tol: 1e-10 });
  if (!v.ok) {
    log(`  finalize failed the float check: ${v.errors[0]}`);
    return null;
  }
  return { lam: f.lam, poses: f.poses, label: fin.label, history, evals: evals + pk.evals };
}
