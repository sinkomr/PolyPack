import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  boundingRadius,
  circumradius,
  containerProtrusions,
  enclose,
  evaluate,
  findOverlaps,
  inradius,
  pairPenetration,
  pieceArea,
  pieceSeparation,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import { registry, run, seededRandom, strictTolerance } from "../src";
import type { MethodContext } from "../src/framework";
import {
  CHECKPOINT_WORK,
  executeHarden,
  hardenMethod,
  planPhases,
  planRuns,
  type HardenObservation,
} from "../src/methods/harden";
import {
  HardenDynamics,
  MOMENTUM,
  POSE_RATE,
  SIZE_RATE,
  STEP_CAP,
  lengthUnit,
  sizeUnit,
} from "../src/methods/harden/dynamics";
import { legalise } from "../src/methods/harden/legalise";
import { SeenArrangements } from "../src/methods/harden/signature";
import { HARDEN_PATHS, pathShape, shapeArea, softShape, type SoftShape } from "../src/methods/harden/shapes";
import { scatter } from "../src/methods/penalty/restoration";

const options = { tau0: 1, gamma0: 0.1 };
const polygons = [3, 4, 5, 6, 8, 12] as const;

function minimumSeparation(config: PackingConfig): number {
  let minimum = Infinity;
  for (let i = 0; i < config.P; i++) {
    for (let j = 0; j < i; j++)
      minimum = Math.min(minimum, pieceSeparation(config.N, config.pieces[i], config.pieces[j]).sep);
  }
  return minimum;
}

/** Short schedule in the reference's 2500 : 7500 : 1500 proportion: 92 steps, 23 assessments. */
const short = { compressSteps: 20, morphSteps: 60, settleSteps: 12, evaluationInterval: 4 };

interface Fake {
  ctx: MethodContext;
  evaluated: PackingConfig[];
  events: HardenObservation[];
  checkpoints: () => number;
}

/** A context with an exact evaluation allowance that records what the method submits. */
function fake(
  problem: { N: number; M: number; P: number },
  settings: {
    evals?: number;
    params?: Record<string, unknown>;
    start?: PackingConfig;
    seed?: number;
    stopAfter?: number;
  } = {},
): Fake {
  const limit = settings.evals ?? Infinity;
  const evaluated: PackingConfig[] = [];
  let checkpoints = 0;
  const stopped = () => evaluated.length >= Math.min(limit, settings.stopAfter ?? Infinity);
  const ctx: MethodContext = {
    problem,
    start: settings.start,
    starts: [],
    initialEvaluation: settings.start ? evaluate(settings.start) : undefined,
    params: { ...hardenMethod.defaults, ...settings.params },
    random: seededRandom(settings.seed ?? 1),
    shouldStop: stopped,
    remaining: () => ({ evals: Math.max(0, limit - evaluated.length), time_s: Infinity }),
    checkpoint: async () => {
      checkpoints++;
      return !stopped();
    },
    run: async () => {
      throw new Error("unexpected sub-run");
    },
    emit: async () => {
      throw new Error("unexpected emission");
    },
    evaluate: async (candidate, opts) => {
      if (stopped()) return undefined;
      evaluated.push(candidate);
      return evaluate(candidate, opts);
    },
  };
  return { ctx, evaluated, events: [], checkpoints: () => checkpoints };
}

async function observed(f: Fake): Promise<Fake> {
  await executeHarden(f.ctx, (event) =>
    f.events.push({ ...event, plan: { ...event.plan }, shape: { ...event.shape } }),
  );
  return f;
}

describe("harden shape paths", () => {
  it("starts every path at the reference's state and ends exactly at the true piece", () => {
    for (const N of polygons) {
      const rho = inradius(N);
      const disk = (Math.PI * rho * rho) / pieceArea(N);
      for (const gamma0 of [0.01, 0.1, 0.3, 0.35, 0.7]) {
        for (const tau0 of [1, 0.5, 0.25, 0]) {
          const set = { tau0, gamma0 };
          expect(pathShape("harden", 0, N, set)).toEqual({ gamma: 1, tau: tau0 });
          expect(pathShape("grow", 0, N, set)).toEqual({ gamma: gamma0, tau: 0 });
          expect(pathShape("rigid", 0, N, set)).toEqual({ gamma: 1, tau: 0 });
          expect(pathShape("snap", 0, N, set)).toEqual({ gamma: 1, tau: 1 });
          const area = pathShape("grow-area", 0, N, set);
          expect(area.tau).toBe(0);
          expect(area.gamma).toBeCloseTo(Math.sqrt(disk), 14);
          for (const path of HARDEN_PATHS) {
            for (const u of [1, 1 + 1e-12, 2]) {
              // toBe on every field: not merely close to the true shape.
              const end = softShape(N, pathShape(path, u, N, set));
              expect(end.gamma).toBe(1);
              expect(end.tau).toBe(0);
              expect(end.scale).toBe(1);
              expect(end.padding).toBe(0);
            }
          }
        }
      }
    }
  });

  it("follows the reference schedules between the endpoints", () => {
    for (const N of polygons) {
      for (const u of [0.001, 0.25, 0.5, 0.9, 0.999]) {
        expect(pathShape("harden", u, N, options).tau).toBeCloseTo(1 - u, 14);
        expect(pathShape("harden", u, N, { tau0: 0.5, gamma0: 0.1 }).tau).toBeCloseTo(0.5 * (1 - u), 14);
        expect(pathShape("grow", u, N, { tau0: 1, gamma0: 0.35 }).gamma).toBeCloseTo(0.35 + 0.65 * u, 14);
        expect(pathShape("snap", u, N, options)).toEqual({ gamma: 1, tau: 0 });
        expect(pathShape("rigid", u, N, options)).toEqual({ gamma: 1, tau: 0 });
        // grow-area is defined by having hardening's area at the same progress.
        expect(shapeArea(N, pathShape("grow-area", u, N, options))).toBeCloseTo(
          shapeArea(N, pathShape("harden", u, N, options)),
          13,
        );
      }
      // A(tau) = A - (A - pi rho^2) tau^2: the inscribed disk at tau = 1 and the polygon at tau = 0.
      expect(shapeArea(N, { gamma: 1, tau: 1 })).toBeCloseTo(Math.PI * inradius(N) ** 2, 13);
      expect(shapeArea(N, { gamma: 1, tau: 0 })).toBeCloseTo(pieceArea(N), 13);
    }
  });

  it("keeps every soft state inside the true polygon and maps it to core scale and padding", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...polygons),
        fc.constantFrom(...HARDEN_PATHS),
        fc.integer({ min: 0, max: 1000 }).map((k) => k / 1000),
        (N, path, u) => {
          const state = pathShape(path, u, N, options);
          const shape = softShape(N, state);
          expect(shape.scale).toBeCloseTo(state.gamma * (1 - state.tau), 15);
          expect(shape.padding).toBeCloseTo(state.gamma * state.tau * inradius(N), 15);
          // Support in every direction is scale * h_P + padding, and h_P ranges over [rho, R].
          for (const support of [inradius(N), circumradius(N)]) {
            expect(shape.scale * support + shape.padding).toBeLessThanOrEqual(support + 1e-15);
          }
        },
      ),
      { numRuns: 200, seed: 7101 },
    );
  });

  it("gives circle pieces no shape path except growth", () => {
    for (const u of [0, 0.3, 0.999, 1]) {
      for (const path of ["harden", "snap", "grow-area", "rigid"] as const) {
        expect(softShape(0, pathShape(path, u, 0, options))).toEqual({ gamma: 1, tau: 0, scale: 1, padding: 0 });
      }
    }
    expect(softShape(0, pathShape("grow", 0, 0, options))).toEqual({ gamma: 0.1, tau: 0, scale: 0.1, padding: 0 });
    expect(softShape(0, pathShape("grow", 0.5, 0, options)).scale).toBeCloseTo(0.55, 14);
  });
});

