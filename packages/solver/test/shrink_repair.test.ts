import { describe, expect, it } from "vitest";
import {
  evaluate,
  findOverlaps,
  pairPenetration,
  pieceSeparation,
  visitContainerProtrusions,
  type PackingConfig,
} from "@polypack/geometry";
import records from "../../../data/records.json";
import { MethodRegistry, registry, run, seededRandom, strictTolerance, type MethodContext } from "../src";
import { seedMethod } from "../src/methods/seed";
import {
  CHECKPOINT_WORK,
  executeShrinkRepair,
  legaliseStrict,
  shrinkRepairMethod,
  type ShrinkRepairObservation,
} from "../src/methods/shrink_repair";
import { Kernel } from "../src/methods/shrink_repair/kernel";
import { RepairState, SUCCESS_DEPTH } from "../src/methods/shrink_repair/repair";

const settings = { globalSamples: 48, localSamples: 24, weightGrowth: 2, weightDecay: 0.95 };

function minimumSeparation(config: PackingConfig): number {
  let minimum = Infinity;
  for (let i = 0; i < config.P; i++) {
    for (let j = 0; j < i; j++)
      minimum = Math.min(minimum, pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep);
  }
  return minimum;
}

function record(N: number, M: number, P: number): PackingConfig {
  const entry = (records as { records: Array<Record<string, unknown>> }).records.find(
    (r) => r.N === N && r.M === M && r.P === P,
  ) as unknown as PackingConfig & { pieces?: PackingConfig["pieces"] };
  if (!entry?.pieces) throw new Error(`no record coordinates for ${N}/${M}/${P}`);
  return { N, M, P, pieces: entry.pieces.map((p) => ({ ...p })), container_phi: entry.container_phi ?? 0 };
}

/**
 * The registered method in a registry of its own whose context records every configuration the
 * method itself submits for assessment (seed sub-runs are the seed's).
 */
function recorder() {
  const submitted: PackingConfig[] = [];
  const events: ShrinkRepairObservation[] = [];
  const local = new MethodRegistry();
  local.register(seedMethod);
  local.register({
    ...shrinkRepairMethod,
    execute: (ctx: MethodContext) =>
      executeShrinkRepair(
        {
          ...ctx,
          evaluate: (config, options) => {
            submitted.push({ ...config, pieces: config.pieces.map((p) => ({ ...p })) });
            return ctx.evaluate(config, options);
          },
        },
        (event) => events.push({ ...event, config: undefined }),
      ),
  });
  return { registry: local, submitted, events };
}

