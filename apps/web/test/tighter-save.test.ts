import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import {
  GameState,
  addToQueue,
  applyAnswer,
  applyLoadAll,
  applyStep,
  buy,
  markSending,
  newGame,
  newProblem,
  openedRun,
  pendingPoints,
} from "../src/tighter/game";
import { recordSend } from "../src/tighter/pacer";
import {
  SAVE_VERSION,
  autoPriceRefund,
  exportString,
  fromJson,
  importString,
  migrate,
  normalize,
  readSave,
  toJson,
} from "../src/tighter/save";
import { AUTO_MAX, autoPerSecond, evalsPerClick, owning } from "../src/tighter/upgrades";

const T0 = 1_700_000_000_000;

function loadAll(N: number, M: number, P: number): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
}

/**
 * A game in the middle of Act I: a record paid per click and confirmed, a click paid since and on
 * its way to the server, an upgrade bought, a submission paced, auto-eval due part of a click, a
 * deal made on credit.
 */
function played(): GameState {
  const s = newGame(T0, 1234);
  s.name = "Ada";
  s.consent = true;
  const p = newProblem({ N: 24, M: 30, P: 40 }, "open", T0);
  addToQueue(s, p);
  const b = loadAll(24, 30, 40);
  applyLoadAll(p, b, 7, null);
  openedRun(s, p, 1, T0 + 500);
  // strict "results": the Load-all board shifted, with smaller made-up scores (the save does not judge)
  const best = { ...b, pieces: b.pieces.map((q) => ({ ...q, x: q.x + 0.1 })), container_phi: 0.3 };
  const record = (evals: number) => ({
    method: "mc_compress",
    params: { shrinkFraction: 0.01, sweepsPerEvaluation: 5 },
    seed: 1,
    budget: { evals },
  });
  applyStep(
    s,
    p,
    { evaluations: 100, best, score: 6.5, run: record(101), ms: 1234.4, ended: false, click: true },
    T0 + 1000,
  );
  markSending(p, 6.5, "Ada", null, T0 + 1500);
  applyAnswer(s, p, null, 6.5, { kind: "leader", score: 6.5, id: 3, pending: false }, T0 + 2000);
  const best2 = { ...best, pieces: best.pieces.map((q) => ({ ...q, y: q.y + 1 / 3 })), container_phi: 0.25 };
  applyStep(
    s,
    p,
    { evaluations: 1, best: best2, score: 6.4 + 1e-13, run: record(102), ms: 3, ended: false, click: true },
    T0 + 3000,
  );
  markSending(p, 6.4 + 1e-13, "Ada", p.leader, T0 + 3500);
  buy(s, "trace");
  // a levelled upgrade at level 2, standing, a record remembered, an arm of each bandit, a retake
  s.owned.push("click10", "clickx", "standing");
  s.levels.clickx = 2;
  s.standing = { ...s.standing, points: 3, total: 5, resets: 1, cycleEarned: 1234.5, rule: "circles" };
  s.economy.recorded.push("21/21/40");
  s.economy.rentPaid = 12.5;
  s.picks.bandit.open = { n: 3, mean: 0.25, m2: 0.01 };
  s.picks.retake.push("21/21/40");
  s.runplan.bandit["open|mc_compress"] = { n: 1, mean: 2, m2: 0 };
  s.pacer = recordSend(s.pacer, p.key, T0 + 3500);
  s.autoDue = 12.75;
  s.autoAt = T0 + 4000;
  s.dealer.tokens = -0.5;
  s.dealer.credit = 12.5;
  s.reveal.push("score", "points");
  s.log.push({ t: T0, text: "New record 6.500000" });
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
  return s;
}

