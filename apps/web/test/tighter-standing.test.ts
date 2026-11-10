import { describe, expect, it } from "vitest";
import { GameState, addToQueue, buy, newGame, newProblem, ownedSet } from "../src/tighter/game";
import {
  RESET_GAIN,
  RESET_MIN,
  RULES,
  bestMark,
  markProgress,
  nextCycleTree,
  dimensionOpenedBy,
  resetCycle,
  resetThreshold,
  resetPreview,
  ruleAllowsMethod,
  ruleAllowsProblem,
  ruleOpenProblems,
  ruleRewardFactor,
  standingMultiplier,
} from "../src/tighter/standing";
import { nextNoon } from "../src/tighter/economy";
import { openSlices } from "../src/tighter/unlocks";
import {
  HEAD2_AUTO_LEVELS,
  HEAD_START_PRICES,
  UPGRADES,
  UpgradeId,
  autoPerSecond,
  canBuy,
  costOf,
  currencyOf,
  evalsPerClick,
  headStartGives,
  listPrice,
  owning,
  upgrade,
} from "../src/tighter/upgrades";
import { fromJson, toJson } from "../src/tighter/save";

const T0 = 1_000_000;
/** What the Standing card needs, bought again each cycle. */
const PREREQUISITES: UpgradeId[] = ["collections", "rent", "ring120"];
const owning2 = (s: GameState, resets: number) => owning(s.owned, s.levels, null, [], [], resets);
const MIN = 60_000;

/**
 * A late first cycle: much of the tree owned (Standing's prerequisites, not Standing: buying it is the reset), a
 * record held, auto-eval running and due a click, and 4 times the threshold earned and in hand.
 */
function lateGame(extra: UpgradeId[] = []): GameState {
  const s = newGame(T0, 1);
  const want = new Set<UpgradeId>(["collections", "rent", "ring120", "rentx", "lanesx", "autox", ...extra]);
  const add = (id: UpgradeId) => {
    if (s.owned.includes(id)) return;
    for (const r of upgrade(id).requires) add(r);
    s.owned.push(id);
  };
  for (const id of want) add(id);
  s.levels = { rentx: 3, lanesx: 2 };
  s.rp = 4 * RESET_MIN;
  s.rpEarned = 16_000_000;
  s.standing.cycleEarned = 4 * RESET_MIN;
  s.autoDue = 50;
  s.settings.auto = true;
  const p = newProblem({ family: "polygon", N: 24, M: 30, P: 40 }, "open", T0);
  addToQueue(s, p);
  p.ourId = 4;
  p.verified = 6;
  return s;
}

