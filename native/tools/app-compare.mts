// A reading aid for the results of native/tools/serverdiff/run.mts while the spaces are not ported
// to Rust. It does not change the harness or its verdict: it compares the same transcripts again
// with the harness's own comparison, after setting aside the one difference that every scenario
// has until then, and sorts what is left by where it comes from.
//
//   node --import tsx native/tools/app-compare.mts OUT_DIR [--show N] [--only REGEX]
//
// Set aside: the lines `[spaces] ...` that the reference writes at startup, one per catalogue
// (loadSpacesIndex), which the Rust server cannot write before it has catalogues. The comparison of
// the log is by position, so without this every later line of a log would count as different.
// Sorted apart: steps that ask a route of spaces.ts (/api/spaces..., /api/admin/spaces...).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareTranscripts } from "./serverdiff/lib/compare.mts";

const args = process.argv.slice(2);
const out = args[0];
if (!out) {
  console.error("usage: app-compare.mts OUT_DIR [--show N] [--only REGEX]");
  process.exit(2);
}
const show = args.includes("--show") ? Number(args[args.indexOf("--show") + 1]) : 6;
const only = args.includes("--only") ? new RegExp(args[args.indexOf("--only") + 1]!) : null;
const CATALOGUE = /^\[spaces\] (\w+: (a domain of \d+ problems|\d+ problems)|no \w+ records|\w+ records not loaded|\w+ record left out)/;

const aside = join(out, "a-without-catalogue-lines");
mkdirSync(aside, { recursive: true });
let total = { records: 0, identical: 0, close: 0, mine: 0, spaces: 0 };
for (const file of readdirSync(join(out, "a")).sort()) {
  const name = file.replace(".transcript.jsonl", "");
  if (only && !only.test(name)) continue;
  if (!existsSync(join(out, "b", file))) continue;
  const lines = readFileSync(join(out, "a", file), "utf8").split("\n").filter(Boolean);
  const rewritten = lines.map((line, i) => {
    if (i === 0) return line;
    const r = JSON.parse(line) as { stdout?: string[] };
    if (!r.stdout) return line;
    r.stdout = r.stdout.filter((l) => !CATALOGUE.test(l));
    return JSON.stringify(r);
  });
  writeFileSync(join(aside, file), rewritten.join("\n") + "\n");
  const c = compareTranscripts(join(aside, file), join(out, "b", file));
  const steps = new Map<number, { what: string; n: number; first: (typeof c.differences)[number] }>();
  for (const d of c.differences) {
    const s = steps.get(d.step);
    if (s) s.n++;
    else steps.set(d.step, { what: d.what, n: 1, first: d });
  }
  const isSpaces = (what: string) => /\/api\/(admin\/)?spaces/.test(what);
  const mine = [...steps].filter(([, s]) => !isSpaces(s.what));
  const spaces = steps.size - mine.length;
  total.records += c.records;
  total.identical += c.identical;
  total.close += c.close;
  total.mine += mine.length;
  total.spaces += spaces;
  console.log(`${mine.length ? "DIFF " : spaces ? "spaces" : "same "} ${name.padEnd(28)} ${String(c.records).padStart(6)} records, ${String(c.identical).padStart(6)} identical, ${c.close} close, ${spaces} at routes of the spaces, ${mine.length} elsewhere`);
  for (const [step, s] of mine.slice(0, show)) {
    console.log(`    step ${step} [${s.what}] ${s.first.where} (${s.first.kind}), ${s.n} difference(s)`);
    console.log(`        a: ${s.first.a.slice(0, 300)}`);
    console.log(`        b: ${s.first.b.slice(0, 300)}`);
  }
  if (mine.length > show) console.log(`    ... and ${mine.length - show} more steps`);
}
console.log(`\n${total.records} records: ${total.identical} identical, ${total.close} equal up to the last digits; steps that differ: ${total.spaces} at routes of the spaces, ${total.mine} elsewhere`);
