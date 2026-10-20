import { describe, expect, it } from "vitest";
import { MAX_METHOD_PARAMS_BYTES, areaLowerBound, parseProvenance } from "@polypack/geometry";
import type { PackingConfig, ProblemInfo } from "@polypack/geometry";
import {
  GameState,
  ProblemState,
  STALE_EVALS,
  StepOutcome,
  TRACE_LIMIT,
  accrue,
  addToQueue,
  applyAnswer,
  applyLeader,
  applyLoadAll,
  applyStep,
  buy,
  drop,
  evolvable,
  hasUnsent,
  markSending,
  newGame,
  newProblem,
  openedRun,
  payAll,
  pendingPoints,
  recordsHeld,
  spent,
  submitTarget,
  unconfirmedPoints,
  withdrawConsent,
} from "../src/tighter/game";
import { FRONTIER, STARTER, problemTitle } from "../src/tighter/frontier";
import { autoHold, autoTarget } from "../src/tighter/scheduler";
import { CLIENT_TAG, classifyAnswer, shouldSubmit, submissionBody } from "../src/tighter/submission";
import {
  COMPACT_EVALS,
  RUN_BUDGET,
  UPGRADES,
  UpgradeId,
  autoPerSecond,
  available,
  awayHours,
  bankCap,
  canBuy,
  evalsPerClick,
  laneCount,
  methodParams,
  methods,
  queueSize,
  seedsPerProblem,
  upgrade,
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
const run = (seed: number, evals = 30) => ({
  method: "mc_compress",
  params: { translationStep: 0.15 },
  seed,
  budget: { evals },
});
/** One step of an open run that found `score` (null: nothing strict yet). */
const step = (score: number | null, seed = 1, extra: Partial<StepOutcome> = {}): StepOutcome => ({
  evaluations: 1,
  best: score === null ? null : board(3, seed),
  score,
  run: run(seed),
  ms: 2,
  ended: false,
  click: true,
  ...extra,
});

function game(consent = true): { s: GameState; p: ProblemState } {
  const s = newGame(T0, 1);
  s.name = "Ada";
  s.consent = consent;
  const p = newProblem({ N: 24, M: 30, P: 3 }, "open", T0);
  addToQueue(s, p);
  return { s, p };
}

/** Realistic gaps for 24-gons in a 30-gon, 3 pieces: Load all 28 % above the area bound. */
const B = areaLowerBound(24, 30, 3);

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
  const ids = UPGRADES.map((u) => u.id);
  const cost = (id: UpgradeId) => upgrade(id).cost;

  it("form a tree: unique ids, every prerequisite an upgrade listed before it", () => {
    expect(new Set(ids).size).toBe(ids.length);
    UPGRADES.forEach((u, i) => {
      for (const r of u.requires) {
        expect(ids).toContain(r);
        // listed earlier, so the prerequisites form no cycle and buying in list order always works
        expect(ids.indexOf(r)).toBeLessThan(i);
      }
      expect(u.cost).toBeGreaterThan(0);
    });
    const owned = new Set<UpgradeId>();
    for (const u of UPGRADES) {
      expect(canBuy(owned, 1e9, u.id)).toEqual({ ok: true });
      owned.add(u.id);
    }
    expect(available(owned)).toEqual([]);
  });

  it("climb slowly: each rung of a ladder, and each new method, costs more than the last", () => {
    const ladder = (list: UpgradeId[]) => {
      for (let i = 1; i < list.length; i++) {
        expect(cost(list[i])).toBeGreaterThan(cost(list[i - 1]));
        // one at a time: each rung needs the one before
        expect(upgrade(list[i]).requires).toContain(list[i - 1]);
      }
    };
    ladder(["click2", "click3", "click4", "click5", "click6", "click7", "click8", "click9", "click10"]);
    ladder(["auto1", "auto2", "auto3", "auto4", "auto5", "auto6", "auto7", "auto8", "auto9"]);
    ladder(["basin", "shrink", "penalty", "lattice", "harden", "morph", "asc", "growth"]);
    ladder(["seeds2", "seeds4", "seeds8", "seeds16"]);
    ladder(["away2", "away3", "away4"]);
    // methods come well after the click ladder and a faster auto-eval
    expect(upgrade("basin").requires).toEqual(expect.arrayContaining(["click10", "auto4"]));
    expect(cost("basin")).toBeGreaterThan(cost("click10"));
    // auto-eval comes after a few rungs of the click ladder
    expect(upgrade("auto1").requires).toEqual(["click4"]);
  });

  it("are gated by their prerequisites and by points", () => {
    const owned = new Set<UpgradeId>();
    expect(available(owned).map((u) => u.id)).toEqual(["trace"]);
    expect(canBuy(owned, 4.99, "trace")).toEqual({ ok: false, reason: "points" });
    expect(canBuy(owned, 5, "trace")).toEqual({ ok: true });
    expect(canBuy(owned, 1e6, "click2")).toEqual({ ok: false, reason: "locked" });
    owned.add("trace");
    expect(canBuy(owned, 1e6, "trace")).toEqual({ ok: false, reason: "owned" });
    expect(available(owned).map((u) => u.id)).toEqual(["click2"]);
    for (const id of ["click2", "click3"] as UpgradeId[]) owned.add(id);
    expect(canBuy(owned, 1e6, "auto1")).toEqual({ ok: false, reason: "locked" });
    owned.add("click4");
    expect(available(owned).map((u) => u.id)).toEqual(["auto1", "click5"]);
    // Auto-advance needs both Reach: loose records and the queue
    for (const id of [
      "auto1",
      "auto2",
      "auto3",
      "auto4",
      "click5",
      "click6",
      "click7",
      "click8",
      "click9",
      "click10",
    ] as UpgradeId[])
      owned.add(id);
    owned.add("basin");
    owned.add("reach2");
    expect(canBuy(owned, 1e6, "advance")).toEqual({ ok: false, reason: "locked" });
    owned.add("queue3");
    expect(canBuy(owned, 1e6, "advance")).toEqual({ ok: true });
  });

  it("spend points, and turn into game parameters", () => {
    const s = newGame(T0, 1);
    s.rp = 4;
    expect(buy(s, "trace")).toBe(false);
    s.rp = cost("click2") + 5;
    expect(buy(s, "trace")).toBe(true);
    expect(buy(s, "trace")).toBe(false);
    expect(buy(s, "click2")).toBe(true);
    expect(s.rp).toBe(0);
    const none = new Set<UpgradeId>();
    const o = (...list: UpgradeId[]) => new Set<UpgradeId>(list);
    expect(evalsPerClick(none)).toBe(1);
    expect(evalsPerClick(new Set(s.owned))).toBe(2);
    expect(evalsPerClick(o("click2", "click3", "click4"))).toBe(4);
    expect(evalsPerClick(o("click10"))).toBe(10);
    expect(COMPACT_EVALS).toBe(100);
    expect(RUN_BUDGET).toBe(100_000);
    // auto-eval starts at one evaluation every 5 s and speeds up step by step
    expect(autoPerSecond(none)).toBeNull();
    expect(autoPerSecond(o("auto2"))).toBeNull();
    expect(autoPerSecond(o("auto1"))).toBe(0.2);
    expect(autoPerSecond(o("auto1", "auto2", "auto3", "auto4"))).toBe(0.5);
    expect(autoPerSecond(o("auto1", "auto5"))).toBe(1);
    expect(autoPerSecond(o("auto1", "auto9"))).toBe(10);
    // away: an hour with auto-eval, more with upgrades; the bank holds the rate over those hours
    expect(awayHours(none)).toBe(0);
    expect(awayHours(o("auto1"))).toBe(1);
    expect(awayHours(o("auto1", "away2"))).toBe(4);
    expect(awayHours(o("auto1", "away2", "away3", "away4"))).toBe(24);
    expect(bankCap(none)).toBe(1);
    expect(bankCap(o("auto1"))).toBeCloseTo(720, 9);
    expect(bankCap(o("auto1", "away2"))).toBeCloseTo(2880, 9);
    expect(bankCap(o("auto1", "auto5", "away3"))).toBeCloseTo(43_200, 9);
    expect(seedsPerProblem(none)).toBe(1);
    expect(seedsPerProblem(o("seeds2"))).toBe(2);
    expect(seedsPerProblem(o("seeds2", "seeds4", "seeds8"))).toBe(8);
    expect(seedsPerProblem(o("seeds16"))).toBe(16);
    // methods in the order they unlock, mc_compress first
    expect(methods(none)).toEqual(["mc_compress"]);
    expect(methods(o("shrink", "basin"))).toEqual(["mc_compress", "basin_hopping", "shrink_repair"]);
    expect(methods(new Set(ids))).toEqual([
      "mc_compress",
      "basin_hopping",
      "shrink_repair",
      "penalty",
      "seed",
      "harden",
      "morph",
      "asc",
      "ls_growth",
    ]);
    // method settings are bought too: mc_compress starts at 5 sweeps per evaluation
    expect(methodParams(none, "mc_compress")).toEqual({ sweepsPerEvaluation: 5 });
    expect(methodParams(o("sweeps10"), "mc_compress")).toEqual({ sweepsPerEvaluation: 10 });
    expect(methodParams(o("sweeps10"), "basin_hopping")).toEqual({});
    expect(queueSize(none)).toBe(1);
    expect(queueSize(o("queue3"))).toBe(3);
    expect(laneCount(none)).toBe(1);
    expect(laneCount(o("lanes2"))).toBe(2);
  });
});

