import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { visitContainerProtrusions, type Container, type Pose } from "@polypack/geometry";
import { clearlyInside } from "../src/methods/mc_compress/state";

/** The exact test: every constraint depth the visitor reports is finite and not positive. */
function inside(N: number, pose: Pose, container: Container, supportOnly: boolean): boolean {
  let valid = Number.isFinite(container.size) && container.size > 0;
  visitContainerProtrusions(N, pose, container, (depth) => {
    if (!Number.isFinite(depth) || depth > 0) valid = false;
  }, supportOnly);
  return valid;
}

describe("clearlyInside", () => {
  it("is true only where every constraint of both visitor modes holds", () => {
    let accepted = 0;
    fc.assert(
      fc.property(
        fc.constantFrom(0, 3, 4, 5, 6, 7, 12, 100),
        fc.constantFrom(0, 3, 4, 6, 7, 12),
        fc.double({ min: -6, max: 6, noNaN: true }),
        fc.double({ min: -6, max: 6, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: 0.5, max: 14, noNaN: true }),
        fc.double({ min: -4, max: 4, noNaN: true }),
        (N, M, x, y, theta, size, phi) => {
          const container: Container = { M, cx: 0.3, cy: -0.2, phi: M === 0 ? 0 : phi, size: size * (N === 100 ? 40 : 1) };
          const pose: Pose = { x, y, theta };
          if (!clearlyInside(N, pose, container)) return;
          accepted++;
          expect(inside(N, pose, container, false)).toBe(true);
          expect(inside(N, pose, container, true)).toBe(true);
        },
      ),
      { numRuns: 20000 },
    );
    expect(accepted).toBeGreaterThan(1000);
  });

  it("leaves non-finite poses and containers to the exact test", () => {
    const box: Container = { M: 4, cx: 0, cy: 0, phi: 0, size: 10 };
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(clearlyInside(4, { x: bad, y: 0, theta: 0 }, box)).toBe(false);
      expect(clearlyInside(4, { x: 0, y: 0, theta: bad }, box)).toBe(false);
      expect(clearlyInside(4, { x: 0, y: 0, theta: 0 }, { ...box, size: bad })).toBe(false);
      expect(clearlyInside(4, { x: 0, y: 0, theta: 0 }, { ...box, phi: bad })).toBe(false);
    }
    expect(clearlyInside(4, { x: 0, y: 0, theta: 0 }, { ...box, size: 0 })).toBe(false);
    expect(clearlyInside(4, { x: 0, y: 0, theta: 0 }, box)).toBe(true);
  });
});
