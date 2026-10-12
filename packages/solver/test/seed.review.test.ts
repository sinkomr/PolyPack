/**
 * Independent review of Phase 2 method 8, "Lattice and symmetry seeds" (`seed`).
 *
 * Tests in the "defects" block fail against the reviewed code on purpose. Each carries a
 * one-line DEFECT comment naming what is wrong. All other tests document behaviour that was
 * checked and found sound.
 */
import { evaluate, findOverlaps, pieceArea, pieceSeparation, type PackingConfig } from "@polypack/geometry";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MethodRegistry, run, seededRandom, type MethodContext, type Problem, type Result } from "../src";
import { seedMethod } from "../src/methods/seed";
import { automaticTheta, baseCell, pentagonCell, rotate, tightScale } from "../src/methods/seed/lattice";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface Collected {
  candidates: PackingConfig[];
  emitted: PackingConfig[];
  error?: string;
  stopChecks: number;
}

/**
 * Runs the method against a mock context that records EVERY candidate (the framework only
 * returns the best one) and checks validity without the cost of container auto-orientation.
 */
async function collect(problem: Problem, params: Record<string, unknown>, seed = 17): Promise<Collected> {
  const out: Collected = { candidates: [], emitted: [], stopChecks: 0 };
  const assess = (c: PackingConfig) => {
    const bad =
      c.pieces.length !== problem.P ||
      c.pieces.some((p) => !Number.isFinite(p.x + p.y + p.theta) || Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) ||
      findOverlaps(c.N, c.pieces).length > 0;
    return {
      valid: !bad,
      reasons: bad ? ["review harness: wrong count, non-finite pose or overlap"] : [],
      overlaps: [],
      container: { M: c.M, size: 1, phi: 0, x: 0, y: 0 },
      score: 1,
    };
  };
  const ctx = {
    problem,
    start: undefined,
    starts: [],
    params: { ...seedMethod.defaults, ...params },
    random: seededRandom(seed),
    shouldStop: () => {
      out.stopChecks++;
      return false;
    },
    checkpoint: async () => true,
    evaluate: async (c: PackingConfig) => {
      out.candidates.push(c);
      return assess(c);
    },
    emit: async (c: PackingConfig) => {
      out.emitted.push(c);
      return assess(c);
    },
    run: async () => {
      throw new Error("not used");
    },
  } as unknown as MethodContext;
  try {
    await seedMethod.execute(ctx);
  } catch (error) {
    out.error = (error as Error).message;
  }
  return out;
}

function generate(problem: Problem, kind: string, params: Record<string, unknown> = {}, evals = 1000, seed = 17) {
  return run(problem, {
    method: "seed",
    params: { kind, poolLimit: 0, ...params },
    budget: { evals },
    seed,
    finalPolish: false,
  });
}

function expectValid(result: Result, P: number): PackingConfig {
  expect(result.reasons).toEqual([]);
  expect(result.valid).toBe(true);
  expect(result.best!.pieces).toHaveLength(P);
  const check = evaluate(result.best!, { autoOrient: true });
  expect(check.valid).toBe(true);
  expect(check.score).toBeCloseTo(result.score!, 9);
  return result.best!;
}

/** Separating-axis test written here, so the pentagon check does not lean on shared geometry. */
function ownSeparation(a: number[][], b: number[][]): number {
  let best = -Infinity;
  for (const [p, q] of [
    [a, b],
    [b, a],
  ]) {
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i];
      const [x2, y2] = p[(i + 1) % p.length];
      const nx = y2 - y1;
      const ny = x1 - x2;
      const length = Math.hypot(nx, ny);
      let least = Infinity;
      for (const [x, y] of q) least = Math.min(least, ((x - x1) * nx + (y - y1) * ny) / length);
      best = Math.max(best, least);
    }
  }
  return best;
}

function ownPentagon(x: number, y: number, up: boolean): number[][] {
  const R = 1 / (2 * Math.sin(Math.PI / 5));
  return Array.from({ length: 5 }, (_, k) => {
    const angle = (up ? 1 : -1) * (Math.PI / 2) + (2 * Math.PI * k) / 5;
    return [x + R * Math.cos(angle), y + R * Math.sin(angle)];
  });
}

const quiet = { checkpoint: async () => true, shouldStop: () => false };
const spacingContext = (N: number) => ({ ...quiet, problem: { N, M: 0, P: 1 } }) as unknown as MethodContext;

