/**
 * Independent review of mc_compress (Phase 2 method 3). Tests marked "DEFECT" fail on the
 * reviewed commit 2d5b0d4 and describe a real fault; the others pin down what was found sound.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  boundingRadius,
  containerProtrusions,
  enclose,
  evaluate,
  findOverlaps,
  pieceSeparation,
  TOL,
  type Container,
  type PackingConfig,
} from "@polypack/geometry";
import { MethodRegistry, run, seededRandom, type MethodContext } from "../src/index";
import { executeCompression, mcCompressMethod, type CompressionObservation } from "../src/methods/mc_compress";
import { CompressionState, contained } from "../src/methods/mc_compress/state";
import { seedMethod } from "../src/methods/seed";

/** The lead's Phase 2 rule: a returned configuration may not live inside the 1e-9 validity tolerance. */
const SLACK = 1e-12;

function minSeparation(config: PackingConfig): number {
  let worst = Infinity;
  for (let i = 0; i < config.pieces.length; i++)
    for (let j = 0; j < i; j++)
      worst = Math.min(worst, pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep);
  return worst;
}

function maxProtrusion(config: PackingConfig, container: Container): number {
  let worst = -Infinity;
  for (const p of config.pieces)
    for (const c of containerProtrusions(config.N, p, container)) worst = Math.max(worst, c.depth);
  return worst;
}

function grid(N: number, M: number, P: number, gap = 2.5, ox = 0, oy = 0): PackingConfig {
  const width = Math.ceil(Math.sqrt(P));
  const step = gap * boundingRadius(N);
  return {
    N,
    M,
    P,
    container_phi: 0.17,
    pieces: Array.from({ length: P }, (_, i) => ({
      x: ox + step * (i % width),
      y: oy + step * Math.floor(i / width),
      theta: 0.23,
    })),
  };
}

/** Random valid start: pieces dropped one at a time into a box, keeping a small clearance. */
function scatter(N: number, M: number, P: number, half: number, seed: number): PackingConfig {
  const random = seededRandom(seed);
  const pieces: PackingConfig["pieces"] = [];
  while (pieces.length < P) {
    const p = {
      x: (2 * random() - 1) * half,
      y: (2 * random() - 1) * half,
      theta: N ? random() * 2 * Math.PI : 0,
    };
    if (!findOverlaps(N, [...pieces, p], -1e-3).length) pieces.push(p);
  }
  return { N, M, P, pieces, container_phi: 0 };
}

interface Probe {
  evaluated: number;
  invalid: number;
  minSep: number;
  maxProt: number;
  events: CompressionObservation[];
}

/** A registry whose "mc_probe" is mc_compress with its own evaluations and states recorded. */
function probe(keepEvents = false): { registry: MethodRegistry; log: Probe } {
  const log: Probe = { evaluated: 0, invalid: 0, minSep: Infinity, maxProt: -Infinity, events: [] };
  const registry = new MethodRegistry();
  registry.register(seedMethod);
  registry.register({
    ...mcCompressMethod,
    name: "mc_probe",
    doc: "docs/methods/mc_probe.md",
    execute: (ctx: MethodContext) =>
      executeCompression(
        {
          ...ctx,
          evaluate: async (config, options) => {
            const result = await ctx.evaluate(config, options);
            if (result) {
              log.evaluated++;
              if (!result.valid) log.invalid++;
            }
            return result;
          },
        },
        (event) => {
          log.minSep = Math.min(log.minSep, minSeparation(event.config));
          log.maxProt = Math.max(log.maxProt, maxProtrusion(event.config, event.container));
          if (keepEvents)
            log.events.push({
              ...event,
              config: { ...event.config, pieces: event.config.pieces.map((p) => ({ ...p })) },
            });
        },
      ),
  });
  return { registry, log };
}

