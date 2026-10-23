import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import {
  StepOutcome,
  addToQueue,
  applyLoadAll,
  applyStep,
  endRunAtStall,
  newGame,
  newProblem,
  stallEnds,
} from "../src/tighter/game";
import { HELP, PIPELINE, runEndRules, smallerText, stallRule } from "../src/tighter/help";
import type { How } from "../src/tighter/how";
import {
  METHOD_GAMES,
  isSelectable,
  methodGame,
  methodLabel,
  runSetup,
  warmIn,
  warmupOf,
} from "../src/tighter/methods";
import type { MethodGame } from "../src/tighter/methods";
import { METHODS } from "../src/tighter/methods/worker";
import { resolvedParams } from "../src/tighter/open-run";
import { chooseRun, newRunPlan, pipelineMethod } from "../src/tighter/runplan";
import { readSave, toJson } from "../src/tighter/save";
import { Speeds } from "../src/tighter/scheduler";
import {
  EvolveMethod,
  RUN_BUDGET,
  UPGRADES,
  UpgradeId,
  advanceHow,
  autoJobEvals,
  methodParams,
  methods,
  owning,
  upgrade,
} from "../src/tighter/upgrades";

const ALL: EvolveMethod[] = [
  "mc_compress",
  "basin_hopping",
  "shrink_repair",
  "seed",
  "penalty",
  "harden",
  "asc",
  "morph",
  "ls_growth",
];
/** The method cards, by the method they unlock. */
const CARDS: Partial<Record<UpgradeId, EvolveMethod>> = {
  basin: "basin_hopping",
  shrink: "shrink_repair",
  penalty: "penalty",
  lattice: "seed",
  harden: "harden",
  morph: "morph",
  asc: "asc",
  growth: "ls_growth",
};

/** Runs `fn` with `hooks` set on a method's entry, then puts the entry back as it was. */
function withHooks<T>(m: EvolveMethod, hooks: Partial<MethodGame>, fn: () => T): T {
  const g = METHOD_GAMES[m] as MethodGame;
  const before = { ...g };
  Object.assign(g, hooks);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(g) as (keyof MethodGame)[]) delete g[k];
    Object.assign(g, before);
  }
}

function loaded(N: number, M: number, P: number) {
  const s = newGame(1_000, 7);
  const p = newProblem({ N, M, P }, "open", 1_000);
  addToQueue(s, p);
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  const board: PackingConfig = { N, M, P, pieces, container_phi: 0 };
  applyLoadAll(p, board, 9.5, null);
  return { s, p, board };
}

