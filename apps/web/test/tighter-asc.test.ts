import { describe, expect, it } from "vitest";
import { evaluate, findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { run } from "@polypack/solver";
import { addToQueue, applyLoadAll, newGame, newProblem } from "../src/tighter/game";
import { HELP, PIPELINE, runEndRules } from "../src/tighter/help";
import type { How } from "../src/tighter/how";
import { methodGame, runSetup } from "../src/tighter/methods";
import type { RunView } from "../src/tighter/methods";
import {
  ASC_COOLING,
  ASC_CYCLE_SWEEPS,
  ASC_HEAT,
  ascGame,
  ascRunBudget,
  ascRunParams,
  ascStepNote,
} from "../src/tighter/methods/asc";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import { presetParams, tuningLevels } from "../src/tighter/presets";
import { methodParams, owning, upgrade } from "../src/tighter/upgrades";

// asc runs warm, one cooling cycle a run (methods/asc.ts). asc is slow, so the runs here are on a
// tiny problem with small budgets.

const problem = { N: 21, M: 24, P: 8 };

function loadAll(): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < problem.P; k++) pieces.push(findFreeSpot(problem.N, pieces, 0, 0));
  return { ...problem, pieces, container_phi: 0 };
}

/** The board after Compact: 100 evaluations of mc_compress from Load all, at its best turn. */
async function compacted(): Promise<PackingConfig> {
  const r = await run(problem, {
    method: "mc_compress",
    params: { sweepsPerEvaluation: 10 },
    budget: { evals: 100 },
    seed: 1,
    start: loadAll(),
    finalPolish: false,
  });
  const e = evaluate(r.best!, { autoOrient: true });
  return { ...r.best!, container_phi: e.container!.phi };
}

const view = (over: Partial<RunView> = {}): RunView => ({
  evaluations: 310,
  budget: 2000,
  params: {},
  last: 6.341,
  runBest: 6.332318,
  found: 6.3405,
  startScore: 6.332318,
  problemBest: 6.332318,
  ...over,
});

const prose = (h: How) => (typeof h.text === "string" ? [h.text] : [...h.text]);