describe("mc_compress review: tolerance exploitation", () => {
  // DEFECT: seven circles in a circle come back below the proven optimum 3 because pairs overlap by up to 1e-9.
  it("does not score below the proven optimum for seven circles in a circle", async () => {
    for (const seed of [1, 2, 3]) {
      const result = await run({ N: 0, M: 0, P: 7 }, { method: "mc_compress", budget: { evals: 1500 }, seed });
      expect(result.valid).toBe(true);
      expect(minSeparation(result.best!)).toBeGreaterThanOrEqual(-SLACK);
      expect(result.score!).toBeGreaterThanOrEqual(3 - 1e-11);
    }
  });

  // DEFECT: the same happens for polygons; five squares come back about 1.3e-9 below the honest value of the same contact graph.
  it("returns no pair separation below -1e-12 on the benchmark problems", async () => {
    for (const [N, M, P] of [
      [4, 4, 5],
      [0, 0, 19],
      [6, 6, 7],
    ]) {
      const result = await run({ N, M, P }, { method: "mc_compress", budget: { evals: 1500 }, seed: 2 });
      expect(result.valid).toBe(true);
      expect(minSeparation(result.best!), `N=${N} M=${M} P=${P}`).toBeGreaterThanOrEqual(-SLACK);
    }
  });

  // DEFECT: the initial bisection keeps the "non-overlapping" side under TOL, so it lands at separation -1e-9 at once.
  it("does not contract a loose supplied start into the tolerance band", async () => {
    const start: PackingConfig = {
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: -1.5, y: 0, theta: 0 },
        { x: 1.5, y: 0, theta: 0 },
      ],
    };
    // two evaluations: the start, then the state right after initialContraction
    const result = await run(
      { N: 0, M: 0, P: 2 },
      { method: "mc_compress", start, budget: { evals: 2 }, seed: 1, finalPolish: false },
    );
    expect(result.valid).toBe(true);
    expect(minSeparation(result.best!)).toBeGreaterThanOrEqual(-SLACK);
    expect(result.score!).toBeGreaterThanOrEqual(2 - 1e-11);
  });

  // DEFECT: the single-piece acceptance test admits a pair overlap of 5e-10 (CellGrid.clear compares with -TOL).
  it("rejects a single-piece move that overlaps a neighbour by half the tolerance", () => {
    const config: PackingConfig = {
      N: 0,
      M: 0,
      P: 2,
      container_phi: 0,
      pieces: [
        { x: -1, y: 0, theta: 0 },
        { x: 1, y: 0, theta: 0 },
      ],
    };
    const state = new CompressionState(config, { M: 0, cx: 0, cy: 0, size: 3, phi: 0 });
    expect(state.move(1, { x: 1 - TOL / 2, y: 0, theta: 0 })).toBe(false);
  });

  // DEFECT: the containment test admits a protrusion of 5e-10 (contained compares with +TOL).
  it("rejects a single-piece move that protrudes from the container by half the tolerance", () => {
    for (const M of [0, 4]) {
      const config: PackingConfig = { N: 0, M, P: 1, container_phi: 0, pieces: [{ x: 0, y: 0, theta: 0 }] };
      // circle of radius 1: a circular container of radius 2, or a square of side 4, leaves exactly 1 of room
      const container: Container = { M, cx: 0, cy: 0, size: M === 0 ? 2 : 4, phi: 0 };
      const state = new CompressionState(config, container);
      expect(state.move(0, { x: 1, y: 0, theta: 0 })).toBe(true);
      expect(state.move(0, { x: 1 + TOL / 2, y: 0, theta: 0 }), `M=${M}`).toBe(false);
    }
  });

  // DEFECT: every internal state of a jammed run sits at the edge of the tolerance, for separation and for protrusion.
  it("keeps its Markov chain states out of the tolerance band", async () => {
    const { registry, log } = probe();
    await registry.run(
      { N: 4, M: 4, P: 5 },
      { method: "mc_probe", budget: { evals: 800 }, seed: 3, finalPolish: false },
    );
    expect(log.minSep).toBeGreaterThanOrEqual(-SLACK);
    expect(log.maxProt).toBeLessThanOrEqual(SLACK);
  });
});

