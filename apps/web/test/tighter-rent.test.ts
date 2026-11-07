import { describe, expect, it } from "vitest";
import { areaLowerBound } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import type { SpaceConfig } from "@polypack/spaces";
import { ensureArchive } from "../src/tighter/archive";
import {
  RENT_PAYDAY_MS,
  RENT_WINDOW_MS,
  addBase,
  nextNoon,
  paydayDueAt,
  rentPerHour,
  rentWindowMs,
  rentWaiting,
  settleRent,
  takeBase,
  tidyRent,
} from "../src/tighter/economy";
import {
  PAST_LIMIT,
  StepOutcome,
  addToQueue,
  applyAnswer,
  applyLoadAll,
  applyStep,
  leave,
  markSending,
  newGame,
  newProblem,
  ownedSet,
} from "../src/tighter/game";
import type { GameState, ProblemState } from "../src/tighter/game";
import { fromJson, toJson } from "../src/tighter/save";
import { spaceSubmissionBody } from "../src/tighter/space-submission";
import { CLIENT_TAG, submissionBody } from "../src/tighter/submission";
import type { RunRecord } from "../src/tighter/submission";

const T0 = 1_000_000_000_000;
const H = 3_600_000;
const D = 24 * H;
const B = areaLowerBound(24, 30, 3);

const board = (P: number, shift = 0): PackingConfig => ({
  N: 24,
  M: 30,
  P,
  pieces: Array.from({ length: P }, (_, i) => ({ x: 3 * i + shift, y: 0, theta: 0 })),
  container_phi: 0,
});
const run: RunRecord = { method: "mc_compress", params: { translationStep: 0.15 }, seed: 7, budget: { evals: 30 } };
const step = (score: number, seed = 1): StepOutcome => ({
  evaluations: 1,
  best: board(3, seed),
  score,
  run,
  ms: 2,
  ended: false,
  click: true,
});

function game(): { s: GameState; p: ProblemState } {
  const s = newGame(T0, 1);
  s.name = "Ada";
  s.owned.push("rent");
  s.economy.paidUntil = T0;
  const p = newProblem({ family: "polygon", N: 24, M: 30, P: 3 }, "open", T0);
  addToQueue(s, p);
  applyLoadAll(p, board(3), 1.28 * B, null);
  return { s, p };
}

describe("a record's earnings live on the record", () => {
  it("pay adds to the problem's own base, and taking points back lowers it in proportion", () => {
    const { s, p } = game();
    applyStep(s, p, step(1.2 * B, 1), T0);
    expect(p.base).toBeUndefined();
    const c = applyStep(s, p, step(1.1 * B, 2), T0);
    expect(p.base).toBeCloseTo(c.points!.improvement, 9);
    expect(s.economy).not.toHaveProperty("base");
    // the pure helpers
    const q: { base?: number } = {};
    addBase(q, 0);
    expect(q.base).toBeUndefined();
    addBase(q, 100);
    addBase(q, 50);
    expect(q.base).toBe(150);
    takeBase(q, 25, 100);
    expect(q.base).toBeCloseTo(112.5, 12);
    takeBase(q, 500, 100);
    expect(q.base).toBe(0);
    // the server did not confirm them: everything paid comes back, and the base with it
    markSending(p, 1.2 * B, "Ada", null, T0);
    applyAnswer(s, p, null, 1.2 * B, { kind: "behind", leaderScore: 1.1 * B }, T0);
    expect(p.base).toBeCloseTo(0, 9);
  });

  it("rent reads it, and falls back to the points of a record from before it was kept", () => {
    const { s, p } = game();
    const o = ownedSet(s);
    p.rp = 40;
    expect(rentPerHour(s, o, p)).toBeCloseTo(0.4, 12);
    p.base = 1000;
    expect(rentPerHour(s, o, p)).toBeCloseTo(10, 12);
  });

  it("leave and the archive keep it, and it is cleared when the problem is neither held nor queued", () => {
    const { s, p } = game();
    p.base = 321;
    p.ourId = 5;
    p.heldSince = T0;
    leave(s, p.key, T0 + H);
    expect(s.past[0].base).toBe(321);
    // enough later entries push it into the archive, with its base
    for (let i = 0; i < PAST_LIMIT; i++) {
      const q = newProblem({ family: "polygon", N: 21, M: 21, P: 100 + i }, "open", T0);
      addToQueue(s, q);
      leave(s, q.key, T0 + 2 * H);
    }
    expect(s.past.some((q) => q.key === p.key)).toBe(false);
    expect(ensureArchive(s).get(p.key)).toMatchObject({ base: 321, heldSince: T0, ourId: 5 });

    // a lost entry in the past loses its base at the next tidy; a held one keeps it
    const lost = { ...s.past[0], key: "9/9/9", N: 9, M: 9, P: 9, ourId: null, base: 12 };
    const held = { ...s.past[1], ourId: 3, base: 13 };
    s.past.push(lost, held);
    tidyRent(s, ownedSet(s), T0 + 3 * H);
    expect(lost.base).toBeUndefined();
    expect(held.base).toBe(13);
  });

  it("is saved and read back, on the queue and the past", () => {
    const { s, p } = game();
    p.base = 12.5;
    const r = fromJson(toJson(s), T0);
    expect(r.ok && r.state.queue[0].base).toBe(12.5);
    leave(s, p.key, T0);
    const r2 = fromJson(toJson(s), T0);
    expect(r2.ok && r2.state.past[0].base).toBe(12.5);
  });
});

