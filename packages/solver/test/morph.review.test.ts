// Independent adversarial review of the shape continuation (morph) method.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as geometry from "@polypack/geometry";
import {
  circumradius,
  convexHull,
  evaluate,
  inradius,
  pairPenetration,
  pieceSeparation,
  pieceVertices,
  polygonSeparation,
  visitContainerProtrusions,
  type Container,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import { run, seededRandom, type MethodContext } from "../src";
import { morphMethod } from "../src/methods/morph";
import { createPenaltyObjective, packState } from "../src/methods/penalty/objective";
import { scatter } from "../src/methods/penalty/restoration";
import {
  roundedShape,
  shapeContained,
  shapeEnclose,
  shapeSeparation,
  superellipseError,
  superellipseVertices,
  type MorphShape,
} from "../src/methods/morph/shapes";

const ROOT = resolve(__dirname, "../../..");
// Copies of three sources as they stood before the scale/padding extension, kept as text so that
// they are neither compiled nor linted with the current tree.
const BASE = resolve(__dirname, "fixtures/pre-morph");

function minimumSeparation(config: PackingConfig): number {
  let minimum = Infinity;
  for (let i = 0; i < config.P; i++)
    for (let j = 0; j < i; j++)
      minimum = Math.min(minimum, pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep);
  return minimum;
}

/** Signed distance from a point to a convex CCW polygon (negative inside). */
function signedDistance(poly: Float64Array, x: number, y: number): number {
  const n = poly.length / 2;
  let inside = true;
  let outside = Infinity;
  let plane = -Infinity;
  for (let i = 0; i < n; i++) {
    const ax = poly[2 * i];
    const ay = poly[2 * i + 1];
    const ex = poly[(2 * i + 2) % (2 * n)] - ax;
    const ey = poly[(2 * i + 3) % (2 * n)] - ay;
    const length = Math.hypot(ex, ey);
    if (length === 0) continue;
    const h = ((x - ax) * ey - (y - ay) * ex) / length;
    plane = Math.max(plane, h);
    if (h > 0) inside = false;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (length * length)));
    outside = Math.min(outside, Math.hypot(x - ax - t * ex, y - ay - t * ey));
  }
  // A collapsed polygon (all edges of zero length) is a point.
  if (plane === -Infinity) return Math.hypot(x - poly[0], y - poly[1]);
  return inside ? plane : outside;
}

/** Independent rounded separation: signed distance of b-a to the core Minkowski difference, minus 2*padding. */
function bruteRoundedSeparation(N: number, a: Pose, b: Pose, shape: MorphShape): number {
  const A = pieceVertices(N, { x: 0, y: 0, theta: a.theta }, shape.scale);
  const B = pieceVertices(N, { x: 0, y: 0, theta: b.theta }, shape.scale);
  const difference = new Float64Array(2 * N * N);
  let k = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      difference[k++] = A[2 * i] - B[2 * j];
      difference[k++] = A[2 * i + 1] - B[2 * j + 1];
    }
  return signedDistance(convexHull(difference), b.x - a.x, b.y - a.y) - 2 * shape.padding;
}

