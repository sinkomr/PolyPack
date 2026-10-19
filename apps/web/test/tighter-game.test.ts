import { describe, expect, it } from "vitest";
import { MAX_METHOD_PARAMS_BYTES, areaLowerBound, parseProvenance } from "@polypack/geometry";
import type { PackingConfig, ProblemInfo } from "@polypack/geometry";
import {
  GameState,
  ProblemState,
  RunOutcome,
  STALE_RUNS,
  addToQueue,
  applyAnswer,
  applyLeader,
  applyLoadAll,
  applyRun,
  buy,
  drop,
  hasUnsent,
  newGame,
  newProblem,
  pendingPoints,
  recordsHeld,
  submitTarget,
} from "../src/tighter/game";
import { FRONTIER, STARTER, problemTitle } from "../src/tighter/frontier";
import { autoHold, autoTarget } from "../src/tighter/scheduler";
import { CLIENT_TAG, classifyAnswer, shouldSubmit, submissionBody } from "../src/tighter/submission";
import {
  UPGRADES,
  UpgradeId,
  available,
  canBuy,
  evalsPerRun,
  evolveEvals,
  laneCount,
  queueSize,
} from "../src/tighter/upgrades";
import { drawProblem, looseCandidates, newDealer, openDealable } from "../src/tighter/dealer";

const T0 = 1_000_000;
const board = (P: number, shift = 0): PackingConfig => ({
  N: 24,
  M: 30,
  P,
  pieces: Array.from({ length: P }, (_, i) => ({ x: 3 * i + shift, y: 0, theta: 0 })),
  container_phi: 0,
});
const run = (seed: number) => ({
  method: "mc_compress",
  params: { translationStep: 0.15 },
  seed,
  budget: { evals: 30 },
});
const outcome = (score: number, seed: number, extra: Partial<RunOutcome> = {}): RunOutcome => ({
  best: board(3, seed),
  score,
  valid: true,
  strict: true,
  evaluations: 30,
  wallTime: 0.5,
  run: run(seed),
  ...extra,
});

function game(): { s: GameState; p: ProblemState } {
  const s = newGame(T0, 1);
  s.name = "Ada";
  s.consent = true;
  const p = newProblem({ N: 24, M: 30, P: 3 }, "open", T0);
  addToQueue(s, p);
  return { s, p };
}

describe("Tighter frontier", () => {
  it("is the curated 2,601, with a 108-problem starter corner inside it", () => {
    expect(FRONTIER).toHaveLength(2601);
    expect(new Set(FRONTIER.map((p) => `${p.N}/${p.M}/${p.P}`)).size).toBe(2601);
    expect(STARTER).toHaveLength(108);
    const all = new Set(FRONTIER.map((p) => `${p.N}/${p.M}/${p.P}`));
    for (const p of STARTER) expect(all.has(`${p.N}/${p.M}/${p.P}`)).toBe(true);
    expect(problemTitle({ N: 60, M: 47, P: 80 })).toBe("60-gons in a 47-gon, 80 pieces");
    expect(problemTitle({ N: 21, M: 80, P: 40 })).toBe("21-gons in an 80-gon, 40 pieces");
  });
});

