import { describe, expect, it } from "vitest";
import type { HolderResponse } from "@polypack/geometry";
import type { LeadersAnswer } from "../src/api";
import { Archive, MemoryStore, archiveOf, attachArchive, ensureArchive } from "../src/tighter/archive";
import type { ArchiveRow } from "../src/tighter/archive";
import { RENT_WINDOW_MS, rentPerHour, rentRate, rentWaiting, tidyRent } from "../src/tighter/economy";
import {
  PAST_LIMIT,
  addToQueue,
  applyAnswer,
  applyLeader,
  leave,
  newGame,
  newProblem,
  ownedSet,
  recordsHeld,
  seenKeys,
} from "../src/tighter/game";
import type { GameState, PastProblem } from "../src/tighter/game";
import { runPayday } from "../src/tighter/payday";
import type { PaydayDeps } from "../src/tighter/payday";
import { recoverRecords } from "../src/tighter/recovery";
import { archiveRows, exportString, fromJson, importString, toExportJson, toJson } from "../src/tighter/save";
import { heldCount } from "../src/tighter/standing";

const T0 = 1_000_000_000;
const H = 3_600_000;
const D = 24 * H;

const pastEntry = (P: number, ourId: number | null, leftAt = T0): PastProblem => ({
  family: "polygon",
  N: 21,
  M: 21,
  P,
  key: `21/21/${P}`,
  tier: "open",
  best: 5,
  verified: 5,
  ourId,
  rp: 100,
  leftAt,
});

const rowOf = (P: number, extra: Partial<ArchiveRow> = {}): ArchiveRow => ({ ...pastEntry(P, 1000 + P), ...extra });

function game(rent = true): GameState {
  const s = newGame(T0, 1);
  if (rent) s.owned.push("rent");
  return s;
}

describe("Archive", () => {
  it("puts, loads and deletes rows through the store, writing only what changed", async () => {
    const store = new MemoryStore();
    const a = new Archive(store);
    a.loaded = true;
    a.put(rowOf(40, { base: 7 }));
    a.put(rowOf(41));
    await a.flush();
    expect([...store.rows.keys()].sort()).toEqual(["21/21/40", "21/21/41"]);
    expect(store.writes).toEqual([{ puts: 2, deletes: 0 }]);
    // nothing changed: no write
    await a.flush();
    expect(store.writes).toHaveLength(1);
    // one row changed in place, one removed: two rows touched, not all
    a.get("21/21/40")!.check = T0;
    a.touch("21/21/40");
    a.remove("21/21/41");
    await a.flush();
    expect(store.writes[1]).toEqual({ puts: 1, deletes: 1 });
    expect(store.rows.get("21/21/40")!.check).toBe(T0);
    expect(store.rows.has("21/21/41")).toBe(false);

    const b = new Archive(store);
    expect(b.loaded).toBe(false);
    expect(await b.load(() => false)).toBe(1);
    expect(b.size).toBe(1);
    expect(b.get("21/21/40")).toMatchObject({ base: 7, check: T0, ourId: 1040 });
  });

  it("drops a row whose problem is in the queue or past, from memory and from the store", async () => {
    const store = new MemoryStore();
    await store.apply([rowOf(40), rowOf(41)], []);
    const a = new Archive(store);
    expect(await a.load((k) => k === "21/21/40")).toBe(1);
    expect(a.has("21/21/40")).toBe(false);
    await a.flush();
    expect(store.rows.has("21/21/40")).toBe(false);
    expect(store.rows.has("21/21/41")).toBe(true);
  });

  it("keeps rows put before the store was read", async () => {
    const store = new MemoryStore();
    await store.apply([rowOf(40, { base: 1 })], []);
    const a = new Archive(store);
    a.put(rowOf(40, { base: 9 }));
    await a.load(() => false);
    expect(a.get("21/21/40")!.base).toBe(9);
  });

  it("has no archive in a save: toJson is the same with and without rows", () => {
    const s = game();
    const before = toJson(s);
    ensureArchive(s).put(rowOf(40));
    expect(toJson(s)).toBe(before);
    expect(before).not.toContain("archive");
  });
});

