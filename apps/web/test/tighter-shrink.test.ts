import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { run } from "@polypack/solver";
import { shrinkRepairMethod } from "../../../packages/solver/src/methods/shrink_repair";
import { HELP } from "../src/tighter/help";
import type { How } from "../src/tighter/how";
import { methodGame } from "../src/tighter/methods";
import type { RunView } from "../src/tighter/methods";
import {
  SHRINK_BASE,
  SHRINK_SOLVER,
  SHRINK_STALL_EVALS,
  SHRINK_STALL_TOLERANCE,
} from "../src/tighter/methods/shrink_repair";
import { StallCounter, shrinkRepairRun } from "../src/tighter/methods/shrink_repair-run";
import { METHODS } from "../src/tighter/methods/worker";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import { presetParams, tuningLevels } from "../src/tighter/presets";
import { upgrade } from "../src/tighter/upgrades";

// shrink_repair in the game: its setting at every tuning level, and the rule that ends a run after
// 1,000 evaluations without progress, which only ends the run, so the site's solver replays it.

const text = (h: How) => (typeof h.text === "string" ? h.text : h.text.join(" "));
const all = (h: How) => [text(h), ...(h.math ?? []), ...(h.vars ?? []).flat(), h.note ?? ""].join(" ");

function loadAll(N: number, M: number, P: number): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
}

describe("Tighter shrink_repair's stop rule", () => {
  it("counts the evaluations since a score at least 10⁻⁵ below the one at the last progress", () => {
    expect([SHRINK_STALL_EVALS, SHRINK_STALL_TOLERANCE]).toEqual([1000, 1e-5]);
    const c = new StallCounter(2);
    // a gain of 0.9 × 10⁻⁵ is not progress, and the reference stays
    expect(c.see(2 * (1 - 0.9e-5))).toBe(false);
    expect(c.count).toBe(1);
    // nor is a smaller gain after it, though it beats the best
    expect(c.see(2 * (1 - 0.95e-5))).toBe(false);
    expect(c.count).toBe(2);
    // small gains that add up to 10⁻⁵ of the reference are, and move it
    expect(c.see(2 * (1 - 0.9e-5) * (1 - 0.2e-5))).toBe(false);
    expect(c.count).toBe(0);
    expect(c.see(2 * (1 - 0.9e-5) * (1 - 0.2e-5) * (1 - 0.5e-5))).toBe(false);
    expect(c.count).toBe(1);
    // exactly 10⁻⁵ is progress
    const d = new StallCounter(3);
    d.see(3 * (1 - 0.5e-5));
    expect([d.see(3 * (1 - 1e-5)), d.count]).toEqual([false, 0]);
    // an evaluation that was not valid counts as one without progress
    expect(c.see(null)).toBe(false);
    expect(c.count).toBe(2);
  });

  it("fires on the 1,000th evaluation in a row without progress", () => {
    const c = new StallCounter(5);
    for (let i = 1; i < SHRINK_STALL_EVALS; i++) expect(c.see(5)).toBe(false);
    expect(c.see(5)).toBe(true);
    expect(c.count).toBe(SHRINK_STALL_EVALS);
    // with its own limit and tolerance
    const d = new StallCounter(1, 3, 0.1);
    expect([d.see(0.95), d.see(0.92), d.see(0.91)]).toEqual([false, false, true]);
  });

  it("takes the first valid score as the reference when the start had none", () => {
    const c = new StallCounter(null, 3);
    expect(c.see(null)).toBe(false);
    expect(c.see(7)).toBe(false);
    expect(c.count).toBe(0);
    expect([c.see(7), c.see(6.99999), c.see(7.5)]).toEqual([false, false, true]);
  });

  it("is the definition open runs register, under the solver's name", () => {
    const named = METHODS.filter((m) => m.name === "shrink_repair");
    expect(named).toEqual([shrinkRepairRun]);
    expect(shrinkRepairRun.defaults).toEqual(shrinkRepairMethod.defaults);
    expect(shrinkRepairRun.schema).toBe(shrinkRepairMethod.schema);
  });

  it("ends a run that cannot improve after its start and 1,000 more evaluations, without another click", async () => {
    // 4 squares in a square, in the 2 × 2 grid (side 2, the optimum): touching squares
    const problem = { N: 4, M: 4, P: 4 };
    const start: PackingConfig = {
      ...problem,
      pieces: [
        [-0.5, -0.5],
        [0.5, -0.5],
        [-0.5, 0.5],
        [0.5, 0.5],
      ].map(([x, y]) => ({ x, y, theta: Math.PI / 4 })),
      container_phi: 0,
    };
    const r = new OpenRun({
      problem,
      method: "shrink_repair",
      params: presetParams("shrink_repair", 0),
      budget: { evals: 100_000 },
      seed: 11,
      start,
    });
    // the step that reaches the 1,001st evaluation is all the run needs to end
    await r.step(SHRINK_STALL_EVALS);
    await r.finished;
    const s = r.state();
    expect(s).toMatchObject({ ended: true, closed: false, evaluations: 1 + SHRINK_STALL_EVALS });
    expect(s.score).toBeCloseTo(2, 9);
  });
});

