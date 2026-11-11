// Runs one scenario file of the differential harness (native/tools/serverdiff) against the
// reference and a candidate, with the harness's own runner and comparison, optionally after a
// rewrite of its steps. A tool for the time before the spaces are ported to Rust: a scenario such as
// `limits` posts to /api/spaces/submit to show that both submit routes share one count, so against
// a server without that route every later answer is off by one and says nothing about the limits.
//
//   node --import tsx native/tools/app-scenario.mts --out DIR --cand COMMAND --from FILE.jsonl
//        [--flat-submits]   every POST /api/spaces/submit is sent to /api/submit instead (same
//                           headers, same body): the count and the budget then see the same requests
//        [--name NAME]      the name of the derived scenario (default: the file's, with a suffix)
//
// The harness itself is not changed, and its verdict on the scenario as written stands; this shows
// what the two servers do with the derived one.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { compareTranscripts, describe } from "./serverdiff/lib/compare.mts";
import { runScenario } from "./serverdiff/lib/runner.mts";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const out = opt("out");
const cand = opt("cand");
const from = opt("from");
if (!out || !cand || !from) {
  console.error("usage: app-scenario.mts --out DIR --cand COMMAND --from FILE.jsonl [--flat-submits] [--name NAME]");
  process.exit(2);
}
const ref = opt("ref") ?? "node --import tsx native/tools/serverdiff/ref-server.mts";
const flat = argv.includes("--flat-submits");
const lines = readFileSync(from, "utf8").split("\n").filter(Boolean);
const header = JSON.parse(lines[0]!) as { scenario: string };
const name = opt("name") ?? `${basename(from, ".jsonl")}${flat ? "-flat-submits" : ""}`;
header.scenario = name;
let rewritten = 0;
const rewrite = (r: { path?: string }) => {
  if (flat && r.path === "/api/spaces/submit") {
    r.path = "/api/submit";
    rewritten++;
  }
};
const steps = lines.slice(1).map((l) => {
  const s = JSON.parse(l) as { op: string; path?: string; requests?: { path?: string }[] };
  if (s.op === "req") rewrite(s);
  if (s.op === "burst") for (const r of s.requests ?? []) rewrite(r);
  return JSON.stringify(s);
});
const dir = resolve(out);
mkdirSync(join(dir, "scenarios"), { recursive: true });
const file = join(dir, "scenarios", `${name}.jsonl`);
writeFileSync(file, [JSON.stringify(header), ...steps].join("\n") + "\n");

const transcript = (side: string) => join(dir, side, `${name}.transcript.jsonl`);
const a = await runScenario({ command: ref, scenarioFile: file, workDir: join(dir, "work", "a", name), transcriptFile: transcript("a") });
const b = await runScenario({ command: cand, scenarioFile: file, workDir: join(dir, "work", "b", name), transcriptFile: transcript("b") });
for (const w of a.warnings.slice(0, 3)) console.log(`warning (reference): ${w.split("\n")[0]!.slice(0, 200)}`);
for (const w of b.warnings.slice(0, 3)) console.log(`warning (candidate): ${w.split("\n")[0]!.slice(0, 200)}`);

// as native/tools/app-compare.mts: the catalogue lines of the reference's startup are set aside
const CATALOGUE = /^\[spaces\] (\w+: (a domain of \d+ problems|\d+ problems)|no \w+ records|\w+ records not loaded|\w+ record left out)/;
const aside = join(dir, "a-without-catalogue-lines");
mkdirSync(aside, { recursive: true });
const cleaned = readFileSync(transcript("a"), "utf8").split("\n").filter(Boolean).map((line, i) => {
  if (i === 0) return line;
  const r = JSON.parse(line) as { stdout?: string[] };
  if (!r.stdout) return line;
  r.stdout = r.stdout.filter((l) => !CATALOGUE.test(l));
  return JSON.stringify(r);
});
writeFileSync(join(aside, `${name}.transcript.jsonl`), cleaned.join("\n") + "\n");
const c = compareTranscripts(join(aside, `${name}.transcript.jsonl`), transcript("b"));
console.log(`${name}: ${steps.length} steps (${rewritten} rewritten), ${c.records} records, ${c.identical} identical, ${c.close} equal up to the last digits, ${c.differing} different`);
if (c.differing) console.log(describe(c, Number(opt("show") ?? 12)));
process.exit(c.differing ? 1 : 0);
