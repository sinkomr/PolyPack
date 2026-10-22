import { describe, expect, it } from "vitest";
import type { PackingConfig } from "@polypack/geometry";
import {
  addToQueue,
  applyAnswer,
  applyLoadAll,
  applyStep,
  markSending,
  newGame,
  newProblem,
  revealed,
} from "../src/tighter/game";
import { grant } from "../src/tighter/cheats";
import { confirmedCycleEarned } from "../src/tighter/standing";

// The local-only cheats (development builds): points from nowhere, kept out of the confirmation logic.

const T0 = 1_000_000;
const board = (shift = 0): PackingConfig => ({
  N: 24,
  M: 30,
  P: 3,
  pieces: [0, 1, 2].map((i) => ({ x: 3 * i + shift, y: 0, theta: 0 })),
  container_phi: 0,
});

describe("Tighter cheats", () => {
  it("add record points to spend, and on request as earned this cycle", () => {
    const s = newGame(T0, 1);
    expect(grant(s, { rp: 1000 })).toEqual({ rp: 1000, standing: 0 });
    expect(s.rp).toBe(1000);
    expect(s.rpEarned).toBe(0);
    expect(s.standing.cycleEarned).toBe(0);
    // the panels where they are spent open
    expect(revealed(s, "points") && revealed(s, "upgrades")).toBe(true);
    grant(s, { rp: 250_000, earned: true });
    expect(s.rp).toBe(251_000);
    expect(s.rpEarned).toBe(250_000);
    expect(s.standing.cycleEarned).toBe(250_000);
    // counted as confirmed: a reset may use them
    expect(confirmedCycleEarned(s)).toBe(250_000);
  });

  it("add whole standing points to spend, and nothing for an amount that is not a positive number", () => {
    const s = newGame(T0, 1);
    expect(grant(s, { standing: 2.7 })).toEqual({ rp: 0, standing: 2 });
    expect(s.standing.points).toBe(2);
    expect(s.standing.total).toBe(0);
    for (const n of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(grant(s, { rp: n, standing: n })).toEqual({ rp: 0, standing: 0 });
    expect(s.rp).toBe(0);
    expect(s.standing.points).toBe(2);
  });

  it("are never taken back by an answer of the server", () => {
    const s = newGame(T0, 1);
    s.name = "Ada";
    s.consent = true;
    const p = newProblem({ N: 24, M: 30, P: 3 }, "open", T0);
    addToQueue(s, p);
    applyLoadAll(p, board(), 10, null);
    applyStep(
      s,
      p,
      {
        evaluations: 100,
        best: board(1),
        score: 9.5,
        run: { method: "mc_compress", params: {}, seed: 1, budget: { evals: 100 } },
        ms: 1,
        ended: false,
        click: true,
      },
      T0,
    );
    const paid = s.rp;
    grant(s, { rp: 500, earned: true });
    // the record's own points ride with its send; the granted ones belong to no problem
    markSending(p, 9.5, "Ada", null, T0);
    expect(p.sending!.rp).toBe(paid);
    applyAnswer(s, p, null, 9.5, { kind: "behind", score: 9.5, leaderScore: 9.0 }, T0);
    expect(s.rp).toBeCloseTo(500, 9);
    expect(s.rpEarned).toBeCloseTo(500, 9);
  });
});
