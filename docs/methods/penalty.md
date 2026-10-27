# Penalty / augmented Lagrangian

[CALC] `penalty` is a local packing optimizer. Variables are each piece's centre
and rotation (omitted for circles), plus the container centre, size and orientation
(omitted for a circle container). Polygon pieces have side 1; circle pieces have
diameter 1 (radius 1/2). The minimized size is the container side or, for a circle container, its diameter.

[CALC] The quadratic objective is `size + weight * sum(max(0, depth)^2)`.
Pair depth is negative shared SAT separation for polygons, or `1 - centreDistance`
for circles. For each polygon-container edge, containment uses the piece's support
vertex, selected analytically in O(1), giving O(M) constraints per piece. Circle
containers constrain all polygon vertices. Circle pieces contribute their centre
plus radius 1/2. Support constraints have the same feasible set as all vertex-edge
constraints, but their squared penalties differ away from feasibility.

[CALC] The augmented objective uses the inequality Powell–Hestenes–Rockafellar term
`(max(0, lambda + 2*weight*depth)^2 - lambda^2)/(4*weight)`. After an inner solve,
`lambda = max(0, lambda + 2*weight*depth)` is applied only if that solve converged
or reduced the objective by more than `1e-12 * max(1, abs(initialObjective))`.
A stalled solve that made no significant progress leaves multipliers unchanged.
The quadratic schedule multiplies the weight every outer iteration. The augmented
schedule holds it while maximum positive constraint violation falls to at most
`violationReduction` times the previous outer residual, and multiplies it otherwise.
The first augmented outer solve holds the weight, establishing the residual baseline.
The default factor 0.5 and progress threshold are implementation choices [CALC];
the practical augmented-Lagrangian continuation approach is described in Nocedal
and Wright, chapter 17, especially section 17.4 [EST].

[CALC] L-BFGS uses analytic pose and container gradients and an Armijo line search
that accepts only finite, strictly decreasing steps with sufficient decrease.
Unsafe curvature pairs are discarded. A rebuilt spatial grid covers possible
contacts at every objective call; augmented mode also retains every pair with
positive multipliers beyond the grid reach. Dense configurations can still require
quadratic pair work. SAT axes are cached once per piece per objective call, with
exactly the same arithmetic as the shared separation routine. Only the final
winning feature creates a pair-gradient object.

[CALC] The optimizer uses an allocation-free numeric protrusion visitor and integer
constraint IDs; quadratic mode creates no constraint keys. Existing direct callers
of `containerProtrusions` keep all vertex-edge constraints and their original order.
`createPenaltyObjective` also preserves its full-constraint default for those
callers; the registered method explicitly selects `supportOnly: true` (sixth argument).
Older string multiplier IDs are translated at the factory boundary; production
uses integer multipliers. An empty full-mode map retains the legacy string-ID
convention; an empty support-mode map uses integer IDs. Integer pairs are `i*P+j`,
and walls are `P*P+i*wallCount+k`.

[CALC] Working coordinates are relative to an anchored start centroid, and assessed
candidates are translated back. Initial enclosure is recomputed in this local frame
using shared geometry. The working container angle starts at zero because the
framework's stored start angle includes auto-orientation rounding at large absolute
coordinates; phi then remains an optimizer variable. The supplied start remains
an assessed fallback. Spatial blow-up checks allow the full accepted global span
(up to 2*MAX_COORD in local coordinates), and do not reject large finite angles.
Grid loops use bounded integer offsets; unrepresentable cell indices use a bounded
all-pairs fallback. Nonfinite objectives, spatial blow-ups and weight overflow
stop optimization without replacing a valid best.

[CALC] Every accepted inner step and outer endpoint attempts restoration. Successful
restorations go through `ctx.evaluate` with `autoOrient: false`; the framework
computes the true enclosing container and retains its best valid result. Default
repair makes small pairwise separating moves, with uniform centre expansion as a
fallback. Expansion is bracketed using shared separation tests and stops before
spatial blow-up. For centres less than `1e-8 * (2*boundingRadius)` apart, a direction
drawn from `ctx.random` separates their bounding circles before either strategy.
Near-coincidences arising during separating sweeps also use seeded directions.
The method never invokes polish itself; the framework appends its contact polish.