describe("Tighter upgrades", () => {
  it("are the design's first ten, through Basin hopping, Reach: loose records and Second lane", () => {
    expect(UPGRADES.map((u) => [u.id, u.cost])).toEqual([
      ["trace", 5],
      ["evals1", 30],
      ["queue3", 50],
      ["seeds", 70],
      ["auto1", 85],
      ["basin", 170],
      ["reach2", 300],
      ["evals2", 560],
      ["advance", 850],
      ["lanes2", 1200],
    ]);
  });

  it("are gated by their prerequisites and by points", () => {
    const owned = new Set<UpgradeId>();
    expect(available(owned).map((u) => u.id)).toEqual(["trace"]);
    expect(canBuy(owned, 4.99, "trace")).toEqual({ ok: false, reason: "points" });
    expect(canBuy(owned, 5, "trace")).toEqual({ ok: true });
    expect(canBuy(owned, 1e6, "evals1")).toEqual({ ok: false, reason: "locked" });
    owned.add("trace");
    expect(canBuy(owned, 1e6, "trace")).toEqual({ ok: false, reason: "owned" });
    expect(available(owned).map((u) => u.id)).toEqual(["evals1", "queue3"]);
    // Basin hopping needs both the seed counter and the queue
    for (const id of ["evals1", "auto1", "seeds"] as UpgradeId[]) owned.add(id);
    expect(canBuy(owned, 1e6, "basin")).toEqual({ ok: false, reason: "locked" });
    owned.add("queue3");
    expect(canBuy(owned, 1e6, "basin")).toEqual({ ok: true });
    // Second lane needs Reach: loose records
    owned.add("basin");
    expect(canBuy(owned, 1e6, "lanes2").ok).toBe(false);
    owned.add("reach2");
    expect(canBuy(owned, 1e6, "lanes2").ok).toBe(true);
  });

  it("spend points, and turn into game parameters", () => {
    const s = newGame(T0, 1);
    s.rp = 4;
    expect(buy(s, "trace")).toBe(false);
    s.rp = 40;
    expect(buy(s, "trace")).toBe(true);
    expect(s.rp).toBe(35);
    expect(buy(s, "trace")).toBe(false);
    expect(buy(s, "evals1")).toBe(true);
    expect(s.rp).toBe(5);
    const owned = new Set(s.owned);
    expect(evalsPerRun(owned)).toBe(60);
    expect(evolveEvals(owned, "basin_hopping")).toBe(100);
    expect(queueSize(owned)).toBe(1);
    expect(laneCount(owned)).toBe(1);
    expect(evalsPerRun(new Set<UpgradeId>(["evals1", "evals2"]))).toBe(300);
    expect(evolveEvals(new Set<UpgradeId>(["evals2"]), "basin_hopping")).toBe(300);
    expect(queueSize(new Set<UpgradeId>(["queue3"]))).toBe(3);
    expect(laneCount(new Set<UpgradeId>(["lanes2"]))).toBe(2);
  });
});

describe("Tighter runs on the board", () => {
  it("never submits Load all: the first record must beat the free floor", () => {
    const { s, p } = game();
    applyLoadAll(p, board(3), 10, null);
    expect(p.phase).toBe("loaded");
    expect(p.floor).toBe(10);
    expect(hasUnsent(p)).toBe(false);
    // a run that returns the start unchanged is no record
    let c = applyRun(s, p, outcome(10, 1), T0);
    expect(c.improved).toBe(false);
    expect(p.phase).toBe("loaded");
    // nor one that beats it by less than the floor F
    c = applyRun(s, p, outcome(10 * (1 - 5e-10), 2), T0);
    expect(c.counted).toBe(false);
    expect(p.phase).toBe("loaded");
    c = applyRun(s, p, outcome(9.5, 3), T0);
    expect(c).toMatchObject({ improved: true, counted: true, firstRecord: true, after: 9.5 });
    expect(p.phase).toBe("ready");
    expect(hasUnsent(p)).toBe(true);
    expect(p.nextSeed).toBe(4);
    expect(s.stats.runs).toBe(3);
    expect(s.stats.evaluations).toBe(90);
  });

  it("takes the trim floor when the P + 1 record is smaller than Load all", () => {
    const { p } = game();
    applyLoadAll(p, board(3), 10, 9.8);
    expect(p.floor).toBe(9.8);
  });

  it("keeps the side from growing and accepts only strict, valid results", () => {
    const { s, p } = game();
    applyLoadAll(p, board(3), 10, null);
    applyRun(s, p, outcome(9.5, 1), T0);
    for (const bad of [
      outcome(9.9, 2),
      outcome(9.4, 3, { strict: false }),
      outcome(9.4, 4, { valid: false }),
      outcome(9.4, 5, { best: undefined }),
      outcome(NaN, 6),
    ]) {
      const c = applyRun(s, p, bad, T0);
      expect(c.improved).toBe(false);
      expect(p.best).toBe(9.5);
    }
    expect(p.deadRuns).toBe(5);
    // a tiny improvement below the floor still improves the board, but is no event
    const c = applyRun(s, p, outcome(9.5 * (1 - 1e-12), 7), T0);
    expect(c).toMatchObject({ improved: true, counted: false });
    expect(p.deadRuns).toBe(6);
    expect(p.trace.at(-1)).toBe(9.5 * (1 - 1e-12));
  });
});

