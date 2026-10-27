import { describe, expect, it } from "vitest";
import type { PackingConfig } from "@polypack/geometry";
import {
  GameState,
  ProblemState,
  StepOutcome,
  addToQueue,
  advancePlan,
  applyLoadAll,
  applyStep,
  countEvaluations,
  drop,
  leaveReason,
  newGame,
  newProblem,
  seenKeys,
  slotted,
  stallAfter,
} from "../src/tighter/game";
import { drawProblem, takeToken } from "../src/tighter/dealer";
import { autoTarget } from "../src/tighter/scheduler";
import type { UpgradeId } from "../src/tighter/upgrades";

// Auto-advance (2026-10-21): problems keep their best at the last progress and the evaluations since;
// one that runs the player's patience without progress leaves the queue once a new problem can take
// its slot, and lanes keep to problems still making progress instead of going in circles.

const T0 = 1_000_000;
const board = (P: number, shift = 0): PackingConfig => ({
  N: 24,
  M: 30,
  P,
  pieces: Array.from({ length: P }, (_, i) => ({ x: 3 * i + shift, y: 0, theta: 0 })),
  container_phi: 0,
});
const run = (seed: number) => ({ method: "mc_compress", params: {}, seed, budget: { evals: 30 } });
/** One step of an open run that found `score` (null: nothing strict yet). */
const step = (score: number | null, evaluations = 1, extra: Partial<StepOutcome> = {}): StepOutcome => ({
  evaluations,
  best: score === null ? null : board(3, evaluations),
  score,
  run: run(1),
  ms: 2,
  ended: false,
  click: true,
  ...extra,
});

/** A game with Auto-advance and a name on records. */
function advanced(): GameState {
  const s = newGame(T0, 1);
  s.name = "Ada";
  s.consent = true;
  s.owned.push("auto1", "queue3", "advance");
  return s;
}

/** A problem with a record that is ours and sent: nothing is left to send. */
function held(s: GameState, key: string, best = 10): ProblemState {
  const [N, M, P] = key.split("/").map(Number);
  const p = newProblem({ family: "polygon", N, M, P }, "open", T0);
  p.phase = "ready";
  p.board = board(3);
  p.best = best;
  p.run = run(1);
  p.progressBest = best;
  p.verified = best;
  p.ourId = 1;
  p.leader = { score: best, name: "Ada", id: 1 };
  addToQueue(s, p);
  return p;
}