## Parameters

[CALC] JSON Schema is an object with `additionalProperties: false`. Every property
has a title, description and default for the parameter form.

| Parameter            | Default       | Schema constraints             | Meaning                                                                                                                                   |
| -------------------- | ------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `start`              | `"seed"`      | `"seed"` or `"scatter"`        | Automatic seed subrun or the random scatter baseline when no complete start is supplied.                                                  |
| `schedule`           | `"augmented"` | `"quadratic"` or `"augmented"` | Weight-only continuation or adaptive weight and multiplier updates.                                                                       |
| `initialWeight`      | `10`          | number > 0                     | Initial squared-violation coefficient.                                                                                                    |
| `growthFactor`       | `4`           | number in [1, 100]             | Weight multiplier when the schedule calls for an increase.                                                                                |
| `outerIterations`    | `10`          | integer in [1, 100]            | Maximum outer solves.                                                                                                                     |
| `innerIterations`    | `200`         | integer in [1, 10000]          | Maximum L-BFGS iterations per outer solve.                                                                                                |
| `memory`             | `12`          | integer in [1, 100]            | Stored L-BFGS curvature pairs.                                                                                                            |
| `gradientTolerance`  | `1e-7`        | number > 0                     | Inner gradient infinity-norm threshold.                                                                                                   |
| `restoration`        | `"separate"`  | `"separate"` or `"expand"`     | Pairwise repair with expansion fallback, or expansion directly.                                                                           |
| `jitter`             | `1e-5`        | number in [0, 1]               | Uniform seeded perturbation in [-jitter, jitter] for each working piece coordinate and angle before the first inner solve; 0 disables it. |
| `violationReduction` | `0.5`         | number in (0, 1)               | Required outer residual reduction to keep the augmented weight unchanged.                                                                 |

[CALC] A complete supplied start is used unchanged by either start mode, including
an overlapping start that needs restoration. Without one, default `start: "seed"`
calls `ctx.run("seed", {kind: "auto"}, {evals: 24})` and uses its valid complete
best arrangement. The 24 assessments share the parent budget; this includes
seed emissions and any child-start assessment. `MethodContext` exposes no
remaining budget, so this is a fixed cap rather than a fraction of the remaining
allowance. The framework clips it against the parent evaluation and time limits.
No child time limit is added: evaluations-only runs remain deterministic even
when machine load changes. The shared framework retains assessed seed candidates
as fallback results even when optimization cannot start. No record is supplied
to the seed generator.

[CALC] A subrun without a valid complete matching result falls back to scatter,
provided the parent can still evaluate. A rejected call also selects scatter in
a context that remains active, including a custom registry without the seed
method. Exceptions thrown inside a child method mark the standard framework's
parent as errored and stop later assessments, so they cannot be recovered by this
method. Subrun `best` is the shared global best, not a separate child-local best.

[CALC] `start: "scatter"` uses the previous no-start baseline directly. Scatter
centres occupy a square grid with pitch
`2.4*boundingRadius`. Each coordinate is jittered uniformly by up to 0.075 pitch;
polygon angles are uniform in [0, 2*pi), independent of the grid. Circle angles
are zero. Minimum adjacent separation is at least `0.85*2.4R = 2.04R`, so bounding
circles cannot overlap at any piece orientation. This is a grid of jittered centres
with random angles, not uniform sampling over a disk. A separate symmetry-breaking
jitter perturbs the working iterate, while the original valid seed/scatter/start
remains best until a valid improvement is found. Penalty mathematics, restoration
and jitter are unchanged; there are no branches on known packing answers.

