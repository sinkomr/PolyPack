import { describe, expect, it } from "vitest";
import {
  SPACE_DOMAINS,
  parseSpaceId,
  validateSpaceSubmission,
  validateSpaceSubmissionAsync,
  SPACE_MAX_P,
  buildSpaceCatalogue,
  problemOf,
  storedSpaceConfig,
  storedSpaceConfigAsync,
} from "../src";
import { pieceGeometry } from "@polypack/curved";
import { quatFromCentreTheta, quatMul, inradiusAngle, type Quat } from "@polypack/sphere";
import { parseSearchProblem, spaceKernel } from "../src/search";
import type { SpaceName } from "../src";

const shapes = [3, 7, 12, 20, 100];
function example(space: SpaceName, N: number, P: number) {
  const R = pieceGeometry(N, -1e-6).R;
  if (space === "curved")
    return {
      id: `curved/-1e-06/${N}/0/${P}`,
      config: { size: 3 * R * P + 1, pieces: Array.from({ length: P }, (_, i) => ({ x: 3 * R * i, y: 0, theta: 0 })) },
    };
  if (space === "sphere")
    return {
      id: `sphere/${N}/${P}`,
      config: {
        rho: Math.max(100, N * P),
        pieces: Array.from({ length: P }, (_, i) => ({
          q: quatFromCentreTheta([Math.cos((2 * Math.PI * i) / P), Math.sin((2 * Math.PI * i) / P), 0], 0),
        })),
      },
    };
  const r = 0.5 / Math.sin(Math.PI / N);
  return {
    id: `torus/sq/${N}/${P}`,
    config: { lattice: { L: 4 * r * P }, poses: Array.from({ length: P }, (_, i) => [3 * r * i, 0, 0]) },
  };
}