describe("shrink_repair kernel", () => {
  it("agrees with the shared pair penetration, its derivatives and the support-form walls", () => {
    const random = seededRandom(7);
    let depth = 0;
    let derivative = 0;
    let wall = 0;
    for (const N of [0, 3, 4, 5, 6, 12]) {
      for (const M of [0, 3, 4, 6, 7]) {
        const kernel = new Kernel(N, M);
        const ua = new Float64Array(2 * N);
        const ub = new Float64Array(2 * N);
        for (let t = 0; t < 1500; t++) {
          const reach = N === 0 ? 2 : 1 / Math.sin(Math.PI / N);
          const a = { x: reach * (2 * random() - 1), y: reach * (2 * random() - 1), theta: N ? 20 * random() - 10 : 0 };
          const b = { x: reach * (2 * random() - 1), y: reach * (2 * random() - 1), theta: N ? 20 * random() - 10 : 0 };
          kernel.normals(a.theta, ua);
          kernel.normals(b.theta, ub);
          const shared = pairPenetration(N, a, b);
          const d = kernel.depthGradient(a.x, a.y, a.theta, ua, b.x, b.y, b.theta, ub);
          depth = Math.max(depth, Math.abs(d - shared.depth));
          depth = Math.max(
            depth,
            Math.abs(kernel.depth(a.x, a.y, a.theta, ua, b.x, b.y, b.theta, ub) - Math.max(0, shared.depth)),
          );
          if (shared.depth > 1e-6) {
            const pairs = [
              [kernel.ax, shared.a.x],
              [kernel.ay, shared.a.y],
              [kernel.at, shared.a.theta],
              [kernel.bx, shared.b.x],
              [kernel.by, shared.b.y],
              [kernel.bt, shared.b.theta],
            ];
            for (const [mine, theirs] of pairs) derivative = Math.max(derivative, Math.abs(mine - theirs));
          }
          // Walls: the shared support form for polygon containers; for a circular container the
          // shared radial constraints of every vertex, of which the kernel keeps the deepest.
          const size = 1.5 + 2 * random();
          const container = { M, cx: 0, cy: 0, phi: 0, size };
          let sum = 0;
          let deepest = -Infinity;
          const gradient = [0, 0, 0];
          visitContainerProtrusions(
            N,
            a,
            container,
            (p, px, py, pt) => {
              if (M === 0 && N !== 0) {
                if (p > deepest) {
                  deepest = p;
                  gradient.splice(0, 3, px, py, pt);
                }
              } else if (p > 0) {
                sum += p * p;
                gradient[0] += 2 * p * px;
                gradient[1] += 2 * p * py;
                gradient[2] += 2 * p * pt;
              }
            },
            true,
          );
          if (M === 0 && N !== 0) {
            sum = deepest > 0 ? deepest * deepest : 0;
            for (let k = 0; k < 3; k++) gradient[k] = deepest > 0 ? 2 * deepest * gradient[k] : 0;
          }
          kernel.walls(a.x, a.y, a.theta, size, true);
          wall = Math.max(
            wall,
            Math.abs(kernel.wallSum - sum),
            Math.abs(kernel.wx - gradient[0]),
            Math.abs(kernel.wy - gradient[1]),
            Math.abs(kernel.wt - gradient[2]),
          );
        }
      }
    }
    expect(depth).toBeLessThan(1e-12);
    expect(derivative).toBeLessThan(1e-12);
    expect(wall).toBeLessThan(1e-12);
  });

  it("has an objective gradient that matches central differences", () => {
    for (const [N, M] of [
      [0, 4],
      [3, 3],
      [4, 4],
      [5, 0],
      [6, 7],
    ]) {
      const P = 7;
      const random = seededRandom(N * 10 + M);
      const state = new RepairState({ N, M, P }, settings);
      state.setSize(2.2);
      state.load(Array.from({ length: P }, () => ({ x: 2 * random() - 1, y: 2 * random() - 1, theta: 6 * random() })));
      const gradient = new Float64Array(3 * P);
      const value = state.evaluate(gradient);
      expect(value).toBeGreaterThan(0);
      const base = state.snapshot();
      const h = 1e-7;
      for (let i = 0; i < P; i++) {
        for (const [k, key] of [
          [0, "x"],
          [1, "y"],
          [2, "theta"],
        ] as const) {
          if (N === 0 && key === "theta") continue;
          const plus = base.map((p) => ({ ...p }));
          const minus = base.map((p) => ({ ...p }));
          plus[i][key] += h;
          minus[i][key] -= h;
          state.load(plus);
          const up = state.evaluate();
          state.load(minus);
          const down = state.evaluate();
          const numeric = (up - down) / (2 * h);
          expect(Math.abs(numeric - gradient[3 * i + k])).toBeLessThan(1e-4 * Math.max(1, Math.abs(numeric)));
        }
      }
    }
  });
});

