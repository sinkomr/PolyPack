import { describe, expect, it } from "vitest";
import { evaluate, findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { run } from "@polypack/solver";
import { IMPROVEMENT_THRESHOLD, basinHoppingMethod } from "../../../packages/solver/src/methods/basin_hopping";
import { addToQueue, applyLoadAll, applyStep, newGame, newProblem } from "../src/tighter/game";
import type { StepOutcome } from "../src/tighter/game";
import { runEndRules } from "../src/tighter/help";
import { plain } from "../src/tighter/how";
import { methodGame, runSetup } from "../src/tighter/methods";
import type { RunStage, RunView } from "../src/tighter/methods";
import {
  BASIN_DEFAULTS,
  BASIN_GAME_PARAMS,
  BASIN_KICK_BOUNDS,
  BASIN_REFINE_EVALS,
  BASIN_RUN_EVALS,
  BASIN_TIE,
  refineEvals,
} from "../src/tighter/methods/basin_hopping";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import { pipelineMethod } from "../src/tighter/runplan";
import { RUN_BUDGET, methodParams, owning, upgrade } from "../src/tighter/upgrades";

const small = { N: 4, M: 4, P: 9 };

/** A problem loaded as the game loads it: every piece at the first free spot from the centre. */
function loaded() {
  const s = newGame(1_000, 7);
  const p = newProblem(small, "open", 1_000);
  addToQueue(s, p);
  const pieces: Pose[] = [];
  for (let k = 0; k < small.P; k++) pieces.push(findFreeSpot(small.N, pieces, 0, 0));
  const board: PackingConfig = { ...small, pieces, container_phi: 0 };
  const score = evaluate(board, { autoOrient: true }).score!;
  applyLoadAll(p, board, score, null);
  return { s, p, board, score };
}

/** The run line's view of a game run of basin_hopping at `evaluations`, with its latest sub-run. */
const view = (evaluations: number, stage?: RunStage, over: Partial<RunView> = {}): RunView => ({
  evaluations,
  budget: BASIN_RUN_EVALS,
  params: resolvedParams("basin_hopping", BASIN_GAME_PARAMS),
  last: null,
  runBest: null,
  found: null,
  ...(stage ? { stage } : {}),
  startScore: 4,
  problemBest: 4,
  ...over,
});

describe("Tighter's basin_hopping", () => {
  it("opens runs of 1,000 evaluations with the game's settings on top of the tuning level's", () => {
    const { p, board } = loaded();
    const o = owning(["basin"]);
    // the player's parameters stay the tuning level's, so a run is not reopened on every job
    expect(methodParams(o, "basin_hopping")).toEqual({});
    expect(runSetup("basin_hopping", methodParams(o, "basin_hopping"), p)).toEqual({
      params: { seedEvals: 1, temperature: 0, poolLimit: 0 },
      budget: 1000,
      start: board,
    });
    const tuned = owning(["basin", "tuneBasin"], { tuneBasin: 1 });
    expect(methodParams(tuned, "basin_hopping")).toEqual({ kickMagnitude: 0.25 });
    expect(runSetup("basin_hopping", methodParams(tuned, "basin_hopping"), p).params).toEqual({
      kickMagnitude: 0.25,
      seedEvals: 1,
      temperature: 0,
      poolLimit: 0,
    });
    // the solver takes them as they are, within its schema
    const props = basinHoppingMethod.schema.properties!;
    for (const [k, v] of Object.entries(BASIN_GAME_PARAMS)) {
      const range = props[k] as { minimum: number; maximum: number };
      expect(v, k).toBeGreaterThanOrEqual(range.minimum);
      expect(v, k).toBeLessThanOrEqual(range.maximum);
    }
    // other methods keep the budget every run had
    expect(runSetup("mc_compress", methodParams(o, "mc_compress"), p).budget).toBe(RUN_BUDGET);
  });

  it("quotes the solver's own defaults and rules in its texts", () => {
    const d = resolvedParams("basin_hopping", {});
    expect(d).toMatchObject(BASIN_DEFAULTS);
    expect(BASIN_TIE).toBe(IMPROVEMENT_THRESHOLD);
    const kick = basinHoppingMethod.schema.properties!.kickMagnitude as { minimum: number; maximum: number };
    expect([kick.minimum, kick.maximum]).toEqual([...BASIN_KICK_BOUNDS]);
    // the solver's final reserve: min(refinementEvals, ⌊allowance / 6⌋), the allowance being what is
    // left after the start's scoring
    expect(BASIN_REFINE_EVALS).toBe(Math.min(d.refinementEvals as number, Math.floor((BASIN_RUN_EVALS - 1) / 6)));
    expect(BASIN_REFINE_EVALS).toBe(166);
    expect(refineEvals(300)).toBe(49);
    expect(refineEvals(100_000)).toBe(3000);
    expect(refineEvals(1000, 0)).toBe(0);
  });

  it("runs as the solver's own run would, and ends by itself at its budget", async () => {
    const { p, board, score } = loaded();
    const setup = runSetup("basin_hopping", methodParams(owning(["basin"]), "basin_hopping"), p);
    const budget = 300;
    const r = new OpenRun({
      problem: small,
      method: "basin_hopping",
      params: setup.params,
      budget: { evals: budget },
      seed: 5,
      start: board,
    });
    const stages: RunStage[] = [];
    let s = await r.step(0);
    for (;;) {
      if (s.stage) stages.push(s.stage);
      if (s.ended) break;
      s = await r.step(10);
    }
    expect(s).toMatchObject({ ended: true, closed: false, evaluations: budget });
    expect(s.error).toBeUndefined();
    expect(s.score!).toBeLessThanOrEqual(score);
    expect(stages.some((x) => x.method === "penalty" && x.count >= 2)).toBe(true);
    // the hops' penalty solves are the solver's own: the same seed gives the same run
    const replay = await run(small, {
      method: "basin_hopping",
      params: setup.params,
      start: board,
      seed: 5,
      budget: { evals: budget },
      finalPolish: false,
    });
    expect(replay.evaluations).toBe(budget);
    expect(s.score).toBe(replay.score);
  }, 60_000);

  it("ends its runs with a sentence of its own, and a pipeline moves on after each", () => {
    const g = methodGame("basin_hopping");
    expect(g.endedText!(view(BASIN_RUN_EVALS), "9 squares in a square")).toBe(
      "The basin_hopping run on 9 squares in a square ended after its 1,000 evaluations.",
    );
    expect(g.endedText!(view(BASIN_RUN_EVALS - 1), "9 squares in a square")).toBeNull();
    expect(runEndRules()).toContain("A basin_hopping run ends after 1,000 evaluations.");
    const { s, p } = loaded();
    const pipeline = ["basin_hopping", "mc_compress"] as const;
    const step = (ended: boolean): StepOutcome => ({
      evaluations: 10,
      best: null,
      score: null,
      run: { method: "basin_hopping", params: BASIN_GAME_PARAMS, seed: 7, budget: { evals: 1000 } },
      ms: 1,
      ended,
      click: false,
    });
    applyStep(s, p, step(false), 0);
    expect(pipelineMethod([...pipeline], p.endedRuns, () => true)).toEqual({ method: "basin_hopping", stage: 0 });
    applyStep(s, p, step(true), 0);
    expect(pipelineMethod([...pipeline], p.endedRuns, () => true)).toEqual({ method: "mc_compress", stage: 1 });
  });

  it("words its card in plain sentences, with its numbers from its constants", () => {
    const u = upgrade("basin");
    const text = [u.how.text].flat();
    for (const t of [u.effect, ...text]) {
      expect(t).not.toMatch(/[;:—]/);
      expect(t).not.toMatch(/seed \d|seeds per problem|One seed|· seed /i);
    }
    const all = text.join(" ");
    expect(all).toContain(`${BASIN_RUN_EVALS.toLocaleString("en-US")} evaluations`);
    expect(all).toContain(`until ${BASIN_REFINE_EVALS} evaluations are left`);
    expect(all).toContain(`at most ${BASIN_DEFAULTS.localEvals} evaluations`);
    expect(plain(u.how.math!.at(-1)!)).toBe(`R = min(3,000, ⌊(L − 1) / 6⌋) = ${BASIN_REFINE_EVALS}`);
    // every variable in the formulas is defined
    const defined = new Set(u.how.vars!.map(([v]) => plain(v)));
    for (const m of u.how.math!)
      for (const v of m.matchAll(/<var>([^<]+)<\/var>(′?)/g)) expect(defined, plain(m)).toContain(v[1] + v[2]);
  });
});