describe("leave past the save's limit", () => {
  it("moves held entries to the archive with their rent, and drops the others", () => {
    const s = game();
    // the oldest two past entries: one held with rent, one not
    s.past.push(pastEntry(40, 1), pastEntry(41, null));
    s.economy.base["21/21/40"] = 55;
    s.economy.checks["21/21/40"] = T0 + 5;
    for (let i = 0; i < PAST_LIMIT - 2; i++) s.past.push(pastEntry(1000 + i, null));
    const p = newProblem({ family: "polygon", N: 21, M: 21, P: 300 }, "open", T0);
    addToQueue(s, p);
    leave(s, p.key, T0 + 10);
    expect(s.past).toHaveLength(PAST_LIMIT);
    expect(s.past.some((q) => q.key === "21/21/40")).toBe(false);
    const a = archiveOf(s)!;
    expect(a.size).toBe(1);
    expect(a.get("21/21/40")).toMatchObject({ ourId: 1, base: 55, check: T0 + 5 });
    expect(a.has("21/21/41")).toBe(false);
    // the economy maps no longer hold it
    expect(s.economy.base["21/21/40"]).toBeUndefined();
    expect(s.economy.checks["21/21/40"]).toBeUndefined();
    expect(seenKeys(s).has("21/21/40")).toBe(true);
  });

  it("counts archived rows in the records held and the rent rate, and tidyRent keeps their rent", () => {
    const s = game();
    const o = ownedSet(s);
    s.past.push(pastEntry(40, 1));
    s.economy.base["21/21/40"] = 100;
    s.economy.checks["21/21/40"] = T0;
    const rate1 = rentRate(s, o);
    const a = ensureArchive(s);
    a.put(rowOf(41, { base: 200, check: T0 }));
    a.put(rowOf(42, { base: 300, check: T0 }));
    expect(recordsHeld(s)).toBe(3);
    expect(heldCount(s)).toBe(3);
    // rent is the same share of the base wherever the record is kept
    expect(rentRate(s, o)).toBeCloseTo(rate1 * 6, 9);
    expect(rentPerHour(s, o, a.get("21/21/42")!)).toBeCloseTo(rate1 * 3, 9);
    expect(rentWaiting(s, o, T0 + 2 * H)).toBeCloseTo(rentRate(s, o) * 2, 9);
    expect(rentWaiting(s, o, T0 + 30 * D)).toBeCloseTo((rentRate(s, o) * RENT_WINDOW_MS) / H, 6);
    tidyRent(s, o, T0 + H);
    expect(a.get("21/21/41")).toMatchObject({ base: 200, check: T0 });
    expect(a.size).toBe(2);
  });

  it("starts rent on archived rows that have none when Rent is bought", () => {
    const s = game();
    ensureArchive(s).put(rowOf(41, { base: 200 }));
    tidyRent(s, ownedSet(s), T0 + 5);
    expect(archiveOf(s)!.get("21/21/41")!.check).toBe(T0 + 5);
  });
});

describe("payday over archived rows", () => {
  const server =
    (leaders: Record<string, { score: number; name: string; id: number } | null>, unknown: string[] = []) =>
    async (keys: string[]): Promise<LeadersAnswer | null> => ({
      leaders: Object.fromEntries(keys.filter((k) => !unknown.includes(k)).map((k) => [k, leaders[k] ?? null])),
      unknown: keys.filter((k) => unknown.includes(k)),
    });
  const deps = (s: GameState, getLeaders: PaydayDeps["getLeaders"]) => {
    const quiet: boolean[] = [];
    const d: PaydayDeps = {
      state: s,
      owned: ownedSet(s),
      now: () => T0 + D,
      getLeaders,
      noteLeader: (p, leader, q) => {
        quiet.push(!!q);
        applyLeader(p, leader, s, T0 + D);
      },
      busy: () => false,
      active: () => true,
    };
    return { d, quiet };
  };

  it("pays held rows and keeps them, removes lost rows with one count, leaves unanswered rows", async () => {
    const s = game();
    const a = ensureArchive(s);
    for (const P of [40, 41, 42, 43]) a.put(rowOf(P, { base: 100, check: T0 }));
    const mine = (P: number) => ({ score: 5, name: s.name, id: 1000 + P });
    const { d, quiet } = deps(
      s,
      server({ "21/21/40": mine(40), "21/21/41": { score: 4, name: "Bob", id: 9 }, "21/21/43": mine(43) }, [
        "21/21/42",
      ]),
    );
    const rp0 = s.rp;
    const r = await runPayday(d);
    expect(r.paying).toBe(2);
    expect(r.lost).toBe(1);
    expect(r.archivedLost).toBe(1);
    expect(r.unanswered).toBe(1);
    expect(r.paid).toBeCloseTo(2 * 24 * 0.01 * 100 * 1, 6);
    expect(s.rp).toBeCloseTo(rp0 + r.paid, 9);
    expect(quiet).toEqual([true, true, true]);
    expect(a.has("21/21/41")).toBe(false);
    expect(a.get("21/21/40")!.check).toBe(T0 + D);
    expect(a.get("21/21/42")!.check).toBe(T0);
    expect(recordsHeld(s)).toBe(3);
  });
});

