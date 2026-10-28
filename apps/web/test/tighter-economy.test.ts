import { describe, expect, it } from "vitest";
import { areaLowerBound } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import {
  GameState,
  ProblemState,
  StepOutcome,
  addToQueue,
  applyAnswer,
  applyLeader,
  applyLoadAll,
  applyStep,
  leave,
  markSending,
  newGame,
  newProblem,
  ownedSet,
  pendingPoints,
} from "../src/tighter/game";
import {
  RENT_WINDOW_MS,
  collections,
  collectionsBonus,
  heldRecords,
  nextRentCheck,
  noteRecorded,
  pointsMultiplier,
  rentPerHour,
  rentRate,
  rentWaiting,
  settleRent,
  syncEconomy,
  tidyRent,
} from "../src/tighter/economy";
import { FRONTIER_P } from "../src/tighter/frontier";
import { fromJson, toJson } from "../src/tighter/save";

const T0 = 1_000_000;
const H = 3_600_000;
const board = (P: number, shift = 0): PackingConfig => ({
  N: 24,
  M: 30,
  P,
  pieces: Array.from({ length: P }, (_, i) => ({ x: 3 * i + shift, y: 0, theta: 0 })),
  container_phi: 0,
});
const step = (score: number, seed = 1, extra: Partial<StepOutcome> = {}): StepOutcome => ({
  evaluations: 1,
  best: board(3, seed),
  score,
  run: { method: "mc_compress", params: {}, seed, budget: { evals: 30 } },
  ms: 2,
  ended: false,
  click: true,
  ...extra,
});
const B = areaLowerBound(24, 30, 3);

function game(): { s: GameState; p: ProblemState } {
  const s = newGame(T0, 1);
  s.name = "Ada";
  const p = newProblem({ family: "polygon", N: 24, M: 30, P: 3 }, "open", T0);
  addToQueue(s, p);
  applyLoadAll(p, board(3), 1.28 * B, null);
  return { s, p };
}

/** A first record on the problem, sent and confirmed as leader with entry id `id`. */
function confirmed(s: GameState, p: ProblemState, score: number, id: number, now = T0) {
  applyStep(s, p, step(score, id, { evaluations: 100 }), now);
  markSending(p, score, s.name, p.leader, now);
  return applyAnswer(s, p, p.leader, score, { kind: "leader", score, id, pending: false }, now);
}

describe("Tighter points multiplier", () => {
  it("multiplies what each click pays, and takes back exactly what was paid", () => {
    const { s, p } = game();
    s.standing.total = 5;
    const c = applyStep(s, p, step(1.2 * B, 1, { evaluations: 100 }), T0);
    const paid = c.points as NonNullable<typeof c.points> & { base: number; multiplier: number };
    expect(paid.multiplier).toBeCloseTo(1.5, 12);
    expect(paid.total).toBeCloseTo(paid.base * 1.5, 9);
    expect(s.rp).toBeCloseTo(paid.total, 9);
    expect(p.unconfirmed).toBeCloseTo(paid.total, 9);
    expect(s.standing.cycleEarned).toBeCloseTo(paid.total, 9);
    expect(s.economy.base[p.key]).toBeCloseTo(paid.base, 9);
    // the server makes another entry leader first: everything paid comes back out, the cycle's count too
    markSending(p, 1.2 * B, "Ada", null, T0);
    const a = applyAnswer(s, p, null, 1.2 * B, { kind: "behind", leaderScore: 1.1 * B }, T0);
    expect(a.takenBack).toBeCloseTo(paid.total, 9);
    expect(s.rp).toBeCloseTo(0, 9);
    expect(s.rpEarned).toBeCloseTo(0, 9);
    expect(s.standing.cycleEarned).toBeCloseTo(0, 9);
    expect(s.economy.base[p.key]).toBeCloseTo(0, 9);
  });

  it("shows unpaid points with the multiplier when the game is given", () => {
    const { s, p } = game();
    s.standing.total = 10;
    applyStep(s, p, step(1.2 * B, 1, { evaluations: 100 }), T0);
    // the step paid at once: what it would pay again, measured from the start
    p.paidTo = null;
    const plain = pendingPoints(p, s.name)!;
    const multiplied = pendingPoints(p, s.name, s)!;
    expect(plain.multiplier).toBe(1);
    expect(multiplied.total).toBeCloseTo(plain.total * 2, 9);
  });

  it("stacks standing, collections and the rules finished", () => {
    const { s, p } = game();
    s.standing.total = 2;
    s.standing.rulesDone = ["small", "circles", "method"];
    s.economy.tiers = ["open"];
    const without = pointsMultiplier(s, ownedSet(s), p, "mc_compress");
    // Collections not owned: no bonus yet; small problem (N+M+P = 57) and mc_compress: ×1.5 twice
    expect(without).toBeCloseTo(1.2 * 1.5 * 1.5, 12);
    s.owned.push("collections");
    expect(pointsMultiplier(s, ownedSet(s), p, "mc_compress")).toBeCloseTo(1.2 * 1.05 * 2.25, 12);
    expect(pointsMultiplier(s, ownedSet(s), { family: "polygon", N: 0, M: 40, P: 200 }, "basin_hopping")).toBeCloseTo(
      1.2 * 1.05 * 1.5,
      12,
    );
    expect(pointsMultiplier(s, ownedSet(s), { family: "polygon", N: 40, M: 40, P: 200 }, null)).toBeCloseTo(
      1.2 * 1.05,
      12,
    );
  });
});