describe("shrink_repair legalisation", () => {
  it("separates a squeezed contact grid strictly, by a factor near 1 + depth when it is shallow", async () => {
    // Exact-contact grids: edge-aligned unit squares at pitch 1, radius-1 circles at pitch 2.
    for (const [N, pitch, theta] of [
      [4, 1, Math.PI / 4],
      [0, 2, 0],
    ]) {
      const grid = Array.from({ length: 9 }, (_, i) => ({ x: (i % 3) * pitch, y: Math.floor(i / 3) * pitch, theta }));
      for (const squeeze of [1e-11, 1e-6, 0.05, 0.3, 0.7]) {
        const config: PackingConfig = {
          N,
          M: 4,
          P: 9,
          container_phi: 0,
          pieces: grid.map((p) => ({ ...p, x: p.x * (1 - squeeze), y: p.y * (1 - squeeze) })),
        };
        const legal = await legaliseStrict(
          config,
          () => false,
          () => true,
          seededRandom(1),
        );
        expect(legal).toBeDefined();
        expect(findOverlaps(N, legal!.pieces, 0)).toEqual([]);
        if (squeeze <= 1e-6) {
          // The squeezed grid has size about 3 (1 - squeeze); legalised, it is back at about 3.
          const size = evaluate(legal!).score!;
          expect(size / ((N === 0 ? 2 : 1) * 3) - 1).toBeLessThan(3 * squeeze + 1e-10);
        }
      }
    }
  });

  it("separates random overlapping arrangements of any piece strictly", async () => {
    const random = seededRandom(3);
    for (const N of [0, 3, 5, 6, 9, 40]) {
      for (let t = 0; t < 4; t++) {
        const spread = 2 + 3 * random();
        const config: PackingConfig = {
          N,
          M: 4,
          P: 12,
          container_phi: 0,
          pieces: Array.from({ length: 12 }, () => ({
            x: spread * random(),
            y: spread * random(),
            theta: N === 0 ? 0 : 7 * random(),
          })),
        };
        const legal = await legaliseStrict(
          config,
          () => false,
          () => true,
          seededRandom(1),
        );
        expect(legal).toBeDefined();
        expect(findOverlaps(N, legal!.pieces, 0)).toEqual([]);
      }
    }
  });
});