describe("heldSince", () => {
  const leaderOutcome = (id: number, score: number) => ({ kind: "leader" as const, score, id, pending: false });

  it("is set on gaining, kept on an own improvement, cleared on loss, and saved", () => {
    const s = game();
    const p = newProblem({ family: "polygon", N: 21, M: 21, P: 50 }, "open", T0);
    addToQueue(s, p);
    expect(p.heldSince).toBeUndefined();
    applyAnswer(s, p, null, 5, leaderOutcome(7, 5), T0 + 100);
    expect(p.heldSince).toBe(T0 + 100);
    applyAnswer(s, p, null, 4.9, leaderOutcome(8, 4.9), T0 + 900);
    expect(p.ourId).toBe(8);
    expect(p.heldSince).toBe(T0 + 100);

    const r = fromJson(toJson(s), T0 + 1000);
    expect(r.ok && r.state.queue[0].heldSince).toBe(T0 + 100);
    leave(s, p.key, T0 + 1000);
    expect(s.past[0].heldSince).toBe(T0 + 100);
    const r2 = fromJson(toJson(s), T0 + 1000);
    expect(r2.ok && r2.state.past[0].heldSince).toBe(T0 + 100);

    const lost = s.past[0];
    applyLeader(lost, { score: 4, name: "Bob", id: 99 }, s, T0 + 2000);
    expect(lost.ourId).toBeNull();
    expect(lost.heldSince).toBeUndefined();
    const r3 = fromJson(toJson(s), T0 + 3000);
    expect(r3.ok && r3.state.past[0].heldSince).toBeUndefined();
  });

  it("is cleared by a answer that says another entry got there first", () => {
    const s = game();
    const p = newProblem({ family: "polygon", N: 21, M: 21, P: 50 }, "open", T0);
    addToQueue(s, p);
    applyAnswer(s, p, null, 5, leaderOutcome(7, 5), T0);
    applyAnswer(s, p, null, 4.9, { kind: "behind", score: 4.9, leaderScore: 4.8 }, T0 + 1);
    expect(p.ourId).toBeNull();
    expect(p.heldSince).toBeUndefined();
  });
});

describe("export and import with archive rows", () => {
  it("round-trips the rows through the save string and through a JSON file, leaving out rows whose problem is in the save", async () => {
    const s = game();
    s.past.push(pastEntry(60, 5));
    const a = ensureArchive(s);
    a.put(rowOf(40, { base: 12, check: T0, heldSince: T0 - 5 }));
    a.put(rowOf(41, { base: 13 }));
    const str = await exportString(s, a.values());
    const r = await importString(str, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.archive).toHaveLength(2);
    expect(r.archive!.find((x) => x.key === "21/21/40")).toMatchObject({
      base: 12,
      check: T0,
      heldSince: T0 - 5,
      ourId: 1040,
    });
    expect(r.state.past).toHaveLength(1);
    // the same document as a file
    const file = await importString(toExportJson(s, a.values()), T0);
    expect(file.ok && file.archive).toHaveLength(2);
    // a row of a problem that is in the save is not an archive row
    const dup = JSON.parse(toExportJson(s, [rowOf(60), rowOf(40)]));
    const r2 = fromJson(JSON.stringify(dup), T0);
    expect(r2.ok && r2.archive!.map((x) => x.key)).toEqual(["21/21/40"]);
    // a save without rows reads as before
    const plain = fromJson(toJson(s), T0);
    expect(plain.ok && plain.archive).toBeUndefined();
    expect(archiveRows("nonsense", T0)).toEqual([]);
  });
});

