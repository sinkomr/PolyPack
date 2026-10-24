import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { problemTitle } from "../src/tighter/frontier";
import { ProblemState, addToQueue, applyLoadAll, applyStep, newGame, newProblem } from "../src/tighter/game";
import { HELP, PIPELINE } from "../src/tighter/help";
import type { How } from "../src/tighter/how";
import { RUN_BUDGET, methodGame, methodLabel, runSetup } from "../src/tighter/methods";
import {
  HEX_BUILD,
  LATTICE_AFTER,
  LATTICE_LARGE,
  LatticeCheck,
  latticeDue,
  latticeParams,
  latticeStep,
  readLattice,
} from "../src/tighter/methods/lattice";
import { OpenRun } from "../src/tighter/open-run";
import { pipelineMethod } from "../src/tighter/runplan";
import { readSave, toJson } from "../src/tighter/save";
import { newStanding, ruleAllowsMethod } from "../src/tighter/standing";
import { UPGRADES, methodParams, methods, owning, upgrade } from "../src/tighter/upgrades";

const loadAll = (N: number, M: number, P: number): PackingConfig => {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
};

/** A problem in the queue whose board is Load all's, at `score`. */
function loaded(N: number, M: number, P: number, score = 9.5) {
  const s = newGame(1_000, 7);
  const p = newProblem({ N, M, P }, "open", 1_000);
  addToQueue(s, p);
  const board = loadAll(N, M, P);
  applyLoadAll(p, board, score, null);
  return { s, p, board };
}

/** A problem of `P` pieces right after its Compact made the first record: 101 evaluations run. */
function compacted(P: number, over: Partial<ProblemState> = {}): ProblemState {
  const { p } = loaded(21, 24, P);
  p.phase = "ready";
  p.run = { method: "mc_compress", params: {}, seed: 1, budget: { evals: 101 } };
  p.evaluations = 101;
  return Object.assign(p, over);
}

const CHECK: LatticeCheck = { owns: true, ruleOk: true, stall: 1000, evals: 10 };
const due = (p: ProblemState, c: Partial<LatticeCheck> = {}) => latticeDue(p, { ...CHECK, ...c });

