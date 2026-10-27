# Adaptive shrinking container (`asc`)

[CALC] ASC interleaves hard-particle Monte Carlo with explicit movement of a
fixed-shape container and collective movement of piece centres. Polygon pieces
keep side one, circles keep diameter one (radius 1/2, since 2026-10-27), and rotations follow the shared Phase 1
conventions. The objective is polygon-container side or circle-container diameter.

```ts
const result = await run({ N: 5, M: 5, P: 6 }, { method: "asc", budget: { evals: 3000 }, seed: 1 });
```

## Moves and relation to periodic ASC

[EST] Torquato and Jiao's original ASC uses periodic cells whose lattice vectors
and particle poses are optimization variables. Their Monte Carlo implementation
combines rigid particle moves with cell strains and biased expansion acceptance.
See their 2009 [paper and Section II of its preprint](https://arxiv.org/pdf/0909.0940).

[CALC] This implementation replaces the periodic cell with hard walls. It has
no periodic images, lattice-vector optimization, or cell shear. One sweep tries
P random single-particle translations or rotations, then the enabled container
and collective moves. Circle rotations are omitted. Moves change only centres
and rigid orientations; vertices are never strained.

| Move                  | Trial and relation to cell strain                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Particle translation  | Uniform independent coordinate increments in ±`translationStep`; ordinary local MC displacement.                                                                                                                                                                                                                       |
| Particle rotation     | Polygon angle increment in ±`rotationStep`; ordinary rigid rotation.                                                                                                                                                                                                                                                   |
| Container translation | Explicit centre increments in ±`containerTranslationStep`, with pieces, size and phi fixed. A finite hard-wall degree of freedom absent from translation-invariant periodic cells.                                                                                                                                     |
| Container rotation    | Explicit phi increment in ±`containerRotationStep`, normalized to the container symmetry period, with pieces, centre and size fixed. Circle containers omit it.                                                                                                                                                        |
| Container scale       | Fractional size decrease drawn between half and all of `scaleStep`; at positive temperature, 20% of proposals instead expand. No enclosure solver chooses the trial size or centre.                                                                                                                                    |
| Balanced strain       | About container centre c, with random unit axis u and perpendicular v, map d=x−c to (1−a)(d·u)u+(d·v)v/(1−a). This imitates an anisotropic, area-preserving cell deformation, since its determinant is one. Only particle centres change; walls retain their regular shape.                                            |
| Uniaxial strain       | Map d to (1−a)(d·u)u+(d·v)v. This is the centre-motion part of a compressive axial cell strain, with determinant 1−a, while regular hard walls stay fixed.                                                                                                                                                             |
| Sector strain         | Contract d to (1−a)d only when d·u≥‖d‖cos(w). Random w is π/2 for a half-plane half the time; otherwise it is uniform in [0.1π,0.5π). This regional displacement has no single global cell-strain tensor; it is an extra finite-boundary heuristic.                                                                    |
| Radial strain         | Map every d to (1−a)d and explicitly propose size s′=(1−a)s+aB/q, where B is piece bounding radius and q is unit container apothem (q=1/2 for a circle container, whose size is its diameter). This mimics isotropic compression while allowing for rigid pieces. It is also tried before diffusion to preserve the contact topology of loose supplied starts. |

[CALC] For the radial trial, a piece offset z has ‖z‖≤B. Its support after
centre contraction is f times the original support plus (1−f)z·u. Consequently
f times the old wall distance plus (1−f)B is sufficient, giving the proposed
size above. This bound may be conservative for polygons. Every trial still
undergoes strict containment and separation checks. For balanced, uniaxial and
sector strains, a is uniform between half and all of the move's amplitude.

[CALC] A feasible same-size or smaller trial is accepted. An expansion uses
`exp(-(s′−s)/T)`, where T is the temperature in score units. T=0 forbids every
accepted increase, including any radial proposal that would increase size.
Feasibility means no pair separation below zero and no positive protrusion.
ASC uses the shared cell grid for particle moves, `findOverlaps(N,pieces,0)`
for collective states, and full shared vertex wall constraints. There is no
1e−9 allowance, automatic wall repair, or deterministic re-enclosure in its
acceptance decisions. A small outward enclosure margin initializes the walls;
it is never credited to the score.

## Parameters and defaults

[CALC] All nodes of the registered JSON Schema have titles and descriptions.
Unknown properties are rejected. Amplitudes are independently adapted by
`step *= exp(adaptationGain*(accepted/attempted−targetAcceptance))` with a
1e−7 floor. Translation amplitudes cap at twice the piece bounding radius,
angles at π, and fractional strains/scales at 0.3. An inactive move has no
acceptance window and is not adapted. Radial warmup adapts after each proposal;
ordinary sweeps adapt at the specified interval. With gain zero, amplitudes
remain fixed.

| Parameter                  | Default | Allowed range / meaning                                 |
| -------------------------- | ------- | ------------------------------------------------------- |
| `translationStep`          | 0.15    | 1e−7–100; particle coordinate half-width.               |
| `rotationStep`             | 0.15    | 1e−7–π; particle angle half-width.                      |
| `containerTranslationStep` | 0.05    | 1e−7–100; container centre coordinate half-width.       |
| `containerRotationStep`    | 0.05    | 1e−7–π; explicit container angle half-width.            |
| `scaleStep`                | 0.01    | 1e−7–0.3; fractional container scale amplitude.         |
| `balancedStep`             | 0.01    | 1e−7–0.3; reciprocal transverse strain amplitude.       |
| `uniaxialStep`             | 0.01    | 1e−7–0.3; axial strain amplitude.                       |
| `sectorStep`               | 0.01    | 1e−7–0.3; regional radial strain amplitude.             |
| `radialStep`               | 0.03    | 1e−7–0.3; isotropic strain amplitude.                   |
| `targetAcceptance`         | 0.3     | 0.01–0.99; common target, separate statistics per move. |
| `adaptationGain`           | 1       | 0–10; exponential gain.                                 |
| `adaptationSweeps`         | 20      | Integer 1–10000; update interval.                       |
| `sweepsPerEvaluation`      | 10      | Integer 1–1000; scoring interval.                       |
| `stagnationSweeps`         | 2000    | Integer 1–100000; stop without meaningful progress.     |
| `radialWarmup`             | 64      | Integer 0–256; radial trials before particle diffusion. |
| `seedEvals`                | 24      | Integer 3–256; automatic seed slice cap.                |
| `temperature`              | 0       | 0–100; Metropolis temperature in score units.           |
| `coolingRate`              | 0.9995  | 0–1; multiply T after every sweep.                      |
| `containerMoves`           | true    | Enables centre and angle trials; scale remains active.  |
| `collectiveMoves`          | true    | Enables all four strains and radial warmup.             |

## Scoring, budgets and limitations

[CALC] A complete supplied start with no pair penetration at zero tolerance,
and with a strict enclosure where it lies, initializes the chain as given. A
complete start valid only within the evaluator's 1e−9 pair tolerance is first
parted in place. Every centre is dilated about the centroid by
1+(d+2e−12)/(2a), where d is the deepest penetration and a the piece apothem
(1/2 for a circle); this leaves each gap at least about 2e−12. The shared
`restore(config, "separate")` repair then clears any pair that roundoff left,
limited to 64 stop polls per piece. Neither step draws random numbers. The
parted state costs one counted assessment, and that assessment, not the
start's, is the score to beat. Otherwise (no start, an incomplete or more
deeply overlapping start, a state with no strict enclosure where it lies, or a
failed or stopped repair) ASC calls the automatic seed generator, capped to a
small slice with at least three assessments when available and `poolLimit:0`
to avoid repeated emissions. For such a supplied start, a distinct, strictly
separated grid is the child start: the framework otherwise reassesses the same
invalid input on entry to `ctx.run`. The child-found configuration is
preferred to the shared best; if it is itself tolerance-only it gets the same
repair and one counted assessment.

