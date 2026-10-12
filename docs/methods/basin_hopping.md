# Basin hopping / iterated local search

[CALC] Registered as `basin_hopping`. Perturb a locally repaired packing, solve locally again, and accept the sub-run's own result by a Metropolis rule. The framework independently retains the strict best. Polygon pieces have side 1, circles radius 1; scores are container side lengths or circle radii. All separation, enclosure, containment, restoration and penalty calculations reuse shared geometry and the existing penalty implementation.

## Search and operators

[CALC] Always spend the automatic seed slice, including with a supplied start. Use the supplied start as the initial current state when complete; otherwise use the seed sub-run's `found`. Add its returned seed, the supplied start and incoming `ctx.starts` to the restart set. An unusable seed result falls back to an assessed scatter. Repair an invalid start, then perform the first local solve. Child failures do not end the parent.

[CALC] Each hop calls `ctx.run("penalty", penalty, {start: perturbed, evals: slice})` and uses `found/foundScore`, never the child's shared best, for acceptance. Finite slices can stop before numerical convergence; a "local optimum" in the pool is the best valid candidate that the child actually assessed. Rejected optima can still improve the framework's global best and enter the pool.

1. **Kick:** choose `max(1, ceil(kickFraction*P))` pieces without replacement. Displace each coordinate uniformly in ±the adaptive magnitude and rotate polygons uniformly in ±`rotationMagnitude`. Clamp coordinates to ±MAX_COORD; circle angles are zero.
2. **Swap:** exchange orientations, leaving centres fixed. Choose uniformly from pairs with different orientations modulo `2π/N`, testing `abs(sin(N*(theta_i-theta_j)/2)) > 1e-9`. Congruent whole poses are interchangeable. Circles get zero swap weight; singletons and entirely equivalent orientations return unchanged.
3. **Cluster:** choose a pivot. Include centres within `clusterRadius * 2 * boundingRadius(N)`: the parameter is a multiple of the piece's bounding diameter. Require at least two members. Rotate positions and orientations rigidly about their centroid; preserve internal distances. Reject the whole move at a coordinate boundary rather than clipping members independently.
4. **Reinsert:** choose the piece whose removal gives the smallest enclosing size, with first-minimum tie breaking. Submit P counted removal assessments, retaining the original P so incomplete packings cannot enter the valid best. Sample within the current enclosure's bounding box, and reject poses protruding outside the enclosure. Include its centre and the removed centre as exact anchors, so a centred piece-sized hole can be found. For each centre try a random orientation, the four nearest neighbours' orientations and their half-symmetry turns, and up to eight container edge directions. Deduplicate angles modulo piece symmetry. Require nonnegative pair clearance. Rank by resulting fixed-phi enclosing size first (1e-12 tie band), then minimum clearance. Retain the original pose if no free candidate exists. This is sampled free-space search, not a proof of the largest hole. Disable it when there is insufficient budget for all removal assessments and a local solve.
5. **Restart:** choose a matching seed uniformly and strongly kick all its pieces. The small base weight makes this uncommon. If no matching seed exists, strongly kick the current state.

[CALC] Compare every perturbation with the current packing, including symmetry-equivalent polygon angles. Redraw an unchanged perturbation without spending a local solve or crediting a trial. After eight consecutive redraws, fall back to a kick, including for operator-only parameter sets with no legal move. `redraws` reports these selections separately; operator `tries` counts actual hop solves. Pure helpers copy exactly P finite poses. The method's reinsertion sampler uses the same seeded stream as its synchronous helper and yields every four centre trials and every 256 pair checks.

## Acceptance and adaptation

[CALC] The exported `metropolis(current, candidate, T, random)` accepts every strict improvement without drawing; at T>0 it otherwise accepts with probability `exp(-(candidate-current)/T)`, including ties. At T=0 it rejects ties and uphill moves. Nonfinite scores are rejected.

[CALC] The search treats raw differences of at most 1e-9 as numerical ties. `hops.rawScore` preserves the actual child score; `hops.score` is the effective decision score. The independent framework tracker always sees actual scored candidates. Credit improvement only for a reduction greater than 1e-9 relative to the current decision score. Numerical ties do not alter kick magnitude.

[CALC] Each operator starts with recent success rate q=0. After an actual hop, with adaptation coefficient α:
`q ← (1−α)q + α I(improvement > 1e-9)`.
Select with effective weight `baseWeight * (weightFloor + q)`. Every enabled operator retains an exploration weight; zero disables it; all-zero available weights fall back to kicks. Improvement is relative to the current state, rather than necessarily the whole-run best.

