// Benchmarks of docs/methods/shrink_repair.md. From the repository root:
//
//   node --import tsx packages/solver/src/methods/shrink_repair/benchmark.mjs squares out.jsonl [workers]
//   node --import tsx packages/solver/src/methods/shrink_repair/benchmark.mjs general out.jsonl [workers]
//   node --import tsx packages/solver/src/methods/shrink_repair/benchmark.mjs report out.jsonl [more.jsonl ...]
//
// `squares`: unit squares in a square, P = 10, 17, 26, 37, 50, from the plain grid start and from a
// scattered start, five methods, seeds 1-3, 20,000 evaluations, final polish on. `general`: circles
// in a square (30), pentagons in a square (20), heptagons in a heptagon (19), triangles in a
// triangle (17) and hexagons in a hexagon (20), each method's own start. Runs already in the
// output file are skipped, so an interrupted benchmark resumes. Each run is its own process.
// Add `--only KEY-SUBSTRING` to run a subset. Nothing is ever submitted anywhere.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = new URL("../../../../../", import.meta.url);
const records = JSON.parse(readFileSync(new URL("data/records.json", root), "utf8")).records;
const METHODS = ["shrink_repair", "asc", "harden", "mc_compress", "basin_hopping"];
const SEEDS = [1, 2, 3];
const EVALS = 20000;

/** Mulberry32, the framework's seededRandom. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const bounding = (N) => (N === 0 ? 0.5 : 1 / (2 * Math.sin(Math.PI / N)));

/**
 * Scattered valid start: centres uniform in [-v, v]^2 with v the published size, angles uniform
 * over the symmetry period, rejecting a piece whose bounding disk meets one already placed.
 */
function scattered(N, M, P, v, seed) {
  const random = rng(1000 + seed);
  const reach = 2 * bounding(N);
  const pieces = [];
  while (pieces.length < P) {
    const x = (2 * random() - 1) * v;
    const y = (2 * random() - 1) * v;
    const theta = N === 0 ? 0 : (2 * Math.PI * random()) / N;
    if (pieces.some((p) => Math.hypot(p.x - x, p.y - y) < reach)) continue;
    pieces.push({ x, y, theta });
  }
  return { N, M, P, container_phi: 0, pieces };
}

/** Plain grid: ceil(sqrt P) columns of edge-aligned unit squares (theta = pi/4) at pitch 1. */
function grid(N, M, P) {
  const w = Math.ceil(Math.sqrt(P));
  return {
    N,
    M,
    P,
    container_phi: 0,
    pieces: Array.from({ length: P }, (_, i) => ({ x: i % w, y: Math.floor(i / w), theta: Math.PI / 4 })),
  };
}

function jobs(kind) {
  const tag = kind === "squares" ? "E1" : "E2";
  const problems =
    kind === "squares"
      ? [10, 17, 26, 37, 50].map((P) => [4, 4, P])
      : [
          [0, 4, 30],
          [5, 4, 20],
          [7, 7, 19],
          [3, 3, 17],
          [6, 6, 20],
        ];
  const out = [];
  for (const [N, M, P] of problems) {
    const v = records.find((r) => r.N === N && r.M === M && r.P === P)?.value ?? Math.sqrt(P) * 2 * bounding(N) * 1.2;
    for (const startKind of kind === "squares" ? ["grid", "scatter"] : ["default"]) {
      for (const method of METHODS) {
        for (const seed of SEEDS) {
          const job = {
            key: `${tag}-${N}/${M}/${P}-${startKind}-${method}-${seed}`,
            N,
            M,
            P,
            method,
            params: {},
            seed,
            evals: EVALS,
            startKind,
          };
          if (startKind === "grid") job.startConfig = grid(N, M, P);
          if (startKind === "scatter") job.startConfig = scattered(N, M, P, v, seed);
          out.push(job);
        }
      }
    }
  }
  return out;
}

