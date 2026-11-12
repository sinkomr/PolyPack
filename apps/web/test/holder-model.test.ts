import { describe, expect, it } from "vitest";
import type { Holder } from "@polypack/geometry";
import {
  HOLDER_SORT_DEFAULT,
  HOLDER_SORT_KEYS,
  type HolderSort,
  holderHref,
  holderTotals,
  isHolderSortKey,
  nextHolderSort,
  pRanges,
  pairHref,
  placeHolders,
  sortHolders,
  timeOfDay,
} from "../src/holder-model";
import { familyName } from "../src/shapes-ui";

describe("the page of a name: its address", () => {
  it("carries any name in the query, encoded", () => {
    expect(holderHref("ann")).toBe("/holder.html?name=ann");
    expect(holderHref("Ann Lee")).toBe("/holder.html?name=Ann%20Lee");
    for (const name of ["a/b", "a+b", "a&b=c", "100%", "#1 ?x", "Zoë ☃ 数学", "../a"]) {
      const url = new URL(holderHref(name), "https://example.org");
      expect(url.pathname).toBe("/holder.html");
      expect([...url.searchParams.keys()]).toEqual(["name"]);
      expect(url.searchParams.get("name")).toBe(name);
      expect(url.hash).toBe("");
    }
  });

  it("links a pair to its records", () => {
    expect(pairHref(4, 6)).toBe("/browse.html#4,6");
    expect(pairHref(0, 4)).toBe("/browse.html#0,4");
  });

  it("names a pair in words", () => {
    expect(familyName(4, 6)).toBe("squares in a hexagon");
    expect(familyName(0, 4)).toBe("circles in a square");
    expect(familyName(3, 8)).toBe("triangles in an octagon");
    expect(familyName(18, 18)).toBe("18-gons in an 18-gon");
  });
});

describe("the values of P in runs", () => {
  it("writes a run from one value to another and a single value alone", () => {
    expect(pRanges([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 25, 26, 27, 40])).toBe(
      "3–17, 20, 25–27, 40",
    );
    expect(pRanges([])).toBe("");
    expect(pRanges([7])).toBe("7");
    expect(pRanges([1, 2])).toBe("1–2");
    expect(pRanges([1, 3, 5])).toBe("1, 3, 5");
    expect(pRanges([498, 499, 500])).toBe("498–500");
  });

  it("is quick for the longest list there is", () => {
    const every = Array.from({ length: 500 }, (_, i) => i + 1);
    expect(pRanges(every)).toBe("1–500");
    const odd = every.filter((p) => p % 2);
    expect(pRanges(odd).split(", ")).toHaveLength(250);
  });
});

describe("the totals of a name", () => {
  const totals = (site_bests: number, records: number, beat_published = 0, pending = 0) => ({
    site_bests,
    records,
    beat_published,
    pending,
  });
  it("says it as the holders page does", () => {
    expect(holderTotals(totals(1, 1), 1)).toBe("leads 1 problem in 1 pair of shapes; 1 of these is a record.");
    expect(holderTotals(totals(12000, 11000), 1200)).toBe(
      "leads 12,000 problems in 1,200 pairs of shapes; 11,000 of these are records.",
    );
    expect(holderTotals(totals(5, 0), 2)).toBe("leads 5 problems in 2 pairs of shapes; 0 of these are records.");
  });

  it("adds the records that beat the published value, and the claims awaiting review", () => {
    expect(holderTotals(totals(10, 6, 2, 3), 4)).toBe(
      "leads 10 problems in 4 pairs of shapes; 6 of these are records, 2 below the published value; 3 await review.",
    );
    expect(holderTotals(totals(2, 1, 0, 1), 1)).toBe(
      "leads 2 problems in 1 pair of shapes; 1 of these is a record; 1 awaits review.",
    );
  });
});

describe("the time an answer was made", () => {
  it("is the time of day, or nothing for a time that cannot be read", () => {
    expect(timeOfDay("2026-11-01T14:05:09.000Z", "en-GB", "UTC")).toBe("14:05");
    expect(timeOfDay("2026-11-01T14:05:09.000Z", "en-GB", "Asia/Tokyo")).toBe("23:05");
    expect(timeOfDay("yesterday")).toBeNull();
    expect(timeOfDay("")).toBeNull();
  });
});

