import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LiteratureRecord } from "@polypack/geometry";
import { SOURCES, recordCredits, recordSources, sourceLabel } from "../src/sources";

const base = {
  source_name: "Erich Friedman, Packing Center: Circles in Circles",
  conversion_note: "None needed: the source uses container radius r for unit pieces (radius 1), as this site does.",
  citation: "r = 3 Trivial.",
  has_coordinates: false,
};
const PACKOMANIA = "Eckard Specht, Packomania: The best known packings of equal circles in a circle";

describe("the sources of a published record", () => {
  it("numbers the sources in a fixed order", () => {
    expect(SOURCES.map((s) => [s.n, sourceLabel(s)])).toEqual([
      [1, "Erich Friedman, Packing Center"],
      [2, "David Ellsworth, Squares in Squares"],
      [3, "Eckard Specht, Packomania"],
      [4, "Berthold, Kamp, Mexi, Pokutta and Polik, Packing Solutions"],
    ]);
    for (const s of SOURCES) expect(s.url).toMatch(/^https?:\/\//);
  });

  it("credits the value to the record's own source", () => {
    expect(recordSources(base)).toEqual({ value: [1], coordinates: [] });
    expect(recordCredits(base)).toEqual([{ n: 1, what: "value and caption" }]);
    expect(recordCredits({ ...base, citation: undefined })).toEqual([{ n: 1, what: "value" }]);
  });

  it("credits both sources when the coordinates and further digits come from another one", () => {
    const lit = {
      ...base,
      has_coordinates: true,
      conversion_note: `${base.conversion_note} More digits (3.813025631308) from ${PACKOMANIA}, http://www.packomania.com/cci/: The source fixes the container.`,
      coordinates_note: `Coordinates from ${PACKOMANIA}, http://www.packomania.com/cci/ (read 2026-10-07).`,
    };
    expect(recordSources(lit)).toEqual({ value: [1, 3], coordinates: [3] });
    expect(recordCredits(lit)).toEqual([
      { n: 1, what: "value and caption" },
      { n: 3, what: "further digits of the value, coordinates" },
    ]);
  });

  it("credits coordinates to the value's source when no other is named", () => {
    const lit = { ...base, source_name: PACKOMANIA, has_coordinates: true };
    expect(recordSources(lit)).toEqual({ value: [3], coordinates: [3] });
    const later = "Coordinates from the source's coordinate archive cci_coords.tar (local copy, read 2026-10-11).";
    expect(recordSources({ ...lit, coordinates_note: later }).coordinates).toEqual([3]);
    expect(recordCredits(lit)).toEqual([{ n: 3, what: "value and caption, coordinates" }]);
  });

  it("does not credit a source with coordinates that this site constructed or that are not listed", () => {
    const ellsworth = {
      ...base,
      source_name: "David Ellsworth, Squares in Squares (continuing Erich Friedman's page)",
      has_coordinates: true,
      coordinates_note: "Coordinates constructed by PolyPack, not taken from the source.",
    };
    // the name of the page mentions Erich Friedman; the record is David Ellsworth's all the same
    expect(recordSources(ellsworth)).toEqual({ value: [2], coordinates: [] });
    // coordinates found by the solver at the published value (scripts/construct-coordinates.ts)
    const solved = {
      ...base,
      has_coordinates: true,
      coordinates_note:
        "Coordinates constructed by PolyPack (harden, seed 1): a packing that reaches the published value, not necessarily the source's arrangement.",
    };
    expect(recordSources(solved)).toEqual({ value: [1], coordinates: [] });
    expect(recordCredits(solved)).toEqual([{ n: 1, what: "value and caption" }]);
    // a note about coordinates means nothing while the listing has none to draw
    const note = `Coordinates from ${PACKOMANIA}, http://www.packomania.com/cci/ (read 2026-10-07).`;
    expect(recordSources({ ...base, coordinates_note: note }).coordinates).toEqual([]);
  });

  it("credits a heptagon record's value and coordinates to Berthold et al.", () => {
    const { records } = JSON.parse(readFileSync("data/records.json", "utf8")) as { records: LiteratureRecord[] };
    const r = records.find((r) => r.N === 7 && r.M === 3 && r.P === 5)!;
    expect(recordSources({ ...r, has_coordinates: !!r.pieces })).toEqual({ value: [4], coordinates: [4] });
    expect(recordCredits({ ...r, has_coordinates: true })).toEqual([{ n: 4, what: "value and caption, coordinates" }]);
  });

  it("gives no number to a record derived here or taken from an unknown source", () => {
    const derived = { ...base, source_name: "PolyPack (derived here, not from the literature)", has_coordinates: true };
    expect(recordSources(derived)).toEqual({ value: [], coordinates: [] });
    expect(recordCredits({ ...base, source_name: "A fixture of the tests" })).toEqual([]);
  });

  it("finds a source for every record of the data that is not derived here", () => {
    const { records } = JSON.parse(readFileSync("data/records.json", "utf8")) as { records: LiteratureRecord[] };
    const counts = [0, 0, 0, 0, 0];
    for (const r of records) {
      const { value, coordinates } = recordSources({ ...r, has_coordinates: !!r.pieces });
      if (r.source_name.startsWith("PolyPack")) expect(value).toEqual([]);
      else expect(value.length).toBeGreaterThan(0);
      // coordinates in the data are Packomania's, read from Ellsworth's drawings (squares in a
      // square only), Berthold et al.'s with their values, or constructed here
      const from = r.source_name.startsWith("Berthold") ? 4 : r.N === 4 && r.M === 4 ? 2 : 3;
      expect(coordinates.every((n) => n === from)).toBe(true);
      if (
        r.pieces &&
        !/constructed by PolyPack/.test(r.coordinates_note ?? "") &&
        !r.source_name.startsWith("PolyPack")
      )
        expect(coordinates).toEqual([from]);
      counts[value[0] ?? 0]++;
    }
    expect(counts.every((c) => c > 0)).toBe(true);
  });
});