describe("Tighter shrink_repair runs, as the site's solver replays them", () => {
  it("are the solver's own run with the same budget, stepped as clicks", async () => {
    const problem = { N: 21, M: 24, P: 40 };
    const start = loadAll(21, 24, 40);
    const params = presetParams("shrink_repair", 0);
    const r = new OpenRun({ problem, method: "shrink_repair", params, budget: { evals: 100_000 }, seed: 5, start });
    let s = await r.step(0);
    for (let i = 0; i < 29; i++) s = await r.step(1);
    while (s.evaluations < 300) s = await r.step(Math.min(10, 300 - s.evaluations));
    expect(s.evaluations).toBe(300);
    const closed = await r.close();
    expect(closed).toMatchObject({ ended: true, closed: true, evaluations: 300 });
    const replay = await run(problem, {
      method: "shrink_repair",
      params,
      start,
      seed: 5,
      budget: { evals: 300 },
      finalPolish: false,
    });
    expect(replay.evaluations).toBe(300);
    expect(closed.best!.pieces).toEqual(replay.best!.pieces);
    expect(closed.score).toBe(replay.score);
    // the run made the board smaller, so the replay has something to match
    expect(closed.score!).toBeLessThan(replay.trace[0][1]);
  });

  it("end by the stop rule exactly where a run of that budget ends", async () => {
    // 5 squares from Load all: the run gets close to the optimum (about 2.7071) and then stalls
    const problem = { N: 4, M: 4, P: 5 };
    const start = loadAll(4, 4, 5);
    const params = presetParams("shrink_repair", 0);
    const r = new OpenRun({ problem, method: "shrink_repair", params, budget: { evals: 100_000 }, seed: 7, start });
    const s = await r.step(20_000);
    expect(s).toMatchObject({ ended: true, closed: false });
    expect(s.evaluations).toBeGreaterThan(1 + SHRINK_STALL_EVALS);
    expect(s.evaluations).toBeLessThan(20_000);
    expect(s.score!).toBeLessThan(2.71);
    const replay = await run(problem, {
      method: "shrink_repair",
      params,
      start,
      seed: 7,
      budget: { evals: s.evaluations },
      finalPolish: false,
    });
    expect(replay.evaluations).toBe(s.evaluations);
    expect(s.best!.pieces).toEqual(replay.best!.pieces);
    expect(s.score).toBe(replay.score);
  });
});