[CALC] Budgets count framework geometry assessments, not analytic objective or
line-search calls. Successfully restored accepted steps each submit an assessment.
Checkpoints occur per L-BFGS iteration and outer boundary; stop checks also cover
line searches, pair/grid scans and restoration. Evaluations-only runs reproduce
in a fixed JavaScript runtime; time-budget results depend on actual load.

## Where it works and where it struggles

[CALC] It tightens starts with useful contact topology. Tests recover loosened and
jittered five-square, seven-circle and two-circle constructions to 1e-8 with final
polish, and cover coincident and collinear starts, large translations, deterministic
randomness, both schedules, all containment kinds, numerical failure and abort.
Seeded jitter can leave symmetric saddles, but it is not a global search. Structured
seeds and uniformly random scatter angles can settle into different local minima;
neither start mode guarantees the best known packing. The benchmark below records
both improvements and regressions.
SAT depth and support vertex selection are non-smooth at feature switches, where
one branch derivative is returned. Smooth L-BFGS convergence theory does not apply
there. Large weights can still make difficult inner problems ill-conditioned.

[CALC] The framework can return no best before any method seed is assessed, with
no supplied start and an already-aborted signal, zero time, or one evaluation
reserved entirely for final polish. A supplied valid start is assessed even then.
This method does not change that framework behavior. [EST] Existing final polish
is float64 SQP/Newton (see [`polish.md`](polish.md)), not 50-digit mpmath. Shared
geometry assessment and final auto-orientation are synchronous, so arbitrary-input
preemption during those calls is a framework limitation. Browser throughput was
not measured.

## References

[EST] Primary publisher metadata and the author preprint were verified on
2026-10-08; the Nocedal–Wright chapter/section listing was rechecked on 2026-10-09.
These are the algorithms and related elastic packing model used, not a claim to
reproduce the preprint's global search strategy.

