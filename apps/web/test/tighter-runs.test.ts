import { describe, expect, it } from "vitest";
import { evaluate, findFreeSpot, findOverlaps } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import { MAX_TUNING, isTunable, presetParams, tuningLevels } from "../src/tighter/presets";
import {
  MAX_STAGES,
  MIN_OBSERVED_EVALS,
  addStage,
  armKey,
  chooseRun,
  learned,
  moveStage,
  newRunPlan,
  normalizeRunPlan,
  observeRun,
  parseArm,
  pipelineMethod,
  planRandom,
  priorFor,
  problemKind,
  removeStage,
} from "../src/tighter/runplan";
import { TRANSFER_MARGIN, chooseStart, neighbourPs, scoredTransfer, transferBoard } from "../src/tighter/transfer";
import { EvolveMethod, TUNING, methodParams, owning, upgrade } from "../src/tighter/upgrades";

const loadAll = (N: number, M: number, P: number): PackingConfig => {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: 0 };
};

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

describe("Tighter method tuning", () => {
  it("gives each tunable method a preset per level, level 0 being today's settings", () => {
    expect(presetParams("mc_compress", 0)).toEqual({ sweepsPerEvaluation: 5 });
    expect(presetParams("mc_compress", 0, true)).toEqual({ sweepsPerEvaluation: 10 });
    expect(presetParams("mc_compress", 1, true)).toEqual({ sweepsPerEvaluation: 15 });
    expect(presetParams("asc", 0)).toEqual({});
    expect(presetParams("harden", 3)).toEqual({ evaluationInterval: 96 });
    // levels are clamped; methods without a tuning upgrade keep their defaults
    expect(presetParams("harden", 9)).toEqual(presetParams("harden", MAX_TUNING));
    expect(presetParams("harden", -1)).toEqual({});
    expect(presetParams("seed", 2)).toEqual({});
    expect(isTunable("morph")).toBe(false);
    for (const m of ALL) expect(isTunable(m)).toBe(!!TUNING[m]);
    // a tuning upgrade has as many levels as its method has kept presets
    for (const m of ALL) if (TUNING[m]) expect(upgrade(TUNING[m]!).levels!.max).toBe(tuningLevels(m));
    expect(tuningLevels("basin_hopping")).toBe(1);
    expect(presetParams("basin_hopping", 3)).toEqual({ kickMagnitude: 0.25 });
  });

  it("names only parameters the solver knows, nested ones complete", () => {
    for (const m of ALL) {
      const defaults = resolvedParams(m, {});
      for (let level = 0; level <= MAX_TUNING; level++) {
        const preset = presetParams(m, level, true);
        for (const [k, v] of Object.entries(preset)) {
          expect(Object.keys(defaults)).toContain(k);
          // a nested object replaces the default whole: it must name every key the default has
          if (typeof v === "object" && v !== null)
            expect(Object.keys(v as object).sort()).toEqual(Object.keys(defaults[k] as object).sort());
        }
      }
    }
  });

  it("takes the owned level, or a lower one when Auto-tune asks", () => {
    const o = owning(["sweeps10", "tuneMc", "harden", "tuneHarden"], { tuneMc: 2, tuneHarden: 1 });
    expect(methodParams(o, "mc_compress")).toEqual(presetParams("mc_compress", 2, true));
    expect(methodParams(o, "mc_compress", 1)).toEqual({ sweepsPerEvaluation: 15 });
    // never above the owned level
    expect(methodParams(o, "mc_compress", 3)).toEqual(presetParams("mc_compress", 2, true));
    expect(methodParams(o, "harden")).toEqual({ evaluationInterval: 48 });
    expect(methodParams(o, "asc")).toEqual({});
    expect(methodParams(owning([]), "mc_compress")).toEqual({ sweepsPerEvaluation: 5 });
  });
});