describe("Tighter's asc runs", () => {
  it("quote the solver's own defaults", () => {
    const d = resolvedParams("asc", {});
    expect(d.coolingRate).toBe(ASC_COOLING);
    expect(d.temperature).toBe(0);
    expect(ascGame.tunedDefaults).toEqual({
      sweepsPerEvaluation: d.sweepsPerEvaluation,
      stagnationSweeps: d.stagnationSweeps,
    });
  });

  it("last one cooling cycle: 20,000 sweeps over the sweeps per evaluation, at least 100", () => {
    expect(tuningLevels("asc")).toBe(3);
    expect([0, 1, 2, 3].map((l) => ascRunBudget(presetParams("asc", l)))).toEqual([2000, 1333, 1000, 667]);
    expect(ascRunBudget({})).toBe(ASC_CYCLE_SWEEPS / 10);
    expect(ascRunBudget({ sweepsPerEvaluation: 1000 })).toBe(100);
    // a value the solver would refuse is read as its default
    expect(ascRunBudget({ sweepsPerEvaluation: 0 })).toBe(2000);
  });

  it("open warm, at 0.0008 times the side of the board they start from", () => {
    const params = ascRunParams({}, { score: 6.332318 });
    expect(Object.keys(params)).toEqual(["temperature"]);
    expect(params.temperature).toBeCloseTo(0.0050659, 7);
    expect(params.temperature).toBe(ASC_HEAT * 6.332318);
    // the player's parameters stay, and the solver's bound holds
    expect(ascRunParams({ sweepsPerEvaluation: 30, stagnationSweeps: 4000 }, { score: 10 })).toEqual({
      sweepsPerEvaluation: 30,
      stagnationSweeps: 4000,
      temperature: ASC_HEAT * 10,
    });
    expect(ascRunParams({}, { score: 1e6 }).temperature).toBe(100);
    // with no board scored yet, cold as the solver's default
    expect(ascRunParams({}, { score: null })).toEqual({});
    expect(resolvedParams("asc", ascRunParams({}, { score: 6.332318 })).temperature).toBe(ASC_HEAT * 6.332318);
  });

  it("open from the player's parameters, which stay as they were, so a run is not reopened on every job", () => {
    const s = newGame(1_000, 7);
    const p = newProblem(problem, "open", 1_000);
    addToQueue(s, p);
    const board = loadAll();
    applyLoadAll(p, board, 9.5, null);
    const o = owning(["asc", "tuneAsc"], { tuneAsc: 3 });
    const base = methodParams(o, "asc");
    const asked = JSON.stringify(base);
    expect(runSetup("asc", base, p)).toEqual({
      params: { ...presetParams("asc", 3), temperature: ASC_HEAT * 9.5 },
      budget: 667,
      start: board,
    });
    expect(JSON.stringify(base)).toBe(asked);
    expect(methodGame("asc").runBudget).toBe(ascRunBudget);
  });

  it(
    "end by themselves at their budget, as the solver's own run of the same parameters, the side never growing",
    { timeout: 60_000 },
    async () => {
      const start = await compacted();
      const params = ascRunParams({}, { score: evaluate(start, { autoOrient: true }).score });
      const budget = 150;
      const r = new OpenRun({ problem, method: "asc", params, budget: { evals: budget }, seed: 2, start });
      expect(r.params.temperature).toBe(params.temperature);
      let s = await r.step(0);
      expect(s.ended).toBe(false);
      let before = s.score!;
      let steps = 0;
      while (!s.ended && steps++ < 30) {
        s = await r.step(10);
        expect(s.error).toBeUndefined();
        expect(s.score!).toBeLessThanOrEqual(before);
        before = s.score!;
      }
      expect(s).toMatchObject({ ended: true, closed: false, evaluations: budget });
      // the same run in the solver, to the bit
      const replay = await run(problem, {
        method: "asc",
        params,
        budget: { evals: budget },
        seed: 2,
        start,
        finalPolish: false,
      });
      expect(replay.evaluations).toBe(budget);
      expect(s.best!.pieces).toEqual(replay.best!.pieces);
      expect(s.score).toBe(replay.score);
      await r.close();
    },
  );

  it("say when a run used its cooling cycle, and leave other ends to the shared sentence", () => {
    const title = "21-gons in a 24-gon, 40 pieces";
    expect(ascGame.endedText!(view({ evaluations: 2000 }), title)).toBe(
      "The asc run on 21-gons in a 24-gon, 40 pieces finished its cooling cycle of 2,000 evaluations.",
    );
    expect(ascGame.endedText!(view({ evaluations: 1210 }), title)).toBeNull();
  });

  it("say why a click found nothing while the run is still loose", () => {
    expect(ascStepNote(view())).toBe(
      "This asc run loosens the packing before it squeezes it, so it seldom beats your best in its first few hundred evaluations. Its latest score is 6.341000, 0.137 % above your best.",
    );
    expect(ascStepNote(view({ last: null }))).toBe(
      "This asc run loosens the packing before it squeezes it, so it seldom beats your best in its first few hundred evaluations.",
    );
    // once the run has beaten its start, or at its end, nothing is added
    expect(ascStepNote(view({ found: 6.33, runBest: 6.33 }))).toBeNull();
    expect(ascStepNote(view({ evaluations: 2000 }))).toBeNull();
    expect(ascGame.stepNote).toBe(ascStepNote);
    // the run line already says where the run is in its budget
    expect(ascStepNote(view())).not.toMatch(/of 2,000/);
  });

  it("explain the warm start and the cycle on the card, the help and the tuning card", () => {
    const card = upgrade("asc");
    expect(card.effect).toBe(
      "You can run asc, a search that loosens the packing and squeezes it again, so tight boards can still shrink.",
    );
    const text = prose(card.how).join(" ");
    expect(text).toContain("The temperature T falls by 0.05 % each sweep");
    expect(text).toContain("A run is one cooling cycle of about 20,000 sweeps");
    expect(text).toContain("or earlier after 2,000 sweeps without a gain (4,000 at the top level of asc tuning)");
    expect(card.how.math).toContain("<var>T</var> = 0.0008 × <var>s</var><sub>0</sub> × 0.9995<sup><var>k</var></sup>");
    expect(card.how.math).toContain("<var>B</var> = round(20,000 / <var>n</var>)");
    expect(new Map(card.how.vars).get("<var>B</var>")).toBe(
      "the evaluations in one run, 2,000 at first (1,333, 1,000 and 667 with asc tuning)",
    );
    expect(new Map(card.how.vars).get("<var>n</var>")).toBe(
      "sweeps per evaluation, 10 at first (15, 20 and 30 with asc tuning)",
    );
    // the help on runs and on pipelines says when an asc run ends
    const ends =
      "An asc run ends after one cooling cycle of about 20,000 sweeps, which is 2,000 evaluations at first and fewer with asc tuning.";
    expect(runEndRules()).toContain(ends);
    expect(prose(HELP.counts as How).join(" ")).toContain(ends);
    expect(prose(PIPELINE).join(" ")).toContain(ends);
    expect(prose(upgrade("tuneAsc").how).join(" ")).toContain(
      "An evaluation takes up to 3 times as long at the top level",
    );
  });
});