describe("Tighter records", () => {
  it("count every problem the server confirmed, once, with its tier", () => {
    const { s, p } = game();
    confirmed(s, p, 1.2 * B, 7);
    expect(s.economy.recorded).toEqual([p.key]);
    expect(s.economy.tiers).toEqual(["open"]);
    // a better record later is the same problem
    applyStep(s, p, step(1.19 * B, 8), T0);
    markSending(p, 1.19 * B, s.name, p.leader, T0);
    applyAnswer(s, p, p.leader, 1.19 * B, { kind: "leader", score: 1.19 * B, id: 8, pending: false }, T0);
    expect(s.economy.recorded).toEqual([p.key]);
    // a lost answer settled from the leader counts too
    const q = newProblem({ family: "polygon", N: 21, M: 21, P: 40 }, "loose", T0);
    addToQueue(s, q);
    q.phase = "ready";
    q.board = { ...board(3), N: 21, M: 21, P: 40 };
    q.best = 5;
    q.run = step(5).run;
    q.paidTo = 5;
    markSending(q, 5, "Ada", null, T0);
    applyLeader(q, { score: 5, name: "Ada", id: 11 }, s, T0);
    expect(s.economy.recorded).toEqual([p.key, q.key]);
    expect(s.economy.tiers).toEqual(["open", "loose"]);
  });

  it("bring a save from before the economy up to date", () => {
    const s = newGame(T0, 1);
    s.rpEarned = 1234;
    s.past.push({
      N: 21,
      M: 21,
      P: 40,
      key: "21/21/40",
      tier: "open",
      best: 5,
      verified: 5,
      ourId: 2,
      rp: 3,
      leftAt: T0,
    });
    s.past.push({
      N: 21,
      M: 24,
      P: 40,
      key: "21/24/40",
      tier: "open",
      best: 5,
      verified: null,
      ourId: null,
      rp: 0,
      leftAt: T0,
    });
    syncEconomy(s);
    expect(s.economy.recorded).toEqual(["21/21/40"]);
    expect(s.standing.cycleEarned).toBe(1234);
  });
});