/**
 * The energy assembled separately from the shared constraint functions, with no neighbour cut-off
 * and no wall prefilter. It checks the method's own assembly and pruning, but it is not
 * independent of the shared geometry: the hand-computed cases below and the finite differences are.
 */
function bruteEnergy(state: HardenDynamics, shape: SoftShape): number {
  const { N, M, poses } = state;
  let energy = 0;
  for (let i = 0; i < poses.length; i++) {
    for (let j = 0; j < i; j++) {
      const depth =
        N !== 0 && shape.scale === 0
          ? 2 * shape.padding - Math.hypot(poses[i].x - poses[j].x, poses[i].y - poses[j].y)
          : pairPenetration(N, poses[i], poses[j], undefined, undefined, shape.scale, shape.padding).depth;
      if (depth > 0) energy += depth * depth;
    }
  }
  const container = { M, cx: 0, cy: 0, phi: 0, size: state.size };
  for (const pose of poses) {
    // A pure inscribed disk meets each wall once, like a circle piece of that radius.
    const walls =
      N !== 0 && shape.scale === 0
        ? containerProtrusions(0, pose, container, shape.padding, 0)
        : containerProtrusions(N, pose, container, shape.scale, shape.padding);
    for (const wall of walls) if (wall.depth > 0) energy += wall.depth * wall.depth;
  }
  return energy;
}

function loaded(N: number, M: number, poses: Pose[], size: number): HardenDynamics {
  const state = new HardenDynamics({ N, M, P: poses.length });
  poses.forEach((p, i) => Object.assign(state.poses[i], N === 0 ? { ...p, theta: 0 } : p));
  state.L = size * sizeUnit(M);
  return state;
}

