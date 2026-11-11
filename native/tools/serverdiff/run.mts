// The differential harness in one command (README.md): writes the scenarios, replays each against
// two servers, compares the transcripts and prints what differs.
//
//   node --import tsx native/tools/serverdiff/run.mts --out DIR \
//        --ref  "node --import tsx native/tools/serverdiff/ref-server.mts" \
//        --cand "native/target/release/polypack-server"
//
//   --self             the candidate is the reference again (two fresh runs must be identical)
//   --only REGEX       scenarios whose name matches; --skip REGEX leaves some out
//   --quick            without the scenarios that wait a minute or more
//   --bulk N           real entries replayed by each bulk scenario (default 1500)
//   --jobs J           scenarios run at once (default 4)
//   --reuse-ref        do not run the reference where its transcript is already in DIR
//   --mutant NAME      the candidate is the reference with one deliberate defect (lib/mutants.mts)
//   --coverage         the reference runs under NODE_V8_COVERAGE, into DIR/coverage (see coverage.mts)
//   --list             prints the inventory of scenarios and stops
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Comparison, compareTranscripts, describe } from "./lib/compare.mts";
import { RunResult, runScenario } from "./lib/runner.mts";
import { buildScenarios } from "./scenarios/index.mts";

const REF = "node --import tsx native/tools/serverdiff/ref-server.mts";

function args(): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]!.startsWith("--")) throw new Error(`unexpected argument ${a[i]}`);
    const key = a[i]!.slice(2);
    const flag = ["self", "quick", "reuse-ref", "coverage", "list"].includes(key);
    out[key] = flag ? true : (a[++i] ?? "");
  }
  return out;
}

const opt = args();
const outDir = typeof opt.out === "string" ? resolve(opt.out) : "";
if (!outDir && !opt.list) {
  console.error("--out DIR is required (a scratch directory; never the repository)");
  process.exit(2);
}
const ref = typeof opt.ref === "string" ? opt.ref : REF;
const cand = opt.self || opt.mutant ? ref : typeof opt.cand === "string" ? opt.cand : "";
if (!cand && !opt.list) {
  console.error("give --cand COMMAND, or --self, or --mutant NAME");
  process.exit(2);
}
const bulk = typeof opt.bulk === "string" ? Number(opt.bulk) : 1500;
const jobs = typeof opt.jobs === "string" ? Number(opt.jobs) : 4;
const only = typeof opt.only === "string" ? new RegExp(opt.only) : null;
const skip = typeof opt.skip === "string" ? new RegExp(opt.skip) : null;

const all = await buildScenarios({ bulk, cacheDir: outDir ? join(outDir, "cache") : "" });
const chosen = all.filter(
  (s) => (!only || only.test(s.header.scenario)) && (!skip || !skip.test(s.header.scenario)) && !(opt.quick && s.slow),
);

// the inventory
const byArea = new Map<string, { scenarios: number; steps: number }>();
for (const s of chosen) {
  const a = byArea.get(s.area) ?? { scenarios: 0, steps: 0 };
  a.scenarios++;
  a.steps += s.steps.length;
  byArea.set(s.area, a);
}
console.log(`${chosen.length} scenarios, ${chosen.reduce((n, s) => n + s.steps.length, 0)} steps`);
for (const [area, a] of byArea) console.log(`  ${area.padEnd(22)} ${String(a.scenarios).padStart(3)} scenarios ${String(a.steps).padStart(6)} steps`);
if (opt.list) {
  for (const s of chosen) console.log(`${s.header.scenario.padEnd(34)} ${String(s.steps.length).padStart(6)}  ${s.header.about ?? ""}`);
  process.exit(0);
}

mkdirSync(join(outDir, "scenarios"), { recursive: true });
for (const s of chosen) writeFileSync(join(outDir, "scenarios", `${s.header.scenario}.jsonl`), s.toJsonl());

const sideB = typeof opt.mutant === "string" ? `mutant-${opt.mutant}` : "b";
const coverageDir = join(outDir, "coverage");
if (opt.coverage) mkdirSync(coverageDir, { recursive: true });
const transcript = (side: string, name: string) => join(outDir, side, `${name}.transcript.jsonl`);

