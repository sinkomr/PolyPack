/**
 * The Johnson solids are in the polyhedra and balls catalogues (186 solids, 373 balls codes) but not yet in Tighter:
 * its family "johnson" has no slice, so no Johnson problem is dealt, sliced or counted in a card's text until the game adds them.
 */
import { describe, expect, it } from "vitest";
import { BALLS_CODES } from "@polypack/balls/catalogue";
import { SOLID_NAMES_LIST } from "@polypack/polyhedra/catalogue";
import { dealableIn, drawSliceProblem, requiredSlices, sliceOfId } from "../src/tighter/catalogue";
import { newDealer } from "../src/tighter/dealer";
import { GAME_BALLS_COUNT, GAME_PAIR_COUNT, SLICES, SOLID_FAMILY_SLICE } from "../src/tighter/slices";

const johnson = SOLID_NAMES_LIST.filter((s) => s.family === "johnson");
const all = SLICES.map((s) => s.id);

describe("Tighter and the Johnson solids", () => {
  it("has no slice for the family, and counts only the 94 solids it deals", () => {
    expect(johnson).toHaveLength(92);
    expect(SOLID_FAMILY_SLICE.johnson).toBeUndefined();
    expect(GAME_PAIR_COUNT).toBe(8836);
    expect(GAME_BALLS_COUNT).toBe(189);
    expect(BALLS_CODES).toHaveLength(373);
  });

  it("requires no slice set for a problem with a Johnson solid, so none is dealable or in a slice", () => {
    const ids = [
      "polyhedra/j05inj92/7",
      "polyhedra/j01incub/7",
      "polyhedra/cubinj44/7",
      "polyhedra/j12inj12/500",
      "balls/ballinj12/7",
      "balls/j92inball/7",
    ];
    for (const id of ids) {
      expect(requiredSlices(id), id).toBeNull();
      expect(dealableIn(id, all), id).toBe(false);
      expect(sliceOfId(id), id).toBeNull();
    }
    // the problems of the first 94 solids are dealt as before, balls in a ball with only the Balls slice
    expect(requiredSlices("balls/ballinball/7")).toEqual(["balls"]);
    expect(requiredSlices("balls/ballincub/7")).toEqual(["balls", "poly-platonic"]);
    expect(requiredSlices("polyhedra/cubintet/7")).toEqual(["poly-platonic"]);
  });

  it("never deals one from any slice, with every family open, over many draws", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const d = newDealer(seed);
      for (const slice of all) {
        for (let i = 0; i < 80; i++) {
          const key = drawSliceProblem(d, slice, { listings: {}, exclude: new Set(), open: all, attempts: 24 });
          if (key) expect(key.id, `${slice} ${key.id}`).not.toMatch(/\bj\d\d|\/j\d\d|inj\d\d|j\d\din/);
        }
      }
    }
  });
});
