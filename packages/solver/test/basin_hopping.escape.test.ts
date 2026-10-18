// Grid-basin escape moves of basin hopping (peel and cleave), and a seeded regression
// on a count just above a perfect square, where the old defaults stayed on the grid.
import { describe, expect, it } from "vitest";
import { evaluate, findOverlaps, pieceSeparation, type PackingConfig } from "@polypack/geometry";
import { MethodRegistry, seededRandom } from "../src/index";
import { basinHoppingMethod } from "../src/methods/basin_hopping";
import { crossCleave, peelLayer, peelLayerCooperative } from "../src/methods/basin_hopping/escape";
import { penaltyMethod } from "../src/methods/penalty";
import { seedMethod } from "../src/methods/seed";

/** Axis-aligned unit squares (theta = pi/4 with this site's vertex-up convention) at integer cells. */
function cells(list: [number, number][]): PackingConfig {
  return {
    N: 4,
    M: 4,
    P: list.length,
    container_phi: 0,
    pieces: list.map(([x, y]) => ({ x, y, theta: Math.PI / 4 })),
  };
}

function peel(config: PackingConfig, seed: number): PackingConfig {
  const sampler = peelLayer(config, seededRandom(seed));
  let next = sampler.next();
  while (!next.done) next = sampler.next();
  return next.value;
}

describe("basin hopping layer peel", () => {
  // 3x3 grid with holes at (0,0) and (-1,0): 7 squares.
  const grid = cells([
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ]);

  it("moves outer-layer pieces only into empty inner cells, without overlap, purely and seeded", () => {
    const frozen = JSON.stringify(grid);
    let movedAny = false;
    for (let seed = 1; seed <= 40; seed++) {
      const out = peel(grid, seed);
      expect(JSON.stringify(grid)).toBe(frozen);
      expect(JSON.stringify(peel(grid, seed))).toBe(JSON.stringify(out));
      expect(out.pieces).toHaveLength(grid.P);
      expect(findOverlaps(4, out.pieces, 1e-9)).toHaveLength(0);
      out.pieces.forEach((p, i) => {
        const q = grid.pieces[i];
        if (Math.abs(p.x - q.x) < 1e-12 && Math.abs(p.y - q.y) < 1e-12) return;
        movedAny = true;
        // Every move lands in one of the two holes, aligned like its neighbours.
        const hole = [
          [0, 0],
          [-1, 0],
        ].some(([x, y]) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
        expect(hole).toBe(true);
        expect(Math.abs(Math.sin(2 * (p.theta - Math.PI / 4)))).toBeLessThan(1e-9);
      });
      expect(evaluate(out, { autoOrient: true }).valid).toBe(true);
    }
    expect(movedAny).toBe(true);
  });

  it("can empty a whole outer row, shrinking the enclosure along that axis", () => {
    // 2 holes, and a top row of 2: peeling up must move both into the holes.
    const config = cells([
      [-1, -1],
      [0, -1],
      [1, -1],
      [1, 0],
      [-1, 1],
      [0, 1],
    ]);
    const heights = Array.from({ length: 40 }, (_, k) => {
      const out = peel(config, k + 1);
      const ys = out.pieces.map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    });
    expect(Math.min(...heights)).toBeCloseTo(1, 12);
  });

  it("is a no-op for one piece and returns the input on an immediate stop", async () => {
    const one = cells([[0, 0]]);
    expect(peel(one, 1)).toEqual(one);
    const stopped = await peelLayerCooperative(
      grid,
      seededRandom(1),
      async () => false,
      () => true,
    );
    expect(stopped).toEqual(grid);
  });

  it("handles circles: six neighbour sites at distance two", () => {
    const circles: PackingConfig = {
      N: 0,
      M: 0,
      P: 3,
      container_phi: 0,
      pieces: [
        { x: 0, y: 0, theta: 0 },
        { x: 2, y: 0, theta: 0 },
        { x: 6, y: 0, theta: 0 },
      ],
    };
    for (let seed = 1; seed <= 20; seed++) {
      const out = peel(circles, seed);
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < i; j++)
          expect(pieceSeparation(0, out.pieces[i], out.pieces[j]).sep).toBeGreaterThanOrEqual(-1e-9);
    }
  });
});

describe("basin hopping cross cleave", () => {
  it("turns k^2+1 squares (a 2x2 block plus a protruding square) into a packing smaller than the grid", () => {
    const block = cells([
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
      [1.5, 0.5],
    ]);
    const frozen = JSON.stringify(block);
    let best = Infinity;
    for (let seed = 1; seed <= 200; seed++) {
      const out = crossCleave(block, seededRandom(seed));
      expect(JSON.stringify(block)).toBe(frozen);
      expect(JSON.stringify(crossCleave(block, seededRandom(seed)))).toBe(JSON.stringify(out));
      const result = evaluate(out, { autoOrient: true });
      if (result.valid && result.score! < best) best = result.score!;
    }
    // [CALC] Four corner blocks around a centred 45-degree square need a gap of at least
    // 1/sqrt(2); the drawn gap is in [0.75, 1.25] circumradii, so 2 + 0.75/sqrt(2) can
    // overlap and the best valid draws lie just above 2 + 1/sqrt(2), well below 3.
    expect(best).toBeLessThan(2 + 1.25 / Math.SQRT2 + 1e-9);
    expect(best).toBeGreaterThanOrEqual(2 + 1 / Math.SQRT2 - 1e-9);
  });

  it("moves exactly one piece onto a vertex of another and leaves tiny problems unchanged", () => {
    const config = cells([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 0],
      [2, 1],
    ]);
    for (let seed = 1; seed <= 30; seed++) {
      const out = crossCleave(config, seededRandom(seed));
      const turned = out.pieces.filter((p) => Math.abs(Math.sin(2 * (p.theta - Math.PI / 4))) > 0.5);
      expect(turned).toHaveLength(1);
    }
    const two = cells([
      [0, 0],
      [1, 0],
    ]);
    expect(crossCleave(two, seededRandom(1))).toEqual(two);
  });
});

describe("basin hopping above a perfect square", () => {
  it("leaves the 6x6 grid for 26 squares at seeds 2 and 3 and 6,000 evaluations", async () => {
    // [EST] Published 26-square value 5.62132034355964 (data/records.json, Friedman/Ellsworth).
    // [CALC] Before peel/cleave seed 2 at this budget returned the 6x6 grid, 6.0. After: 5.711
    // (seed 2) and 5.710 (seed 3) on Apple Silicon, but 5.812 for seed 2 on CI's x86 runner: a
    // seeded search is not bit-identical across processors, so the test asks for what the moves
    // are for, a clear exit from the grid, on two seeds, rather than one seed's exact value.
    const registry = new MethodRegistry();
    registry.register(seedMethod);
    registry.register(penaltyMethod);
    registry.register(basinHoppingMethod);
    for (const seed of [2, 3]) {
      const result = await registry.run(
        { N: 4, M: 4, P: 26 },
        { method: "basin_hopping", budget: { evals: 6000 }, seed },
      );
      expect(result.strict).toBe(true);
      expect(result.evaluations).toBeLessThanOrEqual(6000);
      const checked = evaluate(result.best!, { autoOrient: true });
      expect(checked.valid).toBe(true);
      expect(Math.abs(checked.score! - result.score!)).toBeLessThan(1e-12);
      expect(result.score!).toBeLessThan(5.9);
      expect(result.score!).toBeGreaterThanOrEqual(5.62132034355964 - 1e-9);
    }
  }, 900_000);
});