describe("review: backward compatibility of the scale/padding extension", () => {
  let OLD: typeof geometry;
  let oldObjective: typeof createPenaltyObjective;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "morph-review-"));
    const show = (name: string) => readFileSync(join(BASE, `${name}.txt`), "utf8");
    writeFileSync(join(dir, "shapes.ts"), show("shapes.ts"));
    writeFileSync(join(dir, "penalty.ts"), show("penalty.ts"));
    // The base objective, wired to the current geometry so that only objective.ts differs.
    const objective = show("objective.ts")
      .replace(/from "@polypack\/geometry"/g, `from ${JSON.stringify(join(ROOT, "packages/geometry/src/index.ts"))}`)
      .replace(
        /from "\.\/lbfgs"/g,
        `from ${JSON.stringify(join(ROOT, "packages/solver/src/methods/penalty/lbfgs.ts"))}`,
      );
    writeFileSync(join(dir, "objective.ts"), objective);
    OLD = await import(/* @vite-ignore */ pathToFileURL(join(dir, "penalty.ts")).href);
    oldObjective = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "objective.ts")).href))
      .createPenaltyObjective;
  });

  it("gives bit-identical pair, wall and visitor results with default arguments", () => {
    const random = seededRandom(424242);
    const r = (scale: number) => (2 * random() - 1) * scale;
    const Ns = [0, 3, 4, 5, 6, 7, 8, 12, 50];
    const Ms = [0, 3, 4, 5, 6, 8, 12];
    const flat = (rows: unknown[][]) => rows.flat() as number[];
    for (let k = 0; k < 6000; k++) {
      const N = Ns[k % Ns.length];
      const spread = [0.01, 1, 3, 1e3][k % 4];
      const a = { x: r(spread), y: r(spread), theta: r(10) };
      const b = k % 7 === 0 ? { ...a, theta: r(10) } : { x: r(spread), y: r(spread), theta: r(10) };
      const axesA = N ? OLD.penaltyEdgeNormals(N, a.theta) : undefined;
      const axesB = N ? OLD.penaltyEdgeNormals(N, b.theta) : undefined;
      // Disk pieces (N = 0) and circle containers (M = 0) changed on purpose in the diameter-1 units
      // change (the base copy still has radius-1 disks and a radius-scored circle), so only the
      // polygon pairs and polygon containers are compared bit for bit.
      if (N !== 0) {
        expect(geometry.pairPenetration(N, a, b)).toStrictEqual(OLD.pairPenetration(N, a, b));
        expect(geometry.pairPenetration(N, a, b, axesA, axesB)).toStrictEqual(OLD.pairPenetration(N, a, b, axesA, axesB));
      }
      const M = Ms[k % Ms.length];
      const container: Container = { M, cx: r(2), cy: r(2), size: 0.5 + 5 * random(), phi: r(4) };
      if (N === 0 || M === 0) continue;
      for (const supportOnly of [false, true]) {
        const before: unknown[][] = [];
        const after: unknown[][] = [];
        OLD.visitContainerProtrusions(N, a, container, (...v) => before.push(v), supportOnly);
        geometry.visitContainerProtrusions(N, a, container, (...v) => after.push(v), supportOnly);
        const x = flat(before);
        const y = flat(after);
        expect(y.length).toBe(x.length);
        expect(x.every((v, i) => Object.is(v, y[i]))).toBe(true);
      }
      expect(geometry.containerProtrusions(N, a, container)).toStrictEqual(OLD.containerProtrusions(N, a, container));
    }
  });

  it("gives bit-identical objective values, gradients and violations with default arguments", () => {
    const random = seededRandom(77);
    const r = (scale: number) => (2 * random() - 1) * scale;
    const Ns = [0, 3, 4, 5, 6, 8, 12];
    for (let k = 0; k < 300; k++) {
      const N = Ns[k % Ns.length];
      const M = [0, 3, 4, 6][k % 4];
      const P = 1 + (k % 8);
      const template = {
        N,
        M,
        P,
        container_phi: r(1),
        pieces: Array.from({ length: P }, () => ({ x: r(1.5), y: r(1.5), theta: r(6) })),
      };
      const x = packState({
        config: template,
        container: { M, cx: r(0.3), cy: r(0.3), size: 1 + 3 * random(), phi: template.container_phi },
      });
      for (const augmented of [false, true])
        for (const supportOnly of [false, true]) {
          const multipliers = () =>
            new Map<number, number>([
              [1, 0.3],
              [2, 0.7],
              [P * P + 1, 0.2],
            ]);
          const before = oldObjective(template, 7, multipliers(), augmented, () => false, supportOnly);
          const after = createPenaltyObjective(template, 7, multipliers(), augmented, () => false, supportOnly);
          const u = before.evaluate(x);
          const v = after.evaluate(x);
          expect(Object.is(u.value, v.value)).toBe(true);
          expect(u.gradient.every((g, i) => Object.is(g, v.gradient[i]))).toBe(true);
          expect(Object.is(before.violation(x), after.violation(x))).toBe(true);
        }
    }
  });
});