describe("the payday window", () => {
  it("is the time since the last payday, or since the record was won if that was later, at most a week", () => {
    const payday = T0;
    const now = T0 + D;
    // held all day
    expect(rentWindowMs(T0 - 3 * D, payday, now)).toBe(D);
    expect(rentWindowMs(undefined, payday, now)).toBe(D);
    // won 6 hours ago
    expect(rentWindowMs(now - 6 * H, payday, now)).toBe(6 * H);
    // regained after a loss: counted from the regain, not from before the loss
    expect(rentWindowMs(T0 + 10 * H, payday, now)).toBe(14 * H);
    // a clock that went back, or a record won in the future: nothing
    expect(rentWindowMs(now + H, payday, now)).toBe(0);
    // a week at most
    expect(rentWindowMs(undefined, payday, T0 + 30 * D)).toBe(RENT_WINDOW_MS);
  });

  it("pays a record won at 18:00 only from 18:00, and one regained after a loss from heldSince", () => {
    const day = new Date(2026, 5, 10, 0).getTime();
    const { s, p } = game();
    s.economy.paidUntil = day;
    const o = ownedSet(s);
    p.base = 100;
    p.ourId = 3;
    p.heldSince = day - 5 * D;
    const hourly = rentPerHour(s, o, p);
    const noon = new Date(2026, 5, 10, 12).getTime();
    expect(rentWaiting(s, o, noon)).toBeCloseTo(12 * hourly, 9);
    p.heldSince = new Date(2026, 5, 9, 18).getTime();
    expect(settleRent(s, o, p, new Date(2026, 5, 10, 12).getTime())).toBeCloseTo(12 * hourly, 9);
    // the payday window has not moved: settleRent leaves paidUntil to the payday
    expect(s.economy.paidUntil).toBe(day);
    p.heldSince = new Date(2026, 5, 10, 6).getTime();
    expect(settleRent(s, o, p, noon)).toBeCloseTo(6 * hourly, 9);
  });

  it("counts the archive's rows as held since the last payday", () => {
    const { s } = game();
    const a = ensureArchive(s);
    a.put({
      family: "polygon",
      N: 21,
      M: 21,
      P: 40,
      key: "21/21/40",
      tier: "open",
      best: 5,
      verified: 5,
      ourId: 1,
      base: 100,
      rp: 0,
      leftAt: T0,
    });
    const o = ownedSet(s);
    const hourly = rentPerHour(s, o, a.get("21/21/40")!);
    expect(rentWaiting(s, o, T0 + 5 * H)).toBeCloseTo(5 * hourly, 9);
    expect(rentWaiting(s, o, T0 + 30 * D)).toBeCloseTo((RENT_WINDOW_MS / H) * hourly, 6);
    delete s.economy.paidUntil;
    expect(rentWaiting(s, o, T0 + 5 * H)).toBe(0);
  });
});