// ---------------------------------------------------------------------------------------------
// Checked and found sound
// ---------------------------------------------------------------------------------------------

describe("seed review: sound behaviour", () => {
  it("every candidate of every generator is valid, or the generator declines with a reason", async () => {
    const reasons = new Set<string>();
    let candidates = 0;
    for (const N of [0, 3, 4, 5, 7, 12, 100]) {
      for (const M of [0, 3, 5, 12, 100]) {
        for (const P of [1, 2, 3, 7, 13, 30, 100]) {
          for (const kind of ["square_lattice", "hex_lattice", "pentagon_double_lattice", "rings", "rows"]) {
            if (kind === "rings" && N === 100 && P === 100) continue; // minutes; see the defect block
            const result = await collect({ N, M, P }, { kind, trials: 2, poolLimit: 0 });
            candidates += result.candidates.length;
            if (result.error) {
              expect(result.error).not.toMatch(/invalid geometry|review harness/);
              expect(result.candidates).toHaveLength(0);
              reasons.add(result.error);
            } else expect(result.candidates.length).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(candidates).toBeGreaterThan(1500);
    // Exactly the four documented applicability refusals, nothing else.
    expect([...reasons].sort()).toEqual([
      "D_M rings require P to be a multiple of M, or one more than a multiple of M",
      "a central polygon has D_M symmetry only when M divides N",
      "pentagon_double_lattice applies only to N = 5",
    ]);
  }, 60000);

  it("stays valid at the edges of the parameter schema", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          N: fc.constantFrom(0, 3, 4, 5, 6, 7, 12),
          M: fc.constantFrom(0, 3, 4, 5, 6, 12),
          P: fc.constantFrom(1, 2, 3, 5, 7, 12, 13, 24, 31),
          kind: fc.constantFrom("square_lattice", "hex_lattice", "pentagon_double_lattice", "rings", "rows", "auto"),
          trials: fc.constantFrom(1, 2, 5),
          orientation: fc.constantFrom(0, -2 * Math.PI, 2 * Math.PI, 1e-9, 0.3, -2.9),
          automaticOrientation: fc.boolean(),
          latticeAngle: fc.constantFrom(0, -2 * Math.PI, 2 * Math.PI, 1.1),
          angleRange: fc.constantFrom(0, Math.PI / 2, 2 * Math.PI),
          orientationRange: fc.constantFrom(0, 0.4, Math.PI),
          offsetRange: fc.constantFrom(0, 0.37, 1),
          perRow: fc.constantFrom(0, 1, 2, 3, 7, 500),
          alternateRows: fc.boolean(),
          perRing: fc.constantFrom(0, 1, 5, 6, 12, 500),
          poolLimit: fc.constantFrom(0, 1, 64),
        }),
        fc.integer({ min: 0, max: 1e6 }),
        async ({ N, M, P, ...params }, seed) => {
          const result = await collect({ N, M, P }, params, seed);
          if (result.error) {
            expect(result.error).toMatch(/applies only to N = 5|rings require|central polygon/);
            if (params.kind === "auto") throw new Error(`auto must skip, not fail: ${result.error}`);
          } else expect(result.candidates.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300, seed: 20261009 },
    );
  }, 60000);

  it("P = 500 lattice, row and pentagon cuts finish quickly and are valid", async () => {
    for (const [N, M, kind] of [
      [0, 0, "hex_lattice"],
      [3, 3, "square_lattice"],
      [4, 4, "rows"],
      [5, 0, "pentagon_double_lattice"],
      [100, 0, "hex_lattice"],
      [0, 0, "rings"],
    ] as [number, number, string][]) {
      const begun = performance.now();
      const result = await collect({ N, M, P: 500 }, { kind, trials: 1, poolLimit: 0 });
      expect(result.error).toBeUndefined();
      expect(result.candidates).toHaveLength(1);
      expect(performance.now() - begun).toBeLessThan(3000);
    }
  }, 30000);

  it("lattice spacing from the shared geometry gives the textbook densities", async () => {
    const density = async (N: number, hex: boolean) => {
      const cell = baseCell(N, hex, automaticTheta(N));
      if (hex && N === 6) {
        for (const key of ["a", "b"] as const) {
          const v = rotate({ x: cell[key][0], y: cell[key][1], theta: 0 }, Math.PI / 6);
          cell[key] = [v.x, v.y];
        }
      }
      const scale = (await tightScale(spacingContext(N), cell))!;
      const area = Math.abs(cell.a[0] * cell.b[1] - cell.a[1] * cell.b[0]) * scale * scale;
      return (cell.motif.length * pieceArea(N)) / area;
    };
    expect(await density(0, true)).toBeCloseTo(Math.PI / (2 * Math.sqrt(3)), 9);
    expect(await density(0, false)).toBeCloseTo(Math.PI / 4, 9);
    expect(await density(4, false)).toBeCloseTo(1, 9);
    expect(await density(3, true)).toBeCloseTo(1, 9);
    expect(await density(3, false)).toBeCloseTo(1, 9);
    expect(await density(6, true)).toBeCloseTo(1, 9);
    expect(await density(8, false)).toBeCloseTo(2 * Math.SQRT2 - 2, 9); // best square lattice of octagons
    // Measured, for the record: default orientations give pentagons 0.6572 / 0.7588 and
    // heptagons 0.7197 / 0.8311 on the square / hexagonal lattice.
    expect(await density(5, false)).toBeCloseTo(0.657164, 5);
    expect(await density(5, true)).toBeCloseTo(0.758827, 5);
    expect(await density(7, false)).toBeCloseTo(0.719741, 5);
    expect(await density(7, true)).toBeCloseTo(0.831085, 5);
  });

  it("the pentagon cell is the Kuperberg double lattice, rederived without the author's formulas", () => {
    const R = 1 / (2 * Math.sin(Math.PI / 5));
    const H = R + R * Math.cos(Math.PI / 5); // pentagon height = pitch of a vertex-to-edge column
    // Hales and Kusner: aligned columns of upward pentagons alternate with columns of downward
    // ones. Slide a downward column against an upward one and minimise the column pitch.
    const pitch = (dy: number) => {
      let lo = 0;
      let hi = 3;
      for (let step = 0; step < 50; step++) {
        const mid = (lo + hi) / 2;
        let free = true;
        for (let k = -3; k <= 3 && free; k++)
          free = ownSeparation(ownPentagon(0, 0, true), ownPentagon(mid, dy + k * H, false)) >= 0;
        if (free) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    let best = { dx: Infinity, dy: 0 };
    for (let i = 0; i < 4000; i++) {
      const dy = (i / 4000) * H;
      const dx = pitch(dy);
      if (dx < best.dx) best = { dx, dy };
    }
    const cell = pentagonCell();
    expect(cell.a[0]).toBeCloseTo(2 * best.dx, 3);
    expect(cell.b[0]).toBe(0);
    expect(cell.b[1]).toBeCloseTo(H, 12);
    expect(cell.motif[1].x).toBeCloseTo(best.dx, 3);
    expect(cell.motif[1].y).toBeCloseTo(best.dy, 3);
    // Two orientations related by a half turn, each on the same lattice: a double lattice.
    expect(cell.motif.map((p) => p.theta)).toEqual([0, Math.PI]);
    const area = Math.abs(cell.a[0] * cell.b[1] - cell.a[1] * cell.b[0]);
    expect((2 * 5) / (4 * Math.tan(Math.PI / 5)) / area).toBeCloseTo((5 - Math.sqrt(5)) / 3, 12);
    // No overlap over a 25 x 25 cell patch, and six contacts per pentagon, with the local SAT.
    const patch: { x: number; y: number; up: boolean }[] = [];
    for (let i = -12; i <= 12; i++)
      for (let j = -12; j <= 12; j++)
        for (const m of cell.motif) patch.push({ x: i * cell.a[0] + m.x, y: j * cell.b[1] + m.y, up: m.theta === 0 });
    for (const m of cell.motif) {
      let contacts = 0;
      for (const q of patch) {
        const distance = Math.hypot(q.x - m.x, q.y - m.y);
        if (distance === 0 || distance > 2 * R + 1e-9) continue;
        const sep = ownSeparation(ownPentagon(m.x, m.y, m.theta === 0), ownPentagon(q.x, q.y, q.up));
        expect(sep).toBeGreaterThan(-1e-12);
        if (sep < 1e-9) contacts++;
      }
      expect(contacts).toBe(6);
    }
  });

  it("a generated 500-pentagon cut has the double-lattice density in its interior", async () => {
    const { candidates } = await collect({ N: 5, M: 0, P: 500 }, { kind: "pentagon_double_lattice", trials: 1 });
    const distances = candidates[0].pieces.map((p) => Math.hypot(p.x, p.y)).sort((a, b) => a - b);
    let sum = 0;
    let samples = 0;
    for (let f = 0.7; f <= 1.0001; f += 0.002) {
      const radius = distances[300] * f;
      sum += (distances.filter((d) => d <= radius).length * pieceArea(5)) / (Math.PI * radius * radius);
      samples++;
    }
    expect(sum / samples).toBeGreaterThan(0.915);
    expect(sum / samples).toBeLessThan(0.928);
    expect(new Set(candidates[0].pieces.map((p) => p.theta)).size).toBe(2);
  });

  it("reaches the known exact answers", async () => {
    const s3 = Math.sqrt(3);
    for (const [N, M, P, exact] of [
      [4, 4, 25, 5],
      [4, 4, 100, 10],
      [3, 3, 25, 5],
      [3, 3, 100, 10],
      [0, 0, 7, 3],
      [0, 0, 19, 1 + Math.SQRT2 + Math.sqrt(6)],
      [6, 6, 7, 5 / s3],
      [0, 3, 3, 2 + 2 * s3],
      [0, 3, 6, 4 + 2 * s3],
      [0, 3, 10, 6 + 2 * s3],
      [0, 3, 21, 10 + 2 * s3],
      [3, 6, 24, 2],
      [0, 4, 9, 6],
    ]) {
      const result = await generate({ N, M, P }, "auto");
      expectValid(result, P);
      expect(result.score).toBeCloseTo(exact, 8);
    }
  }, 30000);

  it("reproduces the author's measured table (seed 17, evals 1000, defaults, no polish)", async () => {
    for (const [N, M, P, claimed] of [
      [4, 4, 5, 2.828427],
      [4, 4, 10, 4.0],
      [4, 4, 17, 4.949747],
      [0, 0, 7, 3.0],
      [0, 0, 19, 4.863703],
      [5, 5, 6, 2.809017],
      [6, 6, 7, 2.886751],
    ]) {
      const result = await run({ N, M, P }, { method: "seed", budget: { evals: 1000 }, seed: 17, finalPolish: false });
      expectValid(result, P);
      expect(Math.abs(result.score! - claimed)).toBeLessThan(1e-6);
    }
  });

  it("the sampled cut matches an exhaustive scan of offsets on small circle cases", async () => {
    // Any optimal P-subset of a lattice is the set of sites inside some placed container, so a
    // scan over the offset of a concentric cut covers the whole family for a circular container.
    for (const P of [4, 8, 12, 14, 24]) {
      let brute = Infinity;
      for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 12; j++) {
          const sites: { x: number; y: number; theta: number }[] = [];
          for (let a = -6; a <= 6; a++)
            for (let b = -6; b <= 6; b++)
              sites.push({ x: 2 * (a + i / 12) + (b + j / 12), y: Math.sqrt(3) * (b + j / 12), theta: 0 });
          sites.sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y));
          brute = Math.min(brute, evaluate({ N: 0, M: 0, P, pieces: sites.slice(0, P), container_phi: 0 }).score!);
        }
      }
      const result = await generate({ N: 0, M: 0, P }, "hex_lattice");
      expect(result.score!).toBeLessThanOrEqual(brute + 1e-9);
    }
  }, 30000);

  it("record generators keep the record, give the right count and reject bad records clearly", async () => {
    const record = expectValid(await generate({ N: 0, M: 0, P: 7 }, "auto"), 7);
    const plus = expectValid(await generate({ N: 0, M: 0, P: 8 }, "record_plus_one", { record }), 8);
    expect(plus.pieces.slice(0, 7)).toEqual(record.pieces);
    const gap = Math.min(...record.pieces.map((p) => pieceSeparation(0, p, plus.pieces[7]).sep));
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(1e-9); // small record: the added circle touches the cluster
    const minus = await generate({ N: 0, M: 0, P: 6 }, "record_minus_one", { record });
    expectValid(minus, 6);
    const expected = Math.min(
      ...record.pieces.map(
        (_, k) => evaluate({ ...record, P: 6, pieces: record.pieces.filter((_, i) => i !== k) }).score!,
      ),
    );
    expect(minus.score).toBeCloseTo(expected, 12);
    for (const [kind, P, bad, message] of [
      ["record_plus_one", 8, undefined, /record/],
      ["record_plus_one", 7, record, /exactly 6 pieces/],
      ["record_plus_one", 6, record, /exactly 5 pieces/],
      ["record_minus_one", 8, record, /exactly 9 pieces/],
      ["record_plus_one", 8, { ...record, N: 4 }, /N and M must match/],
      ["record_minus_one", 6, { ...record, M: 4 }, /N and M must match/],
      // The wording here is misleading (it names the problem count, 9), but it is a clean refusal.
      ["record_plus_one", 9, { ...record, P: 8 }, /record must contain exactly/],
      ["record_plus_one", 8, { ...record, pieces: record.pieces.map(() => ({ x: 0, y: 0 })) }, /overlapping/],
      ["record_plus_one", 8, { ...record, pieces: record.pieces.map((p) => ({ ...p, x: p.x + 2e6 })) }, /limit/],
      ["auto", 7, record, /P−1 or P\+1/],
    ] as [string, number, unknown, RegExp][]) {
      const result = await generate({ N: 0, M: 0, P }, kind, bad === undefined ? {} : { record: bad }, 50);
      expect(result.termination).toBe("error");
      expect(result.evaluations).toBe(0);
      expect(result.reasons.join()).toMatch(message);
    }
  });

  it("is deterministic and spends exactly the evaluation budget", async () => {
    for (const problem of [
      { N: 5, M: 5, P: 11 },
      { N: 0, M: 0, P: 19 },
      { N: 3, M: 4, P: 13 },
    ]) {
      for (const evals of [1, 2, 3, 5, 8, 13, 21, 40]) {
        const options = { method: "seed", budget: { evals }, seed: 5, finalPolish: false };
        const a = await run(problem, options);
        const b = await run(problem, options);
        expectValid(a, problem.P);
        expect(a.evaluations).toBe(evals);
        expect(b.best).toEqual(a.best);
        expect(b.score).toBe(a.score);
      }
    }
  });

  it("auto is never worse than a single generator given an equal share of evaluations", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.constantFrom(0, 3, 4, 5, 6),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 9 }),
        fc.constantFrom(0, 1, 3, 8),
        fc.constantFrom(1, 4, 12),
        async (N, M, P, share, poolLimit, trials) => {
          const singles: Result[] = [];
          for (const kind of ["square_lattice", "hex_lattice", "pentagon_double_lattice", "rings", "rows"]) {
            const single = await generate({ N, M, P }, kind, { poolLimit, trials }, share);
            if (single.valid) singles.push(single);
          }
          const auto = await generate({ N, M, P }, "auto", { poolLimit, trials }, share * singles.length);
          for (const single of singles) expect(auto.score!).toBeLessThanOrEqual(single.score! + 1e-9);
        },
      ),
      { numRuns: 40, seed: 8 },
    );
  }, 60000);

  it("emitted seeds reach the next stage valid, and an abort returns at once with a valid best", async () => {
    const own = new MethodRegistry();
    own.register(seedMethod);
    let received: readonly PackingConfig[] = [];
    own.register({
      name: "inspect",
      doc: "docs/methods/inspect.md",
      schema: { type: "object" },
      defaults: {},
      async execute(ctx) {
        received = ctx.starts;
      },
    });
    await own.runPipeline(
      { N: 5, M: 0, P: 30 },
      { stages: [{ method: "seed" }, { method: "inspect" }] },
      { seed: 17, budget: { evals: 1000 }, finalPolish: false },
    );
    expect(received).toHaveLength(8);
    for (const start of received) {
      expect(start.pieces).toHaveLength(30);
      expect(evaluate(start).valid).toBe(true);
    }
    expect(new Set(received.map((c) => JSON.stringify(c.pieces))).size).toBe(8);
    const control = { aborted: false };
    const begun = performance.now();
    setTimeout(() => (control.aborted = true), 200);
    const stopped = await run(
      { N: 3, M: 3, P: 500 },
      { method: "seed", params: { trials: 256 }, budget: { evals: 100000 }, seed: 3, control, finalPolish: false },
    );
    expect(stopped.termination).toBe("aborted");
    expect(stopped.valid).toBe(true);
    expect(performance.now() - begun).toBeLessThan(1200);
  });
});

