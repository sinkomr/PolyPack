import { describe, expect, it } from "vitest";
import type { LeadersAnswer } from "../src/api";
import { RENT_PAYDAY_MS, RENT_WINDOW_MS, rentPerHour } from "../src/tighter/economy";
import { newGame, ownedSet } from "../src/tighter/game";
import type { GameState, Leader, PastProblem } from "../src/tighter/game";
import { paydayDue, runPayday } from "../src/tighter/payday";
import type { PaydayDeps } from "../src/tighter/payday";

const T0 = 1_000_000_000;
const H = 3_600_000;
const D = 24 * H;

/** A game with Rent and `n` held records in the past list, last settled at `settled`. */
function holder(n: number, settled = T0, rp = 100): GameState {
  const s = newGame(T0, 1);
  s.owned.push("rent");
  for (let i = 0; i < n; i++) {
    const P = 40 + i;
    const key = `21/21/${P}`;
    const p: PastProblem = {
      N: 21,
      M: 21,
      P,
      key,
      tier: "open",
      best: 5,
      verified: 5,
      ourId: 1000 + i,
      rp,
      leftAt: T0,
    };
    s.past.push(p);
    s.economy.checks[key] = settled;
  }
  return s;
}

/** A stubbed GET /api/leaders: the leader of every key is our entry unless `other` names it. */
function server(s: GameState, other: Record<string, Leader | null> = {}, unknown: string[] = []) {
  const calls: string[][] = [];
  let open = 0;
  let overlap = 0;
  const getLeaders = async (keys: string[]): Promise<LeadersAnswer | null> => {
    calls.push(keys);
    overlap = Math.max(overlap, ++open);
    await Promise.resolve();
    open--;
    const leaders: LeadersAnswer["leaders"] = {};
    for (const k of keys) {
      if (unknown.includes(k)) continue;
      const mine = s.past.find((p) => p.key === k)!;
      leaders[k] = k in other ? other[k] : { score: 5, name: "me", id: mine.ourId };
    }
    return { leaders, unknown: keys.filter((k) => unknown.includes(k)) };
  };
  return { calls, getLeaders, overlap: () => overlap };
}

function deps(s: GameState, now: number, getLeaders: PaydayDeps["getLeaders"]): PaydayDeps {
  const lost: string[] = [];
  return {
    state: s,
    owned: ownedSet(s),
    now: () => now,
    getLeaders,
    noteLeader: (p, leader) => {
      // what applyLeader does for a held record
      if (!(leader && leader.id === p.ourId)) {
        if (p.ourId !== null) lost.push(p.key);
        p.ourId = null;
        delete s.economy.checks[p.key];
      }
    },
    busy: () => false,
    active: () => true,
    lost,
  } as PaydayDeps & { lost: string[] };
}

describe("Tighter payday", () => {
  it("asks in sequential batches of at most 200 keys, every held record once", async () => {
    const s = holder(450);
    const srv = server(s);
    const r = await runPayday(deps(s, T0 + D, srv.getLeaders));
    expect(srv.calls.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(new Set(srv.calls.flat()).size).toBe(450);
    expect(srv.overlap()).toBe(1);
    expect(r.paying).toBe(450);
    expect(r.unanswered).toBe(0);
  });

  it("pays 24 times the hourly rate for a day, and a week at most", async () => {
    const s = holder(2);
    const hourly = rentPerHour(s, ownedSet(s), s.past[0]);
    expect(hourly).toBeGreaterThan(0);
    const rp0 = s.rp;
    const r = await runPayday(deps(s, T0 + D, server(s).getLeaders));
    expect(r.paid).toBeCloseTo(2 * 24 * hourly, 9);
    expect(s.rp).toBeCloseTo(rp0 + r.paid, 9);
    expect(s.economy.checks["21/21/40"]).toBe(T0 + D);

    const t = holder(1);
    const r2 = await runPayday(deps(t, T0 + 30 * D, server(t).getLeaders));
    expect(r2.paid).toBeCloseTo((hourly * RENT_WINDOW_MS) / H, 9);
  });

  it("settles every held record at each payday, for the time since its own last settlement", async () => {
    const s = holder(3);
    s.economy.checks["21/21/41"] = T0 + 12 * H;
    const hourly = rentPerHour(s, ownedSet(s), s.past[0]);
    expect(paydayDue(s).map((p) => p.key)).toEqual(["21/21/40", "21/21/41", "21/21/42"]);
    const srv = server(s);
    const r = await runPayday(deps(s, T0 + D, srv.getLeaders));
    expect(srv.calls.flat()).toEqual(["21/21/40", "21/21/41", "21/21/42"]);
    expect(r.paid).toBeCloseTo((24 + 12 + 24) * hourly, 9);
    expect(Object.values(s.economy.checks)).toEqual([T0 + D, T0 + D, T0 + D]);
    // the page reloads a minute later: only that minute is owed, so nothing is paid twice
    const r2 = await runPayday(deps(s, T0 + D + 60_000, server(s).getLeaders));
    expect(r2.paid).toBeCloseTo((3 * hourly) / 60, 9);
  });

  it("pays nothing for a lost record, and hands it to the lost-record path", async () => {
    const s = holder(2);
    const d = deps(s, T0 + D, server(s, { "21/21/40": { score: 4, name: "Bob", id: 9 } }).getLeaders);
    const r = await runPayday(d);
    expect(r.lost).toBe(1);
    expect(r.paying).toBe(1);
    expect((d as unknown as { lost: string[] }).lost).toEqual(["21/21/40"]);
    expect(s.past[0].ourId).toBeNull();
    expect(s.economy.checks["21/21/40"]).toBeUndefined();
    // a record with no leader at all (closed) is lost too
    const t = holder(1);
    const r2 = await runPayday(deps(t, T0 + D, server(t, { "21/21/40": null }).getLeaders));
    expect(r2.lost).toBe(1);
    expect(r2.paid).toBe(0);
  });

  it("leaves an unknown key unsettled for the next payday", async () => {
    const s = holder(2);
    const r = await runPayday(deps(s, T0 + D, server(s, {}, ["21/21/41"]).getLeaders));
    expect(r.unanswered).toBe(1);
    expect(r.paying).toBe(1);
    expect(s.economy.checks["21/21/41"]).toBe(T0);
    // later it is paid for the whole time since, up to the week
    const r2 = await runPayday(deps(s, T0 + 2 * D, server(s).getLeaders));
    expect(r2.paying).toBe(2);
  });

  it("stops at a failed request and leaves every later record unsettled", async () => {
    const s = holder(450);
    let n = 0;
    const getLeaders = async (keys: string[]) => (n++ === 0 ? server(s).getLeaders(keys) : null);
    const r = await runPayday(deps(s, T0 + D, getLeaders));
    expect(n).toBe(2);
    expect(r.paying).toBe(200);
    expect(r.unanswered).toBe(250);
    expect(Object.values(s.economy.checks).filter((at) => at === T0).length).toBe(250);
  });

  it("pays a long backlog once, at the first payday", async () => {
    const s = holder(1, T0 - 200 * D, 1e9);
    const hourly = rentPerHour(s, ownedSet(s), s.past[0]);
    const r = await runPayday(deps(s, T0, server(s).getLeaders));
    expect(r.paid).toBeCloseTo((hourly * RENT_WINDOW_MS) / H, 6);
    const r2 = await runPayday(deps(s, T0 + D - 1, server(s).getLeaders));
    // the backlog is not paid again: the next payday pays only the day since
    expect(r2.paid).toBeCloseTo((hourly * (D - 1)) / H, 6);
    expect(RENT_PAYDAY_MS).toBe(D);
  });
});
