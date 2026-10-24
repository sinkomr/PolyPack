/**
 * Scale-free hyperbolic family a*(N, M, P): largest side (radius for disks) of P congruent pieces in
 * the ideal M-gon at K = -1, computed as sqrt(-K*) for unit pieces (see src/ideal.ts).
 *
 *   npx tsx packages/curved/scripts/run-ideal.ts --runs DIR(K=-1 run files) --out DIR --N 3 --M 4 [--extra 1 --hops 6 --seed 1]
 *
 * For P with a K = -1 packing: kPolish from it plus seeded hops. For the first P without one
 * (--extra 1): a seeded search at K = -0.25 followed by kPolish. Each finite result is turned into a
 * certifiable record: unit pieces at K_c = K*(1 - 1e-9) (slightly flatter) in a finite M-gon.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kPolish } from "../src/ideal";
import { energy, posesFromVector, vectorFromPoses } from "../src/model";
import { lbfgs, rng, gaussian } from "../src/optim";
import { makeSpace, solve, polishAt, certifyPrep, type CurvedPose } from "../src/index";
import { idealApothem, sideFromApothem } from "../src/shapes";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}
const runs = arg("runs");
const out = arg("out");
const N = Number(arg("N"));
const M = Number(arg("M"));
const extra = Number(arg("extra", "1"));
const hops = Number(arg("hops", "6"));
const seed = Number(arg("seed", "1"));
mkdirSync(out, { recursive: true });

function repairAt(K: number, poses: CurvedPose[]): CurvedPose[] | undefined {
  const space = makeSpace(K, N, M);
  const t = idealApothem(M, K) * (1 - 1e-12);
  const z0 = vectorFromPoses(poses);
  const res = lbfgs((x, g) => energy(space, x, t, g), z0, { maxIter: 400, stopBelow: 1e-22 });
  return res.f <= 1e-22 ? posesFromVector(res.x) : undefined;
}

function improve(start: CurvedPose[], K0: number, r: () => number) {
  let best = kPolish(N, M, start, K0);
  for (let h = 0; h < hops && !best.unbounded; h++) {
    const z = vectorFromPoses(best.poses);
    const s = 0.03 + 0.1 * r();
    for (let j = 0; j < z.length; j++) z[j] += s * gaussian(r) * (j % 3 === 2 ? 1 : 0.5);
    // re-place one piece at random with probability 1/2
    if (r() < 0.5) {
      const i = Math.floor(r() * (z.length / 3));
      z[3 * i] *= 0.2;
      z[3 * i + 1] *= 0.2;
      z[3 * i + 2] = 2 * Math.PI * r();
    }
    // repair at a slightly flatter curvature (smaller pieces), then grow again
    const Kr = best.K * 0.97;
    const rep = repairAt(Kr, posesFromVector(z));
    if (!rep) continue;
    const cand = kPolish(N, M, rep, Kr);
    if (cand.K < best.K - 1e-12 && cand.feasibility > -1e-10) best = cand;
  }
  return best;
}

let firstMissing = -1;
for (let P = 1; P <= 60; P++) {
  const f = join(runs, `-1_${N}_${M}_${P}.json`);
  if (!existsSync(f)) break;
  const d = JSON.parse(readFileSync(f, "utf8"));
  const file = join(out, `ideal_${N}_${M}_${P}.json`);
  if (!d.found) {
    firstMissing = P;
    break;
  }
  if (existsSync(file)) continue;
  const r = rng(seed * 7717 + P * 31 + N * 7 + M);
  const t0 = Date.now();
  let res = improve(d.config_float.pieces, -1, r);
  let how = "from the K = -1 optimum";
  // also start from a fresh search at a flatter curvature (smaller pieces): finds other basins,
  // e.g. pieces reaching into the cusps
  if (!res.unbounded) {
    const sres = solve({ N, M, P }, -0.5, { seed: seed * 101 + P, restarts: 2, hops: 6 });
    if (sres.config) {
      const cand = improve(sres.config.pieces, -0.5, r);
      if (cand.unbounded || cand.K < res.K) {
        res = cand;
        how = "from a search at K = -0.5";
      }
    }
  }
  writeFileSync(file, JSON.stringify(finish(P, res, how, t0)));
}
if (firstMissing > 0) {
  for (let P = firstMissing; P < firstMissing + extra; P++) {
    const file = join(out, `ideal_${N}_${M}_${P}.json`);
    if (existsSync(file)) continue;
    const r = rng(seed * 7717 + P * 31 + N * 7 + M);
    const t0 = Date.now();
    let bestRes: ReturnType<typeof kPolish> | undefined;
    for (const Ks of [-0.25, -0.5]) {
      const sres = solve({ N, M, P }, Ks, { seed: seed * 101 + P, restarts: 3, hops: 8 });
      if (!sres.config) continue;
      const cand = improve(sres.config.pieces, Ks, r);
      if (!bestRes || cand.K < bestRes.K) bestRes = cand;
    }
    if (bestRes) writeFileSync(file, JSON.stringify(finish(P, bestRes, "from searches at K = -0.25 and -0.5", t0)));
    else writeFileSync(file, JSON.stringify({ N, M, P, found: false }));
  }
}

function finish(P: number, res: ReturnType<typeof kPolish>, how: string, t0: number) {
  const rec: Record<string, unknown> = {
    N,
    M,
    P,
    found: true,
    how,
    a_float: res.a,
    K_float: res.K,
    unbounded: res.unbounded,
    feasibility: res.feasibility,
    seed,
    hops,
  };
  if (!res.unbounded) {
    // certifiable: unit pieces at a slightly flatter curvature in a finite M-gon
    const Kc = res.K * (1 - 1e-9);
    const space = makeSpace(Kc, N, M);
    const prob = { N, M, P };
    const tInf = idealApothem(M, Kc);
    const startSize = sideFromApothem(M, Kc, tInf * (1 - 1e-12));
    const pc = polishAt(prob, Kc, { size: Number.isFinite(startSize) ? startSize : 50, pieces: res.poses });
    if (pc.validation.valid) {
      const cert = certifyPrep(prob, Kc, pc.config, 1e-12);
      rec.K_cert = Kc;
      rec.a_cert = Math.sqrt(-Kc);
      rec.config_cert = cert.config;
      rec.score_cert = cert.config.size;
      rec.witnesses = cert.witnesses;
      rec.validation_cert = { valid: cert.validation.valid, minGap: cert.validation.minGap };
    }
    void space;
  }
  rec.seconds = (Date.now() - t0) / 1000;
  console.log(
    `a*(${N},${M},${P}) = ${res.unbounded ? "unbounded (> " + res.a.toFixed(1) + ")" : res.a} ${how} ${rec.seconds}s`,
  );
  return rec;
}
