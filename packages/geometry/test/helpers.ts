import fc from "fast-check";
import { Pose } from "../src";

/** Area of the intersection of two convex counter-clockwise polygons (Sutherland-Hodgman clipping). */
export function intersectionArea(a: Float64Array, b: Float64Array): number {
  let poly: number[] = Array.from(a);
  const nb = b.length / 2;
  for (let i = 0; i < nb && poly.length >= 6; i++) {
    const j = (i + 1) % nb;
    const px = b[2 * i];
    const py = b[2 * i + 1];
    const ex = b[2 * j] - px;
    const ey = b[2 * j + 1] - py;
    // inside is to the left of the directed edge
    const side = (x: number, y: number) => ex * (y - py) - ey * (x - px);
    const out: number[] = [];
    const n = poly.length / 2;
    for (let k = 0; k < n; k++) {
      const x1 = poly[2 * k];
      const y1 = poly[2 * k + 1];
      const x2 = poly[2 * ((k + 1) % n)];
      const y2 = poly[2 * ((k + 1) % n) + 1];
      const s1 = side(x1, y1);
      const s2 = side(x2, y2);
      if (s1 >= 0) out.push(x1, y1);
      if ((s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0)) {
        const t = s1 / (s1 - s2);
        out.push(x1 + t * (x2 - x1), y1 + t * (y2 - y1));
      }
    }
    poly = out;
  }
  if (poly.length < 6) return 0;
  let area = 0;
  const n = poly.length / 2;
  for (let k = 0; k < n; k++) {
    const m = (k + 1) % n;
    area += poly[2 * k] * poly[2 * m + 1] - poly[2 * m] * poly[2 * k + 1];
  }
  return Math.abs(area) / 2;
}

const coord = (span: number) => fc.double({ min: -span, max: span, noNaN: true });

export const poseArb = (span = 2): fc.Arbitrary<Pose> =>
  fc.record({ x: coord(span), y: coord(span), theta: fc.double({ min: -7, max: 7, noNaN: true }) });

export const sidesArb = fc.integer({ min: 3, max: 12 });
