import type { Target } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import {
  RECENT_MS,
  TOP,
  eligibleTargets,
  noteSearch,
  pickTarget,
  recentFromHistory,
  searchedRecently,
  weightedDraw,
} from "../src/pick";
import type { HistoryLine } from "../src/state";

function target(N: number, M: number, P: number, priority: number, leader_id: number | null = null): Target {
  return {
    N,
    M,
    P,
    reason: leader_id === null ? "unsolved" : "slack",
    priority,
    leader: leader_id === null ? null : 3,
    leader_id,
    published: null,
    published_coordinates: false,
    area_bound: 1,
  };
}

function line(
  N: number,
  M: number,
  P: number,
  time: number,
  before: number | null,
  after: number | null | undefined,
  stopped = "time",
): HistoryLine {
  return {
    time: new Date(time).toISOString(),
    N,
    M,
    P,
    reason: "slack",
    priority: 1,
    leader_before: before === null ? null : { id: before, score: 3 },
    leader_after: after === undefined ? null : { id: after, score: 3 },
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
const NOW = Date.parse("2026-10-21T12:00:00Z");

/** A random source that returns the given values in turn. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe("weighted draw", () => {
  const list = [target(4, 4, 1, 1), target(4, 4, 2, 3), target(4, 4, 3, 6)];

  it("picks in proportion to priority", () => {
    // cumulative weights 1, 4, 10 out of 10
    expect(weightedDraw(list, () => 0)).toBe(list[0]);
    expect(weightedDraw(list, () => 0.0999)).toBe(list[0]);
    expect(weightedDraw(list, () => 0.1)).toBe(list[1]);
    expect(weightedDraw(list, () => 0.3999)).toBe(list[1]);
    expect(weightedDraw(list, () => 0.4)).toBe(list[2]);
    expect(weightedDraw(list, () => 0.999999)).toBe(list[2]);
  });

  it("matches the weights over many draws", () => {
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const counts = new Map(list.map((t) => [t, 0]));
    for (let i = 0; i < 20000; i++) {
      const t = weightedDraw(list, random)!;
      counts.set(t, counts.get(t)! + 1);
    }
    expect(counts.get(list[0])! / 20000).toBeCloseTo(0.1, 1);
    expect(counts.get(list[1])! / 20000).toBeCloseTo(0.3, 1);
    expect(counts.get(list[2])! / 20000).toBeCloseTo(0.6, 1);
  });

  it("gives nothing to priorities that are not positive, and is uniform when none is", () => {
    const mixed = [target(4, 4, 1, 0), target(4, 4, 2, -5), target(4, 4, 3, NaN), target(4, 4, 4, 2)];
    for (const r of [0, 0.5, 0.99]) expect(weightedDraw(mixed, () => r)).toBe(mixed[3]);
    const flat = [target(4, 4, 1, 0), target(4, 4, 2, 0)];
    expect(weightedDraw(flat, () => 0.2)).toBe(flat[0]);
    expect(weightedDraw(flat, () => 0.7)).toBe(flat[1]);
    expect(weightedDraw([], () => 0.5)).toBeNull();
  });
});

describe("eligible targets", () => {
  it("keeps the 50 highest priorities, whatever the list's order", () => {
    const list = Array.from({ length: 120 }, (_, i) => target(4, 4, i + 1, i + 1));
    const top = eligibleTargets(list, { filters: noFilters, recent: new Map(), skip: new Set(), now: NOW });
    expect(top).toHaveLength(TOP);
    expect(top[0].P).toBe(120);
    expect(Math.min(...top.map((t) => t.P))).toBe(71);
  });

  it("applies --N, --M and --max-P before taking the top 50", () => {
    const list = [target(0, 0, 5, 9), target(3, 4, 5, 8), target(4, 4, 60, 7), target(4, 4, 6, 1)];
    const top = eligibleTargets(list, {
      filters: { N: [0, 4], M: [0, 4], maxP: 50 },
      recent: new Map(),
      skip: new Set(),
      now: NOW,
    });
    expect(top.map((t) => `${t.N}-${t.M}-${t.P}`)).toEqual(["0-0-5", "4-4-6"]);
  });

  it("leaves out skipped problems, so that they do not take a place in the top 50", () => {
    const list = Array.from({ length: 60 }, (_, i) => target(4, 4, i + 1, 100 - i));
    const top = eligibleTargets(list, { filters: noFilters, recent: new Map(), skip: new Set(["4-4-1"]), now: NOW });
    expect(top).toHaveLength(TOP);
    expect(top.some((t) => t.P === 1)).toBe(false);
    expect(top.some((t) => t.P === 51)).toBe(true);
  });
});

describe("recently searched problems", () => {
  it("are skipped for 7 days while the leader is the one seen", () => {
    const recent = recentFromHistory([line(4, 4, 5, NOW - 3600_000, 17, undefined)]);
    expect(searchedRecently(target(4, 4, 5, 1, 17), recent, NOW)).toBe(true);
    expect(searchedRecently(target(4, 4, 6, 1, 17), recent, NOW)).toBe(false);
    // a week later it is due again
    expect(searchedRecently(target(4, 4, 5, 1, 17), recent, NOW - 3600_000 + RECENT_MS)).toBe(false);
  });

  it("come back as soon as the leader changes", () => {
    const recent = recentFromHistory([line(4, 4, 5, NOW - 3600_000, 17, 17)]);
    expect(searchedRecently(target(4, 4, 5, 1, 18), recent, NOW)).toBe(false);
    const list = [target(4, 4, 5, 10, 18), target(4, 4, 6, 1, null)];
    expect(pickTarget(list, { filters: noFilters, recent, skip: new Set(), now: NOW, random: () => 0 })).toBe(list[0]);
  });

  it("stay skipped when the leader is our own new entry, or the list still shows the one before it", () => {
    // we took the lead: entry 40 replaced 17, and the work list may lag behind
    const recent = recentFromHistory([line(4, 4, 5, NOW - 60_000, 17, 40)]);
    expect(searchedRecently(target(4, 4, 5, 1, 40), recent, NOW)).toBe(true);
    expect(searchedRecently(target(4, 4, 5, 1, 17), recent, NOW)).toBe(true);
    expect(searchedRecently(target(4, 4, 5, 1, 41), recent, NOW)).toBe(false);
  });

  it("track problems without a leader until one appears", () => {
    const recent = recentFromHistory([line(0, 4, 9, NOW - 60_000, null, null)]);
    expect(searchedRecently(target(0, 4, 9, 1, null), recent, NOW)).toBe(true);
    expect(searchedRecently(target(0, 4, 9, 1, 5), recent, NOW)).toBe(false);
  });

  it("do not count a search cut short by a signal, and use the latest search", () => {
    const recent = recentFromHistory([line(4, 4, 5, NOW - 60_000, 17, 17, "aborted")]);
    expect(searchedRecently(target(4, 4, 5, 1, 17), recent, NOW)).toBe(false);
    noteSearch(recent, line(4, 4, 5, NOW - 120_000, 17, 17));
    noteSearch(recent, line(4, 4, 5, NOW - RECENT_MS - 1, 9, 9)); // older: ignored
    expect(searchedRecently(target(4, 4, 5, 1, 17), recent, NOW)).toBe(true);
  });

  it("make pickTarget return null when everything was searched", () => {
    const list = [target(4, 4, 5, 1, 17)];
    const recent = recentFromHistory([line(4, 4, 5, NOW - 60_000, 17, 17)]);
    expect(
      pickTarget(list, { filters: noFilters, recent, skip: new Set(), now: NOW, random: sequence(0.5) }),
    ).toBeNull();
  });
});