describe("Tighter standing", () => {
  it("gives 1 standing point a reset and doubles all points each time", () => {
    expect(RESET_MIN).toBe(200_000_000);
    expect(RESET_GAIN).toBe(1);
    const st = newGame(T0, 1).standing;
    expect([0, 1, 2, 5].map((resets) => standingMultiplier({ ...st, resets }))).toEqual([1, 2, 4, 32]);
  });

  it("sells Standing at the cycle's threshold, only with that much in hand and confirmed this cycle", () => {
    const s = lateGame();
    const o = () => ownedSet(s);
    const funds = () => ({ rp: s.rp, standing: s.standing.points, confirmed: resetPreview(s).price });
    expect(costOf(o(), "standing")).toBe(RESET_MIN);
    expect(canBuy(o(), { rp: RESET_MIN, standing: 0, confirmed: RESET_MIN }, "standing").ok).toBe(true);
    // enough RP, too little confirmed this cycle (the rest is rent or waiting for the server)
    expect(canBuy(o(), { rp: RESET_MIN, standing: 0, confirmed: RESET_MIN - 1 }, "standing").ok).toBe(false);
    // enough confirmed, too little to spend
    expect(canBuy(o(), { rp: RESET_MIN - 1, standing: 0, confirmed: RESET_MIN }, "standing").ok).toBe(false);
    expect(funds().confirmed).toBe(RESET_MIN);
    // Quick study does not discount it, and it costs 5 times as much after each reset
    s.owned.push("study");
    s.levels.study = 5;
    expect(costOf(o(), "standing")).toBe(RESET_MIN);
    expect(costOf(owning2(s, 2), "standing")).toBe(25 * RESET_MIN);
    // buy() does not buy it: resetCycle does
    expect(buy(s, "standing")).toBe(false);
    expect(s.owned).not.toContain("standing");
  });

  it("previews a reset: what it gives, what it keeps, what it takes", () => {
    const s = lateGame();
    const pv = resetPreview(s);
    expect(pv).toMatchObject({
      can: true,
      gain: 1,
      ruleBonus: 0,
      short: 0,
      price: RESET_MIN,
      held: 1,
      opens: "2-on-3",
    });
    // no Head start: rent, collections and the rest all go
    expect(pv.keeps).toEqual([]);
    expect(pv.loses).toEqual(
      expect.arrayContaining(["click2", "basin", "lanes2", "lanesx", "rent", "rentx", "collections"]),
    );
    s.standing.cycleEarned = 1000;
    expect(resetPreview(s)).toMatchObject({ can: false, short: RESET_MIN - 1000 });
    expect(s.standing.dimensions).toEqual(["2-in-2"]);
    expect(resetCycle(s, T0)).toBe(0);
    s.standing.cycleEarned = 4 * RESET_MIN;
    s.rp = RESET_MIN - 1;
    expect(resetPreview(s)).toMatchObject({ can: false, short: 0 });
    expect(resetCycle(s, T0)).toBe(0);
  });

  it("resets the tree and the points, and keeps records, the list of records and the queue", () => {
    const s = lateGame();
    const queue = s.queue;
    const gain = resetCycle(s, T0 + 90 * MIN);
    expect(gain).toBe(1);
    expect(s.standing).toMatchObject({
      points: 1,
      total: 1,
      resets: 1,
      cycleEarned: 0,
      cycleStartedAt: T0 + 90 * MIN,
    });
    expect(standingMultiplier(s.standing)).toBe(2);
    expect(s.standing.dimensions).toEqual(["2-in-2", "2-on-3"]);
    expect(s.rp).toBe(0);
    expect(s.rpEarned).toBe(16_000_000);
    // rent, Higher rent and Collections go like the rest, and Standing is not owned: it is bought again
    expect(s.owned).toEqual([]);
    expect(s.levels).toEqual({});
    expect(s.queue).toBe(queue);
    expect(s.queue[0].ourId).toBe(4);
    // auto-eval is due nothing in a new cycle; without auto-eval, it is off
    expect(s.autoDue).toBe(0);
    expect(s.settings.auto).toBe(false);
    expect(s.standing.history).toHaveLength(1);
    expect(s.standing.history[0]).toMatchObject({
      startedAt: T0,
      endedAt: T0 + 90 * MIN,
      earned: 4 * RESET_MIN,
      gain: 1,
    });
    // the history keeps when the cycle reached its milestones
    expect(Object.keys(s.standing.history[0].marks)).toEqual(
      expect.arrayContaining(["click2", "auto1", "basin", "ready"]),
    );
  });

  it("opens 2D on 3D at the first reset, 3D in 3D at the second and nothing after, for good", () => {
    const s = lateGame();
    expect(resetPreview(s).opens).toBe("2-on-3");
    expect(resetCycle(s, T0 + MIN)).toBeGreaterThan(0);
    expect(s.standing.dimensions).toEqual(["2-in-2", "2-on-3"]);
    s.standing.cycleEarned = resetThreshold(1);
    s.rp = resetThreshold(1);
    s.owned.push(...PREREQUISITES);
    expect(resetPreview(s)).toMatchObject({ can: true, gain: 1, price: 5 * RESET_MIN, opens: "3-in-3" });
    resetCycle(s, T0 + 2 * MIN);
    expect(s.standing.dimensions).toEqual(["2-in-2", "2-on-3", "3-in-3"]);
    s.standing.cycleEarned = resetThreshold(2);
    s.rp = resetThreshold(2);
    s.owned.push(...PREREQUISITES);
    expect(resetPreview(s).opens).toBeNull();
    resetCycle(s, T0 + 3 * MIN);
    expect(s.standing.dimensions).toEqual(["2-in-2", "2-on-3", "3-in-3"]);
    expect(s.standing.resets).toBe(3);
    expect(standingMultiplier(s.standing)).toBe(8);
    expect([1, 2, 3].map(dimensionOpenedBy)).toEqual(["2-on-3", "3-in-3", null]);
  });

  it("deals the free slice of an opened dimension, and a card's slice once the card is owned", () => {
    const s = lateGame();
    const slices = () => openSlices(ownedSet(s), s.standing);
    expect(slices()).toEqual([]);
    resetCycle(s, T0 + MIN);
    expect(slices()).toEqual(["surf-platonic"]);
    s.owned.push("surf-prisms");
    expect(slices()).toEqual(["surf-platonic", "surf-prisms"]);
    // a card is bought again in each cycle: the next reset takes it away
    s.standing.cycleEarned = resetThreshold(1);
    s.rp = resetThreshold(1);
    s.owned.push(...PREREQUISITES);
    resetCycle(s, T0 + 2 * MIN);
    expect(slices()).toEqual(["surf-platonic", "poly-archimedean"]);
  });

  it("gives the cards Head start's levels name, prerequisites and all, and nothing past their price", () => {
    expect(HEAD_START_PRICES).toEqual([10_000, 1_000_000, 100_000_000]);
    const at = (level: number) => headStartGives(level);
    expect(at(0)).toEqual({ ids: [], levels: {} });
    for (const level of [1, 2, 3]) {
      const g = at(level);
      const limit = HEAD_START_PRICES[level - 1];
      const owned = new Set(g.ids);
      for (const u of UPGRADES) {
        if (!owned.has(u.id)) continue;
        // every card given, and its prerequisites
        for (const r of u.requires) expect(owned.has(r)).toBe(true);
      }
      // each card given on its own price costs at most the limit, at every level given
      for (const id of g.ids) {
        const u = upgrade(id);
        expect(currencyOf(u)).toBe("rp");
        if (u.levels && g.levels[id]) expect(listPrice(id, g.levels[id]! - 1)).toBeLessThanOrEqual(limit);
      }
      // never given
      expect(owned.has("standing")).toBe(false);
      expect(owned.has("lanesx")).toBe(false);
      expect(g.ids.filter((id) => upgrade(id).row === "dimensions")).toEqual([]);
      expect(g.levels.autox).toBeLessThanOrEqual(HEAD2_AUTO_LEVELS);
    }
    // Records pay rent (200k) and Collections (280k) come with level 2, not level 1
    expect(at(1).ids).not.toContain("rent");
    expect(at(1).ids).not.toContain("collections");
    expect(at(2).ids).toEqual(expect.arrayContaining(["rent", "collections", "rentx"]));
    // the price cut brings Higher rent's later levels under 1,000,000 RP (the 5th costs 793,187 after it)
    expect(at(2).levels.rentx).toBe(5);
    expect(at(3).levels.rentx).toBe(5);
    // level 1 gives the first cards and Auto-eval's first levels
    expect(at(1).ids).toEqual(
      expect.arrayContaining(["trace", "click2", "click3", "click4", "click5", "auto1", "autox"]),
    );
    expect(at(1).levels.autox).toBe(HEAD2_AUTO_LEVELS);
  });

  it("begins the next cycle with Head start's cards, and keeps the rows bought", () => {
    const s = lateGame(["keepAuto", "keepMethods", "study", "shrink", "head"]);
    s.levels.head = 2;
    s.levels.study = 2;
    s.levels.autox = 12;
    const tree = nextCycleTree(s);
    const owned = new Set(tree.owned);
    const gives = headStartGives(2);
    for (const id of gives.ids) expect(owned.has(id)).toBe(true);
    // rent and collections come back with level 2
    expect(owned.has("rent") && owned.has("collections") && owned.has("rentx")).toBe(true);
    // the auto-eval row and the methods survive, with their levels; the rest of the tree does not
    expect(owned.has("shrink")).toBe(true);
    expect(owned.has("lanesx")).toBe(false);
    expect(owned.has("standing")).toBe(false);
    // Keep auto-eval keeps all 12 levels of Faster auto-eval, more than Head start's 9
    expect(tree.levels).toMatchObject({ study: 2, head: 2, autox: 12, rentx: gives.levels.rentx });
    expect(tree.owned).toEqual(UPGRADES.filter((u) => owned.has(u.id)).map((u) => u.id));
    // with Keep auto-eval, it stays on, due nothing yet
    resetCycle(s, T0);
    expect(s.autoDue).toBe(0);
    expect(s.settings.auto).toBe(true);
    expect(evalsPerClick(ownedSet(s))).toBe(10);
  });

  it("starts rent again at a reset only with Rent given back, and loses rent not yet paid", () => {
    const s = lateGame(["head"]);
    s.levels.head = 1;
    const p = s.queue[0];
    s.economy.paidUntil = T0 - 3_600_000;
    s.economy.paydayAt = T0 + 3_600_000;
    expect(resetCycle(s, T0 + MIN)).toBe(1);
    // level 1 does not bring Rent back: no rent accrues, none was paid
    expect(s.owned).not.toContain("rent");
    expect(s.economy.paidUntil).toBeUndefined();
    expect(s.economy.paydayAt).toBeUndefined();
    // level 2 does: every record held starts earning from the reset, without back rent
    const t = lateGame(["head"]);
    t.levels.head = 2;
    t.economy.paidUntil = T0 - 24 * 3_600_000;
    resetCycle(t, T0 + 5 * MIN);
    expect(t.owned).toContain("rent");
    expect(t.economy.paidUntil).toBe(T0 + 5 * MIN);
    expect(t.economy.paydayAt).toBe(nextNoon(T0 + 5 * MIN));
  });

  it("spends standing on the Standing row, 1 point an option and a level", () => {
    const s = lateGame();
    resetCycle(s, T0);
    expect(s.standing.points).toBe(1);
    expect(buy(s, "head")).toBe(true);
    expect(s.standing.points).toBe(0);
    expect(buy(s, "pipeline")).toBe(false);
    s.standing.points = 6;
    expect(buy(s, "head")).toBe(true);
    expect(buy(s, "head")).toBe(true);
    expect(buy(s, "head")).toBe(false);
    expect(s.levels.head).toBe(3);
    expect(buy(s, "pipeline")).toBe(true);
    expect(buy(s, "rules")).toBe(true);
    expect(s.standing.points).toBe(2);
    // Keep methods needs Keep auto-eval, which needs Head start
    expect(buy(s, "keepMethods")).toBe(false);
    expect(buy(s, "keepAuto")).toBe(true);
    expect(s.standing.total).toBe(1);
  });

  it("times the milestones of each cycle, and remembers the best", () => {
    const s = lateGame(["head"]);
    s.levels.head = 1;
    s.standing.cycleStartedAt = T0;
    s.standing.marks = {};
    markProgress(s, T0 + 5 * MIN);
    expect(s.standing.marks.click2).toBe(5 * MIN);
    expect(s.standing.marks.ready).toBe(5 * MIN);
    resetCycle(s, T0 + 60 * MIN);
    // Head start 1: 2 per click and auto-eval at the start of the next cycle
    expect(s.standing.marks).toMatchObject({ click2: 0, auto1: 0 });
    expect(s.standing.marks.basin).toBeUndefined();
    s.standing.history.push({ startedAt: 0, endedAt: 1, earned: 1, gain: 1, rule: null, marks: { click2: 3 * MIN } });
    expect(bestMark(s.standing, "click2")).toBe(3 * MIN);
    expect(bestMark(s.standing, "advance")).toBe(5 * MIN);
    expect(bestMark(newGame(T0, 1).standing, "click2")).toBeNull();
  });
});

