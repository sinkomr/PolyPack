/**
 * Benchmark of mc_compress (docs/methods/dimensions/mc_compress.md), on the reference kernel and the free-torus test
 * kernel. From the repository root:
 *
 *   nice -n 10 npx tsx packages/methods/scripts/bench-mc_compress.ts --P 2-10 --seeds 10 --evals 30000
 *
 * Options are those of mc-bench.ts.
 */
import { bench } from "./mc-bench";

bench("mc_compress");
