import { describe, expect, it } from "vitest";
import { holderHref, holderTotals, pRanges, pairHref, timeOfDay } from "../src/holder-model";
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