describe("Tighter progress", () => {
  it("counts evaluations since the best last beat its mark by the tolerance; the first record sets the mark", () => {
    const s = advanced();
    expect(s.settings.tolerance).toBe(1e-6);
    const p = newProblem({ family: "polygon", N: 24, M: 30, P: 3 }, "open", T0);
    addToQueue(s, p);
    applyLoadAll(p, board(3), 10, null);
    // before the first record every evaluation counts, and there is no mark
    applyStep(s, p, step(null, 5), T0);
    expect(p).toMatchObject({ sinceGain: 5, progressBest: null, evaluations: 5 });
    applyStep(s, p, step(9.5, 100, { compact: true }), T0);
    expect(p).toMatchObject({ phase: "ready", sinceGain: 0, progressBest: 9.5, evaluations: 105 });
    // an improvement that counts (and pays) but is under the tolerance is not progress
    const c = applyStep(s, p, step(9.5 * (1 - 5e-7), 10), T0);
    expect(c.counted).toBe(true);
    expect(c.points).not.toBeNull();
    expect(p).toMatchObject({ sinceGain: 10, progressBest: 9.5 });
    // small gains add up: they are measured from the mark, not from the step before
    applyStep(s, p, step(9.5 * (1 - 1.2e-6), 10), T0);
    expect(p).toMatchObject({ sinceGain: 0, progressBest: 9.5 * (1 - 1.2e-6), evaluations: 125 });
    // a coarser tolerance asks for more
    s.settings.tolerance = 1e-3;
    applyStep(s, p, step(p.best! * (1 - 5e-4), 7), T0);
    expect(p.sinceGain).toBe(7);
    applyStep(s, p, step(p.progressBest! * (1 - 1.1e-3), 3), T0);
    expect(p.sinceGain).toBe(0);
  });

  it("is the old rule with τ = 10⁻⁹: progress is exactly an improvement that counts", () => {
    const s = advanced();
    s.settings.tolerance = 1e-9;
    const p = newProblem({ family: "polygon", N: 24, M: 30, P: 3 }, "open", T0);
    addToQueue(s, p);
    applyLoadAll(p, board(3), 10, null);
    applyStep(s, p, step(9.5, 100, { compact: true }), T0);
    let score = 9.5;
    for (const [gain, evaluations] of [
      [1e-8, 4],
      [1e-12, 3],
      [0, 2],
      [2e-9, 5],
      [1e-6, 1],
    ] as const) {
      const before = p.sinceGain;
      score *= 1 - gain;
      const c = applyStep(s, p, step(gain > 0 ? score : null, evaluations), T0);
      expect(p.sinceGain).toBe(c.counted ? 0 : before + evaluations);
    }
    expect(p.sinceGain).toBe(0);
  });

  it("measures a dealt record from its own best", () => {
    const s = advanced();
    const p = newProblem({ family: "polygon", N: 24, M: 30, P: 3 }, "loose", T0);
    addToQueue(s, p);
    p.phase = "ready";
    p.board = board(3);
    p.best = 10;
    p.floor = 10;
    p.leader = { score: 10, name: "Bob", id: 4 };
    applyStep(s, p, step(null, 6), T0);
    expect(p).toMatchObject({ progressBest: 10, sinceGain: 6 });
    applyStep(s, p, step(10 * (1 - 2e-6), 4), T0);
    expect(p).toMatchObject({ progressBest: 10 * (1 - 2e-6), sinceGain: 0 });
  });

  it("takes any improvement that counts as progress until Auto-advance is owned", () => {
    const s = newGame(T0, 1);
    s.settings.tolerance = 1e-3;
    const p = newProblem({ family: "polygon", N: 24, M: 30, P: 3 }, "open", T0);
    addToQueue(s, p);
    applyLoadAll(p, board(3), 10, null);
    applyStep(s, p, step(9.5, 100, { compact: true }), T0);
    applyStep(s, p, step(9.5 * (1 - 1e-6), 8), T0);
    expect(p.sinceGain).toBe(0);
    s.owned.push("advance");
    applyStep(s, p, step(9.5 * (1 - 2e-6), 8), T0);
    expect(p.sinceGain).toBe(8);
  });

  it("counts every evaluation run on a problem, clicks' and auto-eval's alike", () => {
    const s = advanced();
    const p = held(s, "24/30/60");
    applyStep(s, p, step(null, 4, { click: true }), T0);
    applyStep(s, p, step(null, 6, { click: false }), T0);
    expect(p).toMatchObject({ evaluations: 10, sinceGain: 10 });
    expect(s.stats).toMatchObject({ evaluations: 10, clicks: 1 });
  });
});