describe("mc_compress review: search behaviour", () => {
  // DEFECT: an overlapping start costs the seed sub-run its whole one-evaluation slice, so nothing valid is returned.
  it("returns a valid configuration from an overlapping start with a small evaluation budget", async () => {
    for (const evals of [3, 6, 12]) {
      const result = await run(
        { N: 4, M: 4, P: 5 },
        { method: "mc_compress", start: grid(4, 4, 5, 0.5), budget: { evals }, seed: 1, finalPolish: false },
      );
      expect(result.valid, `evals=${evals}, used ${result.evaluations}, ${result.termination}`).toBe(true);
    }
  });

  // Sound: I suspected thermal expansion dies with shrinkFraction (floor 1e-10 in a jam); at constant temperature it does not.
  it("offers thermal container expansions larger than the tolerance while the temperature is positive", async () => {
    const { registry, log } = probe(true);
    await registry.run(
      { N: 4, M: 4, P: 5 },
      {
        method: "mc_probe",
        budget: { evals: 1500 },
        seed: 4,
        finalPolish: false,
        params: { initialTemperature: 0.05, coolingRate: 1 },
      },
    );
    const late = log.events.slice(Math.floor(log.events.length / 2));
    let widest = 0;
    for (const event of late) {
      const tight = enclose(event.config.N, event.config.pieces, event.config.M, event.container.phi).size;
      widest = Math.max(widest, event.container.size / tight - 1);
    }
    // the temperature is constant at 0.05 in score units; room of one part in a million is a modest demand
    expect(late.at(-1)!.shrinkFraction).toBeGreaterThan(1e-8);
    expect(widest).toBeGreaterThan(1e-6);
  });

  it("improves a random scattered start substantially and never returns worse than the start", async () => {
    for (const [N, M, P, half, bound] of [
      [0, 0, 7, 3, 3.3],
      [0, 4, 10, 6.75, 7.6],
      [5, 5, 6, 2.62, 3.3],
    ]) {
      const start = scatter(N, M, P, half, 1000 + P);
      const before = evaluate(start, { autoOrient: true }).score!;
      const result = await run({ N, M, P }, { method: "mc_compress", start, budget: { evals: 1500 }, seed: 1 });
      expect(result.valid).toBe(true);
      expect(evaluate(result.best!, { autoOrient: false }).valid).toBe(true);
      expect(result.score!).toBeLessThanOrEqual(before);
      expect(result.score!, `N=${N} M=${M} P=${P} from ${before}`).toBeLessThan(bound);
    }
  });
});

describe("mc_compress review: bookkeeping found sound", () => {
  it("never submits a candidate that the shared geometry calls invalid, for all kind combinations", async () => {
    let evaluated = 0;
    for (const [N, M, P] of [
      [0, 0, 12],
      [0, 5, 7],
      [4, 0, 7],
      [3, 3, 9],
      [7, 5, 8],
      [20, 20, 6],
      [0, 20, 6],
      [20, 0, 6],
      [13, 17, 7],
    ]) {
      for (const temperature of [0, 0.05]) {
        const { registry, log } = probe();
        const result = await registry.run(
          { N, M, P },
          {
            method: "mc_probe",
            budget: { evals: 250 },
            seed: 5 + N + M,
            finalPolish: false,
            params: { initialTemperature: temperature, orientEvery: 2, shrinkEvery: 1 },
          },
        );
        expect(result.termination, result.reasons.join("; ")).toBe("evals");
        expect(log.invalid).toBe(0);
        // the chain's own invariant: within the shared tolerance of its explicit container at every observation
        expect(log.minSep).toBeGreaterThanOrEqual(-TOL);
        expect(log.maxProt).toBeLessThanOrEqual(TOL);
        evaluated += log.evaluated;
      }
    }
    expect(evaluated).toBeGreaterThan(4000);
  });

  it("agrees with the full vertex-by-edge containment test for N and M up to 20", () => {
    const kind = fc.oneof(fc.constant(0), fc.integer({ min: 3, max: 20 }));
    fc.assert(
      fc.property(
        kind,
        kind,
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.double({ min: -7, max: 7, noNaN: true }),
        fc.double({ min: -7, max: 7, noNaN: true }),
        fc.double({ min: 0.2, max: 6, noNaN: true }),
        (N, M, x, y, theta, phi, size) => {
          const pose = { x, y, theta };
          const container: Container = { M, cx: 0.3, cy: -0.2, size, phi };
          const depth = Math.max(...containerProtrusions(N, pose, container).map((c) => c.depth));
          if (Math.abs(depth - TOL) < 1e-11) return;
          expect(contained(N, pose, container)).toBe(depth <= TOL);
        },
      ),
      { numRuns: 4000, seed: 20261009 },
    );
  });

  it("contracts about the container centre and re-encloses, so a shrink never leaves the container", () => {
    for (const [N, M] of [
      [0, 0],
      [0, 3],
      [5, 0],
      [4, 7],
      [20, 20],
    ]) {
      const start = grid(N, M, 9, 2.6, 40, -25);
      const state = new CompressionState(start, enclose(N, start.pieces, M, 0.4));
      const random = seededRandom(9);
      for (let k = 0; k < 60; k++) {
        const trial = state.contracted(1 - 0.02 * random());
        const before = state.container.size;
        const accepted = state.replace(trial, enclose(N, trial.pieces, M, state.container.phi), 0, random);
        if (accepted) expect(state.container.size).toBeLessThanOrEqual(before);
        expect(findOverlaps(N, state.config.pieces)).toHaveLength(0);
        expect(maxProtrusion(state.config, state.container)).toBeLessThanOrEqual(TOL);
        expect(state.config.container_phi).toBe(state.container.phi);
      }
      // the pieces really moved towards one another
      expect(state.container.size).toBeLessThan(enclose(N, start.pieces, M, 0.4).size * 0.95);
    }
  });
});

