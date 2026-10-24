/**
 * Redo the polish and margin re-solve of run files whose certificate configuration is not strictly
 * valid (unconverged degenerate polish), with a larger iteration budget.
 *   npx tsx packages/curved/scripts/recert.ts FILE...
 */
import { readFileSync, writeFileSync } from "node:fs";
import { certifyPrep, polishAt, validate } from "../src/index";

for (const file of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  const problem = { N: d.N, M: d.M, P: d.P };
  const starts = [d.config_cert, d.config_float];
  let best: { size: number; pieces: { x: number; y: number; theta: number }[] } | undefined;
  for (const st of starts) {
    const pc = polishAt(problem, d.K, st, { maxIter: 3000 });
    if (pc.validation.valid && (!best || pc.config.size < best.size)) best = pc.config;
  }
  if (!best) {
    console.log(`${file}: no valid polish`);
    continue;
  }
  for (const mu of [d.margin, d.margin / 4, 1e-12]) {
    const cert = certifyPrep(problem, d.K, best, mu, 3000);
    const v = validate(problem, d.K, cert.config);
    if (v.strictlyValid && v.minGap > 0) {
      d.score_float = Math.min(best.size, cert.config.size);
      d.config_float = best;
      d.config_cert = cert.config;
      d.score_cert = cert.config.size;
      d.margin = mu;
      d.witnesses = cert.witnesses;
      d.validation_cert = { valid: v.valid, strictlyValid: v.strictlyValid, minGap: v.minGap };
      d.recertified = "polish and margin re-solve repeated with 3000 iterations";
      writeFileSync(file, JSON.stringify(d));
      console.log(`${file}: s_float ${best.size} s_cert ${cert.config.size} minGap ${v.minGap}`);
      break;
    }
    console.log(`${file}: margin ${mu} not strict (minGap ${v.minGap})`);
  }
}
