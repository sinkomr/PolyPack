import { describe, expect, it } from "vitest";
import { DARK_PALETTE, DEFAULT_ROTATION, renderSVG, sceneOf } from "../src/draw";
import { getProblem } from "../src";

describe("draw", () => {
  const p = getProblem("cubincub")!;
  const config = {
    s: 2,
    pieces: [
      [-0.5, -0.5, -0.5, 1, 0, 0, 0],
      [0.5, 0.5, 0.5, 0.9238795, 0.3826834, 0, 0],
    ] as [number, number, number, number, number, number, number][],
  };

  it("draws the container's 12 edges and only front faces of the pieces, inside the drawing", () => {
    const scene = sceneOf(p, config, { size: 300 });
    const edges = scene.filter((q) => q.piece === -1 && !q.fill);
    expect(edges.length).toBe(12);
    expect(edges.some((e) => e.dash)).toBe(true);
    const faces = scene.filter((q) => q.piece >= 0);
    // a cube shows at most 3 faces
    expect(faces.filter((q) => q.piece === 0).length).toBeLessThanOrEqual(3);
    expect(faces.filter((q) => q.piece === 1).length).toBeGreaterThan(0);
    for (const q of scene) for (const [x, y] of q.pts) expect(x >= 0 && x <= 300 && y >= 0 && y <= 300).toBe(true);
  });

  it("orders pieces back to front and renders SVG without NaN", () => {
    const scene = sceneOf(p, config, { rotation: DEFAULT_ROTATION });
    const depths = scene.filter((q) => q.piece >= 0).map((q) => q.depth);
    for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
    const svg = renderSVG(p, config, { palette: DARK_PALETTE });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/NaN/);
    expect(renderSVG(getProblem("tidintid")!, null)).toMatch(/<path/);
  });
});
