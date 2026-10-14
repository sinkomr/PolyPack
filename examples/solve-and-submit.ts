/**
 * Run one PolyPack search method on a problem and, when asked, submit the result.
 *
 * Usage, from the repository root (Node 24 or newer, after `npm install`):
 *
 *   npx tsx examples/solve-and-submit.ts --N 4 --M 4 --P 11 --method basin_hopping \
 *     --evals 20000 --time 20 --seed 1 [--base http://localhost:8787] [--name "my bot"] \
 *     [--note "..."] [--submit]
 *   npx tsx examples/solve-and-submit.ts --method list
 *
 * Without --submit nothing is ever sent. With it, the result is submitted only when it is valid
 * and improves on the problem's current leader by more than the tie tolerance, because an entry
 * of equal quality never replaces an earlier one. Problems with a proven optimum are closed and
 * are refused before any search.
 *
 * Exit codes: 0 done; 1 no valid packing was found, or the server could not be reached or
 * refused the submission; 2 wrong arguments or a closed problem.
 */
import { parseArgs } from "node:util";
import { type ProblemInfo, SCORE_TIE, type SubmitResponse, improvesOn } from "@polypack/geometry";
import { registry, run } from "@polypack/solver";

function fail(code: 1 | 2, message: string): never {
  console.error(message);
  process.exit(code);
}

let args;
try {
  args = parseArgs({
    options: {
      N: { type: "string" },
      M: { type: "string" },
      P: { type: "string" },
      method: { type: "string", default: "basin_hopping" },
      evals: { type: "string", default: "20000" },
      time: { type: "string", default: "20" },
      seed: { type: "string", default: "1" },
      base: { type: "string", default: "http://localhost:8787" },
      name: { type: "string", default: "solve-and-submit example" },
      note: { type: "string" },
      submit: { type: "boolean", default: false },
    },
  }).values;
} catch (error) {
  fail(2, `${(error as Error).message}\nSee the comment at the top of examples/solve-and-submit.ts for the options.`);
}

const methods = registry.list();
// These two refine a configuration they are given; this script starts every search from nothing.
const NEEDS_START = ["identity", "polish"];
if (args.method === "list") {
  for (const m of methods) {
    const needs = NEEDS_START.includes(m.name) ? " (needs a starting configuration: library only)" : "";
    console.log(`${m.name.padEnd(14)} ${(m.schema as { description?: string }).description ?? ""}${needs}`);
  }
  process.exit(0);
}
if (!methods.some((m) => m.name === args.method)) {
  fail(2, `unknown method "${args.method}"; registered: ${methods.map((m) => m.name).join(", ")}`);
}
if (NEEDS_START.includes(args.method)) {
  fail(
    2,
    `"${args.method}" refines a starting configuration, which this script does not take; use run() with \`start\``,
  );
}

/** A plain non-negative decimal integer option; anything else ends the script. */
function integer(name: "N" | "M" | "P" | "evals" | "seed"): number {
  const text = args[name];
  if (text === undefined || !/^\d{1,10}$/.test(text)) fail(2, `--${name} must be a non-negative integer`);
  return Number(text);
}
const problem = { N: integer("N"), M: integer("M"), P: integer("P") };
const evals = integer("evals");
const seed = integer("seed");
const time_s = Number(args.time);
if (!Number.isFinite(time_s) || time_s <= 0) fail(2, "--time must be a positive number of seconds");
if (evals < 1) fail(2, "--evals must be at least 1");
const base = args.base.replace(/\/+$/, "");

// ---------- the problem ----------

let info: ProblemInfo;
try {
  const response = await fetch(`${base}/api/problems/${problem.N}/${problem.M}/${problem.P}`);
  const body = await response.json();
  // out-of-range N, M or P
  if (!response.ok) fail(2, `${base} refused the problem: ${body.error ?? response.status}`);
  info = body as ProblemInfo;
} catch (error) {
  fail(1, `could not read the problem from ${base}: ${(error as Error).message}`);
}

const lit = info.literature;
const leader = info.site_best;
console.log(`problem     N=${problem.N} M=${problem.M} P=${problem.P}`);
console.log(`area bound  ${info.area_bound}`);
console.log(`published   ${lit ? `${lit.display} (${lit.status}, ${lit.source_name})` : "none"}`);
console.log(`leader      ${leader ? `${leader.score} by ${leader.name}` : "none"}`);

if (info.accepts_submissions === false) {
  fail(
    2,
    `This problem is closed: its optimum${lit ? ` ${lit.display}` : ""} is proven, so the site takes no entries for it.`,
  );
}

// ---------- the search ----------

console.log(`running     ${args.method}, at most ${evals} evaluations and ${time_s} s, seed ${seed}`);
const result = await run(problem, { method: args.method, budget: { evals, time_s }, seed });
console.log(`score       ${result.score ?? "none"}`);
console.log(
  `valid       ${result.valid}${result.valid && !result.strict ? " (only within the validity tolerance)" : ""}`,
);
console.log(`evaluations ${result.evaluations}`);
console.log(`wall time   ${result.wallTime.toFixed(2)} s (${result.termination})`);
if (!result.valid || !result.best || result.score === null) {
  fail(1, `no valid packing was found: ${result.reasons.join("; ") || "no reason given"}`);
}

// ---------- the submission ----------

if (!args.submit) {
  console.log("not submitted: pass --submit to send a result that improves on the leader");
  process.exit(0);
}
if (leader && !improvesOn(result.score, leader.score)) {
  const tie = result.score <= leader.score * (1 + SCORE_TIE);
  console.log(
    tie
      ? `not submitted: ${result.score} equals the leader's ${leader.score} within the tie tolerance ` +
          `(relative ${SCORE_TIE}); the earlier entry keeps the lead`
      : `not submitted: ${result.score} is worse than the leader's ${leader.score}`,
  );
  process.exit(0);
}

let status: number;
let answer: SubmitResponse;
try {
  // The rate limits count per minute, so a refusal for that reason is retried after one.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...result.best,
        name: args.name,
        agent: "ai",
        agent_note: args.note ?? `${args.method}, seed ${seed}, ${result.evaluations} evaluations`,
      }),
    });
    status = response.status;
    answer = (await response.json()) as SubmitResponse;
    if (status !== 429 || attempt === 2) break;
    console.log("server      HTTP 429 (rate limit); trying again in 65 s");
    await new Promise((resolve) => setTimeout(resolve, 65_000));
  }
} catch (error) {
  fail(1, `the submission could not be sent: ${(error as Error).message}`);
}
console.log(`server      HTTP ${status}`);
console.log(JSON.stringify({ ...answer, container: undefined }, null, 2));
if (!answer.valid) fail(1, `the server refused the submission: ${(answer.reasons ?? []).join("; ")}`);
console.log(
  answer.leader
    ? `submitted as entry ${answer.id}: it now leads the problem with ${answer.score}`
    : answer.id === null
      ? `valid, but not among the three best kept for this problem; the leader stays at ${answer.leader_score}`
      : `kept as entry ${answer.id}, but the leader stays at ${answer.leader_score}`,
);
