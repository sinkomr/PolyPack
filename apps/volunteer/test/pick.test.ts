import { MAX_PIECES } from "@polypack/geometry";
import { SPACE_DOMAINS, SPACE_NAMES } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_CATALOGUE_MAX_P,
  DRAW_TRIES,
  RECENT_MS,
  RECENT_TRIES,
  SHAPE_CODES,
  drawOnce,
  drawProblem,
  drawnKey,
  flatKind,
  kindsFor,
  noteSearch,
  pruneRecent,
  recentFromHistory,
  searchedRecently,
  spaceFields,
  spaceKind,
} from "../src/pick";
import { parseSpaceId } from "../src/spaces/model";
import type { HistoryLine } from "../src/state";

function line(N: number, M: number, P: number, time: number, stopped = "time"): HistoryLine {
  return {
    time: new Date(time).toISOString(),
    N,
    M,
    P,
    reason: "random",
    priority: null,
    leader_before: null,
    leader_after: null,
    published: null,
    best: null,
    jobs: 1,
    stopped,
    active_s: 1,
    engine_seed: 1,
    submitted: false,
    decision: "",
    status: null,
    response: null,
    version: "test",
  };
}

const noFilters = { N: null, M: null, maxP: null };
const NOW = Date.parse("2026-10-29T12:00:00Z");