[CALC] The dilation comes first because the shared repair alone is too long a
synchronous stretch: for dense 500-pentagon seed lattices with contacts near
−1e−15 it ran 48 separation sweeps and then a bisected uniform expansion,
660,000–690,000 stop polls and 85–94 ms. After the dilation it needs one sweep,
about 15 polls per piece and 1–11 ms at P=500 (Node v26.5.0, arm64, one
machine). Stop and pause are not observed inside a synchronous stretch.

[CALC] Behaviour change, 2026-10-11: a supplied start valid only within
tolerance used to be replaced by the seed generator's result, and is now
parted in place and used. At very small budgets this is sometimes worse than
before. An independent review counted 286 worse of 1,595 cells, for example
N=0, M=4, P=7 at 12 evaluations: 6.297 against 5.864. Those counts were
measured on the first version of this change, which used the pairwise repair
without the dilation, and were not rerun afterwards.

[CALC] The strict enclosure's outward margin is 2e−13 times max(1, size). Near
coordinates of 1e4 one unit in the last place is 1.8e−12, and 165 of 432 loose
grids probed there had no strict enclosure (11 of 432 at 1e3, none at 100).
Such a start, strict or parted, goes through the seed path. Before 2026-10-11
the run ended on it without a move. Recentring it would keep the supplied
arrangement; that is not implemented.

[CALC] ASC calls `ctx.evaluate(config,{autoOrient:false})` at its current phi
every fixed number of sweeps and after each accepted wall shrink smaller than
the scored best. Exact configuration keys prevent repeated ASC assessments. Explicit
size and centre are absent from the configuration schema, so a centre/size-only
wall move does not itself create a new scored configuration. The evaluation
solver encloses the fixed poses for scoring only; it never replaces ASC's walls.

[CALC] Meaningful progress is a score decrease or accepted explicit wall
compression greater than 1e−10 times max(1,size). After `stagnationSweeps`
without either, ASC returns the retained best. It does not expend an evaluation
budget in an unchanged jam. Counts can therefore be below the cap. All counted
work goes through `ctx.evaluate` and `ctx.run`, all randomness through
`ctx.random`, and hot loops check `shouldStop` and yield through checkpoints:
one before every container and collective trial and one every sixteenth
single-piece trial, none of which draws a random number or assesses a state.
The framework appends its existing final polish; ASC never calls polish itself.
Evaluation-only optimization is bit reproducible in the same runtime, while
wall time and time-budget outcomes depend on scheduling.

[CALC] Loose symmetric starts are a good fit for radial warmup. The tests recover
seven and two circles from centre coordinates expanded by 30% at 600 evaluations.
Greedy compression can be trapped by contact networks, especially square grids.
Container centre/angle proposals are frequently blocked when initialized at a
tight enclosure. Regional and anisotropic moves can also be blocked by contacts.
The measured comparisons below, rather than the periodic ASC literature, determine
whether these finite-container additions help here. Defaults were fixed before
the 20-seed measurements; no small-seed tuning was performed.

