/**
 * The Johnson solids in Tighter: the polyhedra and balls catalogues hold 92 of them (186 solids, 373 balls
 * codes), and the game deals them only when their cards are owned. Johnson surfaces are dealt folded only:
 * their faces are regular, so without folding each would be a 2D in 2D packing of its faces.
 */
import { describe, expect, it } from "vitest";
import { BALLS_CODES } from "@polypack/balls/catalogue";
import { SOLID_NAMES_LIST } from "@polypack/polyhedra/catalogue";
import { SURFACE_JOHNSON as PKG_JOHNSON } from "@polypack/spaces";
import {
  SURFACE_JOHNSON,
  dealableIn,
  drawSliceProblem,
  parseDealtKey,
  requiredSlices,
  sliceOfId,
} from "../src/tighter/catalogue";
import { newDealer } from "../src/tighter/dealer";
import { GAME_BALLS_COUNT, GAME_PAIR_COUNT, SLICES, SOLID_FAMILY_SLICE, SliceId, solidsOfSlice } from "../src/tighter/slices";

const johnson = SOLID_NAMES_LIST.filter((s) => s.family === "johnson");
const all = SLICES.map((s) => s.id);
const without = (...ids: SliceId[]) => all.filter((s) => !ids.includes(s));
const JOHNSON_CODE = /(^|\/|in)j\d\d(in|\/)/;

describe("Tighter and the Johnson solids", () => {
  it("has a slice for each family and counts all 186 solids", () => {
    expect(johnson).toHaveLength(92);
    expect(SOLID_FAMILY_SLICE.johnson).toBe("poly-johnson");
    expect(solidsOfSlice("poly-johnson")).toBe(92);
    expect(GAME_PAIR_COUNT).toBe(186 * 186);
    expect(GAME_BALLS_COUNT).toBe(1 + 2 * 186);
    expect(BALLS_CODES).toHaveLength(373);
    expect([...SURFACE_JOHNSON]).toEqual([...PKG_JOHNSON]);
  });

  it("puts a problem with a Johnson solid in the slice that opens it last, and deals it only when that is owned", () => {
    expect(requiredSlices("polyhedra/j05inj92/7")).toEqual(["poly-johnson"]);
    expect(requiredSlices("polyhedra/j01incub/7")).toEqual(["poly-johnson", "poly-platonic"]);
    expect(requiredSlices("balls/ballinj12/7")).toEqual(["balls", "poly-johnson"]);
    expect(requiredSlices("balls/j92inball/7")).toEqual(["balls", "poly-johnson"]);
    expect(sliceOfId("polyhedra/j05inj92/7")).toBe("poly-johnson");
    expect(sliceOfId("polyhedra/j01incub/7")).toBe("poly-johnson");
    // balls is dearer than Johnson, so a balls problem is in the Balls slice
    expect(sliceOfId("balls/ballinj12/7")).toBe("balls");
    for (const id of ["polyhedra/j05inj92/7", "polyhedra/cubinj44/7", "balls/ballinj12/7", "balls/j92inball/7"]) {
      expect(dealableIn(id, all), id).toBe(true);
      expect(dealableIn(id, without("poly-johnson")), id).toBe(false);
    }
    expect(dealableIn("balls/ballinj12/7", without("balls"))).toBe(false);
    // the other problems are as before
    expect(requiredSlices("balls/ballinball/7")).toEqual(["balls"]);
    expect(requiredSlices("polyhedra/cubintet/7")).toEqual(["poly-platonic"]);
  });

  it("never deals a Johnson problem while its card is not owned, over many draws", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const d = newDealer(seed);
      const open = without("poly-johnson", "surf-johnson");
      for (const slice of open) {
        for (let i = 0; i < 80; i++) {
          const key = drawSliceProblem(d, slice, { listings: {}, exclude: new Set(), open, attempts: 24 });
          if (key) expect(key.id, `${slice} ${key.id}`).not.toMatch(JOHNSON_CODE);
        }
      }
    }
  });

  it("deals Johnson solids from the Johnson slice, as piece or container, and balls problems with them", () => {
    const d = newDealer(3);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const key = drawSliceProblem(d, "poly-johnson", { listings: {}, exclude: new Set(), open: all });
      expect(key).not.toBeNull();
      expect(key!.id).toMatch(JOHNSON_CODE);
      // the pair is in its dearer slice: Johnson, or the later Bipyramids and trapezohedra
      expect(requiredSlices(key!.id)).toContain("poly-johnson");
      expect(["poly-johnson", "poly-duals"]).toContain(sliceOfId(key!.id));
      seen.add(key!.id.split("/")[1].startsWith("j") ? "piece" : "container");
    }
    expect([...seen].sort()).toEqual(["container", "piece"]);
    let balls = 0;
    for (let i = 0; i < 400; i++) {
      const key = drawSliceProblem(d, "balls", { listings: {}, exclude: new Set(), open: all });
      if (key && JOHNSON_CODE.test(key.id)) balls++;
    }
    expect(balls).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) {
      const key = drawSliceProblem(d, "balls", { listings: {}, exclude: new Set(), open: without("poly-johnson") });
      if (key) expect(key.id).not.toMatch(JOHNSON_CODE);
    }
  });

  it("holds the Johnson surfaces, folded only", () => {
    expect(SURFACE_JOHNSON).toHaveLength(92);
    for (const solid of SURFACE_JOHNSON) {
      expect(sliceOfId(`surface/${solid}/fold/4/12`), solid).toBe("surf-johnson");
      expect(sliceOfId(`surface/${solid}/nofold/4/12`), solid).toBeNull();
      expect(parseDealtKey(`surface/${solid}/fold/4/12`), solid).not.toBeNull();
      expect(parseDealtKey(`surface/${solid}/nofold/4/12`)).toBeNull();
    }
    const d = newDealer(5);
    for (const slice of SLICES.filter((s) => s.family === "surface")) {
      for (let i = 0; i < 300; i++) {
        const key = drawSliceProblem(d, slice.id, { listings: {}, exclude: new Set(), open: all });
        if (!key) continue;
        expect(sliceOfId(key.id), key.id).toBe(slice.id);
        if (slice.id === "surf-johnson") {
          expect(key.id).toMatch(/^surface\/[a-z_0-9]+\/fold\//);
          expect(SURFACE_JOHNSON).toContain(key.id.split("/")[1]);
        }
        if (slice.id !== "surf-johnson") expect(SURFACE_JOHNSON).not.toContain(key.id.split("/")[1]);
      }
    }
  });

  it("deals only parseable problems of open slices (seeded property)", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const d = newDealer(seed);
      const open = seed % 2 ? all : without("poly-johnson", "balls", "sphere");
      for (const slice of open) {
        for (let i = 0; i < 40; i++) {
          const key = drawSliceProblem(d, slice, { listings: {}, exclude: new Set(), open });
          if (!key) continue;
          const slot = sliceOfId(key.id);
          expect(slot, key.id).not.toBeNull();
          expect(open, key.id).toContain(slot);
          if (key.family === "polyhedra" || key.family === "balls") expect(dealableIn(key.id, open), key.id).toBe(true);
        }
      }
    }
  });
});
