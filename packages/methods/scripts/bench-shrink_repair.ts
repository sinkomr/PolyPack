/**
 * Benchmark of shrink_repair on the reference kernel (unit disks in a circle), against the best
 * known radii. Run from the repository root under nice:
 *
 *   nice -n 10 npx tsx packages/methods/scripts/bench-shrink_repair.ts [Pmin-Pmax] [seeds] [evals] [params JSON]
 *
 * Same output as bench-basin_hopping.ts.
 */
import { bench } from "./bench-basin_hopping";

bench("shrink_repair", process.argv.slice(2));
