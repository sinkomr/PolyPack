import { describe, expect, it } from "vitest";
import { GameState, addToQueue, buy, newGame, newProblem, ownedSet } from "../src/tighter/game";
import {
  HEAD_STARTS,
  RESET_MIN,
  RULES,
  bestMark,
  markProgress,
  nextCycleTree,
  dimensionOpenedBy,
  nextStandingAt,
  resetCycle,
  resetThreshold,
  resetPreview,
  ruleAllowsMethod,
  ruleAllowsProblem,
  ruleBonus,
  ruleOpenProblems,
  ruleRewardFactor,
  standingGain,
  standingMultiplier,
} from "../src/tighter/standing";
import { openSlices } from "../src/tighter/unlocks";
import { UPGRADES, UpgradeId, autoPerSecond, evalsPerClick, upgrade } from "../src/tighter/upgrades";
import { fromJson, toJson } from "../src/tighter/save";

const T0 = 1_000_000;
const MIN = 60_000;

/** A late first cycle: Standing bought, much of the tree owned, a record held, auto-eval running and due a click. */
function lateGame(extra: UpgradeId[] = []): GameState {
  const s = newGame(T0, 1);
  const want = new Set<UpgradeId>(["standing", "rentx", "lanesx", "clickx", "auto7", ...extra]);
  const add = (id: UpgradeId) => {
    if (s.owned.includes(id)) return;
    for (const r of upgrade(id).requires) add(r);
    s.owned.push(id);
  };
  for (const id of want) add(id);
  s.levels = { rentx: 3, lanesx: 2, clickx: 5 };
  s.rp = 123_456;
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
  it("is earned from the cycle's points alone, 5 at the threshold and growing as its square root", () => {
    expect(RESET_MIN).toBe(200_000_000);
    expect(standingGain(RESET_MIN - 1)).toBe(0);
    expect(standingGain(RESET_MIN)).toBe(5);
    expect(standingGain(4 * RESET_MIN)).toBe(10);
    expect(standingGain(100 * RESET_MIN)).toBe(50);
    expect(standingGain(RESET_MIN, resetThreshold(1))).toBe(0);
    expect(standingGain(resetThreshold(1), resetThreshold(1))).toBe(5);
    // the next point: 5 √(c / T) = 6 at 1.44 T
    expect(nextStandingAt(RESET_MIN)).toBe(288_000_000);
    expect(nextStandingAt(4 * RESET_MIN)).toBe(Math.ceil((RESET_MIN * 121) / 25));
    expect(nextStandingAt(0)).toBe(RESET_MIN);
    expect(nextStandingAt(resetThreshold(2), resetThreshold(2))).toBe(1.44 * resetThreshold(2));
    for (const e of [RESET_MIN, 3 * RESET_MIN, 7.3 * RESET_MIN])
      expect(standingGain(nextStandingAt(e))).toBe(standingGain(e) + 1);
    expect(ruleBonus(0)).toBe(0);
    expect(ruleBonus(1)).toBe(1);
    expect(ruleBonus(5)).toBe(3);
    expect(standingMultiplier({ ...newGame(T0, 1).standing, total: 7 })).toBeCloseTo(1.7, 12);
  });

  it("previews a reset: what it gives, what it keeps, what it takes", () => {
    const s = lateGame();
    const pv = resetPreview(s);
    expect(pv).toMatchObject({ gain: 10, ruleBonus: 0, short: 0, held: 1, opens: "2-on-3" });
    expect(pv.keeps).toEqual(expect.arrayContaining(["standing", "rent", "rentx", "collections"]));
    expect(pv.loses).toEqual(expect.arrayContaining(["click2", "basin", "lanes2", "lanesx", "clickx"]));
    s.standing.cycleEarned = 1000;
    expect(resetPreview(s)).toMatchObject({ gain: 0, short: RESET_MIN - 1000 });
    expect(s.standing.dimensions).toEqual(["2-in-2"]);
    expect(resetCycle(s, T0)).toBe(0);
  });

  it("resets the tree and the points, and keeps records, rent, collections and the queue", () => {
    const s = lateGame();
    const queue = s.queue;
    const gain = resetCycle(s, T0 + 90 * MIN);
    expect(gain).toBe(10);
    expect(s.standing).toMatchObject({
      points: 10,
      total: 10,
      resets: 1,
      cycleEarned: 0,
      cycleStartedAt: T0 + 90 * MIN,
    });
    expect(s.standing.dimensions).toEqual(["2-in-2", "2-on-3"]);
    expect(s.rp).toBe(0);
    expect(s.rpEarned).toBe(16_000_000);
    expect(s.owned.sort()).toEqual(["collections", "rent", "rentx", "standing"].sort());
    expect(s.levels).toEqual({ rentx: 3 });
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
      gain: 10,
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
    expect(resetPreview(s)).toMatchObject({ gain: 5, opens: "3-in-3" });
    resetCycle(s, T0 + 2 * MIN);
    expect(s.standing.dimensions).toEqual(["2-in-2", "2-on-3", "3-in-3"]);
    s.standing.cycleEarned = resetThreshold(2);
    expect(resetPreview(s).opens).toBeNull();
    resetCycle(s, T0 + 3 * MIN);
    expect(s.standing.dimensions).toEqual(["2-in-2", "2-on-3", "3-in-3"]);
    expect(s.standing.resets).toBe(3);
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
    resetCycle(s, T0 + 2 * MIN);
    expect(slices()).toEqual(["surf-platonic", "poly-archimedean"]);
  });

  it("begins the next cycle with the head starts owned, prerequisites and all, and keeps the rows bought", () => {
    const s = lateGame(["head1", "head2", "head3", "keepAuto", "keepMethods", "study", "shrink", "auto9"]);
    s.levels.study = 2;
    s.levels.autox = 1;
    s.owned.push("autox");
    const tree = nextCycleTree(s);
    const owned = new Set(tree.owned);
    for (const ids of Object.values(HEAD_STARTS)) for (const id of ids!) expect(owned.has(id)).toBe(true);
    // every head-start upgrade's prerequisites come with it (Basin hopping needs 10 per click and auto-eval at 1/2 s)
    for (const id of tree.owned)
      if (!["standing", "rent", "rentx", "collections"].includes(id) && upgrade(id).currency !== "standing")
        for (const r of upgrade(id).requires)
          if (!["shrink", "auto9", "autox"].includes(id)) expect(owned.has(r)).toBe(true);
    // the auto-eval row and the methods survive, with their levels; record points' upgrades elsewhere do not
    expect(owned.has("auto9")).toBe(true);
    expect(owned.has("autox")).toBe(true);
    expect(owned.has("shrink")).toBe(true);
    expect(owned.has("lanesx")).toBe(false);
    expect(tree.levels).toEqual({ rentx: 3, study: 2, autox: 1 });
    expect(tree.owned).toEqual(UPGRADES.filter((u) => owned.has(u.id)).map((u) => u.id));
    // with Keep auto-eval, it stays on, due nothing yet
    resetCycle(s, T0);
    expect(s.autoDue).toBe(0);
    expect(s.settings.auto).toBe(true);
    expect(evalsPerClick(ownedSet(s))).toBe(10);
  });

  it("spends standing on the Standing row", () => {
    const s = lateGame();
    resetCycle(s, T0);
    expect(buy(s, "head1")).toBe(true);
    expect(s.standing.points).toBe(9);
    expect(buy(s, "pipeline")).toBe(true);
    expect(s.standing.points).toBe(5);
    expect(buy(s, "keepMethods")).toBe(false);
    expect(s.standing.total).toBe(10);
  });

  it("times the milestones of each cycle, and remembers the best", () => {
    const s = lateGame(["head1"]);
    s.standing.cycleStartedAt = T0;
    s.standing.marks = {};
    markProgress(s, T0 + 5 * MIN);
    expect(s.standing.marks.click2).toBe(5 * MIN);
    expect(s.standing.marks.ready).toBe(5 * MIN);
    resetCycle(s, T0 + 60 * MIN);
    // head start I: 2 per click and auto-eval at the start of the next cycle
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

  it("pay extra standing and a reward of their own, for good, once the cycle is finished under them", () => {
    const s = lateGame(["rules"]);
    s.standing.rule = "clicks";
    s.standing.nextRule = "method";
    expect(resetPreview(s)).toMatchObject({ gain: 15, ruleBonus: 5 });
    expect(resetCycle(s, T0)).toBe(15);
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