describe("shrink_repair method", () => {
  it("is registered with a valid schema and documented defaults", () => {
    const metadata = registry.list().find((m) => m.name === "shrink_repair");
    expect(metadata).toBeDefined();
    expect(metadata!.doc).toBe("docs/methods/shrink_repair.md");
    expect(metadata!.schema.additionalProperties).toBe(false);
    for (const [key, value] of Object.entries(metadata!.defaults)) {
      expect(metadata!.schema.properties![key].default).toEqual(value);
    }
  });

  it("assesses only complete, strictly separated configurations", async () => {
    const cases: Array<[number, number, number, Record<string, unknown>, PackingConfig | undefined]> = [
      [4, 4, 6, {}, undefined],
      [0, 0, 7, {}, undefined],
      [3, 3, 5, { start: "random" }, undefined],
      [5, 4, 4, {}, undefined],
      [6, 0, 3, { start: "random" }, undefined],
      [0, 4, 1, {}, undefined],
      [7, 7, 2, {}, undefined],
      // An overlapping start: every piece at one point.
      [
        4,
        4,
        4,
        {},
        { N: 4, M: 4, P: 4, container_phi: 0, pieces: Array.from({ length: 4 }, () => ({ x: 0, y: 0, theta: 0 })) },
      ],
      // A start valid only within the evaluator's tolerance.
      [
        0,
        4,
        2,
        {},
        {
          N: 0,
          M: 4,
          P: 2,
          container_phi: 0,
          pieces: [
            { x: -1 + 2e-10, y: 0, theta: 0 },
            { x: 1 - 2e-10, y: 0, theta: 0 },
          ],
        },
      ],
    ];
    for (const [N, M, P, params, start] of cases) {
      const { registry: local, submitted } = recorder();
      const result = await local.run(
        { N, M, P },
        { method: "shrink_repair", params, seed: 4, start, budget: { evals: 160 }, finalPolish: false },
      );
      expect(submitted.length).toBeGreaterThan(0);
      for (const config of submitted) {
        expect(config.pieces).toHaveLength(P);
        expect(findOverlaps(N, config.pieces, 0)).toEqual([]);
      }
      expect(result.valid && result.strict).toBe(true);
      expect(result.evaluations).toBeLessThanOrEqual(160);
      expect(findOverlaps(N, result.best!.pieces, strictTolerance(result.best!))).toEqual([]);
      expect(Math.abs(evaluate(result.best!, { autoOrient: true }).score! - result.score!)).toBeLessThan(1e-12);
    }
  });

  it("never exceeds an evaluation budget and spends it all when it cannot finish", async () => {
    for (const evals of [1, 2, 3, 5, 17, 60, 250]) {
      const result = await run(
        { N: 4, M: 4, P: 8 },
        { method: "shrink_repair", seed: 2, budget: { evals }, finalPolish: true },
      );
      expect(result.evaluations).toBeLessThanOrEqual(evals);
      if (evals >= 5) expect(result.evaluations).toBe(evals);
      if (evals >= 3) expect(result.valid && result.strict).toBe(true);
    }
  });

  it("respects a time budget", async () => {
    const started = performance.now();
    const result = await run({ N: 4, M: 4, P: 30 }, { method: "shrink_repair", seed: 1, budget: { time_s: 0.5 } });
    // Generous: the polish reserve and a loaded machine; the method itself yields every ~ms.
    expect((performance.now() - started) / 1000).toBeLessThan(5);
    expect(result.valid && result.strict).toBe(true);
    expect(result.termination).toBe("time");
  });

  it("is reproducible for a seed and differs between seeds", async () => {
    // Random starts, so that the seed matters from the first draw.
    const options = {
      method: "shrink_repair",
      params: { start: "random" },
      budget: { evals: 400 },
      finalPolish: false,
    };
    const first = await run({ N: 4, M: 4, P: 7 }, { ...options, seed: 9 });
    const again = await run({ N: 4, M: 4, P: 7 }, { ...options, seed: 9 });
    expect(again.best).toEqual(first.best);
    expect(again.score).toBe(first.score);
    expect(again.evaluations).toBe(first.evaluations);
    expect(again.trace.map((t) => t[1])).toEqual(first.trace.map((t) => t[1]));
    const other = await run({ N: 4, M: 4, P: 7 }, { ...options, seed: 10 });
    expect(other.best).not.toEqual(first.best);
  });

  it("draws no Math.random and gives the same result with or without a sketch observer", async () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error("Math.random used");
    };
    try {
      const options = { method: "shrink_repair", seed: 3, budget: { evals: 300 }, finalPolish: false };
      const plain = await run({ N: 3, M: 4, P: 6 }, options);
      let sketches = 0;
      const sketched = await run(
        { N: 3, M: 4, P: 6 },
        {
          ...options,
          onSketch: (frame) => {
            sketches++;
            expect(frame.sketch.pieces).toHaveLength(6);
            expect(frame.sketch.scale).toBe(1);
          },
        },
      );
      expect(sketched.best).toEqual(plain.best);
      expect(sketched.evaluations).toBe(plain.evaluations);
      expect(sketches).toBeGreaterThanOrEqual(0);
    } finally {
      Math.random = original;
    }
  });

  it("is never worse than a valid start, including a published record", async () => {
    for (const [N, M, P] of [
      [4, 4, 10],
      [4, 4, 5],
      [0, 0, 7],
    ]) {
      const start = record(N, M, P);
      const before = evaluate(start, { autoOrient: true });
      expect(before.valid).toBe(true);
      const result = await run({ N, M, P }, { method: "shrink_repair", seed: 1, start, budget: { evals: 150 } });
      expect(result.valid).toBe(true);
      expect(result.score!).toBeLessThanOrEqual(before.score! + 1e-12);
    }
  });

  it("stops at once when aborted, and returns the same bits when paused and resumed", async () => {
    const control = { aborted: false };
    let atAbort = -1;
    let frames = 0;
    const aborted = await run(
      { N: 4, M: 4, P: 20 },
      {
        method: "shrink_repair",
        seed: 5,
        budget: { evals: 1000000 },
        control,
        onProgress: (frame) => {
          if (++frames === 6) {
            control.aborted = true;
            atAbort = frame.evaluations;
          }
        },
      },
    );
    expect(atAbort).toBeGreaterThan(0);
    expect(aborted.termination).toBe("aborted");
    expect(aborted.evaluations).toBe(atAbort);
    expect(aborted.valid && aborted.strict).toBe(true);

    const before = await run(
      { N: 4, M: 4, P: 50 },
      { method: "shrink_repair", seed: 5, budget: { evals: 1000000 }, control: { aborted: true } },
    );
    expect(before.evaluations).toBe(0);
    expect(before.termination).toBe("aborted");

    const problem = { N: 4, M: 4, P: 12 };
    const options = { method: "shrink_repair", seed: 12, budget: { evals: 200 }, finalPolish: false };
    const plain = await run(problem, options);
    const state = { paused: true };
    let seenPaused = 0;
    const pausing = {
      aborted: false,
      get paused() {
        if (state.paused) seenPaused++;
        return state.paused;
      },
    };
    const timer = setInterval(() => {
      state.paused = !state.paused;
    }, 15);
    try {
      const result = await run(problem, { ...options, control: pausing });
      expect(seenPaused).toBeGreaterThan(0);
      expect(result.best).toEqual(plain.best);
      expect(result.score).toBe(plain.score);
      expect(result.evaluations).toBe(plain.evaluations);
    } finally {
      clearInterval(timer);
    }
  });

  it("places its checkpoints by counted work, identically in repeated runs", async () => {
    const count = async () => {
      let checkpoints = 0;
      let evaluations = 0;
      const marks: number[] = [];
      const ctx: MethodContext = {
        problem: { N: 4, M: 4, P: 40 },
        starts: [],
        params: { ...shrinkRepairMethod.defaults },
        random: seededRandom(1),
        shouldStop: () => evaluations >= 30,
        remaining: () => ({ evals: Math.max(0, 30 - evaluations), time_s: Infinity }),
        checkpoint: async () => {
          checkpoints++;
          marks.push(evaluations);
          return evaluations < 30;
        },
        evaluate: async (config, options) => {
          if (evaluations >= 30) return undefined;
          evaluations++;
          return evaluate(config, options);
        },
        emit: async () => undefined,
        run: async () => ({
          foundScore: null,
          score: null,
          valid: false,
          container: null,
          evaluations: 0,
          termination: "completed",
          reasons: [],
        }),
      };
      await executeShrinkRepair(ctx);
      return { checkpoints, marks };
    };
    const first = await count();
    const second = await count();
    expect(first.checkpoints).toBeGreaterThan(5);
    expect(second).toEqual(first);
    expect(CHECKPOINT_WORK).toBe(60000);
  });
});