// ---------------------------------------------------------------------------------------------
// Defects: these fail against the reviewed code
// ---------------------------------------------------------------------------------------------

describe("seed review: defects", () => {
  it("rings produce a first candidate within a one-second time budget at P = 500", async () => {
    // DEFECT: rings test every new piece against all placed pieces with full SAT and no distance filter; one N=100 trial takes about 30 s.
    const result = await run(
      { N: 100, M: 0, P: 500 },
      { method: "seed", params: { kind: "rings" }, budget: { time_s: 1 }, seed: 3, finalPolish: false },
    );
    expect(result.valid).toBe(true);
  }, 20000);

  it("auto is not starved by the ring generator under a time budget", async () => {
    // DEFECT: round-robin auto blocks on the slow ring generation, so 1 s yields only the first two lattice candidates.
    const result = await run(
      { N: 20, M: 0, P: 500 },
      { method: "seed", params: { poolLimit: 0 }, budget: { time_s: 1 }, seed: 3, finalPolish: false },
    );
    expect(result.evaluations).toBeGreaterThanOrEqual(8);
  }, 20000);

  it("does not recompute an unchanged lattice spacing for every trial", async () => {
    // DEFECT: tightScale reruns 81 x motif^2 x 44 SAT bisections per trial although the cell is identical; this is the triangle slowdown.
    const one = await collect({ N: 3, M: 4, P: 30 }, { kind: "square_lattice", trials: 1, poolLimit: 0 });
    const twelve = await collect({ N: 3, M: 4, P: 30 }, { kind: "square_lattice", trials: 12, poolLimit: 0 });
    // The reviewed code spent over 50,000 stop checks on one spacing. After the fix (pruned
    // translations and a cache) one spacing is far cheaper, so only the ratio is asserted.
    expect(one.stopChecks).toBeGreaterThan(0);
    expect(twelve.stopChecks).toBeLessThan(2 * one.stopChecks);
  });

  it("passes distinct seeds to the next pipeline stage", async () => {
    // DEFECT: the pool is never deduplicated; square, hex and rows emit the same triangle block and the tail repeats one score.
    const own = new MethodRegistry();
    own.register(seedMethod);
    let received: readonly PackingConfig[] = [];
    own.register({
      name: "inspect",
      doc: "docs/methods/inspect.md",
      schema: { type: "object" },
      defaults: {},
      async execute(ctx) {
        received = ctx.starts;
      },
    });
    await own.runPipeline(
      { N: 3, M: 3, P: 4 },
      { stages: [{ method: "seed" }, { method: "inspect" }] },
      { seed: 17, budget: { evals: 1000 }, finalPolish: false },
    );
    expect(received.length).toBeGreaterThan(1);
    expect(new Set(received.map((c) => JSON.stringify(c.pieces))).size).toBe(received.length);
  });

  it("alternateRows shifts alternate rows, so the third row lines up with the first", async () => {
    // DEFECT: the stagger is a cumulative shear (row * half step), and the row pitch stays at the square value, so it is never denser.
    const { candidates } = await collect(
      { N: 0, M: 4, P: 9 },
      { kind: "rows", perRow: 3, alternateRows: true, trials: 1, poolLimit: 0 },
    );
    const rows = new Map<string, number[]>();
    for (const p of candidates[0].pieces) rows.set(p.y.toFixed(6), [...(rows.get(p.y.toFixed(6)) ?? []), p.x]);
    const starts = [...rows.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, xs]) => Math.min(...xs));
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeCloseTo(1, 6); // half of the circle pitch 2: correct
    expect(starts[2] - starts[0]).toBeCloseTo(0, 6);
  });

  it("hexagons on the hex lattice touch along faces for an explicit piece orientation too", async () => {
    // DEFECT: the basis is turned by a fixed pi/6 that assumes the default orientation; with theta = 0 the lattice is vertex to vertex (density 0.75).
    const { candidates } = await collect(
      { N: 6, M: 0, P: 7 },
      { kind: "hex_lattice", automaticOrientation: false, trials: 1, poolLimit: 0 },
    );
    const pieces = candidates[0].pieces;
    let nearest = Infinity;
    for (let i = 0; i < pieces.length; i++)
      for (let j = 0; j < i; j++)
        nearest = Math.min(nearest, Math.hypot(pieces[i].x - pieces[j].x, pieces[i].y - pieces[j].y));
    expect(nearest).toBeCloseTo(Math.sqrt(3), 6);
  });

  it("record_plus_one puts the new piece in contact with a large record", async () => {
    // DEFECT: with record.P >= recordTrials only the first (innermost) pieces get one direction each; every contact try is blocked and only loose exterior fallbacks remain.
    const record = expectValid(await generate({ N: 0, M: 0, P: 200 }, "auto"), 200);
    const added = expectValid(await generate({ N: 0, M: 0, P: 201 }, "record_plus_one", { record }), 201).pieces[200];
    const gap = Math.min(...record.pieces.map((p) => pieceSeparation(0, p, added).sep));
    expect(gap).toBeLessThan(1e-6);
  }, 20000);
});
