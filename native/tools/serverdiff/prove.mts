// The proofs that the harness is sound, with the TypeScript server alone (README.md, "Soundness"):
//   (a) two fresh runs of every scenario give transcripts the comparator calls identical;
//   (b) each deliberate defect of lib/mutants.mts is reported;
//   (c) the coverage of apps/server/src/ while every scenario is replayed.
//
//   node --import tsx native/tools/serverdiff/prove.mts --out DIR [--bulk N] [--jobs J] [--quick] [--entry]
//
// --entry adds (d): the scenarios that use no options file give the same transcripts against
// apps/server/src/node.ts itself as against ref-server.mts, which repeats it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { coverageOf } from "./coverage.mts";

const argv = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const outDir = resolve(value("out", ""));
if (!process.env.SERVERDIFF_SNAP || !process.env.SERVERDIFF_SPACESNAP)
  console.log("note: SERVERDIFF_SNAP or SERVERDIFF_SPACESNAP is not set: the scenarios that replay the site's leading entries are shorter or left out");
if (!argv.includes("--out")) {
  console.error("--out DIR is required (a scratch directory)");
  process.exit(2);
}
const common = ["--import", "tsx", join(import.meta.dirname, "run.mts"), "--out", outDir, "--jobs", value("jobs", "6")];
const quick = argv.includes("--quick") ? ["--quick"] : [];
const run = (title: string, extra: string[]): { status: number; report: any } => {
  console.log(`\n=== ${title}`);
  const r = spawnSync(process.execPath, [...common, ...extra], { cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8", maxBuffer: 1 << 28 });
  const lines = r.stdout.trim().split("\n");
  console.log(lines.slice(-2).join("\n"));
  const side = extra.includes("--mutant") ? `mutant-${extra[extra.indexOf("--mutant") + 1]}` : "b";
  return { status: r.status ?? 1, report: JSON.parse(readFileSync(join(outDir, `report-${side}.json`), "utf8")) };
};

// (a) and (c): the reference twice, the first run under coverage
const self = run("(a) two fresh runs of the reference, the first under V8 coverage", ["--self", "--coverage", "--bulk", value("bulk", "1500"), ...quick]);
let failed = self.status !== 0;

// (b): each mutant against the reference's transcripts, without the bulk scenarios
console.log("\n=== (b) deliberate defects");
const mutants = ["answer", "status", "header", "db", "log", "float", "ulp"];
const rows: string[] = [];
for (const m of mutants) {
  const r = run(`mutant ${m}`, ["--mutant", m, "--reuse-ref", "--quick", "--bulk", "0", "--skip", "^(minute|events|snapshot|spaces-heavy)$"]);
  const hit = r.report.scenarios.filter((s: any) => s.comparison && s.comparison.differing > 0);
  const close = r.report.scenarios.filter((s: any) => s.comparison && s.comparison.differing === 0 && s.comparison.close > 0);
  const first = hit[0]?.comparison.differences[0];
  rows.push(
    `${m.padEnd(7)} reported in ${String(hit.length).padStart(2)} scenarios, counted as last-digit differences in ${close.length}` +
      (first ? `; e.g. ${hit[0].scenario} step ${first.step} [${first.what}] ${first.where}: ${String(first.a).slice(0, 60)} | ${String(first.b).slice(0, 60)}` : ""),
  );
  // `ulp` must NOT be reported as a difference, and must be counted; every other mutant must be reported
  if (m === "ulp" ? hit.length > 0 || close.length === 0 : hit.length === 0) failed = true;
}
console.log("\n" + rows.join("\n"));

// (d), before (c) so that its run of node.ts under coverage counts: the real entry point is the reference here
const coverageDirs = [join(outDir, "coverage")];
if (argv.includes("--entry")) {
  const e = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "run.mts"), "--out", join(outDir, "entry"), "--only", "^entry-", "--bulk", "0", "--coverage", "--ref", "node --import tsx apps/server/src/node.ts", "--cand", "node --import tsx native/tools/serverdiff/ref-server.mts"], { cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8" });
  console.log("\n=== (d) apps/server/src/node.ts itself against ref-server.mts, on the scenarios without an options file");
  console.log(e.stdout.trim().split("\n").slice(-12).join("\n"));
  if (e.status !== 0) failed = true;
  coverageDirs.push(join(outDir, "entry", "coverage"));
}

// (c)
console.log("\n=== (c) coverage of apps/server/src/ over the reference's runs");
for (const f of coverageOf(coverageDirs))
  console.log(
    `${f.file.padEnd(34)} lines ${String(f.linesCovered).padStart(4)}/${String(f.lines).padEnd(4)} ${((100 * f.linesCovered) / f.lines).toFixed(1).padStart(5)}%   blocks ${String(f.blocksCovered).padStart(4)}/${String(f.blocks).padEnd(4)} ${((100 * f.blocksCovered) / Math.max(1, f.blocks)).toFixed(1).padStart(5)}%`,
  );

process.exit(failed ? 1 : 0);