describe("Tighter Auto-advance", () => {
  /** Three problems with records in three slots, the next deal not yet earned. */
  function full(): { s: GameState; q: ProblemState[] } {
    const s = advanced();
    const q = ["24/30/60", "21/21/40", "27/27/80"].map((k) => held(s, k));
    s.dealer.tokens = 0;
    s.dealer.dealt = 3;
    return { s, q };
  }
  const o = { slots: 3 };

  it("drops a problem that ran its patience without progress, once a new one can take its slot", () => {
    const { s, q } = full();
    q[0].sinceGain = 999;
    expect(advancePlan(s, o)).toEqual({ replace: null, due: null });
    q[0].sinceGain = 1000;
    // due, but the next deal is not earned yet: it stays, and the lanes keep to the others
    expect(advancePlan(s, o)).toEqual({ replace: null, due: q[0] });
    // a slot earns a problem per 300 clicks: three slots, one every 100 here, or every 1,000
    // evaluations of auto-eval
    countEvaluations(s, 99, true);
    expect(advancePlan(s, o).replace).toBeNull();
    countEvaluations(s, 9, false);
    expect(advancePlan(s, o).replace).toBeNull();
    countEvaluations(s, 1, false);
    expect(advancePlan(s, o).replace).toBe(q[0]);
    // the page deals the replacement, then drops the problem as Drop does: the queue stays full
    const next = drawProblem(s.dealer, [q[0], { family: "polygon", N: 30, M: 30, P: 60 }], seenKeys(s))!;
    expect(next).toEqual({ family: "polygon", N: 30, M: 30, P: 60 });
    expect(drop(s, q[0].key, T0)).toBe(true);
    takeToken(s.dealer);
    addToQueue(s, newProblem(next, "open", T0));
    expect(slotted(s).map((p) => p.key)).toEqual(["21/21/40", "27/27/80", "30/30/60"]);
    // it left for good: never dealt straight back
    expect(s.past.map((p) => p.key)).toEqual(["24/30/60"]);
    expect(seenKeys(s).has("24/30/60")).toBe(true);
    expect(drawProblem(s.dealer, [q[0]], seenKeys(s))).toBeNull();
    // the deal is spent: the next problem due waits for the next one
    q[1].sinceGain = 5000;
    expect(advancePlan(s, o)).toEqual({ replace: null, due: q[1] });
  });

  it("drops the problem longest without progress first", () => {
    const { s, q } = full();
    s.dealer.tokens = 1;
    q[1].sinceGain = 3000;
    q[2].sinceGain = 1500;
    expect(leaveReason(s, q[1])).toBe("stalled");
    expect(advancePlan(s, o).replace).toBe(q[1]);
  });

  it("never drops a problem for the runs that ended on it: a problem allows any number of runs", () => {
    const { s, q } = full();
    s.dealer.tokens = 3;
    for (const p of q) p.endedRuns = 50;
    expect(q.map((p) => leaveReason(s, p))).toEqual([null, null, null]);
    expect(advancePlan(s, o)).toEqual({ replace: null, due: null });
  });

  it("keeps every problem with Never, and a best that could not be sent without a name", () => {
    const { s, q } = full();
    s.dealer.tokens = 3;
    q[0].sinceGain = 1e6;
    s.settings.patience = null;
    expect(advancePlan(s, o)).toEqual({ replace: null, due: null });
    // the lanes' order still knows when a problem has stalled
    expect(stallAfter(s)).toBe(1000);
    s.settings.patience = 20000;
    expect(stallAfter(s)).toBe(20000);
    expect(advancePlan(s, o).replace).toBe(q[0]);
    // without a name, an unsent best would be lost: it stays
    s.consent = false;
    q[0].best = 9;
    expect(leaveReason(s, q[0])).toBeNull();
    expect(advancePlan(s, o).replace).toBeNull();
  });

  it("marks a dropped problem with an unsent best as leaving, and frees its slot for the replacement", () => {
    const { s, q } = full();
    s.dealer.tokens = 1;
    q[2].best = 9;
    q[2].sinceGain = 1000;
    expect(advancePlan(s, o).replace).toBe(q[2]);
    expect(drop(s, q[2].key, T0)).toBe(false);
    expect(q[2].leaving).toBe(true);
    expect(slotted(s)).toHaveLength(2);
    // a leaving problem is not due again
    expect(advancePlan(s, o).due).toBeNull();
  });
});

describe("Tighter lanes with Auto-advance", () => {
  const owned = new Set<UpgradeId>(["auto1", "advance"]);
  function queue(sinceGain: number[]): ProblemState[] {
    return ["24/30/60", "21/21/40", "27/27/80"].map((k, i) => {
      const [N, M, P] = k.split("/").map(Number);
      const p = newProblem({ family: "polygon", N, M, P }, "open", T0);
      p.phase = "ready";
      p.run = run(1);
      p.sinceGain = sinceGain[i];
      return p;
    });
  }
  const target = (q: ProblemState[], current: string | null, stall = 1000) =>
    autoTarget({ lane: 0, queue: q, focus: q[0].key, busy: new Set(), owned, current, stall })?.key;

  it("keep a lane on its problem while it makes progress, then go to the freshest", () => {
    const q = queue([500, 0, 200]);
    expect(target(q, q[0].key)).toBe(q[0].key);
    q[0].sinceGain = 1000;
    expect(target(q, q[0].key)).toBe(q[1].key);
    // a stalled problem gives way to any problem still making progress
    q[1].sinceGain = 1100;
    expect(target(q, q[1].key)).toBe(q[2].key);
  });

  it("do not go in circles among problems that stopped making progress", () => {
    // every problem stalled, Never: one lane, jobs of 10 evaluations, no progress anywhere
    const q = queue([1000, 1000, 1000]);
    let current: string | null = null;
    let moves = 0;
    for (let job = 0; job < 600; job++) {
      const key = target(q, current)!;
      if (key !== current) moves++;
      current = key;
      q.find((p) => p.key === key)!.sinceGain += 10;
    }
    // a lane moves on once another problem is a whole patience fresher: 6,000 evaluations, 7 runs at most
    expect(moves).toBeLessThanOrEqual(7);
    // and the work is shared out rather than spent on one problem
    for (const p of q) expect(p.sinceGain).toBeGreaterThan(2000);
    // the old rule (always the fewest since progress) opened a new run on almost every job
    const old = queue([1000, 1000, 1000]);
    let last: string | null = null;
    let oldMoves = 0;
    for (let job = 0; job < 600; job++) {
      const key = target(old, null)!;
      if (key !== last) oldMoves++;
      last = key;
      old.find((p) => p.key === key)!.sinceGain += 10;
    }
    expect(oldMoves).toBeGreaterThan(500);
  });
});
