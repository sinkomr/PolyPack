import { describe, expect, it } from "vitest";
import type { LeadersAnswer } from "../src/api";
import { newDealer } from "../src/tighter/dealer";
import { FRONTIER, STARTER, keyOf, parseKey } from "../src/tighter/frontier";
import { BATCH, FinderDeps, TakenCache, findOpen, firstDealPools } from "../src/tighter/open-finder";

const player = { name: "x", id: 1, score: 1 };

/** A stubbed /api/leaders: the keys `takenIf` accepts have a leader, the rest are open. */
function stub(takenIf: (key: string) => boolean) {
  const requests: string[][] = [];
  const deps: FinderDeps = {
    now: () => 0,
    getLeaders: async (keys) => {
      requests.push([...keys]);
      const leaders: LeadersAnswer["leaders"] = {};
      for (const k of keys) leaders[k] = takenIf(k) ? player : null;
      return { leaders, unknown: [] };
    },
  };
  return { deps, requests };
}

const find = (deps: FinderDeps, taken = new TakenCache(() => 0)) =>
  findOpen(deps, newDealer(7), firstDealPools(STARTER, FRONTIER), {
    exclude: new Set(),
    taken,
    smallest: true,
  });

describe("open problem finder", () => {
  it("deals from the starter corner while any of it is open, smallest first", async () => {
    const { deps, requests } = stub(() => false);
    const r = await find(deps);
    const starter = new Set(STARTER.map(keyOf));
    expect(requests).toHaveLength(1);
    expect(r.open.every((k) => starter.has(keyOf(k)))).toBe(true);
    const sum = (k: (typeof r.open)[number]) => (k.family === "polygon" ? k.N + k.M + k.P : 0);
    expect(sum(r.open[0]!)).toBe(Math.min(...STARTER.map(sum)));
  });

  it("falls to the frontier when the starter corner is all taken, in one request of at most 200", async () => {
    const starter = new Set(STARTER.map(keyOf));
    const { deps, requests } = stub((k) => starter.has(k));
    const r = await find(deps);
    expect(r.open.length).toBeGreaterThan(0);
    expect(r.open.every((k) => !starter.has(keyOf(k)))).toBe(true);
    expect(r.open.every((k) => FRONTIER.some((f) => keyOf(f) === keyOf(k)))).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.every((q) => q.length <= BATCH)).toBe(true);
    expect(requests[1]).toHaveLength(BATCH);
  });

  it("falls to the wide set when the frontier is all taken, smallest first", async () => {
    const frontier = new Set(FRONTIER.map(keyOf));
    const { deps, requests } = stub((k) => frontier.has(k));
    const r = await find(deps);
    expect(r.open.length).toBeGreaterThan(1);
    for (const k of r.open) {
      expect(frontier.has(keyOf(k))).toBe(false);
      if (k.family === "polygon") {
        expect(Math.min(k.N, k.M)).toBeGreaterThanOrEqual(21);
        expect(k.P).toBeGreaterThanOrEqual(40);
      }
    }
    const sums = r.open.map((k) => (k.family === "polygon" ? k.N + k.M + k.P : 0));
    expect(sums).toEqual([...sums].sort((a, b) => a - b));
    expect(requests.length).toBeLessThanOrEqual(5);
  });

  it("remembers taken keys and does not ask about them again", async () => {
    const starter = new Set(STARTER.map(keyOf));
    const { deps, requests } = stub((k) => starter.has(k));
    const taken = new TakenCache(() => 0);
    await find(deps, taken);
    const asked = new Set(requests[0]);
    requests.length = 0;
    await find(deps, taken);
    for (const q of requests) for (const k of q) expect(asked.has(k)).toBe(false);
    // the starter corner was skipped without a request
    expect(requests).toHaveLength(1);
  });

  it("forgets a taken key after a few minutes", () => {
    let t = 0;
    const c = new TakenCache(() => t);
    c.add("21/21/40");
    expect(c.has("21/21/40")).toBe(true);
    t = 301_000;
    expect(c.has("21/21/40")).toBe(false);
  });

  it("returns nothing, without hanging, when every candidate is taken or the server fails", async () => {
    const { deps, requests } = stub(() => true);
    const r = await find(deps);
    expect(r.open).toEqual([]);
    expect(r.offline).toBe(false);
    expect(requests.length).toBeLessThanOrEqual(6);
    const off = await find({ now: () => 0, getLeaders: async () => null });
    expect(off.offline).toBe(true);
    expect(parseKey("21/21/40")).not.toBeNull();
  });
});