describe("the holders table: places and sorting", () => {
  const holder = (
    name: string,
    records: number,
    site_bests: number,
    peak = records,
    beat_published = 0,
    pending = 0,
  ): Holder => ({ name, records, beat_published, site_bests, pending, peak });
  // as the server sends them: by records, then by site bests
  const LIST: Holder[] = [
    holder("mia", 9, 12, 9, 4, 3),
    holder("Zed", 5, 5, 20, 0, 0),
    holder("ann", 5, 5, 6, 4, 0),
    holder("team 10", 2, 7, 2, 1, 5),
    holder("team 2", 2, 3, 30, 0, 1),
    holder("Bob", 0, 0, 11, 0, 0),
  ];
  const placed = placeHolders(LIST);
  const names = (sort: HolderSort) => sortHolders(placed, sort).map((h) => h.name);

  it("gives names equal in records and site bests one place, and the next name the place of its row", () => {
    expect(placed.map((h) => h.place)).toEqual([1, 2, 2, 4, 5, 6]);
    expect(placed.map((h) => h.name)).toEqual(LIST.map((h) => h.name));
    expect(placed[3]).toEqual({ ...LIST[3], place: 4 });
    expect(placeHolders([])).toEqual([]);
  });

  it("starts in the order of the server, and by place turns that order round", () => {
    expect(HOLDER_SORT_DEFAULT).toEqual({ key: "place", descending: false });
    expect(names(HOLDER_SORT_DEFAULT)).toEqual(["mia", "Zed", "ann", "team 10", "team 2", "Bob"]);
    expect(names({ key: "place", descending: true })).toEqual(["Bob", "team 2", "team 10", "ann", "Zed", "mia"]);
  });

  it("sorts by a count either way, with equal counts left in the order of the server", () => {
    expect(names({ key: "peak", descending: true })).toEqual(["team 2", "Zed", "Bob", "mia", "ann", "team 10"]);
    expect(names({ key: "peak", descending: false })).toEqual(["team 10", "ann", "mia", "Bob", "Zed", "team 2"]);
    // mia and ann both beat four published values, and three names none: each group stays as the server had it
    expect(names({ key: "beat_published", descending: true })).toEqual([
      "mia",
      "ann",
      "team 10",
      "Zed",
      "team 2",
      "Bob",
    ]);
    expect(names({ key: "beat_published", descending: false })).toEqual([
      "Zed",
      "team 2",
      "Bob",
      "team 10",
      "mia",
      "ann",
    ]);
    expect(names({ key: "site_bests", descending: true })).toEqual(["mia", "team 10", "Zed", "ann", "team 2", "Bob"]);
    expect(names({ key: "pending", descending: true })).toEqual(["team 10", "mia", "team 2", "Zed", "ann", "Bob"]);
    expect(names({ key: "records", descending: true })).toEqual(names(HOLDER_SORT_DEFAULT));
  });

  it("sorts names without regard to capitals, and digits in them as numbers", () => {
    expect(names({ key: "name", descending: false })).toEqual(["ann", "Bob", "mia", "team 2", "team 10", "Zed"]);
    expect(names({ key: "name", descending: true })).toEqual(["Zed", "team 10", "team 2", "mia", "Bob", "ann"]);
  });

  it("keeps each name's place and leaves the list it was given as it is", () => {
    const before = placed.map((h) => h.name);
    const sorted = sortHolders(placed, { key: "name", descending: false });
    expect(sorted.map((h) => h.place)).toEqual([2, 6, 1, 5, 4, 2]);
    expect(sorted).not.toBe(placed);
    expect(sortHolders(placed, HOLDER_SORT_DEFAULT)).not.toBe(placed);
    expect(placed.map((h) => h.name)).toEqual(before);
  });

  it("starts a column of counts with the largest, the name with A and the place with the first; the same column turns round", () => {
    for (const key of ["records", "peak", "beat_published", "site_bests", "pending"] as const) {
      expect(nextHolderSort(HOLDER_SORT_DEFAULT, key)).toEqual({ key, descending: true });
      expect(nextHolderSort({ key, descending: true }, key)).toEqual({ key, descending: false });
      expect(nextHolderSort({ key, descending: false }, key)).toEqual({ key, descending: true });
    }
    expect(nextHolderSort({ key: "peak", descending: true }, "name")).toEqual({ key: "name", descending: false });
    expect(nextHolderSort({ key: "name", descending: false }, "name")).toEqual({ key: "name", descending: true });
    expect(nextHolderSort({ key: "peak", descending: false }, "place")).toEqual(HOLDER_SORT_DEFAULT);
    expect(nextHolderSort(HOLDER_SORT_DEFAULT, "place")).toEqual({ key: "place", descending: true });
  });

  it("knows its columns", () => {
    for (const key of HOLDER_SORT_KEYS) expect(isHolderSortKey(key)).toBe(true);
    for (const key of ["", "Name", "computed_at", undefined, null, 3]) expect(isHolderSortKey(key)).toBe(false);
  });
});