describe("Tighter saves", () => {
  it("round-trip through JSON with every value kept to the last bit", () => {
    const s = played();
    const r = fromJson(toJson(s), T0 + 5000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // all but auto-eval's pace, which runs live: a loaded game is due nothing from before
    expect(r.state).toEqual({ ...s, autoDue: 0, autoAt: T0 + 5000 });
    // full precision of the pieces, the scores and the points
    const [a, b] = [r.state.queue[0], s.queue[0]];
    expect(a.board!.pieces[7].y).toBe(b.board!.pieces[7].y);
    expect(a.best).toBe(6.4 + 1e-13);
    expect(a.paidTo).toBe(6.4 + 1e-13);
    expect(a.sending!.rp).toBe(b.sending!.rp);
    expect(a.sending!.rp).toBeGreaterThan(0);
    expect(r.state.rp).toBe(s.rp);
    // the trace is pairs of (evaluations run here, side)
    expect(a.trace).toEqual([
      [100, 6.5],
      [101, 6.4 + 1e-13],
    ]);
    expect(a).toMatchObject({ evaluations: 101, sinceGain: 0, runs: 1, endedRuns: 0, nextSeed: 2, unconfirmed: 0 });
    expect(r.state).toMatchObject({ version: 3 });
    expect(r.state.stats).toMatchObject({ evaluations: 101, clicks: 2, runs: 1, computeMs: 1237 });
    // a deal made on credit stays in debt
    expect(r.state.dealer).toMatchObject({ tokens: -0.5, credit: 12.5, seed: 1234 });
    expect(r.state.levels).toEqual({ clickx: 2 });
  });

  it("give back the price of the Away upgrades and Keep the bank, once, now that auto-eval runs live", () => {
    const s = played();
    const raw = JSON.parse(toJson(s));
    raw.owned = [...raw.owned, "away2", "away3", "standing", "keepBank", "away2"];
    raw.rp = 100;
    raw.bank = 5000;
    raw.bankAt = T0 - 3_600_000;
    const r = readSave(raw, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.owned).toEqual(s.owned);
    expect(r.state.rp).toBe(100 + 1200 + 12000);
    expect(r.state.standing.points).toBe(s.standing.points + 2);
    expect(r.state.autoDue).toBe(0);
    // the next save owns them no more, so a reload gives nothing back again
    const again = readSave(JSON.parse(toJson(r.state)), T0);
    expect(again.ok && again.state.rp).toBe(100 + 1200 + 12000);
    expect(again.ok && again.state.standing.points).toBe(s.standing.points + 2);
  });

  it("keep levels only for owned levelled upgrades, within their range", () => {
    const s = played();
    const raw = JSON.parse(toJson(s));
    raw.levels = { clickx: 5000, trace: 3, lanesx: 2, nope: 1, study: 0 };
    const r = readSave(raw, T0);
    expect(r.ok && r.state.levels).toEqual({ clickx: 990 });
    raw.standing = "x";
    raw.economy = { recorded: ["1/2/3", "bad", 4], rentPaid: -1 };
    const t = readSave(raw, T0);
    expect(t.ok && t.state.standing).toMatchObject({ points: 0, total: 0, resets: 0 });
    expect(t.ok && t.state.economy).toMatchObject({ recorded: ["1/2/3"], rentPaid: 0, checks: {}, lastRent: null });
  });

  const rungs = ["auto1", "auto2", "auto3", "auto4", "auto5", "auto6", "auto7", "auto8", "auto9"];
  /** The game a save document loads as. */
  const load = (raw: unknown): GameState => {
    const r = readSave(raw, T0);
    if (!r.ok) throw new Error(r.error);
    return r.state;
  };

  it("read a save from an earlier ladder: each rung at its new rate", () => {
    const s = played();
    const raw = JSON.parse(toJson(s));
    // auto5 ran 15 evaluations a second in each lane, then 5 in all: it now runs 10 in all
    raw.owned = ["trace", "click10", ...rungs.slice(0, 5), "queue3", "lanes2"];
    raw.levels = {};
    const t = load(raw);
    expect(t.owned).toEqual(raw.owned);
    expect(autoPerSecond(owning(t.owned))).toBe(10);
    // the ids are kept, so nothing is refunded
    expect(t.rp).toBe(s.rp);
    const rates = [1, 2, 3, 5, 10, 20, 35, 60, 100];
    for (let i = 1; i <= rungs.length; i++) expect(autoPerSecond(owning(rungs.slice(0, i)))).toBe(rates[i - 1]);
  });

  it("read a save with Faster auto-eval's old levels: auto10 given, the levels kept at 10 evaluations a second each", () => {
    const s = played();
    const raw = JSON.parse(toJson(s));
    // the last era: 3 levels of × 1.3 on 120 a second in each lane, after auto9
    raw.owned = ["trace", "click10", "clickx", ...rungs, "autox"];
    raw.levels = { clickx: 30, autox: 3 };
    raw.autoDue = 4321.5;
    const r = readSave(raw, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Faster auto-eval comes after auto10 now: the save is given it, just before
    expect(r.state.owned).toEqual(["trace", "click10", "clickx", ...rungs, "auto10", "autox"]);
    expect(r.state.levels).toEqual({ clickx: 30, autox: 3 });
    const o = owning(r.state.owned, r.state.levels);
    expect(evalsPerClick(o)).toBe(40);
    // 150 a second of auto10 and 10 more a level: 180
    expect(autoPerSecond(o)).toBe(180);
    // nothing due from before the load, whatever unit it was counted in
    expect(r.state.autoDue).toBe(0);
    expect(r.state.autoAt).toBe(T0);
    // within the new range of 10 levels: nothing refunded, now or at the next load
    expect(r.state.rp).toBe(s.rp);
    const again = readSave(JSON.parse(toJson(r.state)), T0);
    expect(again.ok && again.state.owned).toEqual(r.state.owned);
    expect(again.ok && again.state.levels).toEqual({ clickx: 30, autox: 3 });
    expect(again.ok && again.state.rp).toBe(s.rp);
  });

  it("refund Faster auto-eval's levels past its 10, once, at the price they were bought at", () => {
    const s = played();
    const raw = JSON.parse(toJson(s));
    // a save from when auto-eval's rate was in clicks and Faster auto-eval had 100 levels
    raw.owned = ["trace", "click10", ...rungs, "autox"];
    raw.levels = { autox: 14 };
    const r = readSave(raw, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.levels).toEqual({ autox: 10 });
    expect(autoPerSecond(owning(r.state.owned, r.state.levels))).toBe(AUTO_MAX);
    // levels 11 to 14 at their list price then, 150,000 RP × 1.4 a level, not at today's price
    let refund = 0;
    for (let j = 10; j < 14; j++) refund += Math.round(150000 * 1.4 ** j);
    expect(r.state.rp).toBe(s.rp + refund);
    const again = readSave(JSON.parse(toJson(r.state)), T0);
    expect(again.ok && again.state.rp).toBe(s.rp + refund);
    // a save that kept 3 levels (and had the rest refunded when the maximum was 3) gets nothing more
    raw.levels = { autox: 3 };
    expect(load(raw).rp).toBe(s.rp);
  });

  it("read the dealer of a save that counted evaluations: what ran since its last refill, as the clicks it was", () => {
    const s = played();
    const raw = JSON.parse(toJson(s));
    // 600 evaluations since the last refill, at 4 evaluations a click: 150 clicks
    raw.owned = ["trace", "click2", "click3", "click4"];
    raw.stats.evaluations = 1000;
    raw.dealer = { seed: 5, draws: 2, dealt: 1, tokens: 0.25, evalsAt: 400 };
    const s1 = load(raw);
    expect(s1.dealer).toEqual({ seed: 5, draws: 2, dealt: 1, tokens: 0.25, credit: 150 });
    // the next save has no evaluations count: its credit is kept, and nothing is counted twice
    expect(load(JSON.parse(toJson(s1))).dealer).toEqual(s1.dealer);
    // a count past the evaluations run gives nothing, nor does a credit below zero
    raw.dealer.evalsAt = 5000;
    expect(load(raw).dealer.credit).toBe(0);
    raw.dealer = { seed: 5, tokens: 0, credit: -3 };
    expect(load(raw).dealer.credit).toBe(0);
  });

  it("round-trip through an export string", async () => {
    const s = played();
    const text = await exportString(s);
    expect(text).toMatch(/^tighter:3:[zj]:[A-Za-z0-9_-]+$/);
    const r = await importString(text, T0 + 5000);
    expect(r.ok && r.state).toEqual({ ...s, autoDue: 0, autoAt: T0 + 5000 });
    // whitespace from a copy and paste is ignored
    const wrapped = text.replace(/(.{60})/g, "$1\n  ");
    expect((await importString(wrapped, T0)).ok).toBe(true);
  });

  it("refuse damaged and foreign save strings", async () => {
    expect((await importString("hello", T0)).ok).toBe(false);
    expect((await importString("tighter:1:z:AAAA", T0)).ok).toBe(false);
    const r = await importString(`tighter:1:j:${btoa('{"version":1').replace(/=+$/, "")}`, T0);
    expect(r).toEqual({ ok: false, error: "the save is not valid JSON" });
  });

  it("refuse a save from a newer version, and anything that is not a save", () => {
    expect(readSave({ ...JSON.parse(toJson(played())), version: SAVE_VERSION + 1 }, T0)).toEqual({
      ok: false,
      error: `this save is from a newer version of Tighter (save format ${SAVE_VERSION + 1})`,
    });
    expect(readSave([], T0).ok).toBe(false);
    expect(readSave({ rp: 5 }, T0).ok).toBe(false);
  });

  it("run migrations step by step up to the current format", () => {
    // a hypothetical format history: 1 kept points as `points`, 2 renamed them `rp`
    const migrations = {
      1: (s: Record<string, unknown>) => {
        const { points, ...rest } = s;
        return { ...rest, rp: points };
      },
      2: (s: Record<string, unknown>) => ({ ...s, reveal: ["score"] }),
    };
    const m = migrate({ version: 1, points: 12 }, migrations, 3);
    expect(m).toEqual({ ok: true, save: { version: 3, rp: 12, reveal: ["score"] } });
    expect(migrate({ version: 2 }, {}, 3)).toEqual({ ok: false, error: "no way to read save format 2" });
    expect(migrate({ version: 0 }, migrations, 3).ok).toBe(false);
  });

  it("fill missing fields with defaults and drop what cannot be read", () => {
    const raw = JSON.parse(toJson(played()));
    delete raw.settings;
    delete raw.stats;
    raw.owned.push("warp-drive", "trace");
    raw.rp = -5;
    raw.consent = true;
    raw.name = "";
    raw.queue[0].board.pieces[0].x = "oops";
    raw.queue.push({ key: "not a problem" }, raw.queue[0]);
    raw.autoDue = 1e6;
    raw.dealer.tokens = "many";
    const s = normalize(raw, T0);
    expect(s.owned).toEqual(["trace", "click10", "clickx", "standing"]);
    expect(s.rp).toBe(0);
    // no consent without a name
    expect(s.consent).toBe(false);
    expect(s.settings).toEqual({
      auto: false,
      method: "mc_compress",
      background: false,
      battery: false,
      tolerance: 1e-6,
      patience: 1000,
    });
    expect(s.stats).toEqual({
      evaluations: 0,
      clicks: 0,
      runs: 0,
      computeMs: 0,
      submissions: 0,
      firstRecords: 0,
      verifiedImprovements: 0,
    });
    // auto-eval is due nothing from a save, and the dealer keeps its work not yet turned into deals
    expect(s.autoDue).toBe(0);
    expect(s.autoAt).toBe(T0);
    expect(s.dealer).toMatchObject({ tokens: 1, credit: 12.5, seed: 1234 });
    // an unreadable board takes its problem back to the start; duplicates and junk are dropped
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0]).toMatchObject({
      key: "24/30/40",
      phase: "bare",
      board: null,
      best: null,
      ourId: 3,
      paidTo: null,
      trace: [],
    });
    expect(s.focus).toBe("24/30/40");
  });

  it("keep a chosen method only while it is owned", () => {
    const raw = JSON.parse(toJson(played()));
    raw.settings.method = "basin_hopping";
    expect(normalize(raw, T0 + 5000).settings.method).toBe("mc_compress");
    raw.owned.push("basin");
    expect(normalize(raw, T0 + 5000).settings.method).toBe("basin_hopping");
    raw.settings.method = "warp";
    expect(normalize(raw, T0 + 5000).settings.method).toBe("mc_compress");
    // a trace of anything but (evaluations, side) pairs is dropped point by point
    raw.queue[0].trace = [[1, 6.5], 6.4, [2, -1], [-1, 6], [3, 6.3]];
    expect(normalize(raw, T0 + 5000).queue[0].trace).toEqual([
      [1, 6.5],
      [3, 6.3],
    ]);
  });

  it("keep Auto-advance's tolerance and patience when they are among the choices, Never included", () => {
    const raw = JSON.parse(toJson(played()));
    raw.settings.tolerance = 1e-4;
    raw.settings.patience = null;
    expect(normalize(raw, T0).settings).toMatchObject({ tolerance: 1e-4, patience: null });
    // Never survives a save (JSON keeps null)
    const r = fromJson(toJson(normalize(raw, T0)), T0);
    expect(r.ok && r.state.settings.patience).toBeNull();
    raw.settings.tolerance = 0.5;
    raw.settings.patience = 1234;
    expect(normalize(raw, T0).settings).toMatchObject({ tolerance: 1e-6, patience: 1000 });
    raw.settings.tolerance = "1e-3";
    raw.settings.patience = "never";
    expect(normalize(raw, T0).settings).toMatchObject({ tolerance: 1e-6, patience: 1000 });
    // a save from before Auto-advance's settings takes the defaults
    delete raw.settings.tolerance;
    delete raw.settings.patience;
    expect(normalize(raw, T0).settings).toMatchObject({ tolerance: 1e-6, patience: 1000 });
  });

  it("keep each problem's counters, and its best at the last progress or else its best", () => {
    const raw = JSON.parse(toJson(played()));
    raw.queue[0].evaluations = 12345;
    raw.queue[0].sinceGain = 830;
    expect(normalize(raw, T0).queue[0]).toMatchObject({ evaluations: 12345, sinceGain: 830 });
    // a save from before progress was measured starts from the best
    delete raw.queue[0].progressBest;
    expect(normalize(raw, T0).queue[0].progressBest).toBe(6.4 + 1e-13);
    raw.queue[0].progressBest = 6.5;
    expect(normalize(raw, T0).queue[0].progressBest).toBe(6.5);
    // never below the best, and nothing before the first record
    raw.queue[0].progressBest = 6;
    expect(normalize(raw, T0).queue[0].progressBest).toBe(6.4 + 1e-13);
    raw.queue[0].evaluations = -3;
    raw.queue[0].sinceGain = 1.5;
    raw.queue[0].phase = "bare";
    expect(normalize(raw, T0).queue[0]).toMatchObject({ evaluations: 0, sinceGain: 0, progressBest: null });
  });

  it("refuse a board that belongs to another problem", () => {
    const raw = JSON.parse(toJson(played()));
    raw.queue[0].board.P = 41;
    expect(normalize(raw, T0).queue[0].phase).toBe("bare");
  });
});