[CALC] After a kick with a meaningful score difference (or failed local solve), update
`a ← clamp(a * exp(α * (I(accepted) − targetAcceptance)), 0.001, 10)`.
For these trials the expected logarithmic change vanishes at the target acceptance rate. High acceptance increases displacement and low acceptance decreases it. Rotation and temperature remain fixed. `adaptationRate=0` disables both adaptations. The adaptive search does not claim stationary Boltzmann sampling.

## Final refinement, budgets and strictness

[CALC] For an evaluation-limited run, reserve `min(refinementEvals, floor(initialMethodAllowance/6))` evaluations for terminal refinement, plus space for pool emissions. Ordinary slices use `min(localEvals, remaining-reserve)`. The framework's separate final-polish reserve is untouched. Zero refinement allowance disables the terminal phase.

[CALC] Refine the strict shared best, rather than the last accepted state. First, when every polygon is within `alignmentTolerance` of a container face or vertex direction, try a restricted penalty solve: transform into the container frame, snap those angles, freeze piece and container orientations, and optimize translations and size. This uses the existing penalty objective, L-BFGS and restoration; it contains no record lookup or packing template. It gets at most half the terminal allowance. Parameters are 20 outer iterations, 200 inner iterations, memory 12, tolerance 1e-11, augmented multipliers and initial weight 100 growing by 4 up to 1e10. Only strictly restored, counted assessments can replace the existing best. Skip circles, circular containers, and arrangements outside the angle guard.

[CALC] Then rerun the existing unrestricted penalty driver from the best with at least 20 outer and 300 inner iterations, gradient tolerance at most 1e-10, and zero jitter, using the remaining terminal allowance. A scoped MethodContext counts every assessment through the parent's `ctx.evaluate`, caps both phases, and cooperatively checks stop. This terminal work is separate from the hop record; it is not an additional polish call. For time-only runs, reserve one sixth of the initial method time and run a final tighter penalty child through `ctx.run`; the restricted phase is omitted. A finite budget or a stalled optimizer can still prevent full convergence; the measurements below explicitly report that case.

[CALC] Seed work, starts, removals, local assessments, refinement and emissions all count against the framework budget. Analytic objective, clearance and enclosure queries used to rank perturbations are not independent scored submissions, consistently with penalty's convention. Count child `evaluations` and parent assessments to detect zero-cost failures; never compare Infinity with Infinity. On early convergence, assess the retained strict best to finish the finite method allowance. Appended polish may converge before spending its own reserve.

[EST] The framework now prefers strict configurations: penetration above 1e-12 cannot block or replace a strict best, irrespective of score. `Result.strict=false` flags a result for which no strict candidate was found. See the solver README's "Strict results" section. The former tolerance-band-input blocker has been removed. The two-circle regression now checks that a larger strict result replaces the smaller tolerance-band start.

[CALC] Guard tolerance-band child starts before mandatory assessment; recenter starts whose centroid lies outside the central 64-by-64 box, using a bounding-box centre when needed for coordinate limits. Every benchmark result below is checked independently against shared separation, with minimum separation reported. No result is credited through the 1e-9 validity allowance.

[EST] Synchronous geometry calls are atomic in this runtime; an unconditional one-second abort bound for arbitrary maximum-size geometry is not established. The asynchronous abort acceptance tests cover circles up to P=120, polygons up to P=30, and maximum-size cooperative reinsertion. A no-start run with no available method assessment can return no best; a tolerance-band start without any repair allowance can remain flagged non-strict. These are framework budget/atomicity behaviours, not the removed strict-best blocker.

## Pool and diagnostics

[CALC] Retain at most `poolLimit` distinct strict local optima and emit plain configurations, best first. Strip `agent_note` from every emission. The shared congruence signature quantizes scores and sorted centre distances to 1e-7: it merges practical duplicates under motion/permutation but is not a proof of equivalence. Replace an existing class member when a better representative is found.

[CALC] `executeBasinHopping(ctx)` returns structured diagnostics: `version`, per-operator `tries/accepted/improvements/successRate`, final `kickMagnitude`, `localFailures`, `centeredStarts`, `redraws`, `refinementEvaluations`, and the most recent 2048 hop decisions (`operator, score, rawScore, currentScore, accepted, improved`). Hop records are available to explicit instrumentation; they are never attached to emitted packings. Stored benchmark diagnostics are compact per-operator summaries.

[EST] Ordinary `Result.trace` contains only time/score pairs; `SubRunResult` does not return the child's complete seed emission pool. The method therefore uses the returned seed optimum and incoming starts; full alternative child seeds require a framework pool field. Use the exported executor or the measurement wrapper for operator diagnostics. A normal result needs a framework diagnostic channel to expose those summaries directly. Abort/time expiry can prevent final emissions.

## Parameters and defaults

[EST] Every schema node has a title and description for form tooltips. Defaults merge recursively; unknown properties are rejected. The exact schema is at the end of this page.

