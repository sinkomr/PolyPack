import { describe, expect, it } from "vitest";
import { evaluate, findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { addToQueue, applyLoadAll, applyStep, newGame, newProblem } from "../src/tighter/game";
import { HELP, PIPELINE } from "../src/tighter/help";
import type { How } from "../src/tighter/how";
import { methodGame, warmIn, warmupOf } from "../src/tighter/methods";
import type { RunView } from "../src/tighter/methods";
import {
  MORPH_LONGEST,
  MORPH_PRESET,
  MORPH_RUN,
  MORPH_SOLVER,
  MORPH_STAGE,
  MORPH_START,
  MORPH_WARMUP,
} from "../src/tighter/methods/morph";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import { isTunable, presetParams, tuningLevels } from "../src/tighter/presets";
import { TUNING, UPGRADES, methodParams, owning, upgrade } from "../src/tighter/upgrades";

const morph = methodGame("morph");
const polygons = { N: 24, M: 27, P: 40, score: 6.35 };
const circles = { N: 0, M: 6, P: 40, score: 7.1 };
const prose = (h: How) => (typeof h.text === "string" ? [h.text] : [...h.text]);

/** A morph run as its texts see it, at `evaluations` with a warm-up of `warmup`. */
const view = (evaluations: number, warmup = MORPH_WARMUP): RunView => ({
  evaluations,
  budget: 100_000,
  params: resolvedParams("morph", MORPH_PRESET),
  warmup,
  last: null,
  runBest: 6.4,
  found: null,
  startScore: 6.4,
  problemBest: 6.4,
});

function loadAll(N: number, M: number, P: number): PackingConfig {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
}

describe("Tighter's morph", () => {
  it("runs the solver's own morph in 2 stages, its stage length from the solver's defaults", () => {
    const defaults = resolvedParams("morph", {});
    expect(MORPH_SOLVER).toEqual({
      innerIterations: defaults.innerIterations,
      outerIterations: defaults.outerIterations,
    });
    expect(defaults.stages).toBe(7);
    expect([MORPH_START, MORPH_STAGE, MORPH_WARMUP, MORPH_RUN, MORPH_LONGEST]).toEqual([2, 720, 722, 1442, 2882]);
    // the game's setting, at every level and for every owner, and still no tuning card
    expect(presetParams("morph", 0)).toEqual({ stages: 2 });
    expect(presetParams("morph", 3, true)).toEqual({ stages: 2 });
    expect(methodParams(owning(["morph"]), "morph")).toEqual({ stages: 2 });
    expect(resolvedParams("morph", methodParams(owning(["morph"]), "morph")).stages).toBe(2);
    expect(tuningLevels("morph")).toBe(0);
    expect(isTunable("morph")).toBe(false);
    expect(TUNING.morph).toBeUndefined();
    expect(UPGRADES.some((u) => u.name === "morph tuning")).toBe(false);
    // the preset in the table is not the one a run gets: a run cannot change it
    const p = presetParams("morph", 0);
    p.stages = 9;
    expect(presetParams("morph", 0)).toEqual({ stages: 2 });
  });

  it("keeps the start's scorings and the disc stage, 722 evaluations, out of the count since progress", () => {
    // a run's own parameters, the shop's level-0 preset alone, and other stage lengths
    expect(warmupOf("morph", resolvedParams("morph", MORPH_PRESET), polygons)).toBe(722);
    expect(warmupOf("morph", presetParams("morph", 0, true))).toBe(722);
    expect(warmupOf("morph", { stages: 2, innerIterations: 10, outerIterations: 2 }, polygons)).toBe(22);
    expect(warmupOf("morph", { innerIterations: "x" })).toBe(722);
    // on circle pieces the solver runs the true shape alone: no disc stage, no warm-up
    expect(warmupOf("morph", resolvedParams("morph", MORPH_PRESET), circles)).toBe(0);
    // a whole 2-stage run in clicks of 10: only its first 722 evaluations are warm
    let warm = 0;
    for (let at = 0; at < MORPH_RUN; at += 10) warm += warmIn(MORPH_WARMUP, at, Math.min(MORPH_RUN, at + 10));
    expect(warm).toBe(722);
    // through applyStep: a run that never improves adds only its second stage to the count
    const s = newGame(1_000, 7);
    const q = newProblem({ N: 21, M: 24, P: 12 }, "open", 1_000);
    addToQueue(s, q);
    const board = loadAll(21, 24, 12);
    applyLoadAll(q, board, 9.5, null);
    q.sinceGain = 0;
    for (let at = 0; at < MORPH_RUN; at += 10) {
      const to = Math.min(MORPH_RUN, at + 10);
      applyStep(
        s,
        q,
        {
          evaluations: to - at,
          best: null,
          score: null,
          run: { method: "morph", params: MORPH_PRESET, seed: 7, budget: { evals: to } },
          ms: 1,
          ended: false,
          click: false,
          warm: warmIn(MORPH_WARMUP, at, to),
        },
        0,
      );
    }
    expect(q.sinceGain).toBe(MORPH_RUN - MORPH_WARMUP);
    // Auto-advance's card says so, read from the table
    const how = upgrade("advance").how;
    expect(prose(how)[1]).toContain(
      "The first 722 evaluations of every morph run on polygon pieces are its warm-up, and they do not add to the count.",
    );
    expect(how.math![1]).toBe("otherwise <var>n</var> ← <var>n</var> + <var>e</var> − <var>e</var><sub>warm</sub>");
    expect(how.vars!.find(([v]) => v.includes("warm"))![1]).toBe(
      "the evaluations among e in a run's warm-up, the first 722 evaluations of every morph run on polygon pieces (0 for other runs)",
    );
  });

  it("says what a run does, with the numbers from its constants", () => {
    const card = upgrade("morph");
    expect(card.effect).toBe("You can run morph, which repacks your board as discs and then as the true pieces.");
    const text = prose(card.how).join(" ");
    expect(text).toContain("morph repacks your board in 2 stages.");
    expect(text).toContain("at most 6 penalty solves of at most 120 L-BFGS steps each");
    expect(text).toContain("The run ends after its last stage.");
    expect(card.how.math).toContain(
      "<var>e</var> ≤ 2 + <var>k</var> × <var>O</var> × <var>I</var>, which is 1,442 at <var>k</var> = 2",
    );
    expect(card.how.math).toContain("warm-up = 2 + <var>O</var> × <var>I</var> = 722 evaluations");
    expect(Object.fromEntries(card.how.vars!)["<var>k</var>"]).toBe(
      "its stages, 2, or up to 4 with the halfway stages",
    );
    expect(card.how.note).toContain("The first 722 evaluations of a run are its warm-up");
    expect(card.how.note).toContain("Method list");
    // no seeds per problem or seed numbers, and one word for each idea: stages, not steps, for morph's
    for (const t of [card.effect, ...prose(card.how), card.how.note!]) {
      expect(t).not.toMatch(/seeds? of the problem|one of the problem's seeds|with seed \d|[;—]/);
      expect(t).not.toMatch(/\b(\d+|7) steps\b|halves the next step/);
    }
    // when a run ends, in the help on runs and on pipelines
    expect(morph.runEnds).toBe(
      "A morph run ends after its last stage, within 1,442 evaluations, or 2,882 with the halfway stages.",
    );
    expect(prose(HELP.counts as How).join(" ")).toContain(morph.runEnds);
    expect(prose(PIPELINE).join(" ")).toContain(morph.runEnds);
    expect(morph.endedText!(view(1442), "24-gons in a 27-gon, 40 pieces")).toBe(
      "The morph run on 24-gons in a 27-gon, 40 pieces ended after its last stage, at 1,442 evaluations.",
    );
  });

  it("says on a click without improvement, and on the run line, that the run is still in its warm-up", () => {
    const note =
      "morph's disc stage ends by evaluation 722 of this run. Its boards rarely beat a board packed tight before the second stage.";
    expect(morph.stepNote!(view(1))).toBe(note);
    expect(morph.stepNote!(view(721))).toBe(note);
    expect(morph.stepNote!(view(722))).toBeNull();
    expect(morph.stepNote!(view(1300))).toBeNull();
    // circle pieces have no warm-up
    expect(morph.stepNote!(view(300, 0))).toBeNull();
    expect(morph.runNote!(view(300))).toBe(" · warm-up until 722");
    expect(morph.runNote!(view(722))).toBe("");
    expect(morph.runNote!(view(300, 0))).toBe("");
  });

  it("opens a 2-stage run that ends by itself within 1,442 evaluations", async () => {
    const problem = { N: 21, M: 21, P: 6 };
    const start = loadAll(problem.N, problem.M, problem.P);
    const r = new OpenRun({
      problem,
      method: "morph",
      params: { ...MORPH_PRESET },
      budget: { evals: 100_000 },
      seed: 1,
      start,
    });
    expect(r.params.stages).toBe(2);
    let s = await r.step(0);
    expect(s.evaluations).toBe(1);
    s = await r.step(MORPH_LONGEST);
    expect(s).toMatchObject({ ended: true, closed: false });
    expect(s.error).toBeUndefined();
    expect(s.evaluations).toBeGreaterThan(MORPH_START);
    expect(s.evaluations).toBeLessThanOrEqual(MORPH_RUN);
    // it repacked the loose board smaller
    expect(s.score!).toBeLessThan(evaluate(start, { autoOrient: true }).score);
    expect(s.found).not.toBeNull();
  }, 20_000);
});