[EST] Framework limitations that this method inherits: a no-start evaluation budget of
one reserves its only evaluation for polish and never enters the method; a zero
time budget or already-aborted no-start run also produces no best. An invalid
start with no remaining assessment cannot be repaired. The framework controls
the appended polish, its coordinate-dependent strict margin
(`1e−12 + 4 * Number.EPSILON * max(abs(x), abs(y))`), final auto-orientation and
atomic geometry calls. It may reassess identical states during polish, and
the returned minimum pair separation may be slightly negative after polish.
These are framework behaviours, not ASC's. Source:
`packages/solver/src/framework.ts`, `README.md` and ASC boundary tests.

[CALC] The seed child has a separate duplicate-work defect: for
N=M=0, P=1, seed 1, budget 30 and final polish off, ASC's three-assessment
bootstrap scored the origin circle three times, with two identical repeated
seed assessments. This was reproduced by wrapping the registered seed's context
and recording exact configuration keys. `poolLimit:0` avoids repeated emissions,
but cannot stop identical candidates from different seed generators. `packages/solver/src/methods/seed.ts` does not deduplicate across generators
or against its inherited start before evaluation. Thus the no-duplicate
rule is met by ASC's own assessments, but not globally by its seed child
or the appended polish.

[CALC] An independent review found that the shared support-only protrusion shortcut can disagree
with full vertex constraints for an enormous finite angle such as theta=1e16.
ASC now rejects such inconsistent explicit enclosures and checks full vertices
on acceptance. The shared shortcut and the parser's angle range are unchanged. The inherited framework best still uses
the shared evaluator. No claim of universal validity or abort latency beyond
cooperative tested workloads is made. Browser throughput and 50-digit polish
are not implemented or measured by this method; the existing framework's
TypeScript contact polish is used.

## Verified references

