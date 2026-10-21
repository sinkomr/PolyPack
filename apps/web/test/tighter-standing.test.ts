import { describe, expect, it } from "vitest";
import { GameState, addToQueue, buy, newGame, newProblem, ownedSet } from "../src/tighter/game";
import {
  HEAD_STARTS,
  RESET_MIN,
  RULES,
  bestMark,
  markProgress,
  nextCycleTree,
  nextStandingAt,
  resetCycle,
  resetPreview,
  ruleAllowsMethod,
  ruleAllowsProblem,
  ruleBonus,
  ruleOpenProblems,
  standingGain,
  standingMultiplier,
} from "../src/tighter/standing";
import { UPGRADES, UpgradeId, autoPerSecond, evalsPerClick, seedsPerProblem, upgrade } from "../src/tighter/upgrades";
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
  s.rpEarned = 2_000_000;
  s.standing.cycleEarned = 1_000_000;
  s.autoDue = 50;
  s.settings.auto = true;
  const p = newProblem({ N: 24, M: 30, P: 40 }, "open", T0);
  addToQueue(s, p);
  p.ourId = 4;
  p.verified = 6;
  return s;
}

describe("Tighter standing", () => {
  it("is earned from the cycle's points and the records held, never from records alone", () => {
    expect(standingGain(RESET_MIN - 1, 1000)).toBe(0);
    expect(standingGain(RESET_MIN, 0)).toBe(1);
    expect(standingGain(1_000_000, 0)).toBe(2);
    expect(standingGain(1_000_000, 100)).toBe(4);
    expect(standingGain(25_000_000, 0)).toBe(10);
    // the next point: √(c / 250,000) = 3 at 2.25 M
    expect(nextStandingAt(1_000_000, 0)).toBe(2_250_000);
    expect(nextStandingAt(0, 0)).toBe(RESET_MIN);
    expect(standingGain(nextStandingAt(1_000_000, 25), 25)).toBe(3);
    expect(ruleBonus(0)).toBe(0);
    expect(ruleBonus(1)).toBe(1);
    expect(ruleBonus(5)).toBe(3);
    expect(standingMultiplier({ ...newGame(T0, 1).standing, total: 7 })).toBeCloseTo(1.7, 12);
  });

  it("previews a reset: what it gives, what it keeps, what it takes", () => {
    const s = lateGame();
    const pv = resetPreview(s);
    expect(pv).toMatchObject({ gain: 2, ruleBonus: 0, short: 0, held: 1 });
    expect(pv.keeps).toEqual(expect.arrayContaining(["standing", "rent", "rentx", "collections"]));
    expect(pv.loses).toEqual(expect.arrayContaining(["click2", "basin", "lanes2", "lanesx", "clickx"]));
    s.standing.cycleEarned = 1000;
    expect(resetPreview(s)).toMatchObject({ gain: 0, short: RESET_MIN - 1000 });
    expect(resetCycle(s, T0)).toBe(0);
  });

  it("resets the tree and the points, and keeps records, rent, collections and the queue", () => {
    const s = lateGame();
    const queue = s.queue;
    const gain = resetCycle(s, T0 + 90 * MIN);
    expect(gain).toBe(2);
    expect(s.standing).toMatchObject({ points: 2, total: 2, resets: 1, cycleEarned: 0, cycleStartedAt: T0 + 90 * MIN });
    expect(s.rp).toBe(0);
    expect(s.rpEarned).toBe(2_000_000);
    expect(s.owned.sort()).toEqual(["collections", "rent", "rentx", "standing"].sort());
    expect(s.levels).toEqual({ rentx: 3 });
    expect(s.queue).toBe(queue);
    expect(s.queue[0].ourId).toBe(4);
    // auto-eval is due nothing in a new cycle; without auto-eval, it is off
    expect(s.autoDue).toBe(0);
    expect(s.settings.auto).toBe(false);
    expect(s.standing.history).toHaveLength(1);
    expect(s.standing.history[0]).toMatchObject({ startedAt: T0, endedAt: T0 + 90 * MIN, earned: 1_000_000, gain: 2 });
    // the history keeps when the cycle reached its milestones
    expect(Object.keys(s.standing.history[0].marks)).toEqual(
      expect.arrayContaining(["click2", "auto1", "basin", "ready"]),
    );
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
    expect(s.standing.points).toBe(1);
    expect(buy(s, "pipeline")).toBe(false);
    expect(s.standing.total).toBe(2);
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
  it("limit the problems, the methods, the seeds and auto-eval for one cycle", () => {
    const s = newGame(T0, 1);
    s.owned.push("auto1", "seeds2", "seeds4");
    expect(ruleAllowsProblem(s.standing, { N: 40, M: 40, P: 100 })).toBe(true);
    s.standing.rule = "circles";
    expect(ruleAllowsProblem(s.standing, { N: 0, M: 40, P: 100 })).toBe(true);
    expect(ruleAllowsProblem(s.standing, { N: 40, M: 0, P: 100 })).toBe(true);
    expect(ruleAllowsProblem(s.standing, { N: 40, M: 40, P: 100 })).toBe(false);
    expect(ruleOpenProblems(s.standing)!.length).toBe(17 * 9 * 2);
    expect(ruleOpenProblems(s.standing)!.every((p) => ruleAllowsProblem(s.standing, p))).toBe(true);
    s.standing.rule = "small";
    expect(ruleAllowsProblem(s.standing, { N: 40, M: 40, P: 60 })).toBe(false);
    expect(ruleAllowsProblem(s.standing, { N: 21, M: 21, P: 40 })).toBe(true);
    expect(ruleOpenProblems(s.standing)!.length).toBeGreaterThan(20);
    expect(ruleOpenProblems(s.standing)!.every((p) => p.N + p.M + p.P <= 120)).toBe(true);
    s.standing.rule = "method";
    expect(ruleAllowsMethod(s.standing, "mc_compress")).toBe(true);
    expect(ruleAllowsMethod(s.standing, "basin_hopping")).toBe(false);
    expect(ruleOpenProblems(s.standing)).toBeNull();
    expect(seedsPerProblem(ownedSet(s))).toBe(4);
    s.standing.rule = "seed";
    expect(seedsPerProblem(ownedSet(s))).toBe(1);
    expect(autoPerSecond(ownedSet(s))).toBe(0.2);
    s.standing.rule = "clicks";
    expect(autoPerSecond(ownedSet(s))).toBeNull();
    s.standing.rule = null;
    expect(ruleAllowsMethod(s.standing, "basin_hopping")).toBe(true);
  });

  it("pay extra standing and a reward of their own, for good, once the cycle is finished under them", () => {
    const s = lateGame(["rules", "seeds4"]);
    s.standing.rule = "clicks";
    s.standing.nextRule = "seed";
    expect(resetPreview(s)).toMatchObject({ gain: 3, ruleBonus: 1 });
    expect(resetCycle(s, T0)).toBe(3);
    expect(s.standing.rulesDone).toEqual(["clicks"]);
    // the next cycle runs under the rule chosen for it
    expect(s.standing.rule).toBe("seed");
    expect(s.standing.nextRule).toBeNull();
    expect(s.standing.history[0].rule).toBe("clicks");
    // clicks only, finished: one more evaluation per click, for good
    expect(evalsPerClick(ownedSet(s))).toBe(2);
    expect(seedsPerProblem(ownedSet(s))).toBe(1);
    // one seed, finished: twice the seeds (after its cycle)
    s.standing.cycleEarned = RESET_MIN;
    s.owned.push("seeds2");
    resetCycle(s, T0 + MIN);
    expect(s.standing.rulesDone).toEqual(["clicks", "seed"]);
    s.owned.push("seeds2");
    expect(seedsPerProblem(ownedSet(s))).toBe(4);
    expect(RULES.map((r) => r.id)).toEqual(["circles", "small", "seed", "clicks", "method"]);
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