describe("mc_compress review: budgets, determinism and safety found sound", () => {
  it("is bit-identical for a seed and uses an evaluation budget exactly", async () => {
    for (const [N, M, P] of [
      [4, 4, 5],
      [7, 0, 6],
    ]) {
      for (const start of [undefined, grid(N, M, P)]) {
        const options = {
          method: "mc_compress",
          start,
          budget: { evals: 400 },
          seed: 11,
          finalPolish: false,
          params: { initialTemperature: 0.05 },
        };
        const a = await run({ N, M, P }, options);
        const b = await run({ N, M, P }, options);
        expect(a.evaluations).toBe(400);
        expect(JSON.stringify(a.best)).toBe(JSON.stringify(b.best));
        expect(a.score).toBe(b.score);
        // without a start both seeds may return the same seed-generator configuration, so compare only with one
        const c = await run({ N, M, P }, { ...options, seed: 12 });
        if (start) expect(JSON.stringify(c.best)).not.toBe(JSON.stringify(a.best));
      }
    }
  });

  it("stops within a time budget and within a second of an abort at P = 300", async () => {
    const timed = await run({ N: 6, M: 6, P: 300 }, { method: "mc_compress", budget: { time_s: 0.3 }, seed: 1 });
    expect(timed.valid).toBe(true);
    expect(timed.wallTime).toBeLessThan(0.6);
    const control = { aborted: false };
    let abortedAt = 0;
    setTimeout(() => {
      control.aborted = true;
      abortedAt = performance.now();
    }, 150);
    const aborted = await run(
      { N: 6, M: 6, P: 300 },
      {
        method: "mc_compress",
        start: grid(6, 6, 300),
        budget: { time_s: 30 },
        seed: 1,
        control,
        params: { sweepsPerEvaluation: 1000, shrinkEvery: 1000, orientEvery: 1000 },
      },
    );
    expect(aborted.termination).toBe("aborted");
    expect(aborted.valid).toBe(true);
    expect(performance.now() - abortedAt).toBeLessThan(1000);
  });

  it("returns valid results for one and two pieces, large N and M, bad starts and far starts", async () => {
    const cases: [number, number, number, PackingConfig | undefined][] = [
      [0, 0, 1, undefined],
      [5, 7, 1, grid(5, 7, 1)],
      [0, 3, 2, undefined],
      [3, 0, 2, grid(3, 0, 2)],
      [0, 3, 5, undefined],
      [40, 40, 3, grid(40, 40, 3)],
      [4, 4, 7, grid(4, 4, 7, 0.5)],
      [4, 4, 7, { ...grid(4, 4, 7), pieces: Array.from({ length: 7 }, () => ({ x: 1, y: 1, theta: 0 })) }],
      [4, 4, 7, grid(4, 4, 7, 2.5, 9e5, -9e5)],
    ];
    for (const [N, M, P, start] of cases) {
      const result = await run({ N, M, P }, { method: "mc_compress", start, budget: { evals: 150 }, seed: 1 });
      expect(result.termination, result.reasons.join("; ")).not.toBe("error");
      expect(result.valid).toBe(true);
      expect(result.best!.pieces).toHaveLength(P);
      const check = evaluate(result.best!, { autoOrient: false });
      expect(check.valid).toBe(true);
      expect(check.score).toBe(result.score);
      const before = start ? evaluate(start, { autoOrient: true }) : undefined;
      if (before?.valid) expect(result.score!).toBeLessThanOrEqual(before.score!);
    }
  });

  it("accepts every parameter at both ends of its schema range", async () => {
    const properties = mcCompressMethod.schema.properties!;
    for (const [name, schema] of Object.entries(properties)) {
      expect(schema.title && schema.description, name).toBeTruthy();
      for (const value of [schema.minimum!, schema.maximum!]) {
        const result = await run(
          { N: 5, M: 5, P: 4 },
          { method: "mc_compress", budget: { evals: 60 }, seed: 1, params: { [name]: value } },
        );
        expect(result.termination, `${name}=${value}: ${result.reasons.join("; ")}`).not.toBe("error");
        expect(result.valid, `${name}=${value}`).toBe(true);
      }
    }
  });
});