describe("recovery of records lost from the save", () => {
  const holder = (keys: string[]): HolderResponse => {
    const byPair = new Map<string, number[]>();
    for (const k of keys) {
      const [N, M, P] = k.split("/").map(Number);
      byPair.set(`${N}/${M}`, [...(byPair.get(`${N}/${M}`) ?? []), P]);
    }
    return {
      name: "me",
      records: keys.length,
      beat_published: 0,
      site_bests: keys.length,
      pending: 0,
      computed_at: "2026-11-02T00:00:00Z",
      pairs: [...byPair].map(([pair, P]) => {
        const [N, M] = pair.split("/").map(Number);
        return { N, M, P, records: P.length, beat_published: 0, pending: 0 };
      }),
    };
  };

  it("archives the recorded keys the server says the name leads, once", async () => {
    const s = game();
    s.name = "Me";
    // two held records in the save (bases 100 and 300), three recorded problems lost from it
    s.past.push(pastEntry(40, 1), pastEntry(41, 2));
    s.economy.base["21/21/40"] = 100;
    s.economy.base["21/21/41"] = 300;
    s.economy.recorded = ["21/21/40", "21/21/41", "21/21/50", "21/21/51", "21/21/52"];
    const asked: string[][] = [];
    const deps = {
      getHolder: async () => holder(["21/21/50", "21/21/52", "21/21/40", "21/21/99"]),
      getLeaders: async (keys: string[]): Promise<LeadersAnswer> => {
        asked.push(keys);
        return {
          leaders: {
            "21/21/50": { score: 5, name: "Me", id: 77 },
            "21/21/52": { score: 5, name: "Someone else", id: 78 },
          },
          unknown: [],
        };
      },
      now: () => T0 + 7,
    };
    const n = await recoverRecords(s, ownedSet(s), deps);
    expect(n).toBe(1);
    expect(asked).toEqual([["21/21/50", "21/21/52"]]);
    const a = archiveOf(s)!;
    expect(a.size).toBe(1);
    expect(a.get("21/21/50")).toMatchObject({
      ourId: 77,
      tier: "batch",
      base: 200,
      check: T0 + 7,
      heldSince: T0 + 7,
      verified: 5,
    });
    expect(s.archiveRecovered).toBe(true);
    // not again
    expect(await recoverRecords(s, ownedSet(s), { ...deps, getHolder: async () => null })).toBeNull();
    expect(asked).toHaveLength(1);
    expect(fromJson(toJson(s), T0).ok && (fromJson(toJson(s), T0) as { state: GameState }).state.archiveRecovered).toBe(
      true,
    );
  });

  it("tries again later when the server does not answer, and starts no rent without Rent", async () => {
    const s = game(false);
    s.economy.recorded = ["21/21/50"];
    expect(
      await recoverRecords(s, ownedSet(s), {
        getHolder: async () => null,
        getLeaders: async () => null,
        now: () => T0,
      }),
    ).toBeNull();
    expect(s.archiveRecovered).toBeUndefined();
    const n = await recoverRecords(s, ownedSet(s), {
      getHolder: async () => holder(["21/21/50"]),
      getLeaders: async () => ({ leaders: { "21/21/50": { score: 5, name: s.name, id: 3 } }, unknown: [] }),
      now: () => T0,
    });
    expect(n).toBe(1);
    expect(archiveOf(s)!.get("21/21/50")!.check).toBeUndefined();
    expect(archiveOf(s)!.get("21/21/50")!.base).toBe(0);
  });
});

describe("many archived rows", () => {
  it("counts and rates 50,000 rows in a few milliseconds", () => {
    const s = game();
    const o = ownedSet(s);
    const a = new Archive();
    attachArchive(s, a);
    for (let i = 0; i < 50_000; i++) {
      const P = 1 + (i % 500);
      const M = 3 + Math.floor(i / 500);
      a.put({ ...pastEntry(P, i + 1), M, key: `21/${M}/${P}`, base: 50 + (i % 7), check: T0 });
    }
    expect(a.size).toBe(50_000);
    rentRate(s, o);
    recordsHeld(s);
    const t = performance.now();
    for (let i = 0; i < 100; i++) {
      expect(recordsHeld(s)).toBe(50_000);
      expect(rentRate(s, o)).toBeGreaterThan(0);
    }
    expect((performance.now() - t) / 100).toBeLessThan(5);
    // waiting rent is kept for a few seconds
    rentWaiting(s, o, T0 + H);
    const t2 = performance.now();
    for (let i = 0; i < 100; i++) rentWaiting(s, o, T0 + H);
    expect((performance.now() - t2) / 100).toBeLessThan(5);
  });
});