describe("Tighter's Lattice build", () => {
  it("builds the hexagonal lattice alone from 9 sides, and never a pool of boards", () => {
    expect(latticeParams(9)).toEqual({ kind: "hex_lattice", poolLimit: 0 });
    expect(latticeParams(21)).toEqual({ kind: "hex_lattice", poolLimit: 0 });
    expect(latticeParams(100)).toEqual({ kind: "hex_lattice", poolLimit: 0 });
    for (const N of [0, 3, 4, 5, 8]) expect(latticeParams(N)).toEqual({ poolLimit: 0 });
    // a build opens with them, from the problem's board, whatever the player's parameters
    const { p, board } = loaded(21, 24, 40);
    const o = owning(["lattice"]);
    expect(runSetup("seed", methodParams(o, "seed"), p)).toEqual({
      params: { kind: "hex_lattice", poolLimit: 0 },
      budget: RUN_BUDGET,
      start: board,
    });
    expect(runSetup("seed", {}, loaded(4, 4, 30).p).params).toEqual({ poolLimit: 0 });
  });

  it(`runs on a problem of ${LATTICE_LARGE} pieces or more right after Compact`, () => {
    expect(LATTICE_LARGE).toBe(100);
    for (const P of [100, 150, 300]) expect(due(compacted(P)), `P ${P}`).toBe(true);
    expect(due(compacted(99))).toBe(false);
    // a Compact that did not beat a trim floor still leaves a run's board: the build may make the first record
    const trimmed = compacted(150, { phase: "loaded" });
    expect(due(trimmed)).toBe(true);
    // never before Compact
    expect(due(compacted(150, { phase: "loaded", run: null }))).toBe(false);
    expect(due(compacted(150, { phase: "bare", run: null }))).toBe(false);
    // a dealt site record needs no Compact: its board is already one to evolve
    expect(due(compacted(200, { tier: "loose", run: null, evaluations: 0 }))).toBe(true);
  });

  it(`runs on a smaller problem at ${LATTICE_AFTER.toLocaleString("en-US")} evaluations, at a run that ended by itself, or as it is about to stall`, () => {
    expect(LATTICE_AFTER).toBe(2000);
    for (const P of [40, 60, 80, 99]) {
      // right after Compact: not yet
      expect(due(compacted(P)), `P ${P}`).toBe(false);
      // the problem's evaluations, Compact's included
      expect(due(compacted(P, { evaluations: 1999 }))).toBe(false);
      expect(due(compacted(P, { evaluations: 2000 }))).toBe(true);
      expect(due(compacted(P, { evaluations: 5000 }))).toBe(true);
      // a run on it that ended by itself (its method's rule, its budget, or the game at a stall)
      expect(due(compacted(P, { endedRuns: 1 }))).toBe(true);
      // the batch about to run would take it to W evaluations without progress: n + b ≥ W
      expect(due(compacted(P, { sinceGain: 989 }), { evals: 10 })).toBe(false);
      expect(due(compacted(P, { sinceGain: 990 }), { evals: 10 })).toBe(true);
      expect(due(compacted(P, { sinceGain: 1500 }), { evals: 0 })).toBe(true);
      expect(due(compacted(P, { sinceGain: 220 }), { evals: 38, stall: 250 })).toBe(true);
      expect(due(compacted(P, { sinceGain: 220 }), { evals: 29, stall: 250 })).toBe(false);
      // never before Compact, even with every trigger
      const all = { evaluations: 3000, endedRuns: 2, sinceGain: 5000 };
      expect(due(compacted(P, { ...all, phase: "loaded", run: null }))).toBe(false);
      expect(due(compacted(P, { ...all, phase: "bare", run: null }))).toBe(false);
    }
  });

  it("never runs without the card, under the One method rule, on a problem out of play, or twice", () => {
    for (const P of [40, 150]) {
      const all = { evaluations: 3000, endedRuns: 2, sinceGain: 5000 };
      expect(due(compacted(P, all))).toBe(true);
      expect(due(compacted(P, all), { owns: false })).toBe(false);
      expect(due(compacted(P, all), { ruleOk: false })).toBe(false);
      expect(due(compacted(P, { ...all, leaving: true }))).toBe(false);
      expect(due(compacted(P, { ...all, closed: true }))).toBe(false);
      // built: never again, whatever happens on the problem
      expect(due(compacted(P, { ...all, lattice: { score: 6.44, at: 2013 } }))).toBe(false);
      expect(due(compacted(P, { ...all, lattice: { score: null, at: 2013 } }))).toBe(false);
      expect(due(compacted(P, { ...all, lattice: { score: 6.44, at: 2013 } }), { building: true })).toBe(false);
    }
    // the rule's own test: One method allows only mc_compress
    const standing = newStanding(0);
    expect(ruleAllowsMethod(standing, "seed")).toBe(true);
    expect(ruleAllowsMethod({ ...standing, rule: "method" }, "seed")).toBe(false);
    // a build already open goes on until it ends, though its trigger has passed (its board made progress)
    expect(due(compacted(40, { sinceGain: 0 }), { building: true })).toBe(true);
    expect(due(compacted(40, { sinceGain: 0 }), { building: true, owns: false })).toBe(false);
  });

  it(`opens a build of ${HEX_BUILD} evaluations that ends by itself, moves no pipeline on, and is not run again`, async () => {
    const N = 21;
    const M = 24;
    const P = 40;
    const { s, p } = loaded(N, M, P, 7.349087);
    const setup = runSetup("seed", {}, p);
    const run = new OpenRun({
      problem: { N, M, P },
      method: "seed",
      params: setup.params,
      budget: { evals: setup.budget },
      seed: 2,
      start: structuredClone(setup.start),
    });
    let st = await run.step(0);
    expect(st.evaluations).toBe(1);
    const startScore = st.score!;
    while (!st.ended) st = await run.step(5);
    expect(st).toMatchObject({ evaluations: HEX_BUILD, ended: true, closed: false });
    expect(HEX_BUILD).toBe(13);
    expect(st.found!.toFixed(6)).toBe("6.440089");
    expect(st.score).toBe(st.found);
    // the page applies it as it applies any step, but as a build that did not end by itself
    const change = applyStep(
      s,
      p,
      {
        evaluations: st.evaluations,
        best: st.best,
        score: st.score,
        run: { method: "seed", params: run.params, seed: 2, budget: { evals: st.evaluations } },
        ms: 1,
        ended: false,
        click: false,
      },
      2_000,
    );
    expect(change.improved).toBe(true);
    expect(p.best).toBe(st.score);
    expect(p.endedRuns).toBe(0);
    expect(pipelineMethod(["mc_compress", "asc"], p.endedRuns, () => true)).toEqual({
      method: "mc_compress",
      stage: 0,
    });
    // the server is told the solver's name, the player sees Lattice's
    expect(p.run!.method).toBe("seed");
    expect(methodLabel(p.run!.method)).toBe("lattice");
    // the build is over: its result goes on the problem, and its event on the notice line
    const event = latticeStep(p, st, startScore, problemTitle(p), "side");
    expect(event).toEqual({
      text: `Lattice packed 21-gons in a 24-gon, 40 pieces, with side 6.440089. That beats your ${startScore.toFixed(6)}, so it is your board now.`,
      notice: true,
    });
    expect(p.lattice).toEqual({ score: st.found, at: 13 });
    // no second build
    Object.assign(p, { evaluations: 9000, endedRuns: 3, sinceGain: 5000 });
    expect(due(p)).toBe(false);
    expect(due(p, { building: true })).toBe(false);
  });

  it("says what the build found, and records nothing for a build closed before its end", () => {
    const title = "21-gons in a 24-gon, 40 pieces";
    const ended = { ended: true, closed: false };
    const at = (p: ProblemState) => p.lattice;
    let p = compacted(40, { evaluations: 2013 });
    // the board was smaller: the log only
    expect(latticeStep(p, { ...ended, found: 6.440089 }, 6.342965, title, "side")).toEqual({
      text: "Lattice packed 21-gons in a 24-gon, 40 pieces, with side 6.440089. Your board's 6.342965 is smaller, so it stays.",
      notice: false,
    });
    expect(at(p)).toEqual({ score: 6.440089, at: 2013 });
    p = compacted(40);
    expect(latticeStep(p, { ...ended, found: 6.5 }, 6.5, title, "radius")!.text).toBe(
      "Lattice packed 21-gons in a 24-gon, 40 pieces, with radius 6.500000. Your board is as small, so it stays.",
    );
    // no strict lattice packing at all
    p = compacted(40);
    expect(latticeStep(p, { ...ended, found: null }, 6.3, title, "side")).toEqual({
      text: "Lattice found no packing without overlaps for 21-gons in a 24-gon, 40 pieces, so your board stays.",
      notice: false,
    });
    expect(at(p)).toEqual({ score: null, at: 101 });
    // an error ends it too, so that it is not tried again and again
    p = compacted(40);
    expect(latticeStep(p, { ended: true, closed: false, error: "boom", found: null }, 6.3, title, "side")!.text).toBe(
      "The Lattice build on 21-gons in a 24-gon, 40 pieces stopped (boom), so your board stays.",
    );
    expect(at(p)).toEqual({ score: null, at: 101 });
    // still going, or closed by the game (the lane moved, a reload): nothing yet, and it runs again
    p = compacted(40);
    expect(latticeStep(p, { ended: false, closed: false, found: 6.4 }, 6.3, title, "side")).toBeNull();
    expect(latticeStep(p, { ended: true, closed: true, found: 6.4 }, 6.3, title, "side")).toBeNull();
    expect(at(p)).toBeNull();
    expect(due(p, { building: false, evals: 0 })).toBe(false);
    expect(due(Object.assign(p, { evaluations: 2000 }))).toBe(true);
  });

  it("keeps each problem's result in the save, and gives a problem from an older save its build", () => {
    const { s, p } = loaded(21, 24, 40, 7.3);
    expect(p.lattice).toBeNull();
    const old = JSON.parse(toJson(s));
    delete old.queue[0].lattice;
    let r = readSave(old, 2_000);
    expect(r.ok && r.state.queue[0].lattice).toBeNull();
    // a result round-trips, an unreadable one is none
    p.lattice = { score: 6.440089, at: 2013 };
    r = readSave(JSON.parse(toJson(s)), 2_000);
    expect(r.ok && r.state.queue[0].lattice).toEqual({ score: 6.440089, at: 2013 });
    p.lattice = { score: null, at: 13 };
    r = readSave(JSON.parse(toJson(s)), 2_000);
    expect(r.ok && r.state.queue[0].lattice).toEqual({ score: null, at: 13 });
    expect(readLattice({ score: 6.4, at: 13 })).toEqual({ score: 6.4, at: 13 });
    for (const bad of [null, "x", 5, [], {}, { score: -1, at: 3 }, { score: 6.4, at: 1.5 }, { score: 6.4 }, { at: 3 }])
      expect(readLattice(bad), JSON.stringify(bad)).toBeNull();
    // a problem taken back to the start (its board unreadable) gets its build again
    const bare = JSON.parse(toJson(s));
    bare.queue[0].board = null;
    r = readSave(bare, 2_000);
    expect(r.ok && r.state.queue[0].phase).toBe("bare");
    expect(r.ok && r.state.queue[0].lattice).toBeNull();
  });

  it("falls back from a saved choice of seed, in the select or in a pipeline", () => {
    const s = newGame(1_000, 3);
    s.owned = ["basin", "shrink", "penalty", "lattice", "harden", "pipeline"];
    s.settings.method = "seed";
    s.runplan.pipeline = ["seed", "basin_hopping", "seed", "mc_compress"];
    const r = readSave(JSON.parse(toJson(s)), 2_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.settings.method).toBe("mc_compress");
    expect(r.state.runplan.pipeline).toEqual(["basin_hopping", "mc_compress"]);
    expect(r.state.owned).toContain("lattice");
    expect(methods(owning(r.state.owned))).not.toContain("seed");
  });

  it("names the card Lattice, with a How that states both timings and defines every variable", () => {
    const card = upgrade("lattice");
    // its price and place in the tree are the economy's
    expect(card).toMatchObject({ name: "Lattice", row: "methods" });
    expect(card.effect).toBe(
      "Once on each problem, the game builds a lattice packing and makes it your board when it is smaller.",
    );
    const text = (h: How) => (typeof h.text === "string" ? h.text : h.text.join(" "));
    const how = text(card.how);
    expect(how).toContain("On a problem with 100 pieces or more, the build runs right after Compact.");
    expect(how).toContain("2,000 evaluations");
    expect(how).toContain("13 evaluations");
    expect(how).toContain("up to 12 offsets and angles");
    expect(card.how.math![0]).toBe("build right after Compact when <var>P</var> ≥ 100");
    expect(card.how.math![1]).toContain("<var>e</var> ≥ 2,000");
    // every symbol of the formulas is among the variables
    const symbols = (t: string) => [...t.matchAll(/<var>[^<]+<\/var>(?:<sub>[^<]+<\/sub>)?/g)].map((m) => m[0]);
    const defined = card.how.vars!.map(([v]) => v).join(" ");
    for (const line of card.how.math!) for (const v of symbols(line)) expect(defined, line).toContain(v);
    for (const [v, meaning] of card.how.vars!) expect(meaning, v).toBeTruthy();
    // player text: no seed wording, no colon or semicolon chains, no dashes
    const all = [
      card.effect,
      how,
      card.how.note ?? "",
      ...card.how.vars!.map(([, m]) => m),
      methodGame("seed").runEnds!,
    ];
    for (const t of all) {
      expect(t).not.toMatch(/with seed \d|· seed|seeds per problem|One seed|—|;/);
      expect(t.split(":").length, t).toBeLessThanOrEqual(1);
    }
    // the help on runs and on pipelines says the build does not move a pipeline on
    expect(text(HELP.counts as How)).toContain("A Lattice build ends after its last lattice");
    expect(text(PIPELINE)).toContain("does not count as a run that ended by itself");
    // it gates what it gated
    expect(UPGRADES.filter((u) => u.requires.includes("lattice")).map((u) => u.id)).toEqual(["harden", "transfer"]);
  });
});
