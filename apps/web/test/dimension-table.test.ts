import { SPACE_NAMES } from "@polypack/spaces";
import { describe, expect, it } from "vitest";
import {
  DIMENSIONS,
  availableFamilies,
  familyOfSpace,
  familyTitle,
  isAvailable,
  whereIs,
} from "../src/dimension-table";
import { BOARD_SPACES } from "../src/space-address";
import { SPACE_FIELDS } from "../src/spaces-model";

describe("the table of dimensions", () => {
  it("names each dimension by the pieces' dimension, in or on, and the container's", () => {
    expect(DIMENSIONS.map((d) => d.label)).toEqual(["2D in 2D", "2D on 3D", "3D in 3D", "3D on 4D"]);
    for (const d of DIMENSIONS) {
      const m = /^(\d)D (in|on) (\d)D$/.exec(d.label)!;
      expect(m, d.label).not.toBeNull();
      // "in" a container of the same dimension; "on" a boundary of one dimension more
      expect(Number(m[3]) - Number(m[1]), d.label).toBe(m[2] === "in" ? 0 : 1);
      expect(d.id).toBe(`${m[1]}-${m[2]}-${m[3]}`);
      expect(d.families.length, d.label).toBeGreaterThan(0);
    }
  });

  it("files every kind the board can show exactly once, Flat first", () => {
    const shown = DIMENSIONS.flatMap((d) => availableFamilies(d).map((f) => f.space));
    expect(shown[0]).toBe("polygon");
    expect([...shown].sort()).toEqual(["polygon", ...BOARD_SPACES].sort());
    expect(whereIs("polygon")).toMatchObject({ dimension: { label: "2D in 2D" }, family: { name: "Flat" } });
    expect(whereIs("curved")?.dimension.label).toBe("2D in 2D");
    for (const s of ["surface", "sphere", "torus"]) expect(whereIs(s)?.dimension.label, s).toBe("2D on 3D");
    expect(familyTitle("sphere")).toBe("2D on 3D, Sphere");
  });

  it("files every space of the API, so that the dimensions page can group its records", () => {
    for (const s of SPACE_NAMES) {
      expect(familyOfSpace(s), s).not.toBeNull();
      expect(Object.hasOwn(SPACE_FIELDS, s), s).toBe(true);
    }
  });

  it("lists the dimensions to come, with no kind the board can show", () => {
    const soon = DIMENSIONS.filter((d) => !isAvailable(d));
    expect(soon.map((d) => d.label)).toEqual(["3D in 3D", "3D on 4D"]);
    for (const d of soon) {
      expect(availableFamilies(d)).toEqual([]);
      for (const f of d.families) expect(whereIs(f.space), f.space).toBeNull();
    }
    // the names the API will use for them
    expect(familyOfSpace("polyhedra")?.dimension.label).toBe("3D in 3D");
    expect(familyOfSpace("boundary")?.dimension.label).toBe("3D on 4D");
  });

  it("uses distinct names, and an id and a short name for each family", () => {
    const families = DIMENSIONS.flatMap((d) => d.families);
    expect(new Set(families.map((f) => f.space)).size).toBe(families.length);
    expect(new Set(families.map((f) => f.name)).size).toBe(families.length);
    expect(new Set(DIMENSIONS.map((d) => d.id)).size).toBe(DIMENSIONS.length);
    for (const f of families) {
      expect(f.short.length, f.space).toBeGreaterThan(0);
      expect(f.summary, f.space).toMatch(/\.$/);
    }
  });
});
