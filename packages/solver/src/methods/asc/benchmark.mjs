// Standalone Node measurement harness; never imported by the environment-free solver.
import fs from "node:fs";
import { MethodRegistry, seededRandom } from "../../index.ts";
import { identityMethod, polishMethod } from "../../methods.ts";
import { seedMethod } from "../seed.ts";
import { penaltyMethod } from "../penalty.ts";
import { mcCompressMethod } from "../mc_compress.ts";
import { ascMethod, executeAsc } from "../asc.ts";
import { pieceSeparation } from "@polypack/geometry";

const masterPath = "packages/solver/src/methods/asc/benchmark.json";
const selectedProblem = process.argv.find((argument) => argument.startsWith("--problem="))?.slice(10);
const resultPath = selectedProblem
  ? `packages/solver/src/methods/asc/benchmark-${selectedProblem.replaceAll("/", "-")}.json`
  : masterPath;
const docPath = "docs/methods/asc.md";
const problems = [
  [4, 4, 5],
  [4, 4, 10],
  [0, 0, 12],
  [0, 0, 19],
  [0, 4, 10],
  [5, 5, 6],
];
const records = JSON.parse(fs.readFileSync("data/records.json", "utf8")).records;

function scatteredStart(problem, value, seed) {
  const random = seededRandom(seed);
  // Random sequential insertion can jam below the requested population.
  // Restart the whole draw with the same continuing PRNG stream, keeping
  // every accepted centre in the specified box and every pair strictly clear.
  for (let restart = 0; restart < 256; restart++) {
    const pieces = [];
    for (let trials = 0; pieces.length < problem.P && trials < 100000; trials++) {
      const p = {
        x: (2 * random() - 1) * value,
        y: (2 * random() - 1) * value,
        theta: problem.N === 0 ? 0 : (random() * 2 * Math.PI) / problem.N,
      };
      if (pieces.every((q) => pieceSeparation(problem.N, p, q).sep >= 0)) pieces.push(p);
    }
    if (pieces.length === problem.P) return { ...problem, pieces, container_phi: 0 };
  }
  throw new Error("Scatter restart cap exceeded");
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const success = (rows, tolerance) => rows.filter((r) => Math.abs(r.score - r.record) <= tolerance).length;

function writeReport(output) {
  if (output.rows.length !== 1920) throw new Error(`Expected 1920 benchmark runs, got ${output.rows.length}`);
  const rows = output.rows;
  const primary = rows.filter((r) => ["asc", "mc_compress", "penalty"].includes(r.variant));
  const groups = new Map();
  for (const r of rows) {
    const key = [r.N, r.M, r.P, r.budget, r.startKind, r.variant].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  if (groups.size !== 96) throw new Error(`Expected 96 groups, got ${groups.size}`);
  for (const group of groups.values()) {
    const seeds = new Set(group.map((r) => r.seed));
    if (group.length !== 20 || seeds.size !== 20 || [...seeds].some((seed) => seed < 1 || seed > 20))
      throw new Error("Expected seeds 1–20 exactly once per group");
  }
  const number = (n) => n.toFixed(10);
  const groupFor = (N, M, P, budget, startKind, variant) => groups.get([N, M, P, budget, startKind, variant].join(":"));
  const lines = [
    "[CALC] All 1,440 main runs and 480 ablations completed. Each table row contains",
    "seeds 1–20, using the unchanged defaults, the stated overall evaluation cap,",
    "and final polish on. Raw per-seed scores, evaluation counts, wall times,",
    "minimum separations, move statistics and returned poses are saved in",
    "[benchmark.json](../../packages/solver/src/methods/asc/benchmark.json).",
    "Repeat from the repository root with:",
    "",
    "```sh",
    "node --import tsx packages/solver/src/methods/asc/benchmark.mjs",
    "node --import tsx packages/solver/src/methods/asc/benchmark.mjs --report",
    "```",
    "",
    "[CALC] Scattered starts sample each centre uniformly in [−v,v]², where v is",
    "the stored record size, and each polygon angle uniformly over its symmetry",
    "period. Negative pair separation rejects the new piece. The same start for",
    "each seed goes to all methods. The box side is twice the record size, including",
    "when the record size denotes a circle diameter. Default-seed rows give each",
    "method its own normal automatic bootstrap; no record poses are supplied.",
    "The raw file preserves every returned arrangement for rechecking.",
    "Random insertion retries the whole start after 100,000 draws if it jams;",
    "retries continue the same seeded PRNG stream, capped at 256 starts.",
    "",
    "[CALC] Success means absolute score difference from `data/records.json.value`",
    "at most the specified tolerance. Scores smaller by more than that tolerance",
    "are not silently counted as successes. The pentagon entry is truncated to",
    "2.61803 even though its citation gives (3+√5)/2, differing by about 3.99e−6;",
    "the 1e−9 column therefore cannot recognize the exact pentagon construction.",
    "No record-data change was made. Evaluation caps are hard upper bounds, not",
    "a requirement to repeat jammed states: actual median counts are shown.",
    "",
    "[CALC] Measurements used Node v26.5.0 on arm64. Wall times",
    "include final polish and final auto-orientation. ASC's synchronous per-move",
    "observer adds instrumentation overhead; other methods are uninstrumented.",
    "Some groups overlapped test execution or other benchmark processes. These are local costs,",
    "not a controlled machine-isolated timing comparison or browser claim.",
    "",
    "| N/M/P | Stored record |",
    "| --- | ---: |",
  ];
  for (const [N, M, P] of problems)
    lines.push(`| ${N}/${M}/${P} | ${records.find((r) => r.N === N && r.M === M && r.P === P).value} |`);
  lines.push(
    "",
    "### Comparisons",
    "",
    "[CALC] Success columns are counts out of 20. Time columns are seconds.",
    "",
    "| N/M/P | Cap | Start | Method | ≤1e−4 | ≤1e−9 | Median score | Worst score | Median evals | Median s | Worst s | Total s |",
    "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const group of groups.values()) {
    const r = group[0];
    if (!["asc", "mc_compress", "penalty"].includes(r.variant)) continue;
    lines.push(
      `| ${r.N}/${r.M}/${r.P} | ${r.budget} | ${r.startKind} | ${r.variant} | ${success(group, 1e-4)} | ${success(group, 1e-9)} | ${number(median(group.map((v) => v.score)))} | ${number(Math.max(...group.map((v) => v.score)))} | ${median(group.map((v) => v.evaluations))} | ${median(group.map((v) => v.wallTime)).toFixed(3)} | ${Math.max(...group.map((v) => v.wallTime)).toFixed(3)} | ${group.reduce((s, v) => s + v.wallTime, 0).toFixed(3)} |`,
    );
  }
  lines.push(
    "",
    "### Move ablation at 3,000 evaluations",
    "",
    "[CALC] Each entry is median score / successes within 1e−4 out of 20. Disabling",
    "container moves disables centre and phi; scale stays enabled. Disabling",
    "collective moves disables all four strains and the radial warmup. Different",
    "active proposals consume different random streams, so paired seeds are not",
    "identical trial trajectories. These comparisons assess the whole variants.",
    "",
    "| N/M/P | Start | Full ASC | Without centre/phi | Without collective moves |",
    "| --- | --- | ---: | ---: | ---: |",
  );
  for (const [N, M, P] of problems) {
    for (const startKind of ["seed", "scatter"]) {
      const cells = ["asc", "asc_no_container", "asc_no_collective"].map((v) => {
        const g = groupFor(N, M, P, 3000, startKind, v);
        return `${number(median(g.map((r) => r.score)))} / ${success(g, 1e-4)}`;
      });
      lines.push(`| ${N}/${M}/${P} | ${startKind} | ${cells.join(" | ")} |`);
    }
  }
  const ascRows = primary.filter((r) => r.variant === "asc");
  const totals = {};
  for (const r of ascRows) {
    for (const [kind, s] of Object.entries(r.statistics ?? {})) {
      totals[kind] ??= { attempts: 0, accepted: 0, improvements: 0, scoreGain: 0 };
      for (const field of Object.keys(totals[kind])) totals[kind][field] += s[field];
    }
  }
  const improvementCount = Object.values(totals).reduce((s, r) => s + r.improvements, 0);
  const scoreGain = Object.values(totals).reduce((s, r) => s + r.scoreGain, 0);
  lines.push(
    "",
    "### Acceptance and observed improvements",
    "",
    "[CALC] Aggregated over the 480 default ASC runs, including warmup. An observed",
    "score improvement is attributed to the last accepted move that changed poses",
    "or phi before its assessment. Centre/size-only moves cannot independently",
    "change the scored JSON and consequently get zero direct attribution. Multiple",
    "accepted moves can contribute between assessments. This last-change accounting",
    "includes tiny floating-point improvements and excludes seed and final-polish",
    "improvements; it is not a causal marginal-benefit estimate. Ablations above",
    "provide the more useful evidence of marginal benefit.",
    "",
    "| Move | Attempts | Accepted | Acceptance % | Improvement count | Share of improvements % | Share of score drop % |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const [kind, s] of Object.entries(totals))
    lines.push(
      `| ${kind} | ${s.attempts} | ${s.accepted} | ${((100 * s.accepted) / s.attempts).toFixed(3)} | ${s.improvements} | ${((100 * s.improvements) / improvementCount).toFixed(3)} | ${((100 * s.scoreGain) / scoreGain).toFixed(3)} |`,
    );
  lines.push(
    "",
    "### Separation and interpretation",
    "",
    `[CALC] Minimum pair separation over all 1,920 returned results: **${Math.min(...rows.map((r) => r.minPairSeparation)).toExponential(17)}** piece units. For default ASC alone: **${Math.min(...ascRows.map((r) => r.minPairSeparation)).toExponential(17)}**. This includes the framework's final polish; ASC's accepted chain states are tested at zero tolerance.`,
    "",
  );
  if (output.validation) {
    const validation = output.validation;
    lines.push(
      `[CALC] Historical benchmark validation: re-evaluating all ${validation.recheckedResults} saved arrangements with shared geometry found ${validation.invalidResults} invalid results under the shared strict 1e−12 check and ${validation.scoreOrBudgetMismatches} score or budget mismatches. The largest positive protrusion of the scored enclosure was ${validation.maxScoredContainerProtrusion.toExponential(17)}. Consequently, absolute zero pair penetration and absolute zero protrusion cannot be claimed for the final shared result: final polish and enclosure rounding need changes outside ASC. Every internal accepted ASC state is checked at zero tolerance.`,
      "",
    );
  }
  lines.push("| Method | Runs | ≤1e−4 | ≤1e−9 | Minimum pair separation |", "| --- | ---: | ---: | ---: | ---: |");
  for (const variant of ["asc", "mc_compress", "penalty"]) {
    const selected = primary.filter((r) => r.variant === variant);
    lines.push(
      `| ${variant} | ${selected.length} | ${success(selected, 1e-4)} | ${success(selected, 1e-9)} | ${Math.min(...selected.map((r) => r.minPairSeparation)).toExponential(17)} |`,
    );
  }
  const compareMedians = (variant, budgets) => {
    const counts = { better: 0, worse: 0, tied: 0 };
    for (const [N, M, P] of problems) {
      for (const budget of budgets) {
        for (const startKind of ["seed", "scatter"]) {
          const full = groupFor(N, M, P, budget, startKind, "asc");
          const other = groupFor(N, M, P, budget, startKind, variant);
          const difference = median(full.map((r) => r.score)) - median(other.map((r) => r.score));
          if (difference < -1e-8) counts.better++;
          else if (difference > 1e-8) counts.worse++;
          else counts.tied++;
        }
      }
    }
    return counts;
  };
  const mcComparison = compareMedians("mc_compress", [3000, 30000]);
  const centreComparison = compareMedians("asc_no_container", [3000]);
  const strainComparison = compareMedians("asc_no_collective", [3000]);
  const fullShort = ascRows.filter((r) => r.budget === 3000);
  const noCentre = rows.filter((r) => r.variant === "asc_no_container");
  const noStrain = rows.filter((r) => r.variant === "asc_no_collective");
  lines.push(
    "",
    `[CALC] **The additional container and collective moves do not establish a consistent advantage over mc_compress at these defaults.** ASC has ${mcComparison.better} lower, ${mcComparison.worse} higher and ${mcComparison.tied} tied median scores across the 24 problem/start/budget groups, using 1e−8 to distinguish medians. Its overall record success counts are lower than mc_compress. There are real case-specific gains: scattered pentagons improve from 8/20 to 12/20 near-record successes at both caps, scattered circles in a square from 3/20 to 6/20, and scattered 19-circle packings from 15/20 to 16/20. Scattered ten-square medians improve substantially, but record hits are fewer. Twelve-circle results are markedly worse.`,
    "",
    `[CALC] Centre/phi ablation: full ASC has ${centreComparison.better} better, ${centreComparison.worse} worse and ${centreComparison.tied} tied medians across 12 groups. At 3,000 evaluations, full ASC has ${success(fullShort, 1e-4)}/240 near-record successes, compared with ${success(noCentre, 1e-4)}/240 without centre/phi moves and ${success(noStrain, 1e-4)}/240 without collective moves. For collective ablation the median counts are ${strainComparison.better} better, ${strainComparison.worse} worse and ${strainComparison.tied} tied. Collective movement helps some layouts, particularly ten-square medians, but also hurts success rates. The radial move receives ${((100 * totals.radial.scoreGain) / scoreGain).toFixed(3)}% of the observed score-drop attribution; mc_compress already includes uniform centre contraction, so this does not demonstrate a benefit from anisotropic strains.`,
    "",
  );
  lines.push(
    "",
    "[CALC] The exact reported commands `npm run typecheck` and",
    "`npx vitest run packages/geometry packages/solver` passed: all four workspace",
    "typechecks, and 20 test files / 403 tests. ASC's 13 tests completed in 22.286 s",
    "during that full-suite run (full suite 32.67 s). They cover randomized shapes",
    "and counts, shared-geometry invariants at every assessment, each collective",
    "move, the expanded known packings, strict rejection, zero-temperature size",
    "monotonicity, deterministic and exact-cap operation, small-budget invalid-start",
    "repair, time-budget overshoot below 0.2 s and timer abort below 1 s.",
    "",
    "[CALC] Node throughput without instrumentation or final polish, 300 assessments",
    "from loose P=30 grids, seed 1: N=M=0: 1193.5 eval/s; 3: 482.9; 4: 588.0;",
    "5: 488.9; 6: 532.5; 8: 407.3. Browser throughput remains unmeasured.",
    "",
    "### Complete parameter schema",
    "",
    "[CALC] Generated from the registered method metadata; defaults are listed above.",
    "",
    "```json",
    JSON.stringify(ascMethod.schema, null, 2),
    "```",
    "",
  );
  const prefix = fs.readFileSync(docPath, "utf8").split("## Benchmark results")[0];
  fs.writeFileSync(docPath, `${prefix}## Benchmark results\n\n${lines.join("\n")}`);
}

if (process.argv.includes("--report")) {
  const output = JSON.parse(fs.readFileSync(masterPath, "utf8"));
  const merged = new Map(
    output.rows.map((r) => [[r.N, r.M, r.P, r.budget, r.startKind, r.variant, r.seed].join(":"), r]),
  );
  for (const file of fs.readdirSync("packages/solver/src/methods/asc")) {
    if (!/^benchmark-\d+-\d+-\d+\.json$/.test(file)) continue;
    const fragment = JSON.parse(fs.readFileSync(`packages/solver/src/methods/asc/${file}`, "utf8"));
    for (const r of fragment.rows) merged.set([r.N, r.M, r.P, r.budget, r.startKind, r.variant, r.seed].join(":"), r);
  }
  output.rows = [...merged.values()];
  if (output.rows.length !== 1920) throw new Error(`Expected 1920 complete rows; got ${output.rows.length}`);
  output.protocol.scatter =
    "uniform positions in square of side twice stored record size; random polygon angles, reject negative shared pair separation; whole-start retries after 100000 draws, continuing seeded PRNG, cap 256";
  fs.writeFileSync(masterPath, `${JSON.stringify(output, null, 2)}\n`);
  writeReport(output);
} else {
  const output = {
    protocol: {
      seeds: [1, 20],
      budgets: [3000, 30000],
      finalPolish: true,
      scatter:
        "uniform positions in square of side twice stored record size; random polygon angles, reject negative shared pair separation",
      note: "ASC wall times include per-move observation overhead; strict minimum uses shared pieceSeparation; original defaults are used for all three methods.",
    },
    rows: process.argv.includes("--resume")
      ? JSON.parse(fs.readFileSync(fs.existsSync(resultPath) ? resultPath : masterPath, "utf8")).rows.filter(
          (r) => !selectedProblem || [r.N, r.M, r.P].join("/") === selectedProblem,
        )
      : [],
  };
  const completed = new Set(
    output.rows.map((r) => [r.N, r.M, r.P, r.budget, r.startKind, r.variant, r.seed].join(":")),
  );
  let statistics;
  const measuredRegistry = new MethodRegistry();
  for (const method of [identityMethod, polishMethod, seedMethod, penaltyMethod, mcCompressMethod])
    measuredRegistry.register(method);
  measuredRegistry.register({
    ...ascMethod,
    execute: async (ctx) => {
      await executeAsc(ctx, (event) => {
        if (event.kind === "final") statistics = event.statistics;
      });
    },
  });
  for (const [N, M, P] of problems) {
    if (selectedProblem && [N, M, P].join("/") !== selectedProblem) continue;
    const problem = { N, M, P };
    const record = records.find((r) => r.N === N && r.M === M && r.P === P);
    const scatterCache = new Map();
    for (const budget of [3000, 30000]) {
      for (const startKind of ["seed", "scatter"]) {
        for (const variant of [
          "asc",
          "mc_compress",
          "penalty",
          ...(budget === 3000 ? ["asc_no_container", "asc_no_collective"] : []),
        ]) {
          for (let seed = 1; seed <= 20; seed++) {
            const key = [N, M, P, budget, startKind, variant, seed].join(":");
            if (completed.has(key)) continue;
            statistics = undefined;
            if (startKind === "scatter" && !scatterCache.has(seed))
              scatterCache.set(seed, scatteredStart(problem, record.value, seed));
            const start = startKind === "scatter" ? scatterCache.get(seed) : undefined;
            const method = variant.startsWith("asc") ? "asc" : variant;
            const params =
              variant === "asc_no_container"
                ? { containerMoves: false }
                : variant === "asc_no_collective"
                  ? { collectiveMoves: false }
                  : {};
            const result = await measuredRegistry.run(problem, {
              method,
              params,
              start,
              budget: { evals: budget },
              seed,
              finalPolish: true,
            });
            if (!result.valid || !result.best)
              throw new Error(JSON.stringify({ N, M, P, budget, seed, variant, reasons: result.reasons }));
            let minimum = Infinity;
            for (let i = 0; i < P; i++) {
              for (let j = 0; j < i; j++)
                minimum = Math.min(minimum, pieceSeparation(N, result.best.pieces[i], result.best.pieces[j]).sep);
            }
            output.rows.push({
              N,
              M,
              P,
              budget,
              startKind,
              variant,
              seed,
              record: record.value,
              score: result.score,
              evaluations: result.evaluations,
              wallTime: result.wallTime,
              termination: result.termination,
              minPairSeparation: minimum,
              statistics,
              best: result.best,
            });
          }
          fs.writeFileSync(resultPath, `${JSON.stringify(output, null, 2)}\n`);
          console.log(JSON.stringify({ N, M, P, budget, startKind, variant, completed: output.rows.length }));
        }
      }
    }
  }
}
