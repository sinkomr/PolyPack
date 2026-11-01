/**
 * The nD in nD space (4D to 10D, nothing to do with the game's catalogue): Tighter takes its problems from explicit slices
 * and id patterns, not from the spaces' domains, so the new space never reaches the game. This pins that down.
 */
import { describe, expect, it } from "vitest";
import { SPACE_DOMAINS } from "@polypack/spaces";
import { sliceOfId } from "../src/tighter/catalogue";
import { spaceFields } from "../src/tighter/families";
import { SLICES } from "../src/tighter/slices";

describe("Tighter and the nD spaces", () => {
  it("has no slice for them and does not read their ids as problems", () => {
    expect(Object.keys(SPACE_DOMAINS)).toContain("ndim");
    expect(SLICES.some((s) => /ndim/.test(JSON.stringify(s)))).toBe(false);
    for (const id of ["ndim/4/cube/cube/16", "ndim/8/421/ball/5", "ndim/10/ball/ball/20"]) {
      expect(spaceFields(id), id).toBeNull();
      expect(sliceOfId(id), id).toBeNull();
    }
  });
});