describe("review: rounded and superellipse geometry", () => {
  const Ns = [3, 4, 5, 6, 7, 8, 12, 30, 100];

  it("matches an independent Minkowski-difference signed distance, separated or overlapping, both families", () => {
    const random = seededRandom(7);
    let worst = 0;
    for (const N of Ns)
      for (const family of ["inscribed", "circumscribed"] as const)
        for (let k = 0; k < 120; k++) {
          const t = k % 10 === 0 ? 0 : k % 10 === 1 ? 1 - 1e-9 : random();
          const shape = roundedShape(N, t, family);
          const a = { x: 0.3, y: -0.2, theta: 10 * random() };
          const d = 2 * circumradius(N) * (0.15 + random());
          const angle = 7 * random();
          const b = { x: a.x + d * Math.cos(angle), y: a.y + d * Math.sin(angle), theta: 10 * random() };
          worst = Math.max(worst, Math.abs(shapeSeparation(N, a, b, shape) - bruteRoundedSeparation(N, a, b, shape)));
        }
    expect(worst).toBeLessThan(1e-12);
  });

  it("is exact for overlapping sharp pieces (t = 1) and a lower bound when separated", () => {
    const random = seededRandom(8);
    for (const N of Ns)
      for (let k = 0; k < 60; k++) {
        const shape = roundedShape(N, 1, "inscribed");
        const a = { x: 0, y: 0, theta: 10 * random() };
        const d = 2 * circumradius(N) * (0.1 + random());
        const b = { x: d * Math.cos(k), y: d * Math.sin(k), theta: 10 * random() };
        const got = shapeSeparation(N, a, b, shape);
        const truth = bruteRoundedSeparation(N, a, b, shape);
        if (truth <= 0) expect(Math.abs(got - truth)).toBeLessThan(1e-12);
        else expect(got).toBeLessThanOrEqual(truth + 1e-12);
        expect(Math.sign(got) === Math.sign(truth) || Math.abs(truth) < 1e-12).toBe(true);
      }
  });

  it("keeps the inscribed family inside P and the circumscribed family around P", () => {
    const random = seededRandom(9);
    for (const N of Ns)
      for (let k = 0; k < 30; k++) {
        const t = k === 0 ? 0 : random();
        const pose = { x: random(), y: -random(), theta: 10 * random() };
        const P = pieceVertices(N, pose);
        const core = pieceVertices(N, pose, t);
        const inner = roundedShape(N, t, "inscribed");
        const outer = roundedShape(N, t, "circumscribed");
        // Farthest point of the inscribed shape beyond any edge of P: core support + padding.
        for (let e = 0; e < N; e++) {
          const ax = P[2 * e];
          const ay = P[2 * e + 1];
          const ex = P[(2 * e + 2) % (2 * N)] - ax;
          const ey = P[(2 * e + 3) % (2 * N)] - ay;
          const length = Math.hypot(ex, ey);
          let support = -Infinity;
          for (let v = 0; v < N; v++)
            support = Math.max(support, ((core[2 * v] - ax) * ey - (core[2 * v + 1] - ay) * ex) / length);
          // pieceVertices itself carries ~1e-14 relative error at N = 100.
          expect(support + inner.padding).toBeLessThanOrEqual(1e-13 * circumradius(N));
        }
        // Every vertex of P lies within the circumscribed padding of the core.
        for (let v = 0; v < N; v++)
          expect(N === 0 || t === 0 ? 0 : signedDistance(core, P[2 * v], P[2 * v + 1])).toBeLessThanOrEqual(
            outer.padding + 1e-12,
          );
      }
  });

  it("computes container protrusion against brute-force sampled boundaries for all piece/container kinds", () => {
    const random = seededRandom(10);
    for (const N of [0, 3, 4, 5, 8, 30])
      for (const M of [0, 3, 4, 5, 8])
        for (let k = 0; k < 12; k++) {
          const shape =
            N === 0
              ? { scale: 0.3 + random(), padding: 0.5 * random(), vertices: 0 }
              : roundedShape(N, k === 0 ? 0 : random(), k % 2 ? "inscribed" : "circumscribed");
          const pose = { x: 2 * random() - 1, y: 2 * random() - 1, theta: 10 * random() };
          const container: Container = {
            M,
            cx: 0.3 * random(),
            cy: -0.2 * random(),
            size: 2 + random(),
            phi: 3 * random(),
          };
          const reported = [false, true].map((supportOnly) => {
            let worst = -Infinity;
            visitContainerProtrusions(
              N,
              pose,
              container,
              (depth) => {
                worst = Math.max(worst, depth);
              },
              supportOnly,
              undefined,
              undefined,
              shape.scale,
              shape.padding,
            );
            return worst;
          });
          const core = N === 0 ? new Float64Array([pose.x, pose.y]) : pieceVertices(N, pose, shape.scale);
          const radius = N === 0 ? shape.scale * geometry.DISK_RADIUS + shape.padding : shape.padding;
          let brute = -Infinity;
          for (let v = 0; v < core.length / 2; v++)
            for (let s = 0; s < 720; s++) {
              const w = (2 * Math.PI * s) / 720;
              const x = core[2 * v] + radius * Math.cos(w) - container.cx;
              const y = core[2 * v + 1] + radius * Math.sin(w) - container.cy;
              if (M === 0) brute = Math.max(brute, Math.hypot(x, y) - container.size / 2);
              else
                for (let e = 0; e < M; e++) {
                  const g = container.phi - Math.PI / 2 + (2 * Math.PI * e) / M;
                  brute = Math.max(brute, x * Math.cos(g) + y * Math.sin(g) - container.size * inradius(M));
                }
            }
          for (const value of reported) {
            expect(value).toBeGreaterThanOrEqual(brute - 1e-12);
            expect(value - brute).toBeLessThan(radius * (1 - Math.cos(Math.PI / 720)) + 1e-12);
          }
        }
  });

  it("has correct analytic padded pair gradients (central differences, both families)", () => {
    const random = seededRandom(99);
    let checked = 0;
    for (let k = 0; k < 1500; k++) {
      const N = [3, 4, 5, 6, 7, 8, 12, 30][k % 8];
      const shape = roundedShape(N, random(), k % 2 ? "inscribed" : "circumscribed");
      const a = { x: 0, y: 0, theta: 10 * random() };
      const d = 2 * (0.3 + 0.9 * random());
      const b = { x: d * Math.cos(k), y: d * Math.sin(k), theta: 10 * random() };
      const base = pairPenetration(N, a, b, undefined, undefined, shape.scale, shape.padding);
      for (const who of ["a", "b"] as const)
        for (const key of ["x", "y", "theta"] as const) {
          const f = (h: number) => {
            const A = { ...a };
            const B = { ...b };
            (who === "a" ? A : B)[key] += h;
            return pairPenetration(N, A, B, undefined, undefined, shape.scale, shape.padding).depth;
          };
          const coarse = (f(1e-6) - f(-1e-6)) / 2e-6;
          const fine = (f(5e-7) - f(-5e-7)) / 1e-6;
          if (Math.abs(coarse - fine) > 1e-6) continue; // feature switch
          checked++;
          expect(Math.abs(coarse - base[who][key])).toBeLessThan(1e-6);
        }
    }
    expect(checked).toBeGreaterThan(8000);
  });

  it("keeps the superellipse polygon convex, inside the square, within pi/K of the curve and near the square", () => {
    for (const K of [16, 24, 64, 256])
      for (const p of [2, 2.5, 4, 8, 32, 128]) {
        const pose = { x: 0.1, y: -0.3, theta: 0.37 };
        const polygon = superellipseVertices(pose, p, K);
        const dense = superellipseVertices(pose, p, 8192);
        const square = pieceVertices(4, pose);
        let hausdorff = 0;
        for (let i = 0; i < dense.length; i += 2)
          hausdorff = Math.max(hausdorff, signedDistance(polygon, dense[i], dense[i + 1]));
        expect(hausdorff).toBeLessThanOrEqual(superellipseError(K));
        for (let i = 0; i < polygon.length; i += 2) {
          expect(signedDistance(square, polygon[i], polygon[i + 1])).toBeLessThanOrEqual(1e-15);
          const j = (i + 2) % polygon.length;
          const l = (i + 4) % polygon.length;
          const cross =
            (polygon[j] - polygon[i]) * (polygon[l + 1] - polygon[j + 1]) -
            (polygon[j + 1] - polygon[i + 1]) * (polygon[l] - polygon[j]);
          expect(cross).toBeGreaterThanOrEqual(-1e-15);
        }
        // Every square corner is within the curve-to-square bound plus the sampling bound.
        for (let v = 0; v < 8; v += 2)
          expect(signedDistance(polygon, square[v], square[v + 1])).toBeLessThanOrEqual(
            (1 - 2 ** (-1 / p)) / Math.SQRT2 + superellipseError(K) + 1e-12,
          );
      }
  });

  it("encloses every stage shape in shapeEnclose and reports it contained", () => {
    for (let s = 0; s < 600; s++) {
      const random = seededRandom(s);
      const N = [3, 4, 5, 6, 8, 12][s % 6];
      const M = [0, 3, 4, 5, 6, 8][Math.floor(s / 6) % 6];
      const P = 1 + (s % 5);
      const shape: MorphShape =
        N === 4 && s % 3 === 0
          ? { scale: 1, padding: 0, p: 2 + 100 * random(), vertices: 64 }
          : roundedShape(N, s % 7 === 0 ? 0 : random(), s % 2 ? "inscribed" : "circumscribed");
      const config = scatter({ N, M, P }, random);
      config.container_phi = 2 * random();
      const container = shapeEnclose(config, shape);
      for (const pose of config.pieces) expect(shapeContained(N, pose, container, shape)).toBe(true);
    }
  });

  it("superellipse separation agrees with an independent hull distance at p = 128, K = 256", () => {
    const random = seededRandom(12);
    const shape = { scale: 1, padding: 0, p: 128, vertices: 256 };
    for (let k = 0; k < 60; k++) {
      const a = { x: 0, y: 0, theta: 7 * random() };
      const d = 0.4 + 1.2 * random();
      const b = { x: d * Math.cos(k), y: d * Math.sin(k), theta: 7 * random() };
      const sep = shapeSeparation(4, a, b, shape);
      const A = superellipseVertices(a, 128, 256);
      const B = superellipseVertices(b, 128, 256);
      const overlap = polygonSeparation(A, B).sep < 0;
      expect(sep < 0).toBe(overlap);
      if (sep >= 0) {
        let distance = Infinity;
        for (let i = 0; i < A.length; i += 2) distance = Math.min(distance, signedDistance(B, A[i], A[i + 1]));
        expect(sep).toBeLessThanOrEqual(distance + 1e-12);
      }
    }
  });
});