/** A seeded random source (mulberry32), so that the counts below are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random source that returns the given values in turn. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe("the flat problems", () => {
  it("are every shape code (0 and 3 to 100) for N and M, and P from 1 to 500: 4,900,500 problems", () => {
    expect(SHAPE_CODES).toHaveLength(99);
    expect(SHAPE_CODES[0]).toBe(0);
    expect(SHAPE_CODES.slice(1, 3)).toEqual([3, 4]);
    expect(SHAPE_CODES.at(-1)).toBe(100);
    expect(flatKind(noFilters).size).toBe(99 * 99 * MAX_PIECES);
  });

  it("are narrowed by --N, --M and --max-P", () => {
    const k = flatKind({ N: [0, 3], M: [4], maxP: 10 });
    expect(k.size).toBe(2 * 1 * 10);
    const random = seeded(1);
    for (let i = 0; i < 500; i++) {
      const d = k.draw(random);
      expect(d?.kind).toBe("polygon");
      if (d?.kind !== "polygon") continue;
      expect([0, 3]).toContain(d.problem.N);
      expect(d.problem.M).toBe(4);
      expect(d.problem.P).toBeGreaterThanOrEqual(1);
      expect(d.problem.P).toBeLessThanOrEqual(10);
    }
  });

  it("are each drawn about as often as the others", () => {
    const k = flatKind({ N: [3, 4], M: [5], maxP: 3 });
    const counts = new Map<string, number>();
    const random = seeded(7);
    const draws = 60_000;
    for (let i = 0; i < draws; i++) {
      const d = k.draw(random)!;
      counts.set(drawnKey(d), (counts.get(drawnKey(d)) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    // [CALC] each count is binomial(60000, 1/6): mean 10000, standard deviation about 91; 5% is 5.5 of them
    for (const n of counts.values()) expect(Math.abs(n - draws / 6)).toBeLessThan(500);
  });

  it("include the extremes of the ranges", () => {
    const k = flatKind(noFilters);
    expect(k.draw(sequence(0, 0, 0))).toEqual({ kind: "polygon", problem: { N: 0, M: 0, P: 1 } });
    expect(k.draw(sequence(0.999999999, 0.999999999, 0.999999999))).toEqual({
      kind: "polygon",
      problem: { N: 100, M: 100, P: MAX_PIECES },
    });
  });
});

describe("the problems of the other kinds", () => {
  it("are the product of each domain's fields, as many as the domain says it holds", () => {
    for (const space of SPACE_NAMES) {
      const domain = SPACE_DOMAINS[space];
      if (domain) expect(spaceKind(space, null).size, space).toBe(domain.info.problems);
    }
  });

  it("are, for boundary, its catalogue's 32 problems", () => {
    const index = loadSpacesIndex(join(__dirname, "../../.."));
    const catalogue = index.boundary!.problems.map((p) => p.id).sort();
    expect(Math.max(...index.boundary!.problems.map((p) => p.P))).toBe(BOUNDARY_CATALOGUE_MAX_P);
    const k = spaceKind("boundary", null);
    expect(k.size).toBe(catalogue.length);
    const drawn = new Set<string>();
    const random = seeded(3);
    for (let i = 0; i < 2000; i++) {
      const d = k.draw(random);
      if (d) drawn.add(drawnKey(d));
    }
    expect([...drawn].sort()).toEqual(catalogue);
  });

  it("are ids this client searches and its domain holds", () => {
    const random = seeded(11);
    for (const space of SPACE_NAMES) {
      const k = spaceKind(space, null);
      let inside = 0;
      for (let i = 0; i < 300; i++) {
        const d = k.draw(random);
        if (!d) continue;
        inside++;
        expect(d.kind).toBe("space");
        if (d.kind !== "space") continue;
        expect(d.space).toBe(space);
        expect(parseSpaceId(d.id)?.space, d.id).toBe(space);
      }
      // the domains are products of their fields, so no draw falls outside them
      expect(inside, space).toBe(300);
    }
  });

  it("are cut by --max-P, and left out when it leaves none", () => {
    const fields = spaceFields("torus", 20);
    expect(fields.find((f) => f.key === "P")).toMatchObject({ min: 1, max: 20 });
    expect(spaceKind("torus", 20).size).toBe(3 * 99 * 20);
    // balls start at P = 2
    expect(spaceKind("balls", 1).size).toBe(0);
    expect(kindsFor({ ...noFilters, maxP: 1, spaces: ["balls"], onlySpaces: true })).toEqual([]);
  });
});

describe("a draw over several kinds", () => {
  it("covers the flat problems unless --only-dimensions, and the kinds of --dimensions", () => {
    expect(kindsFor({ ...noFilters, spaces: null, onlySpaces: false }).map((k) => k.name)).toEqual(["flat"]);
    expect(kindsFor({ ...noFilters, spaces: ["sphere", "torus"], onlySpaces: false }).map((k) => k.name)).toEqual([
      "flat",
      "sphere",
      "torus",
    ]);
    expect(kindsFor({ ...noFilters, spaces: ["sphere"], onlySpaces: true }).map((k) => k.name)).toEqual(["sphere"]);
  });

  it("takes each kind in proportion to its number of problems", () => {
    // 2 flat problems against sphere's 9,900: about 1 draw in 4,951 is flat
    const kinds = kindsFor({ N: [3], M: [3], maxP: 2, spaces: ["sphere"], onlySpaces: false });
    expect(kinds.map((k) => k.size)).toEqual([2, 99 * 2]);
    const random = seeded(5);
    let flat = 0;
    const draws = 20_000;
    for (let i = 0; i < draws; i++) if (drawOnce(kinds, random)?.kind === "polygon") flat++;
    // [CALC] expected 20000 · 2 / 200 = 200, standard deviation about 14
    expect(Math.abs(flat - 200)).toBeLessThan(60);
  });

  it("gives nothing when no kind has a problem", () => {
    expect(drawOnce([], Math.random)).toBeNull();
  });
});

describe("drawing the next problem", () => {
  const two = [flatKind({ N: [4], M: [4], maxP: 2 })];

  it("never draws a problem to skip", () => {
    const random = seeded(2);
    for (let i = 0; i < 200; i++) {
      const d = drawProblem(two, { recent: new Map(), skip: new Set(["4-4-1"]), now: NOW, random });
      expect(d && drawnKey(d)).toBe("4-4-2");
    }
  });

  it("gives up, with null, when every problem is to skip", () => {
    expect(
      drawProblem(two, { recent: new Map(), skip: new Set(["4-4-1", "4-4-2"]), now: NOW, random: seeded(4) }),
    ).toBeNull();
  });

  it("prefers a problem not searched here in the last week", () => {
    const recent = recentFromHistory([line(4, 4, 1, NOW - 60_000)]);
    const random = seeded(6);
    for (let i = 0; i < 200; i++) {
      const d = drawProblem(two, { recent, skip: new Set(), now: NOW, random });
      expect(d && drawnKey(d)).toBe("4-4-2");
    }
  });

  it(`searches one again when ${RECENT_TRIES} draws in a row fell on problems searched here recently`, () => {
    const recent = recentFromHistory([line(4, 4, 1, NOW - 60_000), line(4, 4, 2, NOW - 60_000)]);
    const d = drawProblem(two, { recent, skip: new Set(), now: NOW, random: seeded(8) });
    expect(d && ["4-4-1", "4-4-2"]).toContain(d && drawnKey(d));
    expect(RECENT_TRIES).toBeLessThan(DRAW_TRIES);
  });
});

describe("recently searched problems", () => {
  it("count for 7 days", () => {
    const recent = recentFromHistory([line(4, 4, 5, NOW - 60_000)]);
    expect(searchedRecently("4-4-5", recent, NOW)).toBe(true);
    expect(searchedRecently("4-4-5", recent, NOW + RECENT_MS)).toBe(false);
    expect(searchedRecently("4-4-6", recent, NOW)).toBe(false);
  });

  it("do not count a search cut short by a signal, and use the latest search", () => {
    const recent = recentFromHistory([line(4, 4, 5, NOW - 60_000, "aborted")]);
    expect(searchedRecently("4-4-5", recent, NOW)).toBe(false);
    noteSearch(recent, line(4, 4, 5, NOW - 120_000));
    noteSearch(recent, line(4, 4, 5, NOW - RECENT_MS - 1)); // older: ignored
    expect(searchedRecently("4-4-5", recent, NOW)).toBe(true);
    expect(recent.get("4-4-5")?.time).toBe(NOW - 120_000);
  });

  // Fix 6: a dry run must not keep a real run away from a problem for a week.
  it("from a dry run count for later dry runs only", () => {
    const dry = { ...line(4, 4, 5, NOW - 60_000), dry_run: true };
    expect(searchedRecently("4-4-5", recentFromHistory([dry], false), NOW)).toBe(false);
    expect(searchedRecently("4-4-5", recentFromHistory([dry], true), NOW)).toBe(true);
    // lines written before dry_run was recorded
    const legacy = { ...line(4, 4, 5, NOW - 60_000), decision: "dry run: would submit" };
    expect(searchedRecently("4-4-5", recentFromHistory([legacy], false), NOW)).toBe(false);
    const recent = new Map();
    noteSearch(recent, dry);
    expect(recent.size).toBe(0);
  });

  it("are forgotten once they no longer count", () => {
    const recent = recentFromHistory([line(4, 4, 5, NOW - RECENT_MS - 1), line(4, 4, 6, NOW - 60_000)]);
    expect(recent.size).toBe(2);
    pruneRecent(recent, NOW);
    expect([...recent.keys()]).toEqual(["4-4-6"]);
  });
});