describe("payday at noon", () => {
  it("is today's noon before noon, and tomorrow's at or after it", () => {
    const at = (h: number, m = 0, ms = 0) => new Date(2026, 5, 10, h, m, 0, ms).getTime();
    const noon = at(12);
    const tomorrow = new Date(2026, 5, 11, 12).getTime();
    expect(nextNoon(at(0))).toBe(noon);
    expect(nextNoon(at(11, 59, 999))).toBe(noon);
    expect(nextNoon(noon)).toBe(tomorrow);
    expect(nextNoon(at(12, 0, 1))).toBe(tomorrow);
    expect(nextNoon(at(23, 59))).toBe(tomorrow);
  });

  it("is noon local time on every day of a year, including the days the clock changes", () => {
    for (let d = 0; d < 366; d++) {
      const noon = new Date(2026, 0, 1 + d, 12).getTime();
      expect(nextNoon(new Date(2026, 0, 1 + d, 0, 30).getTime())).toBe(noon);
      expect(nextNoon(new Date(2026, 0, 1 + d, 11, 59).getTime())).toBe(noon);
      expect(nextNoon(noon)).toBe(new Date(2026, 0, 2 + d, 12).getTime());
      expect(nextNoon(new Date(2026, 0, 1 + d, 13).getTime())).toBe(new Date(2026, 0, 2 + d, 12).getTime());
      expect(new Date(nextNoon(noon)).getHours()).toBe(12);
    }
  });

  it("clamps a saved time more than a day ahead to the next noon, and keeps a nearer one", () => {
    const now = new Date(2026, 5, 10, 15).getTime();
    expect(paydayDueAt({ ...game().s.economy, paydayAt: now + 10 * D }, now)).toBe(nextNoon(now));
    const sooner = new Date(2026, 5, 11, 12).getTime();
    expect(paydayDueAt({ ...game().s.economy, paydayAt: sooner }, now)).toBe(sooner);
    expect(sooner - now).toBeLessThanOrEqual(RENT_PAYDAY_MS);
  });

  it("is the next noon for Rent just bought, with the window starting now", () => {
    const s = newGame(T0, 1);
    s.owned.push("rent");
    const now = new Date(2026, 5, 10, 15).getTime();
    tidyRent(s, ownedSet(s), now);
    expect(s.economy.paidUntil).toBe(now);
    expect(s.economy.paydayAt).toBe(new Date(2026, 5, 11, 12).getTime());
  });
});

describe("nothing of the game goes to the site", () => {
  it("builds both submission bodies from provenance only", () => {
    const { s, p } = game();
    // a problem with a base, a held time, points and a paid bonus
    applyStep(s, p, step(1.2 * B, 1), T0);
    applyStep(s, p, step(1.1 * B, 2), T0);
    p.ourId = 4;
    p.heldSince = T0;
    s.bonusPaid[p.key] = 0;
    expect(p.base).toBeGreaterThan(0);
    expect(p.rp).toBeGreaterThan(0);
    const body = submissionBody(p.board as PackingConfig, s.name, run);
    expect(Object.keys(body).sort()).toEqual(
      [
        "N",
        "M",
        "P",
        "pieces",
        "container_phi",
        "name",
        "agent_note",
        "found_with",
        "method",
        "method_params",
        "seed",
        "budget",
        "units",
      ].sort(),
    );
    expect(body.agent_note).toBe(CLIENT_TAG);
    expect(JSON.stringify(body)).not.toMatch(/heldSince|"rp"|"base"|rent|bonus/i);

    const cfg: SpaceConfig = { s: 2, pieces: [[0.5, 0, 0]] } as unknown as SpaceConfig;
    const sp = spaceSubmissionBody({ family: "balls", id: "balls/ballinball/2" }, cfg, s.name, run);
    expect(Object.keys(sp).sort()).toEqual(["space", "id", "config", "name", "software", "method", "seed", "units"].sort());
    expect(JSON.stringify(sp)).not.toMatch(/heldSince|"rp"|"base"|rent|bonus/i);
  });
});