describe("Tighter runs on the board", () => {
  it("never submits Load all: the first record must beat the free floor", () => {
    const { s, p } = game();
    applyLoadAll(p, board(3), 10, null);
    expect(p.phase).toBe("loaded");
    expect(p.floor).toBe(10);
    expect(hasUnsent(p)).toBe(false);
    openedRun(s, p, 1, T0);
    expect(p.nextSeed).toBe(2);
    // a step that returns the start unchanged is no record
    let c = applyStep(s, p, step(10, 1, { evaluations: 100 }), T0);
    expect(c.improved).toBe(false);
    expect(p.phase).toBe("loaded");
    // nor one that beats it by less than the floor F
    c = applyStep(s, p, step(10 * (1 - 5e-10)), T0);
    expect(c).toMatchObject({ improved: true, counted: false, firstRecord: false, points: null });
    expect(p.phase).toBe("loaded");
    c = applyStep(s, p, step(9.5), T0);
    expect(c).toMatchObject({ improved: true, counted: true, firstRecord: true, after: 9.5 });
    expect(p.phase).toBe("ready");
    expect(hasUnsent(p)).toBe(true);
    expect(s.stats.runs).toBe(1);
    expect(s.stats.evaluations).toBe(102);
    expect(s.stats.clicks).toBe(3);
    expect(p.evaluations).toBe(102);
    // auto-eval's steps count as evaluations, not as clicks
    applyStep(s, p, step(null, 1, { click: false, evaluations: 4 }), T0);
    expect(s.stats.clicks).toBe(3);
    expect(s.stats.evaluations).toBe(106);
  });

  it("takes the trim floor when the P + 1 record is smaller than Load all", () => {
    const { p } = game();
    applyLoadAll(p, board(3), 10, 9.8);
    expect(p.floor).toBe(9.8);
  });

  it("lets Evolve go on after a Compact that did not beat a trim floor", () => {
    // Compact improved the Load-all board, but not past the trim floor: no record, yet a run's board
    let { s, p } = game();
    applyLoadAll(p, board(3), 10, 9.0);
    expect(evolvable(p)).toBe(false);
    // the run's start scoring (one evaluation, not Compact's step) does not make the problem evolvable
    applyStep(s, p, step(null, 1, { click: false, evaluations: 1 }), T0);
    expect(evolvable(p)).toBe(false);
    let c = applyStep(s, p, step(9.5, 1, { evaluations: 100, compact: true }), T0);
    expect(c).toMatchObject({ improved: true, counted: false, firstRecord: false });
    expect(p.phase).toBe("loaded");
    expect(p.run).toEqual(run(1));
    expect(evolvable(p)).toBe(true);
    // Compact found nothing better at all: the board is still the run's start, and Evolve may go on
    ({ s, p } = game());
    applyLoadAll(p, board(3), 10, 9.0);
    c = applyStep(s, p, step(null, 1, { evaluations: 100, compact: true }), T0);
    expect(c.improved).toBe(false);
    expect(evolvable(p)).toBe(true);
    expect(p.best).toBe(10);
  });

  it("keeps the side from growing and accepts only strict results with a finite positive score", () => {
    const { s, p } = game();
    applyLoadAll(p, board(3), 10, null);
    applyStep(s, p, step(9.5), T0);
    for (const bad of [step(9.9), step(9.5), step(9.4, 3, { best: null }), step(null), step(NaN), step(-1), step(0)]) {
      const c = applyStep(s, p, bad, T0);
      expect(c.improved).toBe(false);
      expect(c.points).toBeNull();
      expect(p.best).toBe(9.5);
    }
    expect(p.sinceGain).toBe(7);
    // a tiny improvement below the floor still improves the board, but is no event and is not traced
    const c = applyStep(s, p, step(9.5 * (1 - 1e-12), 7, { evaluations: 3 }), T0);
    expect(c).toMatchObject({ improved: true, counted: false });
    expect(p.sinceGain).toBe(10);
    expect(p.trace).toEqual([[1, 9.5]]);
    // a counted improvement resets the count, and the trace records it by evaluations run here
    applyStep(s, p, step(9.4, 8, { evaluations: 2 }), T0);
    expect(p.sinceGain).toBe(0);
    expect(p.trace).toEqual([
      [1, 9.5],
      [13, 9.4],
    ]);
  });

  it("thins a long trace, keeping its first and last points", () => {
    const { s, p } = game();
    applyLoadAll(p, board(3), 10, null);
    let score = 9.9;
    for (let i = 0; i < 3 * TRACE_LIMIT; i++) {
      score *= 1 - 1e-6;
      applyStep(s, p, step(score), T0);
      expect(p.trace.length).toBeLessThanOrEqual(TRACE_LIMIT);
    }
    expect(p.trace[0]).toEqual([1, 9.9 * (1 - 1e-6)]);
    expect(p.trace.at(-1)).toEqual([3 * TRACE_LIMIT, p.best]);
    // still in order of evaluations
    for (let i = 1; i < p.trace.length; i++) expect(p.trace[i][0]).toBeGreaterThan(p.trace[i - 1][0]);
  });

  it("spends a problem's seeds as its runs end by themselves", () => {
    const { s, p } = game();
    applyLoadAll(p, board(3), 10, null);
    openedRun(s, p, 1, T0);
    applyStep(s, p, step(9.5), T0);
    expect(spent(p, 1)).toBe(false);
    applyStep(s, p, step(9.4, 1, { ended: true }), T0);
    expect(p.endedRuns).toBe(1);
    expect(spent(p, 1)).toBe(true);
    expect(spent(p, 2)).toBe(false);
    // the next seed opens a new run; when it ends too, two seeds are spent
    openedRun(s, p, 2, T0);
    expect(p.runs).toBe(2);
    expect(p.nextSeed).toBe(3);
    expect(spent(p, 2)).toBe(false);
    applyStep(s, p, step(null, 2, { ended: true }), T0);
    expect(spent(p, 2)).toBe(true);
    expect(spent(p, 4)).toBe(false);
  });
});

