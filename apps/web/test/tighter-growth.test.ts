import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { addToQueue, applyLoadAll, applyStep, newGame, newProblem } from "../src/tighter/game";
import type { GameState, ProblemState, RunRecord } from "../src/tighter/game";
import { runSetup } from "../src/tighter/methods";
import { GROWTH_BASES, growthStart } from "../src/tighter/methods/ls_growth";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import { presetParams } from "../src/tighter/presets";
import { RUN_BUDGET, methodParams, owning } from "../src/tighter/upgrades";

const board = (N: number, M: number, P: number, shift = 0): PackingConfig => {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces: pieces.map((q) => ({ ...q, x: q.x + shift })), container_phi: 0 };
};

const record = (method: string, seed = 1): RunRecord => ({ method, params: {}, seed, budget: { evals: 10 } });

/** A loaded problem in a game, its board at side 10. */
function loaded(N = 21, M = 24, P = 8): { s: GameState; p: ProblemState } {
  const s = newGame(1_000, 7);
  const p = newProblem({ N, M, P }, "open", 1_000);
  addToQueue(s, p);
  applyLoadAll(p, board(N, M, P), 10, null);
  return { s, p };
}

/** A run's step that makes the board `to` at side `score`, as main.ts settles it. */
function improve(s: GameState, p: ProblemState, method: string, to: PackingConfig, score: number): void {
  applyStep(s, p, { evaluations: 10, best: to, score, run: record(method), ms: 1, ended: false, click: true }, 2_000);
  expect(p.best).toBe(score);
}

describe("Tighter ls_growth: one growth a run", () => {
  it("runs one growth at every tuning level, with the solver's other defaults", () => {
    const o = owning(["growth", "tuneGrowth"], { tuneGrowth: 3 });
    const defaults = resolvedParams("ls_growth", {});
    for (let l = 0; l <= 3; l++) {
      expect(presetParams("ls_growth", l).runs).toBe(1);
      expect(methodParams(o, "ls_growth", l).runs).toBe(1);
      const r = resolvedParams("ls_growth", methodParams(o, "ls_growth", l));
      expect(r).toMatchObject({ runs: 1, initialShrink: defaults.initialShrink, growthRate: defaults.growthRate });
    }
    // without the tuning card too
    expect(methodParams(owning(["growth"]), "ls_growth")).toEqual({ runs: 1 });
  });

  it(
    "ends a run by itself at its jam, well within its budget, on 8 pieces after Compact",
    { timeout: 60_000 },
    async () => {
      const problem = { N: 21, M: 24, P: 8 };
      const compact = new OpenRun({
        problem,
        method: "mc_compress",
        params: { sweepsPerEvaluation: 10 },
        budget: { evals: RUN_BUDGET },
        seed: 1,
        start: board(21, 24, 8),
      });
      const c = await compact.step(100);
      expect(c.evaluations).toBe(101);
      await compact.close();
      const r = new OpenRun({
        problem,
        method: "ls_growth",
        params: presetParams("ls_growth", 0),
        budget: { evals: RUN_BUDGET },
        seed: 2,
        start: c.best!,
      });
      // early on the pieces are still small: the latest packing scored is larger than the start
      let s = await r.step(20);
      expect(s.last!).toBeGreaterThan(s.score!);
      while (!s.ended && s.evaluations < 20_000) s = await r.step(50);
      expect(s).toMatchObject({ ended: true, closed: false });
      expect(s.evaluations).toBeLessThan(5_000);
      await r.close();
    },
  );
});

describe("Tighter ls_growth: a series starts every run from one board", () => {
  it("keeps the series' board while the board is ls_growth's own, and starts anew after another method's gain", () => {
    const { s, p } = loaded();
    // Compact's board: the series starts from it
    improve(s, p, "mc_compress", board(21, 24, 8, 0.01), 9);
    const compacted = p.board!;
    expect(growthStart(p)).toBe(compacted);
    // a win of ls_growth: the next run still starts from the series' board, not from the win
    improve(s, p, "ls_growth", board(21, 24, 8, 0.02), 8.8);
    expect(p.board).not.toBe(compacted);
    expect(growthStart(p)).toBe(compacted);
    expect(runSetup("ls_growth", methodParams(owning(["growth"]), "ls_growth"), p).start).toBe(compacted);
    // a run that found nothing leaves the board as it was: the same board again
    expect(growthStart(p)).toBe(compacted);
    // another method improves the board: a new series from that board
    improve(s, p, "mc_compress", board(21, 24, 8, 0.03), 8.7);
    const tightened = p.board!;
    expect(growthStart(p)).toBe(tightened);
    improve(s, p, "ls_growth", board(21, 24, 8, 0.04), 8.6);
    expect(growthStart(p)).toBe(tightened);
    // the other methods open from the best board as before
    expect(runSetup("harden", {}, p).start).toBe(p.board);
  });

  it("starts a new series from the board when it knows none, or one of another shape", () => {
    const { s, p } = loaded(21, 24, 9);
    // the board is ls_growth's, but no series board is known (after a reload): the board itself
    improve(s, p, "ls_growth", board(21, 24, 9, 0.01), 9);
    const won = p.board!;
    expect(growthStart(p)).toBe(won);
    improve(s, p, "ls_growth", board(21, 24, 9, 0.02), 8.9);
    expect(growthStart(p)).toBe(won);
    // a stored board of another shape under the same key is never used
    const other = loaded(21, 24, 10);
    other.p.key = p.key;
    improve(other.s, other.p, "ls_growth", board(21, 24, 10, 0.01), 9);
    expect(growthStart(other.p)).toBe(other.p.board);
    expect(growthStart(other.p).P).toBe(10);
  });

  it(`keeps the series of the ${GROWTH_BASES} problems stored last, dropping the oldest`, () => {
    const ps = Array.from({ length: GROWTH_BASES + 1 }, (_, i) => {
      const { s, p } = loaded(21, 24, 11);
      p.key = `growth-test/${i}`;
      return { s, p, base: growthStart(p) };
    });
    // the oldest was dropped: its board, now ls_growth's, starts a new series
    const first = ps[0];
    improve(first.s, first.p, "ls_growth", board(21, 24, 11, 0.01), 9);
    expect(growthStart(first.p)).toBe(first.p.board);
    expect(growthStart(first.p)).not.toBe(first.base);
    // the others keep theirs
    for (const x of ps.slice(2)) {
      improve(x.s, x.p, "ls_growth", board(21, 24, 11, 0.01), 9);
      expect(growthStart(x.p)).toBe(x.base);
    }
  });
});
