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
  exportString,
  fromJson,
  importString,
  migrate,
  normalize,
  readSave,
  toJson,
} from "../src/tighter/save";

const T0 = 1_700_000_000_000;

function loadAll(N: number, M: number, P: number): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
}

/**
 * A game in the middle of Act I: a record paid per click and confirmed, a click paid since and on
 * its way to the server, an upgrade bought, a submission paced, auto-eval's bank part full, a deal
 * made on credit.
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
  s.pacer = recordSend(s.pacer, p.key, T0 + 3500);
  s.bank = 12.75;
  s.bankAt = T0 + 4000;
  s.dealer.tokens = -0.5;
  s.dealer.evalsAt = 50;
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
    expect(r.state).toEqual(s);
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
    expect(r.state).toMatchObject({ version: 2, bank: 12.75, bankAt: T0 + 4000 });
    expect(r.state.stats).toMatchObject({ evaluations: 101, clicks: 2, runs: 1, computeMs: 1237 });
    // a deal made on credit stays in debt
    expect(r.state.dealer).toMatchObject({ tokens: -0.5, evalsAt: 50, seed: 1234 });
  });

  it("round-trip through an export string", async () => {
    const s = played();
    const text = await exportString(s);
    expect(text).toMatch(/^tighter:2:[zj]:[A-Za-z0-9_-]+$/);
    const r = await importString(text, T0 + 5000);
    expect(r.ok && r.state).toEqual(s);
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
    delete raw.bank;
    raw.dealer.tokens = "many";
    const s = normalize(raw, T0);
    expect(s.owned).toEqual(["trace"]);
    expect(s.rp).toBe(0);
    // no consent without a name
    expect(s.consent).toBe(false);
    expect(s.settings).toEqual({ auto: false, method: "mc_compress", background: false, battery: false });
    expect(s.stats).toEqual({
      evaluations: 0,
      clicks: 0,
      runs: 0,
      computeMs: 0,
      submissions: 0,
      firstRecords: 0,
      verifiedImprovements: 0,
    });
    expect(s.bank).toBe(0);
    // auto-eval's clock never stands in the future, and the dealer never counts evaluations not run
    expect(s.bankAt).toBe(T0);
    expect(s.dealer).toMatchObject({ tokens: 1, evalsAt: 0, seed: 1234 });
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
    expect(s).toMatchObject({ rp: 40, rpEarned: 100, bank: 0, consent: true });
    expect(s.stats).toMatchObject({ evaluations: 900, runs: 12, clicks: 12 });
    // the dealer counts evaluations from those already run
    expect(s.dealer).toMatchObject({ seed: 9, draws: 4, dealt: 2, tokens: 0.4, evalsAt: 900 });
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