describe("Tighter answers from the server", () => {
  function recordOn(s: GameState, p: ProblemState) {
    applyLoadAll(p, board(3), 10, null);
    applyRun(s, p, outcome(9.5, 1), T0);
  }

  it("pays points only for an answer that makes the entry leader", () => {
    const { s, p } = game();
    // realistic gaps: Load all 28 % above the area bound, Compact 20 %
    const B = areaLowerBound(24, 30, 3);
    applyLoadAll(p, board(3), 1.28 * B, null);
    applyRun(s, p, outcome(1.2 * B, 1), T0);
    const pending = pendingPoints(p, s.name)!;
    expect(pending.firstBonus).toBe(true);
    expect(s.rp).toBe(0);
    const a = applyAnswer(s, p, null, 1.2 * B, { kind: "leader", score: 1.2 * B, id: 17, pending: false }, T0);
    expect(a.points!.total).toBeCloseTo(pending.total, 12);
    expect(s.rp).toBeCloseTo(pending.total, 12);
    expect(s.stats.firstRecords).toBe(1);
    expect(p.ourId).toBe(17);
    expect(recordsHeld(s)).toBe(1);
    expect(hasUnsent(p)).toBe(false);
    // the next improvement is measured against our own record, without the first-record bonus
    applyRun(s, p, outcome(1.19 * B, 2), T0);
    expect(hasUnsent(p)).toBe(true);
    const next = pendingPoints(p, s.name)!;
    expect(next.firstBonus).toBe(false);
    expect(next.beatBonus).toBe(false);
  });

  it("pays nothing when another entry got there first, and nothing for refusals", () => {
    const { s, p } = game();
    recordOn(s, p);
    let a = applyAnswer(s, p, null, 9.5, { kind: "behind", score: 9.5, leaderScore: 9.3 }, T0);
    expect(a.points).toBeNull();
    expect(s.rp).toBe(0);
    expect(p.leader?.score).toBe(9.3);
    expect(hasUnsent(p)).toBe(false);
    a = applyAnswer(s, p, null, 9.5, { kind: "refused", status: 400, reasons: ["nope"] }, T0);
    expect(p.refused).toEqual({ score: 9.5, reasons: ["nope"] });
    a = applyAnswer(s, p, null, 9.5, { kind: "closed", reasons: ["closed"] }, T0);
    expect(p.closed).toBe(true);
    expect(hasUnsent(p)).toBe(false);
    expect(s.rp).toBe(0);
  });

  it("does not resend a refused board, but sends the next one", () => {
    const { s, p } = game();
    recordOn(s, p);
    applyAnswer(s, p, null, 9.5, { kind: "refused", status: 422, reasons: ["overlap"] }, T0);
    expect(hasUnsent(p)).toBe(false);
    applyRun(s, p, outcome(9.4, 2), T0);
    expect(hasUnsent(p)).toBe(true);
  });

  it("loses a record held when the leader is no longer our entry", () => {
    const { s, p } = game();
    recordOn(s, p);
    applyAnswer(s, p, null, 9.5, { kind: "leader", score: 9.5, id: 17, pending: false }, T0);
    expect(applyLeader(p, { score: 9.5, name: "Ada", id: 17 }).lost).toBe(false);
    expect(recordsHeld(s)).toBe(1);
    expect(applyLeader(p, { score: 9.2, name: "Bob", id: 18 }).lost).toBe(true);
    expect(recordsHeld(s)).toBe(0);
    // taking it back from another name pays the beat bonus once
    applyRun(s, p, outcome(9.1, 2), T0);
    const before = { score: 9.2, name: "Bob", id: 18 };
    const a = applyAnswer(s, p, before, 9.1, { kind: "leader", score: 9.1, id: 19, pending: false }, T0);
    expect(a.points!.beatBonus).toBe(true);
    expect(p.beatPaid).toBe(true);
    expect(submitTarget(p, 9.1)).toBe(9.1);
  });

  it("keeps a dropped problem until its best is sent", () => {
    const { s, p } = game();
    recordOn(s, p);
    expect(drop(s, p.key, T0)).toBe(false);
    expect(p.leaving).toBe(true);
    expect(s.queue).toHaveLength(1);
    const other = newProblem({ N: 21, M: 21, P: 40 }, "open", T0);
    addToQueue(s, other);
    expect(drop(s, other.key, T0)).toBe(true);
    expect(s.past.map((q) => q.key)).toEqual(["21/21/40"]);
  });
});

