import { describe, expect, it } from "vitest";
import { GameState, addToQueue, buy, newGame, newProblem } from "../src/tighter/game";
import { RESET_MIN, grantHeadStart, resetCycle } from "../src/tighter/standing";
import { UpgradeId, autoPerSecond, headStartGives, owning, upgrade } from "../src/tighter/upgrades";
import { fromJson, readSave, toJson } from "../src/tighter/save";

const T0 = 1_000_000;

/** A mid-cycle game after one reset with 1 standing point, a few cards owned and a record held. */
function midCycle(): GameState {
  const s = newGame(T0, 1);
  const add = (id: UpgradeId) => {
    if (s.owned.includes(id)) return;
    for (const r of upgrade(id).requires) add(r);
    s.owned.push(id);
  };
  add("autox");
  s.levels.autox = (headStartGives(1).levels.autox ?? 1) + 1;
  s.standing.resets = 1;
  s.standing.points = 1;
  s.rp = 5000;
  const p = newProblem({ family: "polygon", N: 24, M: 30, P: 40 }, "open", T0);
  addToQueue(s, p);
  p.ourId = 4;
  return s;
}

describe("Head start now", () => {
  it("gives level 1's cards when bought, keeps higher levels, and costs only the standing point", () => {
    const s = midCycle();
    const above = s.levels.autox!;
    expect(buy(s, "head")).toBe(true);
    expect(s.standing.points).toBe(0);
    const given = grantHeadStart(s, T0 + 1000);
    const g1 = headStartGives(1);
    for (const id of g1.ids) expect(s.owned).toContain(id);
    expect(given.length).toBeGreaterThan(0);
    expect(given).not.toContain("autox");
    expect(s.levels.autox).toBe(above);
    for (const [id, l] of Object.entries(g1.levels) as [UpgradeId, number][])
      expect(s.levels[id]).toBeGreaterThanOrEqual(l);
    expect(s.rp).toBe(5000);
    expect(s.owned).not.toContain("rent");
  });

  it("level 2 brings Rent, and the records held start earning from now without back rent", () => {
    const s = midCycle();
    buy(s, "head");
    grantHeadStart(s, T0 + 1000);
    s.standing.points = 1;
    expect(buy(s, "head")).toBe(true);
    const now = T0 + 5000;
    const given = grantHeadStart(s, now);
    expect(given).toContain("rent");
    expect(s.economy.checks).toEqual({ [s.queue[0].key]: now });
    expect(s.rp).toBe(5000);
  });

  it("is idempotent", () => {
    const s = midCycle();
    buy(s, "head");
    expect(grantHeadStart(s, T0).length).toBeGreaterThan(0);
    const copy = JSON.stringify([s.owned, s.levels]);
    expect(grantHeadStart(s, T0 + 10)).toEqual([]);
    expect(JSON.stringify([s.owned, s.levels])).toBe(copy);
  });

  it("gives nothing without Head start", () => {
    const s = midCycle();
    expect(grantHeadStart(s, T0)).toEqual([]);
  });

  it("keeps the reset behaviour", () => {
    const s = midCycle();
    buy(s, "head");
    grantHeadStart(s, T0);
    for (const id of ["collections", "rent", "ring120"] as UpgradeId[]) if (!s.owned.includes(id)) s.owned.push(id);
    s.standing.resets = 0;
    s.rp = s.standing.cycleEarned = 4 * RESET_MIN;
    expect(resetCycle(s, T0 + 1)).toBeGreaterThan(0);
    for (const id of headStartGives(1).ids) expect(s.owned).toContain(id);
    expect(s.owned).not.toContain("rent");
  });

  it("under Clicks only a grant cannot turn auto-eval on", () => {
    const s = midCycle();
    s.standing.rule = "clicks";
    s.settings.auto = true;
    buy(s, "head");
    const given = grantHeadStart(s, T0);
    expect(s.owned).toContain("auto1");
    expect(given.length).toBeGreaterThan(0);
    expect(s.settings.auto).toBe(false);
    expect(autoPerSecond(owning(s.owned, s.levels, s.standing.rule, s.standing.rulesDone))).toBeNull();
  });

  it("loads a save that owns Head start without its cards with all of them", () => {
    const s = midCycle();
    s.owned.push("head");
    s.levels.head = 1;
    const r = fromJson(toJson(s), T0 + 9000);
    if (!r.ok) throw new Error(r.error);
    for (const id of headStartGives(1).ids) expect(r.state.owned).toContain(id);
    expect(r.state.levels.autox).toBe(s.levels.autox);
    expect(r.headStart).toBeGreaterThan(0);
    // a second load gives nothing more
    const again = fromJson(toJson(r.state), T0 + 9000);
    if (!again.ok) throw new Error(again.error);
    expect(again.headStart).toBeUndefined();
    expect(readSave(JSON.parse(toJson(r.state)), T0).ok).toBe(true);
  });

  it("loads a save without Head start unchanged", () => {
    const s = midCycle();
    const r = fromJson(toJson(s), T0 + 9000);
    if (!r.ok) throw new Error(r.error);
    expect(r.state.owned.slice().sort()).toEqual(s.owned.slice().sort());
    expect(r.headStart).toBeUndefined();
  });
});