describe("Tighter points per click", () => {
  it("pay each improving click at once, the first record with its bonus", () => {
    const { s, p } = game();
    applyLoadAll(p, board(3), 1.28 * B, null);
    // Compact: the first record, against the free floor
    const c1 = applyStep(s, p, step(1.2 * B, 1, { evaluations: 100 }), T0);
    expect(c1.firstRecord).toBe(true);
    expect(c1.points!.firstBonus).toBe(true);
    expect(s.rp).toBeCloseTo(c1.points!.total, 12);
    expect(s.rpEarned).toBeCloseTo(c1.points!.total, 12);
    expect(p.paidTo).toBe(1.2 * B);
    expect(p.unconfirmed).toBeCloseTo(c1.points!.total, 12);
    // the next click is measured from what was paid, without the bonus
    const c2 = applyStep(s, p, step(1.19 * B, 2), T0);
    expect(c2.points!.firstBonus).toBe(false);
    expect(c2.points!.delta).toBeCloseTo(1 - 1.19 / 1.2, 12);
    expect(s.rp).toBeCloseTo(c1.points!.total + c2.points!.total, 12);
    expect(p.rp).toBeCloseTo(s.rp, 12);
    expect(unconfirmedPoints(s)).toBeCloseTo(s.rp, 12);
    // below the floor: no event, nothing paid
    const c3 = applyStep(s, p, step(1.19 * B * (1 - 1e-12), 3), T0);
    expect(c3.points).toBeNull();
    expect(p.paidTo).toBe(1.19 * B);
  });

  it("pay nothing without a name; on consent, what the board improved pays as one event", () => {
    const { s, p } = game(false);
    applyLoadAll(p, board(3), 1.28 * B, null);
    applyStep(s, p, step(1.2 * B, 1, { evaluations: 100 }), T0);
    applyStep(s, p, step(1.18 * B, 2), T0);
    expect(s.rp).toBe(0);
    expect(p.paidTo).toBeNull();
    const pending = pendingPoints(p, s.name)!;
    expect(pending.firstBonus).toBe(true);
    expect(pending.delta).toBeCloseTo(1 - 1.18 / 1.28, 12);
    s.consent = true;
    expect(payAll(s)).toBeCloseTo(pending.total, 12);
    expect(s.rp).toBeCloseTo(pending.total, 12);
    expect(p.paidTo).toBe(1.18 * B);
    // paid once
    expect(payAll(s)).toBe(0);
  });

  it("measure a dealt record from its leader, and pay the bonus for beating another name once", () => {
    const s = newGame(T0, 1);
    s.name = "Ada";
    s.consent = true;
    const p = newProblem({ N: 24, M: 30, P: 3 }, "loose", T0);
    addToQueue(s, p);
    p.phase = "ready";
    p.board = board(3);
    p.best = 1.3 * B;
    p.floor = 1.3 * B;
    p.leader = { score: 1.3 * B, name: "Bob", id: 4 };
    // the dealt board is Bob's: nothing to pay or send until a run beats it
    expect(pendingPoints(p, s.name)).toBeNull();
    expect(hasUnsent(p)).toBe(false);
    const c1 = applyStep(s, p, step(1.29 * B, 1), T0);
    expect(c1.points!.beatBonus).toBe(true);
    expect(c1.points!.c).toBe(3);
    expect(c1.points!.firstBonus).toBe(false);
    expect(p.beatPaid).toBe(true);
    const c2 = applyStep(s, p, step(1.28 * B, 2), T0);
    expect(c2.points!.beatBonus).toBe(false);
  });
});

