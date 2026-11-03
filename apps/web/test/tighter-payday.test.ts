import { describe, expect, it } from "vitest";
import type { LeadersAnswer } from "../src/api";
import {
  RENT_PAYDAY_MS,
  RENT_RETRY_MS,
  RENT_WINDOW_MS,
  nextNoon,
  nextPaydayAfter,
  newEconomy,
  paydayDueAt,
  tidyRent,
  rentPerHour,
} from "../src/tighter/economy";
import { newGame, ownedSet } from "../src/tighter/game";
import type { GameState, Leader, PastProblem } from "../src/tighter/game";
import { paydayDue, runPayday } from "../src/tighter/payday";
import type { PaydayDeps } from "../src/tighter/payday";

const T0 = 1_000_000_000;
const H = 3_600_000;
const D = 24 * H;

/** A game with Rent and `n` held records in the past list, the last payday at `paidUntil`. */
function holder(n: number, paidUntil = T0, rp = 100): GameState {
  const s = newGame(T0, 1);
  s.owned.push("rent");
  s.economy.paidUntil = paidUntil;
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
    expect(s.economy.paidUntil).toBe(T0 + D);

    const t = holder(1);
    const r2 = await runPayday(deps(t, T0 + 30 * D, server(t).getLeaders));
    expect(r2.paid).toBeCloseTo((hourly * RENT_WINDOW_MS) / H, 9);
  });

  it("pays each record for its own window: since the payday, or since it was won if that was later", async () => {
    const s = holder(3);
    s.past[1].heldSince = T0 + 12 * H;
    const hourly = rentPerHour(s, ownedSet(s), s.past[0]);
    expect(paydayDue(s).map((p) => p.key)).toEqual(["21/21/40", "21/21/41", "21/21/42"]);
    const srv = server(s);
    const r = await runPayday(deps(s, T0 + D, srv.getLeaders));
    expect(srv.calls.flat()).toEqual(["21/21/40", "21/21/41", "21/21/42"]);
    expect(r.paid).toBeCloseTo((24 + 12 + 24) * hourly, 9);
    expect(s.economy.paidUntil).toBe(T0 + D);
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
    // a record with no leader at all (closed) is lost too
    const t = holder(1);
    const r2 = await runPayday(deps(t, T0 + D, server(t, { "21/21/40": null }).getLeaders));
    expect(r2.lost).toBe(1);
    expect(r2.paid).toBe(0);
  });

  it("counts an unknown key as held, and pays it", async () => {
    const s = holder(2);
    const r = await runPayday(deps(s, T0 + D, server(s, {}, ["21/21/41"]).getLeaders));
    expect(r.unanswered).toBe(0);
    expect(r.lost).toBe(0);
    expect(r.paying).toBe(2);
    expect(s.economy.paidUntil).toBe(T0 + D);
  });

  it("counts a busy record as held without looking at its answer", async () => {
    const s = holder(2);
    const d = deps(s, T0 + D, server(s, { "21/21/41": { score: 4, name: "Bob", id: 9 } }).getLeaders);
    d.busy = (p) => p.key === "21/21/41";
    const r = await runPayday(d);
    expect(r.lost).toBe(0);
    expect(r.paying).toBe(2);
    expect(s.past[1].ourId).not.toBeNull();
  });

  it("is all or nothing: a failed request pays nothing, keeps the losses already answered and keeps the window", async () => {
    const s = holder(450);
    const rp0 = s.rp;
    let n = 0;
    const base = server(s, { "21/21/40": { score: 4, name: "Bob", id: 9 } });
    const getLeaders = async (keys: string[]) => (n++ === 0 ? base.getLeaders(keys) : null);
    const d = deps(s, T0 + D, getLeaders);
    const r = await runPayday(d);
    expect(n).toBe(2);
    expect(r.paying).toBe(0);
    expect(r.paid).toBe(0);
    expect(r.lost).toBe(1);
    expect(r.unanswered).toBe(250);
    expect(s.rp).toBe(rp0);
    expect(s.past[0].ourId).toBeNull();
    expect(s.economy.paidUntil).toBe(T0);
    expect(nextPaydayAfter(T0 + D, r.unanswered)).toBe(T0 + D + RENT_RETRY_MS);
    // the retry pays the whole window, from the old payday
    const hourly = rentPerHour(s, ownedSet(s), s.past[1]);
    const r2 = await runPayday(deps(s, T0 + D + RENT_RETRY_MS, server(s).getLeaders));
    expect(r2.paying).toBe(449);
    expect(r2.paid).toBeCloseTo(449 * hourly * (24 + 1 / 6), 6);
    expect(s.economy.paidUntil).toBe(T0 + D + RENT_RETRY_MS);
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

describe("the saved payday time", () => {
  const T = 1_000_000_000_000;
  it("is due at once without a saved time, not before it, and after it", () => {
    const e = newEconomy();
    expect(paydayDueAt(e, T)).toBe(0);
    e.paydayAt = T + 1000;
    expect(paydayDueAt(e, T)).toBeGreaterThan(T);
    expect(paydayDueAt(e, T + 1000)).toBeLessThanOrEqual(T + 1000);
    expect(paydayDueAt(e, T + 5000)).toBeLessThanOrEqual(T + 5000);
  });
  it("clamps a time more than a day away to the next noon", () => {
    const e = newEconomy();
    e.paydayAt = T + 5 * RENT_PAYDAY_MS;
    expect(paydayDueAt(e, T)).toBe(nextNoon(T));
    e.paydayAt = T + RENT_PAYDAY_MS;
    expect(paydayDueAt(e, T)).toBe(T + RENT_PAYDAY_MS);
  });
  it("is the next noon after a payday, or the retry time when records were unanswered", () => {
    expect(nextPaydayAfter(T, 0)).toBe(nextNoon(T));
    expect(nextPaydayAfter(T, 3)).toBe(T + RENT_RETRY_MS);
  });
  it("starts the first payday at the next noon when Rent is bought, only once", () => {
    const s = newGame(T, 1);
    s.owned.push("rent");
    tidyRent(s, ownedSet(s), T);
    expect(s.economy.paydayAt).toBe(nextNoon(T));
    expect(s.economy.paidUntil).toBe(T);
    tidyRent(s, ownedSet(s), T + 1000);
    expect(s.economy.paydayAt).toBe(nextNoon(T));
    expect(s.economy.paidUntil).toBe(T);
  });
});