- Jorge Nocedal and Stephen J. Wright, _Numerical Optimization_, second edition,
  Springer, 2006. Chapter 17, “Penalty and Augmented Lagrangian Methods,” pp. 497–528.
  [Publisher chapter metadata](https://link.springer.com/chapter/10.1007/978-0-387-40065-5_17),
  [author's section listing](https://users.iems.northwestern.edu/~nocedal/book/toc.html).
- Dong C. Liu and Jorge Nocedal, “On the limited memory BFGS method for large scale
  optimization,” _Mathematical Programming_ 45, 503–528, 1989.
  [Publisher metadata](https://link.springer.com/article/10.1007/BF01589116).
- Kun He, Hui Ye, Zhengli Wang and Jingfa Liu, “An Efficient Quasi-physical
  Quasi-human Algorithm for Packing Equal Circles in a Circular Container,”
  arXiv:1611.02323v2, 2017. Sections 3.1–3.3 cover squared elastic energies,
  BFGS and neighbour lists.
  [Author preprint](https://arxiv.org/abs/1611.02323),
  [full text](https://arxiv.org/pdf/1611.02323).

## Default benchmark: seed and scatter

[CALC] Both modes use no supplied start, seeds 1–5, 3,000 shared evaluations,
all other parameters at their defaults, and framework final polish. These 60
results were measured on 2026-10-09 in Node.js v26.5.0 on Apple Silicon macOS,
alternating seed/scatter within each seed. All results are valid. All five seeded
pentagon runs, scatter pentagon seed 1, and scatter hexagon seed 5 terminate with
`evals`; the other 53 complete. Times are measured wall times, not guarantees.
No seeds were selected or omitted. The 24-assessment seed cap is included in each
seeded run's total.

[EST] Printed record values are from `data/records.json`:

| Pieces / container   |   P |   Published value | Source                                                                    |
| -------------------- | --: | ----------------: | ------------------------------------------------------------------------- |
| Squares / square     |   5 |  2.70710678118654 | [Ellsworth](https://kingbird.myphotos.cc/packing/squares_in_squares.html) |
| Squares / square     |  10 |  3.70710678118654 | [Ellsworth](https://kingbird.myphotos.cc/packing/squares_in_squares.html) |
| Circles / circle     |   7 |                 3 | [Friedman](https://erich-friedman.github.io/packing/cirincir/)            |
| Circles / circle     |  19 | 4.863703305156274 | Friedman / Packomania as recorded in records.json                         |
| Pentagons / pentagon |   6 |          2.61803+ | [Friedman](https://erich-friedman.github.io/packing/peninpen/)            |
| Hexagons / hexagon   |   7 |            2.886+ | [Friedman](https://erich-friedman.github.io/packing/hexinhex/)            |

[CALC] Best, median and worst scores over all five seeds. The pentagon and
hexagon printed record values are truncated, so their final digits are not exact
comparison thresholds. Lower scores are better.

| N=M |   P |      Seed best |    Seed median |     Seed worst |   Scatter best | Scatter median |  Scatter worst |
| --: | --: | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: |
|   4 |   5 | 2.828427124746 | 2.828427124746 | 2.828427124746 | 2.768356257710 | 3.000000000001 | 3.000000000015 |
|   4 |  10 | 4.000000000001 | 4.000000000001 | 4.000000000001 | 4.000000000001 | 4.000000000001 | 4.000002070008 |
|   0 |   7 | 3.000000000000 | 3.000000000000 | 3.000000000000 | 3.000000000000 | 3.000000000000 | 3.000000000000 |
|   0 |  19 | 4.863703305157 | 4.863703305157 | 4.863703305157 | 4.863703305157 | 4.863703305157 | 5.178581468861 |
|   5 |   6 | 2.618033995288 | 2.618034151092 | 2.618034370781 | 2.618046570172 | 3.065248413882 | 3.103235349503 |
|   6 |   7 | 2.886751345948 | 2.886751345948 | 2.886751345948 | 2.886752026160 | 2.932217117682 | 2.935296282728 |

[CALC] Cost ranges include the child seed run, restoration assessments and
framework final polish. Geometry assessments, not analytic objective calls,
count toward the evaluation budget.

| N=M |   P | Seed evals | Scatter evals | Seed wall time (s) | Scatter wall time (s) |
| --: | --: | ---------: | ------------: | -----------------: | --------------------: |
|   4 |   5 |    506–838 |      240–1920 |  0.033904–0.066177 |     0.018467–0.174388 |
|   4 |  10 |    297–635 |      469–1650 |  0.079024–0.134747 |     0.123561–0.456215 |
|   0 |   7 |    153–156 |       179–184 |  0.005033–0.008638 |     0.006093–0.007499 |
|   0 |  19 |    187–201 |       274–312 |  0.036079–0.041627 |     0.080946–0.104026 |
|   5 |   6 |  3000–3000 |     1014–3000 |  0.357599–0.380836 |     0.091847–0.362599 |
|   6 |   7 |    552–749 |     1623–3000 |  0.070023–0.091315 |     0.212817–0.496417 |

[CALC] Individual results, paired by the same random seed.

| N=M |   P | Seed |  Seed-start score | Scatter-start score | Seed evals | Scatter evals | Seed time (s) | Scatter time (s) |
| --: | --: | ---: | ----------------: | ------------------: | ---------: | ------------: | ------------: | ---------------: |
|   4 |   5 |    1 | 2.828427124746470 |   3.000000000015354 |        560 |           332 |      0.066177 |         0.043611 |
|   4 |   5 |    2 | 2.828427124746395 |   3.000000000000824 |        506 |           326 |      0.034358 |         0.029553 |
|   4 |   5 |    3 | 2.828427124746395 |   2.768356257710299 |        838 |          1920 |      0.053566 |         0.174388 |
|   4 |   5 |    4 | 2.828427124746395 |   3.000000000000463 |        567 |           253 |      0.033904 |         0.019713 |
|   4 |   5 |    5 | 2.828427124746469 |   3.000000000001152 |        743 |           240 |      0.042419 |         0.018467 |
|   4 |  10 |    1 | 4.000000000000576 |   4.000001361675485 |        635 |          1563 |      0.124796 |         0.456215 |
|   4 |  10 |    2 | 4.000000000000576 |   4.000002070008065 |        584 |          1650 |      0.134747 |         0.233676 |
|   4 |  10 |    3 | 4.000000000000576 |   4.000000000001324 |        587 |           826 |      0.124507 |         0.179329 |
|   4 |  10 |    4 | 4.000000000000576 |   4.000000000000623 |        297 |           469 |      0.079024 |         0.123561 |
|   4 |  10 |    5 | 4.000000000000576 |   4.000000000001260 |        584 |           696 |      0.097540 |         0.193501 |
|   0 |   7 |    1 | 3.000000000000202 |   3.000000000000161 |        153 |           184 |      0.008638 |         0.007499 |
|   0 |   7 |    2 | 3.000000000000202 |   3.000000000000161 |        153 |           180 |      0.005224 |         0.006573 |
|   0 |   7 |    3 | 3.000000000000202 |   3.000000000000162 |        155 |           184 |      0.005401 |         0.006853 |
|   0 |   7 |    4 | 3.000000000000202 |   3.000000000000161 |        154 |           182 |      0.005729 |         0.006836 |
|   0 |   7 |    5 | 3.000000000000202 |   3.000000000000161 |        156 |           179 |      0.005033 |         0.006093 |
|   0 |  19 |    1 | 4.863703305156644 |   5.178581468860572 |        187 |           274 |      0.041627 |         0.080946 |
|   0 |  19 |    2 | 4.863703305156644 |   4.863703305156662 |        189 |           300 |      0.036079 |         0.092230 |
|   0 |  19 |    3 | 4.863703305156644 |   4.863703305156662 |        201 |           308 |      0.037882 |         0.099030 |
|   0 |  19 |    4 | 4.863703305156644 |   4.863703305156662 |        190 |           308 |      0.036835 |         0.096460 |
|   0 |  19 |    5 | 4.863703305156644 |   4.863703305156662 |        194 |           312 |      0.038044 |         0.104026 |
|   5 |   6 |    1 | 2.618033995287643 |   2.618046570171623 |       3000 |          3000 |      0.357599 |         0.362599 |
|   5 |   6 |    2 | 2.618034108429770 |   3.065238302960001 |       3000 |          1548 |      0.376676 |         0.141196 |
|   5 |   6 |    3 | 2.618034370781183 |   3.102276174704086 |       3000 |          1652 |      0.367210 |         0.136622 |
|   5 |   6 |    4 | 2.618034222488108 |   3.103235349503287 |       3000 |          1727 |      0.380836 |         0.147344 |
|   5 |   6 |    5 | 2.618034151091670 |   3.065248413882428 |       3000 |          1014 |      0.380171 |         0.091847 |
|   6 |   7 |    1 | 2.886751345948331 |   2.918133666851437 |        638 |          2161 |      0.081369 |         0.333842 |
|   6 |   7 |    2 | 2.886751345948331 |   2.932218515267579 |        716 |          2278 |      0.089215 |         0.277347 |
|   6 |   7 |    3 | 2.886751345948331 |   2.935296282728471 |        552 |          1623 |      0.070023 |         0.212817 |
|   6 |   7 |    4 | 2.886751345948331 |   2.932217117681680 |        633 |          2036 |      0.077795 |         0.223309 |
|   6 |   7 |    5 | 2.886751345948331 |   2.886752026159955 |        749 |          3000 |      0.091315 |         0.496417 |

[CALC] Seed starts improve the five-square median, nineteen-circle worst case,
pentagon median and hexagon median in this sample. They do not uniformly improve
individual runs: five-square seed 3 gets worse by `0.060070867036`, from scatter's
`2.768356257710` to seed's `2.828427124746`. The seeded five-square best is also
worse than scatter's best, and both miss the printed `2.707106781187` record.
Ten-square runs stay at 4, above the printed `3.707106781187` record. Seeded
pentagon runs use the full budget in all five seeds; their better scores do not
establish lower cost. Circle score differences below 1e-12 reflect numerical
rounding, not meaningful quality changes. These measurements show different
local minima and finite-budget behavior, not global optimality guarantees.

## Objective-plus-gradient throughput

[CALC] This replaces the original throughput table, whose square configuration
had no overlapping pairs. Before and after are measured on exactly the same
fixed configuration, independent of the changed scatter function: P=30, M=N,
seededRandom(1), width 6, bounding radius R, and for piece i:
`x=R*(0.9*(i%6-2.5)+0.05*(random()-0.5))`,
`y=R*(0.9*(floor(i/6)-2)+0.05*(random()-0.5))`,
`theta=2*pi*random()` for polygons, zero for circles (circles do not draw an angle).
The container is the shared-geometry fixed-angle enclosure at phi=0. Every shape
has at least 100 active pair penalties; overlap counts are recorded below.

[CALC] Both measurements use quadratic weight 10, a rebuilt grid per call,
200 warm-up calls, then 5,000 timed calls for N<=8 or 1,500 for N>=20. Before uses
the first, unoptimized objective; after uses the registered method's support-only
factory mode, cached SAT axes and container normals, and the numeric visitor. They exclude restoration,
framework scoring, final polish and module loading. The container contains the
pieces, so this test exercises active pair gradients and inactive containment
constraints. Timing occurs only in the harness. Node.js/Apple M1 Pro; browser
performance is unmeasured.

| N=M | Active pairs | Calls | Before / s | After / s | Speedup |
| --: | -----------: | ----: | ---------: | --------: | ------: |
|   0 |          139 |  5000 |    25919.9 |   44293.7 |   1.71x |
|   4 |          100 |  5000 |     4541.3 |    8485.2 |   1.87x |
|   8 |          129 |  5000 |     1644.2 |    5319.8 |   3.24x |
|  20 |          134 |  1500 |      401.7 |    2364.2 |   5.88x |
|  50 |          140 |  1500 |       76.4 |    1011.1 |  13.23x |

[CALC] An independent review reported 475/s for N=20 and 82/s for N=50 on
the previous implementation. Those historical figures are not a matched-state baseline for this harness;
the same-configuration measurements above establish the before/after speedups
and meet the five-times target for both N=20 and N=50. These are observed throughput values, not worst-case guarantees.

[CALC] Reproduce packing runs by importing `run` from `packages/solver/src/index.ts`
and calling `run({N,M,P}, {method: "penalty", params: {start}, budget: {evals: 3000}, seed, finalPolish: true})`
with `start` equal to `"seed"` or `"scatter"` and seeds 1–5.
For throughput use `packState({config, container})` and
`createPenaltyObjective(config, 10, new Map<number, number>(), false, () => false, true)`
in `packages/solver/src/methods/penalty/objective.ts` with the state above.

[CALC] For transparency, dividing the final rates by the review's historical
figures gives 4.977x at N=20 and 12.331x at N=50. The N=20
absolute rate is slightly below five times 475/s; the matched-state comparison
above, rather than a cross-run historical baseline, is the measured five-times
speedup result.

## Validation

[CALC] The method's tests and the independent review suite run with:

```sh
npx vitest run packages/solver/test/penalty.test.ts packages/solver/test/penalty.review.test.ts
```

The 27 method tests cover, among other things, the seed cap and selection,
unusable/rejected seed results in an active mock context, recovery when seed
is absent from a custom registry, supplied-start bypass, explicit scatter, and
deterministic tiny parent budgets.

[CALC] Schedule comparison for seven circles without final polish: with the
default seed start, the seed already scores approximately 3 and the framework
retains it for both schedules, so the two schedules cannot be told apart. With
`start: "scatter"` and `growthFactor: 1`, quadratic returns
`3.0004309221775913` and augmented `3.0000000003971268`.