describe("harden energy and dynamics", () => {
  // fast-check favours zeros and bounds, which put pieces exactly on top of each other or exactly
  // aligned: points where the energy has a kink. It supplies only a seed; the poses are generic.
  const softness = fc.oneof(
    fc.constantFrom(0, 1, 0.5),
    fc.integer({ min: 1, max: 990 }).map((k) => k / 1000),
  );
  const scaleOf = fc.constantFrom(1, 1, 0.6, 0.35);

  for (const N of [0, 3, 4]) {
    for (const M of [0, 3, 4, 12]) {
      it(`matches finite differences and an independent energy for N=${N}, M=${M}`, () => {
        let active = 0;
        fc.assert(
          fc.property(
            fc.integer({ min: 1, max: 1000000 }),
            softness,
            scaleOf,
            fc.integer({ min: 300, max: 900 }).map((k) => k / 300),
            (seed, tau, gamma, extent) => {
              const R = boundingRadius(N);
              const random = seededRandom(seed);
              // Poses within about one piece of each other, in a container that cuts some of them.
              const spread = Array.from({ length: 3 }, () => ({
                x: 2.4 * R * (random() - 0.5),
                y: 2.4 * R * (random() - 0.5),
                theta: 6 * (random() - 0.5),
              }));
              const size = (extent * R) / (M === 0 ? 1 : inradius(M));
              const shape = softShape(N, { gamma, tau });
              const energyAt = (index: number, delta: number): number => {
                const moved = spread.map((p) => ({ ...p }));
                let length = size * sizeUnit(M);
                if (index < 9) {
                  const key = (["x", "y", "theta"] as const)[index % 3];
                  moved[Math.floor(index / 3)][key] += delta;
                } else length += delta;
                const state = loaded(N, M, moved, length / sizeUnit(M));
                const report = state.gradient(shape);
                expect(report.energy).toBeCloseTo(bruteEnergy(state, shape), 11);
                return report.energy;
              };
              const state = loaded(N, M, spread, size);
              const report = state.gradient(shape);
              if (report.energy > 0) active++;
              expect(report.violation).toBeGreaterThanOrEqual(0);
              for (let index = 0; index < 10; index++) {
                const analytic =
                  index === 9 ? report.sizeGradient : [state.gx, state.gy, state.gt][index % 3][Math.floor(index / 3)];
                const numeric = (energyAt(index, 1e-6) - energyAt(index, -1e-6)) / 2e-6;
                const half = (energyAt(index, 5e-7) - energyAt(index, -5e-7)) / 1e-6;
                // A feature switch inside the stencil is detected without the gradient under test.
                fc.pre(Math.abs(numeric - half) < 1e-5);
                expect(Math.abs(numeric - analytic)).toBeLessThan(3e-5 * Math.max(1, Math.abs(analytic)));
              }
            },
          ),
          { numRuns: 60, seed: 7200 + 10 * N + M },
        );
        // The property must not pass on empty energies.
        expect(active).toBeGreaterThan(20);
      });
    }
  }

  it("equals energies and gradients computed by hand, without the shared geometry", () => {
    const far = 50;
    // Two radius-1 circles 1.8 apart: overlap 0.2, E = 0.04, each pushed outward by 2 * 0.2.
    const circles = loaded(
      0,
      0,
      [
        { x: -0.9, y: 0, theta: 0 },
        { x: 0.9, y: 0, theta: 0 },
      ],
      far,
    );
    const disk = softShape(0, { gamma: 1, tau: 0 });
    expect(circles.gradient(disk).energy).toBeCloseTo(0.04, 14);
    expect([circles.gx[0], circles.gx[1], circles.gy[0], circles.gy[1]].map((g) => +g.toFixed(12))).toEqual([
      0.4, -0.4, 0, 0,
    ]);
    // The same circles grown to scale 0.5 (radius 0.5) no longer touch.
    expect(circles.gradient(softShape(0, { gamma: 0.5, tau: 0 })).energy).toBe(0);

    // Two axis-aligned unit squares (theta = pi/4 in the vertex-up convention), centres 0.9 apart
    // in x and 0.2 in y: they overlap by 0.1 in x and 0.8 in y, so the penetration depth is 0.1.
    const axis = Math.PI / 4;
    const squares = () =>
      loaded(
        4,
        4,
        [
          { x: 0, y: 0, theta: axis },
          { x: 0.9, y: 0.2, theta: axis },
        ],
        far,
      );
    const rigid = squares();
    expect(rigid.gradient(softShape(4, { gamma: 1, tau: 0 })).energy).toBeCloseTo(0.01, 13);
    expect(rigid.gx[0]).toBeCloseTo(0.2, 12);
    expect(rigid.gx[1]).toBeCloseTo(-0.2, 12);
    expect(Math.abs(rigid.gy[0]) + Math.abs(rigid.gy[1])).toBeLessThan(1e-12);
    // Half-hardened (tau = 0.5): cores of side 0.5 are 0.4 apart, each padded by 0.25: depth 0.1 again.
    expect(squares().gradient(softShape(4, { gamma: 1, tau: 0.5 })).energy).toBeCloseTo(0.01, 13);
    // Pure inscribed disks of radius 0.5: depth 1 - |(0.9, 0.2)|.
    expect(squares().gradient(softShape(4, { gamma: 1, tau: 1 })).energy).toBeCloseTo(
      (1 - Math.hypot(0.9, 0.2)) ** 2,
      13,
    );

    // An axis-aligned unit square centred 0.7 right of the centre of a side-2 square container:
    // its two right-hand vertices are 0.2 outside the wall at x = 1.
    const wall = (tau: number) => {
      const state = loaded(4, 4, [{ x: 0.7, y: 0, theta: axis }], 2);
      return { state, report: state.gradient(softShape(4, { gamma: 1, tau })) };
    };
    const sharp = wall(0);
    expect(sharp.report.energy).toBeCloseTo(2 * 0.04, 13);
    expect(sharp.state.gx[0]).toBeCloseTo(2 * 2 * 0.2, 12);
    // The wall is at half the side, so dE/dL = sum of 2 q * (-1/2).
    expect(sharp.report.sizeGradient).toBeCloseTo(-0.4, 12);
    expect(sharp.report.violation).toBeCloseTo(0.2, 13);
    // Half-hardened: core vertices at x = 0.95 plus padding 0.25, the same two violations.
    expect(wall(0.5).report.energy).toBeCloseTo(0.08, 13);
    // The pure disk of radius 0.5 meets the wall once.
    const round = wall(1);
    expect(round.report.energy).toBeCloseTo(0.04, 13);
    expect(round.report.sizeGradient).toBeCloseTo(-0.2, 12);

    // A radius-1 circle 0.3 from the centre of a radius-1 circular container: 0.3 outside.
    const inCircle = loaded(0, 0, [{ x: 0.3, y: 0, theta: 0 }], 1);
    const pressed = inCircle.gradient(disk);
    expect(pressed.energy).toBeCloseTo(0.09, 13);
    expect(pressed.sizeGradient).toBeCloseTo(-0.6, 12);
    expect(inCircle.gx[0]).toBeCloseTo(0.6, 12);
  });

  it("gives pure disks no torque and uses the cell grid above 32 pieces without losing a term", () => {
    const random = seededRandom(7301);
    for (const [N, M] of [
      [4, 4],
      [3, 0],
      [0, 5],
      [6, 7],
    ] as const) {
      const poses = Array.from({ length: 60 }, () => ({
        x: 9 * (random() - 0.5) * boundingRadius(N),
        y: 9 * (random() - 0.5) * boundingRadius(N),
        theta: 6 * random(),
      }));
      for (const tau of [0, 0.4, 0.99995, 1]) {
        const state = loaded(N, M, poses, (4 * boundingRadius(N)) / (M === 0 ? 1 : inradius(M)));
        const shape = softShape(N, { gamma: 1, tau });
        const report = state.gradient(shape);
        expect(report.energy).toBeGreaterThan(0);
        expect(report.energy).toBeCloseTo(bruteEnergy(state, shape), 9);
        if (N === 0 || tau >= 0.9999) expect(state.gt.every((g) => g === 0)).toBe(true);
        else expect(state.gt.some((g) => g !== 0)).toBe(true);
      }
    }
  });

  it("uses the reference length and size units", () => {
    // Unit squares and unit-diameter circles are the reference's unit; PolyPack circles have radius 1.
    expect(lengthUnit(4)).toBeCloseTo(1, 15);
    expect(lengthUnit(0)).toBe(2);
    expect(lengthUnit(3)).toBeCloseTo(1 / Math.sqrt(3), 15);
    // Side for triangles and squares, radius for circles; apothem once it exceeds the side.
    expect([sizeUnit(0), sizeUnit(3), sizeUnit(4), sizeUnit(6)]).toEqual([1, 1, 1, 1]);
    expect(sizeUnit(12)).toBeCloseTo(inradius(12), 15);
    const state = loaded(4, 12, [{ x: 0, y: 0, theta: 0 }], 2);
    expect(state.size).toBeCloseTo(2, 15);
    expect(state.L).toBeCloseTo(2 * inradius(12), 15);
  });

  it("takes the reference momentum step: rates, caps, pressure on the container and seeded noise", () => {
    // Two radius-1 circles overlapping by 0.2 in a container far too large to touch them.
    const state = loaded(
      0,
      0,
      [
        { x: -0.9, y: 0, theta: 0 },
        { x: 0.9, y: 0, theta: 0 },
      ],
      50,
    );
    const shape = softShape(0, { gamma: 1, tau: 0 });
    const report = state.gradient(shape);
    expect(report.energy).toBeCloseTo(0.04, 14);
    expect(report.sizeGradient).toBe(0);
    expect(state.gx[0]).toBeCloseTo(0.4, 14);
    expect(state.gx[1]).toBeCloseTo(-0.4, 14);
    state.advance(report, 0.3, 0, () => {
      throw new Error("no noise requested");
    });
    expect(state.poses[0].x).toBeCloseTo(-0.9 - POSE_RATE * 0.4, 14);
    expect(state.poses[1].x).toBeCloseTo(0.9 + POSE_RATE * 0.4, 14);
    expect(state.L).toBeCloseTo(50 - SIZE_RATE * 0.3, 13);
    // Second step: momentum carries 0.85 of the velocity.
    const next = state.gradient(shape);
    const expected = MOMENTUM * (-POSE_RATE * 0.4) - POSE_RATE * state.gx[0];
    const before = state.poses[0].x;
    state.advance(next, 0.3, 0, () => 0.5);
    expect(state.poses[0].x - before).toBeCloseTo(expected, 14);
    expect(state.vL).toBeCloseTo(MOMENTUM * (-SIZE_RATE * 0.3) - SIZE_RATE * 0.3, 15);

    // A circle pressed through the wall pushes the container outward: dE/dL < 0 and L grows.
    const pressed = loaded(0, 4, [{ x: 0.3, y: 0, theta: 0 }], 2.2);
    const push = pressed.gradient(shape);
    expect(push.sizeGradient).toBeCloseTo(-2 * 0.2 * 0.5, 13);
    pressed.advance(push, 0, 0, () => 0.5);
    expect(pressed.L).toBeCloseTo(2.2 + SIZE_RATE * 0.2, 13);
    expect(pressed.poses[0].x).toBeCloseTo(0.3 - POSE_RATE * 0.4, 13);

    // A deep overlap and a strong pressure are both capped at 0.03 * sqrt(2) * circumradius.
    const deep = loaded(
      4,
      4,
      [
        { x: 0, y: 0, theta: 0.3 },
        { x: 0.01, y: 0.02, theta: 1.1 },
      ],
      50,
    );
    const sharp = softShape(4, { gamma: 1, tau: 0 });
    const cap = STEP_CAP * Math.SQRT2 * circumradius(4);
    const start = deep.poses.map((p) => ({ ...p }));
    deep.advance(deep.gradient(sharp), 1000, 0, () => 0.5);
    deep.poses.forEach((p, i) => {
      expect(Math.hypot(p.x - start[i].x, p.y - start[i].y)).toBeLessThanOrEqual(cap * (1 + 1e-12));
      expect(Math.abs(p.theta - start[i].theta)).toBeLessThanOrEqual(STEP_CAP * (1 + 1e-12));
    });
    expect(Math.hypot(deep.poses[0].x - start[0].x, deep.poses[0].y - start[0].y)).toBeCloseTo(cap, 12);
    expect(deep.L).toBeCloseTo(50 - cap, 12);

    // Noise is drawn only from the supplied stream, and angular noise is 1.5 times positional per unit.
    const noisy = loaded(4, 4, [{ x: 0, y: 0, theta: 0 }], 50);
    const draws = seededRandom(5);
    let count = 0;
    noisy.advance(noisy.gradient(sharp), 0, 0.1, () => {
      count++;
      return draws();
    });
    expect(count).toBeGreaterThanOrEqual(6);
    expect(Math.hypot(noisy.poses[0].x, noisy.poses[0].y)).toBeGreaterThan(0);
    expect(noisy.poses[0].theta).not.toBe(0);
  });

  it("adopts a supplied arrangement by a rigid motion into the phi = 0 container frame", () => {
    const random = seededRandom(7401);
    for (const [N, M] of [
      [4, 4],
      [3, 5],
      [0, 3],
      [5, 0],
    ] as const) {
      const base = scatter({ N, M, P: 7 }, random);
      const start = {
        ...base,
        container_phi: 0.37,
        pieces: base.pieces.map((p) => ({ ...p, x: p.x + 40, y: p.y - 9 })),
      };
      const state = new HardenDynamics({ N, M, P: 7 });
      state.adopt(start);
      const adopted = state.config();
      const box = enclose(N, start.pieces, M, M === 0 ? 0 : 0.37);
      const frame = enclose(N, adopted.pieces, M, 0);
      expect(frame.size).toBeCloseTo(box.size, 11);
      expect(Math.hypot(frame.cx, frame.cy)).toBeLessThan(1e-11);
      expect(state.size).toBeCloseTo(box.size, 11);
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < i; j++) {
          expect(pieceSeparation(N, adopted.pieces[i], adopted.pieces[j]).sep).toBeCloseTo(
            pieceSeparation(N, start.pieces[i], start.pieces[j]).sep,
            11,
          );
        }
      }
    }
  });

  it("legalises by homothety to first contact, apart or together, and leaves coincident centres to restoration", async () => {
    const random = seededRandom(7501);
    for (const N of [0, 3, 4, 7]) {
      for (const spacing of [0.4, 3]) {
        // Too close (overlapping) or too far (no contact): both end with a smallest gap of zero.
        const config: PackingConfig = {
          N,
          M: 4,
          P: 12,
          container_phi: 0,
          pieces: Array.from({ length: 12 }, (_, i) => ({
            x: spacing * boundingRadius(N) * ((i % 4) + 0.2 * random()),
            y: spacing * boundingRadius(N) * (Math.floor(i / 4) + 0.2 * random()),
            theta: random() * 6,
          })),
        };
        let scans = 0;
        const legal = await legalise(
          config,
          () => false,
          (work) => {
            expect(work).toBeGreaterThan(0);
            scans++;
            return true;
          },
        );
        expect(scans).toBeGreaterThan(40);
        expect(findOverlaps(N, legal!.pieces, 0)).toEqual([]);
        expect(minimumSeparation(legal!)).toBeLessThan(1e-10);
        // A homothety about the mean centre: angles and directions from the centre are unchanged.
        expect(legal!.pieces.map((p) => p.theta)).toEqual(config.pieces.map((p) => p.theta));
        const centre = (c: PackingConfig) => c.pieces.reduce((s, p) => s + p.x, 0) / c.P;
        expect(centre(legal!)).toBeCloseTo(centre(config), 10);
      }
    }
    const coincident: PackingConfig = {
      N: 4,
      M: 4,
      P: 3,
      container_phi: 0,
      pieces: Array.from({ length: 3 }, () => ({ x: 1, y: 2, theta: 0 })),
    };
    expect(
      await legalise(
        coincident,
        () => false,
        () => true,
      ),
    ).toBeUndefined();
    expect(
      await legalise(
        scatter({ N: 4, M: 4, P: 9 }, random),
        () => false,
        () => false,
      ),
    ).toBeUndefined();
  });
});

