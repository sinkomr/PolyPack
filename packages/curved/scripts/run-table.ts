/**
 * Produce table entries for the curved family: seeded search, polish, margin re-solve for the
 * certifier, envelope sensitivity. One JSON file per problem in the output directory.
 *
 *   npx tsx packages/curved/scripts/run-table.ts --K -1 --N 3 --M 4 --P 1-12 --out DIR [--restarts 6 --hops 25 --seed 1 --stopAfterFails 1]
 *
 * For polygon containers the P range stops after `stopAfterFails` consecutive P without a packing
 * (finite catalogue). Each P after the first is warm-started from the previous optimum plus one piece.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { certifyPrep, polishAt, sensitivity, solve, rng, type CurvedConfig } from "../src/index";
import { multiplierRange } from "../src/sensitivity";
import { dSideDApothem } from "../src/shapes";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}

const K = Number(arg("K"));
const N = Number(arg("N"));
const M = Number(arg("M"));
const [p0, p1] = arg("P").split("-").map(Number);
const out = arg("out");
const restarts = Number(arg("restarts", "6"));
const hops = Number(arg("hops", "25"));
const seed = Number(arg("seed", "1"));
const stopAfterFails = Number(arg("stopAfterFails", "1"));
const margin = Number(arg("margin", "4e-11"));
mkdirSync(out, { recursive: true });

let prev: CurvedConfig | undefined;
let fails = 0;
for (let P = p0; P <= (p1 ?? p0); P++) {
  const file = join(out, `${K}_${N}_${M}_${P}.json`);
  if (existsSync(file)) {
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (d.found) {
      prev = d.config_float;
      fails = 0;
    } else fails++;
    if (fails >= stopAfterFails && M !== 0) break;
    continue;
  }
  const problem = { N, M, P };
  const started = Date.now();
  let start: CurvedConfig | undefined;
  if (prev) {
    // previous optimum plus one piece at a random spot near the centre
    const r = rng(seed * 7919 + P);
    const a = 2 * Math.PI * r();
    const rad = 0.3 * r();
    start = {
      size: prev.size * 1.02,
      pieces: [...prev.pieces, { x: rad * Math.cos(a), y: rad * Math.sin(a), theta: 2 * Math.PI * r() }],
    };
  }
  const pieceSeed = seed * 1000003 + P * 101 + N * 13 + M;
  let res = solve(problem, K, { seed: pieceSeed, restarts, hops, start });
  let budget = { restarts, hops, extraRestarts: 0 };
  if (!res.found) {
    // one retry with a doubled budget before declaring "not found"
    res = solve(problem, K, { seed: pieceSeed + 1, restarts: 2 * restarts, hops, start });
    budget = { restarts, hops, extraRestarts: 2 * restarts };
  }
  const record: Record<string, unknown> = { K, N, M, P, seed: pieceSeed, budget, found: res.found, optima: res.optima };
  if (res.found && res.config) {
    const tight = polishAt(problem, K, res.config, { maxIter: 600 });
    const best =
      tight.validation.valid && tight.config.size <= res.config.size
        ? tight
        : { config: res.config, polish: res.polish!, validation: res.validation! };
    const sens = sensitivity(problem, K, best.config, best.polish);
    const range = multiplierRange(problem, K, best.config, best.polish);
    // margin: ~4e-11 in length units, smaller when the size is very sensitive to the apothem
    // (near-ideal hyperbolic containers) so that score_cert - score_float stays ~1e-9 relative
    const dsdt = dSideDApothem(M, K, best.polish.t);
    const mu = Math.min(margin, Math.max(2e-12, margin / Math.max(1, dsdt / 2)));
    const cert = certifyPrep(problem, K, best.config, mu);
    record.score_float = best.config.size;
    record.config_float = best.config;
    record.validation_float = { valid: best.validation.valid, minGap: best.validation.minGap };
    record.kktResidual = best.polish.kktResidual;
    record.rattlers = best.polish.rattlers;
    record.contacts = best.polish.active.filter((a) => Math.abs(a.gap) < 1e-9).length;
    record.dsdK = sens.dsdK;
    record.dsdK_range = range;
    record.active = best.polish.active.filter((a) => a.lambda > 1e-12).map((a) => ({ ...a }));
    record.margin = mu;
    record.config_cert = cert.config;
    record.score_cert = cert.config.size;
    record.validation_cert = {
      valid: cert.validation.valid,
      strictlyValid: cert.validation.strictlyValid,
      minGap: cert.validation.minGap,
    };
    record.witnesses = cert.witnesses;
    prev = best.config;
    fails = 0;
    console.log(
      `K=${K} N=${N} M=${M} P=${P}: s=${best.config.size} cert=${cert.config.size} (+${(cert.config.size - best.config.size).toExponential(2)}) minGapCert=${cert.validation.minGap.toExponential(2)} kkt=${best.polish.kktResidual.toExponential(1)} dsdK=${sens.dsdK.toFixed(4)} ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } else {
    fails++;
    console.log(`K=${K} N=${N} M=${M} P=${P}: not found (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
  record.seconds = (Date.now() - started) / 1000;
  writeFileSync(file, JSON.stringify(record));
  if (fails >= stopAfterFails && M !== 0) break;
}