- [EST] S. Torquato and Y. Jiao, **Dense packings of the Platonic and Archimedean solids**, _Nature_ **460**, 876–879 (2009), [DOI 10.1038/nature08239](https://www.nature.com/articles/nature08239). Checked the publisher page directly for authors, title, venue, date, volume, pages, DOI and ASC abstract on 2026-10-09. Subscription full text was not used.
- [EST] S. Torquato and Y. Jiao, **Dense packings of polyhedra: Platonic and Archimedean solids**, _Physical Review E_ **80**, 041104 (2009), [DOI 10.1103/PhysRevE.80.041104](https://journals.aps.org/pre/abstract/10.1103/PhysRevE.80.041104). Checked the APS publisher page directly for bibliographic metadata and read [arXiv:0909.0940](https://arxiv.org/pdf/0909.0940), Section II, PDF pages 9–14, for particle moves, cell strain and expansion acceptance. APS uses article number 041104 rather than a conventional page range; verified that identifier rather than inventing pages. Publisher lists 2010 corrections; no historical density claims are imported here.
- [EST] S. Torquato and Y. Jiao, **Robust algorithm to generate a diverse class of dense disordered and ordered sphere packings via linear programming**, _Physical Review E_ **82**, 061302 (2010), [DOI 10.1103/PhysRevE.82.061302](https://journals.aps.org/pre/abstract/10.1103/PhysRevE.82.061302). Checked the APS page directly for authors, title, volume, article identifier, publication date and abstract on 2026-10-09. It describes the sequential linear programming variant; this implementation uses Monte Carlo rather than claiming that variant.

[CALC] An independent review of the implementation ran adversarial rejection
checks and five expanded seven-circle trials. The test suite and benchmarks
below are separate from that review.

## Benchmark results

[CALC] All 1,440 main runs and 480 ablations completed. Each table row contains
seeds 1–20, using the unchanged defaults, the stated overall evaluation cap,
and final polish on. Raw per-seed scores, evaluation counts, wall times,
minimum separations, move statistics and returned poses are saved in
[benchmark.json](../../packages/solver/src/methods/asc/benchmark.json).
Repeat from the repository root with:

```sh
node --import tsx packages/solver/src/methods/asc/benchmark.mjs
node --import tsx packages/solver/src/methods/asc/benchmark.mjs --report
```

[CALC] Scattered starts sample each centre uniformly in [−v,v]², where v is
the stored record size, and each polygon angle uniformly over its symmetry
period. Negative pair separation rejects the new piece. The same start for
each seed goes to all methods. The box side is twice the record size, including
when the record size denotes a circle diameter (before 2026-10-27, a radius). Default-seed rows give each
method its own normal automatic bootstrap; no record poses are supplied.
The raw file preserves every returned arrangement for rechecking.
Random insertion retries the whole start after 100,000 draws if it jams;
retries continue the same seeded PRNG stream, capped at 256 starts.

[CALC] Success means absolute score difference from `data/records.json.value`
at most the specified tolerance. Scores smaller by more than that tolerance
are not silently counted as successes. The pentagon entry is truncated to
2.61803 even though its citation gives (3+√5)/2, differing by about 3.99e−6;
the 1e−9 column therefore cannot recognize the exact pentagon construction.
No record-data change was made. Evaluation caps are hard upper bounds, not
a requirement to repeat jammed states: actual median counts are shown.

[CALC] Measurements used Node v26.5.0 on arm64. Wall times
include final polish and final auto-orientation. ASC's synchronous per-move
observer adds instrumentation overhead; other methods are uninstrumented.
Some groups overlapped test execution or other benchmark processes. These are local costs,
not a controlled machine-isolated timing comparison or browser claim.

| N/M/P  |     Stored record |
| ------ | ----------------: |
| 4/4/5  |  2.70710678118654 |
| 4/4/10 |  3.70710678118654 |
| 0/0/12 | 4.029601930116184 |
| 0/0/19 | 4.863703305156274 |
| 0/4/10 |  6.74744152324853 |
| 5/5/6  |           2.61803 |

### Comparisons

[CALC] Success columns are counts out of 20. Time columns are seconds.

| N/M/P  |   Cap | Start   | Method      | ≤1e−4 | ≤1e−9 | Median score |  Worst score | Median evals | Median s | Worst s | Total s |
| ------ | ----: | ------- | ----------- | ----: | ----: | -----------: | -----------: | -----------: | -------: | ------: | ------: |
| 4/4/5  |  3000 | seed    | asc         |     0 |     0 | 2.8284271247 | 2.8284271247 |          113 |    0.076 |   0.112 |   1.566 |
| 4/4/5  |  3000 | seed    | mc_compress |     0 |     0 | 2.8284271247 | 2.8284271247 |         1629 |    0.273 |   0.486 |   5.423 |
| 4/4/5  |  3000 | seed    | penalty     |     0 |     0 | 2.8284271247 | 2.8284271247 |          703 |    0.052 |   0.075 |   1.071 |
| 4/4/5  |  3000 | scatter | asc         |     0 |     0 | 3.0000002732 | 3.0148104199 |       2956.5 |    1.118 |   1.270 |  20.099 |
| 4/4/5  |  3000 | scatter | mc_compress |     3 |     3 | 3.0000358649 | 3.4166528411 |         2853 |    0.382 |   0.478 |   7.331 |
| 4/4/5  |  3000 | scatter | penalty     |     1 |     1 | 3.0000000000 | 3.0000000000 |        405.5 |    0.037 |   0.253 |   0.977 |
| 4/4/5  | 30000 | seed    | asc         |     0 |     0 | 2.8284271247 | 2.8284271247 |          113 |    0.077 |   0.082 |   1.545 |
| 4/4/5  | 30000 | seed    | mc_compress |     0 |     0 | 2.8284271247 | 2.8284271247 |         1629 |    0.285 |   0.558 |   5.676 |
| 4/4/5  | 30000 | seed    | penalty     |     0 |     0 | 2.8284271247 | 2.8284271247 |          703 |    0.051 |   0.074 |   1.036 |
| 4/4/5  | 30000 | scatter | asc         |     0 |     0 | 3.0000002731 | 3.0100776130 |         4774 |    2.191 |  15.889 | 118.309 |
| 4/4/5  | 30000 | scatter | mc_compress |     3 |     3 | 3.0000356599 | 3.4166509788 |         3608 |    0.552 |   4.667 |  22.975 |
| 4/4/5  | 30000 | scatter | penalty     |     1 |     1 | 3.0000000000 | 3.0000000000 |        405.5 |    0.035 |   0.274 |   0.973 |
| 4/4/10 |  3000 | seed    | asc         |     0 |     0 | 4.0000000000 | 4.0000000000 |          113 |    0.150 |   0.157 |   3.015 |
| 4/4/10 |  3000 | seed    | mc_compress |     0 |     0 | 4.0000000000 | 4.0000000000 |       1961.5 |    0.770 |   1.260 |  15.677 |
| 4/4/10 |  3000 | seed    | penalty     |     0 |     0 | 4.0000000000 | 4.0000000000 |          667 |    0.203 |   0.244 |   3.744 |
| 4/4/10 |  3000 | scatter | asc         |     0 |     0 | 3.8451148434 | 4.0257409071 |         3000 |    2.313 |   3.131 |  45.596 |
| 4/4/10 |  3000 | scatter | mc_compress |     3 |     1 | 3.9990458377 | 4.0036019710 |         3000 |    0.916 |   1.177 |  18.419 |
| 4/4/10 |  3000 | scatter | penalty     |     0 |     0 | 4.0000000000 | 4.0000005087 |        772.5 |    0.235 |   1.049 |   7.057 |
| 4/4/10 | 30000 | seed    | asc         |     0 |     0 | 4.0000000000 | 4.0000000000 |          113 |    0.157 |   0.163 |   3.144 |
| 4/4/10 | 30000 | seed    | mc_compress |     0 |     0 | 4.0000000000 | 4.0000000000 |       1961.5 |    0.964 |   5.773 |  29.671 |
| 4/4/10 | 30000 | seed    | penalty     |     0 |     0 | 4.0000000000 | 4.0000000000 |          667 |    0.217 |   0.283 |   4.367 |
| 4/4/10 | 30000 | scatter | asc         |     1 |     1 | 3.8450833855 | 4.0253478914 |       6646.5 |    5.561 |  40.714 | 177.904 |
| 4/4/10 | 30000 | scatter | mc_compress |     4 |     2 | 3.9991715508 | 4.0035965347 |         5974 |    2.342 |   5.505 |  51.670 |
| 4/4/10 | 30000 | scatter | penalty     |     0 |     0 | 4.0000000000 | 4.0000005087 |        772.5 |    0.282 |   2.132 |   9.151 |
| 0/0/12 |  3000 | seed    | asc         |     1 |     0 | 4.0550230208 | 4.0550504633 |       1558.5 |    0.952 |   2.479 |  20.457 |
| 0/0/12 |  3000 | seed    | mc_compress |    17 |     8 | 4.0296031111 | 4.0363244605 |         3000 |    0.456 |   0.661 |   9.381 |
| 0/0/12 |  3000 | seed    | penalty     |    20 |    20 | 4.0296019301 | 4.0296019301 |        296.5 |    0.091 |   0.155 |   2.112 |
| 0/0/12 |  3000 | scatter | asc         |    11 |     5 | 4.0296131180 | 4.2993363424 |         3000 |    1.474 |   1.677 |  27.960 |
| 0/0/12 |  3000 | scatter | mc_compress |    16 |     7 | 4.0296020389 | 4.2360679775 |         3000 |    0.365 |   0.610 |   7.386 |
| 0/0/12 |  3000 | scatter | penalty     |    15 |    15 | 4.0296019301 | 4.2360679775 |        412.5 |    0.120 |   0.197 |   2.673 |
| 0/0/12 | 30000 | seed    | asc         |     1 |     1 | 4.0550230208 | 4.0550504633 |       1558.5 |    0.815 |  17.791 | 104.237 |
| 0/0/12 | 30000 | seed    | mc_compress |    17 |    17 | 4.0296019301 | 4.0363159924 |      27431.5 |    3.428 |   8.211 |  68.387 |
| 0/0/12 | 30000 | seed    | penalty     |    20 |    20 | 4.0296019301 | 4.0296019301 |        296.5 |    0.093 |   0.153 |   2.080 |
| 0/0/12 | 30000 | scatter | asc         |    11 |    11 | 4.0296019301 | 4.2993365938 |      27244.5 |   13.144 |  13.764 | 183.982 |
| 0/0/12 | 30000 | scatter | mc_compress |    16 |    14 | 4.0296019301 | 4.2360679775 |        27481 |    3.158 |   4.024 |  46.872 |
| 0/0/12 | 30000 | scatter | penalty     |    15 |    15 | 4.0296019301 | 4.2360679775 |        412.5 |    0.119 |   0.192 |   2.606 |
| 0/0/19 |  3000 | seed    | asc         |    20 |    20 | 4.8637033052 | 4.8637033052 |          118 |    0.148 |   0.153 |   2.968 |
| 0/0/19 |  3000 | seed    | mc_compress |    20 |    20 | 4.8637033052 | 4.8637033052 |        859.5 |    0.202 |   0.219 |   4.083 |
| 0/0/19 |  3000 | seed    | penalty     |    20 |    20 | 4.8637033052 | 4.8637033052 |          190 |    0.054 |   0.062 |   1.082 |
| 0/0/19 |  3000 | scatter | asc         |    16 |    16 | 4.8637033052 | 5.0996827098 |         1403 |    0.976 |   7.586 |  34.561 |
| 0/0/19 |  3000 | scatter | mc_compress |    15 |    15 | 4.8637033052 | 5.1785814689 |         1509 |    0.601 |   2.426 |  17.550 |
| 0/0/19 |  3000 | scatter | penalty     |    16 |    16 | 4.8637033052 | 5.1785814689 |          340 |    0.187 |   0.738 |   5.504 |
| 0/0/19 | 30000 | seed    | asc         |    20 |    20 | 4.8637033052 | 4.8637033052 |          118 |    0.159 |   0.178 |   3.186 |
| 0/0/19 | 30000 | seed    | mc_compress |    20 |    20 | 4.8637033052 | 4.8637033052 |        859.5 |    0.368 |   0.497 |   6.828 |
| 0/0/19 | 30000 | seed    | penalty     |    20 |    20 | 4.8637033052 | 4.8637033052 |          190 |    0.117 |   0.191 |   2.322 |
| 0/0/19 | 30000 | scatter | asc         |    16 |    16 | 4.8637033052 | 5.0996827098 |         1403 |    1.794 |  36.043 | 130.643 |
| 0/0/19 | 30000 | scatter | mc_compress |    15 |    15 | 4.8637033052 | 5.1785814689 |         1509 |    0.371 |   6.190 |  21.989 |
| 0/0/19 | 30000 | scatter | penalty     |    16 |    16 | 4.8637033052 | 5.1785814689 |          340 |    0.219 |   0.755 |   5.869 |
| 0/4/10 |  3000 | seed    | asc         |     2 |     2 | 6.8142879708 | 6.9068582057 |         3000 |    1.669 |   4.531 |  40.551 |
| 0/4/10 |  3000 | seed    | mc_compress |     2 |     2 | 6.8142877381 | 6.9662667708 |         2907 |    0.883 |   1.574 |  17.052 |
| 0/4/10 |  3000 | seed    | penalty     |    19 |    19 | 6.7474415232 | 6.8700652018 |        798.5 |    0.241 |   0.320 |   4.905 |
| 0/4/10 |  3000 | scatter | asc         |     6 |     4 | 6.7602787773 | 6.8228756555 |         2947 |    1.543 |   3.370 |  32.252 |
| 0/4/10 |  3000 | scatter | mc_compress |     3 |     3 | 6.7602787773 | 6.9201002936 |       2845.5 |    0.445 |   0.609 |   8.367 |
| 0/4/10 |  3000 | scatter | penalty     |     8 |     8 | 6.7602787773 | 7.0225095034 |          651 |    0.154 |   0.260 |   3.274 |
| 0/4/10 | 30000 | seed    | asc         |     2 |     2 | 6.8142877381 | 6.9068582057 |        27391 |   16.040 |  33.473 | 286.608 |
| 0/4/10 | 30000 | seed    | mc_compress |     2 |     2 | 6.8142877381 | 6.9662667708 |         3029 |    0.502 |   4.063 |  27.702 |
| 0/4/10 | 30000 | seed    | penalty     |    19 |    19 | 6.7474415232 | 6.8700652018 |        798.5 |    0.199 |   0.221 |   3.978 |
| 0/4/10 | 30000 | scatter | asc         |     6 |     6 | 6.7602787773 | 6.8228756555 |       5492.5 |    2.723 |  15.489 | 137.627 |
| 0/4/10 | 30000 | scatter | mc_compress |     3 |     3 | 6.7602787773 | 6.9201002936 |       4164.5 |    0.660 |   4.402 |  32.886 |
| 0/4/10 | 30000 | scatter | penalty     |     8 |     8 | 6.7602787773 | 7.0225095034 |          651 |    0.146 |   0.216 |   2.877 |
| 5/5/6  |  3000 | seed    | asc         |    20 |     0 | 2.6180341198 | 2.6180342860 |         3000 |    1.217 |   4.085 |  30.705 |
| 5/5/6  |  3000 | seed    | mc_compress |    20 |     0 | 2.6180339964 | 2.6180343057 |         3000 |    1.169 |   2.040 |  25.853 |
| 5/5/6  |  3000 | seed    | penalty     |    20 |     0 | 2.6180341702 | 2.6180349409 |         3000 |    0.498 |   0.622 |  10.087 |
| 5/5/6  |  3000 | scatter | asc         |    12 |     0 | 2.6180342614 | 3.4285766285 |         3000 |    1.868 |   3.406 |  38.950 |
| 5/5/6  |  3000 | scatter | mc_compress |     8 |     0 | 3.0000008121 | 3.4218564914 |         3000 |    0.640 |   1.558 |  14.888 |
| 5/5/6  |  3000 | scatter | penalty     |    14 |     0 | 2.6180341402 | 3.0869291985 |         3000 |    0.627 |   1.056 |  12.613 |
| 5/5/6  | 30000 | seed    | asc         |    20 |     0 | 2.6180340207 | 2.6180342423 |       5039.5 |    1.810 |  20.571 |  67.572 |
| 5/5/6  | 30000 | seed    | mc_compress |    20 |     0 | 2.6180339889 | 2.6180342996 |       5810.5 |    3.182 |  10.583 |  81.703 |
| 5/5/6  | 30000 | seed    | penalty     |    20 |     0 | 2.6180340639 | 2.6180348774 |         4932 |    0.953 |   1.131 |  18.972 |
| 5/5/6  | 30000 | scatter | asc         |    12 |     0 | 2.6180340635 | 3.4282352067 |        20344 |   11.197 |  29.001 | 218.044 |
| 5/5/6  | 30000 | scatter | mc_compress |     8 |     0 | 2.9999486166 | 3.4203192003 |       5623.5 |    0.943 |   4.715 |  34.481 |
| 5/5/6  | 30000 | scatter | penalty     |    14 |     0 | 2.6180340080 | 3.0869287191 |         4683 |    0.758 |   0.895 |  12.649 |

### Move ablation at 3,000 evaluations

[CALC] Each entry is median score / successes within 1e−4 out of 20. Disabling
container moves disables centre and phi; scale stays enabled. Disabling
collective moves disables all four strains and the radial warmup. Different
active proposals consume different random streams, so paired seeds are not
identical trial trajectories. These comparisons assess the whole variants.

| N/M/P  | Start   |          Full ASC | Without centre/phi | Without collective moves |
| ------ | ------- | ----------------: | -----------------: | -----------------------: |
| 4/4/5  | seed    |  2.8284271247 / 0 |   2.8284271247 / 0 |         2.8284271247 / 0 |
| 4/4/5  | scatter |  3.0000002732 / 0 |   3.0000033753 / 0 |         3.0000002287 / 2 |
| 4/4/10 | seed    |  4.0000000000 / 0 |   4.0000000000 / 0 |         4.0000000000 / 0 |
| 4/4/10 | scatter |  3.8451148434 / 0 |   3.8265256326 / 0 |         4.0000031660 / 1 |
| 0/0/12 | seed    |  4.0550230208 / 1 |   4.0550504633 / 0 |         4.0550504633 / 0 |
| 0/0/12 | scatter | 4.0296131180 / 11 |  4.0296019301 / 19 |        4.0296019301 / 19 |
| 0/0/19 | seed    | 4.8637033052 / 20 |  4.8637033052 / 20 |        4.8637033052 / 20 |
| 0/0/19 | scatter | 4.8637033052 / 16 |  4.8637033052 / 15 |        4.8637033052 / 19 |
| 0/4/10 | seed    |  6.8142879708 / 2 |   6.7485110774 / 5 |         6.7602787773 / 2 |
| 0/4/10 | scatter |  6.7602787773 / 6 |   6.7484541640 / 7 |         6.7568765031 / 3 |
| 5/5/6  | seed    | 2.6180341198 / 20 |  2.6180341513 / 20 |        2.6180341149 / 20 |
| 5/5/6  | scatter | 2.6180342614 / 12 |  2.8090190200 / 10 |        2.6180341211 / 16 |

### Acceptance and observed improvements

[CALC] Aggregated over the 480 default ASC runs, including warmup. An observed
score improvement is attributed to the last accepted move that changed poses
or phi before its assessment. Centre/size-only moves cannot independently
change the scored JSON and consequently get zero direct attribution. Multiple
accepted moves can contribute between assessments. This last-change accounting
includes tiny floating-point improvements and excludes seed and final-polish
improvements; it is not a causal marginal-benefit estimate. Ablations above
provide the more useful evidence of marginal benefit.

| Move                 |  Attempts | Accepted | Acceptance % | Improvement count | Share of improvements % | Share of score drop % |
| -------------------- | --------: | -------: | -----------: | ----------------: | ----------------------: | --------------------: |
| translation          | 199183355 | 58420455 |       29.330 |            259209 |                  37.598 |                 1.820 |
| rotation             |  28534833 |  8297903 |       29.080 |             51195 |                   7.426 |                 0.233 |
| containerTranslation |  23265295 |  6631058 |       28.502 |                 0 |                   0.000 |                 0.000 |
| containerRotation    |  15704951 |  4537397 |       28.892 |            123713 |                  17.944 |                 0.645 |
| scale                |  23265295 |   543500 |        2.336 |                 0 |                   0.000 |                 0.000 |
| balanced             |  23265295 |  1187327 |        5.103 |             27153 |                   3.939 |                 0.196 |
| uniaxial             |  23265295 |  1275007 |        5.480 |             55190 |                   8.005 |                 0.492 |
| sector               |  23265295 |  3001026 |       12.899 |            130496 |                  18.928 |                 1.524 |
| radial               |  23296015 |   275946 |        1.185 |             42466 |                   6.160 |                95.091 |

### Separation and interpretation

[CALC] Minimum pair separation over all 1,920 returned results: **-1.83186799063150829e-14** piece units. For default ASC alone: **-1.57651669496772229e-14**. This includes the framework's final polish; ASC's accepted chain states are tested at zero tolerance.

[CALC] Historical benchmark validation: re-evaluating all 1920 saved arrangements with shared geometry found 0 invalid results under the shared strict 1e−12 check and 0 score or budget mismatches. The largest positive protrusion of the scored enclosure was 4.13891143580258358e-13. Consequently, absolute zero pair penetration and absolute zero protrusion cannot be claimed for the final shared result: final polish and enclosure rounding need changes outside ASC. Every internal accepted ASC state is checked at zero tolerance.

| Method      | Runs | ≤1e−4 | ≤1e−9 |  Minimum pair separation |
| ----------- | ---: | ----: | ----: | -----------------------: |
| asc         |  480 |   177 |   104 | -1.57651669496772229e-14 |
| mc_compress |  480 |   215 |   135 | -1.69864122767648951e-14 |
| penalty     |  480 |   266 |   198 | -1.17683640610266593e-14 |

[CALC] **The additional container and collective moves do not establish a consistent advantage over mc_compress at these defaults.** ASC has 6 lower, 6 higher and 12 tied median scores across the 24 problem/start/budget groups, using 1e−8 to distinguish medians. Its overall record success counts are lower than mc_compress. There are real case-specific gains: scattered pentagons improve from 8/20 to 12/20 near-record successes at both caps, scattered circles in a square from 3/20 to 6/20, and scattered 19-circle packings from 15/20 to 16/20. Scattered ten-square medians improve substantially, but record hits are fewer. Twelve-circle results are markedly worse.

[CALC] Centre/phi ablation: full ASC has 4 better, 4 worse and 4 tied medians across 12 groups. At 3,000 evaluations, full ASC has 88/240 near-record successes, compared with 96/240 without centre/phi moves and 102/240 without collective moves. For collective ablation the median counts are 2 better, 5 worse and 5 tied. Collective movement helps some layouts, particularly ten-square medians, but also hurts success rates. The radial move receives 95.091% of the observed score-drop attribution; mc_compress already includes uniform centre contraction, so this does not demonstrate a benefit from anisotropic strains.

[CALC] The ASC test file has 18 tests. They cover randomized shapes
and counts, shared-geometry invariants at every assessment, each collective
move, the expanded known packings, strict rejection, zero-temperature size
monotonicity, deterministic and exact-cap operation, small-budget invalid-start
repair, time-budget overshoot below 0.2 s and timer abort below 1 s.

[CALC] Node throughput without instrumentation or final polish, 300 assessments
from loose P=30 grids, seed 1: N=M=0: 1193.5 eval/s; 3: 482.9; 4: 588.0;
5: 488.9; 6: 532.5; 8: 407.3. Browser throughput remains unmeasured.

### Complete parameter schema

[CALC] Generated from the registered method metadata; defaults are listed above.

```json
{
  "type": "object",
  "title": "Adaptive shrinking container",
  "description": "Hard-particle Monte Carlo with explicit container moves and centre strains in a fixed container shape.",
  "additionalProperties": false,
  "properties": {
    "translationStep": {
      "type": "number",
      "title": "Translation step",
      "description": "Particle coordinate proposal half-width in piece units.",
      "default": 0.15,
      "minimum": 1e-7,
      "maximum": 100
    },
    "rotationStep": {
      "type": "number",
      "title": "Rotation step",
      "description": "Polygon angle proposal half-width in radians; omitted for circles.",
      "default": 0.15,
      "minimum": 1e-7,
      "maximum": 3.141592653589793
    },
    "containerTranslationStep": {
      "type": "number",
      "title": "Container translation",
      "description": "Centre coordinate proposal half-width in piece units.",
      "default": 0.05,
      "minimum": 1e-7,
      "maximum": 100
    },
    "containerRotationStep": {
      "type": "number",
      "title": "Container rotation",
      "description": "Explicit phi proposal half-width in radians; omitted for circles.",
      "default": 0.05,
      "minimum": 1e-7,
      "maximum": 3.141592653589793
    },
    "scaleStep": {
      "type": "number",
      "title": "Container scale",
      "description": "Maximum fractional explicit size change; expansions use Metropolis acceptance.",
      "default": 0.01,
      "minimum": 1e-7,
      "maximum": 0.3
    },
    "balancedStep": {
      "type": "number",
      "title": "Balanced strain",
      "description": "Maximum axial compression with reciprocal perpendicular expansion (determinant one).",
      "default": 0.01,
      "minimum": 1e-7,
      "maximum": 0.3
    },
    "uniaxialStep": {
      "type": "number",
      "title": "Uniaxial strain",
      "description": "Maximum centre compression along a random axis; perpendicular coordinates stay fixed.",
      "default": 0.01,
      "minimum": 1e-7,
      "maximum": 0.3
    },
    "sectorStep": {
      "type": "number",
      "title": "Sector strain",
      "description": "Maximum radial centre contraction restricted to a random half-plane or sector.",
      "default": 0.01,
      "minimum": 1e-7,
      "maximum": 0.3
    },
    "radialStep": {
      "type": "number",
      "title": "Radial strain",
      "description": "Maximum isotropic centre contraction, coupled to an explicit conservative wall shrink.",
      "default": 0.03,
      "minimum": 1e-7,
      "maximum": 0.3
    },
    "targetAcceptance": {
      "type": "number",
      "title": "Target acceptance",
      "description": "Independent adaptation target for each active move type.",
      "default": 0.3,
      "minimum": 0.01,
      "maximum": 0.99
    },
    "adaptationGain": {
      "type": "number",
      "title": "Adaptation gain",
      "description": "Steps multiply by exp(gain*(acceptance-target)); zero disables adaptation.",
      "default": 1,
      "minimum": 0,
      "maximum": 10
    },
    "adaptationSweeps": {
      "type": "integer",
      "title": "Adaptation interval",
      "description": "Sweeps between independent move-type acceptance windows.",
      "default": 20,
      "minimum": 1,
      "maximum": 10000
    },
    "sweepsPerEvaluation": {
      "type": "integer",
      "title": "Evaluation interval",
      "description": "Assess at fixed sweep intervals and after every accepted best-improving wall shrink; duplicates are skipped.",
      "default": 10,
      "minimum": 1,
      "maximum": 1000
    },
    "stagnationSweeps": {
      "type": "integer",
      "title": "Stagnation limit",
      "description": "Stop after this many sweeps without a meaningful score improvement or wall compression.",
      "default": 2000,
      "minimum": 1,
      "maximum": 100000
    },
    "radialWarmup": {
      "type": "integer",
      "title": "Radial warmup",
      "description": "Before diffusion, try this many adaptive isotropic strains to preserve a loose start's contact topology.",
      "default": 64,
      "minimum": 0,
      "maximum": 256
    },
    "seedEvals": {
      "type": "integer",
      "title": "Seed cap",
      "description": "Small automatic seed slice, at least three assessments when available; invalid supplied starts first get a distinct safe bootstrap.",
      "default": 24,
      "minimum": 3,
      "maximum": 256
    },
    "temperature": {
      "type": "number",
      "title": "Temperature",
      "description": "Size-energy temperature in score units; zero forbids every accepted expansion.",
      "default": 0,
      "minimum": 0,
      "maximum": 100
    },
    "coolingRate": {
      "type": "number",
      "title": "Cooling rate",
      "description": "Multiply temperature by this factor after each sweep.",
      "default": 0.9995,
      "minimum": 0,
      "maximum": 1
    },
    "containerMoves": {
      "type": "boolean",
      "title": "Container moves",
      "description": "Enable explicit centre and phi trials; scaling stays active. Useful for ablation.",
      "default": true
    },
    "collectiveMoves": {
      "type": "boolean",
      "title": "Collective moves",
      "description": "Enable all centre strains and radial warmup. Useful for ablation.",
      "default": true
    }
  }
}
```


## Independent acceptance checks (2026-10-10)

[CALC] An independent review found no implementation blocker. Its bounded probes were rerun: 2,450 move attempts across seven shape pairs (including 100-sided pieces/containers), with 550 accepted states and every observed state having zero pair overlap and nonpositive full-vertex protrusion. Initially paused then resumed execution reproduced the baseline best, score and evaluation count; abort while paused returned valid in about 0.028 seconds. A supplied start with 5e−10 penetration repaired strictly in four evaluations with final polish disabled. Superseded 2026-10-11: such a start is now parted in place and is strict at its second evaluation; the two-circle probe (centres at x=±(1−2.5e−10), 3,000 evaluations, seeds 1, 2, 3, 8 and 19) ends after three to six evaluations in a circle, depending on the seed, and two in a square, final polish disabled.

[CALC] Every saved benchmark pose was rescored using the current shared geometry: 1,920 unique results in 96 groups, all valid and strict under the current coordinate-dependent margin, no evaluation overruns, and all 1,920 scores exactly equal to their saved values. Minimum pair separation was −1.8318679906315083e−14 and maximum scored-wall protrusion was 4.1389114358025836e−13. This checks saved evidence; it does not rerun the full optimization matrix or establish absolute zero-gap final polish. Browser throughput, worst-case P=500 responsiveness, literature citations and automatic 50-digit polish were not reverified in this check. No new benchmark improvement or packing record is claimed.