describe("Tighter submissions", () => {
  it("sends only strict improvements on the leader read just before", () => {
    expect(shouldSubmit(9.5, null)).toBe(true);
    expect(shouldSubmit(9.5, 9.5)).toBe(false);
    expect(shouldSubmit(9.5 * (1 - 1e-9), 9.5)).toBe(false);
    expect(shouldSubmit(9.5 * (1 - 2e-9), 9.5)).toBe(true);
    expect(shouldSubmit(NaN, null)).toBe(false);
  });

  it("fills the provenance fields the server accepts for an optimizer run", () => {
    const body = submissionBody(board(3), "Ada", run(7));
    expect(body).toMatchObject({
      name: "Ada",
      agent_note: CLIENT_TAG,
      found_with: "optimizer",
      method: "mc_compress",
      method_params: { translationStep: 0.15 },
      seed: 7,
      budget: { evals: 30 },
    });
    expect(body.software).toBeUndefined();
    const parsed = parseProvenance(body, ["mc_compress", "basin_hopping"]);
    expect(parsed.ok).toBe(true);
    // oversized parameters are left out rather than refused
    const big = { blob: "x".repeat(MAX_METHOD_PARAMS_BYTES) };
    expect(submissionBody(board(3), "Ada", { ...run(7), params: big }).method_params).toBeUndefined();
  });

  it("reads each answer by its status", () => {
    expect(classifyAnswer(null, null)).toEqual({ kind: "offline" });
    expect(
      classifyAnswer(200, { valid: true, score: 9.5, leader: true, id: null, pending_verification: false }),
    ).toEqual({
      kind: "leader",
      score: 9.5,
      id: null,
      pending: false,
    });
    expect(classifyAnswer(200, { valid: true, score: 9.5, leader: false, leader_score: 9.4, id: null })).toEqual({
      kind: "behind",
      score: 9.5,
      leaderScore: 9.4,
    });
    expect(classifyAnswer(409, { valid: false, reasons: ["this problem is closed"] }).kind).toBe("closed");
    expect(classifyAnswer(429, { valid: false, reasons: ["wait a minute"] }).kind).toBe("rate-limited");
    expect(classifyAnswer(400, { valid: false, reasons: ["name is required"] })).toEqual({
      kind: "refused",
      status: 400,
      reasons: ["name is required"],
    });
    expect(classifyAnswer(422, null)).toEqual({ kind: "refused", status: 422, reasons: ["the server answered 422"] });
    expect(classifyAnswer(503, null).kind).toBe("offline");
  });
});

