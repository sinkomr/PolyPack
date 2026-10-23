import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { addToQueue, applyLoadAll, newGame, newProblem } from "../src/tighter/game";
import { smallerText } from "../src/tighter/help";
import { METHOD_GAMES, isSelectable, methodGame, methodLabel, runSetup } from "../src/tighter/methods";
import type { MethodGame } from "../src/tighter/methods";
import { METHODS } from "../src/tighter/methods/worker";
import { resolvedParams } from "../src/tighter/open-run";
import { chooseRun, newRunPlan, pipelineMethod } from "../src/tighter/runplan";
import { readSave, toJson } from "../src/tighter/save";
import {
  EvolveMethod,
  RUN_BUDGET,
  UPGRADES,
  UpgradeId,
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
    const o = owning(["harden", "tuneHarden"], { tuneHarden: 2 });
    const base = methodParams(o, "harden");
    expect(runSetup("harden", base, p)).toEqual({ params: base, budget: RUN_BUDGET, start: board });
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
