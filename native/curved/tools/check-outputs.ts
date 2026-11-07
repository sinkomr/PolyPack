/**
 * Checks configurations written by the native job (examples/bench.rs --save DIR) with the
 * TypeScript rule the server applies (checkSpaceConfig: validateSpaceSubmission at 1e-9, and at
 * 1e-11 for a problem without a research record).
 *
 *   npx tsx native/curved/tools/check-outputs.ts DIR
 *
 * File names are <id with / replaced by _>-<seed>.json. Prints one line per file and a summary;
 * exits 1 when any configuration fails.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@polypack/curved";
import { checkSpaceConfig, parseSearchProblem } from "@polypack/spaces/search";

const dir = process.argv[2];
if (!dir) throw new Error("usage: check-outputs.ts DIR");
let pass = 0;
let fail = 0;
for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const m = /^(curved_.+)-(\d+)\.json$/.exec(name);
  if (!m) continue;
  const id = m[1].replaceAll("_", "/");
  const p = parseSearchProblem(id);
  if (!p || p.space !== "curved") throw new Error(`bad id ${id}`);
  const config = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const loose = checkSpaceConfig("curved", id, config, { bound: null, certified: null });
  const strict = checkSpaceConfig("curved", id, config, { bound: null, certified: null, noRecord: true });
  const v = validate({ N: p.N, M: p.M, P: p.P }, p.K, config);
  const ok = loose.valid && strict.valid;
  if (ok) pass++;
  else fail++;
  console.log(
    JSON.stringify({ id, seed: Number(m[2]), size: config.size, valid: loose.valid, strict: strict.valid, minGap: v.minGap, reasons: ok ? undefined : [...loose.reasons, ...strict.reasons].slice(0, 3) }),
  );
}
console.log(JSON.stringify({ pass, fail }));
if (fail) process.exit(1);