describe("Tighter saves of version 1", () => {
  /** A version 1 save, as the MVP wrote it: whole runs per click, points paid on the server's answer. */
  function v1(): Record<string, unknown> {
    const b = loadAll(24, 30, 40);
    return {
      version: 1,
      createdAt: T0,
      rp: 40,
      rpEarned: 100,
      owned: ["trace", "evals1", "queue3", "auto1", "seeds", "evals2", "warp-drive"],
      name: "Ada",
      consent: true,
      settings: { auto: true, method: "mc_compress", background: false, battery: true },
      stats: { evaluations: 900, runs: 12, computeMs: 5000, submissions: 3, firstRecords: 1, verifiedImprovements: 3 },
      dealer: { seed: 9, draws: 4, dealt: 2, tokens: 0.4, updatedAt: T0 },
      pacer: { sent: [T0], lastByProblem: { "24/30/40": T0 }, pausedUntil: 0 },
      queue: [
        {
          N: 24,
          M: 30,
          P: 40,
          key: "24/30/40",
          tier: "open",
          dealtAt: T0,
          floor: 7,
          phase: "ready",
          board: b,
          best: 6.4,
          run: { method: "mc_compress", params: {}, seed: 3, budget: { evals: 60 } },
          nextSeed: 4,
          leader: { score: 6.5, name: "Ada", id: 3 },
          verified: 6.5,
          ourId: 3,
          beatPaid: false,
          closed: false,
          refused: null,
          leaving: false,
          sending: { score: 6.4, name: "Ada", leaderBefore: { score: 6.5, name: "Ada", id: 3 }, at: T0 },
          trace: [6.9, 6.5, "x", 6.4],
          deadRuns: 2,
          runs: 12,
          lastRunAt: T0,
          rp: 30,
        },
        {
          N: 21,
          M: 21,
          P: 40,
          key: "21/21/40",
          tier: "open",
          dealtAt: T0,
          floor: 9,
          phase: "ready",
          board: { ...loadAll(21, 21, 40) },
          best: 8.5,
          run: { method: "mc_compress", params: {}, seed: 1, budget: { evals: 100 } },
          nextSeed: 2,
          leader: null,
          verified: null,
          ourId: null,
          beatPaid: false,
          closed: false,
          refused: null,
          leaving: false,
          sending: null,
          trace: [8.5],
          deadRuns: 0,
          runs: 1,
          lastRunAt: T0,
          rp: 0,
        },
      ],
      focus: "24/30/40",
      past: [],
      reveal: ["score", "points"],
      log: [],
    };
  }

  it("migrate to version 2: what was verified counts as paid, Longer runs become evaluations per click", () => {
    const r = readSave(v1(), T0 + 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.state;
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.owned).toEqual(["trace", "click2", "queue3", "auto1", "seeds", "click3"]);
    // and on through version 3, which pays back what Auto-eval cost over its price now: 90 - 9 RP
    expect(r.refunded).toBe(81);
    expect(s).toMatchObject({ rp: 40 + 81, rpEarned: 100, autoDue: 0, consent: true });
    expect(s.stats).toMatchObject({ evaluations: 900, runs: 12, clicks: 12 });
    // the dealer counts its work from the evaluations already run: none is owed from before
    expect(s.dealer).toMatchObject({ seed: 9, draws: 4, dealt: 2, tokens: 0.4, credit: 0 });
    const [p, q] = s.queue;
    expect(p).toMatchObject({
      paidTo: 6.5,
      unconfirmed: 0,
      sinceGain: 60,
      evaluations: 360,
      runs: 12,
      endedRuns: 0,
      nextSeed: 4,
      best: 6.4,
      verified: 6.5,
    });
    expect(p.trace).toEqual([
      [0, 6.9],
      [30, 6.5],
      [60, 6.4],
    ]);
    // a send on its way carried no points in version 1
    expect(p.sending).toEqual({
      score: 6.4,
      name: "Ada",
      leaderBefore: { score: 6.5, name: "Ada", id: 3 },
      at: T0,
      rp: 0,
    });
    // the next payment is measured from the verified 6.5
    expect(pendingPoints(p, s.name)!.delta).toBeCloseTo(1 - 6.4 / 6.5, 12);
    // a record never sent pays from its floor, as the first record it is
    expect(q.paidTo).toBeNull();
    const first = pendingPoints(q, s.name)!;
    expect(first.delta).toBeCloseTo(1 - 8.5 / 9, 12);
  });

  it("migrate through a save string too", async () => {
    const text = `tighter:1:j:${btoa(JSON.stringify(v1())).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const r = await importString(text, T0 + 1000);
    expect(r.ok && r.state.owned).toEqual(["trace", "click2", "queue3", "auto1", "seeds", "click3"]);
  });
});

describe("Tighter saves of version 2", () => {
  const rungs: UpgradeId[] = [
    "auto1",
    "auto2",
    "auto3",
    "auto4",
    "auto5",
    "auto6",
    "auto7",
    "auto8",
    "auto9",
    "auto10",
  ];
  const clicks: UpgradeId[] = [
    "trace",
    "click2",
    "click3",
    "click4",
    "click5",
    "click6",
    "click7",
    "click8",
    "click9",
    "click10",
  ];
  /** A save as version 2 wrote it, owning these upgrades at these levels. */
  const v2 = (owned: string[], levels: Record<string, number> = {}) => ({
    ...JSON.parse(toJson(played())),
    version: 2,
    owned,
    levels,
  });

  it("pay back, once, what each Auto-eval rung and Faster auto-eval level cost over its price now", () => {
    const s = played();
    const r = readSave(v2([...clicks, ...rungs, "autox"], { autox: 3 }), T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the rungs at 90 % of what they cost (a tenth is today's price): 0.9 × 107,590
    const ladder = 0.9 * (90 + 350 + 800 + 1350 + 2500 + 4500 + 9000 + 16000 + 28000 + 45000);
    expect(ladder).toBeCloseTo(96_831, 6);
    // Faster auto-eval's three levels: 100,000, 160,000 and 256,000 then, 10,000, 16,000 and 25,600 now
    const faster = 90_000 + 144_000 + 230_400;
    expect(r.refunded).toBe(96_831 + faster);
    expect(r.state.rp).toBe(s.rp + 96_831 + faster);
    expect(r.state.version).toBe(SAVE_VERSION);
    expect(r.state.levels).toEqual({ autox: 3 });
    expect("autoRefund" in r.state).toBe(false);
    // the save it writes is of version 3: read again, it gets nothing more
    const again = readSave(JSON.parse(toJson(r.state)), T0);
    expect(again.ok && again.state.rp).toBe(r.state.rp);
    expect(again.ok && again.refunded).toBeUndefined();
    // and a game begun on version 3 gets nothing at all
    expect(readSave(JSON.parse(toJson(s)), T0)).toEqual({ ok: true, state: { ...s, autoDue: 0, autoAt: T0 } });
  });

  it("never pay back more than a level cost: the lower of its two old price lists", () => {
    // levels 1 to 4 cost less from 2026-10-21 (100,000 × 1.6 a level): 90 % of that comes back
    const at = (levels: number) => autoPriceRefund(["autox"], { autox: levels });
    expect(at(3)).toBe(90_000 + 144_000 + 230_400);
    expect(at(4)).toBe(at(3) + 368_640);
    // level 5 cost 655,360 then but 576,240 before (150,000 × 1.4^4): 576,240 - 65,536 back, not 589,824
    expect(at(5)).toBe(at(4) + 510_704);
    // a save from when Faster auto-eval had 100 levels: its 10 kept are paid back here, the 4 past them
    // whole (SHRUNK), at the 1.4 a level they cost then
    const s = played();
    const r = readSave(v2([...clicks, ...rungs.slice(0, 9), "autox"], { autox: 14 }), T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let kept = 0;
    for (let j = 0; j < 10; j++)
      kept += Math.max(0, Math.min(100_000 * 1.6 ** j, 150_000 * 1.4 ** j) - 10_000 * 1.6 ** j);
    let past = 0;
    for (let j = 10; j < 14; j++) past += Math.round(150_000 * 1.4 ** j);
    const rungsBack = 0.9 * (90 + 350 + 800 + 1350 + 2500 + 4500 + 9000 + 16000 + 28000);
    expect(r.refunded).toBe(Math.round(rungsBack + kept));
    expect(r.state.rp).toBe(s.rp + Math.round(rungsBack + kept) + past);
    // auto10, given to a save with Faster auto-eval from before it, was never paid for
    expect(r.state.owned).toContain("auto10");
    expect(r.state.levels).toEqual({ autox: 10 });
  });

  it("pay nothing back for the rungs a head start gives each cycle, and pay at the Quick study discount", () => {
    const standing: UpgradeId[] = ["standing", "head1", "head2"];
    // Head start I and II give Auto-eval up to 10 a second (auto1 to auto5): only auto6 and auto7 were paid for
    const r = readSave(v2([...clicks, ...rungs.slice(0, 7), ...standing]), T0);
    expect(r.ok && r.refunded).toBe(4050 + 8100);
    // two levels of Quick study: everything was 19 % cheaper, and so is what comes back
    const study = autoPriceRefund(["auto1", "auto2", "auto3", "standing", "study"], { study: 2 });
    expect(study).toBe(Math.round((81 + 315 + 720) * 0.81));
    // a save of version 2 without auto-eval gets nothing, and says so
    const none = readSave(v2(["trace", "click2"]), T0);
    expect(none.ok && none.refunded).toBeUndefined();
    expect(none.ok && none.state.rp).toBe(played().rp);
  });
});
