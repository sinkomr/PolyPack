import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { run } from "@polypack/solver";
import { addToQueue, applyLoadAll, newGame, newProblem } from "../src/tighter/game";
import { HELP, PIPELINE } from "../src/tighter/help";
import type { How } from "../src/tighter/how";
import { methodGame, runSetup } from "../src/tighter/methods";
import type { RunView } from "../src/tighter/methods";
import {
  HARDEN_INTERVAL,
  HARDEN_LARGE_P,
  HARDEN_NOISE_LARGE,
  HARDEN_NOISE_SMALL,
  HARDEN_RIGID_FROM_N,
  HARDEN_SETTLE,
  HARDEN_STEPS,
  RIGID_COVER,
  discCover,
  hardenGame,
  hardenLarger,
  hardenNoise,
  hardenPath,
  hardenRunBudget,
  hardenRunParams,
  hardenRunSteps,
} from "../src/tighter/methods/harden";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import type { RunState } from "../src/tighter/open-run";
import { presetParams } from "../src/tighter/presets";
import { methodParams, owning, upgrade } from "../src/tighter/upgrades";

const text = (h: How) => (typeof h.text === "string" ? h.text : h.text.join(" "));
const prose = (h: How) => [text(h), ...(h.vars ?? []).map(([, v]) => v), h.note ?? ""].join(" ");

function loadAll(N: number, M: number, P: number): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
}

const view = (over: Partial<RunView> = {}): RunView => ({
  evaluations: 130,
  budget: 361,
  params: {},
  last: 10.38,
  runBest: 10,
  found: 10.38,
  startScore: 10,
  problemBest: 10,
  ...over,
});

