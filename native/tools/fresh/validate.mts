// Re-checks the final packing of every run with the server's own TypeScript validators.
//
//   npx tsx native/tools/fresh/validate.mts RUNS.jsonl OUT.jsonl
//
// Flat: what POST /api/submit does (apps/server/src/app.ts): parseConfig, then evaluate(config,
//   { maxOverlaps, stopWhenInvalid: true }); the score is the container's size. The shrink test
//   (strictVerify, which the server applies to packings that beat the literature) is reported as ts_strict.
// Spaces: what POST /api/spaces/submit does: validateSpaceSubmission(space, id, config, options) with the default
//   options (no bound, not certified, noRecord false; the server passes noRecord for a problem without a record,
//   which the harness does not, as the port's and the JavaScript's searches do not).
// Adds ts_valid, ts_score, ts_score_match (reported score within the server's tie tolerance of ts_score),
// ts_strict (flat only) and ts_reasons.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const { parseConfig, evaluate, strictVerify, SCORE_TIE } = await import(`${root}/packages/geometry/src/index.ts`);
const { validateSpaceSubmission } = await import(`${root}/packages/spaces/src/index.ts`);

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) throw new Error("usage: validate.mts RUNS.jsonl OUT.jsonl");
const lines = readFileSync(inPath, "utf8").split("\n").filter((l) => l.trim());
const out: string[] = [];
let n = 0;
for (const line of lines) {
  const rec = JSON.parse(line);
  const r = rec.result;
  const add: Record<string, unknown> = { ts_valid: false, ts_score: null, ts_score_match: false, ts_strict: null, ts_reasons: [] };
  if (r && r.config) {
    try {
      if (rec.family === "flat") {
        const parsed = parseConfig(r.config);
        if (!parsed.ok) add.ts_reasons = parsed.errors.slice(0, 3);
        else {
          const ev = evaluate(parsed.config, { maxOverlaps: 20, stopWhenInvalid: true });
          const container = ev.valid ? ev.container : null;
          add.ts_valid = !!container;
          add.ts_score = container ? container.size : null;
          add.ts_strict = container ? strictVerify(parsed.config.N, parsed.config.pieces, container).ok : null;
          add.ts_reasons = ev.reasons.slice(0, 3);
        }
      } else {
        const v = validateSpaceSubmission(rec.family, rec.id, r.config, {});
        add.ts_valid = v.valid && v.score !== null && !v.malformed;
        add.ts_score = v.valid ? v.score : null;
        add.ts_reasons = v.reasons.slice(0, 3);
      }
    } catch (e) {
      add.ts_reasons = [`validator threw: ${(e as Error).message}`];
    }
    const s = add.ts_score as number | null;
    if (add.ts_valid && typeof r.score === "number" && s !== null)
      add.ts_score_match = Math.abs(s - r.score) <= SCORE_TIE * Math.max(s, r.score);
  }
  out.push(JSON.stringify({ ...rec, ...add }));
  if (++n % 20 === 0) console.error(`validated ${n}/${lines.length}`);
}
writeFileSync(outPath, out.join("\n") + (out.length ? "\n" : ""));
console.error(`validated ${n} runs -> ${outPath}`);
