import { evaluate, findOverlaps, pieceArea, pieceSeparation, type PackingConfig } from "@polypack/geometry";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MethodRegistry, registry, run, type MethodContext, type Problem, type Result } from "../src";
import { seedKinds, seedMethod } from "../src/methods/seed";
import { baseCell, pentagonCell, rotate, SpacingCache } from "../src/methods/seed/lattice";

async function generate(
  problem: Problem,
  kind = "auto",
  params: Record<string, unknown> = {},
  evals = 150,
): Promise<Result> {
  return run(problem, {
    method: "seed",
    params: { kind, trials: 4, poolLimit: 0, ...params },
    budget: { evals },
    seed: 17,
    finalPolish: false,
  });
}

function valid(result: Result, P: number): PackingConfig {
  expect(result.reasons).toEqual([]);
  expect(result.valid).toBe(true);
  expect(result.best?.pieces).toHaveLength(P);
  expect(evaluate(result.best!).valid).toBe(true);
  expect(evaluate(result.best!).score).toBeCloseTo(result.score!, 9);
  return result.best!;
}

describe("seed", () => {
  it("registers tooltip schemas and defaults", () => {
    const method = registry.list().find((m) => m.name === "seed")!;
    expect(method.defaults.kind).toBe("auto");
    for (const schema of Object.values(method.schema.properties!)) {
      expect(schema.title).toBeTruthy();
      expect(schema.description).toBeTruthy();
    }
  });

  it("generates square, hex, row and auto seeds across shapes and counts", async () => {
    for (const [N, M, P] of [
      [0, 0, 1],
      [0, 3, 2],
      [3, 3, 2],
      [4, 4, 17],
      [5, 5, 6],
      [6, 6, 7],
      [12, 8, 19],
      [100, 0, 2],
      [0, 100, 2],
      [100, 100, 1],
    ]) {
      for (const kind of ["square_lattice", "hex_lattice", "rows", "auto"]) {
        valid(await generate({ N, M, P }, kind, { trials: M === 100 ? 1 : 2 }), P);
      }
    }
  }, 25000);

  it("handles large counts without overlaps", async () => {
    for (const kind of ["square_lattice", "hex_lattice", "rows", "pentagon_double_lattice"]) {
      valid(await generate({ N: 5, M: 0, P: 500 }, kind, { trials: 1 }), 500);
    }
  }, 10000);

  it("uses both triangle orientations and matches exact tilings", async () => {
    for (const k of [2, 3]) {
      for (const kind of ["square_lattice", "hex_lattice", "rows"]) {
        const result = await generate({ N: 3, M: 3, P: k * k }, kind);
        valid(result, k * k);
        expect(result.score).toBeCloseTo(k, 9);
        expect(new Set(result.best!.pieces.map((p) => p.theta)).size).toBeGreaterThan(1);
      }
    }
    for (const kind of ["square_lattice", "hex_lattice", "rows"]) {
      valid(await generate({ N: 3, M: 4, P: 13 }, kind, { perRow: 3, orientation: 0.21, trials: 1 }), 13);
    }
  });

  it("matches square tilings and the seven-circle hexagonal cluster", async () => {
    for (const k of [2, 3, 4]) {
      for (const kind of ["square_lattice", "rows"]) {
        const result = await generate({ N: 4, M: 4, P: k * k }, kind);
        valid(result, k * k);
        expect(result.score).toBeCloseTo(k, 9);
      }
    }
    const circles = await generate({ N: 0, M: 0, P: 7 }, "hex_lattice");
    valid(circles, 7);
    expect(Math.abs(circles.score! - 3)).toBeLessThan(1e-9);
    const hexagons = valid(await generate({ N: 6, M: 0, P: 19 }, "hex_lattice", { trials: 1 }), 19);
    // The six nearest neighbours touch along hexagon faces, not vertices.
    const distances = hexagons.pieces.filter((p) => Math.hypot(p.x, p.y) > 1e-10).map((p) => Math.hypot(p.x, p.y));
    expect(Math.min(...distances)).toBeCloseTo(Math.sqrt(3), 9);
  });

  it("verifies the pentagon infinite cell density and all possible contacting translates", async () => {
    const cell = pentagonCell();
    const det = Math.abs(cell.a[0] * cell.b[1] - cell.a[1] * cell.b[0]);
    expect((2 * pieceArea(5)) / det).toBeCloseTo((5 - Math.sqrt(5)) / 3, 12);
    for (const a of cell.motif) {
      for (let i = -10; i <= 10; i++) {
        for (let j = -10; j <= 10; j++) {
          for (const b of cell.motif) {
            if (i === 0 && j === 0 && a === b) continue;
            expect(
              pieceSeparation(5, a, {
                x: b.x + i * cell.a[0] + j * cell.b[0],
                y: b.y + i * cell.a[1] + j * cell.b[1],
                theta: b.theta,
              }).sep,
            ).toBeGreaterThanOrEqual(-1e-12);
          }
        }
      }
    }
    for (const [M, P] of [
      [0, 1],
      [3, 2],
      [5, 6],
      [8, 30],
    ])
      valid(await generate({ N: 5, M, P }, "pentagon_double_lattice"), P);
    const rejected = await generate({ N: 4, M: 4, P: 2 }, "pentagon_double_lattice");
    expect(rejected.termination).toBe("error");
    expect(rejected.reasons.join()).toContain("only to N = 5");
  });

  it("returns rings where full D_M symmetry applies and explains incompatibilities", async () => {
    for (const [N, M, P] of [
      [0, 0, 1],
      [0, 0, 2],
      [0, 0, 19],
      [4, 4, 1],
      [4, 4, 5],
      [5, 5, 6],
      [6, 6, 7],
      [3, 4, 8],
      [100, 5, 11],
    ]) {
      const result = await generate({ N, M, P }, "rings", { trials: 1 });
      const best = valid(result, P);
      if (M !== 0) {
        for (const p of best.pieces) {
          const turned = rotate(p, (2 * Math.PI) / M);
          expect(
            best.pieces.some(
              (q) =>
                Math.hypot(q.x - turned.x, q.y - turned.y) < 1e-8 &&
                (N === 0 || Math.abs(Math.sin((N * (q.theta - turned.theta)) / 2)) < 1e-8),
            ),
          ).toBe(true);
          expect(
            best.pieces.some(
              (q) =>
                Math.hypot(q.x + p.x, q.y - p.y) < 1e-8 &&
                (N === 0 || Math.abs(Math.sin((N * (q.theta + p.theta)) / 2)) < 1e-8),
            ),
          ).toBe(true);
        }
      }
    }
    for (const problem of [
      { N: 4, M: 4, P: 2 },
      { N: 3, M: 4, P: 5 },
    ]) {
      const result = await generate(problem, "rings");
      expect(result.termination).toBe("error");
      expect(result.reasons.join()).toMatch(/D_M/);
    }
  });

  it("adds or removes from valid records and rejects mismatches and overlaps", async () => {
    for (const [N, M] of [
      [0, 0],
      [3, 3],
      [4, 4],
      [5, 5],
      [12, 8],
    ]) {
      const record = valid(await generate({ N, M, P: 6 }, "hex_lattice", { trials: 1 }), 6);
      valid(await generate({ N, M, P: 7 }, "record_plus_one", { record, recordTrials: 20 }), 7);
      valid(await generate({ N, M, P: 5 }, "record_minus_one", { record }), 5);
      for (const kind of ["record_plus_one", "record_minus_one"]) {
        for (const bad of [
          { ...record, N: N === 0 ? 3 : 0 },
          { ...record, P: 4 },
          { ...record, pieces: record.pieces.slice(1) },
          { ...record, pieces: record.pieces.map(() => ({ x: 0, y: 0, theta: 0 })) },
        ]) {
          const result = await generate({ N, M, P: kind === "record_plus_one" ? 7 : 5 }, kind, { record: bad });
          expect(result.termination).toBe("error");
          expect(result.reasons.join()).toContain("record");
        }
      }
    }
    const record = valid(await generate({ N: 0, M: 0, P: 2 }), 2);
    valid(await generate({ N: 0, M: 0, P: 1 }, "record_minus_one", { record }), 1);
    for (const x of [-1e6, 1e6]) {
      valid(
        await generate({ N: 0, M: 0, P: 2 }, "record_plus_one", {
          record: { N: 0, M: 0, P: 1, pieces: [{ x, y: 0, theta: 0 }], container_phi: 0 },
          recordTrials: 1,
        }),
        2,
      );
    }
    const removal = await generate({ N: 0, M: 0, P: 1 }, "record_minus_one", { record });
    expect(removal.score).toBeCloseTo(1, 10);
    const corners: PackingConfig = {
      N: 0,
      M: 0,
      P: 4,
      container_phi: 0,
      pieces: [-1e6, 1e6].flatMap((x) => [-1e6, 1e6].map((y) => ({ x, y, theta: 0 }))),
    };
    valid(await generate({ N: 0, M: 0, P: 5 }, "record_plus_one", { record: corners, recordTrials: 1 }), 5);
    const source = valid(await generate({ N: 5, M: 5, P: 6 }), 6);
    const deleted = await generate({ N: 5, M: 5, P: 5 }, "record_minus_one", { record: source });
    const expected = Math.min(
      ...source.pieces.map(
        (_, removed) =>
          evaluate({ ...source, P: 5, pieces: source.pieces.filter((_, i) => i !== removed) }, { autoOrient: true })
            .score!,
      ),
    );
    expect(deleted.score).toBeCloseTo(expected, 9);
  });

  it("property checks random shapes, counts, orientations and alternate rows", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(0, 3, 4, 5, 6, 8, 12),
        fc.constantFrom(0, 3, 4, 5, 6, 8),
        fc.integer({ min: 1, max: 30 }),
        fc.constantFrom(...seedKinds),
        fc.boolean(),
        async (N, M, P, kind, alternateRows) => {
          const params: Record<string, unknown> = { trials: 1, alternateRows };
          if (kind.startsWith("record_") && !(kind === "record_plus_one" && P === 1)) {
            const count = kind === "record_plus_one" ? P - 1 : P + 1;
            params.record = valid(await generate({ N, M, P: count }, "hex_lattice", { trials: 1 }), count);
            params.recordTrials = 8;
          }
          const result = await generate({ N, M, P }, kind, params);
          const incompatible =
            (kind === "pentagon_double_lattice" && N !== 5) ||
            (kind === "record_plus_one" && P === 1) ||
            (kind === "rings" && M !== 0 && (P % M > 1 || (P % M === 1 && N !== 0 && N % M !== 0)));
          if (incompatible) {
            expect(result.termination).toBe("error");
            expect(result.reasons.length).toBeGreaterThan(0);
          } else valid(result, P);
        },
      ),
      { numRuns: 40, seed: 118 },
    );
  }, 15000);

  it("is deterministic and obeys small eval budgets", async () => {
    for (const evals of [1, 2, 7, 13, 35]) {
      const options = { method: "seed", params: { trials: 12 }, budget: { evals }, seed: 123, finalPolish: false };
      const a = await run({ N: 5, M: 5, P: 11 }, options);
      const b = await run({ N: 5, M: 5, P: 11 }, options);
      valid(a, 11);
      expect(b.best).toEqual(a.best);
      expect(b.score).toBe(a.score);
      expect(a.evaluations).toBeLessThanOrEqual(evals);
    }
  });

  it("stops promptly with a valid best", async () => {
    const control = { aborted: false };
    const begun = performance.now();
    const result = await run(
      { N: 4, M: 4, P: 30 },
      {
        method: "seed",
        params: { trials: 256 },
        budget: { evals: 10000 },
        seed: 3,
        control,
        finalPolish: false,
        onProgress: (frame) => {
          if (frame.valid) control.aborted = true;
        },
      },
    );
    valid(result, 30);
    expect(result.termination).toBe("aborted");
    expect(performance.now() - begun).toBeLessThan(1000);
  });

  it("emits a bounded diverse pool to a later stage", async () => {
    const ownRegistry = new MethodRegistry();
    ownRegistry.register(seedMethod);
    let received: readonly PackingConfig[] = [];
    ownRegistry.register({
      name: "inspect",
      doc: "docs/methods/inspect.md",
      schema: { type: "object" },
      defaults: {},
      async execute(ctx) {
        received = ctx.starts;
      },
    });
    const result = await ownRegistry.runPipeline(
      { N: 0, M: 0, P: 7 },
      { stages: [{ method: "seed", params: { trials: 2, poolLimit: 3 } }, { method: "inspect" }] },
      { seed: 7, budget: { evals: 50 }, finalPolish: false },
    );
    valid(result, 7);
    expect(received).toHaveLength(3);
    expect(received.every((c) => !findOverlaps(c.N, c.pieces).length)).toBe(true);
    const limited = await ownRegistry.runPipeline(
      { N: 0, M: 0, P: 7 },
      {
        stages: [{ method: "seed", params: { trials: 12, poolLimit: 8 }, budget: { evals: 6 } }, { method: "inspect" }],
      },
      { seed: 7, budget: { evals: 50 }, finalPolish: false },
    );
    valid(limited, 7);
    expect(received).toHaveLength(2);
    expect(limited.stages[0].evaluations).toBe(6);
  });

  it("auto is no worse than single generators with equal budget shares", async () => {
    for (const problem of [
      { N: 4, M: 4, P: 5 },
      { N: 0, M: 0, P: 7 },
      { N: 5, M: 5, P: 6 },
    ]) {
      for (const share of [1, 2, 3, 7]) {
        for (const poolLimit of [0, 1, 8]) {
          const singles: Result[] = [];
          for (const kind of seedKinds.filter((k) => !["auto", "record_plus_one", "record_minus_one"].includes(k))) {
            const result = await generate(problem, kind, { trials: 8, poolLimit }, share);
            if (result.valid) singles.push(result);
          }
          const auto = await generate(problem, "auto", { trials: 8, poolLimit }, share * singles.length);
          valid(auto, problem.P);
          for (const single of singles) expect(auto.score!).toBeLessThanOrEqual(single.score! + 1e-9);
        }
      }
    }
  });

  it("caches pruned contact spacing and searches useful orientation anchors", async () => {
    let checks = 0;
    const context = (N: number) =>
      ({
        problem: { N, M: 0, P: 30 },
        shouldStop: () => {
          checks++;
          return false;
        },
        checkpoint: async () => true,
      }) as unknown as MethodContext;
    const triangle = new SpacingCache(context(3));
    const cell = baseCell(3, false, 0);
    const first = await triangle.scale("square_lattice", cell, 0);
    const cold = checks;
    expect(cold).toBeGreaterThan(0);
    expect(cold).toBeLessThan(5000);
    for (let i = 0; i < 12; i++) expect(await triangle.scale("square_lattice", cell, 0)).toBe(first);
    expect(checks).toBe(cold);
    for (const [N, hex, minimum] of [
      [5, false, 0.708],
      [5, true, 0.802],
      [6, false, 0.807],
    ]) {
      const cache = new SpacingCache(context(N as number));
      const theta = (await cache.optimum(hex as boolean))!;
      const optimal = baseCell(N as number, hex as boolean, theta);
      const scale = (await cache.scale("test", optimal, theta))!;
      const determinant = Math.abs(optimal.a[0] * optimal.b[1] - optimal.a[1] * optimal.b[0]);
      expect(pieceArea(N as number) / (determinant * scale * scale)).toBeGreaterThan(minimum as number);
      const cachedChecks = checks;
      expect(await cache.optimum(hex as boolean)).toBe(theta);
      expect(checks).toBe(cachedChecks);
    }
  });

  it("alternates rows with tight pitch and follows explicit hexagon orientation", async () => {
    const rows = valid(await generate({ N: 0, M: 0, P: 9 }, "rows", { perRow: 3, alternateRows: true, trials: 1 }), 9);
    expect(rows.pieces[3].x - rows.pieces[0].x).toBeCloseTo(1, 9);
    expect(rows.pieces[6].x - rows.pieces[0].x).toBeCloseTo(0, 9);
    expect(rows.pieces[3].y - rows.pieces[0].y).toBeCloseTo(Math.sqrt(3), 9);
    const hexagons = valid(
      await generate({ N: 6, M: 0, P: 7 }, "hex_lattice", {
        automaticOrientation: false,
        orientation: 0.37,
        trials: 1,
      }),
      7,
    );
    const nearest = Math.min(
      ...hexagons.pieces.flatMap((p, i) => hexagons.pieces.slice(0, i).map((q) => Math.hypot(p.x - q.x, p.y - q.y))),
    );
    expect(nearest).toBeCloseTo(Math.sqrt(3), 9);
  });

  it("uses polygon perimeter populations and centre options for small circle rings", async () => {
    const large = await generate({ N: 4, M: 4, P: 484 }, "rings", { trials: 1 });
    valid(large, 484);
    expect(large.score).toBeCloseTo(22, 8);
    for (const P of [8, 9, 10]) {
      const problem = { N: 0, M: 0, P };
      const rings = await generate(problem, "rings");
      valid(rings, P);
      for (const kind of ["square_lattice", "hex_lattice"]) {
        const lattice = await generate(problem, kind);
        expect(rings.score!).toBeLessThanOrEqual(lattice.score! + 1e-9);
      }
    }
  });

  it("inserts at two circle contacts and touches large records", async () => {
    const seven = valid(await generate({ N: 0, M: 0, P: 7 }, "hex_lattice"), 7);
    const eight = await generate({ N: 0, M: 0, P: 8 }, "record_plus_one", { record: seven }, 500);
    valid(eight, 8);
    // A fixed optimal seven-circle hexagonal cluster cannot extend to the
    // optimal eight-circle packing without moving its original pieces.
    expect(eight.score).toBeCloseTo(1 + 14 / (3 * Math.sqrt(3)), 9);
    const ringRadius = 1 / Math.sin(Math.PI / 7);
    const compatible: PackingConfig = {
      N: 0,
      M: 0,
      P: 7,
      container_phi: 0,
      pieces: Array.from({ length: 7 }, (_, i) => ({
        x: ringRadius * Math.cos((2 * Math.PI * i) / 7),
        y: ringRadius * Math.sin((2 * Math.PI * i) / 7),
        theta: 0,
      })),
    };
    const compatibleEight = await generate({ N: 0, M: 0, P: 8 }, "record_plus_one", { record: compatible }, 500);
    valid(compatibleEight, 8);
    expect(compatibleEight.score).toBeCloseTo(3.3048, 3);
    for (const P of [200, 499]) {
      const record = valid(await generate({ N: 0, M: 0, P }, "hex_lattice", { trials: 1 }), P);
      const result = await generate({ N: 0, M: 0, P: P + 1 }, "record_plus_one", { record, recordTrials: 128 }, 500);
      const inserted = valid(result, P + 1).pieces[P];
      expect(Math.min(...record.pieces.map((p) => pieceSeparation(0, inserted, p).sep))).toBeLessThan(1e-6);
      expect(result.evaluations).toBeLessThanOrEqual(128);
    }
  });

  it("keeps large polygon-record insertions valid after tangent slides", async () => {
    for (const N of [5, 12, 100]) {
      const record = valid(await generate({ N, M: 0, P: 60 }, "hex_lattice", { trials: 1 }), 60);
      const result = await generate({ N, M: 0, P: 61 }, "record_plus_one", { record, recordTrials: 24 }, 100);
      valid(result, 61);
      expect(result.evaluations).toBeLessThanOrEqual(24);
    }
  });

  it("explains missing records and counts and ignores records for unrelated kinds", async () => {
    expect((await generate({ N: 0, M: 0, P: 8 }, "record_plus_one")).reasons.join()).toContain("record is required");
    const record = valid(await generate({ N: 0, M: 0, P: 3 }), 3);
    for (const [kind, expected] of [
      ["record_plus_one", 7],
      ["record_minus_one", 9],
    ] as const) {
      const rejected = await generate({ N: 0, M: 0, P: 8 }, kind, { record });
      expect(rejected.reasons.join()).toContain(`exactly ${expected} pieces`);
    }
    const unrelated = { ...record, N: 5, P: 2 };
    valid(await generate({ N: 4, M: 4, P: 5 }, "square_lattice", { record: unrelated }), 5);
  });

  it("emits distinct triangle distance classes", async () => {
    const ownRegistry = new MethodRegistry();
    ownRegistry.register(seedMethod);
    let pool: readonly PackingConfig[] = [];
    ownRegistry.register({
      name: "capture",
      doc: "docs/methods/capture.md",
      schema: { type: "object" },
      defaults: {},
      async execute(ctx) {
        pool = ctx.starts;
      },
    });
    await ownRegistry.runPipeline(
      { N: 3, M: 3, P: 3 },
      {
        stages: [{ method: "seed" }, { method: "capture" }],
      },
      { seed: 17, budget: { evals: 1000 }, finalPolish: false },
    );
    const signature = (c: PackingConfig) => {
      const distances = c.pieces.flatMap((p, i) =>
        c.pieces.slice(0, i).map((q) => Math.round(Math.hypot(p.x - q.x, p.y - q.y) / 1e-7)),
      );
      return `${Math.round(evaluate(c, { autoOrient: true }).score! / 1e-7)}:${distances.sort((a, b) => a - b)}`;
    };
    expect(pool.length).toBeGreaterThan(2);
    expect(new Set(pool.map(signature)).size).toBe(pool.length);
  });
});