| Parameter          | Default                                            | Range/meaning                                                               |
| ------------------ | -------------------------------------------------- | --------------------------------------------------------------------------- |
| localEvals         | 150                                                | Integer 2–1,000,000; maximum per hop solve                                  |
| refinementEvals    | 3000                                               | Integer 0–1,000,000; terminal cap, limited to one sixth of method allowance |
| alignmentTolerance | 0.01                                               | 0–0.1 radians; zero disables restricted refinement                          |
| seedEvals          | 24                                                 | Integer 1–10,000; also spent with a start                                   |
| temperature        | 0.04                                               | 0–1000, score units                                                         |
| kickMagnitude      | 0.35                                               | 0.001–10, displacement in piece units                                       |
| kickFraction       | 0.4                                                | 0–1; at least one selected piece                                            |
| rotationMagnitude  | π/2                                                | 0–π radians                                                                 |
| clusterRadius      | 1.8                                                | 0–10,000, multiples of bounding diameter                                    |
| reinsertionTrials  | 48                                                 | Integer 1–4096, centre samples                                              |
| restartStrength    | 3                                                  | 1–100, displacement multiplier                                              |
| targetAcceptance   | 0.5                                                | 0–1                                                                         |
| adaptationRate     | 0.15                                               | 0–1; zero disables adaptations                                              |
| weightFloor        | 0.2                                                | 0.001–1                                                                     |
| weights            | kick 4, swap 1, cluster 2, reinsert 2, restart 0.3 | Each 0–1000; circles disable swap                                           |
| poolLimit          | 8                                                  | Integer 0–64                                                                |
| penalty            | Nested defaults below                              | Existing penalty schema                                                     |

[EST] Nested penalty defaults: `start:"seed", schedule:"augmented", initialWeight:10, growthFactor:4, outerIterations:6, innerIterations:120, memory:12, gradientTolerance:1e-7, restoration:"separate", jitter:1e-5, violationReduction:0.5`. The terminal solve tightens the limits and tolerance as described above. See [penalty](penalty.md) for inherited ranges.

## Default selection and reliability

[CALC] Development used twenty seeds 21–40, not the original five seeds. Before the restricted terminal phase was added, at 3,000 evaluations the local-slice trials 150/250/400/600 reached the five-square target 8/3/4/4 times respectively. That experiment reserved `min(2*localEvals, floor(methodAllowance/5))`, so it also changed the terminal cap; it does not isolate the slice effect. Kick fractions 0.2/0.4/0.6 with slice 150 reached 7/8/8 of twenty. Keep fraction 0.4; change localEvals from 600 to 150. The complete final defaults, including the new refinement cap and alignment guard, were then remeasured on all twenty development seeds: 8/20 successes at 3,000 evaluations. Cluster radius retains numeric default 1.8 but changes units as required.

[CALC] An independent review set a target of 6/15 for five squares at 3,000 evaluations on seeds 6–20; the measured rate is 4/15, so the target is missed and the review test guards the measured rate (at least 3/15). Across seeds 1–20 that is 5/20, not the earlier tuned claim of 3/5. The independent replacement regression uses seeds 41–55 at 10,000 evaluations, with measured success 12/15; at 3,000 those seeds succeed 3/15. No default was selected on this independent regression set.

[SPEC] Hopping is useful when local minima are separated by a modest rearrangement. Structured circle seeds can already be optimal, so extra hopping may add cost without improving them. Entire-packing cluster rotations remain congruent moves even though their inputs differ. Sampled reinsertion can miss off-centre, exact-sized holes. Hot temperatures or large kicks can spend most of the budget repairing poor basins. There is no global-optimum or universal convergence guarantee.

## Verified references

[EST] Verified on 2026-10-09 from publisher metadata and primary author/institution sources; no unverified reference is cited. These motivate the framework, not a claim to reproduce the authors' specialized implementation.