describe("Tighter cycle rules", () => {
  it("limit the problems, the methods and auto-eval for one cycle", () => {
    const s = newGame(T0, 1);
    s.owned.push("auto1");
    expect(ruleAllowsProblem(s.standing, { family: "polygon", N: 40, M: 40, P: 100 })).toBe(true);
    s.standing.rule = "circles";
    expect(ruleAllowsProblem(s.standing, { family: "polygon", N: 0, M: 40, P: 100 })).toBe(true);
    expect(ruleAllowsProblem(s.standing, { family: "polygon", N: 40, M: 0, P: 100 })).toBe(true);
    expect(ruleAllowsProblem(s.standing, { family: "polygon", N: 40, M: 40, P: 100 })).toBe(false);
    expect(ruleOpenProblems(s.standing)!.length).toBe(17 * 9 * 2);
    expect(ruleOpenProblems(s.standing)!.every((p) => ruleAllowsProblem(s.standing, p))).toBe(true);
    s.standing.rule = "small";
    expect(ruleAllowsProblem(s.standing, { family: "polygon", N: 40, M: 40, P: 60 })).toBe(false);
    expect(ruleAllowsProblem(s.standing, { family: "polygon", N: 21, M: 21, P: 40 })).toBe(true);
    expect(ruleOpenProblems(s.standing)!.length).toBeGreaterThan(20);
    expect(ruleOpenProblems(s.standing)!.every((p) => p.N + p.M + p.P <= 120)).toBe(true);
    s.standing.rule = "method";
    expect(ruleAllowsMethod(s.standing, "mc_compress")).toBe(true);
    expect(ruleAllowsMethod(s.standing, "basin_hopping")).toBe(false);
    expect(ruleOpenProblems(s.standing)).toBeNull();
    expect(autoPerSecond(ownedSet(s))).toBe(1);
    s.standing.rule = "clicks";
    expect(autoPerSecond(ownedSet(s))).toBeNull();
    s.standing.rule = null;
    expect(ruleAllowsMethod(s.standing, "basin_hopping")).toBe(true);
  });

  it("pay 1 more standing point and a reward of their own, for good, once the cycle is finished under them", () => {
    const s = lateGame(["rules"]);
    s.standing.rule = "clicks";
    s.standing.nextRule = "method";
    expect(resetPreview(s)).toMatchObject({ gain: 2, ruleBonus: 1 });
    expect(resetCycle(s, T0)).toBe(2);
    expect(s.standing.points).toBe(2);
    expect(s.standing.rulesDone).toEqual(["clicks"]);
    // the next cycle runs under the rule chosen for it
    expect(s.standing.rule).toBe("method");
    expect(s.standing.nextRule).toBeNull();
    expect(s.standing.history[0].rule).toBe("clicks");
    // clicks only, finished: one more evaluation per click, for good
    expect(evalsPerClick(ownedSet(s))).toBe(2);
    expect(ruleAllowsMethod(s.standing, "basin_hopping")).toBe(false);
    // one method, finished: 1.5 times the points on mc_compress's boards (after its cycle)
    expect(ruleRewardFactor(s.standing, { family: "polygon", N: 21, M: 21, P: 40 }, "mc_compress")).toBe(1);
    s.standing.cycleEarned = resetThreshold(1);
    s.rp = resetThreshold(1);
    s.owned.push("collections", "rent", "ring120");
    resetCycle(s, T0 + MIN);
    expect(s.standing.rulesDone).toEqual(["clicks", "method"]);
    expect(ruleRewardFactor(s.standing, { family: "polygon", N: 21, M: 21, P: 40 }, "mc_compress")).toBe(1.5);
    // the One seed rule went with the Seeds row
    expect(RULES.map((r) => r.id)).toEqual(["circles", "small", "clicks", "method"]);
  });

  it("begin a cycle without a rule unless Cycle rules is owned", () => {
    const s = lateGame();
    s.standing.nextRule = "circles";
    resetCycle(s, T0);
    expect(s.standing.rule).toBeNull();
  });
});

describe("Tighter standing saves", () => {
  it("round-trip standing, its history, marks and rules, and drop what cannot be read", () => {
    const s = lateGame(["rules"]);
    s.standing.rule = "small";
    s.standing.nextRule = "method";
    resetCycle(s, T0 + MIN);
    const r = fromJson(toJson(s), T0 + 2 * MIN);
    expect(r.ok && r.state.standing).toEqual(s.standing);
    const raw = JSON.parse(toJson(s));
    raw.standing.rule = "warp";
    raw.standing.rulesDone = ["small", "warp", 3];
    raw.standing.marks = { click2: -1, auto1: 5, nope: 3 };
    raw.standing.history = [{ startedAt: 1, endedAt: 2, earned: "x", gain: 1, rule: "nope", marks: {} }, 7];
    const t = fromJson(JSON.stringify(raw), T0);
    expect(t.ok && t.state.standing).toMatchObject({
      rule: null,
      rulesDone: ["small"],
      marks: { auto1: 5 },
      history: [{ startedAt: 1, endedAt: 2, earned: 0, gain: 1, rule: null, marks: {} }],
    });
  });
});
