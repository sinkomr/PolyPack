/**
 * A generic method and a kernel for tests of the spaces' methods that do not depend on a space's
 * kernel: the reference kernel of packages/methods (unit-radius disks in a circle, in working units)
 * stands in for the problem curved/-1e-06/0/0/7, seven disks of diameter 1 in a disk at curvature
 * -1e-6, in its format and in site units (the stand-in converts exactly: centres times 1/2, and the
 * container's radius R in working units is the site diameter R).
 * [EST] At negative curvature the exponential map from the centre never shortens distances
 * (comparison with the flat plane), and a centre's distance from the centre is its geodesic one, so
 * a valid flat packing of the reference kernel is valid there too: the server's rule checks it.
 * Shared by the board's tests (apps/web/test).
 */
import {
  type MethodContext,
  type SpaceKernel,
  type SpaceMethodDefinition,
  getMethod,
  registerMethod,
  squeeze,
} from "@polypack/methods";
import { type DisksConfig, disksKernel } from "@polypack/methods/reference";
import { checkSpaceConfig, setKernelFactoryForTests } from "../src/search";

export const DISKS = "curved/-1e-06/0/0/7";
// The curved disk records are archived by the units change (radius-1 records, not served), so this
// fixture no longer reads one: the flat optimum is built here. Seven disks of diameter 1 touch in a
// hexagon of side 1 inside a container of diameter 3. [EST] At K < 0 distances from the centre are
// geodesic and other distances do not shrink, so the flat packing is valid at K = -1e-6.
const HEX = [[0, 0], ...Array.from({ length: 6 }, (_, k) => [Math.cos((k * Math.PI) / 3), Math.sin((k * Math.PI) / 3)])];
/** The problem's lower bound (the flat area bound sqrt 7, rounded down) and the certified size. */
export const disksRule = { bound: 2.6, certified: 3 };

/** The flat optimum grown by 1 %: valid, and room to improve. */
export const grownDisks = () => ({
  size: 3 * 1.01,
  pieces: HEX.map(([x, y]) => ({ x, y, theta: 0 })),
});

/** The reference kernel of P unit disks in a circle, in the curved space's format, checked by the server's rule. */
export function curvedDisks(P: number): SpaceKernel {
  const k = disksKernel(P);
  // working units (unit-radius disks, container radius R) to site units (diameter-1 disks, container diameter R)
  const toCurved = (c: DisksConfig) => ({
    size: c.R,
    pieces: c.centres.map(([x, y]) => ({ x: x / 2, y: y / 2, theta: 0 })),
  });
  const fromCurved = (c: unknown): DisksConfig | null => {
    const v = c as { size?: number; pieces?: { x: number; y: number }[] };
    return v && typeof v.size === "number" && Array.isArray(v.pieces)
      ? { R: v.size, centres: v.pieces.map((q) => [2 * q.x, 2 * q.y] as [number, number]) }
      : null;
  };
  return {
    ...k,
    space: "curved",
    id: DISKS,
    fromConfig: (c) => {
      const d = fromCurved(c);
      return d ? k.fromConfig(d) : null;
    },
    toConfig: (s) => toCurved(k.toConfig(s) as DisksConfig),
    finish: (s) => {
      const f = k.finish(s);
      return f ? { config: toCurved(f.config as DisksConfig), score: f.score } : null;
    },
    validate: (c) => checkSpaceConfig("curved", DISKS, c, disksRule),
  };
}

/** A generic method for tests: squeezes the start, then random starts, offering each. */
export const restarts: SpaceMethodDefinition = {
  name: "spaces_test_restarts",
  title: "Restarts (test)",
  summary: "Squeezes the start, then random starts.",
  doc: "docs/methods/dimensions/spaces_test_restarts.md",
  requires: [],
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { mu: { type: "number", exclusiveMinimum: 0 } },
  },
  defaults: { mu: 1e4 },
  run(ctx: MethodContext) {
    const k = ctx.kernel;
    if (ctx.start) {
      squeeze(k, ctx.start, { mus: [10, 100, ctx.params.mu as number] });
      ctx.offer(ctx.start);
    }
    for (;;) {
      const s = k.randomStart(ctx.rng);
      squeeze(k, s, { mus: [10, 100, ctx.params.mu as number] });
      ctx.offer(s);
    }
  },
};

/** A method that needs a capability the stand-in kernel lacks. */
export const swapper: SpaceMethodDefinition = {
  ...restarts,
  name: "spaces_test_swapper",
  doc: "docs/methods/dimensions/spaces_test_swapper.md",
  requires: ["swap"],
};

/** What the last run of the probe method was given, and what its one offer came to. */
export const probeSeen: {
  start: boolean | null;
  params: Record<string, unknown> | null;
  remaining: number | null;
  offered: number | null | undefined;
} = { start: null, params: null, remaining: null, offered: undefined };

/** A method that records what it is given (its start, parameters and budget), then offers one squeezed random start. */
export const probe: SpaceMethodDefinition = {
  ...restarts,
  name: "spaces_test_probe",
  doc: "docs/methods/dimensions/spaces_test_probe.md",
  run(ctx: MethodContext) {
    probeSeen.start = ctx.start !== null;
    probeSeen.params = { ...ctx.params };
    probeSeen.remaining = ctx.remaining();
    probeSeen.offered = undefined;
    const s = ctx.kernel.randomStart(ctx.rng);
    squeeze(ctx.kernel, s, { mus: [10, 100, ctx.params.mu as number] });
    probeSeen.offered = ctx.offer(s);
  },
};

// registered once per test file (each file has its own registry)
for (const m of [restarts, swapper, probe]) if (!getMethod(m.name)) registerMethod(m);

/** The stand-in kernel for DISKS; every other problem still has none (its factory throws, as the real ones do). */
export const withDisks = () =>
  setKernelFactoryForTests((p) => {
    if (p.id !== DISKS) throw new Error("no kernel");
    return curvedDisks(p.P);
  });

/** No kernel for any problem, as before the spaces build theirs: every problem offers Auto alone. */
export const withoutKernels = () =>
  setKernelFactoryForTests(() => {
    throw new Error("no kernel");
  });
