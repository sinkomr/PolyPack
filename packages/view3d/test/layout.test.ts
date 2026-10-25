import { describe, expect, it } from "vitest";
import { gridLayout } from "../src/layout";

describe("atlas layout", () => {
  it("puts 8 cells in 2 rows of 4 on a wide box and 4 rows of 2 on a phone", () => {
    const wide = gridLayout(8, 1200, 620, { gap: 8, label: 20 });
    expect([wide.rows, wide.cols]).toEqual([2, 4]);
    const phone = gridLayout(8, 360, 760, { gap: 8, label: 20 });
    expect([phone.rows, phone.cols]).toEqual([4, 2]);
  });

  it("keeps every tile inside the box, square and disjoint", () => {
    for (const [n, W, H] of [[8, 1200, 620], [9, 900, 500], [9, 360, 640], [1, 300, 300], [8, 200, 1200]] as const) {
      const g = gridLayout(n, W, H, { gap: 6, label: 18 });
      expect(g.tiles).toHaveLength(n);
      for (const t of g.tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.x + t.w).toBeLessThanOrEqual(W + 1);
        expect(t.y + t.h).toBeLessThanOrEqual(H + 1);
        expect(t.view.size).toBe(g.size);
        expect(t.view.y).toBe(t.y + 18);
      }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = g.tiles[i];
          const b = g.tiles[j];
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
      }
    }
  });

  it("chooses the largest tiles", () => {
    // 9 slices in a strip-shaped box: one row beats 3 x 3
    const g = gridLayout(9, 1800, 220, { gap: 4 });
    expect(g.rows).toBe(1);
    expect(g.size).toBe(Math.floor((1800 - 32) / 9));
  });
});
