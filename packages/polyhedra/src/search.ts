/**
 * The search of the polyhedra space: seeded, budgeted, stoppable and synchronous, for a browser worker or Node.
 *
 *  1. Start. A given configuration (any scale; an invalid one is first legalized by moving its pieces apart) is
 *     polished; without one, a soft-to-rigid run of the simulator (sim/sim.ts, ported from upstream) packs balls
 *     that harden into the solids, and its result is polished.
 *  2. Hops, until the budget ends: from the best configuration, either a soft hop of the simulator (expand by
 *     0.5-3 %, soften, shake until the arrangement changes, re-harden; upstream's gentle hop) or a jiggle (expand
 *     by 0.5-3 % and move and turn one to three pieces at random), then a polish. A hop result replaces the best
 *     when it is smaller.
 * Every configuration returned is legalized (polish.ts) and checked with the validator at tolerance 0.
 *
 * Budget: `maxEvals` counts simulator steps and polish function evaluations, so a run that ends on evaluations
 * is reproducible from its seed; `maxSeconds` and `shouldStop` end it earlier (polled at every evaluation).
 */
import { type Pose } from "./geom";
import { legalizeConfig, polishConfig, StopSearch } from "./polish";
import { getSolid } from "./solids";
import type { PolyhedraProblem } from "./problems";
import { gauss, hop, makeProblem, mulberry32, run } from "./sim/sim";
import { type PolyhedraConfig, validatePolyhedra } from "./validate";

export interface PolyhedraSearchOptions {
  seed: number;
  /** Configuration to start from (any scale). */
  start?: PolyhedraConfig;
  /** Most simulator steps plus polish evaluations; default 200,000. */
  maxEvals?: number;
  /** Wall-clock ceiling in seconds (makes the result depend on the machine); default none. */
  maxSeconds?: number;
  /** Polled at every evaluation: true ends the run with the best so far. */
  shouldStop?: () => boolean;
  /** Seconds, for maxSeconds; default performance.now() / 1000. */
  now?: () => number;
  /** Called after the start and after every hop. */
  onProgress?: (p: { score: number; evaluations: number; hops: number; improved: boolean }) => void;
  log?: (message: string) => void;
  /** Soft-to-rigid schedule of a fresh start (simulator steps); default scaled to P. */
  schedule?: { compact: number; morph: number; settle: number };
  /** Clearance kept between pieces and from the walls; default 1e-12. */
  clearance?: number;
}

export interface PolyhedraSearchResult {
  /** The best configuration found, valid by validatePolyhedra at tolerance 0, or null. */
  config: PolyhedraConfig | null;
  /** Its s; Infinity when there is none. */
  score: number;
  /** s of the polished start, or null without a start. */
  startScore: number | null;
  evaluations: number;
  hops: number;
  stopped: "evals" | "time" | "aborted" | "done";
}

/** Converts a simulator packing (internal units, container size L) to a configuration. */
function fromSim(scale: number, sOfL: (L: number) => number, C: number[][], Q: number[][], L: number): PolyhedraConfig {
  return {
    s: sOfL(L),
    pieces: C.map((c, i) => [c[0] / scale, c[1] / scale, c[2] / scale, Q[i][0], Q[i][1], Q[i][2], Q[i][3]] as Pose),
  };
}