describe("Tighter rent", () => {
  function held(): { s: GameState; p: ProblemState } {
    const { s, p } = game();
    s.owned.push("rent");
    confirmed(s, p, 1.2 * B, 7, T0);
    return { s, p };
  }

  it("pays 1 % an hour of what the record earned, when a check finds it still held", () => {
    const { s, p } = held();
    const o = ownedSet(s);
    expect(s.economy.checks[p.key]).toBe(T0);
    const base = s.economy.base[p.key];
    expect(rentPerHour(s, o, p)).toBeCloseTo(0.01 * base, 12);
    expect(rentRate(s, o)).toBeCloseTo(0.01 * base, 12);
    expect(rentWaiting(s, o, T0 + 2 * H)).toBeCloseTo(0.02 * base, 12);
    const rp0 = s.rp;
    const paid = settleRent(s, o, p, T0 + 2 * H);
    expect(paid).toBeCloseTo(0.02 * base, 12);
    expect(s.rp).toBeCloseTo(rp0 + paid, 12);
    expect(s.economy.rentPaid).toBeCloseTo(paid, 12);
    expect(s.economy.lastRent).toMatchObject({ key: p.key, at: T0 + 2 * H });
    // the next window starts at the check; Higher rent adds half again a level, standing multiplies
    expect(rentWaiting(s, o, T0 + 2 * H)).toBe(0);
    s.owned.push("rentx");
    s.levels.rentx = 2;
    s.standing.total = 10;
    expect(rentPerHour(s, ownedSet(s), p)).toBeCloseTo(0.01 * base * 2.25 * 2, 12);
  });

  it("pays a week at most, and nothing without Rent", () => {
    const { s, p } = held();
    const base = s.economy.base[p.key];
    const paid = settleRent(s, ownedSet(s), p, T0 + 30 * 24 * H);
    expect(paid).toBeCloseTo((0.01 * base * RENT_WINDOW_MS) / H, 9);
    s.owned = s.owned.filter((id) => id !== "rent");
    expect(settleRent(s, ownedSet(s), p, T0 + 40 * 24 * H)).toBe(0);
    expect(rentRate(s, ownedSet(s))).toBe(0);
  });

  it("pays nothing for the unchecked time of a record lost", () => {
    const { s, p } = held();
    const r = applyLeader(p, { score: 1.1 * B, name: "Bob", id: 99 }, s, T0 + 5 * H);
    expect(r.lost).toBe(true);
    expect(s.economy.checks[p.key]).toBeUndefined();
    expect(settleRent(s, ownedSet(s), p, T0 + 6 * H)).toBe(0);
    expect(heldRecords(s)).toEqual([]);
  });

  it("checks the record checked longest ago, starts rent for records held before Rent, and forgets the rest", () => {
    const { s, p } = game();
    confirmed(s, p, 1.2 * B, 7, T0);
    // held before Rent was bought: no rent owed for that time
    expect(s.economy.checks).toEqual({});
    s.owned.push("rent");
    s.past.push({
      N: 21,
      M: 21,
      P: 40,
      key: "21/21/40",
      tier: "open",
      best: 5,
      verified: 5,
      ourId: 2,
      rp: 30,
      leftAt: T0,
    });
    s.economy.checks["9/9/9"] = T0;
    tidyRent(s, ownedSet(s), T0 + H);
    expect(s.economy.checks).toEqual({ [p.key]: T0 + H, "21/21/40": T0 + H });
    s.economy.checks["21/21/40"] = T0;
    expect(nextRentCheck(s, ownedSet(s), T0 + H)!.key).toBe("21/21/40");
    // a record checked less than ten minutes ago waits: a few records cost few requests
    expect(nextRentCheck(s, ownedSet(s), T0 + 9 * 60_000)).toBeNull();
    expect(nextRentCheck(s, ownedSet(s), T0 + 10 * 60_000)!.key).toBe("21/21/40");
    // a past record without a kept base pays on what it earned
    expect(rentPerHour(s, ownedSet(s), s.past[0])).toBeCloseTo(0.3, 12);
    // a problem that leaves the queue still holding its record keeps paying from the past list
    leave(s, p.key, T0 + H);
    tidyRent(s, ownedSet(s), T0 + H);
    expect(Object.keys(s.economy.checks).sort()).toEqual(["21/21/40", "24/30/3"]);
  });
});

describe("Tighter collections", () => {
  it("count frontier pairs, piece-shape milestones and tier firsts", () => {
    const s = newGame(T0, 1);
    s.economy.recorded = FRONTIER_P.map((P) => `24/30/${P}`);
    s.economy.recorded.push(...FRONTIER_P.slice(0, 7).map((P) => `21/21/${P}`));
    s.economy.recorded.push(...Array.from({ length: 14 }, (_, i) => `24/40/${300 + i}`));
    s.economy.tiers = ["open", "loose"];
    const c = collections(s.economy);
    expect(c.pairs).toBe(1);
    expect(c.nearest[0]).toEqual({ N: 21, M: 21, have: 7 });
    // 24-gons: 9 + 14 records, past the 10 milestone; 21-gons: 7
    expect(c.shapes[0]).toEqual({ N: 24, count: 23, milestones: 1 });
    expect(c.milestones).toBe(1);
    expect(c.tiers).toEqual(["open", "loose"]);
    expect(c.bonus).toBeCloseTo(0.02 + 0.01 + 0.1, 12);
    expect(collectionsBonus(s, ownedSet(s))).toBe(0);
    s.owned.push("collections");
    expect(collectionsBonus(s, ownedSet(s))).toBeCloseTo(0.13, 12);
    // counted again when a record is added
    s.owned.push("rent");
    const p = newProblem({ family: "polygon", N: 21, M: 21, P: 250 }, "batch", T0);
    noteRecorded(s, ownedSet(s), p, T0);
    expect(collections(s.economy).tiers).toEqual(["open", "loose", "batch"]);
    expect(s.economy.checks[p.key]).toBe(T0);
  });
});

describe("Tighter economy saves", () => {
  it("round-trip rent, bases, checks, tiers and the last rent", () => {
    const { s, p } = game();
    s.owned.push("rent");
    confirmed(s, p, 1.2 * B, 7, T0);
    settleRent(s, ownedSet(s), p, T0 + H);
    const r = fromJson(toJson(s), T0 + H);
    expect(r.ok && r.state.economy).toEqual(s.economy);
    expect(r.ok && r.state.standing).toEqual(s.standing);
  });
});