describe("shrink_repair escapes the grid basin", () => {
  it("packs five squares in 2 + 1/sqrt(2) from the plain grid start", async () => {
    const grid: PackingConfig = {
      N: 4,
      M: 4,
      P: 5,
      container_phi: 0,
      pieces: Array.from({ length: 5 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3), theta: Math.PI / 4 })),
    };
    expect(evaluate(grid).score).toBeCloseTo(3, 9);
    for (const seed of [1, 2, 3]) {
      const result = await run(
        { N: 4, M: 4, P: 5 },
        { method: "shrink_repair", seed, start: grid, budget: { evals: 1500 } },
      );
      expect(result.valid && result.strict).toBe(true);
      expect(result.score!).toBeLessThan(2 + Math.SQRT1_2 + 1e-6);
      expect(minimumSeparation(result.best!)).toBeGreaterThan(-strictTolerance(result.best!));
    }
  });

  it("packs ten squares below the grid's 4, near 3 + 1/sqrt(2)", async () => {
    const result = await run({ N: 4, M: 4, P: 10 }, { method: "shrink_repair", seed: 1, budget: { evals: 3000 } });
    expect(result.valid && result.strict).toBe(true);
    expect(result.score!).toBeLessThan(3 + Math.SQRT1_2 + 1e-4);
  });

  it("reports feasibility at the method's success depth", () => {
    expect(SUCCESS_DEPTH).toBe(1e-10);
  });
});