/** One run in this process; prints one JSON line. */
async function runJob(job) {
  const { run, strictTolerance } = await import(new URL("packages/solver/src/index.ts", root).href);
  const { evaluate, findOverlaps, pieceSeparation } = await import(
    new URL("packages/geometry/src/index.ts", root).href
  );
  const { N, M, P, method, params, seed, evals } = job;
  const t0 = performance.now();
  const r = await run(
    { N, M, P },
    { method, params, seed, budget: { evals }, start: job.startConfig, finalPolish: true },
  );
  const seconds = (performance.now() - t0) / 1000;
  let gap = Infinity;
  let strict = false;
  let rescore = NaN;
  if (r.best) {
    strict = findOverlaps(N, r.best.pieces, strictTolerance(r.best)).length === 0;
    rescore = evaluate(r.best, { autoOrient: true }).score;
    for (let i = 0; i < P; i++)
      for (let j = 0; j < i; j++) gap = Math.min(gap, pieceSeparation(N, r.best.pieces[i], r.best.pieces[j]).sep);
  }
  const { startConfig: _, ...rest } = job;
  console.log(
    JSON.stringify({
      ...rest,
      score: r.score,
      valid: r.valid,
      strict: r.strict && strict,
      rescoreDiff: Math.abs(rescore - (r.score ?? NaN)),
      gap,
      evaluations: r.evaluations,
      seconds,
      termination: r.termination,
    }),
  );
}

async function runAll(list, out, workers) {
  const done = new Set();
  if (existsSync(out))
    for (const line of readFileSync(out, "utf8").split("\n")) if (line.trim()) done.add(JSON.parse(line).key);
  const todo = list.filter((j) => !done.has(j.key));
  console.error(`${todo.length} runs to do, ${list.length - todo.length} already in ${out}`);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const job = todo[next++];
      const text = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", here, "--job", JSON.stringify(job)], {
          cwd: fileURLToPath(root),
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", () => resolve(stdout.trim() || JSON.stringify({ key: job.key, error: stderr.slice(-500) })));
      });
      appendFileSync(out, text + "\n");
      const r = JSON.parse(text);
      console.error(`${r.key}: ${r.score ?? r.error} (${r.seconds?.toFixed(1) ?? "?"} s)`);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
}

function report(files) {
  const rows = files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
  const fmt = (x, d = 6) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "—");
  console.log(
    "| N/M/P | Start | Published | Method | Scores, seeds 1, 2, 3 | Best / published | Median / published | Mean s | Mean evals |",
  );
  console.log(
    "| ----- | ----- | --------- | ------ | --------------------- | ---------------- | ------------------ | ------ | ---------- |",
  );
  const keys = [...new Set(rows.map((r) => `${r.N}/${r.M}/${r.P}|${r.startKind}`))];
  let problems = 0;
  for (const key of keys) {
    const [name, start] = key.split("|");
    const [N, M, P] = name.split("/").map(Number);
    const published = records.find((r) => r.N === N && r.M === M && r.P === P)?.value;
    for (const method of METHODS) {
      const g = rows
        .filter((r) => `${r.N}/${r.M}/${r.P}|${r.startKind}` === key && r.method === method)
        .sort((a, b) => a.seed - b.seed);
      if (!g.length) continue;
      for (const r of g)
        if (r.error || !r.valid || !r.strict || r.rescoreDiff > 1e-12 || r.evaluations > r.evals) problems++;
      const scores = g.map((r) => r.score);
      const sorted = [...scores].sort((a, b) => a - b);
      const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
      const mean = (k) => g.reduce((s, r) => s + r[k], 0) / g.length;
      console.log(
        `| ${name} | ${start} | ${published ? fmt(published) : "none"} | ${method} | ${scores.map((s) => fmt(s)).join(", ")} | ${
          published ? fmt(sorted[0] / published, 5) : "—"
        } | ${published ? fmt(median / published, 5) : "—"} | ${fmt(mean("seconds"), 1)} | ${Math.round(mean("evaluations"))} |`,
      );
    }
  }
  const gap = Math.min(...rows.map((r) => r.gap).filter(Number.isFinite));
  console.log(
    `\n${rows.length} runs; ${problems} invalid, non-strict, over budget or mis-scored; smallest pair separation ${gap}`,
  );
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "--job") await runJob(JSON.parse(rest[0]));
else if (mode === "report") report(rest);
else if (mode === "squares" || mode === "general") {
  const only = rest.indexOf("--only");
  const filter = only >= 0 ? rest[only + 1] : "";
  const positional = rest.filter((_, i) => only < 0 || (i !== only && i !== only + 1));
  await runAll(
    jobs(mode).filter((j) => j.key.includes(filter)),
    positional[0],
    Number(positional[1] ?? 4),
  );
} else {
  console.error("usage: benchmark.mjs squares|general OUT.jsonl [workers] [--only KEY] | report FILE.jsonl ...");
  process.exit(2);
}