describe("curved, sphere and torus range domains", () => {
  it("has bounded deterministic samples, rejects outside choices, and leaves new problems without records", () => {
    for (const space of ["curved", "sphere", "torus"] as const) {
      const d = SPACE_DOMAINS[space]!;
      const cat = buildSpaceCatalogue(space, { records: [] }, d);
      const parsedNew = parseSpaceId(space, example(space, 100, 100).id);
      if (typeof parsedNew === "string") throw new Error(parsedNew);
      expect(problemOf(cat, parsedNew)).toMatchObject({ status: "no_record", certified: null, config: null, P: 100 });
      expect(SPACE_MAX_P[space]).toBe(100);
      expect(d.sample(0)).toEqual([]);
      expect(d.sample(9)).toEqual(d.sample(20).slice(0, 9));
      expect(new Set(d.sample(20)).size).toBe(20);
      for (const N of [0, ...shapes])
        for (const P of [1, 2, 100]) {
          const { id } = example(space, N === 0 ? 3 : N, P);
          const parsed = parseSpaceId(space, id.replace(`/${N === 0 ? 3 : N}/`, `/${N}/`));
          expect(typeof parsed).toBe("object");
          if (typeof parsed !== "string") {
            expect(d.bound(parsed)).not.toBeUndefined();
            expect(d.bound({ ...parsed, P: 101 })).toBeUndefined();
            expect(d.bound({ ...parsed, fields: { ...parsed.fields, N: 101 } })).toBeUndefined();
          }
        }
    }
  });
  it("validates the small certified constructions and supports them in the volunteer parser and kernels", () => {
    for (const space of ["curved", "sphere", "torus"] as const)
      for (const N of shapes)
        for (const P of [1, 2, 5]) {
          const { id, config } = example(space, N, P);
          const parsed = parseSpaceId(space, id);
          if (typeof parsed === "string") throw new Error(parsed);
          const bound = SPACE_DOMAINS[space]!.bound(parsed);
          const v = validateSpaceSubmission(space, id, config, { bound: bound?.value, noRecord: true });
          expect(v.valid, `${id}: ${v.reasons}`).toBe(true);
          const search = parseSearchProblem(id)!;
          expect(search).not.toBeNull();
          const kernel = spaceKernel(search)!;
          expect(Number.isFinite(kernel.finishCost)).toBe(true);
          expect(Number.isFinite(kernel.validateCost)).toBe(true);
          expect(kernel.validate(config).valid).toBe(true);
          const state = kernel.fromConfig(config);
          expect(state).not.toBeNull();
          if (!state) throw new Error(`kernel could not read ${id}`);
          const gradient = new Float64Array(kernel.P * kernel.dim + kernel.globals + 1);
          expect(Number.isFinite(kernel.energy(state, gradient))).toBe(true);
          expect([...gradient].every(Number.isFinite)).toBe(true);
          expect(kernel.validate(kernel.toConfig(state)).valid).toBe(true);
        }
  });
  it("checks N = 100, P = 100 in bounded slices for valid and adversarial configurations", async () => {
    const N = 100,
      P = 100;
    const theta = Math.PI / N,
      curvedStep = 2 * pieceGeometry(N, -1e-6).rho + 1e-7;
    const torusStep = 1 / Math.tan(Math.PI / N) + 1e-7;
    const sphereStep = 2 * inradiusAngle(N, 1000) + 1e-10;
    const spin: Quat = [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)];
    const configs = {
      curved: {
        size: P * curvedStep,
        pieces: Array.from({ length: P }, (_, i) => ({ x: (i - 49.5) * curvedStep, y: 0, theta })),
      },
      sphere: {
        rho: 1000,
        pieces: Array.from({ length: P }, (_, i) => ({
          q: quatMul([Math.cos((i * sphereStep) / 2), 0, Math.sin((i * sphereStep) / 2), 0], spin),
        })),
      },
      torus: {
        lattice: { L: 10 * torusStep },
        poses: Array.from({ length: P }, (_, i) => [
          torusStep * ((i % 10) - 4.5),
          torusStep * (Math.floor(i / 10) - 4.5),
          theta,
        ]),
      },
    };
    for (const space of ["curved", "sphere", "torus"] as const)
      for (const invalid of [false, true]) {
        const { id } = example(space, N, P);
        const c = structuredClone(configs[space]);
        if (invalid) {
          if ("poses" in c) c.poses.fill([0, 0, 0]);
          else if ("rho" in c) c.pieces.fill({ q: [1, 0, 0, 0] as Quat });
          else c.pieces.fill({ x: 0, y: 0, theta: 0 });
        }
        const sync = validateSpaceSubmission(space, id, c, { noRecord: true });
        let turns = 0;
        const timer = setInterval(() => turns++, 0);
        const v = await validateSpaceSubmissionAsync(space, id, c, { noRecord: true, sliceMs: 2 });
        clearInterval(timer);
        expect(v.valid, `${space}: ${v.reasons}`).toBe(!invalid);
        expect(v.valid).toBe(sync.valid);
        expect(v.reasons).toEqual(sync.reasons);
        // Allow scheduler pauses on a shared machine; isolated slice measurements are reported separately.
        expect(v.longestSliceMs).toBeLessThan(150);
        console.log(
          JSON.stringify({
            space,
            invalid,
            workMs: v.workMs,
            longestSliceMs: v.longestSliceMs,
            slices: v.slices,
            turns,
          }),
        );
        if (space === "sphere" && invalid) expect(turns).toBeGreaterThan(0);
      }
  });
  it("also slices the storage recheck of a large free torus", async () => {
    const step = 1 / Math.tan(Math.PI / 100) + 1e-7,
      L = 10 * step;
    const config = {
      lattice: { b1: [L, 0], b2: [0, -L] },
      poses: Array.from({ length: 100 }, (_, i) => [
        step * ((i % 10) - 4.5),
        step * (Math.floor(i / 10) - 4.5),
        Math.PI / 100,
      ]),
    };
    const id = "torus/free/100/100",
      opts = { noRecord: true, sliceMs: 1 };
    const result = await storedSpaceConfigAsync("torus", id, config, opts);
    expect(result.config).toEqual(storedSpaceConfig("torus", id, config, opts));
    expect(result.config).not.toEqual(config);
    expect(result.slices).toBeGreaterThan(3);
    expect(result.longestSliceMs).toBeLessThan(150);
    expect(validateSpaceSubmission("torus", id, result.config, opts).valid).toBe(true);
  });
  it("decides touching, hair overlaps, and containment or periodic boundary crossings for 100-gons", () => {
    const N = 100,
      r = 0.5 / Math.tan(Math.PI / N),
      R = 0.5 / Math.sin(Math.PI / N),
      theta = Math.PI / N;
    const curved = (gap: number) => ({
      size: 4 * R,
      pieces: [
        { x: 0, y: 0, theta },
        { x: 2 * r + gap, y: 0, theta },
      ],
    });
    // The standalone curved validator includes K = 0, even though the site's K menu is unchanged.
    for (const gap of [0, 1e-7, -1e-7]) {
      expect(validateSpaceSubmission("curved", "curved/0/100/0/2", curved(gap)).valid).toBe(gap >= 0);
      const torus = { lattice: { L: 2 * r + gap }, poses: [[0, 0, theta]] };
      expect(validateSpaceSubmission("torus", "torus/sq/100/1", torus).valid).toBe(gap >= 0);
    }
    for (const gap of [0, 1e-7, -1e-7]) {
      expect(
        validateSpaceSubmission("curved", "curved/0/100/0/1", { size: R + gap, pieces: [{ x: 0, y: 0, theta: 0 }] })
          .valid,
      ).toBe(gap >= 0);
    }
    // Crossing a fundamental-cell edge is valid; only overlap with a periodic image rejects it.
    expect(
      validateSpaceSubmission("torus", "torus/sq/100/2", {
        lattice: { L: 100 },
        poses: [
          [-1, 0, theta],
          [2 * r - 1 + 1e-7, 0, theta],
        ],
      }).valid,
    ).toBe(true);
  });
  it("rejects malformed large-N submissions and enforces P = 100 in kernel limit copies", () => {
    for (const space of ["curved", "sphere", "torus"] as const) {
      const { id } = example(space, 100, 2);
      expect(validateSpaceSubmission(space, id, { pieces: [null, null], poses: [null, null] }).valid).toBe(false);
      const p = parseSearchProblem(example(space, 100, 100).id)!;
      expect(spaceKernel(p)).toBeDefined();
      expect(spaceKernel({ ...p, id: p.id.replace(/100$/, "101"), P: 101 })).toBeNull();
    }
  });
});