- David J. Wales and Jonathan P. K. Doye, “Global Optimization by Basin-Hopping and the Lowest Energy Structures of Lennard-Jones Clusters Containing up to 110 Atoms,” _The Journal of Physical Chemistry A_ **101**(28), 5111–5116, **1997**. [Author preprint metadata](https://arxiv.org/abs/cond-mat/9803344) verified authors, title, journal reference, pages and the 1997 publication year (the preprint was deposited in 1998). The [ACS publication link](https://pubs.acs.org/doi/full/10.1021/jp970984n) was inaccessible on the final recheck; the source remains independently verified.
- Helena R. Lourenço, Olivier C. Martin and Thomas Stützle, “Iterated Local Search,” in Fred Glover and Gary A. Kochenberger (eds.), _Handbook of Metaheuristics_, International Series in Operations Research & Management Science **57**, 320–353, **2003**. [Springer publisher chapter](https://link.springer.com/chapter/10.1007/0-306-48056-5_11) verified authors, title, venue, pages and year.
- Bernardetta Addis, Marco Locatelli and Fabio Schoen, “Disk Packing in a Square: A New Global Optimization Approach,” _INFORMS Journal on Computing_ **20**(4), 516–524, **2008**. [INFORMS publisher metadata](https://pubsonline.informs.org/doi/10.1287/ijoc.1080.0263) verified title, author initials, journal, issue, pages and year; [Addis's author bibliography](https://members.loria.fr/BAddis/publications/) independently verified the attribution.

## Measurements

[CALC] Recomputed with the complete final defaults, no start, and the framework final polish enabled, on Node v26.5.0. The eight-problem tables use seeds 1–5; the square success table uses seeds 1–20. Runs are sequential within each batch, but test and other measurement processes ran concurrently, so these are observed wall times, not isolated performance claims. `Result.wallTime` covers the solver, refinement and polish; independent post-validation is excluded. Full-precision individual scores, evaluation counts, wall times, pair separations and per-operator summaries are in [measurements.json](../../packages/solver/src/methods/basin_hopping/measurements.json). The pure [measurement wrapper](../../packages/solver/src/methods/basin_hopping/measure.ts) rejects any invalid/non-strict result, separation below −1e-12, budget overrun, or geometry score discrepancy above 1e-12.

[EST] Published values and displayed precision are read from [data/records.json](../../data/records.json), rather than encoded into the optimizer. For squares P=5 and P=10 the corresponding exact expressions are `2 + 1/sqrt(2)` and `3 + 1/sqrt(2)`. The other cited record pages are [squares in squares](https://kingbird.myphotos.cc/packing/squares_in_squares.html), [circles in circles](https://erich-friedman.github.io/packing/cirincir/), [circles in squares](https://erich-friedman.github.io/packing/cirinsqu/), [pentagons in pentagons](https://erich-friedman.github.io/packing/peninpen/) and [hexagons in hexagons](https://erich-friedman.github.io/packing/hexinhex/).

[CALC] “Printed matches” means absolute difference at most one unit of `display_precision`; a displayed `+` instead means the truncated interval `[value, value + 10^-precision)`. Thus the 14-decimal square entries can count zero despite converging within 1e-9: the record truncation and strict-restoration margin exceed 1e-14. Scores below are rounded to 12 decimal places; the raw artifact retains all digits. Evaluations and seconds are per-seed ranges, with the five-run time sum also shown. Minimum separation is the worst pair across those five results.

### 3,000 evaluations; five seeds

| Problem, P            | Published        | Best           | Median         | Worst          | Printed matches | Evaluations used | Seconds/run | Seconds total | Min separation |
| --------------------- | ---------------- | -------------- | -------------- | -------------- | --------------- | ---------------- | ----------- | ------------- | -------------- |
| Squares/square, 5     | 2.70710678118654 | 2.707106781187 | 2.767800563472 | 2.768527692295 | 0/5             | 2,790–3,000      | 0.340–0.394 | 1.798         | 4.108e-14      |
| Squares/square, 10    | 3.70710678118654 | 3.707496741315 | 3.756494879924 | 4.000000000000 | 0/5             | 2,789–3,000      | 1.488–2.118 | 9.234         | 1.299e-14      |
| Squares/square, 11    | 3.87708359002281 | 3.924706120707 | 4.000000000000 | 4.000000000000 | 0/5             | 2,789–3,000      | 1.786–2.049 | 9.371         | -5.995e-15     |
| Circles/circle, 7     | 3                | 3.000000000000 | 3.000000000000 | 3.000000000000 | 5/5             | 2,789–2,789      | 0.407–0.438 | 2.106         | 1.985e-13      |
| Circles/circle, 19    | 4.863703305156   | 4.863703305157 | 4.863703305157 | 4.863703305157 | 5/5             | 2,794–2,794      | 3.341–3.624 | 17.549        | 1.816e-13      |
| Circles/square, 10    | 6.7474415232     | 6.747441523239 | 6.747441523240 | 6.747441523261 | 5/5             | 3,000–3,000      | 2.020–2.151 | 10.451        | 7.994e-15      |
| Pentagons/pentagon, 6 | 2.61803+         | 2.618033988750 | 2.618033988750 | 2.618033988750 | 5/5             | 2,789–2,790      | 0.558–0.573 | 2.820         | -8.771e-15     |
| Hexagons/hexagon, 7   | 2.886+           | 2.886751345948 | 2.886751345948 | 2.886751345948 | 5/5             | 2,789–2,789      | 0.741–0.759 | 3.745         | 5.995e-15      |

### 30,000 evaluations; five seeds

| Problem, P            | Published        | Best           | Median         | Worst          | Printed matches | Evaluations used | Seconds/run   | Seconds total | Min separation |
| --------------------- | ---------------- | -------------- | -------------- | -------------- | --------------- | ---------------- | ------------- | ------------- | -------------- |
| Squares/square, 5     | 2.70710678118654 | 2.707106781187 | 2.707106781187 | 2.707106781187 | 0/5             | 27,089–27,090    | 3.059–3.281   | 15.590        | 4.441e-16      |
| Squares/square, 10    | 3.70710678118654 | 3.707106781187 | 3.707106781187 | 3.707106781190 | 0/5             | 27,090–27,303    | 11.877–12.211 | 60.052        | 1.650e-13      |
| Squares/square, 11    | 3.87708359002281 | 3.887342564004 | 3.931134212068 | 4.000000000000 | 0/5             | 27,089–30,000    | 19.927–24.300 | 106.115       | -1.754e-14     |
| Circles/circle, 7     | 3                | 3.000000000000 | 3.000000000000 | 3.000000000000 | 5/5             | 27,089–27,089    | 4.248–4.329   | 21.459        | 1.985e-13      |
| Circles/circle, 19    | 4.863703305156   | 4.863703305157 | 4.863703305157 | 4.863703305157 | 5/5             | 27,094–27,094    | 39.560–40.781 | 200.054       | 1.816e-13      |
| Circles/square, 10    | 6.7474415232     | 6.747441523239 | 6.747441523239 | 6.747441523239 | 5/5             | 27,090–27,121    | 17.697–19.822 | 91.954        | 1.816e-13      |
| Pentagons/pentagon, 6 | 2.61803+         | 2.618033988750 | 2.618033988750 | 2.618033988750 | 5/5             | 27,089–27,090    | 5.489–5.616   | 27.724        | 1.221e-15      |
| Hexagons/hexagon, 7   | 2.886+           | 2.886751345948 | 2.886751345948 | 2.886751345948 | 5/5             | 27,089–27,089    | 6.993–10.057  | 38.707        | 5.995e-15      |

[CALC] Every one of the 230 main benchmark results is valid and strict, with exactly P pieces and no evaluation overrun. The minimum separation across all of them is **−1.7541523789077473e−14** (11 squares, seed 1, 30,000 evaluations), well above the required −1e−12. The maximum independent score recomputation difference is 4.440892098500626e−16. Unused evaluations are early convergence in the framework’s separate polish allowance; the method consumes its own finite allowance exactly.

### Twenty-seed square success rates

[CALC] Each cell is a count out of twenty, using absolute error from the published value. Final defaults are fixed before this batch; default development and independent validation are described above.

| Budget | P=5, ≤1e−4 | P=5, ≤1e−9 | P=10, ≤1e−4 | P=10, ≤1e−9 | P=11, ≤1e−4 | P=11, ≤1e−9 |
| ------ | ---------- | ---------- | ----------- | ----------- | ----------- | ----------- |
| 3,000  | 5/20       | 5/20       | 2/20        | 2/20        | 0/20        | 0/20        |
| 10,000 | 14/20      | 14/20      | 13/20       | 8/20        | 0/20        | 0/20        |
| 30,000 | 20/20      | 20/20      | 20/20       | 17/20       | 0/20        | 0/20        |

[EST] Baselines from an independent review of the previous version: five squares, 3,000 evaluations, **4/20** at `s≤2.7072` (random-restart penalty: **2/20**); five squares, 30,000 evaluations, **19/20** at that bound; ten squares, 30,000 evaluations, **18/20** at `s≤3.7072`, and **11/20** within 1e−9. No 1e−9 five-square baseline, 10,000-evaluation baseline, or eleven-square baseline was supplied. The supplied upper bounds differ slightly from absolute error ≤1e−4; applying those same bounds to the new results gives 5/20, 20/20 and 20/20 respectively.

[CALC] At 10,000 evaluations, seeds 1–5 reach the five-square threshold 4/5 times and the ten-square threshold 4/5 times. At 3,000 evaluations the new five-square result is only 1/5 for those five seeds, and the independent review's seeds 6–20 achieve 4/15 rather than the required 6/15. This target is missed. Eleven squares do not reach either precision threshold at any measured budget.

[CALC] Tight terminal refinement improves convergence but does not guarantee it: ten-square seeds 13, 14 and 15 at 30,000 evaluations remain respectively 3.3741662654e−5, 4.5571192555e−5 and 8.4487990885e−5 above `3+1/sqrt(2)`. The other seventeen reach 1e−9. Increasing the final allowance or improving the local driver may be necessary, but no unmeasured change is claimed.

### No-op solves before and after

[CALC] The same strict-result framework was used for these local before/after measurements. A no-op compares actual solve starts to the accepted current packing, including rotational symmetry; redraws never call the local method. Globally congruent rigid motions can still be distinct inputs and are not counted as exact no-ops.

| Problem/seed              | Budget | Before no-ops / hops | Before share | Wasted evaluations before | After no-ops / hops | Redraws after |
| ------------------------- | ------ | -------------------- | ------------ | ------------------------- | ------------------- | ------------- |
| Circles/circle, 7; seed 4 | 3,000  | 8/42                 | 19.05%       | 256                       | 0/40 (0%)           | 7             |
| Circles/circle, 7; seed 4 | 30,000 | 97/331               | 29.31%       | 3117                      | 0/411 (0%)          | 138           |
| Squares/square, 5; seed 2 | 3,000  | 2/7                  | 28.57%       | 721                       | 0/14 (0%)           | 5             |

[EST] The independent review’s earlier circle baseline was 103/330 no-op hops (31.21%). It was taken on an earlier framework revision and differs from the same-framework baseline above. [CALC] Across the full new 230-run batch: **0/18,980** no-op hops.

### Five-square operator summaries

[CALC] Aggregate statistics across seeds 1–5. “Improvements” means more than 1e−9 relative to the accepted current state, not necessarily a new global best. q is the mean final exponential success rate. Individual per-seed summaries are in measurements.json, including every trial, acceptance and improvement count.

| Budget | Operator | Tries | Accepted | Improvements | Mean final q |
| ------ | -------- | ----- | -------- | ------------ | ------------ |
| 3,000  | kick     | 36    | 24       | 13           | 0.207573     |
| 3,000  | swap     | 5     | 4        | 2            | 0.060000     |
| 3,000  | cluster  | 21    | 21       | 11           | 0.246281     |
| 3,000  | reinsert | 6     | 6        | 6            | 0.171000     |
| 3,000  | restart  | 2     | 0        | 0            | 0.000000     |
| 30,000 | kick     | 318   | 167      | 67           | 0.126482     |
| 30,000 | swap     | 82    | 49       | 27           | 0.253394     |
| 30,000 | cluster  | 299   | 299      | 193          | 0.600824     |
| 30,000 | reinsert | 73    | 73       | 73           | 0.897987     |
| 30,000 | restart  | 14    | 0        | 0            | 0.000000     |

### Equal-budget pentagon comparison

[CALC] Six pentagons in a pentagon; default methods, no start, final polish, 30,000-evaluation cap, identical seeds. All five basin-hopping results beat the single penalty run, addressing the previously reported 1e−8 regression. Both results are strict. The penalty method converges before consuming its cap.

| Seed | Single penalty    | Basin hopping     | Basin − penalty | Penalty evaluations | Basin evaluations |
| ---- | ----------------- | ----------------- | --------------- | ------------------- | ----------------- |
| 1    | 2.618033988834268 | 2.618033988749989 | -8.428e-11      | 5369                | 27089             |
| 2    | 2.618033991649952 | 2.618033988750158 | -2.900e-09      | 5164                | 27090             |
| 3    | 2.618034117684195 | 2.618033988749947 | -1.289e-07      | 5237                | 27089             |
| 4    | 2.618034063194044 | 2.618033988750157 | -7.444e-08      | 4911                | 27089             |
| 5    | 2.618034078437598 | 2.618033988750110 | -8.969e-08      | 4934                | 27089             |

### Throughput quality-bar measurement

[CALC] P=30, N=M, seed 1, 300 evaluations, no start, defaults and final polish, after one 100-evaluation circle warmup. These server measurements ran under concurrent benchmark load. All seven use 300 evaluations and return strict results. Full data are in [throughput.json](../../packages/solver/src/methods/basin_hopping/throughput.json).

| N=M | Server seconds | Evaluations/second |
| --- | -------------- | ------------------ |
| 0   | 0.720          | 416.39             |
| 3   | 2.216          | 135.39             |
| 4   | 1.456          | 206.08             |
| 5   | 4.208          | 71.29              |
| 6   | 1.688          | 177.75             |
| 7   | 4.766          | 62.94              |
| 8   | 6.578          | 45.61              |

[EST] Browser throughput remains unmeasured.

### Reproduction and verification

[CALC] From the repository root, the following read-only command reproduces the main scores and compact operator summaries (wall times will differ). It uses the installed tsx dependency. Use the same helper with seeds 21–40 or 41–55 for the development/validation batches; throughput uses P=30, N=M in {0,3,4,5,6,7,8} and budget 300 after the warmup.

```sh
node --import tsx --input-type=module <<'JS'
import { measureBasinRun } from './packages/solver/src/methods/basin_hopping/measure.ts';
const problems = [[4,4,5],[4,4,10],[4,4,11],[0,0,7],[0,0,19],[0,4,10],[5,5,6],[6,6,7]];
for (const [N,M,P] of problems) {
  const square = N === 4 && M === 4;
  for (const budget of square ? [3000,10000,30000] : [3000,30000]) {
    for (let seed = 1; seed <= (square ? 20 : 5); seed++) {
      console.log(JSON.stringify(await measureBasinRun({N,M,P}, budget, seed)));
    }
  }
}
JS
```

[CALC] The method's own test file (`packages/solver/test/basin_hopping.test.ts`, 24 tests, measured at 58.151 seconds) covers random-property workloads up to P=30; its five-square regression on seeds 41–55 achieves 12/15 at 10,000 evaluations. The independent review's six-of-fifteen target at 3,000 evaluations was not met (**4/15**).

[EST] Not provided: a normal-result diagnostic channel, the full child seed emission pool, browser throughput and an unconditional atomic-geometry abort bound.

## Complete registered parameter schema

```json
{
  "type": "object",
  "title": "Basin hopping / iterated local search",
  "description": "Perturb and locally repair packings, with adaptive operators and Metropolis acceptance of local scores.",
  "additionalProperties": false,
  "properties": {
    "localEvals": {
      "type": "integer",
      "title": "Local solve evaluations",
      "description": "Maximum shared assessments per hop penalty solve, including its start; clipped to remaining budget, terminal refinement and pool reserves.",
      "default": 150,
      "minimum": 2,
      "maximum": 1000000
    },
    "refinementEvals": {
      "type": "integer",
      "title": "Final refinement evaluations",
      "description": "Cap for a tighter final penalty solve from the strict best; reserve at most one sixth of the method allowance. Zero disables it.",
      "default": 3000,
      "minimum": 0,
      "maximum": 1000000
    },
    "alignmentTolerance": {
      "type": "number",
      "title": "Final wall alignment tolerance",
      "description": "Radians: also try a fixed-angle penalty solve when all pieces are near container face or vertex alignment. Zero disables this restricted solve.",
      "default": 0.01,
      "minimum": 0,
      "maximum": 0.1
    },
    "seedEvals": {
      "type": "integer",
      "title": "Seed evaluations",
      "description": "Automatic seed slice, also with a supplied start; adds seed results to alternative restarts.",
      "default": 24,
      "minimum": 1,
      "maximum": 10000
    },
    "temperature": {
      "type": "number",
      "title": "Temperature",
      "description": "Score units; uphill probability exp(-difference/temperature). Zero accepts strict improvements only.",
      "default": 0.04,
      "minimum": 0,
      "maximum": 1000
    },
    "kickMagnitude": {
      "type": "number",
      "title": "Kick displacement",
      "description": "Uniform displacement per axis in piece units; adapted after kick trials, bounded to [0.001,10].",
      "default": 0.35,
      "minimum": 0.001,
      "maximum": 10
    },
    "kickFraction": {
      "type": "number",
      "title": "Kicked fraction",
      "description": "Ceiling of this fraction of pieces is sampled without replacement, at least one.",
      "default": 0.4,
      "minimum": 0,
      "maximum": 1
    },
    "rotationMagnitude": {
      "type": "number",
      "title": "Rotation amplitude",
      "description": "Uniform angle in plus/minus this many radians for kicks and cluster turns.",
      "default": 1.5707963267948966,
      "minimum": 0,
      "maximum": 3.141592653589793
    },
    "clusterRadius": {
      "type": "number",
      "title": "Cluster radius",
      "description": "Radius as a multiple of the piece bounding diameter; require at least two members and rotate about their centroid.",
      "default": 1.8,
      "minimum": 0,
      "maximum": 10000
    },
    "reinsertionTrials": {
      "type": "integer",
      "title": "Free region samples",
      "description": "Centre samples inside the current container, with fitting neighbour and wall orientations; rank enclosing size then clearance.",
      "default": 48,
      "minimum": 1,
      "maximum": 4096
    },
    "restartStrength": {
      "type": "number",
      "title": "Restart strength",
      "description": "Multiply the adaptive kick amplitude for all pieces of a randomly selected seed.",
      "default": 3,
      "minimum": 1,
      "maximum": 100
    },
    "targetAcceptance": {
      "type": "number",
      "title": "Target kick acceptance",
      "description": "Adapt kick size toward this acceptance probability; numerical score ties within 1e-9 do not change the amplitude.",
      "default": 0.5,
      "minimum": 0,
      "maximum": 1
    },
    "adaptationRate": {
      "type": "number",
      "title": "Adaptation rate",
      "description": "Exponential moving average coefficient and logarithmic kick adaptation rate; zero disables adaptation.",
      "default": 0.15,
      "minimum": 0,
      "maximum": 1
    },
    "weightFloor": {
      "type": "number",
      "title": "Operator exploration floor",
      "description": "Effective weight = base weight times (floor + recent rate of improvements larger than 1e-9). Zero base weight disables an operator.",
      "default": 0.2,
      "minimum": 0.001,
      "maximum": 1
    },
    "weights": {
      "type": "object",
      "title": "Operator weights",
      "description": "Relative base weights; all zero falls back to kicks. Recent improvements larger than 1e-9 adapt their effective weights.",
      "additionalProperties": false,
      "properties": {
        "kick": {
          "type": "number",
          "title": "kick",
          "description": "Relative selection weight for kick.",
          "default": 4,
          "minimum": 0,
          "maximum": 1000
        },
        "swap": {
          "type": "number",
          "title": "swap",
          "description": "Relative selection weight for swap.",
          "default": 1,
          "minimum": 0,
          "maximum": 1000
        },
        "cluster": {
          "type": "number",
          "title": "cluster",
          "description": "Relative selection weight for cluster.",
          "default": 2,
          "minimum": 0,
          "maximum": 1000
        },
        "reinsert": {
          "type": "number",
          "title": "reinsert",
          "description": "Relative selection weight for reinsert.",
          "default": 2,
          "minimum": 0,
          "maximum": 1000
        },
        "restart": {
          "type": "number",
          "title": "restart",
          "description": "Relative selection weight for restart.",
          "default": 0.3,
          "minimum": 0,
          "maximum": 1000
        }
      }
    },
    "poolLimit": {
      "type": "integer",
      "title": "Local optimum pool",
      "description": "Keep and emit plain configurations in at most this many distinct score/distance classes, best first. Emit costs one evaluation.",
      "default": 8,
      "minimum": 0,
      "maximum": 64
    },
    "penalty": {
      "type": "object",
      "title": "Local penalty parameters",
      "description": "Nested penalty schema; defaults use six outer and 120 inner iterations. Child solves never append polish.",
      "additionalProperties": false,
      "properties": {
        "start": {
          "type": "string",
          "enum": ["seed", "scatter"],
          "default": "seed",
          "title": "Initial arrangement",
          "description": "Without a complete supplied start, use the best automatic seed within 24 shared assessments, or the random scatter baseline. Seed runs without a valid result fall back to scatter."
        },
        "schedule": {
          "type": "string",
          "enum": ["quadratic", "augmented"],
          "default": "augmented",
          "title": "Penalty schedule",
          "description": "Quadratic raises the squared-violation weight; augmented also updates nonnegative inequality multipliers."
        },
        "initialWeight": {
          "type": "number",
          "exclusiveMinimum": 0,
          "default": 10,
          "title": "Initial weight",
          "description": "Initial coefficient of squared penetration and protrusion in piece units."
        },
        "growthFactor": {
          "type": "number",
          "minimum": 1,
          "maximum": 100,
          "default": 4,
          "title": "Weight growth",
          "description": "Weight multiplier: every quadratic outer solve, or only when augmented constraint violation fails to decrease enough."
        },
        "outerIterations": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 6,
          "title": "Outer iterations",
          "description": "Maximum number of weight and multiplier updates."
        },
        "innerIterations": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10000,
          "default": 120,
          "title": "Inner iterations",
          "description": "Maximum L-BFGS iterations at each weight; every accepted step submits a restored candidate."
        },
        "memory": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 12,
          "title": "L-BFGS memory",
          "description": "Number of curvature pairs retained in the inverse-Hessian approximation."
        },
        "gradientTolerance": {
          "type": "number",
          "exclusiveMinimum": 0,
          "default": 1e-7,
          "title": "Gradient tolerance",
          "description": "Stop an inner solve when the infinity norm of its gradient reaches this threshold."
        },
        "jitter": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "default": 0.00001,
          "title": "Initial symmetry breaking",
          "description": "Seeded position and angle perturbation before the first inner solve, in piece units/radians. Zero disables it; the unperturbed start remains the valid fallback."
        },
        "violationReduction": {
          "type": "number",
          "exclusiveMinimum": 0,
          "exclusiveMaximum": 1,
          "default": 0.5,
          "title": "Augmented violation reduction",
          "description": "Keep the augmented weight when maximum positive constraint violation is at most this fraction of its previous value; otherwise increase it."
        },
        "restoration": {
          "type": "string",
          "enum": ["separate", "expand"],
          "default": "separate",
          "title": "Feasibility restoration",
          "description": "Separate uses small pairwise moves, then uniform expansion if necessary; expand uses uniform centre expansion directly."
        }
      }
    }
  }
}
```