describe("Tighter answers from the server", () => {
  /** A first record paid at once (Compact), and a click paid since. */
  function recordOn(s: GameState, p: ProblemState) {
    applyLoadAll(p, board(3), 10, null);
    applyStep(s, p, step(9.5, 1, { evaluations: 100 }), T0);
  }

  it("confirm points paid per click when the server makes the entry leader", () => {
    const { s, p } = game();
    recordOn(s, p);
    const paid = s.rp;
    expect(paid).toBeGreaterThan(0);
    markSending(p, 9.5, "Ada", null, T0);
    // the points ride with the send
    expect(p.unconfirmed).toBe(0);
    expect(p.sending!.rp).toBe(paid);
    expect(unconfirmedPoints(s)).toBe(paid);
    const a = applyAnswer(s, p, null, 9.5, { kind: "leader", score: 9.5, id: 17, pending: false }, T0);
    expect(a).toMatchObject({ confirmed: paid, takenBack: 0, points: null });
    expect(s.rp).toBe(paid);
    expect(unconfirmedPoints(s)).toBe(0);
    expect(s.stats.firstRecords).toBe(1);
    expect(s.stats.submissions).toBe(1);
    expect(p.ourId).toBe(17);
    expect(recordsHeld(s)).toBe(1);
    expect(hasUnsent(p)).toBe(false);
    // the next improvement is measured against our own record, without the first-record bonus
    applyStep(s, p, step(9.4, 2), T0);
    expect(hasUnsent(p)).toBe(true);
    expect(s.stats.firstRecords).toBe(1);
  });

  it("take back what another entry's earlier record makes no record, and pay what the board still beats", () => {
    const { s, p } = game();
    recordOn(s, p);
    markSending(p, 9.5, "Ada", null, T0);
    // a click while the send was on its way
    applyStep(s, p, step(9.2, 2), T0);
    const carried = p.sending!.rp;
    const since = p.unconfirmed;
    expect(since).toBeGreaterThan(0);
    const a = applyAnswer(s, p, null, 9.5, { kind: "behind", score: 9.5, leaderScore: 9.3 }, T0);
    expect(a.takenBack).toBeCloseTo(carried + since, 12);
    expect(p.leader?.score).toBe(9.3);
    expect(p.paidTo).toBe(9.2);
    // 9.2 still beats the new record 9.3: that much pays again, and goes with the next send
    expect(a.points).not.toBeNull();
    expect(a.points!.delta).toBeCloseTo(1 - 9.2 / 9.3, 12);
    expect(s.rp).toBeCloseTo(a.points!.total, 12);
    expect(p.unconfirmed).toBeCloseTo(a.points!.total, 12);
    expect(p.sending).toBeNull();
    expect(hasUnsent(p)).toBe(true);
  });

  it("take back everything when the board no longer beats the record, or the problem closes", () => {
    let { s, p } = game();
    recordOn(s, p);
    markSending(p, 9.5, "Ada", null, T0);
    let a = applyAnswer(s, p, null, 9.5, { kind: "behind", score: 9.5, leaderScore: 9.3 }, T0);
    expect(a.points).toBeNull();
    expect(s.rp).toBe(0);
    expect(s.rpEarned).toBe(0);
    expect(hasUnsent(p)).toBe(false);
    ({ s, p } = game());
    recordOn(s, p);
    markSending(p, 9.5, "Ada", null, T0);
    applyStep(s, p, step(9.4, 2), T0);
    a = applyAnswer(s, p, null, 9.5, { kind: "closed", reasons: ["closed"] }, T0);
    expect(p.closed).toBe(true);
    expect(s.rp).toBe(0);
    expect(p.unconfirmed).toBe(0);
    expect(hasUnsent(p)).toBe(false);
  });

  it("take back only the refused send's points; a 429 keeps them for the next send", () => {
    const { s, p } = game();
    recordOn(s, p);
    markSending(p, 9.5, "Ada", null, T0);
    const carried = p.sending!.rp;
    const c = applyStep(s, p, step(9.4, 2), T0);
    let a = applyAnswer(s, p, null, 9.5, { kind: "refused", status: 422, reasons: ["overlap"] }, T0);
    expect(a.takenBack).toBe(carried);
    expect(p.refused).toEqual({ score: 9.5, reasons: ["overlap"] });
    expect(s.rp).toBeCloseTo(c.points!.total, 12);
    expect(p.unconfirmed).toBeCloseTo(c.points!.total, 12);
    // rate-limited: not looked at, so nothing is taken and the points wait in the problem
    markSending(p, 9.4, "Ada", null, T0);
    const submissions = s.stats.submissions;
    a = applyAnswer(s, p, null, 9.4, { kind: "rate-limited", reasons: ["wait"] }, T0);
    expect(a.takenBack).toBe(0);
    expect(p.sending).toBeNull();
    expect(p.unconfirmed).toBeCloseTo(c.points!.total, 12);
    expect(s.stats.submissions).toBe(submissions);
    // no answer at all: the send is kept, points and all, to be recognised later
    markSending(p, 9.4, "Ada", null, T0);
    a = applyAnswer(s, p, null, 9.4, { kind: "offline" }, T0);
    expect(p.sending?.rp).toBeCloseTo(c.points!.total, 12);
    expect(s.rp).toBeCloseTo(c.points!.total, 12);
  });

  it("never take the balance below zero when the points were already spent", () => {
    const { s, p } = game();
    recordOn(s, p);
    const paid = s.rp;
    s.rp = paid + 1;
    expect(buy(s, "trace")).toBe(true);
    markSending(p, 9.5, "Ada", null, T0);
    const a = applyAnswer(s, p, null, 9.5, { kind: "behind", score: 9.5, leaderScore: 9.0 }, T0);
    expect(a.takenBack).toBe(paid);
    expect(s.rp).toBe(0);
    expect(s.rpEarned).toBe(0);
    expect(p.rp).toBe(0);
  });

  it("does not resend a refused board, but sends the next one", () => {
    const { s, p } = game();
    recordOn(s, p);
    applyAnswer(s, p, null, 9.5, { kind: "refused", status: 422, reasons: ["overlap"] }, T0);
    expect(hasUnsent(p)).toBe(false);
    applyStep(s, p, step(9.4, 2), T0);
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
    // taking it back from another name pays the beat bonus once, measured from what was paid
    const c = applyStep(s, p, step(9.1, 2), T0);
    expect(c.points!.beatBonus).toBe(true);
    expect(c.points!.delta).toBeCloseTo(1 - 9.1 / 9.5, 12);
    expect(p.beatPaid).toBe(true);
    expect(submitTarget(p, 9.2)).toBe(9.2);
    expect(submitTarget(p, null)).toBe(10);
  });

  it("settles a send whose answer was lost: confirmed if it leads, else its points wait for the next", () => {
    let { s, p } = game();
    recordOn(s, p);
    const paid = s.rp;
    markSending(p, 9.5, "Ada", null, T0);
    let r = applyLeader(p, { score: 9.5, name: "Ada", id: 9 }, s, T0);
    expect(r).toMatchObject({ reconciled: true, confirmed: paid, lost: false });
    expect(s.rp).toBe(paid);
    expect(p.ourId).toBe(9);
    expect(p.sending).toBeNull();
    ({ s, p } = game());
    recordOn(s, p);
    markSending(p, 9.5, "Ada", null, T0);
    r = applyLeader(p, { score: 9.3, name: "Bob", id: 4 }, s, T0);
    expect(r).toMatchObject({ reconciled: false, confirmed: 0 });
    expect(p.sending).toBeNull();
    expect(p.unconfirmed).toBe(paid);
    expect(s.rp).toBe(paid);
  });

  it("takes back unsent points when sending is switched off, and pays again from the last confirmed score", () => {
    const { s, p } = game();
    recordOn(s, p);
    markSending(p, 9.5, "Ada", null, T0);
    applyAnswer(s, p, null, 9.5, { kind: "leader", score: 9.5, id: 17, pending: false }, T0);
    const confirmed = s.rp;
    const c = applyStep(s, p, step(9.4, 2), T0);
    expect(withdrawConsent(s)).toBeCloseTo(c.points!.total, 12);
    expect(s.consent).toBe(false);
    expect(s.rp).toBeCloseTo(confirmed, 12);
    expect(p.paidTo).toBe(9.5);
    // nothing pays while sending is off
    expect(applyStep(s, p, step(9.3, 3), T0).points).toBeNull();
    // back on: the board pays again from the last confirmed score, 9.5, as one event
    s.consent = true;
    const again = pendingPoints(p, s.name)!;
    expect(again.delta).toBeCloseTo(1 - 9.3 / 9.5, 12);
    expect(payAll(s)).toBeCloseTo(again.total, 12);
    expect(p.paidTo).toBe(9.3);
    // a send already on its way keeps its points until its answer
    markSending(p, 9.3, "Ada", null, T0);
    const riding = p.sending!.rp;
    expect(withdrawConsent(s)).toBe(0);
    expect(p.sending!.rp).toBe(riding);
    expect(p.paidTo).toBe(9.3);
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

describe("Tighter auto-eval's bank", () => {
  it("earns at its rate, up to its cap, from where it last stood", () => {
    const s = newGame(T0, 1);
    expect(accrue(s, T0 + 10_000, 0.2, 720)).toBeCloseTo(2, 12);
    expect(s.bank).toBeCloseTo(2, 12);
    expect(s.bankAt).toBe(T0 + 10_000);
    // a long absence fills it to the cap, no further
    expect(accrue(s, T0 + 10_000 + 86_400_000, 0.2, 720)).toBeCloseTo(718, 9);
    expect(s.bank).toBe(720);
    // time never runs backwards: an earlier clock earns nothing and leaves bankAt where it was
    const at = s.bankAt;
    s.bank = 0;
    expect(accrue(s, at - 60_000, 1, 720)).toBe(0);
    expect(s.bankAt).toBe(at);
    // off (rate 0): nothing earned, but the clock moves on, so nothing is owed for that time later
    expect(accrue(s, at + 60_000, 0, 720)).toBe(0);
    expect(s.bank).toBe(0);
    expect(s.bankAt).toBe(at + 60_000);
    // a bank above a smaller cap keeps what it has, and earns nothing more
    s.bank = 1000;
    expect(accrue(s, at + 120_000, 1, 720)).toBe(0);
    expect(s.bank).toBe(1000);
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
    const a = newDealer(42);
    const b = newDealer(42);
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
  const base = { busy: new Set<string>(), seeds: 1 };

  it("keeps lane 1 on the board's problem and lane 2 on another, without Auto-advance", () => {
    const q = queue();
    const owned = new Set<UpgradeId>(["auto1"]);
    expect(autoTarget({ ...base, lane: 0, queue: q, focus: "21/21/40", owned })).toEqual({
      key: "21/21/40",
      action: "evolve",
    });
    expect(autoTarget({ ...base, lane: 1, queue: q, focus: "21/21/40", owned })).toEqual({
      key: "24/30/60",
      action: "evolve",
    });
    // never two lanes on one problem
    expect(
      autoTarget({ ...base, lane: 0, queue: q, focus: "21/21/40", busy: new Set(["21/21/40"]), owned }),
    ).toBeNull();
    // a problem whose seeds are spent has nothing left to give
    q[1].endedRuns = 1;
    expect(autoTarget({ ...base, lane: 0, queue: q, focus: "21/21/40", owned })).toBeNull();
    expect(autoTarget({ ...base, lane: 0, queue: q, focus: "21/21/40", owned, seeds: 2 })?.key).toBe("21/21/40");
    // a problem without a record is left to the player
    q[1].endedRuns = 0;
    q[1].phase = "bare";
    expect(autoTarget({ ...base, lane: 0, queue: q, focus: "21/21/40", owned })).toBeNull();
  });

  it("moves on when evaluations stop paying, and compacts fresh problems, with Auto-advance", () => {
    const q = queue();
    const owned = new Set<UpgradeId>(["auto1", "advance"]);
    q[0].sinceGain = STALE_EVALS;
    q[1].sinceGain = 300;
    q[2].sinceGain = 10;
    expect(autoTarget({ ...base, lane: 0, queue: q, focus: q[0].key, owned })?.key).toBe("27/27/80");
    // spent problems are skipped, however fresh their last gain
    q[2].endedRuns = 1;
    expect(autoTarget({ ...base, lane: 0, queue: q, focus: q[0].key, owned })?.key).toBe("21/21/40");
    q[2].endedRuns = 0;
    q[2].sinceGain = STALE_EVALS;
    q[1].sinceGain = STALE_EVALS;
    // everything has stopped paying: the least stale one still runs
    q[0].lastRunAt = 5;
    expect(autoTarget({ ...base, lane: 0, queue: q, focus: q[0].key, owned })?.key).toBe("21/21/40");
    q.push(newProblem({ N: 30, M: 30, P: 60 }, "open", T0));
    expect(autoTarget({ ...base, lane: 1, queue: q, focus: q[0].key, owned })).toEqual({
      key: "30/30/60",
      action: "compact",
    });
    // a bank that cannot pay for a Compact sends the lane to a run elsewhere
    expect(autoTarget({ ...base, lane: 1, queue: q, focus: q[0].key, owned, canCompact: false })).toEqual({
      key: "21/21/40",
      action: "evolve",
    });
  });

  it("holds in hidden tabs and on battery unless allowed", () => {
    expect(autoHold({ hidden: true, onBattery: false, background: false, battery: false })).toBe("hidden");
    expect(autoHold({ hidden: true, onBattery: false, background: true, battery: false })).toBeNull();
    expect(autoHold({ hidden: false, onBattery: true, background: false, battery: false })).toBe("battery");
    expect(autoHold({ hidden: false, onBattery: true, background: false, battery: true })).toBeNull();
  });
});