describe("harden budget plan", () => {
  const reference = { compress: 2500, morph: 7500, settle: 1500 };

  it("keeps the reference proportion at every length and always reaches the true shape", () => {
    expect(planPhases(11500, reference)).toEqual(reference);
    expect(planPhases(23000, reference)).toEqual({ compress: 5000, morph: 15000, settle: 3000 });
    expect(planPhases(1150, reference)).toEqual({ compress: 250, morph: 750, settle: 150 });
    for (let steps = 1; steps <= 400; steps++) {
      for (const full of [reference, { compress: 0, morph: 1, settle: 0 }, { compress: 9, morph: 1, settle: 9 }]) {
        for (const compression of [true, false]) {
          const plan = planPhases(steps, full, compression);
          expect(plan.compress + plan.morph + plan.settle).toBe(steps);
          expect(plan.morph).toBeGreaterThanOrEqual(1);
          expect(Math.min(plan.compress, plan.settle)).toBeGreaterThanOrEqual(0);
          if (!compression) expect(plan.compress).toBe(0);
          if (full === reference && compression) {
            expect(Math.abs(plan.compress - (steps * 2500) / 11500)).toBeLessThanOrEqual(1);
            expect(Math.abs(plan.settle - (steps * 1500) / 11500)).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("chooses as many full-length runs as the allowance holds, or the requested number", () => {
    // 11,500 steps at 32 per assessment need 360 assessments.
    expect(planRuns(359, 11500, 32, 0)).toBe(1);
    expect(planRuns(360, 11500, 32, 0)).toBe(1);
    expect(planRuns(719, 11500, 32, 0)).toBe(1);
    expect(planRuns(720, 11500, 32, 0)).toBe(2);
    expect(planRuns(2700, 11500, 32, 0)).toBe(7);
    expect(planRuns(27000, 11500, 32, 0)).toBe(75);
    expect(planRuns(2700, 11500, 32, 3)).toBe(3);
    expect(planRuns(2, 11500, 32, 5)).toBe(2);
    expect(planRuns(1, 11500, 32, 0)).toBe(1);
    expect(planRuns(Infinity, 11500, 32, 0)).toBe(Infinity);
    expect(planRuns(Infinity, 11500, 32, 4)).toBe(4);
  });
});

describe("registered harden method", () => {
  it("describes every schema node, credits the originator and registers the reference defaults", () => {
    const check = (schema: typeof hardenMethod.schema) => {
      expect(schema.title).toBeTruthy();
      expect(schema.description).toBeTruthy();
      Object.values(schema.properties ?? {}).forEach(check);
    };
    check(hardenMethod.schema);
    expect(hardenMethod.schema.title).toContain("Yohei Nakajima");
    expect(hardenMethod.schema.description).toContain("Yohei Nakajima");
    for (const [key, schema] of Object.entries(hardenMethod.schema.properties!)) {
      expect(schema.default, key).toEqual(hardenMethod.defaults[key]);
      if (schema.type !== "string") {
        expect(typeof schema.minimum, key).toBe("number");
        expect(typeof schema.maximum, key).toBe("number");
      }
    }
    expect(Object.keys(hardenMethod.defaults).sort()).toEqual(Object.keys(hardenMethod.schema.properties!).sort());
    expect(hardenMethod.defaults).toMatchObject({
      path: "harden",
      pressure: 0.16,
      noise: 8,
      tau0: 1,
      gamma0: 0.1,
      compressSteps: 2500,
      morphSteps: 7500,
      settleSteps: 1500,
      fill: 3.2,
    });
    expect(hardenMethod.schema.properties!.path.enum).toEqual(["harden", "grow", "rigid", "snap", "grow-area"]);
    expect(registry.list().find((m) => m.name === "harden")?.doc).toBe("docs/methods/harden.md");
  });

  it("never exceeds an evaluation budget, from one evaluation to a few hundred", async () => {
    for (const [problem, budgets] of [
      [{ N: 4, M: 4, P: 5 }, [1, 2, 3, 4, 5, 9, 10, 11, 37, 150, 400]],
      [{ N: 0, M: 3, P: 6 }, [2, 3, 7, 40]],
      [{ N: 5, M: 0, P: 4 }, [2, 3, 7, 40]],
    ] as const) {
      for (const evals of budgets) {
        let frames = 0;
        const result = await run(problem, { method: "harden", seed: 3, budget: { evals }, onProgress: () => frames++ });
        expect(result.evaluations, `evals ${evals}`).toBeLessThanOrEqual(evals);
        expect(result.stages[0].evaluations).toBeLessThanOrEqual(evals - Math.min(evals, Math.ceil(evals / 10)));
        // One evaluation is the polish reserve; from two on the method always scores something.
        expect(result.valid, `evals ${evals}`).toBe(evals >= 2);
        if (result.valid) {
          expect(result.strict).toBe(true);
          expect(result.best!.pieces).toHaveLength(problem.P);
          expect(frames).toBeGreaterThan(0);
        }
      }
    }
  });

  it("spends exactly its allowance: every run completes its path on the planned number of steps", async () => {
    const problem = { N: 4, M: 4, P: 6 };
    for (const evals of [1, 2, 5, 23, 24, 70, 97]) {
      const f = await observed(fake(problem, { evals, params: short }));
      // No assessment is a duplicate here, so the count is exact, not merely bounded.
      expect(f.evaluated).toHaveLength(evals);
      const runs = Math.max(1, Math.floor(evals / 23));
      const starts = f.events.filter((e) => e.kind === "run");
      expect(starts).toHaveLength(runs);
      const ends = f.events.filter((e) => e.kind === "end");
      expect(ends).toHaveLength(runs);
      let steps = 0;
      ends.forEach((end, index) => {
        const total = end.plan.compress + end.plan.morph + end.plan.settle;
        // Never truncated: the run performed every planned step and ended on the true shape.
        expect(end.step).toBe(total);
        expect(total % 4).toBe(0);
        expect(end.shape).toMatchObject({ gamma: 1, tau: 0, scale: 1, padding: 0 });
        if (total >= 92) expect(end.phase).toBe("settle");
        if (total >= 8) {
          expect(Math.abs(end.plan.compress - (total * 20) / 92)).toBeLessThanOrEqual(1);
          expect(Math.abs(end.plan.settle - (total * 12) / 92)).toBeLessThanOrEqual(1);
        }
        expect(starts[index].plan).toEqual(end.plan);
        steps += total;
      });
      expect(f.events.filter((e) => e.kind === "step")).toHaveLength(steps);
      // The first run gives one assessment to the starting grid when it has at least two.
      const insured = evals / runs >= 2 ? 1 : 0;
      expect(steps).toBe((evals - insured) * 4);
    }
  });

  it("holds the path's start through compression and the exact true shape through settling", async () => {
    for (const path of HARDEN_PATHS) {
      const f = await observed(fake({ N: 4, M: 4, P: 5 }, { evals: 23, params: { ...short, path, restarts: 1 } }));
      const steps = f.events.filter((e) => e.kind === "step");
      const first = softShape(4, pathShape(path, 0, 4, options));
      const phases = new Set(steps.map((e) => e.phase));
      expect([...phases]).toEqual(["compress", "morph", "settle"]);
      for (const event of steps) {
        if (event.phase === "compress") expect(event.shape).toEqual(first);
        if (event.phase === "settle") expect(event.shape).toEqual({ gamma: 1, tau: 0, scale: 1, padding: 0 });
        expect(event.shape.scale).toBeLessThanOrEqual(1);
        expect(Number.isFinite(event.size) && event.size > 0).toBe(true);
      }
      const softest = Math.max(...steps.filter((e) => e.phase === "morph").map((e) => e.shape.tau));
      expect(softest).toBe(path === "harden" || path === "snap" ? 1 : 0);
    }
  });

  it("scores only complete, distinct, zero-overlap true-shape arrangements", async () => {
    for (const [N, M, P] of [
      [4, 4, 9],
      [3, 0, 7],
      [0, 6, 8],
      [6, 3, 5],
    ] as const) {
      for (const path of ["harden", "grow"] as const) {
        const f = await observed(fake({ N, M, P }, { evals: 60, params: { ...short, path } }));
        expect(f.evaluated).toHaveLength(60);
        const keys = new Set(f.evaluated.map((c) => JSON.stringify(c.pieces)));
        expect(keys.size).toBe(60);
        for (const config of f.evaluated) {
          expect(config).toMatchObject({ N, M, P, container_phi: 0 });
          expect(config.pieces).toHaveLength(P);
          // Zero tolerance: a soft or overlapping state would fail here.
          expect(findOverlaps(N, config.pieces, 0)).toEqual([]);
          expect(evaluate(config).valid).toBe(true);
        }
        // What the observer saw assessed is what reached the framework.
        expect(f.events.filter((e) => e.kind === "assessment").map((e) => e.config)).toEqual(f.evaluated);
      }
    }
  });

  it("reproduces bits for a seed and an evaluation budget, differs across seeds and never calls Math.random", async () => {
    const spy = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random is not allowed");
    });
    try {
      for (const [problem, params] of [
        [{ N: 4, M: 4, P: 7 }, {}],
        [{ N: 3, M: 0, P: 5 }, { path: "grow" }],
        [{ N: 0, M: 4, P: 6 }, { path: "rigid" }],
        [
          { N: 5, M: 5, P: 4 },
          { path: "snap", restarts: 3 },
        ],
        [{ N: 6, M: 3, P: 4 }, { path: "grow-area" }],
      ] as const) {
        const options = { method: "harden", params, seed: 71, budget: { evals: 150 } };
        const first = await run(problem, options);
        const second = await run(problem, options);
        expect(first.valid && first.strict).toBe(true);
        expect(second.best).toEqual(first.best);
        expect(second.score).toBe(first.score);
        expect(second.evaluations).toBe(first.evaluations);
        expect(second.trace.map(([, score]) => score)).toEqual(first.trace.map(([, score]) => score));
        // An ample time budget beside the evaluation budget changes nothing.
        const timed = await run(problem, { ...options, budget: { evals: 150, time_s: 600 } });
        expect(timed.best).toEqual(first.best);
        const other = await run(problem, { ...options, seed: 72 });
        expect(other.valid && other.strict).toBe(true);
        expect(other.best).not.toEqual(first.best);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("stops at once: no assessment after the stop and the best strict result is returned", async () => {
    const problem = { N: 4, M: 4, P: 8 };
    for (const stopAfter of [1, 2, 7, 31]) {
      const f = await observed(fake(problem, { evals: 100000, params: short, stopAfter }));
      expect(f.evaluated).toHaveLength(stopAfter);
      // Nothing ran on after the refused checkpoint or assessment: at most one interval of steps.
      const last = f.events.at(-1)!;
      expect(last.kind).not.toBe("end");
      const stepsAfter = f.events.length - 1 - f.events.map((e) => e.kind).lastIndexOf("assessment");
      expect(stepsAfter).toBeLessThanOrEqual(6);
    }

    const control = { aborted: false };
    let atAbort = -1;
    let frames = 0;
    const result = await run(
      { N: 4, M: 4, P: 60 },
      {
        method: "harden",
        seed: 5,
        budget: { evals: 1000000 },
        control,
        onProgress: (frame) => {
          // Stop from inside the run once a few true-shape frames have been offered.
          if (++frames === 4) {
            control.aborted = true;
            atAbort = frame.evaluations;
          }
        },
      },
    );
    // Counted, not timed: the run ends without one more assessment after the stop request.
    expect(atAbort).toBeGreaterThan(0);
    expect(result.termination).toBe("aborted");
    expect(result.evaluations).toBe(atAbort);
    expect(result.valid && result.strict).toBe(true);
    expect(findOverlaps(4, result.best!.pieces, strictTolerance(result.best!))).toEqual([]);

    const before = await run(
      { N: 4, M: 4, P: 300 },
      { method: "harden", seed: 5, budget: { evals: 1000000 }, control: { aborted: true } },
    );
    expect(before.evaluations).toBe(0);
    expect(before.termination).toBe("aborted");
  });

  it("returns the same bits when paused and resumed as when left alone", async () => {
    const problem = { N: 4, M: 4, P: 24 };
    const options = { method: "harden", seed: 12, budget: { evals: 120 }, finalPolish: false };
    const plain = await run(problem, options);
    // The run starts paused and a timer then toggles the pause every 15 ms until it ends.
    const state = { paused: true };
    let seenPaused = 0;
    let toggles = 0;
    const control = {
      aborted: false,
      get paused() {
        if (state.paused) seenPaused++;
        return state.paused;
      },
    };
    const timer = setInterval(() => {
      state.paused = !state.paused;
      toggles++;
    }, 15);
    try {
      const result = await run(problem, { ...options, control });
      expect(seenPaused).toBeGreaterThan(0);
      expect(toggles).toBeGreaterThanOrEqual(1);
      expect(result.best).toEqual(plain.best);
      expect(result.score).toBe(plain.score);
      expect(result.evaluations).toBe(plain.evaluations);
      expect(result.termination).toBe(plain.termination);
      expect(result.valid && result.strict).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it("places checkpoints by counted work, identically in repeated runs, also inside one large gradient", async () => {
    for (const [problem, params, evals] of [
      [{ N: 4, M: 4, P: 200 }, {}, 6],
      [{ N: 0, M: 0, P: 500 }, {}, 3],
      [{ N: 20, M: 20, P: 60 }, {}, 4],
      [{ N: 48, M: 7, P: 24 }, { path: "harden", tau0: 0.5 }, 3],
    ] as const) {
      const record = async () => {
        const f = await observed(fake(problem, { evals, params: { ...params, evaluationInterval: 16 } }));
        return f;
      };
      const first = await record();
      const second = await record();
      const stops = first.events.filter((e) => e.kind === "checkpoint");
      const steps = first.events.filter((e) => e.kind === "step").length;
      expect(steps).toBeGreaterThanOrEqual(16);
      expect(stops.length).toBeGreaterThan(3);
      // A checkpoint is due at CHECKPOINT_WORK and taken at the next part boundary: a part is at
      // most a quarter of it, or one pair or one piece's walls if that is larger.
      const N = problem.N;
      const part = Math.max(CHECKPOINT_WORK / 4, 2 * N + 2 * N * N, 1 + Math.max(1, N) * Math.max(1, problem.M));
      const slack = part + 13 * problem.P + (problem.P * (problem.P - 1)) / 2;
      for (const stop of stops) {
        expect(stop.work).toBeGreaterThanOrEqual(CHECKPOINT_WORK);
        expect(stop.work).toBeLessThanOrEqual(CHECKPOINT_WORK + slack);
      }
      // Counted work, not the clock: the same places every time.
      const places = (f: Fake) => f.events.filter((e) => e.kind === "checkpoint").map((e) => [e.run, e.step, e.work]);
      expect(places(second)).toEqual(places(first));
      expect(second.evaluated).toEqual(first.evaluated);
      // The framework is polled at every counted checkpoint (and at entry and each run start).
      expect(first.checkpoints()).toBe(stops.length + 2);
    }
  });

  it("returns valid, strict packings across piece and container kinds, with and without a start", async () => {
    const cases: [number, number, number][] = [
      [4, 4, 1],
      [0, 0, 1],
      [3, 3, 1],
      [0, 0, 7],
      [0, 4, 6],
      [4, 0, 5],
      [3, 3, 4],
      [3, 5, 6],
      [5, 3, 3],
      [12, 4, 5],
      [4, 12, 6],
      [64, 0, 3],
      [0, 64, 4],
      [64, 64, 2],
      [3, 64, 5],
      [8, 6, 20],
    ];
    for (const [N, M, P] of cases) {
      const problem = { N, M, P };
      const loose = scatter(problem, seededRandom(100 + N + M + P));
      const coincident = {
        ...problem,
        container_phi: 0.2,
        pieces: loose.pieces.map(() => ({ x: 3, y: -2, theta: 0.1 })),
      };
      const starts: [string, PackingConfig | undefined][] = [
        ["none", undefined],
        ["loose", { ...loose, container_phi: 0.3 }],
      ];
      if (P > 1) starts.push(["coincident", coincident], ["incomplete", { ...loose, pieces: loose.pieces.slice(1) }]);
      for (const [label, start] of starts) {
        const result = await run(problem, { method: "harden", start, seed: 9, budget: { evals: 40 } });
        const name = `${N}/${M}/${P} ${label}`;
        expect(result.valid, `${name}: ${result.reasons.join("; ")}`).toBe(true);
        expect(result.strict, name).toBe(true);
        expect(result.evaluations, name).toBeLessThanOrEqual(40);
        expect(result.best!.pieces, name).toHaveLength(P);
        expect(minimumSeparation(result.best!), name).toBeGreaterThanOrEqual(-1e-12);
        expect(findOverlaps(N, result.best!.pieces, strictTolerance(result.best!)), name).toEqual([]);
        const container = enclose(N, result.best!.pieces, M, result.best!.container_phi);
        expect(container.size, name).toBeCloseTo(result.score!, 9);
        expect(
          Math.max(...result.best!.pieces.flatMap((p) => containerProtrusions(N, p, container).map((v) => v.depth))),
          name,
        ).toBeLessThan(1e-9);
        // A valid start is the framework's fallback: the method can only improve on it.
        if (label === "loose")
          expect(result.score!, name).toBeLessThanOrEqual(evaluate(start!, { autoOrient: true }).score! + 1e-12);
        if (P === 1) expect(result.score!, name).toBeLessThan((M === 0 ? 1 : 2) * boundingRadius(N) * 2.5);
      }
    }
  }, 120000);

  it("starts the first run from a supplied arrangement without compression, then restarts at random", async () => {
    const problem = { N: 4, M: 4, P: 6 };
    const start = { ...scatter(problem, seededRandom(8)), container_phi: 0.4 };
    const f = await observed(fake(problem, { evals: 69, params: short, start }));
    const runs = f.events.filter((e) => e.kind === "run");
    expect(runs).toHaveLength(3);
    expect(runs[0].plan.compress).toBe(0);
    expect(runs[0].plan.morph + runs[0].plan.settle).toBe(92);
    expect(runs[0].size).toBeCloseTo(enclose(4, start.pieces, 4, 0.4).size, 11);
    expect(runs[1].plan).toEqual({ compress: 20, morph: 60, settle: 12 });
    expect(runs[2].plan).toEqual({ compress: 20, morph: 60, settle: 12 });
    // The valid start was scored by the framework; the method does not spend an assessment on it.
    expect(f.evaluated).toHaveLength(69);
    expect(f.events.find((e) => e.kind === "assessment")!.step).toBe(4);

    // An overlapping start is legalised and scored before the dynamics begin.
    const crushed = { ...start, pieces: start.pieces.map((p) => ({ ...p, x: p.x / 4, y: p.y / 4 })) };
    expect(evaluate(crushed).valid).toBe(false);
    const g = await observed(fake(problem, { evals: 69, params: short, start: crushed }));
    const early = g.events.find((e) => e.kind === "assessment")!;
    expect(early.step).toBe(0);
    expect(findOverlaps(4, early.config!.pieces, 0)).toEqual([]);
    expect(g.events.filter((e) => e.kind === "run")[0].plan.compress).toBe(0);
  });

  it("restarts with fresh seeded starts whenever the budget holds more than one full run", async () => {
    const problem = { N: 4, M: 4, P: 5 };
    const count = async (evals: number, params: Record<string, unknown> = {}) => {
      const f = await observed(fake(problem, { evals, params: { ...short, ...params } }));
      return f.events.filter((e) => e.kind === "run");
    };
    // A full run is 92 steps at 4 per assessment: 23 assessments.
    expect(await count(22)).toHaveLength(1);
    expect(await count(45)).toHaveLength(1);
    expect(await count(46)).toHaveLength(2);
    expect(await count(230)).toHaveLength(10);
    expect(await count(230, { restarts: 4 })).toHaveLength(4);
    expect(await count(22, { restarts: 4 })).toHaveLength(4);
    // Each restart begins in the fill-area container with its own random poses.
    const runs = await count(92);
    const size = Math.sqrt(3.2 * 5);
    for (const event of runs) expect(event.size).toBeCloseTo(size, 12);
    const f = await observed(fake(problem, { evals: 92, params: short }));
    const finals = f.events
      .filter((e) => e.kind === "assessment" && e.step > 0 && e.step === e.plan.compress + e.plan.morph + e.plan.settle)
      .map((e) => e.config);
    expect(finals).toHaveLength(4);
    expect(new Set(finals.map((c) => JSON.stringify(c))).size).toBe(4);
    // Through the framework: more budget means more runs, and the best of them is kept.
    const one = await run(problem, { method: "harden", seed: 2, budget: { evals: 400 }, finalPolish: false });
    const many = await run(problem, { method: "harden", seed: 2, budget: { evals: 1600 }, finalPolish: false });
    expect(many.score!).toBeLessThanOrEqual(one.score! + 1e-12);
  });

  it("without an evaluation budget runs full-length restarts until stopped, after scoring the grid first", async () => {
    // The fake context has unlimited evaluations, as under a time-only budget, and stops by count.
    const problem = { N: 4, M: 4, P: 5 };
    const f = await observed(fake(problem, { params: short, stopAfter: 60 }));
    expect(f.evaluated).toHaveLength(60);
    // The jitter-free grid is scored before any momentum step, so an early stop has a result.
    expect(f.evaluated[0]).toEqual(scatter(problem, () => 0.5));
    const firstAssessment = f.events.findIndex((e) => e.kind === "assessment");
    expect(f.events.slice(0, firstAssessment).some((e) => e.kind === "step")).toBe(false);
    // Grid, two complete runs of 23 assessments, and a third run cut after 13 more.
    const runs = f.events.filter((e) => e.kind === "run");
    expect(runs).toHaveLength(3);
    for (const event of runs) expect(event.plan).toEqual({ compress: 20, morph: 60, settle: 12 });
    expect(f.events.filter((e) => e.kind === "end")).toHaveLength(2);
    // The cut run's most recent legalised state was scored at most one interval before the stop.
    const last = f.events.at(-1)!;
    expect(last.run).toBe(2);
    // The 60th assessment falls at step 52; at most one more interval of steps runs before the stop is seen.
    expect(last.step).toBeGreaterThanOrEqual(52);
    expect(last.step).toBeLessThanOrEqual(56);
    expect(f.events.map((e) => e.kind).lastIndexOf("assessment")).toBeGreaterThanOrEqual(f.events.length - 6);
    for (const config of f.evaluated) expect(findOverlaps(4, config.pieces, 0)).toEqual([]);

    // A large problem stopped at once still has the strict grid, scored before any gradient work.
    const large = { N: 4, M: 4, P: 400 };
    const g = await observed(fake(large, { stopAfter: 1 }));
    expect(g.evaluated).toEqual([scatter(large, () => 0.5)]);
    const scored = g.events.findIndex((e) => e.kind === "assessment");
    expect(g.events.slice(0, scored).some((e) => e.kind === "step" || e.kind === "checkpoint")).toBe(false);
    // The stop is seen at the next counted checkpoint: within one gradient of 400 pieces.
    expect(g.events.filter((e) => e.kind === "step").length).toBeLessThanOrEqual(32);
    expect(findOverlaps(4, g.evaluated[0].pieces, 0)).toEqual([]);

    // Through the framework a time-only run ends on time with a strict result (no duration is asserted).
    const result = await run(problem, { method: "harden", seed: 4, budget: { time_s: 1 } });
    expect(result.termination).toBe("time");
    expect(result.valid && result.strict).toBe(true);
    expect(result.evaluations).toBeGreaterThan(1);
  });

  it("finds known small optima as the best of several seeds and never ends near the trivial layout", async () => {
    // Published values: 2 + 1/sqrt(2) for five squares in a square, 3 for seven circles in a circle.
    // Trajectories are chaotic, so a single seed may differ between platforms; the assertions are
    // on the best of several seeds, with every seed far below the trivial grid (side 3; radius 4).
    const squares: number[] = [];
    for (const seed of [1, 2, 3, 4]) {
      const result = await run({ N: 4, M: 4, P: 5 }, { method: "harden", seed, budget: { evals: 3000 } });
      expect(result.valid && result.strict).toBe(true);
      expect(result.score!).toBeGreaterThan(2 + Math.SQRT1_2 - 1e-9);
      expect(result.score!).toBeLessThan(2.9);
      squares.push(result.score!);
    }
    expect(Math.min(...squares)).toBeLessThan(2 + Math.SQRT1_2 + 1e-4);
    const circles: number[] = [];
    for (const seed of [1, 2, 3]) {
      const result = await run({ N: 0, M: 0, P: 7 }, { method: "harden", seed, budget: { evals: 800 } });
      expect(result.valid && result.strict).toBe(true);
      expect(result.score!).toBeGreaterThan(3 - 1e-9);
      expect(result.score!).toBeLessThan(3.3);
      circles.push(result.score!);
    }
    expect(Math.min(...circles)).toBeLessThan(3 + 1e-6);
  });

  it("keeps a bounded, compact memory of scored arrangements and still recognises duplicates", () => {
    const random = seededRandom(7601);
    const seen = new SeenArrangements(4);
    expect(seen.limit).toBe(16384);
    const arrangement = (): PackingConfig => ({
      N: 4,
      M: 4,
      P: 500,
      container_phi: 0,
      pieces: Array.from({ length: 500 }, () => ({ x: 40 * random(), y: 40 * random(), theta: 6 * random() })),
    });
    const first = arrangement();
    // One full-text signature of this arrangement is tens of thousands of characters.
    expect(JSON.stringify(first.pieces.map((p) => [p.x, p.y, p.theta])).length).toBeGreaterThan(20000);
    expect(seen.add(first)).toBe(true);
    expect(seen.add({ ...first, pieces: first.pieces.map((p) => ({ ...p })) })).toBe(false);
    // Equal numbers are equal arrangements: negative zero is zero.
    const zero = { ...first, pieces: first.pieces.map((p, i) => (i === 7 ? { ...p, x: 0 } : p)) };
    const minus = { ...first, pieces: first.pieces.map((p, i) => (i === 7 ? { ...p, x: -0 } : p)) };
    expect(seen.key(minus)).toBe(seen.key(zero));
    // One unit in the last place of one coordinate is a different arrangement.
    const nudged = {
      ...first,
      pieces: first.pieces.map((p, i) => (i === 311 ? { ...p, y: p.y * (1 + 2 ** -52) } : p)),
    };
    expect(nudged.pieces[311].y).not.toBe(first.pieces[311].y);
    expect(seen.key(nudged)).not.toBe(seen.key(first));
    expect(seen.key({ ...first, pieces: first.pieces.slice().reverse() })).not.toBe(seen.key(first));
    // Circle angles are ignored; polygon angles are not.
    const turned = { ...first, pieces: first.pieces.map((p) => ({ ...p, theta: p.theta + 1 })) };
    expect(seen.key(turned)).not.toBe(seen.key(first));
    const circles = new SeenArrangements(0);
    expect(circles.key({ ...turned, N: 0 })).toBe(circles.key({ ...first, N: 0 }));
    // Far more arrangements than the limit: the set and its retained text stay bounded, at
    // under a megabyte where full signatures of these would need hundreds of megabytes.
    const small = new SeenArrangements(4);
    const keys = new Set<string>();
    for (let k = 0; k < 40000; k++) {
      const config = { ...first, pieces: first.pieces.map((p, i) => (i === k % 500 ? { ...p, x: p.x + k + 1 } : p)) };
      expect(small.add(config)).toBe(true);
      keys.add(small.key(config));
    }
    expect(keys.size).toBe(40000);
    expect(small.size).toBe(16384);
    expect(small.retained).toBeLessThanOrEqual(16384 * 15);
    // The oldest are forgotten first: the most recent is remembered, the first is not.
    const latest = { ...first, pieces: first.pieces.map((p, i) => (i === 39999 % 500 ? { ...p, x: p.x + 40000 } : p)) };
    expect(small.add(latest)).toBe(false);
    const oldest = { ...first, pieces: first.pieces.map((p, i) => (i === 0 ? { ...p, x: p.x + 1 } : p)) };
    expect(small.add(oldest)).toBe(true);
  });
});