describe("Tighter's methods table", () => {
  it("has an entry for every method the game runs, each registered in the worker under its solver name", () => {
    expect(Object.keys(METHOD_GAMES).sort()).toEqual([...ALL].sort());
    const names = METHODS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of ALL) {
      expect(names, m).toContain(m);
      expect(() => resolvedParams(m, {}), m).not.toThrow();
    }
    // the framework's own stages are registered too
    expect(names).toEqual(expect.arrayContaining(["identity", "polish"]));
  });

  it("gives every method card its effect and How from the method's own file", () => {
    const cards = UPGRADES.filter((u) => u.row === "methods");
    expect(cards.map((u) => u.id).sort()).toEqual(Object.keys(CARDS).sort());
    for (const u of cards) {
      const g = methodGame(CARDS[u.id]!);
      expect(g.effect, u.id).toBeTruthy();
      expect(u.effect).toBe(g.effect);
      // the How is the method's, its note the shared sentence on the Method list
      const how = g.how!("NOTE");
      expect(u.how.text).toEqual(how.text);
      expect(u.how.math).toEqual(how.math);
      expect(u.how.vars).toEqual(how.vars);
      expect(how.note).toContain("NOTE");
      expect(u.how.note).toContain("Method list");
      expect(u.name).toBe(`Method: ${CARDS[u.id]}`);
    }
    // mc_compress is owned from the start: it has no card, and its tuning card reads the table too
    expect(methodGame("mc_compress").effect).toBeUndefined();
    expect(upgrade("tuneMc").how.vars!.map(([, v]) => v)).toContain(
      `${methodGame("mc_compress").tunedMeaning!.sweepsPerEvaluation}, at levels 0 to 3`,
    );
  });

  it("names a method by its label in player text, and the solver's name otherwise", () => {
    for (const m of ALL) expect(methodLabel(m)).toBe(m);
    withHooks("seed", { label: "lattice" }, () => {
      expect(methodLabel("seed")).toBe("lattice");
      expect(methodLabel("mc_compress")).toBe("mc_compress");
    });
    expect(methodLabel("seed")).toBe("seed");
    // a name the game does not know is shown as it is
    expect(methodLabel("identity")).toBe("identity");
    expect(methodGame("identity" as EvolveMethod)).toEqual({});
  });

  it("opens a run with the player's parameters, the run budget and the problem's board, unless the method says otherwise", () => {
    const { p, board } = loaded(21, 24, 12);
    const o = owning(["harden", "tuneHarden", "sweeps10", "tuneMc"], { tuneHarden: 2, tuneMc: 1 });
    const mc = methodParams(o, "mc_compress");
    expect(runSetup("mc_compress", mc, p)).toEqual({ params: mc, budget: RUN_BUDGET, start: board });
    const base = methodParams(o, "harden");
    // the method's own run settings, from the player's and the problem's
    const other: PackingConfig = { ...board, pieces: board.pieces.map((q) => ({ ...q, x: q.x + 1 })) };
    const seen: unknown[] = [];
    const setup = withHooks(
      "harden",
      {
        runParams: (b, q) => {
          seen.push(q);
          return { ...b, noise: q.P < 60 ? 8 : 2 };
        },
        runBudget: (params) => Math.ceil(11_500 / (params.evaluationInterval as number)) + 1,
        startFrom: () => other,
      },
      () => runSetup("harden", base, p),
    );
    expect(setup).toEqual({ params: { evaluationInterval: 64, noise: 8 }, budget: 181, start: other });
    expect(seen).toEqual([{ N: 21, M: 24, P: 12, score: 9.5 }]);
    // the player's parameters are left as they were: a run is reopened only when they change
    expect(base).toEqual({ evaluationInterval: 64 });
    // a budget is a whole number of evaluations, at least 1
    expect(withHooks("asc", { runBudget: () => 0.4 }, () => runSetup("asc", {}, p).budget)).toBe(1);
  });

  it("leaves a method that cannot be chosen out of the Method list, Method match and the pipelines", () => {
    const o = owning(["basin", "shrink", "penalty", "lattice", "harden"]);
    expect(methods(o)).toContain("seed");
    const save = newGame(1_000, 3);
    save.owned = ["basin", "shrink", "penalty", "lattice"];
    save.settings.method = "seed";
    save.runplan.pipeline = ["seed", "mc_compress", "seed"];
    withHooks("seed", { selectable: false }, () => {
      expect(isSelectable("seed")).toBe(false);
      expect(methods(o)).toEqual(["mc_compress", "basin_hopping", "shrink_repair", "penalty", "harden"]);
      // Method match draws only among those
      const plan = newRunPlan();
      for (let i = 0; i < 50; i++) {
        const c = chooseRun(plan, {
          kind: "open|t80|r",
          methods: methods(o),
          levelOf: () => 0,
          tune: false,
          allowed: () => true,
          rand: Math.random,
        });
        expect(c!.method).not.toBe("seed");
      }
      // a pipeline stage of it is skipped, as a stage the cycle's rule refuses
      expect(pipelineMethod(["seed", "asc"], 0, (m) => methods(o).includes(m) || m === "asc")).toEqual({
        method: "asc",
        stage: 1,
      });
      // a save that chose it, or put it in its pipeline, falls back: mc_compress, and the stage dropped
      const r = readSave(JSON.parse(toJson(save)), 2_000);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.state.settings.method).toBe("mc_compress");
      expect(r.state.runplan.pipeline).toEqual(["mc_compress"]);
      // the card stays owned, and the method stays a method for run records
      expect(r.state.owned).toContain("lattice");
      expect(methodParams(o, "seed")).toEqual({});
    });
    // selectable again, the save keeps both
    const r = readSave(JSON.parse(toJson(save)), 2_000);
    expect(r.ok && r.state.settings.method).toBe("seed");
    expect(r.ok && r.state.runplan.pipeline).toEqual(["seed", "mc_compress", "seed"]);
  });

  it("end a stalled run of mc_compress after 500 evaluations without progress, as a run that ended by itself", () => {
    const R = methodGame("mc_compress").restartAfter!;
    expect(R).toBe(500);
    for (const m of ALL.filter((x) => x !== "mc_compress")) expect(methodGame(m).restartAfter ?? null, m).toBeNull();
    // the run must have done R evaluations, and the problem gone R without progress
    expect(stallEnds(R, 500, 500)).toBe(true);
    expect(stallEnds(R, 1200, 800)).toBe(true);
    expect(stallEnds(R, 499, 5000)).toBe(false);
    expect(stallEnds(R, 5000, 499)).toBe(false);
    // a method without the rule never ends this way
    expect(stallEnds(null, 1e6, 1e6)).toBe(false);
    expect(stallEnds(undefined, 1e6, 1e6)).toBe(false);
    expect(stallEnds(0, 1e6, 1e6)).toBe(false);
    // it counts as a run that ended by itself: the pipeline goes on to its next stage
    const { p } = loaded(21, 24, 12);
    const pipeline: EvolveMethod[] = ["mc_compress", "asc", "harden"];
    expect(pipelineMethod(pipeline, p.endedRuns, () => true)).toEqual({ method: "mc_compress", stage: 0 });
    endRunAtStall(p);
    expect(p.endedRuns).toBe(1);
    expect(pipelineMethod(pipeline, p.endedRuns, () => true)).toEqual({ method: "asc", stage: 1 });
  });

  it("explain the stall rule from the table, every limit named", () => {
    expect(stallRule()).toBe(
      "The game also ends a stalled run of mc_compress. Once the run has done 500 evaluations and its problem has gone 500 evaluations without progress, it counts as ended by itself.",
    );
    const two = { mc_compress: { restartAfter: 500 }, asc: { restartAfter: 1500 }, harden: {} };
    expect(stallRule(two)).toBe(
      "The game also ends a stalled run of mc_compress or asc. Once the run has done R evaluations and its problem has gone R evaluations without progress, it counts as ended by itself. R is 500 for mc_compress and 1,500 for asc.",
    );
    expect(stallRule({ harden: {}, asc: { restartAfter: null } })).toBe("");
    // the help on runs and on pipelines says it
    const text = (h: How) => (typeof h.text === "string" ? h.text : h.text.join(" "));
    expect(text(HELP.counts as How)).toContain(stallRule());
    expect(text(PIPELINE)).toContain(stallRule());
    expect(text(PIPELINE)).toContain("or the game ended it at a stall");
    // a method's own sentence on when its runs end goes with them, in the table's order
    for (const g of Object.values(METHOD_GAMES)) if (g.runEnds) expect(runEndRules()).toContain(g.runEnds);
    expect(text(HELP.counts as How)).toContain(runEndRules());
    expect(text(PIPELINE)).toContain(runEndRules());
    expect(
      runEndRules({
        basin_hopping: { runEnds: "A basin_hopping run ends after 1,000 evaluations." },
        harden: { runEnds: "A harden run ends after its last step." },
        asc: {},
      }),
    ).toBe("A basin_hopping run ends after 1,000 evaluations. A harden run ends after its last step.");
  });

  it("keep a run's warm-up out of the evaluations since progress", () => {
    // the evaluations of a step that fall within the run's first W
    expect(warmIn(722, 0, 10)).toBe(10);
    expect(warmIn(722, 720, 730)).toBe(2);
    expect(warmIn(722, 722, 732)).toBe(0);
    expect(warmIn(722, 800, 810)).toBe(0);
    expect(warmIn(0, 0, 10)).toBe(0);
    // only morph has one; it reads the run's resolved parameters, its defaults when a text asks
    for (const m of ALL) expect(warmupOf(m, resolvedParams(m, {})), m).toBe(m === "morph" ? 722 : 0);
    const morph = {
      warmup: (q: Record<string, unknown>) =>
        2 + ((q.innerIterations as number) ?? 120) * ((q.outerIterations as number) ?? 6),
    };
    withHooks("morph", morph, () => {
      expect(warmupOf("morph", resolvedParams("morph", {}))).toBe(722);
      expect(warmupOf("morph", { innerIterations: 10, outerIterations: 2 })).toBe(22);
    });
    // a warm-up that is not a whole positive number is none
    for (const w of [-5, Number.NaN, Infinity])
      withHooks("morph", { warmup: () => w }, () => expect(warmupOf("morph", {})).toBe(0));
    withHooks("morph", { warmup: () => 9.7 }, () => expect(warmupOf("morph", {})).toBe(9));
    // a step's warm evaluations count everywhere but in the count since progress
    const { s, p } = loaded(21, 24, 12);
    const step = (evaluations: number, warm?: number): StepOutcome => ({
      evaluations,
      best: null,
      score: null,
      run: { method: "morph", params: {}, seed: 7, budget: { evals: 1 } },
      ms: 1,
      ended: false,
      click: false,
      ...(warm === undefined ? {} : { warm }),
    });
    p.sinceGain = 100;
    applyStep(s, p, step(10, 10), 0);
    expect(p).toMatchObject({ sinceGain: 100, evaluations: 10 });
    applyStep(s, p, step(10, 4), 0);
    expect(p).toMatchObject({ sinceGain: 106, evaluations: 20 });
    applyStep(s, p, step(10), 0);
    expect(p).toMatchObject({ sinceGain: 116, evaluations: 30 });
    // never more than the step's own evaluations, never fewer than none
    applyStep(s, p, step(10, 50), 0);
    applyStep(s, p, step(10, -3), 0);
    expect(p).toMatchObject({ sinceGain: 126, evaluations: 50 });
    expect(s.stats.evaluations).toBe(50);
  });

  it("say in Auto-advance's How which runs have a warm-up, read from the table", () => {
    // morph's is on the card, and without any the card says nothing of it
    expect(upgrade("advance").how).toEqual(advanceHow([{ label: "morph", evals: 722, runs: "on polygon pieces" }]));
    expect(advanceHow([]).text[1]).toMatch(/“830 since progress”\.$/);
    expect(advanceHow([]).math![1]).toBe("otherwise <var>n</var> ← <var>n</var> + <var>e</var>");
    const how = advanceHow([{ label: "morph", evals: 722 }]);
    expect(how.text[1]).toMatch(
      /The first 722 evaluations of every morph run are its warm-up, and they do not add to the count\.$/,
    );
    expect(how.math![1]).toBe("otherwise <var>n</var> ← <var>n</var> + <var>e</var> − <var>e</var><sub>warm</sub>");
    expect(how.vars!.map(([v]) => v)).toContain("<var>e</var><sub>warm</sub>");
    const two = advanceHow([
      { label: "morph", evals: 722 },
      { label: "lattice", evals: 1_500 },
    ]);
    expect(two.text[1]).toContain(
      "The first 722 evaluations of every morph run and the first 1,500 of every lattice run are their warm-up, and they do not add to the count.",
    );
    expect(two.vars!.find(([v]) => v.includes("warm"))![1]).toBe(
      "the evaluations among e in a run's warm-up, the first 722 evaluations of every morph run and the first 1,500 of every lattice run (0 for other runs)",
    );
  });

  it("size auto-eval's jobs by each method's own speed on this device", () => {
    const speeds = new Speeds();
    // nothing measured: the cost table as it is
    expect(speeds.msEach("mc_compress@0", 2)).toBe(2);
    expect(speeds.msEach(null, 2)).toBe(2);
    // mc_compress runs at the table's speed here, harden 6 times slower
    for (let i = 0; i < 20; i++) speeds.observe("mc_compress@0", 2, 10, 20);
    speeds.observe("harden@0", 2, 10, 120);
    expect(speeds.slowness("mc_compress@0")).toBeCloseTo(1, 12);
    expect(speeds.slowness("harden@0")).toBeCloseTo(6, 12);
    // harden's steps leave mc_compress's jobs as they were: 150 a second, a quarter second's worth
    const top = owning([..."auto1 auto2 auto3 auto4 auto5 auto6 auto7 auto8 auto9 auto10".split(" ")] as UpgradeId[]);
    expect(autoJobEvals(top, 1000, 1, speeds.msEach("mc_compress@0", 2))).toBe(38);
    // and harden's own jobs keep to a quarter second of its slower evaluations: 250 / 12 ms
    expect(autoJobEvals(top, 1000, 1, speeds.msEach("harden@0", 2))).toBe(20);
    // the average moves a fifth of the way at each step
    speeds.observe("harden@0", 2, 10, 20);
    expect(speeds.slowness("harden@0")).toBeCloseTo(0.8 * 6 + 0.2 * 1, 12);
    // a kind not measured yet, or a run Method match has still to draw, is taken as the slowest so far
    expect(speeds.slowness("asc@1")).toBeCloseTo(0.8 * 6 + 0.2 * 1, 12);
    expect(speeds.slowness(null)).toBeCloseTo(0.8 * 6 + 0.2 * 1, 12);
    // steps without evaluations or time teach nothing, and a ratio is kept within 0.01 and 100
    speeds.observe("asc@1", 2, 0, 50);
    speeds.observe("asc@1", 2, 5, 0);
    expect(speeds.slowness("asc@1")).toBeCloseTo(0.8 * 6 + 0.2 * 1, 12);
    speeds.observe("ls_growth@0", 1, 1, 1e9);
    expect(speeds.slowness("ls_growth@0")).toBe(100);
  });

  it("say at a run's end how much smaller it made the side, only when that counts", () => {
    expect(smallerText("side", 10, 9.9506)).toBe("It made the side 0.494 % smaller.");
    expect(smallerText("radius", 2, 1.5)).toBe("It made the radius 25.000 % smaller.");
    // nothing when the run did not beat its start by more than 10⁻⁹
    expect(smallerText("side", 10, 10)).toBe("");
    expect(smallerText("side", 10, 10 * (1 - 5e-10))).toBe("");
    expect(smallerText("side", 10, 10.5)).toBe("");
    expect(smallerText("side", null, 9)).toBe("");
    expect(smallerText("side", 10, null)).toBe("");
  });
});