describe("Tighter dealer", () => {
  const info = (over: Partial<ProblemInfo>): ProblemInfo => ({
    N: 24,
    M: 30,
    P: 60,
    conventions: {},
    area_bound: 1,
    literature: null,
    site_best: null,
    accepts_submissions: true,
    ...over,
  });

  it("deals only problems that are still open and unpublished", () => {
    expect(openDealable(info({}))).toBe(true);
    expect(openDealable(null)).toBe(false);
    expect(openDealable(info({ accepts_submissions: false }))).toBe(false);
    const entry = {
      id: 1,
      name: "Bob",
      found_with: null,
      agent_note: "",
      score: 9,
      created_at: "",
      verification: "none" as const,
    };
    expect(openDealable(info({ site_best: entry }))).toBe(false);
  });

  it("draws reproducibly and never deals a problem twice", () => {
    const a = newDealer(42, T0);
    const b = newDealer(42, T0);
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const pa = drawProblem(a, STARTER, seen)!;
      expect(drawProblem(b, STARTER, seen)).toEqual(pa);
      const key = `${pa.N}/${pa.M}/${pa.P}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // the last problem left is still found
    const all = new Set(STARTER.map((p) => `${p.N}/${p.M}/${p.P}`));
    all.delete("36/36/80");
    expect(drawProblem(a, STARTER, all)).toEqual({ N: 36, M: 36, P: 80 });
  });

  it("finds loose records: gap above 12 %, no published value, not pending", () => {
    const b = (P: number) => areaLowerBound(7, 7, P);
    const entry = (P: number, score: number, verification: "none" | "pending" = "none") => ({
      P,
      id: P,
      name: "Bob",
      found_with: null,
      agent_note: "",
      score,
      created_at: "",
      verification,
    });
    const records = {
      N: 7,
      M: 7,
      literature: [{ P: 12 } as never],
      site: [
        entry(10, b(10) * 1.2),
        entry(11, b(11) * 1.05),
        entry(12, b(12) * 1.3),
        entry(13, b(13) * 1.3, "pending"),
      ],
    };
    expect(looseCandidates(records, new Set()).map((c) => c.P)).toEqual([10]);
    expect(looseCandidates(records, new Set(["7/7/10"]))).toEqual([]);
  });
});

describe("Tighter auto-eval", () => {
  function queue(): ProblemState[] {
    return ["24/30/60", "21/21/40", "27/27/80"].map((k) => {
      const [N, M, P] = k.split("/").map(Number);
      const p = newProblem({ N, M, P }, "open", T0);
      p.phase = "ready";
      p.run = run(1);
      return p;
    });
  }

  it("keeps lane 1 on the board's problem and lane 2 on another, without Auto-advance", () => {
    const q = queue();
    const owned = new Set<UpgradeId>(["auto1"]);
    expect(autoTarget({ lane: 0, queue: q, focus: "21/21/40", busy: new Set(), owned })).toEqual({
      key: "21/21/40",
      action: "evolve",
    });
    expect(autoTarget({ lane: 1, queue: q, focus: "21/21/40", busy: new Set(), owned })).toEqual({
      key: "24/30/60",
      action: "evolve",
    });
    // never two lanes on one problem
    expect(autoTarget({ lane: 0, queue: q, focus: "21/21/40", busy: new Set(["21/21/40"]), owned })).toBeNull();
    // a problem without a record is left to the player
    q[1].phase = "bare";
    expect(autoTarget({ lane: 0, queue: q, focus: "21/21/40", busy: new Set(), owned })).toBeNull();
  });

  it("moves on when runs stop paying, and compacts fresh problems, with Auto-advance", () => {
    const q = queue();
    const owned = new Set<UpgradeId>(["auto1", "advance"]);
    q[0].deadRuns = STALE_RUNS;
    q[1].deadRuns = 3;
    q[2].deadRuns = 1;
    expect(autoTarget({ lane: 0, queue: q, focus: q[0].key, busy: new Set(), owned })?.key).toBe("27/27/80");
    q[2].deadRuns = STALE_RUNS;
    q[1].deadRuns = STALE_RUNS;
    // everything has stopped paying: the least stale one still runs
    q[0].lastRunAt = 5;
    expect(autoTarget({ lane: 0, queue: q, focus: q[0].key, busy: new Set(), owned })?.key).toBe("21/21/40");
    q.push(newProblem({ N: 30, M: 30, P: 60 }, "open", T0));
    expect(autoTarget({ lane: 1, queue: q, focus: q[0].key, busy: new Set(), owned })).toEqual({
      key: "30/30/60",
      action: "compact",
    });
  });

  it("holds in hidden tabs and on battery unless allowed", () => {
    expect(autoHold({ hidden: true, onBattery: false, background: false, battery: false })).toBe("hidden");
    expect(autoHold({ hidden: true, onBattery: false, background: true, battery: false })).toBeNull();
    expect(autoHold({ hidden: false, onBattery: true, background: false, battery: false })).toBe("battery");
    expect(autoHold({ hidden: false, onBattery: true, background: false, battery: true })).toBeNull();
  });
});