describe("harden in Tighter", () => {
  it("takes its pass length, its first setting and its first noise from the solver's defaults", () => {
    const d = resolvedParams("harden", {});
    expect(HARDEN_STEPS).toBe((d.compressSteps as number) + (d.morphSteps as number) + (d.settleSteps as number));
    expect(HARDEN_SETTLE).toBe(d.settleSteps);
    expect(HARDEN_INTERVAL).toBe(d.evaluationInterval);
    expect(HARDEN_NOISE_SMALL).toBe(d.noise);
    expect(d.restarts).toBe(0);
  });

  it("gives a run one pass and the start's scoring: 361, 241, 181 or 121 evaluations, 11,520 steps at every level", () => {
    const budgets = [0, 1, 2, 3].map((l) => hardenRunBudget(presetParams("harden", l)));
    expect(budgets).toEqual([361, 241, 181, 121]);
    for (let l = 0; l <= 3; l++) {
      const params = presetParams("harden", l);
      expect(hardenRunBudget(params)).toBe(Math.ceil(HARDEN_STEPS / ((params.evaluationInterval as number) ?? 32)) + 1);
      expect(hardenRunSteps(params)).toBe(11_520);
    }
    // a parameter that is not a step count reads as the default
    expect(hardenRunBudget({ evaluationInterval: "x" })).toBe(361);
    expect(hardenRunBudget({ evaluationInterval: 0 })).toBe(361);
  });

  it("sets the noise by the pieces and the shape path by the sides, keeping the player's setting", () => {
    expect(HARDEN_LARGE_P).toBe(60);
    for (const P of [6, 40, 59]) expect(hardenNoise(P), String(P)).toBe(8);
    for (const P of [60, 80, 300]) expect(hardenNoise(P), String(P)).toBe(2);
    expect(HARDEN_NOISE_LARGE).toBe(2);
    expect(HARDEN_RIGID_FROM_N).toBe(21);
    for (const N of [21, 36, 100]) expect(hardenPath(N), String(N)).toBe("rigid");
    for (const N of [0, 3, 20]) expect(hardenPath(N), String(N)).toBe("harden");
    const base = { evaluationInterval: 64 };
    expect(hardenRunParams(base, { N: 21, P: 40 })).toEqual({ evaluationInterval: 64, noise: 8, path: "rigid" });
    expect(hardenRunParams(base, { N: 20, P: 60 })).toEqual({ evaluationInterval: 64, noise: 2, path: "harden" });
    expect(base).toEqual({ evaluationInterval: 64 });
    // the solver accepts what the game asks
    expect(resolvedParams("harden", hardenRunParams({}, { N: 21, P: 80 }))).toMatchObject({ noise: 2, path: "rigid" });
    // the inscribed disc covers more than the share the How quotes from 21 sides, and less below
    expect(RIGID_COVER).toBe(99.2);
    expect(100 * discCover(21)).toBeGreaterThan(RIGID_COVER);
    expect(100 * discCover(20)).toBeLessThan(RIGID_COVER);
  });

  it("opens a run with its noise, path and budget, while the player's parameters stay as they were", () => {
    const s = newGame(1_000, 7);
    const p = newProblem({ N: 21, M: 24, P: 40 }, "open", 1_000);
    addToQueue(s, p);
    const board = loadAll(21, 24, 40);
    applyLoadAll(p, board, 9.5, null);
    for (const [level, budget] of [
      [0, 361],
      [1, 241],
      [3, 121],
    ]) {
      const o = level ? owning(["harden", "tuneHarden"], { tuneHarden: level }) : owning(["harden"]);
      const base = methodParams(o, "harden");
      const asked = JSON.stringify(base);
      const setup = runSetup("harden", base, p);
      expect(setup).toEqual({ params: { ...base, noise: 8, path: "rigid" }, budget, start: board });
      // what main.ts compares to keep a run open between jobs is the player's own, unchanged
      expect(JSON.stringify(base)).toBe(asked);
      expect(JSON.stringify(methodParams(o, "harden"))).toBe(asked);
    }
    const big = newProblem({ N: 12, M: 30, P: 80 }, "open", 1_000);
    addToQueue(s, big);
    applyLoadAll(big, loadAll(12, 30, 80), 20, null);
    expect(runSetup("harden", {}, big).params).toEqual({ noise: 2, path: "harden" });
  });

  it("explains the run as the code runs it, with its numbers from the constants", () => {
    const how = hardenGame.how!("SELECT");
    const all = [text(how), ...(how.math ?? [])].join(" ");
    for (const n of ["11,500", "11,520", "87 %", "13 %", "99.2 %", "20 sides", "21 or more sides"])
      expect(all, n).toContain(n);
    expect(how.math).toContain(
      "<var>ν</var> = 8 when <var>P</var> &lt; 60, and <var>ν</var> = 2 when <var>P</var> ≥ 60",
    );
    expect(how.note).toMatch(/SELECT$/);
    expect(upgrade("harden").effect).toBe(
      "You can run harden, which squeezes your board in runs of 361 evaluations, with the gains near the end.",
    );
    // the old texts of a compress phase and of many passes a run are gone
    expect(prose(how)).not.toMatch(/compress|repeats it|100,000/i);
    // the help on runs and on pipelines says when a harden run ends
    expect(hardenGame.runEnds).toBe(
      "A harden run ends after its 11,520 momentum steps, 361 evaluations without harden tuning.",
    );
    expect(text(HELP.counts as How)).toContain(hardenGame.runEnds);
    expect(text(PIPELINE)).toContain(hardenGame.runEnds);
  });

  it("shows how much larger the run's latest packing is than the board, and how far the run has got", () => {
    const g = methodGame("harden");
    expect(hardenLarger(view())).toBeCloseTo(0.038, 12);
    expect(g.runNote!(view())).toBe(" · its latest packing is 3.8 % larger than your board");
    expect(g.runNote!(view({ last: 10.031 }))).toBe(" · its latest packing is 0.31 % larger than your board");
    // the run's own new best is the board
    expect(g.runNote!(view({ last: 9.9, problemBest: 9.9 }))).toBe(" · its latest packing is as small as your board");
    // nothing before the run has scored a packing of its own: its first evaluation is the board
    expect(g.runNote!(view({ evaluations: 1, last: 10 }))).toBe("");
    expect(g.runNote!(view({ last: null }))).toBe("");
    // the board before any best is known: the score the run opened from
    expect(g.runNote!(view({ problemBest: null }))).toBe(" · its latest packing is 3.8 % larger than your board");
    expect(g.stepNote!(view())).toBe(
      "The run is at 130 of 361 evaluations, and its latest packing is 3.8 % larger than your board.",
    );
    expect(g.stepNote!(view({ evaluations: 1, budget: 1_201 }))).toBe("The run is at 1 of 1,201 evaluations.");
    expect(g.endedText!(view({ evaluations: 361 }), "21-gons in a 24-gon, 40 pieces")).toBe(
      "The harden run on 21-gons in a 24-gon, 40 pieces ended after its last step, at 361 evaluations.",
    );
    // plain sentences, and never a seed
    for (const t of [g.runNote!(view()), g.stepNote!(view()), g.endedText!(view(), "T"), g.runEnds!])
      expect(t).not.toMatch(/[;—]|seed/i);
  });

  it(
    "ends a run by itself after its last step, with the packing a closed solver run makes",
    { timeout: 60_000 },
    async () => {
      const problem = { N: 21, M: 24, P: 6 };
      const start = loadAll(21, 24, 6);
      const seed = 12_345;
      const pass = async (base: Record<string, unknown>) => {
        const params = hardenRunParams(base, problem);
        const budget = hardenRunBudget(params);
        const r = new OpenRun({ problem, method: "harden", params, budget: { evals: budget }, seed, start });
        let s: RunState = await r.step(0);
        expect(s.evaluations).toBe(1);
        let clicks = 0;
        while (!s.ended && clicks < budget + 10) {
          s = await r.step(1);
          clicks++;
        }
        return { s, params, budget };
      };
      const { s, params, budget } = await pass({});
      expect(budget).toBe(361);
      expect(s).toMatchObject({ ended: true, closed: false });
      expect(s.error).toBeUndefined();
      expect(s.evaluations).toBeLessThanOrEqual(budget);
      expect(s.evaluations).toBeGreaterThan(budget / 2);
      expect(s.last).not.toBeNull();
      // the same run, made in one go by the solver
      const replay = await run(problem, {
        method: "harden",
        params,
        budget: { evals: budget },
        seed,
        start,
        finalPolish: false,
      });
      expect(s.score).toBe(replay.score);
      expect(s.best!.pieces).toEqual(replay.best!.pieces);
      // the top level makes the same moves and scores fewer of them: its last packing is the same
      const top = await pass(presetParams("harden", 3));
      expect(top.budget).toBe(121);
      expect(top.s).toMatchObject({ ended: true, closed: false });
      expect(top.s.last).toBe(s.last);
    },
  );
});