interface Row {
  scenario: string;
  a?: RunResult;
  b?: RunResult;
  comparison?: Comparison;
  error?: string;
}
const rows: Row[] = [];
let next = 0;
const started = performance.now();
async function worker(): Promise<void> {
  for (;;) {
    const s = chosen[next++];
    if (!s) return;
    const name = s.header.scenario;
    const row: Row = { scenario: name };
    rows.push(row);
    const scenarioFile = join(outDir, "scenarios", `${name}.jsonl`);
    try {
      if (!(opt["reuse-ref"] && existsSync(transcript("a", name))))
        row.a = await runScenario({
          command: ref,
          scenarioFile,
          workDir: join(outDir, "work", "a", name),
          transcriptFile: transcript("a", name),
          extraEnv: opt.coverage ? { NODE_V8_COVERAGE: coverageDir } : {},
        });
      row.b = await runScenario({
        command: cand,
        scenarioFile,
        workDir: join(outDir, "work", sideB, name),
        transcriptFile: transcript(sideB, name),
        extraEnv: typeof opt.mutant === "string" ? { SERVERDIFF_MUTANT: opt.mutant } : {},
      });
      row.comparison = compareTranscripts(transcript("a", name), transcript(sideB, name));
    } catch (e) {
      row.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    }
    const c = row.comparison;
    console.log(
      `${row.error ? "ERROR" : c!.differing ? "DIFF " : c!.close ? "close" : "same "} ${name.padEnd(34)} ` +
        (c ? `${String(c.records).padStart(6)} records ${String(c.identical).padStart(6)} identical ${String(c.close).padStart(4)} close ${String(c.differing).padStart(4)} different` : "") +
        `  ${(((row.a?.ms ?? 0) + (row.b?.ms ?? 0)) / 1000).toFixed(1)} s`,
    );
  }
}
await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));

rows.sort((x, y) => (x.scenario < y.scenario ? -1 : 1));
let bad = 0;
const total = { records: 0, identical: 0, close: 0, differing: 0, closeNumbers: 0, maxRelative: 0 };
console.log("");
for (const r of rows) {
  for (const side of ["a", "b"] as const)
    for (const [k, w] of (r[side]?.warnings ?? []).entries()) {
      if (k < 4) console.log(`warning (${side === "a" ? "reference" : "candidate"}, ${r.scenario}): ${w.split("\n")[0]!.slice(0, 260)}`);
      else if (k === 4) console.log(`warning (${side === "a" ? "reference" : "candidate"}, ${r.scenario}): ... and ${r[side]!.warnings.length - 4} more`);
    }
  if (r.error) {
    bad++;
    console.log(`ERROR ${r.scenario}: ${r.error}`);
    continue;
  }
  const c = r.comparison!;
  total.records += c.records;
  total.identical += c.identical;
  total.close += c.close;
  total.differing += c.differing;
  total.closeNumbers += c.closeNumbers;
  total.maxRelative = Math.max(total.maxRelative, c.maxRelative);
  if (c.differing) {
    bad++;
    console.log(describe(c, 12));
  }
}
console.log(
  `\n${rows.length} scenarios in ${((performance.now() - started) / 1000).toFixed(0)} s: ${rows.length - bad} without a difference, ${bad} with differences or errors.\n` +
    `${total.records} records: ${total.identical} identical, ${total.close} equal up to the last digits of ${total.closeNumbers} numbers ` +
    `(largest relative difference ${total.maxRelative.toExponential(1)}), ${total.differing} different.`,
);
writeFileSync(
  join(outDir, `report-${sideB}.json`),
  JSON.stringify({ ref, cand, mutant: opt.mutant ?? null, total, scenarios: rows.map((r) => ({ scenario: r.scenario, error: r.error ?? null, warningsA: r.a?.warnings ?? [], warningsB: r.b?.warnings ?? [], comparison: r.comparison ? { ...r.comparison, differences: r.comparison.differences.slice(0, 50) } : null })) }, null, 1),
);
process.exit(bad ? 1 : 0);
