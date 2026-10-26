/**
 * Quality and cost of `morph` on the reference kernel (unit disks in a circle), or on the tests'
 * soft disks (the same problem, whose soft shapes are smaller disks), against the best known radii
 * DISKS_IN_CIRCLE_BEST, for an evaluation budget and a range of seeds. Every result is checked
 * valid at tolerance 0.
 *
 * Usage: nice -n 10 npx tsx packages/methods/scripts/bench-morph.ts [evals] [seeds] [P list] [params JSON] [disks|soft]
 * Example: nice -n 10 npx tsx packages/methods/scripts/bench-morph.ts 30000 5 2,3,4,5,6,7,8,9,10 '{"stages":3}'
 */
import { runMethod } from "../src";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";
import { softDisksKernel } from "../test/soft-disks";

const [evalsText = "30000", seedsText = "5", Ptext = "2,3,4,5,6,7,8,9,10", paramsText = "{}", kernelName = "disks"] =
  process.argv.slice(2);
const make = kernelName === "soft" ? softDisksKernel : disksKernel;
const evals = Number(evalsText);
const seeds = Number(seedsText);
const params = JSON.parse(paramsText) as Record<string, unknown>;
console.log(`morph, ${evals} evaluations, seeds 1-${seeds}, params ${JSON.stringify(params)}, kernel ${kernelName}`);
console.log("P | best known | best | median | worst | best/known-1 | median/known-1 | worst/known-1 | evals | s/run");
for (const P of Ptext.split(",").map(Number)) {
  const scores: number[] = [];
  let used = 0;
  const t0 = performance.now();
  for (let seed = 1; seed <= seeds; seed++) {
    const r = runMethod(make(P), "morph", { seed, params, budget: { evals } });
    if (r.score === null || !validateDisks(P, r.config, 0).valid)
      throw new Error(`no valid result for P = ${P}, seed ${seed}`);
    scores.push(r.score);
    used += r.evaluations;
  }
  const seconds = (performance.now() - t0) / 1000 / seeds;
  scores.sort((a, b) => a - b);
  const known = DISKS_IN_CIRCLE_BEST[P];
  const median = (scores[Math.floor((seeds - 1) / 2)] + scores[Math.ceil((seeds - 1) / 2)]) / 2;
  const rel = (v: number) => (v / known - 1).toExponential(2);
  console.log(
    [
      P,
      known.toFixed(6),
      scores[0].toFixed(6),
      median.toFixed(6),
      scores.at(-1)!.toFixed(6),
      rel(scores[0]),
      rel(median),
      rel(scores.at(-1)!),
      Math.round(used / seeds),
      seconds.toFixed(2),
    ].join(" | "),
  );
}
