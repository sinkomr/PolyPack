/**
 * The checks every kernel must pass (kernel.ts states the rules). A space's kernel test calls
 * checkKernel with a factory and expects an empty list of failures:
 *
 *   expect(checkKernel(() => sphereKernel(problem), { seed: 1 })).toEqual([]);
 *
 * Each failure is one sentence naming the rule and the numbers. The checks are seeded and use the
 * kernel's own randomStart, so they also cover the states the methods will see.
 */
import type { KernelState, SpaceKernel } from "./kernel";
import { mulberry32 } from "./random";
import { relax } from "./local";

export interface ContractOptions {
  seed?: number;
  /** Random states to test (default 4). */
  states?: number;
  /** Relative tolerance of the gradient check (default 1e-4). */
  gradTol?: number;
  /** Absolute energy below which a finished state counts as having none (default 1e-9). */
  zeroEnergy?: number;
}

const same = (a: unknown, b: unknown, tol = 1e-9): boolean => {
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i], tol));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return same(ka, kb) && ka.every((k) => same((a as never)[k], (b as never)[k], tol));
  }
  return a === b;
};

export function checkKernel(make: () => SpaceKernel, o: ContractOptions = {}): string[] {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  const k = make();
  const { P, dim } = k;
  const n = P * dim + k.globals;
  const rng = mulberry32(o.seed ?? 1);
  const gradTol = o.gradTol ?? 1e-4;
  const zero = o.zeroEnergy ?? 1e-9;

  if (k.steps.length !== dim || ![...k.steps].every((v) => v > 0)) fail("steps must have dim positive entries");
  if (k.globalSteps.length !== k.globals || ![...k.globalSteps].every((v) => v > 0))
    fail("globalSteps must have globals positive entries");
  if (!(k.finishCost >= 1)) fail("finishCost must be at least 1");
  if (!(k.inradius > 0)) fail("inradius must be positive");

  // determinism: the same stream gives the same start
  const a = make().randomStart(mulberry32(7));
  const b = make().randomStart(mulberry32(7));
  if (!same(make().toConfig(a), make().toConfig(b), 0)) fail("randomStart is not determined by the stream");

  for (let t = 0; t < (o.states ?? 4); t++) {
    const s = k.randomStart(rng);
    if (s.x.length !== n || !(s.size > 0) || ![...s.x].every(Number.isFinite)) {
      fail(`randomStart gave a malformed state (length ${s.x.length}, size ${s.size})`);
      continue;
    }
    // configurations round-trip, and rebase and clone change nothing
    const config = k.toConfig(s);
    const back = k.fromConfig(config);
    if (!back || !same(k.toConfig(back), config)) fail("fromConfig(toConfig(s)) does not give back the configuration");
    const c = k.clone(s);
    k.rebase(c);
    if (!same(k.toConfig(c), config)) fail("rebase changed the configuration");
    k.jiggle(c, 0, 1, rng);
    if (!same(k.toConfig(s), config)) fail("changing a clone changed the original");

    // a move changes only its piece's x entries: writing them back undoes it (kernel.ts)
    for (const move of ["randomPose", "jiggle"] as const) {
      const m = k.clone(s);
      const i = Math.floor(rng() * P);
      const saved = m.x.slice(i * dim, i * dim + dim);
      if (move === "randomPose") k.randomPose(m, i, rng);
      else k.jiggle(m, i, 2, rng);
      m.x.set(saved, i * dim);
      if (!same(k.toConfig(m), config, 1e-12)) fail(`${move} changed more than piece ${i}'s variables`);
    }

    // energy: nonnegative, its gradient matches central differences
    const g = new Float64Array(n + 1);
    const e = k.energy(s, g);
    if (!(e >= 0)) fail(`energy ${e} is negative or not a number`);
    if (e > 1e-6) {
      // a few piece variables, every global, and the size
      const coords = [
        ...Array.from({ length: Math.min(6, P * dim) }, () => Math.floor(rng() * P * dim)),
        ...Array.from({ length: k.globals }, (_, g) => P * dim + g),
        n,
      ];
      for (const i of coords) {
        const h =
          i === n ? 1e-6 * Math.max(1, s.size) : 1e-6 * (i < P * dim ? k.steps[i % dim] : k.globalSteps[i - P * dim]);
        const p = k.clone(s);
        const m = k.clone(s);
        if (i === n) {
          p.size += h;
          m.size -= h;
        } else {
          p.x[i] += h;
          m.x[i] -= h;
        }
        const fd = (k.energy(p) - k.energy(m)) / (2 * h);
        if (Math.abs(fd - g[i]) > gradTol * Math.max(1, Math.abs(fd), Math.abs(g[i])))
          fail(`gradient entry ${i === n ? "size" : i}: ${g[i]} against the difference quotient ${fd}`);
      }
    }
    // an overlap that clear() sees must show in the energy
    for (let i = 0; i < P; i++)
      if (!k.clear(s, i, 1e-9) && !(k.pieceEnergy(s, i) > 0)) {
        fail(`piece ${i} is not clear but its energy is 0`);
        break;
      }
    // weights scale the terms
    const w = new Float64Array(P).fill(2);
    if (e > 0 && !same(k.energy(s, undefined, w), 2 * e, 1e-9)) fail("weights of 2 do not double the energy");

    // finish gives a valid configuration with (about) zero energy, and a larger size keeps it so
    const r = k.clone(s);
    relax(k, r, { maxIter: 300 });
    const f = k.finish(r);
    if (f) {
      const v = k.validate(f.config);
      if (!v.valid) fail(`finish gave a configuration the validator rejects: ${v.reasons.join("; ")}`);
      if (v.score !== null && !same(v.score, f.score, 1e-12))
        fail(`finish states ${f.score}, the validator ${v.score}`);
      const fs = k.fromConfig(f.config);
      if (!fs) fail("fromConfig rejects a finished configuration");
      else {
        if (!same(fs.size, f.score, 1e-12)) fail(`a finished state's size ${fs.size} is not its score ${f.score}`);
        const ef = k.energy(fs);
        if (ef > zero) fail(`a finished configuration has energy ${ef}`);
        const big = k.clone(fs);
        k.setSize(big, fs.size * 1.1);
        // where growth may itself open overlaps (kernel.ts), a relaxation must close them
        if (k.growthMayOverlap) relax(k, big, { maxIter: 300 });
        const eb = k.energy(big);
        if (eb > Math.max(zero, ef))
          fail(
            `growing a finished state by 10%${k.growthMayOverlap ? " and relaxing it" : ""} left its energy at ${eb}`,
          );
      }
    } else if (t === 0) fail("finish found nothing from a relaxed random start");

    // soft shapes are inside the true ones, so softening never adds energy
    if (k.capabilities.includes("shape")) {
      if (!k.setShape) fail('the capability "shape" needs setShape');
      else {
        const hard = k.energy(s);
        for (const tt of [0, 0.5]) {
          const soft = k.clone(s);
          k.setShape(soft, tt);
          const es = k.energy(soft);
          if (es > hard * (1 + 1e-9) + 1e-12)
            fail(`the soft shape t = ${tt} has energy ${es}, above the true shape's ${hard}`);
          k.setShape(soft, 1);
          if (!same(k.energy(soft), hard, 1e-9)) fail("setShape(1) does not give back the true shape");
        }
      }
    }
    if (k.capabilities.includes("seeds")) {
      if (!k.seeds) fail('the capability "seeds" needs seeds');
      else
        for (const q of k.seeds(rng, 2) as KernelState[])
          if (q.x.length !== n || !(q.size > 0)) fail("seeds gave a malformed state");
    }
    if (k.capabilities.includes("swap")) {
      if (!k.swap) fail('the capability "swap" needs swap');
      else if (P > 1) {
        const q = k.clone(s);
        k.swap(q, 0, 1);
        k.swap(q, 0, 1);
        if (!same(k.toConfig(q), config)) fail("swapping twice does not give back the configuration");
      }
    }
  }
  return failures;
}