describe("Tighter method match", () => {
  const kind = "open|t80|r";
  const rand = (seed: number) => planRandom(newRunPlan(), seed);

  it("sorts problems into kinds by tier, size and piece shape", () => {
    expect(problemKind({ N: 21, M: 24, P: 40, tier: "open" })).toBe("open|t80|r");
    expect(problemKind({ N: 0, M: 6, P: 400, tier: "batch" })).toBe("batch|t300|c");
    expect(problemKind({ N: 4, M: 4, P: 10, tier: "published" })).toBe("published|t0|f");
    expect(problemKind({ N: 12, M: 5, P: 20, tier: "loose" })).toBe("loose|t30|m");
    expect(parseArm(armKey(kind, "mc_compress", 2))).toEqual({ kind, method: "mc_compress", level: 2 });
    expect(parseArm("nonsense")).toBeNull();
  });

  it("learns what a run paid per evaluation, and ignores runs too short to tell", () => {
    const plan = newRunPlan();
    expect(observeRun(plan, kind, "mc_compress", 0, 10, MIN_OBSERVED_EVALS - 1)).toBe(false);
    expect(observeRun(plan, kind, "mc_compress", 0, 10, 100)).toBe(true);
    expect(observeRun(plan, kind, "mc_compress", 0, Number.NaN, 100)).toBe(false);
    expect(plan.bandit[armKey(kind, "mc_compress", 0)]).toEqual({ n: 1, mean: 0.1, m2: 0 });
    expect(priorFor(plan.bandit, kind).mean).toBeCloseTo(0.1);
    // another kind starts from what all kinds paid
    expect(priorFor(plan.bandit, "loose|t300|f").mean).toBeCloseTo(0.1);
    expect(priorFor({}, kind)).toEqual({ mean: 0, sd: 1 });
  });

  it("chooses the method that pays most on problems of a kind, and still tries the others", () => {
    const plan = newRunPlan();
    for (let i = 0; i < 20; i++) {
      observeRun(plan, kind, "shrink_repair", 0, 50 + i, 100);
      observeRun(plan, kind, "mc_compress", 0, 10 + i, 100);
    }
    const r = rand(5);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      const c = chooseRun(plan, {
        kind,
        methods: ["mc_compress", "shrink_repair", "penalty"],
        levelOf: () => 0,
        tune: false,
        allowed: () => true,
        rand: r,
      })!;
      counts[c.method] = (counts[c.method] ?? 0) + 1;
    }
    expect(counts.shrink_repair).toBeGreaterThan(counts.mc_compress ?? 0);
    // an untried method has a wide prior: it is tried now and then
    expect(counts.penalty).toBeGreaterThan(0);
    expect(learned(plan, kind)[0]).toMatchObject({ method: "shrink_repair", runs: 20 });
  });

  it("with Auto-tune, also chooses among the owned levels; it never picks a method the rule refuses", () => {
    const plan = newRunPlan();
    for (let i = 0; i < 10; i++) {
      observeRun(plan, kind, "mc_compress", 0, 5, 100);
      observeRun(plan, kind, "mc_compress", 2, 40, 100);
    }
    const r = rand(9);
    const levels = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const c = chooseRun(plan, {
        kind,
        methods: ["mc_compress", "harden"],
        levelOf: (m) => (m === "mc_compress" ? 2 : 0),
        tune: true,
        allowed: (m) => m !== "harden",
        rand: r,
      })!;
      expect(c.method).toBe("mc_compress");
      levels.add(c.level);
    }
    expect([...levels].every((l) => l >= 0 && l <= 2)).toBe(true);
    expect(levels.has(2)).toBe(true);
    const none = chooseRun(plan, {
      kind,
      methods: ["harden"],
      levelOf: () => 0,
      tune: true,
      allowed: () => false,
      rand: r,
    });
    expect(none).toBeNull();
  });

  it("draws the same choices from the same seed, and counts its draws in the save", () => {
    const a = newRunPlan();
    const b = newRunPlan();
    const ra = planRandom(a, 42);
    const rb = planRandom(b, 42);
    const xs = [ra(), ra(), ra()];
    expect([rb(), rb(), rb()]).toEqual(xs);
    expect(a.draws).toBe(3);
    // a single allowed arm is taken without a draw
    const c = chooseRun(a, {
      kind,
      methods: ["mc_compress"],
      levelOf: () => 1,
      tune: false,
      allowed: () => true,
      rand: ra,
    });
    expect(c).toEqual({ method: "mc_compress", level: 1 });
    expect(a.draws).toBe(3);
    const saved = normalizeRunPlan(JSON.parse(JSON.stringify(a)), ["mc_compress"]);
    expect(saved.draws).toBe(3);
    expect(normalizeRunPlan({ draws: -1, pipeline: ["warp", "mc_compress"] }, ["mc_compress"])).toMatchObject({
      draws: 0,
      pipeline: ["mc_compress"],
    });
  });
});