/** A context that records every call; it never reaches the framework. */
function instrumented(
  problem: { N: number; M: number; P: number },
  params: Record<string, unknown>,
  budget: number,
  start?: PackingConfig,
) {
  let count = 0;
  const log = { evaluated: [] as PackingConfig[], runs: [] as string[], emits: 0 };
  const ctx: MethodContext = {
    problem,
    start,
    starts: [],
    initialEvaluation: start ? evaluate(start) : undefined,
    params: { ...morphMethod.defaults, ...params },
    random: seededRandom(5),
    shouldStop: () => count >= budget,
    remaining: () => ({ evals: budget - count, time_s: Infinity }),
    checkpoint: async () => count < budget,
    run: async (name) => {
      log.runs.push(name);
      return { found: undefined, best: undefined, evaluations: 0 } as never;
    },
    emit: async () => {
      log.emits++;
    },
    evaluate: async (candidate, options) => {
      if (count >= budget) return undefined;
      count++;
      log.evaluated.push(candidate);
      return evaluate(candidate, options);
    },
  } as MethodContext;
  return { ctx, log, count: () => count };
}

describe("review: registered method", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reaches the 10-square construction within 1e-4 for seeds 1 and 4 at 3,000 while plain penalty does not", async () => {
    const problem = { N: 4, M: 4, P: 10 };
    const target = 3 + Math.SQRT1_2;
    for (const seed of [1, 4]) {
      const result = await run(problem, { method: "morph", seed, budget: { evals: 3000 } });
      expect(result.valid && result.strict).toBe(true);
      expect(result.evaluations).toBeLessThanOrEqual(3000);
      const rescored = evaluate(result.best!, { autoOrient: false });
      expect(rescored.valid).toBe(true);
      expect(rescored.score).toBe(result.score);
      expect(minimumSeparation(result.best!)).toBeGreaterThanOrEqual(-1e-12);
      expect(Math.abs(result.score! - target)).toBeLessThan(1e-4);
      // Convergence digits can differ across CPU architectures; same-runtime
      // seeded determinism is tested separately, rather than against old scores.
    }
    const plain = await run(problem, { method: "penalty", seed: 1, budget: { evals: 3000 } });
    expect(plain.score!).toBeGreaterThan(3.99);
  }, 30000);

  it("only evaluates complete, finite, strictly non-overlapping sharp configurations, within budget", async () => {
    const cases: [{ N: number; M: number; P: number }, Record<string, unknown>][] = [
      [{ N: 4, M: 4, P: 6 }, {}],
      [{ N: 4, M: 4, P: 6 }, { family: "circumscribed" }],
      [
        { N: 4, M: 0, P: 6 },
        { path: "superellipse", vertices: 16 },
      ],
      [
        { N: 5, M: 3, P: 6 },
        { localMethod: "mc_compress", mcSweeps: 30 },
      ],
      [{ N: 0, M: 6, P: 6 }, {}],
      [{ N: 6, M: 6, P: 1 }, {}],
      [
        { N: 3, M: 0, P: 2 },
        { stages: 2, spacing: 4 },
      ],
    ];
    for (const [problem, params] of cases) {
      const start = scatter(problem, seededRandom(problem.N + problem.P));
      const { ctx, log, count } = instrumented(problem, params, 60, start);
      await morphMethod.execute(ctx);
      expect(count()).toBeLessThanOrEqual(60);
      expect(log.runs).toEqual([]);
      expect(log.emits).toBe(0);
      const keys = new Set<string>();
      for (const candidate of log.evaluated) {
        expect(candidate.pieces).toHaveLength(problem.P);
        expect(candidate.pieces.every((p) => [p.x, p.y, p.theta].every(Number.isFinite))).toBe(true);
        expect(minimumSeparation(candidate)).toBeGreaterThanOrEqual(0);
        const key = JSON.stringify([candidate.pieces, candidate.container_phi]);
        expect(keys.has(key)).toBe(false);
        keys.add(key);
      }
    }
  }, 30000);

  it("terminates the adaptive schedule with a zero residual threshold and no budget pressure", async () => {
    const problem = { N: 5, M: 5, P: 3 };
    const { ctx, count } = instrumented(
      problem,
      { stages: 64, residualThreshold: 0, innerIterations: 2, outerIterations: 1 },
      1e9,
      scatter(problem, seededRandom(2)),
    );
    await morphMethod.execute(ctx);
    // At most 3 stages per base interval, each with a bounded number of accepted steps.
    expect(count()).toBeLessThan(64 * 3 * 4 + 10);
  }, 30000);

  it("never throws, never worsens a valid start and stays strict at P = 1, 2, large N/M and far starts", async () => {
    const codes = [0, 3, 4, 6];
    for (const N of codes)
      for (const M of codes)
        for (const P of [1, 2]) {
          const result = await run({ N, M, P }, { method: "morph", seed: 3, budget: { evals: 25 } });
          expect(result.valid && result.strict, `${N} ${M} ${P}`).toBe(true);
          expect(result.best!.pieces).toHaveLength(P);
        }
    for (const [N, M, P] of [
      [100, 100, 4],
      [100, 0, 4],
      [3, 100, 6],
    ]) {
      const result = await run({ N, M, P }, { method: "morph", seed: 1, budget: { evals: 40 } });
      expect(result.valid && result.strict).toBe(true);
      expect(minimumSeparation(result.best!)).toBeGreaterThanOrEqual(-1e-12);
    }
    const problem = { N: 4, M: 4, P: 4 };
    const far = {
      ...problem,
      container_phi: 0,
      pieces: [
        { x: 999990, y: 999990, theta: 0 },
        { x: -999990, y: -999990, theta: 1 },
        { x: 999990, y: -999990, theta: 2 },
        { x: -999990, y: 999990, theta: 3 },
      ],
    };
    const startScore = evaluate(far, { autoOrient: true }).score!;
    const result = await run(problem, { method: "morph", start: far, seed: 6, budget: { evals: 150 } });
    expect(result.valid).toBe(true);
    expect(result.score!).toBeLessThanOrEqual(startScore);
    const coincident = { ...far, pieces: far.pieces.map(() => ({ x: 999999.9, y: 999999.9, theta: 0 })) };
    const repaired = await run(problem, { method: "morph", start: coincident, seed: 6, budget: { evals: 150 } });
    expect(repaired.valid && repaired.strict).toBe(true);
  }, 40000);

  it("accepts every schema edge without throwing and rejects out-of-range values", async () => {
    const edges: Record<string, unknown>[] = [
      { stages: 2 },
      { spacing: 0.25, residualThreshold: 0 },
      { spacing: 4, adaptive: false },
      { path: "superellipse", maxExponent: 2, vertices: 17 },
      { path: "superellipse", maxExponent: 128, stages: 2 },
      { innerIterations: 1, outerIterations: 1, initialWeight: 1e8, jitter: 0.5 },
      { localMethod: "mc_compress", mcSweeps: 1, translationStep: 1e-6, rotationStep: 1e-6 },
      { family: "circumscribed", initialWeight: 0.001, jitter: 0 },
    ];
    for (const params of edges)
      for (const [N, M] of [
        [4, 4],
        [3, 0],
        [0, 5],
      ]) {
        const result = await run({ N, M, P: 5 }, { method: "morph", params, seed: 7, budget: { evals: 80 } });
        expect(result.valid && result.strict, JSON.stringify(params)).toBe(true);
        expect(result.evaluations).toBeLessThanOrEqual(80);
      }
    for (const params of [
      { stages: 1 },
      { stages: 65 },
      { vertices: 8 },
      { maxExponent: 1 },
      { foo: 1 },
      { stages: 2.5 },
    ])
      await expect(
        run({ N: 4, M: 4, P: 3 }, { method: "morph", params, seed: 1, budget: { evals: 10 } }),
      ).rejects.toThrow();
  }, 40000);

  it("is deterministic per seed for MC and superellipse and makes no Math.random call", async () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random used");
    });
    for (const params of [{ localMethod: "mc_compress" }, { path: "superellipse" }, { family: "circumscribed" }]) {
      const problem = { N: 4, M: 4, P: 6 };
      const options = { method: "morph", params, seed: 11, budget: { evals: 250 } };
      const first = await run(problem, options);
      const second = await run(problem, options);
      expect(first.valid).toBe(true);
      expect(second.best).toEqual(first.best);
      expect(second.evaluations).toBe(first.evaluations);
    }
  }, 30000);

  it("returns the valid start when aborted before it runs and honours a short time budget", async () => {
    const problem = { N: 4, M: 4, P: 8 };
    const start = scatter(problem, seededRandom(4));
    const aborted = await run(problem, {
      method: "morph",
      start,
      seed: 1,
      budget: { evals: 1000 },
      control: { aborted: true },
    });
    expect(aborted.valid).toBe(true);
    expect(aborted.score!).toBeLessThanOrEqual(evaluate(start, { autoOrient: true }).score!);
    const begun = performance.now();
    const timed = await run({ N: 4, M: 4, P: 120 }, { method: "morph", seed: 1, budget: { time_s: 0.3 } });
    expect(timed.valid).toBe(true);
    expect(performance.now() - begun).toBeLessThan(1500);
  }, 30000);
});