describe("Tighter shrink_repair's setting and texts", () => {
  it("runs the game setting at every tuning level, with more work per scoring at each", () => {
    expect(tuningLevels("shrink_repair")).toBe(3);
    expect(presetParams("shrink_repair", 0)).toEqual(SHRINK_BASE);
    const work = [0, 1, 2, 3].map((l) => {
      const p = presetParams("shrink_repair", l);
      expect(p).toMatchObject(SHRINK_BASE);
      return resolvedParams("shrink_repair", p).evaluationWork;
    });
    expect(work).toEqual([4000, 6000, 9000, 14000]);
    // the card's solver numbers are the solver's
    for (const [k, v] of Object.entries(SHRINK_SOLVER)) expect(shrinkRepairMethod.defaults[k], k).toBe(v);
    expect(methodGame("shrink_repair").tunedDefaults).toEqual({
      evaluationWork: shrinkRepairMethod.defaults.evaluationWork,
    });
  });

  it("quote the setting and the stop rule on the method card", () => {
    const card = upgrade("shrink");
    const how = all(card.how);
    expect(card.effect).toBe(
      "You can run shrink_repair, which shrinks the container and then moves the pieces until none overlap.",
    );
    expect(how).toContain("A run ends by itself after 1,000 evaluations without progress.");
    expect(how).toContain("Progress is a score at least 10⁻⁵ (relative) below the reference score.");
    expect(how).toContain(`(1 − 10<sup>−5</sup>) × <var>s</var><sub>ref</sub>`);
    expect(how).toContain(`the run ends when <var>n</var> = 1,000`);
    expect([SHRINK_BASE.shrinkRatio, SHRINK_BASE.maxShrinkRatio, SHRINK_BASE.minShrinkRatio]).toEqual([
      0.001, 0.004, 0.0001,
    ]);
    expect(how).toContain("the shrink ratio, 0.1 % at first");
    expect(how).toContain("up to 0.4 %");
    expect(how).toContain(`min(0.004, 1.25 × <var>r</var>)`);
    expect(how).toContain("Once r is below 0.01 %");
    expect([SHRINK_BASE.patience, SHRINK_BASE.explorePatience, SHRINK_BASE.strikes]).toEqual([6, 12, 1]);
    expect(how).toContain("after 6 rounds in a row that do not lower the overlap by 0.1 %, or after 24 rounds in all");
    expect(how).toContain("fails the same way after 12 rounds in a row, or 48 in all");
    expect(how).toContain("the best of 72 sampled spots");
    expect(how).toContain("4,000 at first");
    // the old setting's rules are gone
    expect(how).not.toMatch(/100,000|restarts from random|5 %/);
  });

  it("call level 0 of the tuning card the card's setting, and keep the other cards' wording", () => {
    expect(text(upgrade("tuneShrink").how)).toContain(
      "from level 0 (the setting on the shrink_repair card) to level 3.",
    );
    expect(upgrade("tuneShrink").how.math).toEqual(["<code>evaluationWork</code> = 4000, 6000, 9000, 14000"]);
    expect(text(upgrade("tuneMc").how)).toContain("from level 0 (the solver's defaults)");
    // its bench was run on worked boards, the others' on Compact boards
    expect(text(upgrade("tuneShrink").how)).toContain("boards that mc_compress had worked for 8,000 evaluations");
    expect(text(upgrade("tuneShrink").how)).toContain("An evaluation takes up to 2.8 times as long at the top level");
    expect(text(upgrade("tuneShrink").how)).not.toContain("three test problems");
    expect(text(upgrade("tuneMc").how)).toContain("three test problems");
  });

  it("say when a run ends, in the help and in the run-end event", () => {
    const g = methodGame("shrink_repair");
    expect(g.runEnds).toBe(
      "A shrink_repair run ends once its last 1,000 evaluations have not made its best score 10⁻⁵ (relative) smaller.",
    );
    expect(text(HELP.counts as How)).toContain(g.runEnds);
    const view = (evaluations: number): RunView => ({
      evaluations,
      budget: 100_000,
      params: {},
      last: 2.1,
      runBest: 2,
      found: 2,
      startScore: 2.05,
      problemBest: 2,
    });
    expect(g.endedText!(view(2011), "5 squares in a square")).toBe(
      "The run on 5 squares in a square ended after 2,011 evaluations, because its last 1,000 did not make its best score 10⁻⁵ (relative) smaller.",
    );
    // a run that used its whole budget keeps the shared sentence
    expect(g.endedText!(view(100_000), "5 squares in a square")).toBeNull();
  });
});