describe("Tighter pipelines", () => {
  const pipe: EvolveMethod[] = ["mc_compress", "shrink_repair", "harden"];

  it("runs the next stage each time a run ends by itself, in a loop", () => {
    const all = () => true;
    expect([0, 1, 2, 3, 4].map((e) => pipelineMethod(pipe, e, all)?.method)).toEqual([
      "mc_compress",
      "shrink_repair",
      "harden",
      "mc_compress",
      "shrink_repair",
    ]);
    expect(pipelineMethod(pipe, 1, all)?.stage).toBe(1);
    expect(pipelineMethod([], 0, all)).toBeNull();
  });

  it("skips stages the cycle's rule refuses", () => {
    const noShrink = (m: EvolveMethod) => m !== "shrink_repair";
    expect(pipelineMethod(pipe, 1, noShrink)).toEqual({ method: "harden", stage: 2 });
    expect(pipelineMethod(pipe, 0, () => false)).toBeNull();
  });

  it("is edited stage by stage, up to its limit", () => {
    let p: EvolveMethod[] = [];
    p = addStage(p, "mc_compress");
    p = addStage(p, "harden");
    p = addStage(p, "asc");
    expect(moveStage(p, 2, -1)).toEqual(["mc_compress", "asc", "harden"]);
    expect(moveStage(p, 0, -1)).toEqual(p);
    expect(removeStage(p, 1)).toEqual(["mc_compress", "asc"]);
    let full: EvolveMethod[] = [];
    for (let i = 0; i < MAX_STAGES + 3; i++) full = addStage(full, "mc_compress");
    expect(full.length).toBe(MAX_STAGES);
  });
});

describe("Tighter transfers", () => {
  it("look at the closest neighbours with fewer pieces first", () => {
    expect(neighbourPs(60, false)).toEqual([40]);
    expect(neighbourPs(40, false)).toEqual([]);
    expect(neighbourPs(300, false)).toEqual([250, 200, 150, 120]);
    expect(neighbourPs(61, true)).toEqual([60, 59, 58, 40]);
    expect(neighbourPs(3, true)).toEqual([2]);
  });

  it("grow a neighbour's packing to the problem's pieces, its own pieces unchanged", async () => {
    // a compacted 21-gons in a 24-gon with 40 pieces, as a record would be
    const start = loadAll(21, 24, 40);
    const r = new OpenRun({
      problem: { N: 21, M: 24, P: 40 },
      method: "mc_compress",
      params: { sweepsPerEvaluation: 5 },
      budget: { evals: 1000 },
      seed: 1,
      start,
    });
    const s = await r.step(100);
    await r.close();
    const neighbour = s.best!;
    const board = transferBoard(neighbour, { N: 21, M: 24, P: 60 })!;
    expect(board.pieces.length).toBe(60);
    expect(board.pieces.slice(0, 40)).toEqual(neighbour.pieces);
    expect(findOverlaps(21, board.pieces)).toEqual([]);
    const t = scoredTransfer(neighbour, { N: 21, M: 24, P: 60 })!;
    expect(t.from).toBe(40);
    expect(t.score).toBe(evaluate(t.board, { autoOrient: true }).score);
    // many pieces added: they go around the centre (cheap); the start is then often larger than
    // Load all's rings, and chooseStart keeps Load all
    const laScore = evaluate(loadAll(21, 24, 60), { autoOrient: true }).score!;
    expect(chooseStart({ board: loadAll(21, 24, 60), score: laScore }, null, t).transferred).toBe(
      t.score < TRANSFER_MARGIN * laScore,
    );
    // one piece added: placed where it grows the container least, never larger than going around the centre
    const near = scoredTransfer({ ...neighbour, P: 40 }, { N: 21, M: 24, P: 41 })!;
    expect(near.board.pieces.length).toBe(41);
    expect(findOverlaps(21, near.board.pieces)).toEqual([]);
    // not a neighbour: other shapes, or as many pieces
    expect(transferBoard(neighbour, { N: 21, M: 21, P: 60 })).toBeNull();
    expect(transferBoard(neighbour, { N: 21, M: 24, P: 40 })).toBeNull();
  });

  it("start from a transfer only when it is clearly smaller than Load all, the floor below both", () => {
    const la = { board: loadAll(21, 24, 60), score: 10 };
    const t = { board: loadAll(21, 24, 60), score: 9, from: 40 };
    expect(chooseStart(la, null, t)).toMatchObject({ score: 9, floor: 9, transferred: true });
    expect(chooseStart(la, 8.5, t)).toMatchObject({ score: 9, floor: 8.5, transferred: true });
    // smaller, but not by the margin: Load all, whose score is then the floor
    expect(chooseStart(la, null, { ...t, score: 10 * TRANSFER_MARGIN })).toMatchObject({
      score: 10,
      floor: 10,
      transferred: false,
    });
    expect(chooseStart(la, null, { ...t, score: 11 })).toMatchObject({ score: 10, floor: 10, transferred: false });
    expect(chooseStart(la, null, null)).toMatchObject({ score: 10, floor: 10, transferred: false });
  });
});