export function searchPolyhedra(problem: PolyhedraProblem, P: number, o: PolyhedraSearchOptions): PolyhedraSearchResult {
  if (!Number.isInteger(P) || P < 1) throw new Error("P must be a positive integer");
  const maxEvals = o.maxEvals ?? 200_000;
  const clock = o.now ?? (() => performance.now() / 1000);
  const t0 = clock();
  const log = o.log ?? (() => {});
  const g = o.clearance ?? 1e-12;
  const rng = mulberry32((o.seed * 2654435761) | 0);
  let evaluations = 0;
  let stopped: PolyhedraSearchResult["stopped"] = "done";
  const tick = () => {
    evaluations++;
    if (evaluations > maxEvals) throw new StopSearch("evals");
    if ((evaluations & 63) === 0) {
      if (o.shouldStop?.()) throw new StopSearch("aborted");
      if (o.maxSeconds !== undefined && clock() - t0 > o.maxSeconds) throw new StopSearch("time");
    }
  };
  const pb = makeProblem(problem.piece, problem.container);
  const scale = pb.P.edge;
  let best: PolyhedraConfig | null = null;
  let hops = 0;
  const accept = (c: PolyhedraConfig | null, what: string): boolean => {
    if (!c) return false;
    const v = validatePolyhedra(problem, c, { tol: 0 });
    if (!v.valid) {
      log(`${what}: not valid after legalization (${v.errors[0]})`);
      return false;
    }
    if (best && !(c.s < best.s)) return false;
    best = c;
    log(`${what}: s = ${c.s}`);
    return true;
  };
  const polish = (c: PolyhedraConfig, mus?: number[]) => {
    const r = polishConfig(problem, c, { pairClearance: g, wallClearance: g, tick, mus });
    if (r.stopped) throw Object.assign(new StopSearch(r.stopped), { partial: r.config });
    return r.config;
  };
  let startScore: number | null = null;
  try {
    // 1. start
    if (o.start) {
      if (o.start.pieces.length !== P) throw new Error(`the start has ${o.start.pieces.length} pieces, not ${P}`);
      const legal = legalizeConfig(problem, o.start, g, g);
      accept(legal, "start");
      try {
        accept(polish(legal, [1e4, 1e5, 1e6, 1e7, 1e8, 1e9]), "polished start");
      } catch (e) {
        if (e instanceof StopSearch && (e as StopSearch & { partial?: PolyhedraConfig }).partial)
          accept((e as StopSearch & { partial?: PolyhedraConfig }).partial!, "partly polished start");
        throw e;
      }
      startScore = best ? (best as PolyhedraConfig).s : null;
    } else {
      let sch = o.schedule ?? {
        compact: Math.min(5000, 600 + 60 * P),
        morph: Math.min(45000, 4000 + 600 * P),
        settle: Math.min(3000, 500 + 50 * P),
      };
      // the run must finish within the budget to give anything: at most 40 % of maxEvals
      const total = sch.compact + sch.morph + sch.settle;
      if (total > 0.4 * maxEvals) {
        const f = (0.4 * maxEvals) / total;
        sch = { compact: Math.ceil(sch.compact * f), morph: Math.ceil(sch.morph * f), settle: Math.ceil(sch.settle * f) };
      }
      const r = run({ seed: o.seed, n: P, piece: problem.piece, container: problem.container, ...sch, tick });
      const fresh = fromSim(scale, pb.sOfL, r.final.C, r.final.Q, r.final.L);
      accept(legalizeConfig(problem, fresh, g, g), "fresh run");
      try {
        accept(polish(fresh), "polished fresh run");
      } catch (e) {
        if (e instanceof StopSearch && (e as StopSearch & { partial?: PolyhedraConfig }).partial)
          accept((e as StopSearch & { partial?: PolyhedraConfig }).partial!, "partly polished run");
        throw e;
      }
    }
    o.onProgress?.({ score: best ? (best as PolyhedraConfig).s : Infinity, evaluations, hops, improved: true });
    // 2. hops
    for (;;) {
      if (!best) throw new StopSearch("evals");
      const b: PolyhedraConfig = best;
      hops++;
      let cand: PolyhedraConfig;
      const soft = P > 1 && rng() < 0.5;
      if (soft) {
        const L = pb.LofS(b.s);
        const h = hop({
          piece: problem.piece,
          container: problem.container,
          C: b.pieces.map((p) => [p[0] * scale, p[1] * scale, p[2] * scale]),
          Q: b.pieces.map((p) => {
            const m = Math.hypot(p[3], p[4], p[5], p[6]);
            return [p[3] / m, p[4] / m, p[5] / m, p[6] / m];
          }),
          L,
          seed: (o.seed * 7919 + hops) | 0,
          expand: 0.005 + 0.025 * rng(),
          minDiff: 0.02 + 0.08 * rng(),
          rh: 0.06 + 0.14 * rng(),
          focus: rng() < 0.6 ? Math.max(2, Math.floor(P / 3)) : 0,
          morph: 3000 + 100 * P,
          settle: 800 + 20 * P,
          tick,
        });
        cand = fromSim(scale, pb.sOfL, h.C, h.Q, h.L);
      } else {
        const e = 1 + 0.005 + 0.025 * rng();
        const k = 1 + Math.floor(rng() * Math.min(3, P));
        const pieces = b.pieces.map((p) => [p[0] * e, p[1] * e, p[2] * e, p[3], p[4], p[5], p[6]] as Pose);
        const edge = getSolid(problem.piece).inradius;
        for (let t = 0; t < k; t++) {
          const i = Math.floor(rng() * P);
          const p = pieces[i];
          const a = 0.3 * rng();
          pieces[i] = [
            p[0] + edge * 0.5 * gauss(rng),
            p[1] + edge * 0.5 * gauss(rng),
            p[2] + edge * 0.5 * gauss(rng),
            p[3] + a * gauss(rng),
            p[4] + a * gauss(rng),
            p[5] + a * gauss(rng),
            p[6] + a * gauss(rng),
          ];
        }
        cand = { s: b.s * e, pieces };
      }
      let improved = false;
      try {
        improved = accept(polish(cand, soft ? undefined : [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9]), soft ? "soft hop" : "jiggle");
      } catch (e) {
        if (e instanceof StopSearch && (e as StopSearch & { partial?: PolyhedraConfig }).partial)
          accept((e as StopSearch & { partial?: PolyhedraConfig }).partial!, "partly polished hop");
        throw e;
      }
      o.onProgress?.({ score: (best as PolyhedraConfig | null)?.s ?? Infinity, evaluations, hops, improved });
    }
  } catch (e) {
    if (!(e instanceof StopSearch)) throw e;
    stopped = e.why;
  }
  const out = best as PolyhedraConfig | null;
  return { config: out, score: out ? out.s : Infinity, startScore, evaluations: Math.min(evaluations, maxEvals), hops, stopped };
}
